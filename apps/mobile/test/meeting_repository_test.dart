import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';

import 'support/meeting_test_support.dart';

void main() {
  group('Meeting repository API contracts', () {
    test(
      'lists typed projections and fetches snapshots with response ETags',
      () async {
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'GET' &&
              request.url.path.endsWith('/meetings')) {
            return meetingApiSuccess(
              <Map<String, dynamic>>[
                {
                  ...meetingTestJson(),
                  'display': {
                    'organizerName': 'Test User',
                    'roomName': null,
                    'roomLocation': null,
                    'participantCount': 1,
                    'participantPreview': [
                      {'userId': testUserId, 'displayName': 'Test User'},
                    ],
                  },
                },
              ],
              meta: {
                ...meetingTestMeta,
                'pagination': {
                  'page': 0,
                  'size': 20,
                  'totalElements': 1,
                  'totalPages': 1,
                  'hasNext': false,
                  'hasPrevious': false,
                },
              },
            );
          }
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': testMeetingEtag},
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final repository = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );

        final page = await repository.list();
        final snapshot = await repository.detail(testMeetingId);

        expect(page, isA<PagedCollection<MeetingListProjection>>());
        expect(page.items.single.display.organizerName, 'Test User');
        expect(page.items.single.meeting.display, isNull);
        expect(snapshot.meeting.lifecycleStatus, MeetingStatus.scheduled);
        expect(snapshot.etag, testMeetingEtag);
        expect(snapshot.sessionScope, api.authenticatedSessionScope);
        expect(client.requests[2].url.queryParameters, {
          'page': '0',
          'size': '20',
          'sort': 'createdAt,desc',
        });
        expect(client.requests[3].url.path, '/api/v1/meetings/$testMeetingId');
        expect(invalidation.revision, 0);
      },
    );

    test('executes create, patch, schedule and lifecycle commands with one ETag each', () async {
      final etags = <String>[
        '"created-v1"',
        '"updated-v2"',
        '"scheduled-v3"',
        '"started-v4"',
        '"ended-v5"',
        '"cancelled-v6"',
      ];
      final statuses = <String>[
        'DRAFT',
        'DRAFT',
        'SCHEDULED',
        'IN_PROGRESS',
        'ENDED',
        'CANCELLED',
      ];
      var mutationIndex = 0;
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(
              status: 'DRAFT',
              scheduledStartAt: null,
              scheduledEndAt: null,
            ),
            headers: const {'etag': '"detail-v0"'},
          );
        }
        final index = mutationIndex++;
        return meetingApiSuccess(
          meetingTestJson(status: statuses[index]),
          status: index == 0 ? 201 : 200,
          headers: {'etag': etags[index]},
        );
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final repository = MeetingRepository(
        api: api,
        invalidation: invalidation,
      );
      final interval = MeetingInterval(
        start: DateTime.utc(2026, 11, 24, 9),
        end: DateTime.utc(2026, 11, 24, 10),
      );

      final created = await repository.create(
        CreateMeetingInput(
          title: 'New draft',
          description: null,
          scheduledInterval: interval,
          roomId: null,
        ),
        idempotencyKey: 'm03-create-key:retry-1',
      );
      final updated = await repository.update(
        created,
        MeetingUpdateInput(
          description: const MeetingFieldUpdate<String?>.set(null),
          roomId: const MeetingFieldUpdate<String?>.set(testRoomId),
        ),
      );
      final scheduled = await repository.schedule(
        updated,
        MeetingScheduleInput(interval: interval),
      );
      final started = await repository.start(scheduled);
      final ended = await repository.end(started);
      final cancelled = await repository.cancel(
        ended,
        const MeetingCancelInput(reason: 'No longer needed'),
      );

      final meetingRequests = client.requests
          .where((request) => request.url.path.contains('/meetings'))
          .toList();
      expect(meetingRequests.map((request) => request.method).toList(), [
        'POST',
        'PATCH',
        'POST',
        'POST',
        'POST',
        'POST',
      ]);
      expect(meetingRequests.map((request) => request.url.path).toList(), [
        '/api/v1/meetings',
        '/api/v1/meetings/$testMeetingId',
        '/api/v1/meetings/$testMeetingId/schedule',
        '/api/v1/meetings/$testMeetingId/start',
        '/api/v1/meetings/$testMeetingId/end',
        '/api/v1/meetings/$testMeetingId/cancel',
      ]);
      expect(
        meetingRequests[0].headers['Idempotency-Key'],
        'm03-create-key:retry-1',
      );
      final createBody = jsonDecode((meetingRequests[0] as http.Request).body);
      expect(createBody['title'], 'New draft');
      expect(createBody['scheduledStartAt'], '2026-11-24T09:00:00.000Z');
      expect(createBody['scheduledEndAt'], '2026-11-24T10:00:00.000Z');
      expect(createBody['roomId'], isNull);

      final patchBody = jsonDecode((meetingRequests[1] as http.Request).body);
      expect(patchBody, {'description': null, 'roomId': testRoomId});
      final scheduleBody = jsonDecode(
        (meetingRequests[2] as http.Request).body,
      );
      expect(scheduleBody, {
        'scheduledStartAt': '2026-11-24T09:00:00.000Z',
        'scheduledEndAt': '2026-11-24T10:00:00.000Z',
      });
      final cancelBody = jsonDecode((meetingRequests[5] as http.Request).body);
      expect(cancelBody, {'reason': 'No longer needed'});

      expect(
        meetingRequests.skip(1).map((request) => request.headers['If-Match']),
        [
          '"created-v1"',
          '"updated-v2"',
          '"scheduled-v3"',
          '"started-v4"',
          '"ended-v5"',
        ],
      );
      expect(cancelled.etag, '"cancelled-v6"');
      expect(invalidation.revision, 6);
    });

    test('preserves an omitted patch field and refuses an invalid effective interval before dispatch', () async {
      final client = MeetingTestHttpClient((request) async {
        return meetingApiSuccess(
          meetingTestJson(),
          headers: const {'etag': testMeetingEtag},
        );
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final repository = MeetingRepository(
        api: api,
        invalidation: invalidation,
      );
      final snapshot = await repository.detail(testMeetingId);
      final requestCount = client.requests.length;

      await expectLater(
        repository.update(
          snapshot,
          MeetingUpdateInput(
            scheduledStartAt: const MeetingFieldUpdate<DateTime?>.set(null),
          ),
        ),
        throwsArgumentError,
      );

      expect(client.requests, hasLength(requestCount));
      expect(invalidation.revision, 0);
    });

    test('requires usable ETags for details and mutation results', () async {
      final responses = <Future<http.StreamedResponse> Function()>[
        () => meetingApiSuccess(meetingTestJson()),
        () => meetingApiSuccess(
          meetingTestJson(
            status: 'DRAFT',
            scheduledStartAt: null,
            scheduledEndAt: null,
          ),
        ),
      ];
      final client = MeetingTestHttpClient((_) => responses.removeAt(0)());
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final repository = MeetingRepository(
        api: api,
        invalidation: invalidation,
      );

      await expectLater(
        repository.detail(testMeetingId),
        throwsA(
          isA<MeetingFailure>()
              .having(
                (failure) => failure.category,
                'category',
                MeetingFailureCategory.missingPrecondition,
              )
              .having(
                (failure) => failure.mutationOutcome,
                'outcome',
                MeetingMutationOutcome.notDispatched,
              ),
        ),
      );
      await expectLater(
        repository.create(
          CreateMeetingInput(title: 'Draft'),
          idempotencyKey: 'create-1',
        ),
        throwsA(
          isA<MeetingFailure>()
              .having(
                (failure) => failure.category,
                'category',
                MeetingFailureCategory.missingPrecondition,
              )
              .having(
                (failure) => failure.mutationOutcome,
                'outcome',
                MeetingMutationOutcome.unknown,
              ),
        ),
      );
      expect(invalidation.revision, 1);
    });

    test(
      'rejects versioned responses for a different meeting identity',
      () async {
        const otherMeetingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        final detailClient = MeetingTestHttpClient((request) async {
          return meetingApiSuccess(
            {...meetingTestJson(), 'id': otherMeetingId},
            headers: const {'etag': testMeetingEtag},
          );
        });
        final detailApi = createMeetingTestApi(detailClient);
        addTearDown(detailApi.dispose);
        await signInMeetingTestApi(detailApi);
        final detailInvalidation = MeetingInvalidationSignal(detailApi);
        addTearDown(detailInvalidation.dispose);
        final detailRepository = MeetingRepository(
          api: detailApi,
          invalidation: detailInvalidation,
        );

        await expectLater(
          detailRepository.detail(testMeetingId),
          throwsA(
            isA<MeetingFailure>()
                .having(
                  (failure) => failure.category,
                  'category',
                  MeetingFailureCategory.invalidResponse,
                )
                .having(
                  (failure) => failure.mutationOutcome,
                  'outcome',
                  MeetingMutationOutcome.notDispatched,
                ),
          ),
        );

        final mutationClient = MeetingTestHttpClient((request) async {
          if (request.method == 'GET') {
            return meetingApiSuccess(
              meetingTestJson(),
              headers: const {'etag': testMeetingEtag},
            );
          }
          return meetingApiSuccess(
            {...meetingTestJson(), 'id': otherMeetingId},
            headers: const {'etag': '"wrong-meeting-v2"'},
          );
        });
        final mutationApi = createMeetingTestApi(mutationClient);
        addTearDown(mutationApi.dispose);
        await signInMeetingTestApi(mutationApi);
        final mutationInvalidation = MeetingInvalidationSignal(mutationApi);
        addTearDown(mutationInvalidation.dispose);
        final mutationRepository = MeetingRepository(
          api: mutationApi,
          invalidation: mutationInvalidation,
        );
        final snapshot = await mutationRepository.detail(testMeetingId);

        await expectLater(
          mutationRepository.update(
            snapshot,
            MeetingUpdateInput(
              title: const MeetingFieldUpdate<String>.set('Updated'),
            ),
          ),
          throwsA(
            isA<MeetingFailure>()
                .having(
                  (failure) => failure.category,
                  'category',
                  MeetingFailureCategory.invalidResponse,
                )
                .having(
                  (failure) => failure.mutationOutcome,
                  'outcome',
                  MeetingMutationOutcome.unknown,
                ),
          ),
        );
        expect(mutationInvalidation.revision, 1);
      },
    );

    test('preserves 412 as a rejected version conflict and does not retry or invalidate', () async {
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': testMeetingEtag},
          );
        }
        return meetingApiFailure(
          412,
          'PRECONDITION_FAILED',
          message: 'The meeting version changed.',
          headers: const {
            'x-request-id': '22222222-2222-4222-8222-222222222222',
          },
        );
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final repository = MeetingRepository(
        api: api,
        invalidation: invalidation,
      );
      final snapshot = await repository.detail(testMeetingId);

      await expectLater(
        repository.update(
          snapshot,
          MeetingUpdateInput(
            title: const MeetingFieldUpdate<String>.set('Updated title'),
          ),
        ),
        throwsA(
          isA<MeetingFailure>()
              .having((failure) => failure.status, 'status', 412)
              .having((failure) => failure.code, 'code', 'PRECONDITION_FAILED')
              .having(
                (failure) => failure.category,
                'category',
                MeetingFailureCategory.versionConflict,
              )
              .having(
                (failure) => failure.mutationOutcome,
                'outcome',
                MeetingMutationOutcome.rejected,
              )
              .having(
                (failure) => failure.requestId,
                'requestId',
                meetingTestMeta['requestId'],
              )
              .having(
                (failure) => failure.responseRequestId,
                'responseRequestId',
                '22222222-2222-4222-8222-222222222222',
              ),
        ),
      );

      expect(
        client.requests.where((request) => request.method == 'PATCH'),
        hasLength(1),
      );
      expect(invalidation.revision, 0);
    });

    test('classifies 409 without assuming a room conflict', () async {
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': testMeetingEtag},
          );
        }
        return meetingApiFailure(409, 'MEETING_STATE_CONFLICT');
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final repository = MeetingRepository(
        api: api,
        invalidation: invalidation,
      );
      final snapshot = await repository.detail(testMeetingId);

      await expectLater(
        repository.start(snapshot),
        throwsA(
          isA<MeetingFailure>()
              .having(
                (failure) => failure.category,
                'category',
                MeetingFailureCategory.businessConflict,
              )
              .having(
                (failure) => failure.code,
                'code',
                'MEETING_STATE_CONFLICT',
              )
              .having(
                (failure) => failure.mutationOutcome,
                'outcome',
                MeetingMutationOutcome.rejected,
              ),
        ),
      );
      expect(invalidation.revision, 0);
    });

    for (final entry in <(int, String, MeetingFailureCategory)>[
      (401, 'AUTH_REQUIRED', MeetingFailureCategory.authentication),
      (403, 'AUTHZ_FORBIDDEN', MeetingFailureCategory.authorization),
      (404, 'MEETING_NOT_FOUND', MeetingFailureCategory.resourceUnavailable),
      (400, 'VALIDATION_FAILED', MeetingFailureCategory.validation),
      (
        428,
        'PRECONDITION_REQUIRED',
        MeetingFailureCategory.missingPrecondition,
      ),
      (429, 'RATE_LIMIT_EXCEEDED', MeetingFailureCategory.rateLimited),
    ]) {
      test('classifies HTTP ${entry.$1} as ${entry.$3.name}', () async {
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'GET') {
            return meetingApiSuccess(
              meetingTestJson(),
              headers: const {'etag': testMeetingEtag},
            );
          }
          return meetingApiFailure(
            entry.$1,
            entry.$2,
            headers: entry.$1 == 429
                ? const {'retry-after': '30'}
                : const <String, String>{},
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final repository = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );
        final snapshot = await repository.detail(testMeetingId);

        await expectLater(
          repository.start(snapshot),
          throwsA(
            isA<MeetingFailure>()
                .having((failure) => failure.category, 'category', entry.$3)
                .having(
                  (failure) => failure.mutationOutcome,
                  'outcome',
                  MeetingMutationOutcome.rejected,
                )
                .having(
                  (failure) => failure.retryAfter,
                  'retryAfter',
                  entry.$1 == 429 ? '30' : isNull,
                ),
          ),
        );
        expect(invalidation.revision, 0);
      });
    }

    test(
      'classifies a transport failure as ambiguous and requests revalidation',
      () async {
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'GET') {
            return meetingApiSuccess(
              meetingTestJson(),
              headers: const {'etag': testMeetingEtag},
            );
          }
          throw http.ClientException('connection lost');
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final repository = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );
        final snapshot = await repository.detail(testMeetingId);

        await expectLater(
          repository.start(snapshot),
          throwsA(
            isA<MeetingFailure>()
                .having(
                  (failure) => failure.category,
                  'category',
                  MeetingFailureCategory.transport,
                )
                .having(
                  (failure) => failure.transportFailure,
                  'transport',
                  isTrue,
                )
                .having(
                  (failure) => failure.mutationOutcome,
                  'outcome',
                  MeetingMutationOutcome.unknown,
                ),
          ),
        );
        expect(invalidation.revision, 1);
        expect(invalidation.lastMeetingId, testMeetingId);
      },
    );

    test(
      'classifies malformed read projections as invalid response contracts',
      () async {
        final client = MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/meetings')) {
            return meetingApiSuccess(
              <Map<String, dynamic>>[meetingTestJson()],
              meta: {
                ...meetingTestMeta,
                'pagination': {
                  'page': 0,
                  'size': 20,
                  'totalElements': 1,
                  'totalPages': 1,
                  'hasNext': false,
                  'hasPrevious': false,
                },
              },
            );
          }
          return meetingApiSuccess(
            {...meetingTestJson(), 'status': 'UNSUPPORTED'},
            headers: const {'etag': testMeetingEtag},
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final repository = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );

        await expectLater(
          repository.list(),
          throwsA(
            isA<MeetingFailure>()
                .having(
                  (failure) => failure.category,
                  'category',
                  MeetingFailureCategory.invalidResponse,
                )
                .having(
                  (failure) => failure.invalidResponse,
                  'invalidResponse',
                  isTrue,
                )
                .having(
                  (failure) => failure.mutationOutcome,
                  'outcome',
                  MeetingMutationOutcome.notDispatched,
                ),
          ),
        );
        await expectLater(
          repository.detail(testMeetingId),
          throwsA(
            isA<MeetingFailure>()
                .having(
                  (failure) => failure.category,
                  'category',
                  MeetingFailureCategory.invalidResponse,
                )
                .having(
                  (failure) => failure.invalidResponse,
                  'invalidResponse',
                  isTrue,
                )
                .having(
                  (failure) => failure.mutationOutcome,
                  'outcome',
                  MeetingMutationOutcome.notDispatched,
                ),
          ),
        );
        expect(invalidation.revision, 0);
      },
    );

    test('marks 5xx and malformed success responses ambiguous and invalidates for revalidation', () async {
      var nextStatus = 503;
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': testMeetingEtag},
          );
        }
        if (nextStatus == 503) {
          return meetingApiFailure(503, 'SERVICE_UNAVAILABLE');
        }
        return meetingApiSuccess(
          {'id': testMeetingId},
          headers: const {'etag': '"bad-success"'},
        );
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final repository = MeetingRepository(
        api: api,
        invalidation: invalidation,
      );
      final snapshot = await repository.detail(testMeetingId);
      final patch = MeetingUpdateInput(
        title: const MeetingFieldUpdate<String>.set('Updated title'),
      );

      await expectLater(
        repository.update(snapshot, patch),
        throwsA(
          isA<MeetingFailure>()
              .having(
                (failure) => failure.category,
                'category',
                MeetingFailureCategory.server,
              )
              .having(
                (failure) => failure.mutationOutcome,
                'outcome',
                MeetingMutationOutcome.unknown,
              ),
        ),
      );
      expect(invalidation.revision, 1);

      nextStatus = 200;
      await expectLater(
        repository.update(snapshot, patch),
        throwsA(
          isA<MeetingFailure>()
              .having(
                (failure) => failure.category,
                'category',
                MeetingFailureCategory.invalidResponse,
              )
              .having(
                (failure) => failure.mutationOutcome,
                'outcome',
                MeetingMutationOutcome.unknown,
              ),
        ),
      );
      expect(invalidation.revision, 2);
    });

    test(
      'rejects invalid caller-owned creation keys before network dispatch',
      () async {
        final client = MeetingTestHttpClient((_) async {
          fail('Invalid idempotency keys must not be dispatched.');
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final repository = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );
        final requestCount = client.requests.length;

        await expectLater(
          repository.create(
            CreateMeetingInput(title: 'Draft'),
            idempotencyKey: ' leading-space',
          ),
          throwsArgumentError,
        );
        expect(client.requests, hasLength(requestCount));
        expect(invalidation.revision, 0);
      },
    );
  });
}
