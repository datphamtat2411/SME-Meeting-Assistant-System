import 'package:sme_meeting_assistant/core/api_model_validation.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';

enum AssistantConversationStatus { active, archived }

enum AssistantMessageRole { user, assistant, systemEvent }

enum AssistantMessageVisibility { visible, sourceUnavailable }

enum AssistantAnswerStatus { grounded, partial, insufficientEvidence, failed }

enum AssistantClaimSupport { supported, unsupported, conflicted }

enum AssistantSourceType { transcript, summary, decision, actionItem }

enum AssistantTurnState { processing, completed, failed, staleSource }

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
    final citations =
        requireJsonObjectArray(raw['citations'], response: response)
            .map((item) => AssistantCitation._decode(item, response))
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
    required this.nextBeforeMessageId,
    required this.pendingTurn,
  });

  final AssistantConversation conversation;
  final List<AssistantMessage> messages;
  final int page;
  final int size;
  final bool hasMore;
  final String? nextBeforeMessageId;
  final AssistantTurnStatus? pendingTurn;

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
    final anchor = raw['nextBeforeMessageId'] == null
        ? null
        : _uuid(raw, 'nextBeforeMessageId', response);
    if (anchor != (hasMore ? messages.first.id : null)) {
      invalidApiData(response: response);
    }
    final pending = raw['pendingTurn'] == null
        ? null
        : AssistantTurnStatus.fromJson(
            requiredObject(raw, 'pendingTurn', response: response),
            response: response,
            conversationId: conversation.id,
          );
    if (pending != null &&
        pending.turn.state != AssistantTurnState.processing) {
      invalidApiData(response: response);
    }
    return AssistantConversationDetail._(
      conversation: conversation,
      messages: messages,
      page: page,
      size: size,
      hasMore: hasMore,
      nextBeforeMessageId: anchor,
      pendingTurn: pending,
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
  }) => AssistantTurn._decode(
    response.objectData(),
    response,
    meetingId,
    statusRead: false,
  );

  static AssistantTurn _decode(
    Map<String, dynamic> raw,
    ApiResult response,
    String meetingId, {
    required bool statusRead,
  }) {
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
      if (response.statusCode != (statusRead ? 200 : 202) ||
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
          status == null) {
        invalidApiData(response: response);
      }
      switch (state) {
        case AssistantTurnState.completed:
          if (status == AssistantAnswerStatus.failed ||
              answer == null ||
              answer.isEmpty) {
            invalidApiData(response: response);
          }
          evidence.validateAnswer(status, response);
        case AssistantTurnState.failed:
          if (!statusRead ||
              status != AssistantAnswerStatus.failed ||
              answer != null ||
              !evidence.isEmpty) {
            invalidApiData(response: response);
          }
        case AssistantTurnState.staleSource:
          if (!statusRead ||
              (status != AssistantAnswerStatus.grounded &&
                  status != AssistantAnswerStatus.partial) ||
              answer != null ||
              !evidence.isEmpty) {
            invalidApiData(response: response);
          }
        case AssistantTurnState.processing:
          invalidApiData(response: response);
      }
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

/// A successful read of a durable turn, not a successful question submission.
class AssistantTurnStatus {
  const AssistantTurnStatus._(this.turn, this.recoveryEligible);

  final AssistantTurn turn;
  final bool recoveryEligible;

  factory AssistantTurnStatus.fromResult(
    ApiResult response, {
    required String meetingId,
    String? conversationId,
  }) => AssistantTurnStatus.fromJson(
    response.objectData(),
    response: response,
    conversationId: conversationId,
  );

  factory AssistantTurnStatus.fromJson(
    Map<String, dynamic> raw, {
    required ApiResult response,
    String? conversationId,
  }) {
    if (response.statusCode != 200) invalidApiData(response: response);
    final returnedConversationId = _uuid(raw, 'conversationId', response);
    if (conversationId != null &&
        !sameAssistantIdentity(returnedConversationId, conversationId)) {
      invalidApiData(response: response);
    }
    final state = _requiredEnum(
      raw,
      'state',
      AssistantTurnState.values,
      response,
    );
    final leaseStatus = optionalString(raw, 'leaseStatus', response: response);
    final userMessageId = _uuid(raw, 'userMessageId', response);
    final assistantMessageId = raw['assistantMessageId'] == null
        ? null
        : _uuid(raw, 'assistantMessageId', response);
    final answerStatus = _answerStatus(raw, response);
    final turn = AssistantTurn._(
      turnId: _uuid(raw, 'turnId', response),
      state: state,
      userMessageId: userMessageId,
      assistantMessageId: assistantMessageId,
      answerStatus: answerStatus,
      answer: null,
      claims: const [],
      citations: const [],
    );

    if (state == AssistantTurnState.processing) {
      if (assistantMessageId != null ||
          answerStatus != null ||
          (leaseStatus != 'ACTIVE' && leaseStatus != 'EXPIRED')) {
        invalidApiData(response: response);
      }
    } else {
      if (assistantMessageId == null ||
          leaseStatus != null ||
          answerStatus == null) {
        invalidApiData(response: response);
      }
      switch (state) {
        case AssistantTurnState.completed:
          if (answerStatus == AssistantAnswerStatus.failed) {
            invalidApiData(response: response);
          }
        case AssistantTurnState.failed:
          if (answerStatus != AssistantAnswerStatus.failed) {
            invalidApiData(response: response);
          }
        case AssistantTurnState.staleSource:
          if (answerStatus != AssistantAnswerStatus.grounded &&
              answerStatus != AssistantAnswerStatus.partial) {
            invalidApiData(response: response);
          }
        case AssistantTurnState.processing:
          invalidApiData(response: response);
      }
    }
    return AssistantTurnStatus._(turn, leaseStatus == 'EXPIRED');
  }
}

/// A fresh Core authorization and source-revision proof for a persisted
/// message citation. This is source-level navigation, not segment provenance.
class AssistantResolvedCitation {
  const AssistantResolvedCitation._({
    required this.citationId,
    required this.sourceType,
    required this.sourceId,
    required this.sourceRevision,
    required this.meetingTitle,
    required this.claimIds,
  });

  final String citationId;
  final AssistantSourceType sourceType;
  final String sourceId;
  final int sourceRevision;
  final String meetingTitle;
  final List<String> claimIds;

  factory AssistantResolvedCitation.fromResult(
    ApiResult response, {
    required String conversationId,
    required String messageId,
    required AssistantCitation expected,
  }) {
    final raw = response.objectData();
    if (response.statusCode != 200 ||
        !sameAssistantIdentity(
          _uuid(raw, 'conversationId', response),
          conversationId,
        ) ||
        !sameAssistantIdentity(_uuid(raw, 'messageId', response), messageId) ||
        !sameAssistantIdentity(
          _uuid(raw, 'meetingId', response),
          expected.meetingId,
        )) {
      invalidApiData(response: response);
    }
    final entries = requireJsonObjectArray(raw['evidence'], response: response);
    if (entries.isEmpty || entries.length > 64) {
      invalidApiData(response: response);
    }
    final seen = <String>{};
    AssistantResolvedCitation? selected;
    for (final entry in entries) {
      final id = requiredIdentifier(entry, 'citationId', response: response);
      final type = _requiredEnum(
        entry,
        'sourceType',
        AssistantSourceType.values,
        response,
      );
      final source = _uuid(entry, 'sourceId', response);
      final revision = requiredInt(entry, 'sourceRevision', response: response);
      final claims = _references(entry['claimIds'], response);
      final meetingTitle = requiredIdentifier(
        entry,
        'meetingTitle',
        response: response,
      );
      requiredIdentifier(entry, 'label', response: response);
      final preview = optionalString(entry, 'preview', response: response);
      final navigation = requiredObject(
        entry,
        'navigation',
        response: response,
      );
      final expectedTarget = switch (type) {
        AssistantSourceType.transcript => 'MEETING_TRANSCRIPT',
        AssistantSourceType.summary => 'MEETING_SUMMARY',
        AssistantSourceType.decision => 'MEETING_DECISIONS',
        AssistantSourceType.actionItem => 'MEETING_ACTION_ITEMS',
      };
      if (!seen.add(id) ||
          claims.isEmpty ||
          (preview != null && preview.runes.length > 500) ||
          (type == AssistantSourceType.transcript && preview != null) ||
          requiredString(navigation, 'target', response: response) !=
              expectedTarget ||
          requiredString(navigation, 'precision', response: response) !=
              'SOURCE') {
        invalidApiData(response: response);
      }
      if (id != expected.citationId) continue;
      if (type != expected.sourceType ||
          !sameAssistantIdentity(source, expected.sourceId) ||
          revision != expected.sourceRevision ||
          claims.length != expected.claimIds.length ||
          !claims.toSet().containsAll(expected.claimIds)) {
        invalidApiData(response: response);
      }
      selected = AssistantResolvedCitation._(
        citationId: id,
        sourceType: type,
        sourceId: source,
        sourceRevision: revision,
        meetingTitle: meetingTitle,
        claimIds: claims,
      );
    }
    if (selected == null) invalidApiData(response: response);
    return selected;
  }
}
