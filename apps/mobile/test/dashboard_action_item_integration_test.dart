import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/features/action_items/action_item_collection.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_detail_sheet.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_invalidation.dart';
import 'package:sme_meeting_assistant/features/dashboard/dashboard_controller.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_controller.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/action_items/action_items_page.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_detail_page.dart';
import 'package:sme_meeting_assistant/features/results/results_panel.dart';
import 'package:sme_meeting_assistant/features/profile/preferences_panel.dart';
import 'package:sme_meeting_assistant/features/profile/profile_page.dart';
import 'package:sme_meeting_assistant/main.dart';

import 'action_item_foundation_test.dart' show itemId, itemJson, pageMeta;
import 'support/widget_test_support.dart';

import 'support/meeting_test_support.dart';

Map<String, dynamic> _dashboard(int open) => {
  'assignedActionItems': {
    'open': open,
    'inProgress': 2,
    'done': 3,
    'overdue': 1,
  },
};

void main() {
  testWidgets('Dashboard metric reuses global collection and clears filters', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(650, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final queries = <Map<String, String>>[];
    var meetingReads = 0;
    var profileReads = 0;
    var preferenceReads = 0;
    var restricted = false;
    var denyMeeting = false;
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/dashboard/me')) {
        return meetingApiSuccess(_dashboard(4));
      }
      if (path.endsWith('/creation-meetings')) {
        final size = int.parse(request.url.queryParameters['size']!);
        return meetingApiSuccess(
          [],
          meta: {
            ...pageMeta(total: 0),
            'pagination': {
              ...(pageMeta(total: 0)['pagination'] as Map<String, dynamic>),
              'size': size,
            },
          },
        );
      }
      if (path.endsWith('/action-items/$itemId')) {
        return meetingApiSuccess(
          itemJson(restricted: restricted),
          headers: {'etag': '"detail"'},
        );
      }
      if (path.endsWith('/action-items')) {
        queries.add(request.url.queryParameters);
        return meetingApiSuccess([
          itemJson(restricted: restricted),
        ], meta: pageMeta());
      }
      if (path.endsWith('/meetings/$testMeetingId')) {
        meetingReads++;
        if (denyMeeting) return meetingApiFailure(403, 'AUTHZ_FORBIDDEN');
        return meetingApiSuccess(
          meetingTestJson(),
          headers: {'etag': testMeetingEtag},
        );
      }
      if (path.endsWith('/meetings') ||
          path.endsWith('/assistant/conversations')) {
        return meetingApiSuccess([], meta: pageMeta(total: 0));
      }
      if (path.endsWith('/participants') ||
          path.endsWith('/media') ||
          path.endsWith('/processing-jobs')) {
        return meetingApiSuccess([]);
      }
      if (path.endsWith('/me/profile')) {
        profileReads++;
        return meetingApiSuccess(
          {
            'id': testUserId,
            'email': 'user@example.test',
            'displayName': 'Test User',
            'globalRole': 'ADMINISTRATOR',
            'accountStatus': 'ACTIVE',
            'primaryOrgUnitId': null,
          },
          headers: {'etag': '"profile-v1"'},
        );
      }
      if (path.endsWith('/me/preferences')) {
        preferenceReads++;
        return meetingApiSuccess({
          'timezone': null,
          'locale': null,
          'meetingEmailEnabled': true,
          'actionItemEmailEnabled': true,
        });
      }
      return meetingApiFailure(404, 'NOT_FOUND');
    });
    final api = createMeetingTestApi(client);
    await tester.runAsync(() => signInMeetingTestApi(api));
    final dependencies = AppDependencies(
      api: api,
      appearancePreferences: InMemoryAppearancePreferences(
        initialMode: ThemeMode.light,
      ),
      httpClient: client,
    );
    addTearDown(dependencies.dispose);
    final appearance = AppearanceController(
      preferences: dependencies.appearancePreferences,
    );
    addTearDown(appearance.dispose);
    appearance.initialize();
    await tester.pumpWidget(
      MaterialApp(
        home: AppShell(
          dependencies: dependencies,
          api: api,
          appearance: appearance,
        ),
      ),
    );
    await pumpUntil(
      tester,
      () => find.text('Cần thực hiện').evaluate().isNotEmpty,
      reason: 'personal Dashboard',
    );
    expect(profileReads, 0);
    expect(preferenceReads, 0);
    final collection = find.byType(ActionItemsPage, skipOffstage: false);
    final originalState = tester.state(collection);
    await tester.tap(find.text('Công việc'));
    await pumpUntil(
      tester,
      () => find.text('Send report').evaluate().isNotEmpty,
      reason: 'global collection',
    );
    await tester.tap(find.widgetWithText(ChoiceChip, 'Tất cả'));
    await tester.pumpAndSettle();
    final search = find.byType(TextField);
    await tester.enterText(search, 'previous search');
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilterChip, 'Quá hạn'));
    await pumpUntil(
      tester,
      () =>
          queries.isNotEmpty &&
          queries.last['q'] == 'previous search' &&
          queries.last['overdue'] == 'true',
      reason: 'previous collection filters',
    );
    await tester.ensureVisible(find.text('Weekly review'));
    await tester.tap(find.text('Weekly review'));
    await pumpUntil(
      tester,
      () => queries.last['meetingId'] == testMeetingId,
      reason: 'previous meeting filter',
    );
    await tester.tap(find.text('Tổng quan'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cần thực hiện'));
    await pumpUntil(
      tester,
      () =>
          queries.last['status'] == 'OPEN' &&
          queries.last['official'] == 'true',
      reason: 'Dashboard metric query',
    );
    expect(tester.state(collection), same(originalState));
    expect(queries.last['assignee'], 'me');
    expect(queries.last['q'], isNull);
    expect(queries.last['meetingId'], isNull);
    expect(queries.last['overdue'], isNull);
    expect(tester.widget<TextField>(search).controller!.text, isEmpty);

    await pumpUntil(
      tester,
      () => find.text('Send report').evaluate().isNotEmpty,
      reason: 'filtered Action Item',
    );
    await tester.tap(find.text('Send report'));
    final openMeeting = find.text('Mở cuộc họp');
    await pumpUntil(
      tester,
      () => openMeeting.evaluate().isNotEmpty,
      reason: 'authorized meeting navigation',
    );
    await tester.ensureVisible(openMeeting);
    await tester.tap(openMeeting);
    await pumpUntil(
      tester,
      () => find.byType(ResultsPanel).evaluate().isNotEmpty,
      reason: 'originating meeting authorization and Results navigation',
    );
    final meeting = tester.widget<MeetingDetailPage>(
      find.byType(MeetingDetailPage),
    );
    expect(meeting.meetingId, testMeetingId);
    expect(meeting.initialResultsSection, ResultsSection.actionItems);
    expect(meetingReads, greaterThan(0));
    expect(tester.takeException(), isNull);
    await tester.pageBack();
    await tester.pumpAndSettle();
    final beforeDenied = meetingReads;
    denyMeeting = true;
    await tester.ensureVisible(openMeeting);
    await tester.tap(openMeeting);
    await pumpUntil(
      tester,
      () => meetingReads > beforeDenied,
      reason: 'independent destination authorization',
    );
    await tester.pumpAndSettle();
    expect(find.byType(ResultsPanel), findsNothing);
    expect(find.text('Không thể truy cập cuộc họp'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Quay lại'));
    await tester.pumpAndSettle();
    restricted = true;
    await tester.tap(find.text('Send report'));
    await pumpUntil(
      tester,
      () =>
          find.textContaining('Cuộc họp giới hạn quyền').evaluate().isNotEmpty,
      reason: 'restricted verified detail',
    );
    expect(openMeeting, findsNothing);
    expect(find.byType(MeetingDetailPage), findsNothing);
    expect(tester.takeException(), isNull);
    expect(profileReads, 0);
    expect(preferenceReads, 0);

    // The restricted detail is still a pushed route, even though it has
    // no meeting-navigation action. Its opaque surface owns pointer input.
    final detail = find.byType(ActionItemDetailPage);
    final accountDestination = find.descendant(
      of: find.byType(NavigationBar),
      matching: find.text('Tài khoản'),
    );
    expect(detail, findsOneWidget);
    expect(accountDestination.hitTestable(), findsNothing);

    final closeDetail = find.descendant(
      of: detail,
      matching: find.byTooltip('Quay lại'),
    );
    expect(closeDetail.hitTestable(), findsOneWidget);
    await tester.tap(closeDetail);
    await tester.pumpAndSettle();
    expect(detail, findsNothing);
    expect(accountDestination.hitTestable(), findsOneWidget);
    expect(profileReads, 0);
    expect(preferenceReads, 0);
    expect(
      tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
      2,
    );

    await tester.tap(accountDestination);
    await tester.pump();
    expect(
      tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
      4,
    );
    await pumpUntil(
      tester,
      () =>
          find.text('Test User').evaluate().isNotEmpty &&
          find
              .widgetWithText(SwitchListTile, 'Email cuộc họp')
              .evaluate()
              .isNotEmpty,
      reason: 'first Account destination activation',
    );
    expect(profileReads, 1);
    expect(preferenceReads, 1);
    final workspace = find.byType(ProfilePage);
    final accountState = tester.state(workspace);
    final panel = find.byType(PreferencesPanel);
    final preferenceOwner = tester.widget<PreferencesPanel>(panel).controller;

    tester.view.physicalSize = const Size(1100, 1400);
    await tester.pumpAndSettle();
    expect(tester.state(workspace), same(accountState));
    expect(
      tester.widget<PreferencesPanel>(panel).controller,
      same(preferenceOwner),
    );
    expect(profileReads, 1);
    expect(preferenceReads, 1);

    final rail = find.byType(NavigationRail);
    final dashboardDestination = find.descendant(
      of: rail,
      matching: find.text('Tổng quan'),
    );
    final accountRailDestination = find.descendant(
      of: rail,
      matching: find.text('Tài khoản'),
    );
    expect(tester.widget<NavigationRail>(rail).selectedIndex, 4);
    expect(dashboardDestination.hitTestable(), findsOneWidget);
    await tester.tap(dashboardDestination);
    await tester.pumpAndSettle();
    expect(tester.widget<NavigationRail>(rail).selectedIndex, 0);
    expect(profileReads, 1);
    expect(preferenceReads, 1);
    expect(accountRailDestination.hitTestable(), findsOneWidget);
    await tester.tap(accountRailDestination);
    await tester.pump();
    expect(tester.widget<NavigationRail>(rail).selectedIndex, 4);
    await pumpUntil(
      tester,
      () =>
          profileReads == 2 && preferenceReads == 2 && !preferenceOwner.loading,
      reason: 'Account destination re-entry',
    );
    expect(tester.state(workspace), same(accountState));
    expect(tester.state(collection), same(originalState));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('Dashboard destinations preserve official My Work semantics', () {
    for (final destination in MyWorkDestination.values) {
      final query = ActionItemNavigationIntent(destination).criteria
          .query()
          .toQueryParameters();
      expect(query['assignee'], 'me');
      expect(query['official'], 'true');
      expect(query['status'], switch (destination) {
        MyWorkDestination.open => 'OPEN',
        MyWorkDestination.inProgress => 'IN_PROGRESS',
        MyWorkDestination.done => 'DONE',
        _ => null,
      });
      expect(
        query['overdue'],
        destination == MyWorkDestination.overdue ? 'true' : null,
      );
    }
  });

  test('Dashboard defers hidden and retains later invalidations', () async {
    final started = Completer<void>();
    final pending = Completer<http.StreamedResponse>();
    final updated = Completer<void>();
    var reads = 0;
    final client = MeetingTestHttpClient((request) async {
      expect(request.url.path, endsWith('/dashboard/me'));
      reads++;
      if (reads == 2) {
        started.complete();
        return pending.future;
      }
      return meetingApiSuccess(_dashboard(reads));
    });
    final api = createMeetingTestApi(client);
    await signInMeetingTestApi(api);
    final signal = ActionItemInvalidationSignal(api);
    final controller = DashboardController(api: api, invalidation: signal);
    addTearDown(() {
      controller.dispose();
      signal.dispose();
      api.dispose();
    });
    await controller.refresh();
    controller.setActive(false);
    signal.invalidate(sessionScope: api.requireAuthenticatedSessionScope());
    expect(reads, 1);
    controller.addListener(() {
      if (controller.data?['assignedActionItems']['open'] == 3 &&
          !updated.isCompleted) {
        updated.complete();
      }
    });
    controller.setActive(true);
    await started.future;
    signal.invalidate(sessionScope: api.requireAuthenticatedSessionScope());
    pending.complete(await meetingApiSuccess(_dashboard(2)));
    await updated.future;
    expect(reads, 3);
  });

  test('Dashboard fences an obsolete session response', () async {
    final started = Completer<void>();
    final pending = Completer<http.StreamedResponse>();
    final client = MeetingTestHttpClient((request) async {
      started.complete();
      return pending.future;
    });
    final api = createMeetingTestApi(client);
    await signInMeetingTestApi(api);
    final signal = ActionItemInvalidationSignal(api);
    final controller = DashboardController(api: api, invalidation: signal);
    addTearDown(() {
      controller.dispose();
      signal.dispose();
      api.dispose();
    });
    final operation = controller.refresh();
    await started.future;
    await api.signOut();
    await api.signIn('user@example.test', 'password');
    pending.complete(await meetingApiSuccess(_dashboard(1)));
    await operation;
    expect(controller.current, isFalse);
    expect(controller.data, isNull);
  });
}
