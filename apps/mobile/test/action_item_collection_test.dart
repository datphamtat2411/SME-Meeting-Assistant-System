import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/features/action_items/action_item_collection.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_models.dart';

import 'action_item_foundation_test.dart' show itemJson, repositoryFor;
import 'support/meeting_test_support.dart';

Map<String, dynamic> _meta(int page, int total) => {
  ...meetingTestMeta,
  'pagination': {
    'page': page,
    'size': 20,
    'totalElements': total,
    'totalPages': (total + 19) ~/ 20,
    'hasNext': (page + 1) * 20 < total,
    'hasPrevious': page > 0,
  },
};

Map<String, dynamic> _item(int index) => {
  ...itemJson(),
  'id': 'eeeeeeee-eeee-4eee-8eee-${index.toString().padLeft(12, '0')}',
  'title': 'Item $index',
};

void main() {
  test('collection modes enforce server-side ownership and review', () {
    final mine = ActionItemCollectionCriteria(
      status: ActionItemStatus.proposed,
      assignee: ActionItemAssigneeFilter.user(testRoomId),
    ).query().toQueryParameters();
    expect(mine['official'], 'true');
    expect(mine['assignee'], 'me');
    expect(mine.containsKey('status'), isFalse);

    final review = const ActionItemCollectionCriteria(
      mode: ActionItemCollectionMode.needsReview,
      status: ActionItemStatus.done,
      overdue: true,
    ).query().toQueryParameters();
    expect(review['reviewable'], 'true');
    expect(review['status'], 'PROPOSED');
    expect(review.containsKey('overdue'), isFalse);
    expect(review.containsKey('official'), isFalse);

    final all = const ActionItemCollectionCriteria(
      mode: ActionItemCollectionMode.allAccessible,
      meetingId: testMeetingId,
    ).query().toQueryParameters();
    expect(all['meetingId'], testMeetingId);
    expect(all.containsKey('assignee'), isFalse);
    expect(all.containsKey('official'), isFalse);
    expect(all.containsKey('reviewable'), isFalse);
  });

  test('append failure preserves pages and retries the same offset', () async {
    var attempts = 0;
    final client = MeetingTestHttpClient((request) async {
      final page = int.parse(request.url.queryParameters['page']!);
      if (page == 0) {
        return meetingApiSuccess(
          List.generate(20, _item),
          meta: _meta(0, 21),
        );
      }
      if (attempts++ == 0) {
        return meetingApiFailure(503, 'INTERNAL_ERROR');
      }
      return meetingApiSuccess([_item(20)], meta: _meta(1, 21));
    });
    final repository = await repositoryFor(client);
    final controller = ActionItemCollectionController(repository: repository);
    addTearDown(controller.dispose);
    await controller.initialize();
    expect(controller.state.items.length, 20);
    await Future.wait([controller.loadMore(), controller.loadMore()]);
    expect(attempts, 1);
    expect(controller.state.failure, ActionItemCollectionFailure.append);
    expect(controller.state.items.length, 20);
    await controller.retry();
    expect(attempts, 2);
    expect(controller.state.items.length, 21);
    expect(controller.state.totalElements, 21);
    expect(controller.state.hasMore, isFalse);
  });

  test('duplicate offset page requires refresh without losing data', () async {
    final client = MeetingTestHttpClient((request) async {
      final page = int.parse(request.url.queryParameters['page']!);
      return page == 0
          ? meetingApiSuccess(
              List.generate(20, _item),
              meta: _meta(0, 21),
            )
          : meetingApiSuccess([_item(0)], meta: _meta(1, 21));
    });
    final repository = await repositoryFor(client);
    final controller = ActionItemCollectionController(repository: repository);
    addTearDown(controller.dispose);
    await controller.initialize();
    await controller.loadMore();
    expect(controller.state.failure, ActionItemCollectionFailure.changed);
    expect(controller.state.items.length, 20);
    expect(controller.state.hasMore, isFalse);
    await controller.retry();
    expect(controller.state.failure, isNull);
    expect(controller.state.hasMore, isTrue);
  });

  test('new search fences old response before debounce expires', () async {
    final started = Completer<void>();
    final old = Completer<http.StreamedResponse>();
    final client = MeetingTestHttpClient((request) async {
      if (request.url.queryParameters['q'] == 'new') {
        return meetingApiSuccess([_item(2)], meta: _meta(0, 1));
      }
      started.complete();
      return old.future;
    });
    final repository = await repositoryFor(client);
    final controller = ActionItemCollectionController(
      repository: repository,
      searchDebounce: const Duration(days: 1),
    );
    addTearDown(controller.dispose);
    final initial = controller.initialize();
    await started.future;
    const criteria = ActionItemCollectionCriteria(search: 'new');
    await controller.applyCriteria(criteria, debounce: true);
    old.complete(await meetingApiSuccess([_item(1)], meta: _meta(0, 1)));
    await initial;
    expect(controller.state.items, isEmpty);
    expect(controller.state.phase, ActionItemCollectionPhase.debounce);
    await controller.applyCriteria(criteria);
    expect(controller.state.items.single.title, 'Item 2');
  });

  test('invalidation during refresh is not lost', () async {
    final started = Completer<void>();
    final first = Completer<http.StreamedResponse>();
    final second = Completer<void>();
    var requests = 0;
    final client = MeetingTestHttpClient((request) async {
      if (++requests == 1) {
        started.complete();
        return first.future;
      }
      return meetingApiSuccess([_item(2)], meta: _meta(0, 1));
    });
    final repository = await repositoryFor(client);
    final controller = ActionItemCollectionController(repository: repository);
    addTearDown(controller.dispose);
    controller.addListener(() {
      if (controller.state.items.singleOrNull?.title == 'Item 2' &&
          !second.isCompleted) {
        second.complete();
      }
    });
    final initial = controller.initialize();
    await started.future;
    repository.invalidation.invalidate(
      sessionScope: repository.captureSession(),
      meetingId: testMeetingId,
    );
    first.complete(await meetingApiSuccess([_item(1)], meta: _meta(0, 1)));
    await initial;
    await second.future;
    expect(requests, 2);
  });

  test('authorization failure clears previously loaded data', () async {
    var calls = 0;
    final client = MeetingTestHttpClient((request) async {
      if (calls++ == 0) {
        return meetingApiSuccess([_item(1)], meta: _meta(0, 1));
      }
      return meetingApiFailure(403, 'AUTHZ_FORBIDDEN');
    });
    final repository = await repositoryFor(client);
    final controller = ActionItemCollectionController(repository: repository);
    addTearDown(controller.dispose);
    await controller.initialize();
    await controller.refresh();
    expect(controller.state.items, isEmpty);
    expect(controller.state.loaded, isFalse);
    expect(controller.state.failure, ActionItemCollectionFailure.access);
  });
}
