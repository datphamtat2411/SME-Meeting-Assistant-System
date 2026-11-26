import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_invalidation.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_models.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_repository.dart';
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';

import 'support/meeting_test_support.dart';

const itemId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

Map<String, dynamic> itemJson({
  bool restricted = false,
  String status = 'OPEN',
  bool official = true,
  String source = 'MANUAL',
  String? assigneeId = testUserId,
  int version = 1,
}) {
  final commands = switch (status) {
    'PROPOSED' => assigneeId == null ? ['REJECT'] : ['CONFIRM', 'REJECT'],
    'OPEN' => ['START', 'COMPLETE', if (!restricted) 'CANCEL'],
    'IN_PROGRESS' => ['COMPLETE', if (!restricted) 'CANCEL'],
    'DONE' => ['REOPEN'],
    _ => <String>[],
  };
  final editable = !restricted && status != 'DONE' && status != 'CANCELLED';
  return {
    'id': itemId,
    'meetingId': testMeetingId,
    'title': 'Send report',
    'details': null,
    'status': status,
    'sourceType': source,
    'official': official,
    'assigneeUserId': assigneeId,
    'dueDate': '2026-12-01',
    'overdue': false,
    'version': version,
    'createdAt': '2026-11-24T12:00:00Z',
    'updatedAt': '2026-11-24T12:00:00Z',
    'createdByUserId': restricted ? null : testUserId,
    'assignee': assigneeId == null
        ? null
        : {
            'id': assigneeId,
            'displayName': 'Test User',
            'accountStatus': 'ACTIVE',
          },
    'meetingContext': {
      'id': testMeetingId,
      'title': restricted ? null : 'Weekly review',
    },
    'capabilities': {
      'canEdit': editable,
      'canAssign': editable,
      'canReadMeetingContext': !restricted,
      'allowedCommands': commands,
    },
  };
}

Map<String, dynamic> pageMeta({int total = 1}) => {
  ...meetingTestMeta,
  'pagination': {
    'page': 0,
    'size': 20,
    'totalElements': total,
    'totalPages': total == 0 ? 0 : 1,
    'hasNext': false,
    'hasPrevious': false,
  },
};

Future<ActionItemRepository> repositoryFor(MeetingTestHttpClient client) async {
  final api = createMeetingTestApi(client);
  addTearDown(api.dispose);
  await signInMeetingTestApi(api);
  final signal = ActionItemInvalidationSignal(api);
  addTearDown(signal.dispose);
  return ActionItemRepository(
    api: api,
    invalidation: signal,
    participantCandidates: ParticipantCandidateRepository(api),
  );
}

