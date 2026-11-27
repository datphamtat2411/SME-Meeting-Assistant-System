import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/models.dart';
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
  group('Meeting creation recovery controller', () {
    test(
      'a rejected initial creation does not register replay evidence',
      () async {
        final client = MeetingTestHttpClient((request) async {
          throw StateError(
            'Unexpected request ${request.method} ${request.url}',
          );
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
        final now = DateTime.utc(2026, 11, 24, 12);
        final replayClock = MeetingCreationReplayClock(
          wallNow: () => now,
          monotonicNow: () => Duration.zero,
        );
        final recovery = MeetingCreationRecoveryStore(
          storage: api.credentialStorage,
          deployment: api.baseUri,
          replayClock: replayClock,
        );
        final scope = api.requireAuthenticatedSessionScope();
        final controller = MeetingCreationController(
          meetings: meetings,
          recoveryStore: recovery,
          sessionScope: scope,
          replayClock: replayClock,
          createIdempotencyKey: () => 'rejected-initial-intent',
        );
        addTearDown(controller.dispose);

        final blocker = recovery.tryAcquireOperation(scope.userId);
        expect(blocker, isNotNull);
        try {
          await controller.submit(
            CreateMeetingInput(title: 'Rejected initial intent'),
            MeetingCreationAction.saveDraft,
          );
        } finally {
          recovery.releaseOperation(blocker!);
        }

        expect(controller.state.phase, MeetingCreationPhase.recoveryRequired);
        expect(
          (await recovery.read(scope.userId)).status,
          MeetingCreationRecoveryReadStatus.missing,
        );
        final rejected = MeetingCreationRecord(
          accountId: scope.userId,
          deploymentScope: recovery.deploymentScope,
          idempotencyKey: 'rejected-initial-intent',
          input: CreateMeetingInput(title: 'Rejected initial intent'),
          action: MeetingCreationAction.saveDraft,
          createdAt: now,
          replayDeadline: now.add(meetingCreationReplaySafetyWindow),
          phase: MeetingCreationRecordPhase.intentPersisted,
        );
        expect(controller.canReplayCreate(rejected), isFalse);
        expect(
          client.requests.where(
            (request) =>
                request.method == 'POST' &&
                request.url.path.endsWith('/meetings'),
          ),
          isEmpty,
        );
      },
    );

    test(
      'an occupied durable slot does not register a rejected initial intent',
      () async {
        final client = MeetingTestHttpClient((request) async {
          throw StateError(
            'Unexpected request ${request.method} ${request.url}',
          );
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
        final now = DateTime.utc(2026, 11, 24, 12);
        final replayClock = MeetingCreationReplayClock(
          wallNow: () => now,
          monotonicNow: () => Duration.zero,
        );
        final recovery = MeetingCreationRecoveryStore(
          storage: api.credentialStorage,
          deployment: api.baseUri,
          replayClock: replayClock,
        );
        final scope = api.requireAuthenticatedSessionScope();
        final existing = MeetingCreationRecord(
          accountId: scope.userId,
          deploymentScope: recovery.deploymentScope,
          idempotencyKey: 'existing-durable-intent',
          input: CreateMeetingInput(title: 'Existing durable intent'),
          action: MeetingCreationAction.saveDraft,
          createdAt: now,
          replayDeadline: now.add(meetingCreationReplaySafetyWindow),
          phase: MeetingCreationRecordPhase.intentPersisted,
        );
        final existingLease = recovery.tryAcquireOperation(scope.userId);
        expect(existingLease, isNotNull);
        try {
          await recovery.save(scope.userId, existing, lease: existingLease!);
        } finally {
          recovery.releaseOperation(existingLease!);
        }

        final controller = MeetingCreationController(
          meetings: meetings,
          recoveryStore: recovery,
          sessionScope: scope,
          replayClock: replayClock,
          createIdempotencyKey: () => 'rejected-existing-slot',
        );
        addTearDown(controller.dispose);
        await controller.submit(
          CreateMeetingInput(title: 'Rejected existing slot'),
          MeetingCreationAction.saveDraft,
        );

        expect(controller.state.phase, MeetingCreationPhase.recoveryRequired);
        final rejected = MeetingCreationRecord(
          accountId: scope.userId,
          deploymentScope: recovery.deploymentScope,
          idempotencyKey: 'rejected-existing-slot',
          input: CreateMeetingInput(title: 'Rejected existing slot'),
          action: MeetingCreationAction.saveDraft,
          createdAt: now,
          replayDeadline: now.add(meetingCreationReplaySafetyWindow),
          phase: MeetingCreationRecordPhase.intentPersisted,
        );
        expect(controller.canReplayCreate(rejected), isFalse);
        final current = await recovery.read(scope.userId);
        expect(current.record?.idempotencyKey, existing.idempotencyKey);
        expect(current.record?.input.title, 'Existing durable intent');
      },
    );

    test(
      'replays only the durable original request after an unknown create',
      () async {
        var createCalls = 0;
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'POST' &&
              request.url.path.endsWith('/meetings')) {
            createCalls++;
            if (createCalls == 1) {
              throw http.ClientException('connection lost');
            }
            return meetingApiSuccess(
              meetingTestJson(
                status: 'DRAFT',
                scheduledStartAt: null,
                scheduledEndAt: null,
                title: 'Planning review',
              ),
              status: 201,
              headers: const {'etag': '"created-v1"'},
            );
          }
          throw StateError(
            'Unexpected request ${request.method} ${request.url}',
          );
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
        final scope = api.requireAuthenticatedSessionScope();
        var wallNow = DateTime.utc(2026, 11, 24, 12);
        var monotonicNow = Duration.zero;
        final replayClock = MeetingCreationReplayClock(
          wallNow: () => wallNow,
          monotonicNow: () => monotonicNow,
        );
        final recovery = MeetingCreationRecoveryStore(
          storage: api.credentialStorage,
          deployment: api.baseUri,
          replayClock: replayClock,
        );
        MeetingCreationController controller() => MeetingCreationController(
          meetings: meetings,
          recoveryStore: recovery,
          sessionScope: scope,
          replayClock: replayClock,
          createIdempotencyKey: () => 'stable-create-key',
        );
        var workflow = controller();
        addTearDown(() {
          workflow.dispose();
        });
        final input = CreateMeetingInput(
          title: 'Planning review',
          participantUserIds: const <String>[],
        );

        await workflow.submit(input, MeetingCreationAction.saveDraft);

        expect(workflow.state.phase, MeetingCreationPhase.outcomeUnknown);
        final saved = await recovery.read(scope.userId);
        expect(saved.status, MeetingCreationRecoveryReadStatus.available);
        expect(saved.record?.idempotencyKey, 'stable-create-key');
        expect(saved.record?.input.title, 'Planning review');

        workflow.dispose();
        wallNow = wallNow.add(const Duration(minutes: 1));
        monotonicNow += const Duration(minutes: 1);
        workflow = controller();
        await workflow.restore();
        expect(workflow.state.phase, MeetingCreationPhase.outcomeUnknown);
        await workflow.retryUnresolvedCreation();

        expect(workflow.state.phase, MeetingCreationPhase.completed);
        expect(workflow.state.snapshot?.meeting.id, testMeetingId);
        expect(createCalls, 2);
        final creates = client.requests
            .where(
              (request) =>
                  request.method == 'POST' &&
                  request.url.path.endsWith('/meetings'),
            )
            .toList();
        expect(creates.map((request) => request.headers['idempotency-key']), [
          'stable-create-key',
          'stable-create-key',
        ]);
        expect(creates.map(decodeRequestBody).toList(), hasLength(2));
        expect(
          decodeRequestBody(creates.first),
          decodeRequestBody(creates.last),
        );
        expect(
          (await recovery.read(scope.userId)).status,
          MeetingCreationRecoveryReadStatus.missing,
        );
      },
    );

    test('identity-less recovery after process restart is non-replayable without time evidence', () async {
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
      final storage = api.credentialStorage;
      final originalClock = MeetingCreationReplayClock(
        wallNow: () => DateTime.utc(2026, 11, 24, 12),
        monotonicNow: () => Duration.zero,
      );
      final recovery = MeetingCreationRecoveryStore(
        storage: storage,
        deployment: api.baseUri,
        replayClock: originalClock,
      );
      final scope = api.requireAuthenticatedSessionScope();
      final first = MeetingCreationController(
        meetings: meetings,
        recoveryStore: recovery,
        sessionScope: scope,
        replayClock: originalClock,
        createIdempotencyKey: () => 'restart-uncertain',
      );
      addTearDown(first.dispose);
      await first.submit(
        CreateMeetingInput(title: 'Restart recovery'),
        MeetingCreationAction.saveDraft,
      );
      first.dispose();

      final freshClock = MeetingCreationReplayClock(
        wallNow: () => DateTime.utc(2026, 11, 24, 12, 5),
        monotonicNow: () => Duration.zero,
      );
      final restored = MeetingCreationController(
        meetings: meetings,
        recoveryStore: MeetingCreationRecoveryStore(
          storage: storage,
          deployment: api.baseUri,
          replayClock: freshClock,
        ),
        sessionScope: scope,
        replayClock: freshClock,
      );
      addTearDown(restored.dispose);
      await restored.restore();

      expect(restored.state.phase, MeetingCreationPhase.recoveryRequired);
      expect(restored.canReplayCreate(restored.state.record!), isFalse);
      expect(
        restored.state.message,
        contains('Không thể xác minh thời hạn gửi lại an toàn'),
      );
      await restored.retryUnresolvedCreation();
      expect(createCalls, 1);
      expect(
        (await recovery.read(scope.userId)).status,
        MeetingCreationRecoveryReadStatus.available,
      );
      expect(restored.state.hasUnresolvedOperation, isTrue);
    });

    test('wall-clock rollback cannot restore replay eligibility after controller recreation', () async {
      var wall = DateTime.utc(2026, 11, 24, 12);
      var monotonic = Duration.zero;
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
        wallNow: () => wall,
        monotonicNow: () => monotonic,
      );
      final recovery = MeetingCreationRecoveryStore(
        storage: api.credentialStorage,
        deployment: api.baseUri,
        replayClock: clock,
      );
      final scope = api.requireAuthenticatedSessionScope();
      final first = MeetingCreationController(
        meetings: meetings,
        recoveryStore: recovery,
        sessionScope: scope,
        replayClock: clock,
        createIdempotencyKey: () => 'rollback-key',
      );
      addTearDown(first.dispose);
      await first.submit(
        CreateMeetingInput(title: 'Rollback recovery'),
        MeetingCreationAction.saveDraft,
      );
      wall = wall.subtract(const Duration(minutes: 5));
      monotonic = const Duration(hours: 1);
      first.dispose();

      final recreated = MeetingCreationController(
        meetings: meetings,
        recoveryStore: recovery,
        sessionScope: scope,
        replayClock: clock,
      );
      addTearDown(recreated.dispose);
      await recreated.restore();
      expect(recreated.state.phase, MeetingCreationPhase.recoveryRequired);
      expect(
        recreated.state.message,
        contains('Không thể xác minh thời hạn gửi lại an toàn'),
      );
      await recreated.retryUnresolvedCreation();
      expect(createCalls, 1);
      expect(
        (await recovery.read(scope.userId)).status,
        MeetingCreationRecoveryReadStatus.available,
      );
    });

    test(
      'replay expiration during durable preparation prevents creation dispatch',
      () async {
        var wall = DateTime.utc(2026, 11, 24, 12);
        var monotonic = Duration.zero;
        var createCalls = 0;
        final storage = ControllableMeetingCredentialStorage();
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'POST' &&
              request.url.path.endsWith('/meetings')) {
            createCalls++;
            throw http.ClientException('connection lost');
          }
          throw StateError(
            'Unexpected request ${request.method} ${request.url}',
          );
        });
        final api = createMeetingTestApi(client, credentialStorage: storage);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final meetings = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );
        final clock = MeetingCreationReplayClock(
          wallNow: () => wall,
          monotonicNow: () => monotonic,
        );
        final recovery = MeetingCreationRecoveryStore(
          storage: storage,
          deployment: api.baseUri,
          replayClock: clock,
        );
        final scope = api.requireAuthenticatedSessionScope();
        final controller = MeetingCreationController(
          meetings: meetings,
          recoveryStore: recovery,
          sessionScope: scope,
          replayClock: clock,
          createIdempotencyKey: () => 'preparation-expiry',
        );
        addTearDown(controller.dispose);
        await controller.submit(
          CreateMeetingInput(title: 'Preparation expiry'),
          MeetingCreationAction.saveDraft,
        );
        storage.holdNextDurabilityConfirmation();
        final replay = controller.retryUnresolvedCreation();
        await storage.waitForDurabilityConfirmation();
        wall = wall.add(const Duration(hours: 24));
        monotonic = const Duration(hours: 24);
        storage.releaseDurabilityConfirmation();
        await replay;

        expect(createCalls, 1);
        expect(controller.state.phase, MeetingCreationPhase.recoveryRequired);
        expect(
          (await recovery.read(scope.userId)).status,
          MeetingCreationRecoveryReadStatus.available,
        );
      },
    );

    test(
      'initial replay evidence keeps the original deadline during preparation',
      () async {
        var monotonic = Duration.zero;
        var createCalls = 0;
        final storage = ControllableMeetingCredentialStorage();
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'POST' &&
              request.url.path.endsWith('/meetings')) {
            createCalls++;
            throw http.ClientException('connection lost');
          }
          throw StateError(
            'Unexpected request ${request.method} ${request.url}',
          );
        });
        final api = createMeetingTestApi(client, credentialStorage: storage);
        addTearDown(api.dispose);
        addTearDown(storage.releaseDurabilityConfirmation);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final meetings = MeetingRepository(
          api: api,
          invalidation: invalidation,
        );
        final now = DateTime.utc(2026, 11, 24, 12);
        final replayClock = MeetingCreationReplayClock(
          wallNow: () => now,
          monotonicNow: () => monotonic,
        );
        final recovery = MeetingCreationRecoveryStore(
          storage: storage,
          deployment: api.baseUri,
          replayClock: replayClock,
        );
        final scope = api.requireAuthenticatedSessionScope();
        final controller = MeetingCreationController(
          meetings: meetings,
          recoveryStore: recovery,
          sessionScope: scope,
          replayClock: replayClock,
          createIdempotencyKey: () => 'pre-registration-deadline',
        );
        addTearDown(controller.dispose);

        storage.holdNextDurabilityConfirmation();
        final initial = controller.submit(
          CreateMeetingInput(title: 'Pre-registration deadline'),
          MeetingCreationAction.saveDraft,
        );
        await storage.waitForDurabilityConfirmation();
        monotonic =
            meetingCreationReplaySafetyWindow + const Duration(minutes: 1);
        storage.releaseDurabilityConfirmation();
        await initial;

        expect(createCalls, 1);
        expect(controller.state.phase, MeetingCreationPhase.outcomeUnknown);
        final unresolved = controller.state.record!;
        expect(controller.canReplayCreate(unresolved), isFalse);
        await controller.retryUnresolvedCreation();
        expect(createCalls, 1);
      },
    );
  });

  group('Meeting creation hardening', () {
    test('a room conflict does not block saving a draft', () async {
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'POST' &&
            request.url.path.endsWith('/meetings')) {
          return meetingApiSuccess(
            meetingTestJson(
              status: 'DRAFT',
              scheduledStartAt: null,
              scheduledEndAt: null,
              roomId: testRoomId,
            ),
            status: 201,
            headers: const {'etag': '"draft-v1"'},
          );
        }
        throw StateError('Unexpected request ${request.method} ${request.url}');
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final controller = MeetingCreationController(
        meetings: MeetingRepository(api: api, invalidation: invalidation),
        recoveryStore: MeetingCreationRecoveryStore(
          storage: api.credentialStorage,
          deployment: api.baseUri,
        ),
        sessionScope: api.requireAuthenticatedSessionScope(),
        createIdempotencyKey: () => 'draft-with-conflict',
      );
      addTearDown(controller.dispose);

      await controller.submit(
        CreateMeetingInput(title: 'Draft despite conflict', roomId: testRoomId),
        MeetingCreationAction.saveDraft,
        blockingRoomConflict: true,
      );

      expect(controller.state.phase, MeetingCreationPhase.completed);
      expect(
        client.requests.where(
          (request) =>
              request.method == 'POST' &&
              request.url.path.endsWith('/meetings'),
        ),
        hasLength(1),
      );
    });

    test(
      'a rejected replay preserves the unresolved original intent',
      () async {
        var createCalls = 0;
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'POST' &&
              request.url.path.endsWith('/meetings')) {
            createCalls++;
            if (createCalls == 1) throw http.ClientException('connection lost');
            return meetingApiFailure(429, 'RATE_LIMITED');
          }
          throw StateError(
            'Unexpected request ${request.method} ${request.url}',
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final recovery = MeetingCreationRecoveryStore(
          storage: api.credentialStorage,
          deployment: api.baseUri,
        );
        final controller = MeetingCreationController(
          meetings: MeetingRepository(api: api, invalidation: invalidation),
          recoveryStore: recovery,
          sessionScope: api.requireAuthenticatedSessionScope(),
          createIdempotencyKey: () => 'preserve-original-intent',
        );
        addTearDown(controller.dispose);
        final input = CreateMeetingInput(title: 'Uncertain creation');

        await controller.submit(input, MeetingCreationAction.saveDraft);
        await controller.retryUnresolvedCreation();

        expect(controller.state.phase, MeetingCreationPhase.recoveryRequired);
        expect(
          controller.state.record?.idempotencyKey,
          'preserve-original-intent',
        );
        expect(controller.state.record?.input.title, input.title);
        final persisted = await recovery.read(controller.sessionScope.userId);
        expect(persisted.record?.idempotencyKey, 'preserve-original-intent');
        expect(createCalls, 2);
      },
    );

    test(
      'a replayed DRAFT is reviewed instead of scheduled automatically',
      () async {
        var createCalls = 0;
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'POST' &&
              request.url.path.endsWith('/meetings')) {
            createCalls++;
            if (createCalls == 1) throw http.ClientException('connection lost');
            return meetingApiSuccess(
              meetingTestJson(
                status: 'DRAFT',
                title: 'Planning review',
                roomId: testRoomId,
              ),
              status: 201,
              headers: const {'etag': '"recovered-draft-v2"'},
            );
          }
          throw StateError(
            'Unexpected request ${request.method} ${request.url}',
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final controller = MeetingCreationController(
          meetings: MeetingRepository(api: api, invalidation: invalidation),
          recoveryStore: MeetingCreationRecoveryStore(
            storage: api.credentialStorage,
            deployment: api.baseUri,
          ),
          sessionScope: api.requireAuthenticatedSessionScope(),
          createIdempotencyKey: () => 'review-recovered-draft',
        );
        addTearDown(controller.dispose);
        final interval = MeetingInterval(
          start: DateTime.utc(2026, 11, 24, 9),
          end: DateTime.utc(2026, 11, 24, 10),
        );

        await controller.submit(
          CreateMeetingInput(
            title: 'Planning review',
            scheduledInterval: interval,
            roomId: testRoomId,
          ),
          MeetingCreationAction.schedule,
        );
        await controller.retryUnresolvedCreation();

        expect(controller.state.phase, MeetingCreationPhase.partialSuccess);
        expect(
          controller.state.snapshot?.meeting.lifecycleStatus,
          MeetingStatus.draft,
        );
        expect(controller.state.record?.meetingId, testMeetingId);
        expect(
          client.requests.where(
            (request) =>
                request.method == 'POST' &&
                request.url.path.endsWith('/schedule'),
          ),
          isEmpty,
        );
      },
    );

    test('an unknown schedule that still reads as the matching DRAFT stays unresolved', () async {
      var detailReads = 0;
      var scheduleCalls = 0;
      final interval = MeetingInterval(
        start: DateTime.utc(2026, 11, 24, 9),
        end: DateTime.utc(2026, 11, 24, 10),
      );
      final client = MeetingTestHttpClient((request) async {
        final path = request.url.path;
        if (request.method == 'POST' && path.endsWith('/meetings')) {
          return meetingApiSuccess(
            meetingTestJson(status: 'DRAFT', roomId: testRoomId),
            status: 201,
            headers: const {'etag': '"created-draft-v1"'},
          );
        }
        if (request.method == 'POST' && path.endsWith('/schedule')) {
          scheduleCalls++;
          throw http.ClientException('connection lost');
        }
        if (request.method == 'GET' && path.endsWith('/$testMeetingId')) {
          detailReads++;
          return meetingApiSuccess(
            meetingTestJson(status: 'DRAFT', roomId: testRoomId),
            headers: const {'etag': '"still-draft-v2"'},
          );
        }
        throw StateError('Unexpected request ${request.method} $path');
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final controller = MeetingCreationController(
        meetings: MeetingRepository(api: api, invalidation: invalidation),
        recoveryStore: MeetingCreationRecoveryStore(
          storage: api.credentialStorage,
          deployment: api.baseUri,
        ),
        sessionScope: api.requireAuthenticatedSessionScope(),
        createIdempotencyKey: () => 'unknown-schedule-stays-draft',
      );
      addTearDown(controller.dispose);

      await controller.submit(
        CreateMeetingInput(
          title: 'Draft schedule',
          scheduledInterval: interval,
          roomId: testRoomId,
        ),
        MeetingCreationAction.schedule,
      );

      expect(controller.state.phase, MeetingCreationPhase.partialSuccess);
      expect(
        controller.state.snapshot?.meeting.lifecycleStatus,
        MeetingStatus.draft,
      );
      expect(controller.state.record?.meetingId, testMeetingId);
      expect(scheduleCalls, 1);
      expect(detailReads, 1);
    });
  });

  group('Meeting editing controller', () {
    test('sends only changed fields with the original version', () async {
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(title: 'Original title'),
            headers: const {'etag': '"edit-v1"'},
          );
        }
        if (request.method == 'PATCH') {
          expect(request.headers['if-match'], '"edit-v1"');
          expect(decodeRequestBody(request), {'title': 'Updated title'});
          return meetingApiSuccess(
            meetingTestJson(title: 'Updated title'),
            headers: const {'etag': '"edit-v2"'},
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
          title: 'Updated title',
          description: snapshot.meeting.description,
          start: snapshot.meeting.scheduledStartAt,
          end: snapshot.meeting.scheduledEndAt,
          roomId: snapshot.meeting.roomId,
        ),
      );

      await controller.submit();

      expect(controller.state.phase, MeetingEditPhase.completed);
      expect(controller.state.snapshot?.etag, '"edit-v2"');
      expect(controller.state.dirtyFields, isEmpty);
      expect(
        client.requests.where((request) => request.method == 'PATCH'),
        hasLength(1),
      );
    });

    test(
      'requires conflict choices and a new explicit submit after rebase',
      () async {
        var detailReads = 0;
        var patchCalls = 0;
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'GET') {
            detailReads++;
            return meetingApiSuccess(
              meetingTestJson(
                title: detailReads == 1 ? 'Original title' : 'Server title',
              ),
              headers: {'etag': detailReads == 1 ? '"edit-v1"' : '"edit-v2"'},
            );
          }
          if (request.method == 'PATCH') {
            patchCalls++;
            if (patchCalls == 1) {
              expect(request.headers['if-match'], '"edit-v1"');
              return meetingApiFailure(412, 'PRECONDITION_FAILED');
            }
            expect(request.headers['if-match'], '"edit-v2"');
            expect(decodeRequestBody(request), {'title': 'My title'});
            return meetingApiSuccess(
              meetingTestJson(title: 'My title'),
              headers: const {'etag': '"edit-v3"'},
            );
          }
          throw StateError(
            'Unexpected request ${request.method} ${request.url}',
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
        final controller = MeetingEditingController(
          repository: repository,
          invalidation: invalidation,
          snapshot: snapshot,
        );
        addTearDown(controller.dispose);
        controller.updateValues(
          MeetingEditValues(
            title: 'My title',
            description: snapshot.meeting.description,
            start: snapshot.meeting.scheduledStartAt,
            end: snapshot.meeting.scheduledEndAt,
            roomId: snapshot.meeting.roomId,
          ),
        );

        await controller.submit();

        expect(controller.state.phase, MeetingEditPhase.rebaseRequired);
        expect(
          controller.state.reconciliation?.conflicts,
          contains(MeetingEditField.title),
        );
        expect(patchCalls, 1);
        controller.chooseConflict(
          MeetingEditField.title,
          MeetingEditFieldChoice.local,
        );
        controller.acceptReconciliation();
        expect(controller.state.phase, MeetingEditPhase.editing);
        expect(controller.state.snapshot?.etag, '"edit-v2"');
        expect(controller.state.canSubmit, isTrue);

        await controller.submit();

        expect(controller.state.phase, MeetingEditPhase.completed);
        expect(controller.state.snapshot?.etag, '"edit-v3"');
        expect(patchCalls, 2);
      },
    );

    test(
      'does not accept an edit reconciliation invalidated while it is loading',
      () async {
        final revalidationResponse = Completer<http.StreamedResponse>();
        final revalidationStarted = Completer<void>();
        var detailReads = 0;
        final client = MeetingTestHttpClient((request) async {
          if (request.method != 'GET') {
            throw StateError('Unexpected request ${request.method}');
          }
          detailReads++;
          if (detailReads == 1) {
            return meetingApiSuccess(
              meetingTestJson(title: 'Original title'),
              headers: const {'etag': '"edit-v1"'},
            );
          }
          revalidationStarted.complete();
          return revalidationResponse.future;
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
            title: 'Local title',
            description: snapshot.meeting.description,
            start: snapshot.meeting.scheduledStartAt,
            end: snapshot.meeting.scheduledEndAt,
            roomId: snapshot.meeting.roomId,
          ),
        );

        final revalidation = controller.revalidateLatest();
        await revalidationStarted.future;
        invalidation.invalidate(
          sessionScope: snapshot.sessionScope,
          meetingId: testMeetingId,
        );
        await completeRequestAfter(
          revalidationResponse,
          status: 200,
          body: meetingSuccessEnvelope(meetingTestJson(title: 'Server title')),
          headers: const {'etag': '"edit-v2"'},
        );
        await revalidation;

        expect(controller.state.needsRevalidation, isTrue);
        expect(controller.state.canSubmit, isFalse);
        controller.acceptReconciliation();
        expect(controller.state.snapshot?.etag, '"edit-v1"');
        expect(controller.state.canSubmit, isFalse);
      },
    );
  });

  group('Meeting detail lifecycle controller', () {
    test('uses the current version for a confirmed lifecycle action', () async {
      final client = MeetingTestHttpClient((request) async {
        final path = request.url.path;
        if (request.method == 'GET' && path.endsWith('/participants')) {
          return meetingApiSuccess(const <dynamic>[]);
        }
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(),
            headers: const {'etag': '"detail-v1"'},
          );
        }
        if (request.method == 'POST' && path.endsWith('/start')) {
          expect(request.headers['if-match'], '"detail-v1"');
          return meetingApiSuccess(
            meetingTestJson(status: 'IN_PROGRESS'),
            headers: const {'etag': '"detail-v2"'},
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
      final confirmedContext = controller.snapshot!;

      final result = await controller.runLifecycle(
        command: MeetingLifecycleCommand.start,
        confirmedContext: confirmedContext,
      );

      expect(result.status, MeetingLifecycleResultStatus.confirmed);
      expect(controller.snapshot?.etag, '"detail-v2"');
      expect(
        controller.snapshot?.meeting.lifecycleStatus,
        MeetingStatus.inProgress,
      );
      expect(
        client.requests.where(
          (request) =>
              request.method == 'POST' && request.url.path.endsWith('/start'),
        ),
        hasLength(1),
      );
    });

    test('reconciles an unknown lifecycle result without replaying the command', () async {
      var startCalls = 0;
      var detailReads = 0;
      final client = MeetingTestHttpClient((request) async {
        final path = request.url.path;
        if (request.method == 'GET' && path.endsWith('/participants')) {
          return meetingApiSuccess(const <dynamic>[]);
        }
        if (request.method == 'GET') {
          detailReads++;
          return meetingApiSuccess(
            meetingTestJson(
              status: detailReads == 1 ? 'SCHEDULED' : 'IN_PROGRESS',
            ),
            headers: {'etag': detailReads == 1 ? '"detail-v1"' : '"detail-v2"'},
          );
        }
        if (request.method == 'POST' && path.endsWith('/start')) {
          startCalls++;
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

      final result = await controller.runLifecycle(
        command: MeetingLifecycleCommand.start,
        confirmedContext: controller.snapshot!,
      );

      expect(
        result.status,
        MeetingLifecycleResultStatus.observed,
        reason:
            '${result.message}; failure=${result.failure}; reads=$detailReads; phase=${controller.state.phase}',
      );
      expect(startCalls, 1);
      expect(detailReads, 2);
      expect(
        controller.snapshot?.meeting.lifecycleStatus,
        MeetingStatus.inProgress,
      );
      expect(controller.state.phase, MeetingDetailPhase.ready);
      expect(controller.state.needsRevalidation, isFalse);
    });

    test(
      'holds recovery state when an unknown lifecycle result is not observed',
      () async {
        final client = MeetingTestHttpClient((request) async {
          final path = request.url.path;
          if (request.method == 'GET' && path.endsWith('/participants')) {
            return meetingApiSuccess(const <dynamic>[]);
          }
          if (request.method == 'GET') {
            return meetingApiSuccess(
              meetingTestJson(),
              headers: const {'etag': '"detail-v1"'},
            );
          }
          if (request.method == 'POST' && path.endsWith('/start')) {
            throw http.ClientException('connection lost');
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

        final result = await controller.runLifecycle(
          command: MeetingLifecycleCommand.start,
          confirmedContext: controller.snapshot!,
        );

        expect(
          result.status,
          MeetingLifecycleResultStatus.unknown,
          reason: '${result.message}; phase=${controller.state.phase}',
        );
        expect(
          controller.state.phase,
          MeetingDetailPhase.recoveryRequired,
          reason: controller.state.message,
        );
        expect(controller.state.needsRevalidation, isTrue);
        expect(controller.state.canStartAggregateMutation, isFalse);
        expect(
          client.requests.where(
            (request) =>
                request.method == 'GET' &&
                request.url.path == '/api/v1/meetings/$testMeetingId',
          ),
          hasLength(2),
        );
        expect(
          client.requests.where(
            (request) =>
                request.method == 'POST' && request.url.path.endsWith('/start'),
          ),
          hasLength(1),
        );
      },
    );

    test(
      'unknown scheduling requires the same authoritative room and interval',
      () async {
        var detailReads = 0;
        var scheduleCalls = 0;
        final client = MeetingTestHttpClient((request) async {
          final path = request.url.path;
          if (request.method == 'GET' && path.endsWith('/participants')) {
            return meetingApiSuccess(const <dynamic>[]);
          }
          if (request.method == 'GET' &&
              path == '/api/v1/meetings/$testMeetingId') {
            detailReads++;
            return meetingApiSuccess(
              meetingTestJson(
                status: detailReads == 1 ? 'DRAFT' : 'SCHEDULED',
                roomId: detailReads == 1 ? testRoomId : testUserId,
              ),
              headers: {'etag': '"schedule-v$detailReads"'},
            );
          }
          if (request.method == 'POST' && path.endsWith('/schedule')) {
            scheduleCalls++;
            throw http.ClientException('connection lost');
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

        final result = await controller.runLifecycle(
          command: MeetingLifecycleCommand.schedule,
          confirmedContext: controller.snapshot!,
        );

        expect(result.status, MeetingLifecycleResultStatus.unknown);
        expect(controller.state.phase, MeetingDetailPhase.recoveryRequired);
        expect(controller.snapshot?.meeting.roomId, testUserId);
        expect(scheduleCalls, 1);
        expect(detailReads, 2);
      },
    );

    test(
      'membership mutations reconcile through the detail owner snapshot',
      () async {
        var detailReads = 0;
        var membershipReads = 0;
        final client = MeetingTestHttpClient((request) async {
          final path = request.url.path;
          if (request.method == 'GET' && path.endsWith('/participants')) {
            membershipReads++;
            return meetingApiSuccess([
              {
                'id': testRoomId,
                'meetingId': testMeetingId,
                'userId': testUserId,
                'displayName': 'Test User',
                'addedAt': '2026-11-20T10:00:00Z',
                'removedAt': null,
              },
              if (membershipReads > 1)
                {
                  'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                  'meetingId': testMeetingId,
                  'userId': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                  'displayName': 'New participant',
                  'addedAt': '2026-11-24T12:00:00Z',
                  'removedAt': null,
                },
            ]);
          }
          if (request.method == 'GET') {
            detailReads++;
            return meetingApiSuccess(
              meetingTestJson(),
              headers: {
                'etag': detailReads == 1 ? '"detail-v1"' : '"detail-v2"',
              },
            );
          }
          if (request.method == 'POST' && path.endsWith('/participants')) {
            expect(request.headers['if-match'], '"detail-v1"');
            return meetingApiSuccess({
              'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              'meetingId': testMeetingId,
              'userId': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              'displayName': 'New participant',
              'addedAt': '2026-11-24T12:00:00Z',
              'removedAt': null,
            }, status: 201);
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
          canStartAggregateMutation: () =>
              detail.state.canStartAggregateMutation,
          acquireAggregateMutation: (context) =>
              detail.acquireAggregateMutation(
                MeetingDetailMutation.membership,
                confirmedContext: context,
              ),
          releaseAggregateMutation: detail.releaseAggregateMutation,
          ownsAggregateMutation: detail.ownsAggregateMutation,
          acceptAggregateSnapshot: detail.acceptAggregateSnapshot,
          revalidateAggregate: detail.revalidateAggregate,
          refreshCanonical: detail.refreshCanonicalForChild,
        );
        addTearDown(membership.dispose);

        final result = await membership.addParticipant(
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          confirmedContext: detail.snapshot,
        );

        expect(result.status, MembershipOperationStatus.confirmed);
        expect(detail.snapshot?.etag, '"detail-v2"');
        expect(membership.state.snapshot?.etag, '"detail-v2"');
        expect(
          detail.state.participants.any(
            (participant) =>
                participant.userId == 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          ),
          isTrue,
        );
        expect(detail.state.canStartAggregateMutation, isTrue);
        expect(detailReads, 2);
        expect(membershipReads, greaterThanOrEqualTo(2));
      },
    );
  });
}
