import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_create_sheet.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_creation.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_detail.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_detail_sheet.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_models.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_picker.dart';
import 'package:sme_meeting_assistant/features/action_items/action_items_page.dart';

import 'action_item_foundation_test.dart' show itemId, itemJson, repositoryFor;
import 'support/meeting_test_support.dart';
import 'support/widget_test_support.dart';

Map<String, dynamic> _pageMeta(int size, int total) => {
  ...meetingTestMeta,
  'pagination': {
    'page': 0,
    'size': size,
    'totalElements': total,
    'totalPages': total == 0 ? 0 : 1,
    'hasNext': false,
    'hasPrevious': false,
  },
};

void main() {
  testWidgets('selected meeting label follows authorized collection', (
    tester,
  ) async {
    var restricted = false;
    var deny = false;
    final client = MeetingTestHttpClient((request) async {
      if (request.url.path.endsWith('/creation-meetings')) {
        return meetingApiSuccess([], meta: _pageMeta(1, 0));
      }
      if (deny) return meetingApiFailure(403, 'AUTHZ_FORBIDDEN');
      return meetingApiSuccess(
        [itemJson(restricted: restricted)],
        meta: _pageMeta(20, 1),
      );
    });
    final api = createMeetingTestApi(client);
    await tester.runAsync(() => signInMeetingTestApi(api));
    final dependencies = AppDependencies(
      api: api,
      appearancePreferences: InMemoryAppearancePreferences(),
      httpClient: client,
    );
    addTearDown(dependencies.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ActionItemsPage(dependencies: dependencies)),
      ),
    );
    await pumpUntil(
      tester,
      () => find.text('Weekly review').evaluate().isNotEmpty,
      reason: 'initial meeting title',
    );
    await tester.ensureVisible(find.text('Weekly review'));
    await tester.tap(find.text('Weekly review'));
    await pumpUntil(
      tester,
      () => find.widgetWithText(InputChip, 'Weekly review').evaluate().isNotEmpty,
      reason: 'selected meeting filter',
    );
    restricted = true;
    dependencies.actionItems.invalidation.invalidate(
      sessionScope: dependencies.actionItems.captureSession(),
      meetingId: testMeetingId,
    );
    await pumpUntil(
      tester,
      () => find.text('Weekly review').evaluate().isEmpty,
      reason: 'redacted meeting title',
    );
    await pumpUntil(
      tester,
      () => find.text('Send report').evaluate().isNotEmpty,
      reason: 'restricted item retained',
    );
    expect(find.text('Weekly review'), findsNothing);
    deny = true;
    dependencies.actionItems.invalidation.invalidate(
      sessionScope: dependencies.actionItems.captureSession(),
    );
    await pumpUntil(
      tester,
      () => find.text('Không thể truy cập danh sách').evaluate().isNotEmpty,
      reason: 'authorization failure',
    );
    expect(find.text('Weekly review'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('picker never resurrects revoked pins after a new search', (
    tester,
  ) async {
    final client = MeetingTestHttpClient((request) async {
      return meetingApiFailure(403, 'AUTHZ_FORBIDDEN');
    });
    final repository = (await tester.runAsync(() => repositoryFor(client)))!;
    var denied = false;
    await tester.pumpWidget(
      MaterialApp(
        home: ActionItemPicker<String>(
          api: repository.api,
          scope: repository.captureSession(),
          title: 'Test picker',
          minimumSearchLength: 2,
          readPinned: () => const [
            ActionItemPickerOption(
              value: 'old',
              id: 'old',
              label: 'Protected pin',
            ),
          ],
          load: (search, page) async {
            if (denied) {
              return PagedCollection<String>(
                items: const ['fresh'],
                page: 0,
                size: 20,
                totalElements: 1,
                totalPages: 1,
                hasNext: false,
                hasPrevious: false,
              );
            }
            denied = true;
            throw const ApiFailure(403, 'AUTHZ_FORBIDDEN', 'Denied');
          },
          describe: (value) => ActionItemPickerOption(
            value: value,
            id: value,
            label: value,
          ),
        ),
      ),
    );
    expect(find.text('Protected pin'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'first');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    expect(find.text('Protected pin'), findsNothing);
    await tester.enterText(find.byType(TextField), 'second');
    await tester.pump();
    expect(find.text('Protected pin'), findsNothing);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    expect(find.text('fresh'), findsOneWidget);
    expect(find.text('Protected pin'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('reopened creation recovery displays safe current context', (
    tester,
  ) async {
    var canRead = true;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST') {
        return meetingApiFailure(500, 'INTERNAL_ERROR');
      }
      return meetingApiSuccess([
        {
          'id': testMeetingId,
          'title': canRead ? 'Eligible meeting' : null,
          'canReadMeetingContext': canRead,
        },
      ], meta: _pageMeta(20, 1));
    });
    final repository = (await tester.runAsync(() => repositoryFor(client)))!;
    final creation = ActionItemCreationController(repository: repository);
    addTearDown(creation.dispose);
    await tester.runAsync(() async {
      final scope = repository.captureSession();
      final meetings = await repository.creationMeetings(
        ActionItemCreationMeetingQuery(search: testMeetingId),
        sessionScope: scope,
      );
      await creation.submit(
        input: ActionItemCreateInput(
          meetingId: testMeetingId,
          title: 'Pending task',
          assigneeUserId: testUserId,
        ),
        meeting: meetings.items.single,
        assignee: repository.selfCandidate(scope),
      );
    });
    await tester.pumpWidget(
      MaterialApp(home: ActionItemCreatePage(controller: creation)),
    );
    await pumpUntil(
      tester,
      () => find.text('Cuộc họp: Eligible meeting').evaluate().isNotEmpty,
      reason: 'authorized recovery context',
    );
    expect(find.textContaining('Phụ trách: '), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    canRead = false;
    await tester.pumpWidget(
      MaterialApp(home: ActionItemCreatePage(controller: creation)),
    );
    await pumpUntil(
      tester,
      () => creation.recoveryMeeting?.canReadMeetingContext == false,
      reason: 'revalidated recovery context',
    );
    expect(find.text('Cuộc họp: Eligible meeting'), findsNothing);
    expect(find.textContaining('Cuộc họp giới hạn quyền'), findsOneWidget);
    expect(creation.unresolvedIntent, isNotNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('restricted detail exposes no edit control or hidden title', (
    tester,
  ) async {
    final client = MeetingTestHttpClient((request) async {
      return meetingApiSuccess(
        itemJson(restricted: true, status: 'CANCELLED'),
        headers: {'etag': '"restricted"'},
      );
    });
    final repository = (await tester.runAsync(() => repositoryFor(client)))!;
    tester.view.physicalSize = const Size(360, 640);
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
      reason: 'verified action item detail',
    );
    expect(find.text('Chỉnh sửa'), findsNothing);
    expect(find.byType(TextFormField), findsNothing);
    expect(find.text('Weekly review'), findsNothing);
    expect(find.textContaining('Cuộc họp giới hạn quyền'), findsOneWidget);
    expect(find.textContaining(testMeetingId), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('creation requires explicit meeting and assignee selection', (
    tester,
  ) async {
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST') {
        throw StateError('No creation submission expected.');
      }
      return meetingApiSuccess([
        {
          'id': testMeetingId,
          'title': 'Eligible meeting',
          'canReadMeetingContext': true,
        },
      ], meta: _pageMeta(20, 1));
    });
    final repository = (await tester.runAsync(() => repositoryFor(client)))!;
    final creation = ActionItemCreationController(repository: repository);
    addTearDown(creation.dispose);
    await tester.pumpWidget(
      MaterialApp(home: ActionItemCreatePage(controller: creation)),
    );
    final submit = find.widgetWithText(FilledButton, 'Tạo công việc');
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.tap(find.text('Chọn cuộc họp *'));
    await pumpUntil(
      tester,
      () => find.text('Eligible meeting').evaluate().isNotEmpty,
      reason: 'eligible meeting picker',
    );
    await tester.tap(find.text('Eligible meeting'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).first, 'New action item');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    final assignee = find.text('Chọn người phụ trách *');
    await tester.ensureVisible(assignee);
    await tester.tap(assignee);
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Giao cho tôi'));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
    expect(tester.takeException(), isNull);
    expect(
      client.requests.where(
        (r) => r.url.path.endsWith('/action-items') && r.method == 'POST',
      ),
      isEmpty,
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
    'global collection switches server query to reviewable proposals',
    (tester) async {
      final queries = <Map<String, String>>[];
      final client = MeetingTestHttpClient((request) async {
        if (request.url.path.endsWith('/creation-meetings')) {
          return meetingApiSuccess([], meta: _pageMeta(1, 0));
        }
        queries.add(request.url.queryParameters);
        final reviewing = request.url.queryParameters['reviewable'] == 'true';
        return meetingApiSuccess([
          if (reviewing)
            {
              ...itemJson(
                status: 'PROPOSED',
                source: 'AI_EXTRACTED',
                official: false,
                assigneeId: null,
              ),
              'title': 'Unassigned proposal',
              'overdue': true,
            }
          else
            itemJson(),
        ], meta: _pageMeta(20, 1));
      });
      final api = createMeetingTestApi(client);
      await tester.runAsync(() => signInMeetingTestApi(api));
      final dependencies = AppDependencies(
        api: api,
        appearancePreferences: InMemoryAppearancePreferences(),
        httpClient: client,
      );
      addTearDown(dependencies.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: ActionItemsPage(dependencies: dependencies)),
        ),
      );
      await pumpUntil(
        tester,
        () => find.text('Send report').evaluate().isNotEmpty,
        reason: 'official work collection',
      );
      expect(queries.first['official'], 'true');
      expect(queries.first['assignee'], 'me');
      await tester.tap(find.text('Chờ duyệt'));
      await pumpUntil(
        tester,
        () => find.text('Unassigned proposal').evaluate().isNotEmpty,
        reason: 'reviewable proposal collection',
      );
      expect(queries.last['reviewable'], 'true');
      expect(queries.last.containsKey('assignee'), isFalse);
      expect(find.textContaining('Chưa phân công'), findsOneWidget);
      expect(find.text('Đã qua hạn đề xuất'), findsOneWidget);
      await tester.ensureVisible(find.widgetWithText(FilterChip, 'Quá hạn'));
      await tester.tap(find.widgetWithText(FilterChip, 'Quá hạn'));
      await pumpUntil(
        tester,
        () => queries.last['overdue'] == 'true',
        reason: 'overdue review filter',
      );
      expect(queries.last['reviewable'], 'true');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
