import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_message_view.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_repository.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_workspace_controller.dart';

import 'support/meeting_test_support.dart';

const _conversationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const _userMessageId = '11111111-1111-4111-8111-111111111111';
const _assistantMessageId = '22222222-2222-4222-8222-222222222222';
const _turnId = '33333333-3333-4333-8333-333333333333';
const _sourceId = '44444444-4444-4444-8444-444444444444';
const _timestamp = '2026-11-24T12:00:00Z';

Map<String, dynamic> _conversation({String meetingId = testMeetingId}) => {
  'id': _conversationId,
  'meetingId': meetingId,
  'title': null,
  'status': 'ACTIVE',
  'createdAt': _timestamp,
  'updatedAt': _timestamp,
  'futureOptionalField': true,
};

Map<String, dynamic> _claim() => {
  'claimId': 'A1',
  'text': 'Đã thống nhất.',
  'support': 'SUPPORTED',
  'citationIds': ['C1'],
};

Map<String, dynamic> _citation() => {
  'citationId': 'C1',
  'sourceType': 'TRANSCRIPT',
  'sourceId': _sourceId,
  'meetingId': testMeetingId,
  'sourceRevision': 0,
  'retrievalChunkId': 'opaque-chunk',
  'claimIds': ['A1'],
};

Map<String, dynamic> _message({
  String status = 'GROUNDED',
  String visibility = 'VISIBLE',
}) => {
  'id': _assistantMessageId,
  'role': 'ASSISTANT',
  'content': visibility == 'VISIBLE' ? 'Đã thống nhất.' : null,
  'answerStatus': status,
  'visibility': visibility,
  'claims': visibility == 'VISIBLE' && status == 'GROUNDED' ? [_claim()] : [],
  'citations': visibility == 'VISIBLE' && status == 'GROUNDED'
      ? [_citation()]
      : [],
  'createdAt': _timestamp,
};

Map<String, dynamic> _userMessage() => {
  'id': _userMessageId,
  'role': 'USER',
  'content': 'Câu hỏi',
  'answerStatus': null,
  'visibility': 'VISIBLE',
  'claims': [],
  'citations': [],
  'createdAt': _timestamp,
};

Map<String, dynamic> _turn({bool processing = false}) => {
  'turnId': _turnId,
  'state': processing ? 'PROCESSING' : 'COMPLETED',
  'userMessageId': _userMessageId,
  'assistantMessageId': processing ? null : _assistantMessageId,
  'answerStatus': processing ? null : 'GROUNDED',
  'answer': processing ? null : 'Đã thống nhất.',
  'claims': processing ? [] : [_claim()],
  'citations': processing ? [] : [_citation()],
};

Map<String, dynamic> _detail({
  int page = 0,
  int size = 50,
  bool hasMore = false,
  List<Map<String, dynamic>>? messages,
}) => {
  'conversation': _conversation(),
  'messages': messages ?? [_message()],
  'page': page,
  'size': size,
  'hasMore': hasMore,
};

ApiResult _result(dynamic data, {int status = 200}) =>
    ApiResult(data, meetingTestMeta, null, statusCode: status);

AssistantConversation _typedConversation() => AssistantConversation.fromJson(
  _conversation(),
  response: _result(_conversation()),
);

AssistantQuestionRequest _question({
  String question = '  Câu hỏi  ',
  String key = 'intent-01:retry',
}) => AssistantQuestionRequest(
  conversation: _typedConversation(),
  question: question,
  idempotencyKey: key,
);

Matcher _invalidResponse() =>
    isA<ApiFailure>().having((e) => e.invalidResponse, 'invalidResponse', true);

class _RecordingApiClient extends ApiClient {
  _RecordingApiClient(MeetingTestHttpClient client)
    : super(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: InMemoryCredentialStorage(),
      );

  CoreApiTimeoutPolicy? lastPolicy;

  @override
  Future<ApiResult> post(
    String path,
    Map<String, dynamic> body, {
    Map<String, String>? headers,
    CoreApiTimeoutPolicy? timeoutPolicy,
    AuthenticatedSessionScope? sessionScope,
  }) {
    lastPolicy = timeoutPolicy;
    return super.post(
      path,
      body,
      headers: headers,
      timeoutPolicy: timeoutPolicy,
      sessionScope: sessionScope,
    );
  }
}

Future<AssistantRepository> _repository(MeetingTestHttpClient client) async {
  final api = _RecordingApiClient(client);
  addTearDown(api.dispose);
  await signInMeetingTestApi(api);
  return AssistantRepository(api: api);
}

