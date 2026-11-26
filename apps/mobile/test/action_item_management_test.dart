import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_creation.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_detail.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_editing.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_models.dart';

import 'action_item_foundation_test.dart' show itemId, itemJson, repositoryFor;
import 'support/meeting_test_support.dart';

void main() {
  test('draft emits only changed fields, including explicit nulls', () {
    final item = ActionItemResource.fromJson({
      ...itemJson(),
      'details': 'Original details',
    });
    final original = ActionItemDraft.fromResource(item);
    expect(original.patchAgainst(item), isNull);
    final draft = ActionItemDraft(
      title: ' ${item.title} ',
      details: '',
      assigneeUserId: item.assigneeUserId,
      dueDate: null,
    );
    expect(draft.patchAgainst(item)!.toJson(), {
      'details': null,
      'dueDate': null,
    });
  });

  test('three-way reconciliation preserves independent server changes', () async {
    var reads = 0;
    final client = MeetingTestHttpClient((request) async {
      if (reads++ == 0) {
        return meetingApiSuccess(itemJson(), headers: {'etag': '"v1"'});
      }
      return meetingApiSuccess(
        {...itemJson(version: 2), 'title': 'Server title'},
        headers: {'etag': '"v2"'},
      );
    });
    final repository = await repositoryFor(client);
    final scope = repository.captureSession();
    final base = await repository.detail(itemId, sessionScope: scope);
    final latest = await repository.detail(itemId, sessionScope: scope);
    final merge = ActionItemReconciliation(
      original: base,
      local: ActionItemDraft(
        title: base.item.title,
        details: 'My change',
        assigneeUserId: base.item.assigneeUserId,
        dueDate: base.item.dueDate,
      ),
      latest: latest,
    );
    expect(merge.fieldsRequiringChoice, isEmpty);
    final result = merge.resolve({});
    expect(result.title, 'Server title');
    expect(result.patchAgainst(latest.item)!.toJson(), {'details': 'My change'});
  });

  test('version conflict requires explicit review and another submit', () async {
    var reads = 0;
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'PATCH') {
        writes++;
        expect(request.headers['If-Match'], writes == 1 ? '"v1"' : '"v2"');
        expect(decodeRequestBody(request), {'title': 'Local'});
        if (writes == 1) {
          return meetingApiFailure(412, 'RESOURCE_VERSION_CONFLICT');
        }
        return meetingApiSuccess(
          {...itemJson(version: 3), 'title': 'Local'},
          headers: {'etag': '"v3"'},
        );
      }
      reads++;
      return meetingApiSuccess(
        {
          ...itemJson(version: reads == 1 ? 1 : 2),
          'title': reads == 1 ? 'Original' : 'Server',
        },
        headers: {'etag': reads == 1 ? '"v1"' : '"v2"'},
      );
    });
    final repository = await repositoryFor(client);
    final detail = ActionItemDetailController(
      repository: repository,
      admission: ActionItemMutationAdmission(),
      itemId: itemId,
    );
    addTearDown(detail.dispose);
    await detail.refresh();
    detail.beginEdit();
    final original = detail.draft!;
    detail.setDraft(
      ActionItemDraft(
        title: 'Local',
        details: original.details,
        assigneeUserId: original.assigneeUserId,
        dueDate: original.dueDate,
      ),
    );
    expect(await detail.save(), isFalse);
    expect(writes, 1);
    expect(detail.reconciliation!.conflicts, {ActionItemEditField.title});
    expect(await detail.save(), isFalse);
    expect(() => detail.acceptReconciliation({}), throwsStateError);
    detail.acceptReconciliation({
      ActionItemEditField.title: ActionItemMergeChoice.local,
    });
    expect(writes, 1);
    expect(await detail.save(), isTrue);
    expect(writes, 2);
  });

  test('creation replay retains key after an ambiguous response', () async {
    var writes = 0;
    final keys = <String?>[];
    final payloads = <Map<String, dynamic>>[];
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'POST') {
        writes++;
        keys.add(request.headers['Idempotency-Key']);
        payloads.add(decodeRequestBody(request));
        if (writes == 1) return meetingApiFailure(500, 'INTERNAL_ERROR');
        if (writes == 2) return meetingApiFailure(403, 'AUTHZ_FORBIDDEN');
        return meetingApiSuccess(itemJson(), headers: {'etag': '"created"'});
      }
      return meetingApiSuccess(
        [
          {'id': testMeetingId, 'title': null, 'canReadMeetingContext': false},
        ],
        meta: {
          ...meetingTestMeta,
          'pagination': {
            'page': 0,
            'size': 20,
            'totalElements': 1,
            'totalPages': 1,
            'hasNext': false,
            'hasPrevious': false,
          },
        },
      );
    });
    final repository = await repositoryFor(client);
    final scope = repository.captureSession();
    final meetings = await repository.creationMeetings(
      ActionItemCreationMeetingQuery(search: testMeetingId),
      sessionScope: scope,
    );
    final creation = ActionItemCreationController(repository: repository);
    addTearDown(creation.dispose);
    final input = ActionItemCreateInput(
      meetingId: testMeetingId,
      title: 'New item',
      assigneeUserId: testUserId,
    );
    final assignee = repository.selfCandidate(scope);
    final meeting = meetings.items.single;
    expect(
      await creation.submit(input: input, meeting: meeting, assignee: assignee),
      isNull,
    );
    expect(creation.phase, ActionItemCreationPhase.unresolved);
    expect(
      await creation.submit(input: input, meeting: meeting, assignee: assignee),
      isNull,
    );
    expect(writes, 1);
    expect(await creation.retry(), isNull);
    expect(creation.phase, ActionItemCreationPhase.unresolved);
    expect(await creation.retry(), isNotNull);
    expect(keys.toSet().length, 1);
    expect(keys.first, isNotNull);
    expect(payloads[0], payloads[1]);
    expect(payloads[1], payloads[2]);
    expect(creation.unresolvedIntent, isNull);
  });
}
