import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling_widgets.dart';

import 'support/meeting_test_support.dart';

const _room = <String, dynamic>{
  'id': testRoomId,
  'code': 'R-01',
  'name': 'Tầng 1',
  'location': 'Tòa A',
  'capacity': 12,
  'status': 'ACTIVE',
  'notes': null,
  'createdAt': '2026-11-20T10:00:00Z',
  'updatedAt': '2026-11-20T10:00:00Z',
};

const _onePage = <String, dynamic>{
  'pagination': {
    'page': 0,
    'size': 20,
    'totalElements': 1,
    'totalPages': 1,
    'hasNext': false,
    'hasPrevious': false,
  },
};

void main() {
  group('Room scheduling API contracts', () {
    test('room selection switches to interval availability and fences catalog responses', () async {
      final catalogStarted = Completer<void>();
      final catalogResponse = Completer<http.StreamedResponse>();
      final client = MeetingTestHttpClient((request) async {
        if (request.url.path.endsWith('/rooms/availability')) {
          expect(
            request.url.queryParameters['start'],
            '2026-11-24T09:00:00.000Z',
          );
          return meetingApiSuccess(
            [
              {
                'id': testRoomId,
                'code': 'R-01',
                'name': 'Tầng 1',
                'location': 'Tòa A',
                'capacity': 12,
                'available': true,
                'participantCount': 3,
                'capacityExceeded': false,
              },
            ],
            meta: {...meetingTestMeta, ..._onePage},
          );
        }
        if (request.url.path.endsWith('/rooms')) {
          catalogStarted.complete();
          return catalogResponse.future;
        }
        throw StateError('Unexpected request ${request.url}');
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final controller = RoomSelectionController(
        repository: RoomSchedulingRepository(api),
        sessionScope: api.requireAuthenticatedSessionScope(),
      );
      addTearDown(controller.dispose);

      final oldCatalog = controller.initialize();
      await catalogStarted.future;
      await controller.updateAvailability(
        interval: MeetingInterval(
          start: DateTime.utc(2026, 11, 24, 9),
          end: DateTime.utc(2026, 11, 24, 10),
        ),
        participantCount: 3,
      );
      expect(controller.state.rooms.single.available, isTrue);

      await completeRequestAfter(
        catalogResponse,
        status: 200,
        body: meetingSuccessEnvelope(
          [_room],
          meta: {...meetingTestMeta, ..._onePage},
        ),
      );
      await oldCatalog;

      expect(controller.state.rooms.single.id, testRoomId);
      expect(controller.state.rooms.single.available, isTrue);
    });

    test(
      'loads the active searchable catalog with server pagination',
      () async {
        final client = MeetingTestHttpClient((request) async {
          expect(request.method, 'GET');
          expect(request.url.path, '/api/v1/rooms');
          expect(request.url.queryParameters, {
            'q': 'board',
            'status': 'ACTIVE',
            'page': '0',
            'size': '20',
            'sort': 'code,asc',
          });
          return meetingApiSuccess(
            [_room],
            meta: {...meetingTestMeta, ..._onePage},
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final repository = RoomSchedulingRepository(api);
        final scope = api.requireAuthenticatedSessionScope();

        final page = await repository.catalog(
          RoomCatalogQuery(search: 'board'),
          sessionScope: scope,
        );

        expect(page.items.single.name, 'Tầng 1');
        expect(page.hasNext, isFalse);
      },
    );

    test(
      'loads interval availability separately from the active catalog',
      () async {
        final interval = MeetingInterval(
          start: DateTime.parse('2026-11-24T09:00:00+02:00'),
          end: DateTime.parse('2026-11-24T10:00:00+02:00'),
        );
        final client = MeetingTestHttpClient((request) async {
          expect(request.url.path, '/api/v1/rooms/availability');
          expect(request.url.queryParameters, {
            'start': '2026-11-24T07:00:00.000Z',
            'end': '2026-11-24T08:00:00.000Z',
            'q': 'R-',
            'participantCount': '4',
            'page': '0',
            'size': '20',
          });
          return meetingApiSuccess(
            [
              {
                'id': testRoomId,
                'code': 'R-01',
                'name': 'Tầng 1',
                'location': 'Tòa A',
                'capacity': 12,
                'available': false,
                'participantCount': 4,
                'capacityExceeded': false,
              },
            ],
            meta: {...meetingTestMeta, ..._onePage},
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);

        final page = await RoomSchedulingRepository(api).availability(
          RoomAvailabilityQuery(
            interval: interval,
            search: 'R-',
            participantCount: 4,
          ),
          sessionScope: api.requireAuthenticatedSessionScope(),
        );

        expect(page.items.single.available, isFalse);
        expect(page.items.single.capacityExceeded, isFalse);
        expect(
          client.requests
              .singleWhere(
                (request) => request.url.path.endsWith('/rooms/availability'),
              )
              .url
              .queryParameters,
          isNot(contains('meetingId')),
        );
      },
    );

    test('preserves omitted and explicitly empty preview participants', () {
      final interval = MeetingInterval(
        start: DateTime.utc(2026, 11, 24, 9),
        end: DateTime.utc(2026, 11, 24, 10),
      );
      final existing = ScheduleIntent(
        interval: interval,
        meetingId: testMeetingId,
        organizerId: testUserId,
      );
      final explicitEmpty = ScheduleIntent(
        interval: interval,
        meetingId: testMeetingId,
        organizerId: testUserId,
        participantUserIds: const [],
      );

      expect(existing.toRequestBody(), isNot(contains('participantUserIds')));
      expect(explicitEmpty.toRequestBody()['participantUserIds'], isEmpty);
    });

    test('excludes organizer, rejects duplicate participants and enforces limit', () {
      final interval = MeetingInterval(
        start: DateTime.utc(2026, 11, 24, 9),
        end: DateTime.utc(2026, 11, 24, 10),
      );
      final intent = ScheduleIntent(
        interval: interval,
        organizerId: testUserId,
        participantUserIds: const [testUserId, testRoomId],
      );

      expect(intent.participantUserIds, [testRoomId]);
      expect(
        () => ScheduleIntent(
          interval: interval,
          participantUserIds: const [testRoomId, testRoomId],
        ),
        throwsArgumentError,
      );
      expect(
        () => ScheduleIntent(
          interval: interval,
          participantUserIds: List<String>.generate(
            101,
            (index) =>
                '${index.toString().padLeft(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          ),
        ),
        throwsArgumentError,
      );
    });

    test(
      'posts immutable preview intent and decodes warning semantics',
      () async {
        final interval = MeetingInterval(
          start: DateTime.utc(2026, 11, 24, 9),
          end: DateTime.utc(2026, 11, 24, 10),
        );
        final client = MeetingTestHttpClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, '/api/v1/meeting-schedule-checks');
          expect(decodeRequestBody(request), {
            'meetingId': testMeetingId,
            'roomId': testRoomId,
            'start': '2026-11-24T09:00:00.000Z',
            'end': '2026-11-24T10:00:00.000Z',
          });
          return meetingApiSuccess({
            'previewOnly': true,
            'canSchedule': false,
            'roomConflict': true,
            'room': {
              'roomId': testRoomId,
              'active': true,
              'available': false,
              'capacity': 12,
              'participantCount': 4,
              'capacityExceeded': false,
            },
            'warnings': [
              {'code': 'FUTURE_WARNING', 'userId': testUserId},
            ],
          });
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);

        final preview = await RoomSchedulingRepository(api).preview(
          ScheduleIntent(
            interval: interval,
            roomId: testRoomId,
            meetingId: testMeetingId,
            organizerId: testUserId,
          ),
          sessionScope: api.requireAuthenticatedSessionScope(),
        );

        expect(preview.previewOnly, isTrue);
        expect(preview.canSchedule, isFalse);
        expect(preview.roomConflict, isTrue);
        expect(preview.room?.roomId, testRoomId);
        expect(preview.warnings.single.code, 'FUTURE_WARNING');
        expect(preview.warnings.single.userId, testUserId);
      },
    );

    test('rejects contradictory successful preview signals', () async {
      final client = MeetingTestHttpClient((request) async {
        return meetingApiSuccess({
          'previewOnly': true,
          'canSchedule': true,
          'roomConflict': true,
          'room': {
            'roomId': testRoomId,
            'active': true,
            'available': false,
            'capacity': 12,
            'participantCount': 3,
            'capacityExceeded': false,
          },
          'warnings': [],
        });
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final interval = MeetingInterval(
        start: DateTime.utc(2026, 11, 24, 9),
        end: DateTime.utc(2026, 11, 24, 10),
      );

      await expectLater(
        RoomSchedulingRepository(api).preview(
          ScheduleIntent(interval: interval, roomId: testRoomId),
          sessionScope: api.requireAuthenticatedSessionScope(),
        ),
        throwsA(isA<ApiFailure>()),
      );
    });

    test(
      'preview fences changed intents and coalesces unchanged requests',
      () async {
        final firstStarted = Completer<void>();
        final firstResponse = Completer<http.StreamedResponse>();
        var previewCalls = 0;
        final client = MeetingTestHttpClient((request) async {
          if (request.method != 'POST') {
            throw StateError('Unexpected request ${request.url}');
          }
          previewCalls++;
          if (previewCalls == 1) {
            firstStarted.complete();
            return firstResponse.future;
          }
          return meetingApiSuccess(_previewJson(canSchedule: true));
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final controller = SchedulePreviewController(
          repository: RoomSchedulingRepository(api),
          sessionScope: api.requireAuthenticatedSessionScope(),
        );
        addTearDown(controller.dispose);
        final interval = MeetingInterval(
          start: DateTime.utc(2026, 11, 24, 9),
          end: DateTime.utc(2026, 11, 24, 10),
        );
        controller.setIntent(ScheduleIntent(interval: interval));

        final oldRequest = controller.check();
        await firstStarted.future;
        final duplicateOldRequest = controller.check();
        expect(previewCalls, 1);

        controller.setIntent(
          ScheduleIntent(
            interval: MeetingInterval(
              start: DateTime.utc(2026, 11, 24, 11),
              end: DateTime.utc(2026, 11, 24, 12),
            ),
          ),
        );
        await controller.check();
        expect(controller.state.phase, SchedulePreviewPhase.current);
        expect(controller.state.preview?.canSchedule, isTrue);

        await completeRequestAfter(
          firstResponse,
          status: 200,
          body: meetingSuccessEnvelope(_previewJson(canSchedule: false)),
        );
        await Future.wait([oldRequest, duplicateOldRequest]);

        expect(previewCalls, 2);
        expect(controller.state.phase, SchedulePreviewPhase.current);
        expect(controller.state.preview?.canSchedule, isTrue);
      },
    );
  });
}

Map<String, dynamic> _previewJson({required bool canSchedule}) => {
  'previewOnly': true,
  'canSchedule': canSchedule,
  'roomConflict': !canSchedule,
  'room': null,
  'warnings': [],
};
