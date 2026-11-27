import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_detail.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_editing.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_models.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_workflows.dart';

import 'action_item_foundation_test.dart'
    show itemId, itemJson, pageMeta, repositoryFor;
import 'support/meeting_test_support.dart';

void main() {
  test('restricted projections reject unexpected protected attribution', () {
    const timestamp = '2026-11-24T12:00:00Z';
    const protectedFields = {
      'processingJobId': testRoomId,
      'createdByUserId': testUserId,
      'confirmedByUserId': testUserId,
      'confirmedAt': timestamp,
      'completedByUserId': testUserId,
      'completedAt': timestamp,
      'cancelledByUserId': testUserId,
      'cancelledAt': timestamp,
    };
    for (final entry in protectedFields.entries) {
      expect(
        () => ActionItemResource.fromJson({
          ...itemJson(restricted: true),
          entry.key: entry.value,
        }),
        throwsA(isA<ApiFailure>()),
        reason: entry.key,
      );
    }
    final authorized = ActionItemResource.fromJson({
      ...itemJson(status: 'DONE'),
      'completedByUserId': testUserId,
      'completedAt': timestamp,
    });
    expect(authorized.completedByUserId, testUserId);
    expect(authorized.completedAt, DateTime.parse(timestamp));
    expect(
      ActionItemResource.fromJson(itemJson(restricted: true)).capabilities
          .allows(ActionItemCommand.complete),
      isTrue,
    );
  });

  test('detail ignores only clearly unrelated invalidations', () async {
    var reads = 0;
    final repository = await repositoryFor(
      MeetingTestHttpClient((request) async {
        expect(request.method, 'GET');
        reads++;
        return meetingApiSuccess(
          itemJson(version: reads),
          headers: {'etag': '"v$reads"'},
        );
      }),
    );
    final detail = ActionItemDetailController(
      repository: repository,
      admission: ActionItemMutationAdmission(),
      itemId: itemId,
    );
    addTearDown(detail.dispose);
    await detail.refresh();
    final reviewed = detail.snapshot!;
    final signal = repository.invalidation;
    final scope = repository.captureSession();
    signal.invalidate(sessionScope: scope, meetingId: testRoomId);
    expect(reads, 1);
    expect(detail.snapshot, same(reviewed));
    expect(detail.canExecuteCommand(ActionItemCommand.start, reviewed), isTrue);

    Future<void> invalidateAndWait({String? meetingId}) async {
      final settled = Completer<void>();
      final previous = detail.snapshot;
      void observe() {
        if (detail.canUseSnapshot &&
            !identical(previous, detail.snapshot) &&
            !settled.isCompleted) {
          settled.complete();
        }
      }

      detail.addListener(observe);
      try {
        signal.invalidate(sessionScope: scope, meetingId: meetingId);
        await settled.future;
      } finally {
        detail.removeListener(observe);
      }
    }

    await invalidateAndWait(meetingId: testMeetingId);
    await invalidateAndWait();
    expect(reads, 3);
    expect(
      detail.canExecuteCommand(ActionItemCommand.start, reviewed),
      isFalse,
    );
  });

  test(
    'repeated conflicts require another reviewed conditional write',
    () async {
      var version = 1;
      final writes = <String?>[];
      final repository = await repositoryFor(
        MeetingTestHttpClient((request) async {
          if (request.method == 'PATCH') {
            writes.add(request.headers['If-Match']);
            expect(decodeRequestBody(request), {'title': 'Local'});
            version++;
            if (version < 4) {
              return meetingApiFailure(412, 'RESOURCE_VERSION_CONFLICT');
            }
          }
          return meetingApiSuccess(
            {
              ...itemJson(version: version),
              'title': version == 4 ? 'Local' : 'Server $version',
              'details': version >= 3 ? 'Independent server edit' : null,
            },
            headers: {'etag': '"v$version"'},
          );
        }),
      );
      final detail = ActionItemDetailController(
        repository: repository,
        admission: ActionItemMutationAdmission(),
        itemId: itemId,
      );
      addTearDown(detail.dispose);
      await detail.refresh();
      detail.beginEdit();
      final draft = detail.draft!;
      detail.setDraft(
        ActionItemDraft(
          title: 'Local',
          details: draft.details,
          assigneeUserId: draft.assigneeUserId,
          dueDate: draft.dueDate,
        ),
      );
      for (var attempt = 1; attempt <= 2; attempt++) {
        expect(await detail.save(), isFalse);
        expect(writes.length, attempt);
        final next = attempt + 1;
        expect(detail.reconciliation!.latest.etag, '"v$next"');
        expect(detail.reconciliation!.conflicts, {ActionItemEditField.title});
        expect(await detail.save(), isFalse);
        expect(writes.length, attempt);
        detail.acceptReconciliation({
          ActionItemEditField.title: ActionItemMergeChoice.local,
        });
        expect(detail.draft!.title, 'Local');
      }
      expect(detail.draft!.details, 'Independent server edit');
      expect(await detail.save(), isTrue);
      expect(writes, ['"v1"', '"v2"', '"v3"']);
      expect(detail.snapshot!.item.title, 'Local');
      expect(detail.snapshot!.item.details, 'Independent server edit');
    },
  );

  test(
    'competing detail workflows share admission but not unrelated leases',
    () async {
      final started = Completer<void>();
      final pending = Completer<http.StreamedResponse>();
      var firstVersion = 1;
      var otherVersion = 1;
      final writes = <String>[];
      Map<String, dynamic> canonical(bool other) {
        final version = other ? otherVersion : firstVersion;
        return {
          ...itemJson(
            version: version,
            status: version == 1 ? 'OPEN' : 'IN_PROGRESS',
          ),
          'id': other ? testRoomId : itemId,
        };
      }

      final repository = await repositoryFor(
        MeetingTestHttpClient((request) async {
          final other = request.url.path.contains(testRoomId);
          if (request.method == 'POST') {
            writes.add(request.url.path);
            expect(request.headers['If-Match'], '"v1"');
            if (!other) {
              started.complete();
              return pending.future;
            }
            otherVersion++;
          }
          final version = other ? otherVersion : firstVersion;
          return meetingApiSuccess(
            canonical(other),
            headers: {'etag': '"v$version"'},
          );
        }),
      );
      final owner = ActionItemWorkflowOwner(repository);
      addTearDown(owner.dispose);
      final global = ActionItemDetailController(
        repository: repository,
        admission: owner.admission,
        itemId: itemId,
      );
      final embedded = ActionItemDetailController(
        repository: repository,
        admission: owner.admission,
        itemId: itemId,
        expectedMeetingId: testMeetingId,
      );
      final independent = ActionItemDetailController(
        repository: repository,
        admission: owner.admission,
        itemId: testRoomId,
      );
      addTearDown(global.dispose);
      addTearDown(embedded.dispose);
      addTearDown(independent.dispose);
      await global.refresh();
      await embedded.refresh();
      await independent.refresh();
      final oldEmbedded = embedded.snapshot!;
      final first = global.command(
        ActionItemCommand.start,
        reviewed: global.snapshot!,
      );
      await started.future;
      expect(
        await embedded.command(
          ActionItemCommand.complete,
          reviewed: oldEmbedded,
        ),
        isFalse,
      );
      expect(
        embedded.lifecycleOperation!.phase,
        ActionItemLifecyclePhase.notDispatched,
      );
      expect(writes, hasLength(1));
      expect(
        await independent.command(
          ActionItemCommand.start,
          reviewed: independent.snapshot!,
        ),
        isTrue,
      );
      expect(writes, hasLength(2));
      final refreshed = Completer<void>();
      embedded.addListener(() {
        if (embedded.canUseSnapshot &&
            embedded.snapshot!.item.version == 2 &&
            !refreshed.isCompleted) {
          refreshed.complete();
        }
      });
      firstVersion++;
      pending.complete(
        await meetingApiSuccess(canonical(false), headers: {'etag': '"v2"'}),
      );
      expect(await first, isTrue);
      await refreshed.future;
      expect(embedded.snapshot!.item.status, ActionItemStatus.inProgress);
      expect(
        await embedded.command(
          ActionItemCommand.complete,
          reviewed: oldEmbedded,
        ),
        isFalse,
      );
      expect(writes, hasLength(2));
    },
  );

  test(
    'manual work retains canonical identity across its full lifecycle',
    () async {
      var version = 0;
      var status = 'OPEN';
      String? details;
      final commands = <String>[];
      Map<String, dynamic> canonical() => {
        ...itemJson(status: status, version: version),
        'details': details,
        'dueDate': null,
        if (status == 'DONE') 'completedByUserId': testUserId,
        if (status == 'DONE') 'completedAt': '2026-11-24T12:00:00Z',
      };
      final repository = await repositoryFor(
        MeetingTestHttpClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/management-targets')) {
            return meetingApiSuccess([
              {
                'id': testMeetingId,
                'label': 'Weekly review',
                'restricted': false,
              },
            ], meta: pageMeta());
          }
          if (path.endsWith('/action-items') && request.method == 'POST') {
            expect(request.headers['Idempotency-Key'], isNotNull);
            final body = decodeRequestBody(request);
            expect(body['meetingId'], testMeetingId);
            expect(body['assigneeUserId'], testUserId);
            expect(body['dueDate'], isNull);
            version++;
          } else if (request.method == 'PATCH') {
            expect(request.headers['If-Match'], '"v$version"');
            expect(decodeRequestBody(request), {'details': 'Updated details'});
            details = 'Updated details';
            version++;
          } else if (request.method == 'POST') {
            expect(request.headers['If-Match'], '"v$version"');
            final command = request.url.pathSegments.last;
            commands.add(command);
            status = switch (command) {
              'start' => 'IN_PROGRESS',
              'complete' => 'DONE',
              'reopen' => 'OPEN',
              'cancel' => 'CANCELLED',
              _ => throw StateError('Unexpected command $command'),
            };
            version++;
          }
          return meetingApiSuccess(
            canonical(),
            headers: {'etag': '"v$version"'},
          );
        }),
      );
      final owner = ActionItemWorkflowOwner(repository);
      addTearDown(owner.dispose);
      final scope = repository.captureSession();
      final meeting = await repository.findCreationMeeting(
        testMeetingId,
        sessionScope: scope,
      );
      final created = (await owner.creation.submit(
        input: ActionItemCreateInput(
          meetingId: testMeetingId,
          title: 'Send report',
          assigneeUserId: testUserId,
        ),
        meeting: meeting!,
        assignee: repository.selfCandidate(scope),
      ))!;
      expect(created.item.status, ActionItemStatus.open);
      expect(created.item.official, isTrue);
      expect(created.item.dueDate, isNull);
      final detail = ActionItemDetailController(
        repository: repository,
        admission: owner.admission,
        itemId: created.item.id,
        expectedMeetingId: testMeetingId,
      );
      addTearDown(detail.dispose);
      await detail.refresh();
      detail.beginEdit();
      final draft = detail.draft!;
      detail.setDraft(
        ActionItemDraft(
          title: draft.title,
          details: 'Updated details',
          assigneeUserId: draft.assigneeUserId,
          dueDate: draft.dueDate,
        ),
      );
      expect(await detail.save(), isTrue);
      for (final command in [
        ActionItemCommand.start,
        ActionItemCommand.complete,
        ActionItemCommand.reopen,
        ActionItemCommand.cancel,
      ]) {
        expect(
          await detail.command(command, reviewed: detail.snapshot!),
          isTrue,
        );
        final item = detail.snapshot!.item;
        expect(item.id, itemId);
        expect(item.meetingId, testMeetingId);
        expect(item.official, isTrue);
        expect(item.assigneeUserId, testUserId);
        expect(item.status, command.targetStatus);
        expect(item.details, 'Updated details');
        expect(item.dueDate, isNull);
        if (command == ActionItemCommand.complete) {
          expect(item.completedByUserId, testUserId);
          expect(item.completedAt, isNotNull);
        }
      }
      expect(commands, ['start', 'complete', 'reopen', 'cancel']);
      expect(detail.snapshot!.etag, '"v6"');
      expect(
        detail.canExecuteCommand(ActionItemCommand.reopen, detail.snapshot!),
        isFalse,
      );
    },
  );
}