void main() {
  group('Assistant model contract', () {
    test('decodes canonical evidence and tolerates additive fields', () {
      final detail = AssistantConversationDetail.fromResult(
        _result(_detail()),
        conversationId: _conversationId,
        requestedPage: 0,
        requestedSize: 50,
      );
      expect(detail.conversation.title, isNull);
      expect(detail.conversation.meetingId, testMeetingId);
      final message = detail.messages.single;
      expect(message.answerStatus, AssistantAnswerStatus.grounded);
      expect(message.claims.single.citationIds, ['C1']);
      expect(message.citations.single.claimIds, ['A1']);
      expect(message.citations.single.sourceRevision, 0);
      expect(message.citations.single.retrievalChunkId, 'opaque-chunk');
      expect(() => message.citations.clear(), throwsUnsupportedError);
    });

    test('preserves source-unavailable, failed and insufficient states', () {
      final hidden = _message(visibility: 'SOURCE_UNAVAILABLE');
      final failed = _message(status: 'FAILED');
      final insufficient = _message(status: 'INSUFFICIENT_EVIDENCE');
      for (final raw in [hidden, failed, insufficient]) {
        final message = AssistantMessage.fromJson(
          raw,
          response: _result(raw),
          meetingId: testMeetingId,
        );
        expect(message.claims, isEmpty);
        expect(message.citations, isEmpty);
      }
      final message = AssistantMessage.fromJson(
        hidden,
        response: _result(hidden),
        meetingId: testMeetingId,
      );
      expect(message.content, isNull);
      expect(message.visibility, AssistantMessageVisibility.sourceUnavailable);
      expect(message.answerStatus, AssistantAnswerStatus.grounded);
      hidden['content'] = 'Must not escape';
      expect(
        () => AssistantMessage.fromJson(
          hidden,
          response: _result(hidden),
          meetingId: testMeetingId,
        ),
        throwsA(_invalidResponse()),
      );
    });

    test('supports partial, conflicted and non-assistant messages', () {
      final partial = _message()
        ..['answerStatus'] = 'PARTIAL'
        ..['claims'] = [
          _claim(),
          {
            'claimId': 'A2',
            'text': 'Chưa xác định.',
            'support': 'UNSUPPORTED',
            'citationIds': [],
          },
        ];
      final conflicted = _message()
        ..['answerStatus'] = 'PARTIAL'
        ..['claims'] = [
          _claim()
            ..['support'] = 'CONFLICTED'
            ..['citationIds'] = ['C1', 'C2'],
        ]
        ..['citations'] = [_citation(), _citation()..['citationId'] = 'C2'];
      for (final raw in [partial, conflicted]) {
        final message = AssistantMessage.fromJson(
          raw,
          response: _result(raw),
          meetingId: testMeetingId,
        );
        expect(message.answerStatus, AssistantAnswerStatus.partial);
      }
      for (final role in ['USER', 'SYSTEM_EVENT']) {
        final raw = _message()
          ..['role'] = role
          ..['answerStatus'] = null
          ..['claims'] = []
          ..['citations'] = [];
        final message = AssistantMessage.fromJson(
          raw,
          response: _result(raw),
          meetingId: testMeetingId,
        );
        expect(message.answerStatus, isNull);
      }
    });

    test('rejects invalid identity, status, evidence and page metadata', () {
      for (final raw in [
        _message()..['id'] = 'not-a-uuid',
        _message()..['visibility'] = 'UNKNOWN',
        _message()..['answerStatus'] = 'UNKNOWN',
        _message()..['createdAt'] = '2026-02-30T12:00:00Z',
        _message()..['citations'] = [_citation()..['meetingId'] = testRoomId],
        _message()..['citations'] = [_citation()..['sourceRevision'] = -1],
        _message()
          ..['claims'] = [
            _claim()..['citationIds'] = ['missing'],
          ],
        _message()
          ..['citations'] = [
            _citation()..['claimIds'] = ['missing'],
          ],
        _message()..['citations'] = [_citation(), _citation()],
      ]) {
        expect(
          () => AssistantMessage.fromJson(
            raw,
            response: _result(raw),
            meetingId: testMeetingId,
          ),
          throwsA(_invalidResponse()),
        );
      }
      expect(
        () => AssistantConversationDetail.fromResult(
          _result(_detail(page: 1)),
          conversationId: _conversationId,
          requestedPage: 0,
          requestedSize: 50,
        ),
        throwsA(_invalidResponse()),
      );
      expect(
        () => AssistantConversationDetail.fromResult(
          _result(_detail(hasMore: true)),
          conversationId: _conversationId,
          requestedPage: 0,
          requestedSize: 50,
        ),
        throwsA(_invalidResponse()),
      );
    });

    test('requires HTTP and durable turn state to agree', () {
      final processing = AssistantTurn.fromResult(
        _result(_turn(processing: true), status: 202),
        meetingId: testMeetingId,
      );
      expect(processing.state, AssistantTurnState.processing);
      expect(processing.assistantMessageId, isNull);
      final completed = AssistantTurn.fromResult(
        _result(_turn()),
        meetingId: testMeetingId,
      );
      expect(completed.state, AssistantTurnState.completed);
      expect(completed.assistantMessageId, _assistantMessageId);
      expect(
        () => AssistantTurn.fromResult(
          _result(_turn(processing: true)),
          meetingId: testMeetingId,
        ),
        throwsA(_invalidResponse()),
      );
      expect(
        () => AssistantTurn.fromResult(
          _result(_turn(), status: 202),
          meetingId: testMeetingId,
        ),
        throwsA(_invalidResponse()),
      );
    });
  });

  group('Assistant repository', () {
    test('uses all operations and preserves caller-owned keys', () async {
      var submissions = 0;
      final client = MeetingTestHttpClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/messages')) {
          expect(request.method, 'POST');
          expect(
            path,
            '/api/v1/assistant/conversations/$_conversationId/messages',
          );
          expect(decodeRequestBody(request), {'question': 'Câu hỏi'});
          expect(
            request.headers.entries
                .singleWhere(
                  (entry) => entry.key.toLowerCase() == 'idempotency-key',
                )
                .value,
            'intent-01:retry',
          );
          submissions++;
          return meetingApiSuccess(
            _turn(processing: submissions == 1),
            status: submissions == 1 ? 202 : 200,
          );
        }
        if (path.endsWith('/$_conversationId')) {
          expect(request.method, 'GET');
          expect(request.url.queryParameters, {'page': '1', 'size': '1'});
          return meetingApiSuccess(_detail(page: 1, size: 1, hasMore: true));
        }
        expect(path, '/api/v1/assistant/conversations');
        if (request.method == 'POST') {
          expect(decodeRequestBody(request), {'meetingId': testMeetingId});
          return meetingApiSuccess(_conversation(), status: 201);
        }
        expect(request.method, 'GET');
        expect(request.url.queryParameters, {'page': '0', 'size': '1'});
        return meetingApiSuccess([_conversation()]);
      });
      final repository = await _repository(client);
      final scope = repository.captureSession();
      final page = await repository.listConversations(
        sessionScope: scope,
        size: 1,
      );
      expect(page.mayHaveMore, isTrue);
      expect(page.items.single.id, _conversationId);
      final created = await repository.createConversation(
        const AssistantCreateConversationRequest(
          meetingId: testMeetingId,
          title: '   ',
        ),
        sessionScope: scope,
      );
      expect(created.meetingId, testMeetingId);
      final api = repository.api as _RecordingApiClient;
      expect(api.lastPolicy, isNull);
      final detail = await repository.getConversation(
        created.id,
        sessionScope: scope,
        expectedMeetingId: created.meetingId,
        page: 1,
        size: 1,
      );
      expect(detail.hasMore, isTrue);
      final command = _question();
      final processing = await repository.submitQuestion(
        command,
        sessionScope: scope,
      );
      expect(processing.state, AssistantTurnState.processing);
      expect(api.lastPolicy?.dispatchTimeout, const Duration(seconds: 60));
      expect(api.lastPolicy?.overallTimeout, const Duration(seconds: 60));
      expect(api.lastPolicy?.responseTimeout, isNull);
      final completed = await repository.submitQuestion(
        command,
        sessionScope: scope,
      );
      expect(completed.state, AssistantTurnState.completed);
      expect(completed.turnId, processing.turnId);
      expect(submissions, 2);
    });

    test(
      'uses creation keys, anchored history and read-only turn status',
      () async {
        final repository = await _repository(
          MeetingTestHttpClient((request) async {
            final path = request.url.path;
            if (path.endsWith('/turns/by-key')) {
              expect(request.method, 'GET');
              expect(request.headers['idempotency-key'], 'intent-01:retry');
              expect(request.url.queryParameters, isEmpty);
              return meetingApiSuccess({
                'turn': _turn(processing: true),
                'recoveryEligible': true,
              });
            }
            if (request.method == 'POST') {
              expect(request.headers['idempotency-key'], 'create-01');
              return meetingApiSuccess(_conversation(), status: 201);
            }
            expect(request.url.queryParameters, {
              'page': '0',
              'size': '50',
              'beforeMessageId': _userMessageId,
            });
            return meetingApiSuccess(_detail());
          }),
        );
        final scope = repository.captureSession();
        await repository.createConversation(
          const AssistantCreateConversationRequest(
            meetingId: testMeetingId,
            idempotencyKey: 'create-01',
          ),
          sessionScope: scope,
        );
        final older = await repository.getConversation(
          _conversationId,
          sessionScope: scope,
          beforeMessageId: _userMessageId,
        );
        expect(older.messages.single.id, _assistantMessageId);
        final result = await repository.getTurnStatus(
          _question(),
          sessionScope: scope,
        );
        expect(result.turn.state, AssistantTurnState.processing);
        expect(result.recoveryEligible, isTrue);
      },
    );

    test(
      'status lookup preserves terminal failures without exposing evidence',
      () {
        for (final state in ['FAILED', 'STALE_SOURCE']) {
          final raw = {
            'turn': _turn()
              ..['state'] = state
              ..['answerStatus'] = state == 'FAILED' ? 'FAILED' : 'GROUNDED'
              ..['answer'] = null
              ..['claims'] = []
              ..['citations'] = [],
            'recoveryEligible': false,
          };
          final result = AssistantTurnStatus.fromResult(
            _result(raw),
            meetingId: testMeetingId,
          );
          expect(
            result.turn.state,
            state == 'FAILED'
                ? AssistantTurnState.failed
                : AssistantTurnState.staleSource,
          );
          expect(result.turn.answer, isNull);
          expect(result.turn.citations, isEmpty);
          raw['recoveryEligible'] = true;
          expect(
            () => AssistantTurnStatus.fromResult(
              _result(raw),
              meetingId: testMeetingId,
            ),
            throwsA(_invalidResponse()),
          );
        }
      },
    );

    test('rejects invalid input without dispatch', () async {
      var requests = 0;
      final repository = await _repository(
        MeetingTestHttpClient((_) async {
          requests++;
          return meetingApiSuccess(null);
        }),
      );
      final scope = repository.captureSession();
      final matcher = isA<AssistantFailure>().having(
        (e) => e.outcome,
        'outcome',
        AssistantMutationOutcome.notDispatched,
      );
      await expectLater(
        repository.createConversation(
          const AssistantCreateConversationRequest(meetingId: 'invalid'),
          sessionScope: scope,
        ),
        throwsA(matcher),
      );
      await expectLater(
        repository.listConversations(sessionScope: scope, size: 51),
        throwsA(matcher),
      );
      for (final command in [
        _question(question: '  '),
        _question(question: List.filled(2049, '😀').join()),
        _question(key: 'bad key'),
      ]) {
        await expectLater(
          repository.submitQuestion(command, sessionScope: scope),
          throwsA(matcher),
        );
      }
      expect(requests, 0);
    });

    test('preserves diagnostics and uncertain mutation outcomes', () async {
      var calls = 0;
      final failures = [
        (
          429,
          'RATE_LIMIT_EXCEEDED',
          AssistantFailureCategory.rateLimited,
          AssistantMutationOutcome.rejected,
        ),
        (
          409,
          'ASSISTANT_SOURCE_STALE',
          AssistantFailureCategory.sourceStale,
          AssistantMutationOutcome.unknown,
        ),
        (
          404,
          'RESOURCE_NOT_FOUND',
          AssistantFailureCategory.resourceUnavailable,
          AssistantMutationOutcome.unknown,
        ),
        (
          503,
          'ASSISTANT_UNAVAILABLE',
          AssistantFailureCategory.serviceUnavailable,
          AssistantMutationOutcome.unknown,
        ),
        (
          422,
          'VALIDATION_ERROR',
          AssistantFailureCategory.validation,
          AssistantMutationOutcome.rejected,
        ),
      ];
      final client = MeetingTestHttpClient((_) async {
        final failure = failures[calls++];
        return meetingApiFailure(
          failure.$1,
          failure.$2,
          headers: {'retry-after': '12'},
        );
      });
      final repository = await _repository(client);
      final scope = repository.captureSession();
      for (final failure in failures) {
        await expectLater(
          repository.submitQuestion(_question(), sessionScope: scope),
          throwsA(
            isA<AssistantFailure>()
                .having((e) => e.category, 'category', failure.$3)
                .having((e) => e.outcome, 'outcome', failure.$4)
                .having((e) => e.code, 'code', failure.$2)
                .having((e) => e.retryAfter, 'retryAfter', '12')
                .having((e) => e.requestId, 'requestId', isNotNull),
          ),
        );
      }
      expect(calls, failures.length);
    });

    test('malformed success and timeout are not proof of no write', () async {
      var calls = 0;
      final client = MeetingTestHttpClient((_) async {
        calls++;
        if (calls == 1) {
          return meetingApiSuccess({'unexpected': true});
        }
        throw TimeoutException('simulated timeout');
      });
      final repository = await _repository(client);
      final scope = repository.captureSession();
      for (final category in [
        AssistantFailureCategory.invalidResponse,
        AssistantFailureCategory.timeout,
      ]) {
        await expectLater(
          repository.submitQuestion(_question(), sessionScope: scope),
          throwsA(
            isA<AssistantFailure>()
                .having((e) => e.category, 'category', category)
                .having(
                  (e) => e.outcome,
                  'outcome',
                  AssistantMutationOutcome.unknown,
                )
                .having((e) => e.remoteOutcomeAmbiguous, 'ambiguous', true),
          ),
        );
      }
      expect(calls, 2);
    });

    for (final detail in [false, true]) {
      for (final lateFailure in [false, true]) {
        test(
          'old session cannot publish ${detail ? 'detail' : 'list'} '
          '${lateFailure ? 'failure' : 'success'} after session replacement',
          () async {
            final entered = Completer<void>();
            final held = Completer<http.StreamedResponse>();
            var reads = 0;
            final repository = await _repository(
              MeetingTestHttpClient((request) async {
                expect(request.method, 'GET');
                reads++;
                if (reads == 1) {
                  entered.complete();
                  return held.future;
                }
                return meetingApiSuccess(
                  detail ? _detail() : [_conversation()],
                );
              }),
            );
            final oldScope = repository.captureSession();
            Future<Object> read(AuthenticatedSessionScope scope) => detail
                ? repository.getConversation(
                    _conversationId,
                    sessionScope: scope,
                    expectedMeetingId: testMeetingId,
                  )
                : repository.listConversations(sessionScope: scope);

            final pending = read(oldScope);
            final expectation = expectLater(
              pending,
              throwsA(
                isA<AssistantFailure>()
                    .having(
                      (e) => e.category,
                      'category',
                      AssistantFailureCategory.authentication,
                    )
                    .having(
                      (e) => e.outcome,
                      'outcome',
                      AssistantMutationOutcome.notApplicable,
                    ),
              ),
            );
            await entered.future;
            await repository.api.signOut();
            await repository.api.signIn('user@example.test', 'password');
            final newScope = repository.captureSession();
            expect(newScope, isNot(oldScope));
            held.complete(
              lateFailure
                  ? await meetingApiFailure(403, 'AUTHZ_FORBIDDEN')
                  : await meetingApiSuccess(
                      detail ? _detail() : [_conversation()],
                    ),
            );
            await expectation;
            await expectLater(
              read(oldScope),
              throwsA(
                isA<AssistantFailure>().having(
                  (e) => e.outcome,
                  'outcome',
                  AssistantMutationOutcome.notDispatched,
                ),
              ),
            );
            expect(reads, 1);
            final current = await read(newScope);
            expect(
              current,
              detail
                  ? isA<AssistantConversationDetail>()
                  : isA<AssistantConversationPage>(),
            );
            expect(reads, 2);
          },
        );
      }
    }

    test('old session cannot dispatch or publish a late mutation', () async {
      final entered = Completer<void>();
      final held = Completer<http.StreamedResponse>();
      var writes = 0;
      final repository = await _repository(
        MeetingTestHttpClient((_) async {
          writes++;
          entered.complete();
          return held.future;
        }),
      );
      final oldScope = repository.captureSession();
      final pending = repository.submitQuestion(
        _question(),
        sessionScope: oldScope,
      );
      final expectation = expectLater(
        pending,
        throwsA(
          isA<AssistantFailure>()
              .having(
                (e) => e.category,
                'category',
                AssistantFailureCategory.authentication,
              )
              .having(
                (e) => e.outcome,
                'outcome',
                AssistantMutationOutcome.unknown,
              ),
        ),
      );
      await entered.future;
      await repository.api.signOut();
      await repository.api.signIn('user@example.test', 'password');
      held.complete(await meetingApiSuccess(_turn()));
      await expectation;
      await expectLater(
        repository.submitQuestion(_question(), sessionScope: oldScope),
        throwsA(
          isA<AssistantFailure>().having(
            (e) => e.outcome,
            'outcome',
            AssistantMutationOutcome.notDispatched,
          ),
        ),
      );
      expect(writes, 1);
    });
  });

  group('Assistant evidence presentation', () {
    testWidgets(
      'citation interaction is typed and redaction removes evidence',
      (tester) async {
        final visible = AssistantMessage.fromJson(
          _message(),
          response: _result(_message()),
          meetingId: testMeetingId,
        );
        final hiddenRaw = _message(visibility: 'SOURCE_UNAVAILABLE');
        final hidden = AssistantMessage.fromJson(
          hiddenRaw,
          response: _result(hiddenRaw),
          meetingId: testMeetingId,
        );
        AssistantCitation? opened;
        Widget surface(AssistantMessage message) => MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: AssistantMessageView(
                message: message,
                onOpenCitation: (citation) => opened = citation,
              ),
            ),
          ),
        );
        await tester.pumpWidget(surface(visible));
        await tester.tap(find.text('Bằng chứng · 1 nguồn'));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Mở nguồn tham chiếu'));
        expect(opened?.sourceId, _sourceId);
        await tester.pumpWidget(surface(hidden));
        await tester.pumpAndSettle();
        expect(find.byTooltip('Mở nguồn tham chiếu'), findsNothing);
        expect(find.text('Đã thống nhất.'), findsNothing);
      },
    );
  });

  group('Assistant workspace recovery', () {
    test('ASK cooldown survives editing and conversation switching', () async {
      const otherId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      final other = _conversation()..['id'] = otherId;
      var writes = 0;
      final retryAt = HttpDate.format(
        DateTime.now().add(const Duration(minutes: 1)).toUtc(),
      );
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/conversations')) {
            return meetingApiSuccess([]);
          }
          if (request.method == 'POST') {
            writes++;
            return meetingApiFailure(
              429,
              'RATE_LIMIT_EXCEEDED',
              headers: {'retry-after': retryAt},
            );
          }
          return meetingApiSuccess(
            _detail(messages: [])
              ..['conversation'] = request.url.path.endsWith(otherId)
                  ? other
                  : _conversation(),
          );
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      controller.setActive(true);
      await controller.open(_typedConversation());
      await controller.submit('Câu hỏi');
      expect(controller.askCoolingDown, isTrue);
      expect(controller.canRetryPending, isFalse);
      expect(controller.editRejectedQuestion(), 'Câu hỏi');
      expect(controller.canCompose, isTrue);
      expect(controller.canSend, isFalse);
      await controller.open(
        AssistantConversation.fromJson(other, response: _result(other)),
      );
      expect(controller.canCompose, isTrue);
      expect(controller.canSend, isFalse);
      await controller.submit('Câu hỏi khác');
      expect(writes, 1);
    });

    test(
      'automatic status monitoring resolves a turn without POST replay',
      () async {
        var reads = 0;
        var writes = 0;
        final settled = Completer<void>();
        final repository = await _repository(
          MeetingTestHttpClient((request) async {
            if (request.url.path.endsWith('/conversations')) {
              return meetingApiSuccess([]);
            }
            if (request.url.path.endsWith('/turns/by-key')) {
              reads++;
              return meetingApiSuccess({
                'turn': _turn(processing: reads == 1),
                'recoveryEligible': false,
              });
            }
            if (request.method == 'POST') {
              writes++;
              return meetingApiSuccess(_turn(processing: true), status: 202);
            }
            return meetingApiSuccess(
              _detail(messages: reads >= 2 ? [_userMessage(), _message()] : []),
            );
          }),
        );
        final controller = AssistantWorkspaceController(repository);
        addTearDown(controller.dispose);
        controller.addListener(() {
          if (reads >= 2 &&
              controller.pending == null &&
              !settled.isCompleted) {
            settled.complete();
          }
        });
        controller.setActive(true);
        await controller.open(_typedConversation());
        await controller.submit('Câu hỏi');
        await settled.future.timeout(const Duration(seconds: 15));
        expect(reads, 2);
        expect(writes, 1);
        expect(controller.messages.length, 2);
      },
    );

    test('TLS failure before dispatch does not lock the composer', () async {
      var writes = 0;
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/conversations')) {
            return meetingApiSuccess([]);
          }
          if (request.method == 'POST') {
            writes++;
            throw const HandshakeException('TLS failed');
          }
          return meetingApiSuccess(_detail(messages: []));
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      controller.setActive(true);
      await controller.open(_typedConversation());
      await controller.submit('Câu hỏi');
      expect(
        controller.pending?.failure?.outcome,
        AssistantMutationOutcome.notDispatched,
      );
      expect(controller.pending?.canEdit, isTrue);
      expect(controller.editRejectedQuestion(), 'Câu hỏi');
      expect(controller.canSend, isTrue);
      expect(writes, 1);
    });

    test('incremental reconciliation retains contiguous older history', () async {
      var submitted = false;
      Map<String, dynamic> userAt(int index) => _userMessage()
        ..['id'] =
            'aaaaaaaa-aaaa-4aaa-8aaa-${index.toRadixString(16).padLeft(12, '0')}';
      final initial = List.generate(50, (index) => userAt(index + 2));
      final older = [userAt(0), userAt(1)];
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/conversations')) {
            return meetingApiSuccess([]);
          }
          if (request.method == 'POST') {
            submitted = true;
            return meetingApiSuccess(_turn());
          }
          if (request.url.queryParameters.containsKey('beforeMessageId')) {
            return meetingApiSuccess(_detail(messages: older));
          }
          return meetingApiSuccess(
            _detail(
              hasMore: true,
              messages: submitted
                  ? [...initial.skip(2), _userMessage(), _message()]
                  : initial,
            ),
          );
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      controller.setActive(true);
      await controller.open(_typedConversation());
      await controller.loadOlder();
      expect(controller.messages.length, 52);
      await controller.submit('Câu hỏi');
      expect(controller.pending, isNull);
      expect(controller.messages.length, 54);
      expect(controller.messages.first.id, older.first['id']);
      expect(controller.messages.last.id, _assistantMessageId);
    });

    test('uncertain creation can be abandoned after access loss', () async {
      var writes = 0;
      final keys = <String?>[];
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          if (request.method == 'GET') return meetingApiSuccess([]);
          writes++;
          keys.add(request.headers['idempotency-key']);
          if (writes == 1) throw TimeoutException('lost response');
          if (writes == 2) {
            return meetingApiFailure(404, 'RESOURCE_NOT_FOUND');
          }
          return meetingApiSuccess(_conversation(), status: 201);
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      controller.setActive(true);
      await controller.create(testMeetingId, 'Weekly review');
      await controller.retryCreation();
      expect(controller.canDiscardCreation, isFalse);
      expect(controller.canAbandonCreation, isTrue);
      await controller.abandonCreation();
      expect(controller.creation, isNull);
      expect(
        await controller.create(testMeetingId, 'Another intent'),
        isNotNull,
      );
      expect(keys[0], keys[1]);
      expect(keys[2], isNot(keys[0]));
    });

    test('terminal turn waits for both canonical message identities', () async {
      var writes = 0;
      var completeHistory = false;
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/conversations')) {
            return meetingApiSuccess([]);
          }
          if (request.method == 'POST') {
            writes++;
            return meetingApiSuccess(_turn());
          }
          return meetingApiSuccess(
            _detail(
              messages: completeHistory ? [_userMessage(), _message()] : [],
            ),
          );
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      controller.setActive(true);
      await controller.open(_typedConversation());
      await controller.submit('Câu hỏi');
      expect(controller.pending?.terminal, isTrue);
      expect(controller.canSend, isFalse);
      completeHistory = true;
      await controller.reconcilePending();
      expect(controller.pending, isNull);
      expect(controller.messages.length, 2);
      expect(writes, 1);
    });

    test(
      'terminal status during older history loading is reconciled afterwards',
      () async {
        final statusEntered = Completer<void>();
        final statusResponse = Completer<http.StreamedResponse>();
        final olderEntered = Completer<void>();
        final olderResponse = Completer<http.StreamedResponse>();
        var terminal = false;
        var writes = 0;
        Map<String, dynamic> userAt(int index) => _userMessage()
          ..['id'] =
              'aaaaaaaa-aaaa-4aaa-8aaa-${index.toRadixString(16).padLeft(12, '0')}';
        final initial = List.generate(50, (index) => userAt(index + 2));
        final older = [userAt(0), userAt(1)];
        final repository = await _repository(
          MeetingTestHttpClient((request) async {
            final path = request.url.path;
            if (path.endsWith('/conversations')) {
              return meetingApiSuccess([]);
            }
            if (path.endsWith('/turns/by-key')) {
              statusEntered.complete();
              return statusResponse.future;
            }
            if (request.method == 'POST') {
              writes++;
              return meetingApiSuccess(_turn(processing: true), status: 202);
            }
            if (request.url.queryParameters.containsKey('beforeMessageId')) {
              olderEntered.complete();
              return olderResponse.future;
            }
            return meetingApiSuccess(
              _detail(
                hasMore: true,
                messages: terminal
                    ? [...initial.skip(2), _userMessage(), _message()]
                    : initial,
              ),
            );
          }),
        );
        final controller = AssistantWorkspaceController(repository);
        addTearDown(controller.dispose);
        controller.setActive(true);
        await controller.open(_typedConversation());
        final submission = controller.submit('Câu hỏi');
        await statusEntered.future;
        final loading = controller.loadOlder();
        await olderEntered.future;
        terminal = true;
        statusResponse.complete(
          await meetingApiSuccess({
            'turn': _turn(),
            'recoveryEligible': false,
          }),
        );
        await submission;
        expect(controller.pending?.terminal, isTrue);
        olderResponse.complete(
          await meetingApiSuccess(_detail(messages: older)),
        );
        await loading;
        expect(controller.pending, isNull);
        expect(controller.messages.length, 54);
        expect(controller.messages.last.id, _assistantMessageId);
        expect(writes, 1);
      },
    );

    test('archived conversation prevents pending retry mutations', () async {
      var archived = false;
      var writes = 0;
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/conversations')) {
            return meetingApiSuccess([]);
          }
          if (path.endsWith('/turns/by-key')) {
            return meetingApiSuccess({
              'turn': _turn(processing: true),
              'recoveryEligible': true,
            });
          }
          if (request.method == 'POST') {
            writes++;
            return meetingApiSuccess(_turn(processing: true), status: 202);
          }
          return meetingApiSuccess(
            _detail(messages: [])
              ..['conversation'] = (_conversation()
                ..['status'] = archived ? 'ARCHIVED' : 'ACTIVE'),
          );
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      controller.setActive(true);
      await controller.open(_typedConversation());
      await controller.submit('Câu hỏi');
      expect(controller.canRetryPending, isTrue);
      archived = true;
      await controller.refreshHistory();
      expect(controller.canRetryPending, isFalse);
      await controller.retryPending();
      expect(writes, 1);
      await controller.checkPending();
      expect(controller.pending?.turn?.turnId, _turnId);
    });

    test('ambiguous reclaim retains identity and permits local release', () async {
      final keys = <String?>[];
      var statusAvailable = true;
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/conversations')) {
            return meetingApiSuccess([]);
          }
          if (path.endsWith('/turns/by-key')) {
            if (!statusAvailable) {
              return meetingApiFailure(503, 'ASSISTANT_UNAVAILABLE');
            }
            return meetingApiSuccess({
              'turn': _turn(processing: true),
              'recoveryEligible': keys.length == 1,
            });
          }
          if (request.method == 'POST') {
            keys.add(request.headers['idempotency-key']);
            if (keys.length > 1) throw TimeoutException('lost reclaim');
            return meetingApiSuccess(_turn(processing: true), status: 202);
          }
          return meetingApiSuccess(_detail(messages: [_userMessage()]));
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      controller.setActive(true);
      await controller.open(_typedConversation());
      await controller.submit('Câu hỏi');
      final command = controller.pending!;
      command.automaticChecks = 12;
      statusAvailable = false;
      await controller.retryPending();
      await controller.checkPending();
      expect(command.turn?.turnId, _turnId);
      expect(command.reclaimUncertain, isTrue);
      expect(command.canAbandon, isTrue);
      statusAvailable = true;
      await controller.checkPending();
      expect(command.reclaimUncertain, isFalse);
      expect(command.canAbandon, isFalse);
      // A fresh authoritative live lease must not be locally abandoned.
      await controller.abandonPending();
      expect(controller.pending, same(command));
      expect(keys.length, 2);
      expect(keys.first, keys.last);
    });

    test('definitively rejected questions can be edited', () async {
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/conversations')) {
            return meetingApiSuccess([]);
          }
          if (request.method == 'POST') {
            return meetingApiFailure(422, 'VALIDATION_ERROR');
          }
          return meetingApiSuccess(_detail(messages: []));
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      controller.setActive(true);
      await controller.open(_typedConversation());
      await controller.submit('Câu hỏi');
      expect(controller.pending?.canEdit, isTrue);
      expect(controller.editRejectedQuestion(), 'Câu hỏi');
      expect(controller.canSend, isTrue);
    });

    test('status reads stop when the workspace is deactivated', () async {
      var reads = 0;
      var writes = 0;
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/conversations')) {
            return meetingApiSuccess([]);
          }
          if (request.url.path.endsWith('/turns/by-key')) {
            reads++;
            return meetingApiSuccess({
              'turn': _turn(processing: true),
              'recoveryEligible': false,
            });
          }
          if (request.method == 'POST') {
            writes++;
            return meetingApiSuccess(_turn(processing: true), status: 202);
          }
          return meetingApiSuccess(_detail(messages: [_userMessage()]));
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      controller.setActive(true);
      await controller.open(_typedConversation());
      await controller.submit('Câu hỏi');
      expect(reads, 1);
      controller.setActive(false);
      await controller.checkPending();
      expect(reads, 1);
      expect(writes, 1);
      expect(controller.messages, isEmpty);
    });

    test(
      'late history cannot replace the newly selected conversation',
      () async {
        const otherId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        final entered = Completer<void>();
        final held = Completer<http.StreamedResponse>();
        final other = _conversation()..['id'] = otherId;
        final repository = await _repository(
          MeetingTestHttpClient((request) async {
            final path = request.url.path;
            if (path.endsWith('/conversations')) {
              return meetingApiSuccess([]);
            }
            if (path.endsWith(otherId)) {
              return meetingApiSuccess(
                _detail(messages: [])..['conversation'] = other,
              );
            }
            entered.complete();
            return held.future;
          }),
        );
        final controller = AssistantWorkspaceController(repository);
        addTearDown(controller.dispose);
        controller.setActive(true);
        final first = controller.open(_typedConversation());
        await entered.future;
        await controller.open(
          AssistantConversation.fromJson(other, response: _result(other)),
        );
        held.complete(await meetingApiSuccess(_detail()));
        await first;
        expect(controller.conversation?.id, otherId);
        expect(controller.messages, isEmpty);
        expect(controller.historyVerified, isTrue);
      },
    );

    test(
      'creation retries preserve the intent after an ambiguous failure',
      () async {
        final keys = <String?>[];
        final repository = await _repository(
          MeetingTestHttpClient((request) async {
            if (request.method == 'GET') return meetingApiSuccess([]);
            keys.add(request.headers['idempotency-key']);
            if (keys.length == 1) throw TimeoutException('lost response');
            return meetingApiSuccess(_conversation(), status: 201);
          }),
        );
        final controller = AssistantWorkspaceController(repository);
        addTearDown(controller.dispose);
        controller.setActive(true);
        expect(await controller.create(testMeetingId, 'Weekly review'), isNull);
        expect(controller.creation, isNotNull);
        expect(controller.canDiscardCreation, isFalse);
        expect(await controller.retryCreation(), isNotNull);
        expect(keys.length, 2);
        expect(keys.first, isNotNull);
        expect(keys.last, keys.first);
        expect(controller.creation, isNull);
      },
    );

    test(
      'turn status is read-only and explicit reclaim keeps the same key',
      () async {
        final keys = <String?>[];
        var statusReads = 0;
        final repository = await _repository(
          MeetingTestHttpClient((request) async {
            final path = request.url.path;
            if (path.endsWith('/conversations')) {
              return meetingApiSuccess([]);
            }
            if (path.endsWith('/turns/by-key')) {
              statusReads++;
              expect(request.method, 'GET');
              expect(request.headers['idempotency-key'], keys.first);
              return meetingApiSuccess({
                'turn': _turn(processing: true),
                'recoveryEligible': true,
              });
            }
            if (path.endsWith('/messages')) {
              keys.add(request.headers['idempotency-key']);
              expect(decodeRequestBody(request), {'question': 'Câu hỏi'});
              return keys.length == 1
                  ? meetingApiSuccess(_turn(processing: true), status: 202)
                  : meetingApiSuccess(_turn());
            }
            return meetingApiSuccess(
              _detail(
                messages: keys.length > 1 ? [_userMessage(), _message()] : [],
              ),
            );
          }),
        );
        final controller = AssistantWorkspaceController(repository);
        addTearDown(controller.dispose);
        controller.setActive(true);
        await controller.open(_typedConversation());
        await controller.submit('Câu hỏi');
        expect(statusReads, 1);
        expect(keys.length, 1);
        expect(controller.pending?.retryAllowed, isTrue);
        await controller.retryPending();
        expect(keys.length, 2);
        expect(keys.first, isNotNull);
        expect(keys.last, keys.first);
        expect(controller.pending, isNull);
        expect(controller.messages.map((message) => message.id), [
          _userMessageId,
          _assistantMessageId,
        ]);
      },
    );
  });
}
