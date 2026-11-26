import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/features/action_items/action_item_collection.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_invalidation.dart';
import 'package:sme_meeting_assistant/features/dashboard/dashboard_controller.dart';

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
