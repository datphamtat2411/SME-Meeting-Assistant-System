import 'package:sme_meeting_assistant/core/api_client.dart';

import 'assistant_errors.dart';
import 'assistant_models.dart';

export 'assistant_errors.dart';
export 'assistant_models.dart';

class AssistantCreateConversationRequest {
  const AssistantCreateConversationRequest({
    required this.meetingId,
    this.title,
  });

  final String meetingId;
  final String? title;
}

class AssistantQuestionRequest {
  const AssistantQuestionRequest({
    required this.conversation,
    required this.question,
    required this.idempotencyKey,
  });

  final AssistantConversation conversation;
  final String question;
  final String idempotencyKey;
}

/// Stateless feature data boundary. The caller owns session and command
/// identity; the server owns conversation history and durable turn state.
class AssistantRepository {
  const AssistantRepository({required this.api});

  final ApiClient api;

  static const submissionTimeoutPolicy = CoreApiTimeoutPolicy(
    dispatchTimeout: Duration(seconds: 60),
    overallTimeout: Duration(seconds: 60),
  );

  static final _keyPattern = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  static const _collection = '/assistant/conversations';

  AuthenticatedSessionScope captureSession() {
    final scope = api.authenticatedSessionScope;
    if (scope == null || !api.isCurrentAuthenticatedSession(scope)) {
      throw AssistantFailure.sessionChanged(
        AssistantMutationOutcome.notDispatched,
      );
    }
    return scope;
  }

  Future<AssistantConversationPage> listConversations({
    required AuthenticatedSessionScope sessionScope,
    int page = 0,
    int size = 20,
  }) async {
    _validatePage(page, size);
    return _execute(sessionScope, mutation: false, operation: () async {
      final response = await api.get(
        _collection,
        query: _pageQuery(page, size),
        sessionScope: sessionScope,
      );
      if (response.statusCode != 200) throw response.invalidDataFailure();
      return AssistantConversationPage.fromResult(
        response,
        page: page,
        size: size,
      );
    });
  }

  Future<AssistantConversation> createConversation(
    AssistantCreateConversationRequest input, {
    required AuthenticatedSessionScope sessionScope,
  }) async {
    _validateUuid(input.meetingId, 'meetingId');
    final title = input.title?.trim();
    if (title != null && title.length > 255) {
      throw AssistantFailure.invalidInput('title');
    }
    return _execute(sessionScope, mutation: true, operation: () async {
      final response = await api.post(
        _collection,
        {
          'meetingId': input.meetingId.toLowerCase(),
          if (title != null && title.isNotEmpty) 'title': title,
        },
        sessionScope: sessionScope,
      );
      if (response.statusCode != 201) throw response.invalidDataFailure();
      final conversation = AssistantConversation.fromJson(
        response.objectData(),
        response: response,
      );
      if (!sameAssistantIdentity(conversation.meetingId, input.meetingId) ||
          conversation.status != AssistantConversationStatus.active) {
        throw response.invalidDataFailure();
      }
      return conversation;
    });
  }

  Future<AssistantConversationDetail> getConversation(
    String conversationId, {
    required AuthenticatedSessionScope sessionScope,
    String? expectedMeetingId,
    int page = 0,
    int size = 50,
  }) async {
    _validateUuid(conversationId, 'conversationId');
    if (expectedMeetingId != null) {
      _validateUuid(expectedMeetingId, 'meetingId');
    }
    _validatePage(page, size);
    return _execute(sessionScope, mutation: false, operation: () async {
      final response = await api.get(
        _path(conversationId),
        query: _pageQuery(page, size),
        sessionScope: sessionScope,
      );
      if (response.statusCode != 200) throw response.invalidDataFailure();
      return AssistantConversationDetail.fromResult(
        response,
        conversationId: conversationId,
        expectedMeetingId: expectedMeetingId,
        requestedPage: page,
        requestedSize: size,
      );
    });
  }

  Future<AssistantTurn> submitQuestion(
    AssistantQuestionRequest input, {
    required AuthenticatedSessionScope sessionScope,
  }) async {
    final question = input.question.trim();
    // Java @Size counts UTF-16 code units, as does Dart String.length.
    if (question.isEmpty || question.length > 4096) {
      throw AssistantFailure.invalidInput('question');
    }
    if (!_keyPattern.hasMatch(input.idempotencyKey)) {
      throw AssistantFailure.invalidInput('Idempotency-Key');
    }
    return _execute(sessionScope, mutation: true, operation: () async {
      final response = await api.post(
        _path(input.conversation.id) + '/messages',
        {'question': question},
        headers: {'Idempotency-Key': input.idempotencyKey},
        timeoutPolicy: submissionTimeoutPolicy,
        sessionScope: sessionScope,
      );
      return AssistantTurn.fromResult(
        response,
        meetingId: input.conversation.meetingId,
      );
    });
  }

  Future<T> _execute<T>(
    AuthenticatedSessionScope scope, {
    required bool mutation,
    required Future<T> Function() operation,
  }) async {
    if (!api.isCurrentAuthenticatedSession(scope)) {
      throw AssistantFailure.sessionChanged(
        AssistantMutationOutcome.notDispatched,
      );
    }
    final staleOutcome = mutation
        ? AssistantMutationOutcome.unknown
        : AssistantMutationOutcome.notApplicable;
    try {
      final result = await operation();
      if (!api.isCurrentAuthenticatedSession(scope)) {
        throw AssistantFailure.sessionChanged(staleOutcome);
      }
      return result;
    } on AssistantFailure {
      rethrow;
    } on AuthSessionException catch (error) {
      if (!api.isCurrentAuthenticatedSession(scope)) {
        throw AssistantFailure.sessionChanged(staleOutcome);
      }
      throw AssistantFailure.fromSession(error, mutation: mutation);
    } on ApiFailure catch (error) {
      if (!api.isCurrentAuthenticatedSession(scope)) {
        throw AssistantFailure.sessionChanged(staleOutcome);
      }
      throw AssistantFailure.fromApi(error, mutation: mutation);
    }
  }

  static String _path(String id) => _collection + '/' + id.toLowerCase();

  static Map<String, String> _pageQuery(int page, int size) => {
    'page': page.toString(),
    'size': size.toString(),
  };

  static void _validateUuid(String value, String field) {
    if (!isAssistantUuid(value)) throw AssistantFailure.invalidInput(field);
  }

  static void _validatePage(int page, int size) {
    if (page < 0 || page > 10000) {
      throw AssistantFailure.invalidInput('page');
    }
    if (size < 1 || size > 50) {
      throw AssistantFailure.invalidInput('size');
    }
  }
}
