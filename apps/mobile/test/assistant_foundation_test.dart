import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_evidence_page.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_evidence_resolver.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_page.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_message_view.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_repository.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_workspace_controller.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_detail_page.dart';

import 'action_item_foundation_test.dart' show itemJson;
import 'support/meeting_test_support.dart';
import 'support/widget_test_support.dart';

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

  group('Verified Assistant evidence', () {
    for (final type in ['TRANSCRIPT', 'SUMMARY', 'DECISION', 'ACTION_ITEM']) {
      test('verifies canonical $type identity and type-specific revision', () async {
        var revision = 2;
        var redact = false;
        var deny = false;
        var artifactReads = 0;
        final citationJson = _citation()
          ..['sourceType'] = type
          ..['sourceRevision'] = 2;
        final rawMessage = _message()..['citations'] = [citationJson];
        Map<String, dynamic> decision(String id) => {
          'id': id,
          'meetingId': testMeetingId,
          'content': 'Canonical decision',
          'status': 'CONFIRMED',
          'version': revision,
          'isStale': false,
          'createdAt': _timestamp,
        };
        final client = MeetingTestHttpClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/meetings/$testMeetingId')) {
            if (deny) return meetingApiFailure(403, 'AUTHZ_FORBIDDEN');
            return meetingApiSuccess(
              meetingTestJson(),
              headers: {'etag': testMeetingEtag},
            );
          }
          if (path.endsWith('/conversations/$_conversationId')) {
            return meetingApiSuccess(
              _detail(
                messages: [
                  if (redact)
                    _message(visibility: 'SOURCE_UNAVAILABLE')
                  else
                    rawMessage,
                ],
              ),
            );
          }
          artifactReads++;
          if (path.endsWith('/transcript')) {
            return meetingApiSuccess(
              {
                'id': _sourceId,
                'meetingId': testMeetingId,
                'versionNumber': 1,
                'languageCode': 'vi',
                'status': 'READY',
                'contentRevision': revision,
                'finalizedAt': _timestamp,
                'segments': [
                  {
                    'id': _assistantMessageId,
                    'ordinal': 0,
                    'text': 'Canonical transcript',
                    'startMs': 0,
                    'endMs': 1000,
                    'qualityStatus': 'ACCEPTED',
                    'version': 0,
                  },
                ],
              },
              headers: {'etag': '"transcript"'},
            );
          }
          if (path.endsWith('/summary')) {
            return meetingApiSuccess(
              {
                'id': _sourceId,
                'meetingId': testMeetingId,
                'versionNumber': revision,
                'sourceType': 'AI_GENERATED',
                'qualityStatus': 'READY',
                'content': 'Canonical summary',
                'isStale': false,
                'createdAt': _timestamp,
                'aiWarnings': [],
              },
              headers: {'etag': '"summary"'},
            );
          }
          if (path.endsWith('/decisions')) {
            final page = int.parse(request.url.queryParameters['page']!);
            final size = int.parse(request.url.queryParameters['size']!);
            return meetingApiSuccess(
              page == 0
                  ? List.generate(
                      size,
                      (index) => decision(
                        'aaaaaaaa-aaaa-4aaa-8aaa-${index.toRadixString(16).padLeft(12, '0')}',
                      ),
                    )
                  : [decision(_sourceId)],
              meta: {
                ...meetingTestMeta,
                'pagination': {
                  'page': page,
                  'size': size,
                  'totalElements': size + 1,
                  'totalPages': 2,
                  'hasNext': page == 0,
                  'hasPrevious': page > 0,
                },
              },
            );
          }
          if (path.endsWith('/action-items/$_sourceId')) {
            return meetingApiSuccess(
              itemJson(version: revision)..['id'] = _sourceId,
              headers: {'etag': '"action"'},
            );
          }
          throw StateError('Unexpected request: $path');
        });
        final api = createMeetingTestApi(client);
        await signInMeetingTestApi(api);
        final dependencies = AppDependencies(
          api: api,
          appearancePreferences: InMemoryAppearancePreferences(),
          httpClient: client,
        );
        addTearDown(dependencies.dispose);
        final message = AssistantMessage.fromJson(
          rawMessage,
          response: _result(rawMessage),
          meetingId: testMeetingId,
        );
        final target = AssistantEvidenceTarget(
          scope: dependencies.assistant.captureSession(),
          conversationId: _conversationId,
          messageId: _assistantMessageId,
          citation: message.citations.single,
        );
        final resolver = AssistantEvidenceResolver(
          assistant: dependencies.assistant,
          results: dependencies.results,
          actionItems: dependencies.actionItems,
        );
        final artifact = await resolver.verify(
          target,
          stillCurrent: () => true,
        );
        expect(artifact, switch (type) {
          'TRANSCRIPT' => isA<TranscriptEvidence>(),
          'SUMMARY' => isA<SummaryEvidence>(),
          'DECISION' => isA<DecisionEvidence>(),
          _ => isA<ActionItemEvidence>(),
        });
        expect(artifact.meetingTitle, 'Weekly review');
        expect(artifactReads, type == 'DECISION' ? 2 : 1);
        revision++;
        await expectLater(
          resolver.verify(target, stillCurrent: () => true),
          throwsA(
            isA<AssistantEvidenceFailure>().having(
              (error) => error.issue,
              'issue',
              AssistantEvidenceIssue.obsolete,
            ),
          ),
        );
        revision--;
        final before = artifactReads;
        redact = true;
        await expectLater(
          resolver.verify(target, stillCurrent: () => true),
          throwsA(isA<AssistantEvidenceFailure>()),
        );
        expect(artifactReads, before);
        redact = false;
        deny = true;
        await expectLater(
          resolver.verify(target, stillCurrent: () => true),
          throwsA(
            isA<AssistantEvidenceFailure>().having(
              (error) => error.issue,
              'issue',
              AssistantEvidenceIssue.meetingUnavailable,
            ),
          ),
        );
        expect(artifactReads, before);
      });
    }
  });

  testWidgets('ordinary Assistant creates and sends through canonical APIs', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final conversation = _conversation()..['title'] = 'Weekly review';
    final questions = <String>[];
    final keys = <String?>[];
    var creations = 0;
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/meetings')) {
        return meetingApiSuccess(
          [
            {
              ...meetingTestJson(),
              'display': {
                'organizerName': 'Test User',
                'roomName': null,
                'roomLocation': null,
                'participantCount': 1,
                'participantPreview': [
                  {'userId': testUserId, 'displayName': 'Test User'},
                ],
              },
            },
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
      }
      if (path.endsWith('/assistant/conversations')) {
        if (request.method == 'POST') {
          creations++;
          expect(decodeRequestBody(request)['meetingId'], testMeetingId);
          expect(request.headers['idempotency-key'], isNotEmpty);
          return meetingApiSuccess(conversation, status: 201);
        }
        return meetingApiSuccess(creations == 0 ? [] : [conversation]);
      }
      if (path.endsWith('/messages')) {
        questions.add(decodeRequestBody(request)['question'] as String);
        keys.add(request.headers['idempotency-key']);
        return meetingApiSuccess(_turn());
      }
      if (path.endsWith('/conversations/$_conversationId')) {
        return meetingApiSuccess(
          _detail(
            messages: questions.isEmpty ? [] : [_userMessage(), _message()],
          )..['conversation'] = conversation,
        );
      }
      if (path.endsWith('/meetings/$testMeetingId')) {
        return meetingApiSuccess(
          meetingTestJson(),
          headers: {'etag': testMeetingEtag},
        );
      }
      throw StateError('Unexpected request: $path');
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
        theme: ThemeData.dark(),
        home: Scaffold(
          body: AssistantPage(dependencies: dependencies, active: true),
        ),
      ),
    );
    final create = find.text('Hội thoại mới');
    await pumpUntil(
      tester,
      () => create.evaluate().isNotEmpty,
      reason: 'ordinary Assistant entry',
    );
    await tester.tap(create);
    final meeting = find.text('Weekly review');
    await pumpUntil(
      tester,
      () => meeting.evaluate().isNotEmpty,
      reason: 'authorized meeting picker',
    );
    expect(creations, 0);
    await tester.tap(meeting);
    final composer = find.byType(TextField);
    await pumpUntil(
      tester,
      () =>
          composer.evaluate().isNotEmpty &&
          dependencies.assistantWorkspace.canCompose,
      reason: 'created conversation history',
    );
    expect(creations, 1);
    expect(
      dependencies.assistantWorkspace.conversation?.meetingId,
      testMeetingId,
    );
    final send = find.byTooltip('Gửi câu hỏi');
    expect(tester.widget<IconButton>(send).onPressed, isNull);
    await tester.enterText(composer, '   ');
    await tester.pump();
    expect(tester.widget<IconButton>(send).onPressed, isNull);
    await tester.enterText(composer, '  Câu hỏi  ');
    await tester.pump();
    await tester.tap(send);
    await pumpUntil(
      tester,
      () =>
          dependencies.assistantWorkspace.pending == null &&
          dependencies.assistantWorkspace.messages.length == 2,
      reason: 'canonical turn reconciliation',
    );
    expect(questions, ['Câu hỏi']);
    expect(keys.single, isNotEmpty);
    expect(find.text('Đã thống nhất.'), findsWidgets);
    expect(tester.widget<TextField>(composer).controller!.text, isEmpty);
    await tester.tap(find.byTooltip('Danh sách hội thoại'));
    await pumpUntil(
      tester,
      () => meeting.evaluate().isNotEmpty,
      reason: 'return to conversation collection',
    );
    await tester.tap(meeting);
    await pumpUntil(
      tester,
      () => dependencies.assistantWorkspace.canCompose,
      reason: 'reopen canonical history',
    );
    expect(dependencies.assistantWorkspace.messages.length, 2);
    expect(creations, 1);
    expect(questions.length, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });

  testWidgets('contextual entry shares workspace and fixes meeting scope', (
    tester,
  ) async {
    final other = _conversation()
      ..['id'] = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      ..['meetingId'] = testRoomId
      ..['title'] = 'Other meeting conversation';
    final local = _conversation()..['title'] = 'This meeting conversation';
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (request.method == 'POST') {
        writes++;
        return meetingApiSuccess(local, status: 201);
      }
      if (path.endsWith('/meetings/$testMeetingId')) {
        return meetingApiSuccess(
          meetingTestJson(),
          headers: {'etag': testMeetingEtag},
        );
      }
      if (path.endsWith('/assistant/conversations')) {
        return meetingApiSuccess([other, local]);
      }
      if (path.endsWith('/conversations/$_conversationId')) {
        return meetingApiSuccess(
          _detail(messages: [])..['conversation'] = local,
        );
      }
      throw StateError('Unexpected request: $path');
    });
    final api = createMeetingTestApi(client);
    await tester.runAsync(() => signInMeetingTestApi(api));
    final dependencies = AppDependencies(
      api: api,
      appearancePreferences: InMemoryAppearancePreferences(),
      httpClient: client,
    );
    addTearDown(dependencies.dispose);
    final meeting = Meeting.fromJson(meetingTestJson());
    final owner = dependencies.assistantWorkspace;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AssistantPage(
            dependencies: dependencies,
            active: true,
            contextualMeeting: meeting,
          ),
        ),
      ),
    );
    await pumpUntil(
      tester,
      () => find.text('This meeting conversation').evaluate().isNotEmpty,
      reason: 'verified scoped conversation collection',
    );
    expect(find.text('Other meeting conversation'), findsNothing);
    expect(dependencies.assistantWorkspace, same(owner));
    expect(writes, 0);
    await tester.tap(find.text('This meeting conversation'));
    await pumpUntil(
      tester,
      () => find.byType(TextField).evaluate().isNotEmpty,
      reason: 'canonical scoped history',
    );
    await tester.enterText(find.byType(TextField), 'Draft in scoped workspace');
    expect(owner.draftFor(_conversationId), 'Draft in scoped workspace');
    expect(writes, 0);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });

  testWidgets('citation route verifies once and clears on meeting revocation', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(800, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final held = Completer<http.StreamedResponse>();
    var artifactReads = 0;
    var deny = false;
    final conversation = _conversation()..['title'] = 'Evidence conversation';
    final rawMessage = _message()
      ..['citations'] = [
        _citation()
          ..['sourceType'] = 'SUMMARY'
          ..['sourceRevision'] = 2,
      ];
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/meetings/$testMeetingId')) {
        if (deny) return meetingApiFailure(403, 'AUTHZ_FORBIDDEN');
        return meetingApiSuccess(
          meetingTestJson(),
          headers: {'etag': testMeetingEtag},
        );
      }
      if (path.endsWith('/conversations')) {
        return meetingApiSuccess([conversation]);
      }
      if (path.endsWith('/conversations/$_conversationId')) {
        return meetingApiSuccess(
          _detail(messages: [rawMessage])..['conversation'] = conversation,
        );
      }
      if (path.endsWith('/summary')) {
        artifactReads++;
        return held.future;
      }
      throw StateError('Unexpected request: $path');
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
        home: Scaffold(
          body: AssistantPage(dependencies: dependencies, active: true),
        ),
      ),
    );
    final entry = find.text('Evidence conversation');
    await pumpUntil(
      tester,
      () => entry.evaluate().isNotEmpty,
      reason: 'conversation collection',
    );
    await tester.tap(entry);
    final evidence = find.text('Bằng chứng · 1 nguồn');
    await pumpUntil(
      tester,
      () => evidence.evaluate().isNotEmpty,
      reason: 'canonical Assistant message',
    );
    final owner = dependencies.assistantWorkspace;
    await tester.enterText(find.byType(TextField), 'Private draft');
    expect(owner.draftFor(_conversationId), 'Private draft');
    await tester.ensureVisible(evidence);
    await tester.tap(evidence);
    await tester.pumpAndSettle();
    final openSource = find.byTooltip('Mở nguồn tham chiếu');
    await tester.ensureVisible(openSource);
    await tester.tap(openSource);
    await pumpUntil(
      tester,
      () =>
          find.byType(AssistantEvidencePage).evaluate().isNotEmpty &&
          artifactReads == 1,
      reason: 'destination owns verification while source read is pending',
    );
    expect(find.text('Canonical summary'), findsNothing);
    expect(owner.draftFor(_conversationId), 'Private draft');
    held.complete(
      await meetingApiSuccess(
        {
          'id': _sourceId,
          'meetingId': testMeetingId,
          'versionNumber': 2,
          'sourceType': 'AI_GENERATED',
          'qualityStatus': 'READY',
          'content': 'Canonical summary',
          'isStale': false,
          'createdAt': _timestamp,
          'aiWarnings': [],
        },
        headers: {'etag': '"summary"'},
      ),
    );
    await pumpUntil(
      tester,
      () => find.text('Canonical summary').evaluate().isNotEmpty,
      reason: 'verified source rendered',
    );
    expect(find.text('Weekly review'), findsOneWidget);
    expect(artifactReads, 1);
    deny = true;
    dependencies.meetingInvalidation.invalidate(
      sessionScope: owner.scope,
      meetingId: testMeetingId,
    );
    await tester.pump();
    expect(find.text('Canonical summary'), findsNothing);
    await pumpUntil(
      tester,
      () => find
          .text('Không thể truy cập nội dung cuộc họp này.')
          .evaluate()
          .isNotEmpty,
      reason: 'meeting access revoked',
    );
    expect(owner.draftFor(_conversationId), isEmpty);
    expect(artifactReads, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });

  testWidgets('contextual entry is fenced after leaving its originating tab', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(800, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final held = Completer<http.StreamedResponse>();
    var holdNext = false;
    var entered = false;
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/meetings/$testMeetingId')) {
        if (holdNext) {
          holdNext = false;
          entered = true;
          return held.future;
        }
        return meetingApiSuccess(
          meetingTestJson(),
          headers: {'etag': testMeetingEtag},
        );
      }
      if (path.endsWith('/participants') ||
          path.endsWith('/media') ||
          path.endsWith('/processing-jobs') ||
          path.endsWith('/conversations')) {
        return meetingApiSuccess([]);
      }
      return meetingApiFailure(404, 'RESOURCE_NOT_FOUND');
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
        home: MeetingDetailPage(
          dependencies: dependencies,
          meetingId: testMeetingId,
        ),
      ),
    );
    final entry = find.text('Hỏi trợ lý về cuộc họp này');
    final entryButton = find.ancestor(
      of: entry,
      matching: find.byWidgetPredicate((widget) => widget is FilledButton),
    );
    bool entryEnabled() => entryButton.evaluate().any(
      (element) => (element.widget as FilledButton).onPressed != null,
    );
    await pumpUntil(tester, entryEnabled, reason: 'meeting overview ready');
    await tester.ensureVisible(entry);
    holdNext = true;
    await tester.tap(entry);
    await pumpUntil(
      tester,
      () => entered,
      reason: 'entry verification pending',
    );
    await tester.tap(find.text('Thành viên'));
    await tester.pump();
    await tester.tap(find.text('Tổng quan'));
    await tester.pump();
    held.complete(
      await meetingApiSuccess(
        meetingTestJson(),
        headers: {'etag': testMeetingEtag},
      ),
    );
    await pumpUntil(tester, entryEnabled, reason: 'old entry intent released');
    expect(find.byType(AssistantPage), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });

  group('Assistant workspace ownership', () {
    test('stale host cannot release the new active presentation', () async {
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/conversations')) {
            return meetingApiSuccess([]);
          }
          return meetingApiSuccess(_detail(messages: []));
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      final first = Object();
      final second = Object();
      controller.setPresentationActive(first, true);
      await controller.open(_typedConversation());
      controller.saveDraft(_conversationId, 'Shared draft');
      controller.setPresentationActive(second, true);
      controller.setPresentationActive(first, false);
      expect(controller.ownsPresentation(second), isTrue);
      expect(controller.ownsPresentation(first), isFalse);
      expect(controller.draftFor(_conversationId), 'Shared draft');
      controller.forgetMeeting(testMeetingId);
      expect(controller.draftFor(_conversationId), isEmpty);
      expect(controller.conversation, isNull);
    });

    test('new relevant invalidation fences an in-flight read', () async {
      final entered = Completer<void>();
      final held = Completer<http.StreamedResponse>();
      final settled = Completer<void>();
      var invalidated = false;
      var reads = 0;
      final repository = await _repository(
        MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/conversations')) {
            return meetingApiSuccess([]);
          }
          if (!invalidated) return meetingApiSuccess(_detail());
          reads++;
          if (reads == 1) {
            entered.complete();
            return held.future;
          }
          return meetingApiSuccess(
            _detail(messages: [_message(visibility: 'SOURCE_UNAVAILABLE')]),
          );
        }),
      );
      final controller = AssistantWorkspaceController(repository);
      addTearDown(controller.dispose);
      controller.setActive(true);
      await controller.open(_typedConversation());
      controller.invalidateMeeting(testRoomId);
      expect(controller.historyVerified, isTrue);
      invalidated = true;
      controller.addListener(() {
        if (!controller.historyVerified) return;
        expect(
          controller.messages.single.visibility,
          AssistantMessageVisibility.sourceUnavailable,
        );
        if (!settled.isCompleted) settled.complete();
      });
      controller.invalidateMeeting(testMeetingId);
      controller.invalidateMeeting(testMeetingId);
      expect(controller.messages, isEmpty);
      await entered.future;
      controller.invalidateMeeting(testMeetingId);
      held.complete(await meetingApiSuccess(_detail()));
      await settled.future.timeout(const Duration(seconds: 5));
      expect(reads, 2);
      expect(controller.messages.single.content, isNull);
    });
  });

  group('Assistant workspace recovery', () {
    for (final meetingDenied in [true, false]) {
      test(
        'conversation denial checks meeting access: $meetingDenied',
        () async {
          const siblingId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
          const unrelatedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
          final sibling = _conversation()..['id'] = siblingId;
          final unrelated = _conversation(meetingId: testRoomId)
            ..['id'] = unrelatedId;
          var denied = false;
          var accessChecks = 0;
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
                return meetingApiSuccess(_turn(processing: true), status: 202);
              }
              if (path.endsWith(siblingId)) {
                return meetingApiSuccess(
                  _detail(messages: [])..['conversation'] = sibling,
                );
              }
              if (path.endsWith(unrelatedId)) {
                return meetingApiSuccess(
                  _detail(messages: [])..['conversation'] = unrelated,
                );
              }
              if (denied) return meetingApiFailure(404, 'RESOURCE_NOT_FOUND');
              return meetingApiSuccess(_detail(messages: []));
            }),
          );
          final controller = AssistantWorkspaceController(
            repository,
            verifyMeetingReadAccess:
                ({required sessionScope, required meetingId}) async {
                  accessChecks++;
                  expect(sessionScope, repository.captureSession());
                  expect(meetingId, testMeetingId);
                  return !meetingDenied;
                },
          );
          addTearDown(controller.dispose);
          controller.setActive(true);
          await controller.open(
            AssistantConversation.fromJson(sibling, response: _result(sibling)),
          );
          await controller.submit('Pending sibling question');
          expect(controller.pending?.turn?.turnId, _turnId);
          controller.saveDraft(siblingId, 'Sibling draft');
          await controller.open(
            AssistantConversation.fromJson(
              unrelated,
              response: _result(unrelated),
            ),
          );
          controller.saveDraft(unrelatedId, 'Unrelated draft');
          denied = true;
          await controller.open(_typedConversation());
          expect(accessChecks, 1);
          expect(controller.conversation, isNull);
          expect(controller.messages, isEmpty);
          expect(
            controller.draftFor(siblingId),
            meetingDenied ? '' : 'Sibling draft',
          );
          expect(controller.draftFor(unrelatedId), 'Unrelated draft');
          await controller.open(
            AssistantConversation.fromJson(sibling, response: _result(sibling)),
          );
          if (meetingDenied) {
            expect(controller.pending, isNull);
          } else {
            expect(controller.pending?.turn?.turnId, _turnId);
          }
        },
      );
    }

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

    for (final longCooldown in [false, true]) {
      testWidgets(
        'automatic status budget survives reactivation: $longCooldown',
        (tester) async {
          var reads = 0;
          var writes = 0;
          final repository = (await tester.runAsync(
            () => _repository(
              MeetingTestHttpClient((request) async {
                if (request.url.path.endsWith('/conversations')) {
                  return meetingApiSuccess([]);
                }
                if (request.url.path.endsWith('/turns/by-key')) {
                  reads++;
                  expect(request.method, 'GET');
                  if (longCooldown && reads == 1) {
                    return meetingApiFailure(
                      429,
                      'RATE_LIMIT_EXCEEDED',
                      headers: {'retry-after': '121'},
                    );
                  }
                  return meetingApiSuccess({
                    'turn': _turn(processing: true),
                    'recoveryEligible': false,
                  });
                }
                if (request.method == 'POST') {
                  writes++;
                  return meetingApiSuccess(
                    _turn(processing: true),
                    status: 202,
                  );
                }
                return meetingApiSuccess(_detail(messages: [_userMessage()]));
              }),
            ),
          ))!;
          final controller = AssistantWorkspaceController(
            repository,
            now: tester.binding.clock.now,
          );
          addTearDown(controller.dispose);
          controller.setActive(true);
          await controller.open(_typedConversation());
          await controller.submit('Câu hỏi');
          final command = controller.pending!;
          expect(reads, 1);
          expect(command.automaticChecks, 1);

          if (longCooldown) {
            await tester.pump(const Duration(seconds: 120));
            expect(reads, 1);
            expect(command.automaticExhausted, isTrue);
            expect(command.canCheck, isFalse);
            await tester.pump(const Duration(seconds: 1));
          } else {
            for (final delay in [2, 4, 8, ...List.filled(8, 10)]) {
              final before = reads;
              await tester.pump(Duration(seconds: delay - 1));
              expect(reads, before);
              await tester.pump(const Duration(seconds: 1));
              await tester.pump();
              expect(reads, before + 1);
            }
            expect(reads, 12);
            expect(command.automaticExhausted, isTrue);
          }
          final exhaustedReads = reads;
          controller.setActive(false);
          controller.setActive(true);
          await tester.pump();
          await tester.pump(const Duration(seconds: 30));
          expect(reads, exhaustedReads);
          expect(controller.pending, same(command));
          expect(command.automaticExhausted, isTrue);
          expect(controller.historyVerified, isTrue);
          await controller.checkPending();
          expect(reads, exhaustedReads + 1);
          expect(writes, 1);
          controller.setActive(false);
        },
      );
    }

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

    test('terminal status during older history loading is reconciled afterwards', () async {
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
        await meetingApiSuccess({'turn': _turn(), 'recoveryEligible': false}),
      );
      await submission;
      expect(controller.pending?.terminal, isTrue);
      olderResponse.complete(await meetingApiSuccess(_detail(messages: older)));
      await loading;
      expect(controller.pending, isNull);
      expect(controller.messages.length, 54);
      expect(controller.messages.last.id, _assistantMessageId);
      expect(writes, 1);
    });

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

    test(
      'ambiguous reclaim retains identity and permits local release',
      () async {
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
      },
    );

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
