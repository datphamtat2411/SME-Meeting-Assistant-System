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
        final recovery = MeetingCreationRecoveryStore(
          storage: api.credentialStorage,
          deployment: api.baseUri,
        );
        final now = DateTime.now().toUtc();
        MeetingCreationController controller() => MeetingCreationController(
          meetings: meetings,
          recoveryStore: recovery,
          sessionScope: scope,
          now: () => now,
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
  });
}
