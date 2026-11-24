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

  test('unknown participant addition holds aggregate ownership through the public mutation', () async {
    final canonicalRead = Completer<http.StreamedResponse>();
    final participantRead = Completer<http.StreamedResponse>();
    final canonicalReadStarted = Completer<void>();
    final participantReadStarted = Completer<void>();
    final initialParticipantsStarted = Completer<void>();
    var detailReads = 0;
    var participantReads = 0;
    var addCalls = 0;
    final addedUserId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (request.method == 'GET' && path.endsWith('/participants')) {
        participantReads++;
        if (participantReads == 1) {
          initialParticipantsStarted.complete();
          return meetingApiSuccess(const <dynamic>[]);
        }
        if (participantReads == 2) {
          participantReadStarted.complete();
          return participantRead.future;
        }
        return meetingApiSuccess([
          {
            'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            'meetingId': testMeetingId,
            'userId': addedUserId,
            'displayName': 'New participant',
            'addedAt': '2026-11-24T12:00:00Z',
            'removedAt': null,
          },
        ]);
      }
      if (request.method == 'GET' &&
          path == '/api/v1/meetings/$testMeetingId') {
        detailReads++;
        if (detailReads == 1) {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': '"aggregate-add-v1"'},
          );
        }
        canonicalReadStarted.complete();
        return canonicalRead.future;
      }
      if (request.method == 'POST' && path.endsWith('/participants')) {
        addCalls++;
        throw http.ClientException('connection lost');
      }
      throw StateError('Unexpected request ${request.method} $path');
    });
    final api = createMeetingTestApi(client);
    addTearDown(api.dispose);
    await signInMeetingTestApi(api);
    final invalidation = MeetingInvalidationSignal(api);
    addTearDown(invalidation.dispose);
    final meetings = MeetingRepository(api: api, invalidation: invalidation);
    final membershipRepository = MeetingMembershipRepository(
      api: api,
      meetings: meetings,
      invalidation: invalidation,
    );
    final detail = MeetingDetailController(
      meetings: meetings,
      membership: membershipRepository,
      rooms: RoomSchedulingRepository(api),
      invalidation: invalidation,
      meetingId: testMeetingId,
    );
    addTearDown(detail.dispose);
    await detail.initialize();
    await initialParticipantsStarted.future;
    await Future<void>.delayed(Duration.zero);

    final membership = MeetingMembershipController(
      repository: membershipRepository,
      snapshot: detail.snapshot!,
      initialRecords: detail.state.participants,
      onSnapshotRecordsChanged: detail.acceptMembershipSnapshotRecords,
      canStartAggregateMutation: () => detail.state.canStartAggregateMutation,
      acquireAggregateMutation: (context) => detail.acquireAggregateMutation(
        MeetingDetailMutation.membership,
        confirmedContext: context,
      ),
      releaseAggregateMutation: detail.releaseAggregateMutation,
      ownsAggregateMutation: detail.ownsAggregateMutation,
      revalidateAggregate: detail.revalidateAggregate,
      refreshCanonical: detail.refreshCanonicalForChild,
    );
    addTearDown(membership.dispose);

    final operation = membership.addParticipant(
      addedUserId,
      confirmedContext: detail.snapshot,
    );
    await canonicalReadStarted.future;

    expect(membership.state.isMutating, isTrue);
    expect(
      membership.state.lastMutation?.status,
      MembershipOperationStatus.unknown,
    );
    expect(
      detail.acquireAggregateMutation(
        MeetingDetailMutation.editing,
        confirmedContext: detail.snapshot,
      ),
      isNull,
    );

    await completeRequestAfter(
      canonicalRead,
      status: 200,
      body: meetingSuccessEnvelope(meetingTestJson()),
      headers: const {'etag': '"aggregate-add-v2"'},
    );
    await participantReadStarted.future;
    expect(membership.state.isMutating, isTrue);
    expect(
      membership.state.lastMutation?.status,
      MembershipOperationStatus.unknown,
    );
    expect(
      detail.acquireAggregateMutation(
        MeetingDetailMutation.editing,
        confirmedContext: detail.snapshot,
      ),
      isNull,
    );

    await completeRequestAfter(
      participantRead,
      status: 200,
      body: meetingSuccessEnvelope([
        {
          'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          'meetingId': testMeetingId,
          'userId': addedUserId,
          'displayName': 'New participant',
          'addedAt': '2026-11-24T12:00:00Z',
          'removedAt': null,
        },
      ]),
    );
    final result = await operation;

    expect(
      result.status,
      MembershipOperationStatus.observed,
      reason:
          'result=${result.status}; reconciled=${result.reconciled}; '
          'records=${membership.state.records.length}; '
          'detailReads=$detailReads; participantReads=$participantReads; '
          'detailPhase=${detail.state.phase}; '
          'detailNeedsRevalidation=${detail.state.needsRevalidation}',
    );
    expect(result.reconciled, isTrue);
    expect(membership.state.isMutating, isFalse);
    expect(membership.state.snapshot?.etag, '"aggregate-add-v2"');
    expect(
      membership.state.activeParticipants.any(
        (participant) => participant.userId == addedUserId,
      ),
      isTrue,
    );
    expect(detail.snapshot?.etag, '"aggregate-add-v2"');
    expect(addCalls, 1);
    expect(
      client.requests.where(
        (request) =>
            request.method == 'POST' &&
            request.url.path.endsWith('/participants'),
      ),
      hasLength(1),
    );
    expect(detail.state.canStartAggregateMutation, isTrue);
  });

  test('participant removal fences publication after asynchronous aggregate acceptance loses ownership', () async {
    final acceptanceParticipants = Completer<http.StreamedResponse>();
    final acceptanceStarted = Completer<void>();
    var participantReads = 0;
    var removeCalls = 0;
    final participant = <String, dynamic>{
      'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'meetingId': testMeetingId,
      'userId': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'displayName': 'Participant',
      'addedAt': '2026-11-24T11:00:00Z',
      'removedAt': null,
    };
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (request.method == 'GET' && path.endsWith('/participants')) {
        participantReads++;
        if (participantReads == 1) {
          return meetingApiSuccess([participant]);
        }
        acceptanceStarted.complete();
        return acceptanceParticipants.future;
      }
      if (request.method == 'GET') {
        return meetingApiSuccess(
          meetingTestJson(),
          headers: const {'etag': '"aggregate-remove-v1"'},
        );
      }
      if (request.method == 'DELETE' &&
          path.endsWith('/participants/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')) {
        removeCalls++;
        return meetingApiSuccess(
          meetingTestJson(),
          headers: const {'etag': '"aggregate-remove-v2"'},
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
    final membershipRepository = MeetingMembershipRepository(
      api: api,
      meetings: meetings,
      invalidation: invalidation,
    );
    final detail = MeetingDetailController(
      meetings: meetings,
      membership: membershipRepository,
      rooms: RoomSchedulingRepository(api),
      invalidation: invalidation,
      meetingId: testMeetingId,
    );
    addTearDown(detail.dispose);
    await detail.initialize();
    await Future<void>.delayed(Duration.zero);
    final membership = MeetingMembershipController(
      repository: membershipRepository,
      snapshot: detail.snapshot!,
      initialRecords: detail.state.participants,
      onSnapshotRecordsChanged: detail.acceptMembershipSnapshotRecords,
      canStartAggregateMutation: () => detail.state.canStartAggregateMutation,
      acquireAggregateMutation: (context) => detail.acquireAggregateMutation(
        MeetingDetailMutation.membership,
        confirmedContext: context,
      ),
      releaseAggregateMutation: detail.releaseAggregateMutation,
      ownsAggregateMutation: detail.ownsAggregateMutation,
      acceptAggregateSnapshotAndReconcile:
          detail.acceptAggregateSnapshotAndReconcile,
    );
    addTearDown(membership.dispose);
    var notificationsAfterInvalidation = 0;
    membership.addListener(() {
      if (membership.state.accessRevoked) {
        notificationsAfterInvalidation++;
      }
    });

    final operation = membership.removeParticipant(
      detail.state.participants.single,
      confirmedContext: detail.snapshot,
    );
    await acceptanceStarted.future;
    membership.clearForCanonicalAccessLoss();
    final stateAfterInvalidation = membership.state;
    await completeRequestAfter(
      acceptanceParticipants,
      status: 200,
      body: meetingSuccessEnvelope(const <dynamic>[]),
    );
    final result = await operation;

    expect(result.status, MembershipOperationStatus.unknown);
    expect(membership.state.accessRevoked, isTrue);
    expect(membership.state.snapshot, isNull);
    expect(membership.state.lastMutation, isNull);
    expect(membership.state.records, isEmpty);
    expect(membership.state, same(stateAfterInvalidation));
    expect(notificationsAfterInvalidation, 1);
    expect(removeCalls, 1);
    expect(
      client.requests.where((request) => request.method == 'DELETE'),
      hasLength(1),
    );
  });

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

      final first = store.tryAcquireOperation(testUserId);
      expect(first, isNotNull);
      expect(store.tryAcquireOperation(testUserId), isNull);
      expect(store.ownsOperation(first!), isTrue);
      store.releaseOperation(first);

      final second = store.tryAcquireOperation(testUserId);
      expect(second, isNotNull);
      store.releaseOperation(first);
      expect(store.ownsOperation(second!), isTrue);
      expect(store.tryAcquireOperation(testUserId), isNull);
      store.releaseOperation(second);

      final finalLease = store.tryAcquireOperation(testUserId);
      expect(finalLease, isNotNull);
      store.releaseOperation(finalLease!);

      final otherAccount = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      final otherAccountLease = store.tryAcquireOperation(otherAccount);
      expect(otherAccountLease, isNotNull);
      final sharedScopeLease = store.tryAcquireOperation(testUserId);
      expect(sharedScopeLease, isNotNull);

      final sameScopeStore = MeetingCreationRecoveryStore(
        storage: InMemoryCredentialStorage(),
        deployment: Uri.parse('https://api.example.test/api/v1'),
      );
      expect(sameScopeStore.tryAcquireOperation(testUserId), isNull);

      final otherDeploymentStore = MeetingCreationRecoveryStore(
        storage: InMemoryCredentialStorage(),
        deployment: Uri.parse('https://other.example.test/api/v1'),
      );
      final otherDeploymentLease = otherDeploymentStore.tryAcquireOperation(
        testUserId,
      );
      expect(otherDeploymentLease, isNotNull);

      store.releaseOperation(otherAccountLease!);
      store.releaseOperation(sharedScopeLease!);
      otherDeploymentStore.releaseOperation(otherDeploymentLease!);
    },
  );

  test('durable recovery writes require an owned lease and preserve rejected state', () async {
    final storage = InMemoryCredentialStorage();
    final deployment = Uri.parse('https://api.example.test/api/v1');
    final store = MeetingCreationRecoveryStore(
      storage: storage,
      deployment: deployment,
    );
    final now = DateTime.utc(2026, 11, 24, 12);
    MeetingCreationRecord record({
      required String accountId,
      required String deploymentScope,
      required String idempotencyKey,
      required String title,
    }) => MeetingCreationRecord(
      accountId: accountId,
      deploymentScope: deploymentScope,
      idempotencyKey: idempotencyKey,
      input: CreateMeetingInput(title: title),
      action: MeetingCreationAction.saveDraft,
      createdAt: now,
      replayDeadline: now.add(const Duration(hours: 1)),
      phase: MeetingCreationRecordPhase.intentPersisted,
    );

    final original = record(
      accountId: testUserId,
      deploymentScope: store.deploymentScope,
      idempotencyKey: 'owned-recovery-write',
      title: 'Owned recovery write',
    );
    final owner = store.tryAcquireOperation(testUserId);
    expect(owner, isNotNull);
    try {
      final saved = await store.save(testUserId, original, lease: owner!);
      expect(saved.idempotencyKey, original.idempotencyKey);
    } finally {
      store.releaseOperation(owner!);
    }

    final persisted = await store.read(testUserId);
    expect(persisted.status, MeetingCreationRecoveryReadStatus.available);
    expect(persisted.record?.input.title, 'Owned recovery write');

    final replacement = record(
      accountId: testUserId,
      deploymentScope: store.deploymentScope,
      idempotencyKey: 'rejected-recovery-write',
      title: 'Rejected recovery write',
    );
    Future<void> expectUnchanged() async {
      final current = await store.read(testUserId);
      expect(current.fingerprint, persisted.fingerprint);
      expect(current.record?.input.title, 'Owned recovery write');
    }

    await expectLater(
      store.save(testUserId, replacement, lease: owner),
      throwsA(isA<MeetingCreationStorageException>()),
    );
    await expectUnchanged();

    final otherAccount = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    final otherAccountLease = store.tryAcquireOperation(otherAccount);
    expect(otherAccountLease, isNotNull);
    try {
      await expectLater(
        store.save(testUserId, replacement, lease: otherAccountLease!),
        throwsA(isA<MeetingCreationStorageException>()),
      );
    } finally {
      store.releaseOperation(otherAccountLease!);
    }
    await expectUnchanged();

    final otherDeploymentStore = MeetingCreationRecoveryStore(
      storage: storage,
      deployment: Uri.parse('https://other.example.test/api/v1'),
    );
    final otherDeploymentLease = otherDeploymentStore.tryAcquireOperation(
      testUserId,
    );
    expect(otherDeploymentLease, isNotNull);
    try {
      await expectLater(
        store.save(testUserId, replacement, lease: otherDeploymentLease!),
        throwsA(isA<MeetingCreationStorageException>()),
      );
    } finally {
      otherDeploymentStore.releaseOperation(otherDeploymentLease!);
    }
    await expectUnchanged();
  });

  test('manual resolution cannot retire a recovery record while another controller creates', () async {
    final createResponse = Completer<http.StreamedResponse>();
    final createStarted = Completer<void>();
    var createCalls = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST' && request.url.path.endsWith('/meetings')) {
        createCalls++;
        createStarted.complete();
        return createResponse.future;
      }
      throw StateError('Unexpected request ${request.method} ${request.url}');
    });
    final api = createMeetingTestApi(client);
    addTearDown(api.dispose);
    await signInMeetingTestApi(api);
    final invalidation = MeetingInvalidationSignal(api);
    addTearDown(invalidation.dispose);
    final meetings = MeetingRepository(api: api, invalidation: invalidation);
    final clock = MeetingCreationReplayClock(
      wallNow: () => DateTime.utc(2026, 11, 24, 12),
      monotonicNow: () => Duration.zero,
    );
    final recovery = MeetingCreationRecoveryStore(
      storage: api.credentialStorage,
      deployment: api.baseUri,
      replayClock: clock,
    );
    final scope = api.requireAuthenticatedSessionScope();
    final controllerA = MeetingCreationController(
      meetings: meetings,
      recoveryStore: recovery,
      sessionScope: scope,
      replayClock: clock,
      createIdempotencyKey: () => 'concurrent-create-a',
    );
    final controllerB = MeetingCreationController(
      meetings: meetings,
      recoveryStore: MeetingCreationRecoveryStore(
        storage: api.credentialStorage,
        deployment: api.baseUri,
        replayClock: clock,
      ),
      sessionScope: scope,
      replayClock: clock,
      createIdempotencyKey: () => 'concurrent-create-b',
    );
    addTearDown(controllerA.dispose);
    addTearDown(controllerB.dispose);

    final creating = controllerA.submit(
      CreateMeetingInput(title: 'Only one creation'),
      MeetingCreationAction.saveDraft,
    );
    await createStarted.future;
    final reviewedRead = await recovery.read(scope.userId);
    final reviewed = MeetingCreationRecoveryContext(
      status: reviewedRead.status,
      record: reviewedRead.record,
      fingerprint: reviewedRead.fingerprint,
    );
    await controllerB.restore();
    expect(controllerB.state.recoveryBusy, isTrue);
    expect(
      await controllerB.resolveAfterManualReview(reviewedContext: reviewed),
      isFalse,
    );
    final unchanged = await recovery.read(scope.userId);
    expect(unchanged.fingerprint, reviewed.fingerprint);
    expect(unchanged.record?.idempotencyKey, 'concurrent-create-a');
    await controllerB.submit(
      CreateMeetingInput(title: 'Second creation'),
      MeetingCreationAction.saveDraft,
    );
    expect(createCalls, 1);

    await completeRequestAfter(
      createResponse,
      status: 201,
      body: meetingSuccessEnvelope(
        meetingTestJson(
          status: 'DRAFT',
          scheduledStartAt: null,
          scheduledEndAt: null,
          title: 'Only one creation',
        ),
      ),
      headers: const {'etag': '"concurrent-v1"'},
    );
    await creating;
    expect(controllerA.state.phase, MeetingCreationPhase.completed);
    expect(
      (await recovery.read(scope.userId)).status,
      MeetingCreationRecoveryReadStatus.missing,
    );
    final available = recovery.tryAcquireOperation(scope.userId);
    expect(available, isNotNull);
    recovery.releaseOperation(available!);
  });

  test(
    'manual resolution cannot delete recovery while another controller replays',
    () async {
      final replayResponse = Completer<http.StreamedResponse>();
      final replayStarted = Completer<void>();
      var createCalls = 0;
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'POST' &&
            request.url.path.endsWith('/meetings')) {
          createCalls++;
          if (createCalls == 1) {
            throw http.ClientException('connection lost');
          }
          replayStarted.complete();
          return replayResponse.future;
        }
        throw StateError('Unexpected request ${request.method} ${request.url}');
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final meetings = MeetingRepository(api: api, invalidation: invalidation);
      final wall = DateTime.utc(2026, 11, 24, 12);
      final clock = MeetingCreationReplayClock(
        wallNow: () => wall,
        monotonicNow: () => Duration.zero,
      );
      final recovery = MeetingCreationRecoveryStore(
        storage: api.credentialStorage,
        deployment: api.baseUri,
        replayClock: clock,
      );
      final scope = api.requireAuthenticatedSessionScope();
      final controllerA = MeetingCreationController(
        meetings: meetings,
        recoveryStore: recovery,
        sessionScope: scope,
        replayClock: clock,
        createIdempotencyKey: () => 'replay-race-key',
      );
      final controllerB = MeetingCreationController(
        meetings: meetings,
        recoveryStore: MeetingCreationRecoveryStore(
          storage: api.credentialStorage,
          deployment: api.baseUri,
          replayClock: clock,
        ),
        sessionScope: scope,
        replayClock: clock,
      );
      addTearDown(controllerA.dispose);
      addTearDown(controllerB.dispose);

      await controllerA.submit(
        CreateMeetingInput(title: 'Replay race'),
        MeetingCreationAction.saveDraft,
      );
      final reviewed = controllerA.recoveryContext!;
      await controllerB.restore();
      final replaying = controllerB.retryUnresolvedCreation();
      await replayStarted.future;

      expect(
        await controllerA.resolveAfterManualReview(reviewedContext: reviewed),
        isFalse,
      );
      expect(
        (await recovery.read(scope.userId)).status,
        MeetingCreationRecoveryReadStatus.available,
      );
      await completeRequestAfter(
        replayResponse,
        status: 201,
        body: meetingSuccessEnvelope(
          meetingTestJson(
            status: 'DRAFT',
            scheduledStartAt: null,
            scheduledEndAt: null,
            title: 'Replay race',
          ),
        ),
        headers: const {'etag': '"replay-race-v1"'},
      );
      await replaying;
      expect(createCalls, 2);
      expect(controllerB.state.phase, MeetingCreationPhase.completed);
      expect(
        (await recovery.read(scope.userId)).status,
        MeetingCreationRecoveryReadStatus.missing,
      );
    },
  );

  test(
    'manual confirmation is rejected when the durable recovery context changes',
    () async {
      var createCalls = 0;
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'POST' &&
            request.url.path.endsWith('/meetings')) {
          createCalls++;
          throw http.ClientException('connection lost');
        }
        throw StateError('Unexpected request ${request.method} ${request.url}');
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final meetings = MeetingRepository(api: api, invalidation: invalidation);
      final clock = MeetingCreationReplayClock(
        wallNow: () => DateTime.utc(2026, 11, 24, 12),
        monotonicNow: () => Duration.zero,
      );
      final recovery = MeetingCreationRecoveryStore(
        storage: api.credentialStorage,
        deployment: api.baseUri,
        replayClock: clock,
      );
      final scope = api.requireAuthenticatedSessionScope();
      var keyIndex = 0;
      final controllerA = MeetingCreationController(
        meetings: meetings,
        recoveryStore: recovery,
        sessionScope: scope,
        replayClock: clock,
        createIdempotencyKey: () =>
            keyIndex++ == 0 ? 'reviewed-record-a' : 'reviewed-record-b',
      );
      final controllerB = MeetingCreationController(
        meetings: meetings,
        recoveryStore: MeetingCreationRecoveryStore(
          storage: api.credentialStorage,
          deployment: api.baseUri,
          replayClock: clock,
        ),
        sessionScope: scope,
        replayClock: clock,
      );
      addTearDown(controllerA.dispose);
      addTearDown(controllerB.dispose);

      await controllerA.submit(
        CreateMeetingInput(title: 'Record A'),
        MeetingCreationAction.saveDraft,
      );
      final reviewedA = controllerA.recoveryContext!;
      expect(
        await controllerA.resolveAfterManualReview(reviewedContext: reviewedA),
        isTrue,
      );
      expect(
        (await recovery.read(scope.userId)).status,
        MeetingCreationRecoveryReadStatus.missing,
      );
      await controllerA.submit(
        CreateMeetingInput(title: 'Record B'),
        MeetingCreationAction.saveDraft,
      );
      await controllerB.restore();
      final before = await recovery.read(scope.userId);
      expect(before.record?.idempotencyKey, isNot('reviewed-record-a'));

      expect(
        await controllerB.resolveAfterManualReview(reviewedContext: reviewedA),
        isFalse,
      );
      final after = await recovery.read(scope.userId);
      expect(after.fingerprint, before.fingerprint);
      expect(after.record?.input.title, 'Record B');
      expect(controllerB.state.phase, MeetingCreationPhase.recoveryRequired);
      expect(controllerB.state.message, contains('thay đổi'));
      expect(createCalls, 2);
    },
  );

  test('replay never recreates a missing durable record', () async {
    var createCalls = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST' && request.url.path.endsWith('/meetings')) {
        createCalls++;
        throw http.ClientException('connection lost');
      }
      throw StateError('Unexpected request ${request.method} ${request.url}');
    });
    final api = createMeetingTestApi(client);
    addTearDown(api.dispose);
    await signInMeetingTestApi(api);
    final invalidation = MeetingInvalidationSignal(api);
    addTearDown(invalidation.dispose);
    final meetings = MeetingRepository(api: api, invalidation: invalidation);
    final clock = MeetingCreationReplayClock(
      wallNow: () => DateTime.utc(2026, 11, 24, 12),
      monotonicNow: () => Duration.zero,
    );
    final recovery = MeetingCreationRecoveryStore(
      storage: api.credentialStorage,
      deployment: api.baseUri,
      replayClock: clock,
    );
    final scope = api.requireAuthenticatedSessionScope();
    final controller = MeetingCreationController(
      meetings: meetings,
      recoveryStore: recovery,
      sessionScope: scope,
      replayClock: clock,
      createIdempotencyKey: () => 'missing-durable-intent',
    );
    addTearDown(controller.dispose);

    await controller.submit(
      CreateMeetingInput(title: 'Missing durable intent'),
      MeetingCreationAction.saveDraft,
    );
    final reviewed = controller.recoveryContext!;
    final lease = recovery.tryAcquireOperation(scope.userId)!;
    final cleanup = await recovery.delete(
      scope.userId,
      lease: lease,
      expectedFingerprint: reviewed.fingerprint!,
      expectedIdempotencyKey: reviewed.record!.idempotencyKey,
    );
    recovery.releaseOperation(lease);
    expect(cleanup.status, MeetingCreationRecoveryDeleteStatus.deleted);

    await controller.retryUnresolvedCreation();
    expect(createCalls, 1);
    expect(controller.state.phase, MeetingCreationPhase.recoveryRequired);
    expect(
      (await recovery.read(scope.userId)).status,
      MeetingCreationRecoveryReadStatus.missing,
    );
  });

  test(
    'replay adopts a more advanced durable phase instead of creating again',
    () async {
      var createCalls = 0;
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'POST' &&
            request.url.path.endsWith('/meetings')) {
          createCalls++;
          throw http.ClientException('connection lost');
        }
        throw StateError('Unexpected request ${request.method} ${request.url}');
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final meetings = MeetingRepository(api: api, invalidation: invalidation);
      final clock = MeetingCreationReplayClock(
        wallNow: () => DateTime.utc(2026, 11, 24, 12),
        monotonicNow: () => Duration.zero,
      );
      final recovery = MeetingCreationRecoveryStore(
        storage: api.credentialStorage,
        deployment: api.baseUri,
        replayClock: clock,
      );
      final scope = api.requireAuthenticatedSessionScope();
      final controller = MeetingCreationController(
        meetings: meetings,
        recoveryStore: recovery,
        sessionScope: scope,
        replayClock: clock,
        createIdempotencyKey: () => 'advanced-durable-intent',
      );
      addTearDown(controller.dispose);

      await controller.submit(
        CreateMeetingInput(title: 'Advanced durable intent'),
        MeetingCreationAction.saveDraft,
      );
      final unresolved = controller.state.record!;
      final lease = recovery.tryAcquireOperation(scope.userId)!;
      try {
        await recovery.save(
          scope.userId,
          unresolved.withPhase(
            MeetingCreationRecordPhase.meetingConfirmed,
            meetingId: testMeetingId,
          ),
          lease: lease,
        );
      } finally {
        recovery.releaseOperation(lease);
      }

      await controller.retryUnresolvedCreation();
      expect(createCalls, 1);
      expect(controller.state.record?.meetingId, testMeetingId);
      expect(controller.state.phase, MeetingCreationPhase.partialSuccess);
      expect(
        (await recovery.read(scope.userId)).record?.meetingId,
        testMeetingId,
      );
    },
  );

  test('changed malformed and unsupported records cannot be deleted by stale review', () async {
    final storage = InMemoryCredentialStorage();
    final client = MeetingTestHttpClient((request) async {
      throw StateError('Unexpected request ${request.method} ${request.url}');
    });
    final api = createMeetingTestApi(client, credentialStorage: storage);
    addTearDown(api.dispose);
    await signInMeetingTestApi(api);
    final invalidation = MeetingInvalidationSignal(api);
    addTearDown(invalidation.dispose);
    final meetings = MeetingRepository(api: api, invalidation: invalidation);
    final store = MeetingCreationRecoveryStore(
      storage: storage,
      deployment: api.baseUri,
    );
    final scope = api.requireAuthenticatedSessionScope();
    final key = meetingRecoveryStorageKey(api.baseUri, scope.userId);
    final controller = MeetingCreationController(
      meetings: meetings,
      recoveryStore: store,
      sessionScope: scope,
    );
    addTearDown(controller.dispose);

    await storage.write(key: key, value: 'malformed-a');
    await controller.restore();
    final malformed = controller.recoveryContext!;
    await storage.write(key: key, value: 'malformed-b');
    expect(
      await controller.resolveAfterManualReview(reviewedContext: malformed),
      isFalse,
    );
    expect(await storage.read(key: key), 'malformed-b');

    await storage.write(key: key, value: '{"version":999}');
    await controller.restore();
    final unsupported = controller.recoveryContext!;
    await storage.write(key: key, value: '{"version":998}');
    expect(
      await controller.resolveAfterManualReview(reviewedContext: unsupported),
      isFalse,
    );
    expect(await storage.read(key: key), '{"version":998}');
  });

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
