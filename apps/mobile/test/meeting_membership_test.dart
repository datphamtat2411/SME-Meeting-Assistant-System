import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_membership.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';

import 'support/meeting_test_support.dart';

const _membershipId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const _otherMembershipId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

Map<String, dynamic> _participantJson({
  required String id,
  required String userId,
  String? removedAt,
}) => {
  'id': id,
  'meetingId': testMeetingId,
  'userId': userId,
  'addedByUserId': testUserId,
  'addedAt': '2026-11-20T10:00:00Z',
  'removedAt': removedAt,
  'removedByUserId': removedAt == null ? null : testUserId,
  'displayName': userId == testUserId ? 'Organizer' : 'Member',
};

void main() {
  group('Meeting membership API contracts', () {
    test(
      'preserves history and uses intent-bound versions for add and remove',
      () async {
        var detailReads = 0;
        final client = MeetingTestHttpClient((request) async {
          final path = request.url.path;
          if (request.method == 'GET' && path.endsWith('/participants')) {
            return meetingApiSuccess([
              _participantJson(id: _membershipId, userId: testUserId),
              _participantJson(
                id: _otherMembershipId,
                userId: testRoomId,
                removedAt: '2026-11-22T10:00:00Z',
              ),
            ]);
          }
          if (request.method == 'GET') {
            detailReads++;
            return meetingApiSuccess(
              meetingTestJson(),
              headers: {
                'etag': detailReads == 1 ? '"meeting-v1"' : '"meeting-v2"',
              },
            );
          }
          if (request.method == 'POST') {
            expect(request.headers['if-match'], '"meeting-v1"');
            expect(decodeRequestBody(request), {'userId': testRoomId});
            return meetingApiSuccess(
              _participantJson(id: _membershipId, userId: testRoomId),
              status: 201,
            );
          }
          if (request.method == 'DELETE') {
            expect(request.url.path, endsWith('/participants/$testRoomId'));
            expect(request.headers['if-match'], '"meeting-v2"');
            return meetingApiSuccess(
              meetingTestJson(),
              headers: const {'etag': '"meeting-v3"'},
            );
          }
          throw StateError('Unexpected request ${request.method} $path');
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final meetings = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );
        final repository = MeetingMembershipRepository(
          api: api,
          meetings: meetings,
          invalidation: invalidation,
        );
        final scope = api.requireAuthenticatedSessionScope();
        final initialSnapshot = await meetings.detail(testMeetingId);

        final records = await repository.listParticipants(
          testMeetingId,
          sessionScope: scope,
        );
        expect(records, hasLength(2));
        expect(records.where((record) => record.isActive), hasLength(1));
        expect(
          records.where((record) => !record.isActive).single.id,
          _otherMembershipId,
        );

        final added = await repository.addParticipant(
          initialSnapshot,
          testRoomId,
        );
        expect(added.meetingId, testMeetingId);
        expect(added.userId, testRoomId);

        final refreshedSnapshot = await meetings.detail(testMeetingId);
        final removedSnapshot = await repository.removeParticipant(
          refreshedSnapshot,
          testRoomId,
        );
        expect(removedSnapshot.meeting.id, testMeetingId);
        expect(removedSnapshot.etag, '"meeting-v3"');
        expect(invalidation.revision, 2);

        final membershipRequests = client.requests
            .where((request) => request.url.path.contains('/participants'))
            .toList();
        expect(membershipRequests.map((request) => request.method), [
          'GET',
          'POST',
          'DELETE',
        ]);
      },
    );

    test(
      'a stale membership ETag is rejected without retry or optimistic success',
      () async {
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'GET') {
            return meetingApiSuccess(
              meetingTestJson(),
              headers: const {'etag': '"stale-v1"'},
            );
          }
          return meetingApiFailure(412, 'PRECONDITION_FAILED');
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final meetings = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );
        final repository = MeetingMembershipRepository(
          api: api,
          meetings: meetings,
          invalidation: invalidation,
        );
        final snapshot = await meetings.detail(testMeetingId);

        await expectLater(
          repository.addParticipant(snapshot, testRoomId),
          throwsA(
            isA<MembershipFailure>()
                .having((failure) => failure.status, 'status', 412)
                .having(
                  (failure) => failure.category,
                  'category',
                  MembershipFailureCategory.versionConflict,
                )
                .having(
                  (failure) => failure.outcome,
                  'outcome',
                  MembershipMutationCertainty.rejected,
                ),
          ),
        );
        expect(
          client.requests.where(
            (request) =>
                request.method == 'POST' &&
                request.url.path.endsWith('/participants'),
          ),
          hasLength(1),
        );
        expect(invalidation.revision, 0);
      },
    );

    test(
      'an unknown add outcome invalidates its projection for reconciliation',
      () async {
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'GET') {
            return meetingApiSuccess(
              meetingTestJson(),
              headers: const {'etag': '"meeting-v1"'},
            );
          }
          throw http.ClientException('connection lost');
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final meetings = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );
        final repository = MeetingMembershipRepository(
          api: api,
          meetings: meetings,
          invalidation: invalidation,
        );
        final snapshot = await meetings.detail(testMeetingId);

        await expectLater(
          repository.addParticipant(snapshot, testRoomId),
          throwsA(
            isA<MembershipFailure>()
                .having(
                  (failure) => failure.outcome,
                  'outcome',
                  MembershipMutationCertainty.unknown,
                )
                .having(
                  (failure) => failure.category,
                  'category',
                  MembershipFailureCategory.transport,
                ),
          ),
        );
        expect(invalidation.revision, 1);
        expect(invalidation.lastMeetingId, testMeetingId);
      },
    );

    test('keeps a confirmed add when snapshot reconciliation fails and blocks retries', () async {
      var detailReads = 0;
      var addCalls = 0;
      final client = MeetingTestHttpClient((request) async {
        final path = request.url.path;
        if (request.method == 'GET' && path.endsWith('/participants')) {
          return meetingApiSuccess([
            _participantJson(id: _membershipId, userId: testUserId),
          ]);
        }
        if (request.method == 'GET') {
          detailReads++;
          if (detailReads == 1) {
            return meetingApiSuccess(
              meetingTestJson(),
              headers: const {'etag': '"meeting-v1"'},
            );
          }
          return meetingApiFailure(503, 'SERVICE_UNAVAILABLE');
        }
        if (request.method == 'POST') {
          addCalls++;
          return meetingApiSuccess(
            _participantJson(id: _otherMembershipId, userId: testRoomId),
            status: 201,
          );
        }
        throw StateError('Unexpected request ${request.method} $path');
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final meetings = MeetingRepository(api: api, invalidation: invalidation);
      final controller = MeetingMembershipController(
        repository: MeetingMembershipRepository(
          api: api,
          meetings: meetings,
          invalidation: invalidation,
        ),
        snapshot: await meetings.detail(testMeetingId),
      );
      addTearDown(controller.dispose);
      await controller.initialize();

      final result = await controller.addParticipant(testRoomId);

      expect(result.status, MembershipOperationStatus.confirmed);
      expect(result.requiresRevalidation, isTrue);
      expect(controller.state.needsRevalidation, isTrue);
      expect(
        controller.state.activeParticipants.any(
          (record) => record.userId == testRoomId,
        ),
        isTrue,
      );

      final blocked = await controller.addParticipant(_otherMembershipId);
      expect(blocked.status, MembershipOperationStatus.notDispatched);
      expect(addCalls, 1);
    });

    test(
      'reloads after a 412 but requires a new user action and never replays',
      () async {
        var detailReads = 0;
        var addCalls = 0;
        final client = MeetingTestHttpClient((request) async {
          final path = request.url.path;
          if (request.method == 'GET' && path.endsWith('/participants')) {
            return meetingApiSuccess([
              _participantJson(id: _membershipId, userId: testUserId),
            ]);
          }
          if (request.method == 'GET') {
            detailReads++;
            return meetingApiSuccess(
              meetingTestJson(),
              headers: {
                'etag': detailReads == 1 ? '"meeting-v1"' : '"meeting-v2"',
              },
            );
          }
          if (request.method == 'POST') {
            addCalls++;
            return meetingApiFailure(412, 'PRECONDITION_FAILED');
          }
          throw StateError('Unexpected request ${request.method} $path');
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final meetings = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );
        final controller = MeetingMembershipController(
          repository: MeetingMembershipRepository(
            api: api,
            meetings: meetings,
            invalidation: invalidation,
          ),
          snapshot: await meetings.detail(testMeetingId),
        );
        addTearDown(controller.dispose);
        await controller.initialize();

        final result = await controller.addParticipant(testRoomId);

        expect(result.status, MembershipOperationStatus.rejected);
        expect(result.failure, isA<MembershipFailure>());
        expect(result.reconciled, isTrue);
        expect(controller.state.snapshot?.etag, '"meeting-v2"');
        expect(controller.state.needsRevalidation, isFalse);
        expect(controller.state.failure, isNull);
        expect(addCalls, 1);
      },
    );

    test('clears membership history when its session ends', () async {
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET' &&
            request.url.path.endsWith('/participants')) {
          return meetingApiSuccess([
            _participantJson(id: _membershipId, userId: testUserId),
          ]);
        }
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': '"meeting-v1"'},
          );
        }
        throw StateError('Unexpected request ${request.method} ${request.url}');
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final meetings = MeetingRepository(api: api, invalidation: invalidation);
      final controller = MeetingMembershipController(
        repository: MeetingMembershipRepository(
          api: api,
          meetings: meetings,
          invalidation: invalidation,
        ),
        snapshot: await meetings.detail(testMeetingId),
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      expect(controller.state.activeParticipants, hasLength(1));

      await api.signOut();

      expect(controller.state.snapshot, isNull);
      expect(controller.state.records, isEmpty);
      expect(controller.state.accessRevoked, isTrue);
    });
  });
}
