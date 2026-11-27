import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_models.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_repository.dart';
import 'package:sme_meeting_assistant/features/results/results_models.dart';
import 'package:sme_meeting_assistant/features/results/results_repository.dart';

import 'assistant_repository.dart';

/// A rendered citation is a reference, not a permanent access grant.
class AssistantEvidenceTarget {
  const AssistantEvidenceTarget({
    required this.scope,
    required this.conversationId,
    required this.messageId,
    required this.citation,
    this.beforeMessageId,
  });

  final AuthenticatedSessionScope scope;
  final String conversationId;
  final String messageId;
  final AssistantCitation citation;

  // A known canonical newer neighbor can locate an old message without
  // scanning every newer page. Core still validates the anchor and scope.
  final String? beforeMessageId;
}

enum AssistantEvidenceIssue {
  unavailable,
  meetingUnavailable,
  obsolete,
  syncRequired,
  interrupted,
}

class AssistantEvidenceFailure implements Exception {
  const AssistantEvidenceFailure(this.issue);
  final AssistantEvidenceIssue issue;
}

sealed class AssistantEvidenceArtifact {
  const AssistantEvidenceArtifact({this.meetingTitle});
  final String? meetingTitle;
}

final class TranscriptEvidence extends AssistantEvidenceArtifact {
  const TranscriptEvidence(this.transcript, {super.meetingTitle});
  final Transcript transcript;
}

final class SummaryEvidence extends AssistantEvidenceArtifact {
  const SummaryEvidence(this.summary, {super.meetingTitle});
  final ResultsSummary summary;
}

final class DecisionEvidence extends AssistantEvidenceArtifact {
  const DecisionEvidence(this.decision, {super.meetingTitle});
  final MeetingDecision decision;
}

final class ActionItemEvidence extends AssistantEvidenceArtifact {
  const ActionItemEvidence(this.item, {super.meetingTitle});
  final ActionItemResource item;
}

/// Reuses canonical public repositories and the server's evidence visibility
/// decision. Each verification is bounded, read-only and owned by a caller.
class AssistantEvidenceResolver {
  const AssistantEvidenceResolver({
    required this.assistant,
    required this.results,
    required this.actionItems,
  });

  final AssistantRepository assistant;
  final ResultsRepository results;
  final ActionItemRepository actionItems;
  static const _maxPages = 5;

  void _requireCurrent(
    AssistantEvidenceTarget target,
    bool Function() stillCurrent,
  ) {
    if (!stillCurrent() ||
        !assistant.api.isCurrentAuthenticatedSession(target.scope)) {
      throw const AssistantEvidenceFailure(AssistantEvidenceIssue.interrupted);
    }
  }

  Future<AssistantEvidenceArtifact> verify(
    AssistantEvidenceTarget target, {
    required bool Function() stillCurrent,
  }) async {
    void check() => _requireCurrent(target, stillCurrent);
    check();
    final citation = target.citation;
    final meetingId = citation.meetingId;
    final scope = target.scope;
    final ResultsAccessVerification access;
    try {
      access = await results.verifyAccess(
        sessionScope: scope,
        meetingId: meetingId,
      );
    } on ApiFailure catch (error) {
      check();
      if (error.status == 403 || error.status == 404) {
        throw const AssistantEvidenceFailure(
          AssistantEvidenceIssue.meetingUnavailable,
        );
      }
      rethrow;
    }
    check();
    if (!access.canRead) {
      throw const AssistantEvidenceFailure(
        AssistantEvidenceIssue.meetingUnavailable,
      );
    }
    await _verifyOrigin(target, stillCurrent);
    check();

    final AssistantEvidenceArtifact artifact;
    switch (citation.sourceType) {
      case AssistantSourceType.transcript:
        final transcript = await results.currentTranscript(
          sessionScope: scope,
          meetingId: meetingId,
        );
        check();
        _requireSource(
          citation,
          transcript.id,
          transcript.meetingId,
          transcript.contentRevision,
          const {'READY', 'READY_WITH_WARNINGS'}.contains(transcript.status) &&
              transcript.finalizedAt != null &&
              transcript.segments.isNotEmpty,
        );
        artifact = TranscriptEvidence(
          transcript,
          meetingTitle: access.meetingTitle,
        );
      case AssistantSourceType.summary:
        final summary = await results.currentSummary(
          sessionScope: scope,
          meetingId: meetingId,
        );
        check();
        _requireSource(
          citation,
          summary.id,
          summary.meetingId,
          summary.versionNumber,
          !summary.isStale &&
              const {
                'READY',
                'READY_WITH_WARNINGS',
              }.contains(summary.qualityStatus),
        );
        artifact = SummaryEvidence(summary, meetingTitle: access.meetingTitle);
      case AssistantSourceType.decision:
        final decision = await _decision(target, stillCurrent);
        check();
        _requireSource(
          citation,
          decision.id,
          decision.meetingId,
          decision.version,
          decision.status == 'CONFIRMED' && !decision.stale,
        );
        artifact = DecisionEvidence(
          decision,
          meetingTitle: access.meetingTitle,
        );
      case AssistantSourceType.actionItem:
        final snapshot = await actionItems.detail(
          citation.sourceId,
          sessionScope: scope,
        );
        check();
        final item = snapshot.item;
        if (snapshot.sessionScope != scope ||
            !item.capabilities.canAccessMeeting) {
          throw const AssistantEvidenceFailure(
            AssistantEvidenceIssue.unavailable,
          );
        }
        _requireSource(
          citation,
          item.id,
          item.meetingId,
          item.version,
          item.isOfficial && item.status != ActionItemStatus.proposed,
        );
        artifact = ActionItemEvidence(item, meetingTitle: access.meetingTitle);
    }

    // The origin may have been redacted while the artifact was being read.
    // Re-read the public history before publishing the verified resource.
    await _verifyOrigin(target, stillCurrent);
    check();
    return artifact;
  }