void main() {
  test(
    'decodes official and restricted projections without inventing data',
    () {
      final item = ActionItemResource.fromJson(
        itemJson(restricted: true, source: 'AI_EXTRACTED'),
      );
      expect(item.official, isTrue);
      expect(item.source, ActionItemSource.aiExtracted);
      expect(item.confirmedByUserId, isNull);
      expect(item.meetingContext.title, isNull);
      expect(item.capabilities.canEdit, isFalse);
      expect(item.dueDate, '2026-12-01');
      expect(item.capabilities.allows(ActionItemCommand.complete), isTrue);

      final proposal = ActionItemResource.fromJson(
        itemJson(
          status: 'PROPOSED',
          official: false,
          source: 'AI_EXTRACTED',
          assigneeId: null,
        ),
      );
      expect(proposal.assignee, isNull);
      expect(proposal.official, isFalse);
      expect(proposal.capabilities.allows(ActionItemCommand.confirm), isFalse);

      for (final malformed in <Map<String, dynamic>>[
        {...itemJson(), 'status': 'OVERDUE'},
        {...itemJson(), 'capabilities': null},
        {...itemJson(), 'dueDate': '2026-02-30'},
        {...itemJson(), 'official': false},
      ]) {
        expect(
          () => ActionItemResource.fromJson(malformed),
          throwsA(isA<ApiFailure>()),
        );
      }
    },
  );

  test('query and patch preserve filter and explicit null semantics', () {
    final query = ActionItemQuery(
      assignee: const ActionItemAssigneeFilter.me(),
      official: true,
      reviewable: false,
      overdue: false,
      page: 2,
    );
    expect(query.toQueryParameters(), {
      'assignee': 'me',
      'official': 'true',
      'reviewable': 'false',
      'overdue': 'false',
      'page': '2',
      'size': '20',
      'sort': 'createdAt,desc',
    });
    final patch = ActionItemPatch(
      details: const ActionItemFieldUpdate<String?>.set(null),
      dueDate: const ActionItemFieldUpdate<String?>.set(null),
    );
    expect(patch.toJson(), {'details': null, 'dueDate': null});
    expect(() => ActionItemPatch(), throwsArgumentError);
    expect(
      () =>
          ActionItemPatch(title: const ActionItemFieldUpdate<String>.set(' ')),
      throwsArgumentError,
    );
  });

  test(
    'reads collection, eligible meetings and assignment directory',
    () async {
      final client = MeetingTestHttpClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/creation-meetings')) {
          expect(request.url.queryParameters['q'], testMeetingId);
          return meetingApiSuccess([
            {
              'id': testMeetingId,
              'title': null,
              'canReadMeetingContext': false,
            },
          ], meta: pageMeta());
        }
        if (path.endsWith('/meeting-candidates')) {
          expect(request.url.queryParameters['q'], 'Al');
          return meetingApiSuccess([
            {
              'id': testRoomId,
              'displayName': 'Alice',
              'email': 'alice@example.test',
              'organizationalUnitName': null,
            },
          ], meta: pageMeta());
        }
        expect(request.url.queryParameters['official'], 'true');
        expect(request.url.queryParameters['assignee'], 'me');
        return meetingApiSuccess([
          itemJson(restricted: true),
        ], meta: pageMeta());
      });
      final repository = await repositoryFor(client);
      final scope = repository.captureSession();
      final list = await repository.list(
        ActionItemQuery(
          official: true,
          assignee: const ActionItemAssigneeFilter.me(),
        ),
        sessionScope: scope,
      );
      expect(list.items.single.id, itemId);
      final meetings = await repository.creationMeetings(
        ActionItemCreationMeetingQuery(search: testMeetingId),
        sessionScope: scope,
      );
      expect(meetings.items.single.title, isNull);
      final candidates = await repository.assignmentCandidates(
        MeetingCandidateQuery(search: 'Al'),
        sessionScope: scope,
      );
      expect(candidates.items.single.displayName, 'Alice');
      expect(repository.selfCandidate(scope).id, testUserId);
    },
  );

  test(
    'preserves original ETag and stable create intent across failures',
    () async {
      var creates = 0;
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            itemJson(),
            headers: const {'etag': '"original"'},
          );
        }
        if (request.method == 'PATCH') {
          expect(request.headers['If-Match'], '"original"');
          expect(decodeRequestBody(request), {'dueDate': null});
          return meetingApiFailure(412, 'RESOURCE_VERSION_CONFLICT');
        }
        creates++;
        expect(request.headers['Idempotency-Key'], 'stable-action-create');
        expect(decodeRequestBody(request)['assigneeUserId'], testUserId);
        if (creates == 1) {
          // The mutation may have committed despite an invalid response.
          return meetingApiSuccess(itemJson(), status: 201);
        }
        return meetingApiSuccess(
          itemJson(version: 2),
          status: 201,
          headers: const {'etag': '"created"'},
        );
      });
      final repository = await repositoryFor(client);
      final signal = repository.invalidation;
      final scope = repository.captureSession();
      final snapshot = await repository.detail(itemId, sessionScope: scope);
      await expectLater(
        repository.update(
          snapshot,
          ActionItemPatch(
            dueDate: const ActionItemFieldUpdate<String?>.set(null),
          ),
        ),
        throwsA(
          isA<ActionItemFailure>()
              .having(
                (e) => e.category,
                'category',
                ActionItemFailureCategory.versionConflict,
              )
              .having(
                (e) => e.outcome,
                'outcome',
                ActionItemMutationOutcome.rejected,
              ),
        ),
      );
      expect(signal.revision, 0);
      final intent = ActionItemCreateIntent(
        sessionScope: scope,
        idempotencyKey: 'stable-action-create',
        input: ActionItemCreateInput(
          meetingId: testMeetingId,
          title: 'Send report',
          assigneeUserId: testUserId,
        ),
      );
      await expectLater(
        repository.create(intent),
        throwsA(
          isA<ActionItemFailure>().having(
            (e) => e.outcome,
            'outcome',
            ActionItemMutationOutcome.unknown,
          ),
        ),
      );
      expect(signal.revision, 1);
      expect(signal.lastMeetingId, testMeetingId);
      expect(signal.lastActionItemId, isNull);
      final created = await repository.create(intent);
      expect(created.etag, '"created"');
      expect(signal.revision, 2);
      expect(signal.lastActionItemId, itemId);
      expect(creates, 2);
      expect(
        client.requests.where((r) => r.url.path.endsWith('/$itemId')).length,
        2,
      );
    },
  );

  test('all commands use the preceding verified snapshot', () async {
    final commands = [
      ActionItemCommand.confirm,
      ActionItemCommand.start,
      ActionItemCommand.complete,
      ActionItemCommand.reopen,
      ActionItemCommand.cancel,
      ActionItemCommand.reject,
    ];
    final targets = [
      'OPEN',
      'IN_PROGRESS',
      'DONE',
      'OPEN',
      'CANCELLED',
      'CANCELLED',
    ];
    var index = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'GET') {
        return meetingApiSuccess(
          itemJson(status: 'PROPOSED', source: 'AI_EXTRACTED', official: false),
          headers: {'etag': '"v$index"'},
        );
      }
      expect(request.url.path.split('/').last, commands[index].name);
      expect(request.headers['If-Match'], '"v$index"');
      final target = targets[index++];
      return meetingApiSuccess(
        itemJson(
          status: target,
          source: 'AI_EXTRACTED',
          official: index != 6,
          version: index,
        ),
        headers: {'etag': '"v$index"'},
      );
    });
    final repository = await repositoryFor(client);
    final scope = repository.captureSession();
    var snapshot = await repository.detail(itemId, sessionScope: scope);
    for (final command in commands) {
      if (command == ActionItemCommand.reject) {
        snapshot = await repository.detail(itemId, sessionScope: scope);
      }
      snapshot = await repository.command(snapshot, command);
    }
    expect(index, 6);
    expect(snapshot.item.status, ActionItemStatus.cancelled);
    expect(snapshot.item.official, isFalse);
    expect(repository.invalidation.revision, 6);
  });

  test('rejects missing or unusable detail ETags', () async {
    for (final etag in <String?>[null, 'W/"weak"', 'unquoted']) {
      final client = MeetingTestHttpClient((request) async {
        return meetingApiSuccess(
          itemJson(),
          headers: {if (etag != null) 'etag': etag},
        );
      });
      final repository = await repositoryFor(client);
      await expectLater(
        repository.detail(itemId, sessionScope: repository.captureSession()),
        throwsA(
          isA<ActionItemFailure>().having(
            (e) => e.category,
            'category',
            ActionItemFailureCategory.missingPrecondition,
          ),
        ),
      );
      expect(repository.invalidation.revision, 0);
    }
  });

  test('rejects semantically invalid mutation responses', () async {
    for (final invalid in [
      {...itemJson(status: 'DONE'), 'id': testRoomId},
      {...itemJson(status: 'DONE'), 'meetingId': testRoomId},
      itemJson(status: 'OPEN'),
      {...itemJson(status: 'DONE'), 'capabilities': null},
    ]) {
      final client = MeetingTestHttpClient((request) async {
        return meetingApiSuccess(
          request.method == 'GET' ? itemJson() : invalid,
          headers: const {'etag': '"v1"'},
        );
      });
      final repository = await repositoryFor(client);
      final snapshot = await repository.detail(
        itemId,
        sessionScope: repository.captureSession(),
      );
      await expectLater(
        repository.command(snapshot, ActionItemCommand.complete),
        throwsA(
          isA<ActionItemFailure>()
              .having(
                (e) => e.category,
                'category',
                ActionItemFailureCategory.invalidResponse,
              )
              .having(
                (e) => e.outcome,
                'outcome',
                ActionItemMutationOutcome.unknown,
              ),
        ),
      );
      expect(repository.invalidation.revision, 1);
      expect(repository.invalidation.lastActionItemId, itemId);
    }
  });

  test('transport and server failures require mutation revalidation', () async {
    for (final category in [
      ActionItemFailureCategory.timeout,
      ActionItemFailureCategory.transport,
      ActionItemFailureCategory.server,
    ]) {
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            itemJson(),
            headers: const {'etag': '"v1"'},
          );
        }
        if (category == ActionItemFailureCategory.timeout) {
          throw TimeoutException('Lost response');
        }
        if (category == ActionItemFailureCategory.transport) {
          throw http.ClientException('Connection lost');
        }
        return meetingApiFailure(500, 'INTERNAL_ERROR');
      });
      final repository = await repositoryFor(client);
      final snapshot = await repository.detail(
        itemId,
        sessionScope: repository.captureSession(),
      );
      await expectLater(
        repository.command(snapshot, ActionItemCommand.complete),
        throwsA(
          isA<ActionItemFailure>()
              .having((e) => e.category, 'category', category)
              .having(
                (e) => e.outcome,
                'outcome',
                ActionItemMutationOutcome.unknown,
              ),
        ),
      );
      expect(repository.invalidation.revision, 1);
      expect(repository.invalidation.lastActionItemId, itemId);
      expect(
        client.requests
            .where(
              (r) => r.method == 'POST' && r.url.path.endsWith('/complete'),
            )
            .length,
        1,
      );
    }
  });

  test('obsolete create intent cannot dispatch under a new session', () async {
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      writes++;
      return meetingApiSuccess(
        itemJson(),
        status: 201,
        headers: const {'etag': '"created"'},
      );
    });
    final repository = await repositoryFor(client);
    final intent = ActionItemCreateIntent(
      sessionScope: repository.captureSession(),
      idempotencyKey: 'obsolete-create',
      input: ActionItemCreateInput(
        meetingId: testMeetingId,
        title: 'Send report',
        assigneeUserId: testUserId,
      ),
    );
    await repository.api.signOut();
    await repository.api.signIn('user@example.test', 'password');
    await expectLater(
      repository.create(intent),
      throwsA(
        isA<ActionItemFailure>().having(
          (e) => e.outcome,
          'outcome',
          ActionItemMutationOutcome.notDispatched,
        ),
      ),
    );
    expect(writes, 0);
    expect(repository.invalidation.revision, 0);
  });

  test('session changes fence late responses and obsolete snapshots', () async {
    final entered = Completer<void>();
    final held = Completer<http.StreamedResponse>();
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.method == 'PATCH') {
        writes++;
        entered.complete();
        return held.future;
      }
      return meetingApiSuccess(
        itemJson(),
        headers: const {'etag': '"original"'},
      );
    });
    final repository = await repositoryFor(client);
    final snapshot = await repository.detail(
      itemId,
      sessionScope: repository.captureSession(),
    );
    final patch = ActionItemPatch(
      title: const ActionItemFieldUpdate<String>.set('New'),
    );
    final pending = repository.update(snapshot, patch);
    final expectation = expectLater(pending, throwsA(isA<ActionItemFailure>()));
    await entered.future;
    await repository.api.signOut();
    await repository.api.signIn('user@example.test', 'password');
    held.complete(
      await meetingApiSuccess(
        itemJson(version: 2),
        headers: const {'etag': '"new"'},
      ),
    );
    await expectation;
    expect(repository.invalidation.revision, 0);
    await expectLater(
      repository.update(snapshot, patch),
      throwsA(
        isA<ActionItemFailure>().having(
          (e) => e.outcome,
          'outcome',
          ActionItemMutationOutcome.notDispatched,
        ),
      ),
    );
    expect(writes, 1);
  });
}
