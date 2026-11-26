import 'package:sme_meeting_assistant/core/api_model_validation.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';

enum AssistantConversationStatus { active, archived }

enum AssistantMessageRole { user, assistant, systemEvent }

enum AssistantMessageVisibility { visible, sourceUnavailable }

enum AssistantAnswerStatus { grounded, partial, insufficientEvidence, failed }

enum AssistantClaimSupport { supported, unsupported, conflicted }

enum AssistantSourceType { transcript, summary, decision, actionItem }

enum AssistantTurnState { processing, completed }

final _uuidPattern = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);

bool isAssistantUuid(String value) => _uuidPattern.hasMatch(value);

bool sameAssistantIdentity(String first, String second) =>
    first.toLowerCase() == second.toLowerCase();

String _uuid(Map<String, dynamic> raw, String field, ApiResult response) {
  final value = requiredIdentifier(raw, field, response: response);
  if (!isAssistantUuid(value)) invalidApiData(response: response);
  return value.toLowerCase();
}

T _enumValue<T extends Enum>(String value, List<T> values, ApiResult response) {
  for (final candidate in values) {
    final wire = candidate.name
        .replaceAllMapped(RegExp(r'[A-Z]'), (match) => '_' + match[0]!)
        .toUpperCase();
    if (wire == value) return candidate;
  }
  invalidApiData(response: response);
}

T _requiredEnum<T extends Enum>(
  Map<String, dynamic> raw,
  String field,
  List<T> values,
  ApiResult response,
) => _enumValue(
  requiredString(raw, field, response: response),
  values,
  response,
);

AssistantAnswerStatus? _answerStatus(
  Map<String, dynamic> raw,
  ApiResult response,
) {
  final value = optionalString(raw, 'answerStatus', response: response);
  return value == null
      ? null
      : _enumValue(value, AssistantAnswerStatus.values, response);
}

List<String> _references(dynamic raw, ApiResult response) {
  final ids = <String>[];
  final seen = <String>{};
  for (final value in requireJsonArray(raw, response: response)) {
    if (value is! String || value.trim().isEmpty || !seen.add(value)) {
      invalidApiData(response: response);
    }
    ids.add(value);
  }
  return List.unmodifiable(ids);
}

