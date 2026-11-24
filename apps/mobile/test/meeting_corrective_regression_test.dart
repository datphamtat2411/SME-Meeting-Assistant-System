import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_creation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_detail_controller.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_editing.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_membership.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling.dart';

import 'support/meeting_test_support.dart';

void main() {
  test(
    'incomplete or reversed edit intervals stay non-throwing and unsent',
    () async {
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': '"edit-safe-v1"'},
          );
        }
        throw StateError('Unexpected request ${request.method} ${request.url}');
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
      final controller = MeetingEditingController(
        repository: repository,
        invalidation: invalidation,
        snapshot: snapshot,
      );
      addTearDown(controller.dispose);

      controller.updateValues(
        MeetingEditValues(
          title: snapshot.meeting.title,
          description: snapshot.meeting.description,
          start: DateTime.utc(2026, 11, 24, 11),
          end: DateTime.utc(2026, 11, 24, 10),
          roomId: snapshot.meeting.roomId,
        ),
      );

      expect(controller.state.values?.interval, isNull);
      expect(controller.state.canSubmit, isFalse);
      expect(controller.buildPatch(), isNull);

      await controller.submit();

      expect(controller.state.message, contains('kết thúc'));
      expect(
        client.requests.where((request) => request.method == 'PATCH'),
        isEmpty,
      );
    },
  );

  test(
    'aggregate ownership remains held until secondary reconciliation finishes',
    () async {
      final participantsResponse = Completer<http.StreamedResponse>();
      var participantReads = 0;
      final client = MeetingTestHttpClient((request) async {
        final path = request.url.path;
        if (request.method == 'GET' && path.endsWith('/participants')) {
          participantReads++;
          if (participantReads > 1) return participantsResponse.future;
          return meetingApiSuccess(const <dynamic>[]);
        }
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': '"aggregate-v1"'},
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
      final membership = MeetingMembershipRepository(
        api: api,
        meetings: meetings,
        invalidation: invalidation,
      );
      final controller = MeetingDetailController(
        meetings: meetings,
        membership: membership,
        rooms: RoomSchedulingRepository(api),
        invalidation: invalidation,
        meetingId: testMeetingId,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      await Future<void>.delayed(Duration.zero);

      final token = controller.acquireAggregateMutation(
        MeetingDetailMutation.membership,
        confirmedContext: controller.snapshot,
      );
      expect(token, isNotNull);
      final reconcile = controller.acceptAggregateSnapshotAndReconcile(
        token!,
        controller.snapshot!,
      );
      var finished = false;
      unawaited(reconcile.then((_) => finished = true));
      await Future<void>.delayed(Duration.zero);

      expect(controller.ownsAggregateMutation(token), isTrue);
      expect(finished, isFalse);

      participantsResponse.complete(await meetingApiSuccess(const <dynamic>[]));
      expect(await reconcile, isTrue);
      expect(controller.ownsAggregateMutation(token), isTrue);

      controller.releaseAggregateMutation(token);
      expect(controller.ownsAggregateMutation(token), isFalse);
    },
  );

  test(
    'organizer metadata falls back to the signed-in identity without a lookup',
    () async {
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET' &&
            request.url.path.endsWith('/participants')) {
          return meetingApiSuccess(const <dynamic>[]);
        }
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': '"organizer-fallback-v1"'},
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
      final controller = MeetingDetailController(
        meetings: meetings,
        membership: MeetingMembershipRepository(
          api: api,
          meetings: meetings,
          invalidation: invalidation,
        ),
        rooms: RoomSchedulingRepository(api),
        invalidation: invalidation,
        meetingId: testMeetingId,
      );
      addTearDown(controller.dispose);

      await controller.initialize();
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.organizerDisplayName, 'Test User');
      expect(
        client.requests.where(
          (request) => request.url.path.contains('/meeting-organizers/'),
        ),
        isEmpty,
      );
    },
  );

  test(
    'recovery operation ownership is scoped to one account and deployment',
    () {
      final store = MeetingCreationRecoveryStore(
        storage: InMemoryCredentialStorage(),
        deployment: Uri.parse('https://api.example.test/api/v1'),
      );

      expect(store.tryAcquireOperation(testUserId, 'first'), isTrue);
      expect(store.tryAcquireOperation(testUserId, 'different'), isFalse);
      store.releaseOperation(testUserId, 'different');
      expect(store.tryAcquireOperation(testUserId, 'second'), isTrue);
      store.releaseOperation(testUserId, 'second');
    },
  );

  test(
    'replay eligibility rejects a record from another account or deployment',
    () async {
      final client = MeetingTestHttpClient((request) async {
        throw StateError('Unexpected request ${request.method} ${request.url}');
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final now = DateTime.utc(2026, 11, 24, 12);
      final controller = MeetingCreationController(
        meetings: MeetingRepository(api: api, invalidation: invalidation),
        recoveryStore: MeetingCreationRecoveryStore(
          storage: api.credentialStorage,
          deployment: api.baseUri,
        ),
        sessionScope: api.requireAuthenticatedSessionScope(),
        now: () => now,
      );
      addTearDown(controller.dispose);
      final record = MeetingCreationRecord(
        accountId: '99999999-9999-4999-8999-999999999999',
        deploymentScope: 'other-deployment',
        idempotencyKey: 'foreign-record',
        input: CreateMeetingInput(title: 'Foreign'),
        action: MeetingCreationAction.saveDraft,
        createdAt: now,
        replayDeadline: now.add(const Duration(hours: 1)),
        phase: MeetingCreationRecordPhase.intentPersisted,
      );

      expect(controller.canReplayCreate(record), isFalse);
    },
  );
}
