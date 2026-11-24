import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';

import 'support/meeting_test_support.dart';

void main() {
  test(
    'a snapshot cannot be reused after logout and same-account login',
    () async {
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': testMeetingEtag},
          );
        }
        return meetingApiSuccess(
          meetingTestJson(status: 'DRAFT'),
          status: 201,
          headers: const {'etag': '"created-v1"'},
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

      final oldSnapshot = await repository.detail(testMeetingId);
      final created = await repository.create(
        CreateMeetingInput(title: 'One-time draft'),
        idempotencyKey: 'session-isolation-key',
      );
      expect(created.sessionScope, oldSnapshot.sessionScope);
      expect(invalidation.revision, 1);

      await api.signOut();
      await api.signIn('user@example.test', 'password');
      expect(api.authenticatedSessionScope!.userId, testUserId);
      expect(api.authenticatedSessionScope, isNot(oldSnapshot.sessionScope));
      expect(invalidation.revision, 0);

      final before = client.requests.length;
      await expectLater(
        repository.start(oldSnapshot),
        throwsA(
          isA<MeetingFailure>()
              .having(
                (failure) => failure.mutationOutcome,
                'outcome',
                MeetingMutationOutcome.notDispatched,
              )
              .having(
                (failure) => failure.category,
                'category',
                MeetingFailureCategory.authentication,
              ),
        ),
      );
      expect(client.requests, hasLength(before));
      expect(invalidation.revision, 0);
    },
  );

  test(
    'a delayed old-session mutation cannot publish or return after re-login',
    () async {
      final started = Completer<void>();
      final delayedResponse = Completer<http.StreamedResponse>();
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': testMeetingEtag},
          );
        }
        if (request.method == 'PATCH') {
          started.complete();
          return delayedResponse.future;
        }
        throw StateError('Unexpected meeting request: ${request.url}');
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

      final mutation = repository.update(
        snapshot,
        MeetingUpdateInput(
          title: const MeetingFieldUpdate<String>.set('Updated while pending'),
        ),
      );
      await started.future;
      await api.signOut();
      await api.signIn('user@example.test', 'password');
      await completeRequestAfter(
        delayedResponse,
        status: 200,
        body: meetingSuccessEnvelope(meetingTestJson(status: 'SCHEDULED')),
        headers: const {'etag': '"old-session-result"'},
      );

      await expectLater(
        mutation,
        throwsA(
          isA<MeetingFailure>().having(
            (failure) => failure.mutationOutcome,
            'outcome',
            MeetingMutationOutcome.unknown,
          ),
        ),
      );
      expect(api.authenticatedSessionScope!.userId, testUserId);
      expect(invalidation.revision, 0);
    },
  );

  test(
    'credential refresh within one session does not stale a snapshot',
    () async {
      var now = DateTime.utc(2026, 11, 24, 12);
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': testMeetingEtag},
          );
        }
        if (request.method == 'PATCH') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': '"after-refresh-v2"'},
          );
        }
        throw StateError('Unexpected meeting request: ${request.url}');
      });
      final api = createMeetingTestApi(client, now: () => now);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final repository = MeetingRepository(
        api: api,
        invalidation: invalidation,
      );
      final snapshot = await repository.detail(testMeetingId);
      final session = snapshot.sessionScope;

      now = now.add(const Duration(seconds: 601));
      final updated = await repository.update(
        snapshot,
        MeetingUpdateInput(
          title: const MeetingFieldUpdate<String>.set('Refreshed credential'),
        ),
      );

      expect(updated.sessionScope, session);
      expect(api.authenticatedSessionScope, session);
      expect(
        client.requests.where(
          (request) => request.url.path.endsWith('/auth/refresh'),
        ),
        hasLength(1),
      );
      expect(
        client.requests.where((request) => request.method == 'PATCH'),
        hasLength(1),
      );
      expect(invalidation.revision, 1);
    },
  );
}
