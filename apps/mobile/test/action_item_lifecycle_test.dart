import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/features/action_items/action_item_collection.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_detail.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_detail_sheet.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_editing.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_models.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_repository.dart';

import 'action_item_foundation_test.dart'
    show itemId, itemJson, pageMeta, repositoryFor;
import 'support/meeting_test_support.dart';
import 'support/widget_test_support.dart';

Map<String, dynamic> proposal({String? assigneeId, int version = 1}) =>
    itemJson(
      status: 'PROPOSED',
      source: 'AI_EXTRACTED',
      official: false,
      assigneeId: assigneeId,
      version: version,
    );

ActionItemDetailController controllerFor(ActionItemRepository repository) {
  final controller = ActionItemDetailController(
    repository: repository,
    admission: ActionItemMutationAdmission(),
    itemId: itemId,
  );
  addTearDown(controller.dispose);
  return controller;
}

void main() {
  test('preparation and confirmation are separately reviewed writes', () async {
    var patches = 0;
    var commands = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'PATCH') {
        patches++;
        expect(request.headers['If-Match'], '"v1"');
        expect(decodeRequestBody(request), {'assigneeUserId': testUserId});
        return meetingApiSuccess(
          proposal(assigneeId: testUserId, version: 2),
          headers: {'etag': '"v2"'},
        );
      }
      if (request.method == 'POST') {
        commands++;
        expect(request.url.path.endsWith('/confirm'), isTrue);
        expect(request.headers['If-Match'], '"v2"');
        return meetingApiSuccess(
          itemJson(source: 'AI_EXTRACTED', version: 3),
          headers: {'etag': '"v3"'},
        );
      }
      return meetingApiSuccess(proposal(), headers: {'etag': '"v1"'});
    });
    final detail = controllerFor(await repositoryFor(client));
    await detail.refresh();
    final original = detail.snapshot!;
    expect(
      detail.canExecuteCommand(ActionItemCommand.confirm, original),
      isFalse,
    );
    expect(
      detail.canExecuteCommand(ActionItemCommand.reject, original),
      isTrue,
    );
    detail.beginEdit(reviewed: original);
    final draft = detail.draft!;
    detail.setDraft(
      ActionItemDraft(
        title: draft.title,
        details: draft.details,
        assigneeUserId: testUserId,
        dueDate: draft.dueDate,
      ),
    );
    expect(await detail.save(), isTrue);
    expect(patches, 1);
    expect(commands, 0);
    final prepared = detail.snapshot!;
    expect(prepared.item.status, ActionItemStatus.proposed);
    expect(prepared.item.official, isFalse);
    expect(
      await detail.command(ActionItemCommand.confirm, reviewed: original),
      isFalse,
    );
    expect(commands, 0);
    expect(
      await detail.command(ActionItemCommand.confirm, reviewed: prepared),
      isTrue,
    );
    expect(commands, 1);
    expect(detail.snapshot!.item.official, isTrue);
    expect(detail.snapshot!.item.status, ActionItemStatus.open);
    expect(
      detail.lifecycleOperation!.phase,
      ActionItemLifecyclePhase.verifiedSuccess,
    );
    expect(detail.lifecycleOperation!.reviewedVersion, 2);
  });

  test('rejects unassigned proposals without preparing them', () async {
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST') {
        writes++;
        expect(request.url.path.endsWith('/reject'), isTrue);
        return meetingApiSuccess(
          itemJson(
            status: 'CANCELLED',
            source: 'AI_EXTRACTED',
            official: false,
            assigneeId: null,
            version: 2,
          ),
          headers: {'etag': '"v2"'},
        );
      }
      expect(request.method, 'GET');
      return meetingApiSuccess(proposal(), headers: {'etag': '"v1"'});
    });
    final detail = controllerFor(await repositoryFor(client));
    await detail.refresh();
    expect(
      await detail.command(
        ActionItemCommand.reject,
        reviewed: detail.snapshot!,
      ),
      isTrue,
    );
    expect(writes, 1);
    expect(detail.snapshot!.item.official, isFalse);
    expect(detail.snapshot!.item.status, ActionItemStatus.cancelled);
  });

  test('preparation survives a rejected confirmation', () async {
    var prepared = false;
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'PATCH') {
        prepared = true;
      } else if (request.method == 'POST') {
        writes++;
        return meetingApiFailure(409, 'ACTION_ITEM_INVALID_TRANSITION');
      }
      return meetingApiSuccess(
        proposal(
          assigneeId: prepared ? testUserId : null,
          version: prepared ? 2 : 1,
        ),
        headers: {'etag': prepared ? '"v2"' : '"v1"'},
      );
    });
    final detail = controllerFor(await repositoryFor(client));
    await detail.refresh();
    detail.beginEdit();
    final draft = detail.draft!;
    detail.setDraft(
      ActionItemDraft(
        title: draft.title,
        details: draft.details,
        assigneeUserId: testUserId,
        dueDate: draft.dueDate,
      ),
    );
    expect(await detail.save(), isTrue);
    expect(
      await detail.command(
        ActionItemCommand.confirm,
        reviewed: detail.snapshot!,
      ),
      isFalse,
    );
    expect(detail.snapshot!.item.assigneeUserId, testUserId);
    expect(detail.snapshot!.item.status, ActionItemStatus.proposed);
    expect(detail.snapshot!.item.official, isFalse);
    expect(detail.lifecycleOperation!.phase, ActionItemLifecyclePhase.rejected);
    expect(writes, 1);
  });

  for (final status in ['DONE', 'OPEN', 'CANCELLED']) {
    test(
      'unknown completion observes $status without claiming success',
      () async {
        var reads = 0;
        var writes = 0;
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'POST') {
            writes++;
            return meetingApiFailure(500, 'INTERNAL_ERROR');
          }
          reads++;
          if (reads == 2) return meetingApiFailure(503, 'INTERNAL_ERROR');
          return meetingApiSuccess(
            itemJson(status: reads == 1 ? 'OPEN' : status, version: reads),
            headers: {'etag': '"v$reads"'},
          );
        });
        final detail = controllerFor(await repositoryFor(client));
        await detail.refresh();
        final reviewed = detail.snapshot!;
        expect(
          await detail.command(ActionItemCommand.complete, reviewed: reviewed),
          isFalse,
        );
        expect(
          detail.lifecycleOperation!.phase,
          ActionItemLifecyclePhase.unknown,
        );
        expect(detail.lifecycleOperation!.observedStatus, isNull);
        expect(detail.revalidationRequired, isTrue);
        expect(
          await detail.command(ActionItemCommand.complete, reviewed: reviewed),
          isFalse,
        );
        await detail.refresh();
        expect(detail.revalidationRequired, isFalse);
        expect(
          detail.lifecycleOperation!.phase,
          ActionItemLifecyclePhase.unknown,
        );
        expect(detail.lifecycleOperation!.observedStatus!.apiValue, status);
        expect(writes, 1);
      },
    );
  }

  test(
    'missing precondition and validation failures close freshness',
    () async {
      for (final status in [428, 422]) {
        var reads = 0;
        final client = MeetingTestHttpClient((request) async {
          if (request.method == 'POST') {
            return meetingApiFailure(status, 'ACTION_ITEM_INVALID_TRANSITION');
          }
          reads++;
          if (reads > 1) return meetingApiFailure(503, 'INTERNAL_ERROR');
          return meetingApiSuccess(
            proposal(assigneeId: testUserId),
            headers: {'etag': '"v1"'},
          );
        });
        final detail = controllerFor(await repositoryFor(client));
        await detail.refresh();
        final reviewed = detail.snapshot!;
        expect(
          await detail.command(ActionItemCommand.confirm, reviewed: reviewed),
          isFalse,
        );
        expect(reads, 2);
        expect(detail.revalidationRequired, isTrue);
        expect(detail.unresolved, isFalse);
        expect(
          detail.lifecycleOperation!.phase,
          ActionItemLifecyclePhase.rejected,
        );
        expect(
          detail.canExecuteCommand(ActionItemCommand.confirm, reviewed),
          isFalse,
        );
      }
    },
  );

  test('semantic command mismatch is ambiguous, not success', () async {
    final client = MeetingTestHttpClient((request) async {
      return meetingApiSuccess(
        request.method == 'GET'
            ? proposal(assigneeId: testUserId)
            : itemJson(version: 2),
        headers: {'etag': request.method == 'GET' ? '"v1"' : '"v2"'},
      );
    });
    final repository = await repositoryFor(client);
    final reviewed = await repository.detail(
      itemId,
      sessionScope: repository.captureSession(),
    );
    await expectLater(
      repository.command(reviewed, ActionItemCommand.confirm),
      throwsA(
        isA<ActionItemFailure>()
            .having(
              (failure) => failure.category,
              'category',
              ActionItemFailureCategory.invalidResponse,
            )
            .having(
              (failure) => failure.outcome,
              'outcome',
              ActionItemMutationOutcome.unknown,
            ),
      ),
    );
    expect(repository.invalidation.revision, 1);
  });

  testWidgets('OPEN exposes direct completion with explicit confirmation', (
    tester,
  ) async {
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST') {
        writes++;
        expect(request.url.path.endsWith('/complete'), isTrue);
        expect(request.headers['If-Match'], '"v1"');
        return meetingApiSuccess(
          itemJson(status: 'DONE', version: 2),
          headers: {'etag': '"v2"'},
        );
      }
      return meetingApiSuccess(itemJson(), headers: {'etag': '"v1"'});
    });
    final repository = (await tester.runAsync(() => repositoryFor(client)))!;
    tester.view.physicalSize = const Size(800, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: ActionItemDetailPage(
          repository: repository,
          admission: ActionItemMutationAdmission(),
          itemId: itemId,
        ),
      ),
    );
    await pumpUntil(
      tester,
      () => find.text('Send report').evaluate().isNotEmpty,
      reason: 'verified detail',
    );
    final complete = find.widgetWithText(OutlinedButton, 'Hoàn thành');
    await tester.ensureVisible(complete);
    await tester.tap(complete);
    await tester.pumpAndSettle();
    expect(writes, 0);
    await tester.tap(find.widgetWithText(FilledButton, 'Hoàn thành'));
    await pumpUntil(
      tester,
      () => find.text('Đã hoàn thành').evaluate().isNotEmpty,
      reason: 'verified completion',
    );
    expect(writes, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('confirmation dialog cannot reuse an invalidated snapshot', (
    tester,
  ) async {
    var reads = 0;
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST') {
        writes++;
        return meetingApiFailure(409, 'ACTION_ITEM_INVALID_TRANSITION');
      }
      reads++;
      return meetingApiSuccess(
        proposal(assigneeId: testUserId, version: reads),
        headers: {'etag': '"v$reads"'},
      );
    });
    final repository = (await tester.runAsync(() => repositoryFor(client)))!;
    tester.view.physicalSize = const Size(800, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: ActionItemDetailPage(
          repository: repository,
          admission: ActionItemMutationAdmission(),
          itemId: itemId,
        ),
      ),
    );
    await pumpUntil(
      tester,
      () => find.text('Xem xét đề xuất AI').evaluate().isNotEmpty,
      reason: 'proposal review',
    );
    final confirm = find.widgetWithText(FilledButton, 'Xác nhận đề xuất');
    await tester.ensureVisible(confirm);
    await tester.tap(confirm);
    await tester.pumpAndSettle();
    repository.invalidation.invalidate(
      sessionScope: repository.captureSession(),
      actionItemId: itemId,
    );
    await pumpUntil(tester, () => reads == 2, reason: 'invalidated proposal');
    await tester.pumpAndSettle();
    final dialog = find.byType(AlertDialog);
    expect(
      find.descendant(
        of: dialog,
        matching: find.text('Công việc đã thay đổi. Vui lòng xem lại.'),
      ),
      findsOneWidget,
    );
    final staleConfirm = find.descendant(of: dialog, matching: confirm);
    expect(tester.widget<FilledButton>(staleConfirm).onPressed, isNull);
    expect(
      find.descendant(of: dialog, matching: find.textContaining('Test User')),
      findsNothing,
    );
    await tester.tap(find.widgetWithText(TextButton, 'Quay lại'));
    await tester.pumpAndSettle();
    expect(writes, 0);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('prepared proposal survives an unknown confirmation outcome', () async {
    var prepared = false;
    var commands = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'PATCH') {
        expect(request.headers['If-Match'], '"v1"');
        prepared = true;
      } else if (request.method == 'POST') {
        commands++;
        expect(request.headers['If-Match'], '"v2"');
        return meetingApiFailure(500, 'INTERNAL_ERROR');
      }
      return meetingApiSuccess(
        proposal(
          assigneeId: prepared ? testUserId : null,
          version: prepared ? 2 : 1,
        ),
        headers: {'etag': prepared ? '"v2"' : '"v1"'},
      );
    });
    final detail = controllerFor(await repositoryFor(client));
    await detail.refresh();
    detail.beginEdit();
    final draft = detail.draft!;
    detail.setDraft(
      ActionItemDraft(
        title: draft.title,
        details: draft.details,
        assigneeUserId: testUserId,
        dueDate: draft.dueDate,
      ),
    );
    expect(await detail.save(), isTrue);
    expect(commands, 0);
    final reviewed = detail.snapshot!;
    expect(
      await detail.command(ActionItemCommand.confirm, reviewed: reviewed),
      isFalse,
    );
    expect(detail.lifecycleOperation!.phase, ActionItemLifecyclePhase.unknown);
    expect(detail.snapshot!.item.assigneeUserId, testUserId);
    expect(detail.snapshot!.item.status, ActionItemStatus.proposed);
    expect(detail.snapshot!.item.official, isFalse);
    expect(detail.canUseSnapshot, isTrue);
    expect(
      await detail.command(ActionItemCommand.confirm, reviewed: reviewed),
      isFalse,
    );
    expect(commands, 1);
  });

  test('unknown preparation blocks confirmation until reviewed', () async {
    var reads = 0;
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'PATCH') {
        writes++;
        return meetingApiFailure(500, 'INTERNAL_ERROR');
      }
      expect(request.method, 'GET');
      reads++;
      if (reads == 2) return meetingApiFailure(503, 'INTERNAL_ERROR');
      return meetingApiSuccess(
        proposal(
          assigneeId: reads == 1 ? null : testUserId,
          version: reads == 1 ? 1 : 2,
        ),
        headers: {'etag': reads == 1 ? '"v1"' : '"v2"'},
      );
    });
    final detail = controllerFor(await repositoryFor(client));
    await detail.refresh();
    detail.beginEdit();
    final draft = detail.draft!;
    detail.setDraft(
      ActionItemDraft(
        title: draft.title,
        details: draft.details,
        assigneeUserId: testUserId,
        dueDate: draft.dueDate,
      ),
    );
    expect(await detail.save(), isFalse);
    expect(detail.unresolved, isTrue);
    expect(detail.revalidationRequired, isTrue);
    expect(
      await detail.command(
        ActionItemCommand.confirm,
        reviewed: detail.snapshot!,
      ),
      isFalse,
    );
    await detail.refresh();
    expect(detail.reconciliation!.intendedChangesReflected, isTrue);
    expect(
      detail.canExecuteCommand(ActionItemCommand.confirm, detail.snapshot!),
      isFalse,
    );
    detail.acceptReconciliation({});
    expect(detail.unresolved, isFalse);
    expect(detail.hasChanges, isFalse);
    expect(
      detail.canExecuteCommand(ActionItemCommand.confirm, detail.snapshot!),
      isFalse,
    );
    detail.discardEdit();
    expect(
      detail.canExecuteCommand(ActionItemCommand.confirm, detail.snapshot!),
      isTrue,
    );
    expect(writes, 1);
  });

  for (final status in ['INACTIVE', 'PENDING_SETUP']) {
    testWidgets('$status assignee blocks confirmation', (tester) async {
      var writes = 0;
      final raw = proposal(assigneeId: testUserId);
      (raw['assignee'] as Map<String, dynamic>)['accountStatus'] = status;
      (raw['capabilities'] as Map<String, dynamic>)['allowedCommands'] = [
        'REJECT',
      ];
      final client = MeetingTestHttpClient((request) async {
        expect(request.method, 'GET');
        if (request.method != 'GET') writes++;
        return meetingApiSuccess(raw, headers: {'etag': '"v1"'});
      });
      final repository = (await tester.runAsync(() => repositoryFor(client)))!;
      tester.view.physicalSize = const Size(800, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          home: ActionItemDetailPage(
            repository: repository,
            admission: ActionItemMutationAdmission(),
            itemId: itemId,
          ),
        ),
      );
      await pumpUntil(
        tester,
        () => find.text('Xem xét đề xuất AI').evaluate().isNotEmpty,
        reason: 'proposal review',
      );
      expect(
        find.textContaining(
          status == 'INACTIVE'
              ? 'đã ngừng hoạt động'
              : 'chưa kích hoạt tài khoản',
        ),
        findsOneWidget,
      );
      expect(find.text('Xác nhận đề xuất'), findsNothing);
      expect(find.text('Từ chối đề xuất'), findsOneWidget);
      expect(find.text('Chỉnh sửa đề xuất'), findsOneWidget);
      expect(writes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets('revoked access redacts the open confirmation dialog', (
    tester,
  ) async {
    var reads = 0;
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST') writes++;
      if (++reads > 1) return meetingApiFailure(403, 'AUTHZ_FORBIDDEN');
      return meetingApiSuccess(
        proposal(assigneeId: testUserId),
        headers: {'etag': '"v1"'},
      );
    });
    final repository = (await tester.runAsync(() => repositoryFor(client)))!;
    tester.view.physicalSize = const Size(800, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: ActionItemDetailPage(
          repository: repository,
          admission: ActionItemMutationAdmission(),
          itemId: itemId,
        ),
      ),
    );
    await pumpUntil(
      tester,
      () => find.text('Xem xét đề xuất AI').evaluate().isNotEmpty,
      reason: 'proposal review',
    );
    final confirm = find.widgetWithText(FilledButton, 'Xác nhận đề xuất');
    await tester.ensureVisible(confirm);
    await tester.tap(confirm);
    await tester.pumpAndSettle();
    final dialog = find.byType(AlertDialog);
    final privateDescription = find.descendant(
      of: dialog,
      matching: find.textContaining('Test User'),
    );
    expect(privateDescription, findsOneWidget);
    repository.invalidation.invalidate(
      sessionScope: repository.captureSession(),
      actionItemId: itemId,
    );
    await pumpUntil(
      tester,
      () => find.text('Bạn không có quyền thao tác.').evaluate().isNotEmpty,
      reason: 'revoked resource access',
    );
    await tester.pumpAndSettle();
    expect(privateDescription, findsNothing);
    expect(find.text('Send report'), findsNothing);
    final staleConfirm = find.descendant(of: dialog, matching: confirm);
    expect(tester.widget<FilledButton>(staleConfirm).onPressed, isNull);
    await tester.tap(find.widgetWithText(TextButton, 'Quay lại'));
    await tester.pumpAndSettle();
    expect(writes, 0);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('late lifecycle response cannot enter a replacement session', () async {
    final started = Completer<void>();
    final pending = Completer<http.StreamedResponse>();
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST') {
        writes++;
        started.complete();
        return pending.future;
      }
      return meetingApiSuccess(itemJson(), headers: {'etag': '"v1"'});
    });
    final repository = await repositoryFor(client);
    final detail = controllerFor(repository);
    await detail.refresh();
    final reviewed = detail.snapshot!;
    final operation = detail.command(
      ActionItemCommand.complete,
      reviewed: reviewed,
    );
    await started.future;
    await repository.api.signOut();
    await repository.api.signIn('user@example.test', 'password');
    pending.complete(
      await meetingApiSuccess(
        itemJson(status: 'DONE', version: 2),
        headers: {'etag': '"v2"'},
      ),
    );
    expect(await operation, isFalse);
    expect(detail.current, isFalse);
    expect(detail.snapshot, isNull);
    expect(detail.lifecycleOperation, isNull);
    expect(repository.invalidation.revision, 0);
    expect(writes, 1);
  });

  for (final command in [ActionItemCommand.confirm, ActionItemCommand.reject]) {
    test('${command.name} revalidates both collections', () async {
      var canonical = proposal(assigneeId: testUserId);
      var reviewReads = 0;
      var personalReads = 0;
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'POST') {
          expect(request.url.path.endsWith('/${command.name}'), isTrue);
          expect(request.headers['If-Match'], '"v1"');
          canonical = itemJson(
            status: command == ActionItemCommand.confirm ? 'OPEN' : 'CANCELLED',
            source: 'AI_EXTRACTED',
            official: command == ActionItemCommand.confirm,
            version: 2,
          );
          return meetingApiSuccess(canonical, headers: {'etag': '"v2"'});
        }
        final query = request.url.queryParameters;
        if (request.url.path.endsWith('/action-items')) {
          final bool include;
          if (query['reviewable'] == 'true') {
            reviewReads++;
            expect(query['status'], 'PROPOSED');
            include = canonical['status'] == 'PROPOSED';
          } else {
            personalReads++;
            expect(query['assignee'], 'me');
            expect(query['official'], 'true');
            include =
                canonical['official'] == true &&
                canonical['assigneeUserId'] == testUserId;
          }
          return meetingApiSuccess([
            if (include) canonical,
          ], meta: pageMeta(total: include ? 1 : 0));
        }
        return meetingApiSuccess(canonical, headers: {'etag': '"v1"'});
      });
      final repository = await repositoryFor(client);
      final review = ActionItemCollectionController(
        repository: repository,
        criteria: const ActionItemCollectionCriteria(
          mode: ActionItemCollectionMode.needsReview,
        ),
      );
      final personal = ActionItemCollectionController(repository: repository);
      addTearDown(review.dispose);
      addTearDown(personal.dispose);
      await review.initialize();
      await personal.initialize();
      expect(review.state.items.single.id, itemId);
      expect(personal.state.items, isEmpty);
      final revalidated = Completer<void>();
      void observe() {
        if (reviewReads > 1 &&
            personalReads > 1 &&
            review.state.phase == ActionItemCollectionPhase.idle &&
            personal.state.phase == ActionItemCollectionPhase.idle &&
            !revalidated.isCompleted) {
          revalidated.complete();
        }
      }

      review.addListener(observe);
      personal.addListener(observe);
      final detail = controllerFor(repository);
      await detail.refresh();
      expect(await detail.command(command, reviewed: detail.snapshot!), isTrue);
      await revalidated.future;
      expect(review.state.isConfirmedEmpty, isTrue);
      expect(personal.state.failure, isNull);
      if (command == ActionItemCommand.confirm) {
        expect(personal.state.items.single.id, itemId);
        expect(personal.state.items.single.official, isTrue);
      } else {
        expect(personal.state.isConfirmedEmpty, isTrue);
      }
      expect(reviewReads, 2);
      expect(personalReads, 2);
    });
  }

  testWidgets('unknown rejection retains proposal semantics', (tester) async {
    var reads = 0;
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST') {
        writes++;
        expect(request.url.path.endsWith('/reject'), isTrue);
        return meetingApiFailure(500, 'INTERNAL_ERROR');
      }
      if (++reads == 1) {
        return meetingApiSuccess(proposal(), headers: {'etag': '"v1"'});
      }
      return meetingApiSuccess(
        itemJson(
          status: 'CANCELLED',
          source: 'AI_EXTRACTED',
          official: false,
          assigneeId: null,
          version: 2,
        ),
        headers: {'etag': '"v2"'},
      );
    });
    final repository = (await tester.runAsync(() => repositoryFor(client)))!;
    tester.view.physicalSize = const Size(800, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: ActionItemDetailPage(
          repository: repository,
          admission: ActionItemMutationAdmission(),
          itemId: itemId,
        ),
      ),
    );
    await pumpUntil(
      tester,
      () => find.text('Xem xét đề xuất AI').evaluate().isNotEmpty,
      reason: 'proposal review',
    );
    final reject = find.widgetWithText(OutlinedButton, 'Từ chối đề xuất');
    await tester.ensureVisible(reject);
    await tester.tap(reject);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Từ chối đề xuất'));
    await pumpUntil(
      tester,
      () => find
          .textContaining('Trạng thái hiện tại: Đề xuất đã từ chối.')
          .evaluate()
          .isNotEmpty,
      reason: 'semantic recovery feedback',
    );
    expect(find.textContaining('Trạng thái hiện tại: Đã hủy.'), findsNothing);
    expect(writes, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