  Future<void> _verifyOrigin(
    AssistantEvidenceTarget target,
    bool Function() stillCurrent,
  ) async {
    var anchor = target.beforeMessageId;
    final seen = <String>{};
    for (var index = 0; index < _maxPages; index++) {
      _requireCurrent(target, stillCurrent);
      final detail = await assistant.getConversation(
        target.conversationId,
        sessionScope: target.scope,
        expectedMeetingId: target.citation.meetingId,
        beforeMessageId: anchor,
      );
      _requireCurrent(target, stillCurrent);
      for (final message in detail.messages) {
        if (!seen.add(message.id)) {
          throw const AssistantEvidenceFailure(
            AssistantEvidenceIssue.syncRequired,
          );
        }
        if (!sameAssistantIdentity(message.id, target.messageId)) continue;
        if (message.role != AssistantMessageRole.assistant ||
            message.visibility != AssistantMessageVisibility.visible) {
          throw const AssistantEvidenceFailure(
            AssistantEvidenceIssue.unavailable,
          );
        }
        if (!message.citations.any(
          (value) => _matchesCitation(value, target.citation),
        )) {
          throw const AssistantEvidenceFailure(AssistantEvidenceIssue.obsolete);
        }
        return;
      }
      if (!detail.hasMore) {
        throw const AssistantEvidenceFailure(
          AssistantEvidenceIssue.unavailable,
        );
      }
      if (detail.messages.isEmpty) break;
      anchor = detail.messages.first.id;
    }
    throw const AssistantEvidenceFailure(AssistantEvidenceIssue.syncRequired);
  }

  bool _matchesCitation(AssistantCitation actual, AssistantCitation expected) =>
      actual.citationId == expected.citationId &&
      actual.sourceType == expected.sourceType &&
      sameAssistantIdentity(actual.sourceId, expected.sourceId) &&
      sameAssistantIdentity(actual.meetingId, expected.meetingId) &&
      actual.sourceRevision == expected.sourceRevision &&
      actual.retrievalChunkId == expected.retrievalChunkId &&
      actual.claimIds.length == expected.claimIds.length &&
      actual.claimIds.toSet().containsAll(expected.claimIds);

  void _requireSource(
    AssistantCitation citation,
    String id,
    String meetingId,
    int revision,
    bool eligible,
  ) {
    if (!sameAssistantIdentity(meetingId, citation.meetingId)) {
      throw const AssistantEvidenceFailure(AssistantEvidenceIssue.unavailable);
    }
    if (!sameAssistantIdentity(id, citation.sourceId) ||
        revision != citation.sourceRevision ||
        !eligible) {
      throw const AssistantEvidenceFailure(AssistantEvidenceIssue.obsolete);
    }
  }

  Future<MeetingDecision> _decision(
    AssistantEvidenceTarget target,
    bool Function() stillCurrent,
  ) async {
    final seen = <String>{};
    int? total;
    for (var page = 0; page < _maxPages; page++) {
      _requireCurrent(target, stillCurrent);
      final result = await results.decisions(
        sessionScope: target.scope,
        meetingId: target.citation.meetingId,
        page: page,
        size: 50,
        status: 'CONFIRMED',
      );
      _requireCurrent(target, stillCurrent);
      total ??= result.totalElements;
      final remaining = total - page * result.size;
      final expected = remaining > result.size ? result.size : remaining;
      if (result.totalElements != total ||
          result.items.length != expected ||
          result.items.any((item) => !seen.add(item.id))) {
        throw const AssistantEvidenceFailure(
          AssistantEvidenceIssue.syncRequired,
        );
      }
      for (final item in result.items) {
        if (sameAssistantIdentity(item.id, target.citation.sourceId)) {
          return item;
        }
      }
      if (!result.hasNext) {
        throw const AssistantEvidenceFailure(
          AssistantEvidenceIssue.unavailable,
        );
      }
    }
    throw const AssistantEvidenceFailure(AssistantEvidenceIssue.syncRequired);
  }
}

String assistantEvidenceFailureLabel(Object error) {
  if (error is AssistantEvidenceFailure) {
    return switch (error.issue) {
      AssistantEvidenceIssue.unavailable =>
        'Nguồn hoặc câu trả lời không còn khả dụng.',
      AssistantEvidenceIssue.meetingUnavailable =>
        'Không thể truy cập nội dung cuộc họp này.',
      AssistantEvidenceIssue.obsolete =>
        'Nguồn đã thay đổi và không còn khớp với bằng chứng đã trích dẫn.',
      AssistantEvidenceIssue.syncRequired =>
        'Chưa thể xác minh nguồn trong phạm vi lịch sử đã kiểm tra.',
      AssistantEvidenceIssue.interrupted => 'Quá trình xác minh bị gián đoạn.',
    };
  }
  if (error is ApiFailure &&
      (error.status == 401 || error.status == 403 || error.status == 404)) {
    return 'Không thể truy cập hoặc xác minh nguồn này.';
  }
  return 'Chưa thể xác minh nguồn. Kiểm tra kết nối và thử lại.';
}
