import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_create_sheet.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_creation.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_detail.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_detail_sheet.dart';
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
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