class AssistantConversation {
  const AssistantConversation._({
    required this.id,
    required this.meetingId,
    required this.title,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String meetingId;
  final String? title;
  final AssistantConversationStatus status;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory AssistantConversation.fromJson(
    Map<String, dynamic> raw, {
    required ApiResult response,
  }) => AssistantConversation._(
    id: _uuid(raw, 'id', response),
    meetingId: _uuid(raw, 'meetingId', response),
    title: optionalString(raw, 'title', response: response),
    status: _requiredEnum(
      raw,
      'status',
      AssistantConversationStatus.values,
      response,
    ),
    createdAt: requiredTimestamp(raw, 'createdAt', response: response),
    updatedAt: requiredTimestamp(raw, 'updatedAt', response: response),
  );
}

class AssistantClaim {
  const AssistantClaim._({
    required this.claimId,
    required this.text,
    required this.support,
    required this.citationIds,
  });

  final String claimId;
  final String text;
  final AssistantClaimSupport support;
  final List<String> citationIds;

  factory AssistantClaim._decode(
    Map<String, dynamic> raw,
    ApiResult response,
  ) => AssistantClaim._(
    claimId: requiredIdentifier(raw, 'claimId', response: response),
    text: requiredString(raw, 'text', response: response, nonEmpty: true),
    support: _requiredEnum(
      raw,
      'support',
      AssistantClaimSupport.values,
      response,
    ),
    citationIds: _references(raw['citationIds'], response),
  );
}

class AssistantCitation {
  const AssistantCitation._({
    required this.citationId,
    required this.sourceType,
    required this.sourceId,
    required this.meetingId,
    required this.sourceRevision,
    required this.retrievalChunkId,
    required this.claimIds,
  });

  final String citationId;
  final AssistantSourceType sourceType;
  final String sourceId;
  final String meetingId;
  final int sourceRevision;
  final String retrievalChunkId;
  final List<String> claimIds;

  factory AssistantCitation._decode(
    Map<String, dynamic> raw,
    ApiResult response,
  ) => AssistantCitation._(
    citationId: requiredIdentifier(raw, 'citationId', response: response),
    sourceType: _requiredEnum(
      raw,
      'sourceType',
      AssistantSourceType.values,
      response,
    ),
    sourceId: _uuid(raw, 'sourceId', response),
    meetingId: _uuid(raw, 'meetingId', response),
    sourceRevision: requiredInt(raw, 'sourceRevision', response: response),
    retrievalChunkId: requiredIdentifier(
      raw,
      'retrievalChunkId',
      response: response,
    ),
    claimIds: _references(raw['claimIds'], response),
  );
}

/// Validate the public evidence graph, not the underlying AI inference.
class _Evidence {
  const _Evidence(this.claims, this.citations);

  final List<AssistantClaim> claims;
  final List<AssistantCitation> citations;

  factory _Evidence.decode(
    Map<String, dynamic> raw,
    ApiResult response,
    String meetingId,
  ) {
    final claims = requireJsonObjectArray(raw['claims'], response: response)
        .map((item) => AssistantClaim._decode(item, response))
        .toList(growable: false);
    final citations = requireJsonObjectArray(
      raw['citations'],
      response: response,
    ).map((item) => AssistantCitation._decode(item, response))
        .toList(growable: false);
    final byClaim = {for (final claim in claims) claim.claimId: claim};
    final byCitation = {
      for (final citation in citations) citation.citationId: citation,
    };
    if (byClaim.length != claims.length ||
        byCitation.length != citations.length) {
      invalidApiData(response: response);
    }

    for (final claim in claims) {
      if (claim.support == AssistantClaimSupport.unsupported
          ? claim.citationIds.isNotEmpty
          : claim.citationIds.isEmpty) {
        invalidApiData(response: response);
      }
      if (claim.support == AssistantClaimSupport.conflicted &&
          claim.citationIds.length < 2) {
        invalidApiData(response: response);
      }
      for (final id in claim.citationIds) {
        if (!(byCitation[id]?.claimIds.contains(claim.claimId) ?? false)) {
          invalidApiData(response: response);
        }
      }
    }
    for (final citation in citations) {
      if (!sameAssistantIdentity(citation.meetingId, meetingId) ||
          citation.claimIds.isEmpty) {
        invalidApiData(response: response);
      }
      for (final id in citation.claimIds) {
        final claim = byClaim[id];
        if (claim == null || !claim.citationIds.contains(citation.citationId)) {
          invalidApiData(response: response);
        }
      }
    }
    return _Evidence(List.unmodifiable(claims), List.unmodifiable(citations));
  }

  bool get isEmpty => claims.isEmpty && citations.isEmpty;

  void validateAnswer(AssistantAnswerStatus status, ApiResult response) {
    switch (status) {
      case AssistantAnswerStatus.insufficientEvidence:
      case AssistantAnswerStatus.failed:
        if (!isEmpty) invalidApiData(response: response);
      case AssistantAnswerStatus.grounded:
      case AssistantAnswerStatus.partial:
        if (claims.isEmpty ||
            citations.isEmpty ||
            !claims.any(
              (claim) => claim.support != AssistantClaimSupport.unsupported,
            )) {
          invalidApiData(response: response);
        }
        if (status == AssistantAnswerStatus.grounded &&
            claims.any(
              (claim) => claim.support == AssistantClaimSupport.unsupported,
            )) {
          invalidApiData(response: response);
        }
        if (status == AssistantAnswerStatus.partial &&
            claims.every(
              (claim) => claim.support == AssistantClaimSupport.supported,
            )) {
          invalidApiData(response: response);
        }
    }
  }
}

class AssistantMessage {
  const AssistantMessage._({
    required this.id,
    required this.role,
    required this.content,
    required this.answerStatus,
    required this.visibility,
    required this.claims,
    required this.citations,
    required this.createdAt,
  });

  final String id;
  final AssistantMessageRole role;
  final String? content;
  final AssistantAnswerStatus? answerStatus;
  final AssistantMessageVisibility visibility;
  final List<AssistantClaim> claims;
  final List<AssistantCitation> citations;
  final DateTime createdAt;

  factory AssistantMessage.fromJson(
    Map<String, dynamic> raw, {
    required ApiResult response,
    required String meetingId,
  }) {
    final role = _requiredEnum(
      raw,
      'role',
      AssistantMessageRole.values,
      response,
    );
    final visibility = _requiredEnum(
      raw,
      'visibility',
      AssistantMessageVisibility.values,
      response,
    );
    final status = _answerStatus(raw, response);
    final content = optionalString(raw, 'content', response: response);
    final evidence = _Evidence.decode(raw, response, meetingId);

    if (visibility == AssistantMessageVisibility.sourceUnavailable) {
      if (role != AssistantMessageRole.assistant ||
          (status != AssistantAnswerStatus.grounded &&
              status != AssistantAnswerStatus.partial) ||
          content != null ||
          !evidence.isEmpty) {
        invalidApiData(response: response);
      }
    } else {
      if (content == null || content.isEmpty) {
        invalidApiData(response: response);
      }
      if (role == AssistantMessageRole.assistant) {
        if (status == null) invalidApiData(response: response);
        evidence.validateAnswer(status, response);
      } else if (status != null || !evidence.isEmpty) {
        invalidApiData(response: response);
      }
    }
    return AssistantMessage._(
      id: _uuid(raw, 'id', response),
      role: role,
      content: content,
      answerStatus: status,
      visibility: visibility,
      claims: evidence.claims,
      citations: evidence.citations,
      createdAt: requiredTimestamp(raw, 'createdAt', response: response),
    );
  }
}

class AssistantConversationPage {
  const AssistantConversationPage._({
    required this.page,
    required this.size,
    required this.items,
  });

  final int page;
  final int size;
  final List<AssistantConversation> items;

  /// A full page is not proof of a subsequent page.
  bool get mayHaveMore => items.length == size && page < 10000;

  factory AssistantConversationPage.fromResult(
    ApiResult response, {
    required int page,
    required int size,
  }) {
    final items = response.objectArrayData().map(
      (raw) => AssistantConversation.fromJson(raw, response: response),
    );
    final result = List<AssistantConversation>.unmodifiable(items);
    if (result.length > size ||
        result.map((item) => item.id).toSet().length != result.length) {
      invalidApiData(response: response);
    }
    return AssistantConversationPage._(page: page, size: size, items: result);
  }
}

class AssistantConversationDetail {
  const AssistantConversationDetail._({
    required this.conversation,
    required this.messages,
    required this.page,
    required this.size,
    required this.hasMore,
  });

  final AssistantConversation conversation;
  final List<AssistantMessage> messages;
  final int page;
  final int size;
  final bool hasMore;

  factory AssistantConversationDetail.fromResult(
    ApiResult response, {
    required String conversationId,
    required int requestedPage,
    required int requestedSize,
    String? expectedMeetingId,
  }) {
    final raw = response.objectData();
    final conversation = AssistantConversation.fromJson(
      requiredObject(raw, 'conversation', response: response),
      response: response,
    );
    final page = requiredInt(raw, 'page', response: response);
    final size = requiredInt(raw, 'size', response: response, minimum: 1);
    final hasMore = requiredBool(raw, 'hasMore', response: response);
    if (!sameAssistantIdentity(conversation.id, conversationId) ||
        (expectedMeetingId != null &&
            conversation.meetingId != expectedMeetingId.toLowerCase()) ||
        page != requestedPage ||
        size != requestedSize) {
      invalidApiData(response: response);
    }
    final messages = List<AssistantMessage>.unmodifiable(
      requireJsonObjectArray(raw['messages'], response: response).map(
        (item) => AssistantMessage.fromJson(
          item,
          response: response,
          meetingId: conversation.meetingId,
        ),
      ),
    );
    if (messages.length > size ||
        (hasMore && messages.length != size) ||
        messages.map((item) => item.id).toSet().length != messages.length) {
      invalidApiData(response: response);
    }
    for (var index = 1; index < messages.length; index++) {
      if (messages[index].createdAt.isBefore(messages[index - 1].createdAt)) {
        invalidApiData(response: response);
      }
    }
    return AssistantConversationDetail._(
      conversation: conversation,
      messages: messages,
      page: page,
      size: size,
      hasMore: hasMore,
    );
  }
}

class AssistantTurn {
  const AssistantTurn._({
    required this.turnId,
    required this.state,
    required this.userMessageId,
    required this.assistantMessageId,
    required this.answerStatus,
    required this.answer,
    required this.claims,
    required this.citations,
  });

  final String turnId;
  final AssistantTurnState state;
  final String userMessageId;
  final String? assistantMessageId;
  final AssistantAnswerStatus? answerStatus;
  final String? answer;
  final List<AssistantClaim> claims;
  final List<AssistantCitation> citations;

  factory AssistantTurn.fromResult(
    ApiResult response, {
    required String meetingId,
  }) {
    final raw = response.objectData();
    final state = _requiredEnum(
      raw,
      'state',
      AssistantTurnState.values,
      response,
    );
    final status = _answerStatus(raw, response);
    final answer = optionalString(raw, 'answer', response: response);
    final evidence = _Evidence.decode(raw, response, meetingId);
    final assistantId = raw['assistantMessageId'] == null
        ? null
        : _uuid(raw, 'assistantMessageId', response);
    final userId = _uuid(raw, 'userMessageId', response);
    if (state == AssistantTurnState.processing) {
      if (response.statusCode != 202 ||
          assistantId != null ||
          status != null ||
          answer != null ||
          !evidence.isEmpty) {
        invalidApiData(response: response);
      }
    } else {
      if (response.statusCode != 200 ||
          assistantId == null ||
          assistantId == userId ||
          status == null ||
          status == AssistantAnswerStatus.failed ||
          answer == null ||
          answer.isEmpty) {
        invalidApiData(response: response);
      }
      evidence.validateAnswer(status, response);
    }
    return AssistantTurn._(
      turnId: _uuid(raw, 'turnId', response),
      state: state,
      userMessageId: userId,
      assistantMessageId: assistantId,
      answerStatus: status,
      answer: answer,
      claims: evidence.claims,
      citations: evidence.citations,
    );
  }
}
