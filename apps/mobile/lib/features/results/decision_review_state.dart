import '../../core/api_client.dart';
import '../../core/meeting_models.dart';
import '../../core/paged_collection.dart';
import 'results_models.dart';

/// A meeting-scoped query window. The workspace supplies request generations
/// and authorization fencing, so no second transport lifecycle is needed.
class DecisionCollection {
  DecisionCollection._(this.items, this.lastPage, this.status);

  final List<MeetingDecision> items;
  final PagedCollection<MeetingDecision> lastPage;
  final String? status;

  bool get hasMore => lastPage.hasNext;

  factory DecisionCollection.first(
    PagedCollection<MeetingDecision> page,
    String? status,
  ) {
    if (page.page != 0) throw _changed();
    return _combine(const [], page, status);
  }

  DecisionCollection append(PagedCollection<MeetingDecision> page) {
    if (!hasMore ||
        page.page != lastPage.page + 1 ||
        page.size != lastPage.size ||
        page.totalElements != lastPage.totalElements ||
        page.totalPages != lastPage.totalPages) {
      throw _changed();
    }
    return _combine(items, page, status);
  }

  static DecisionCollection _combine(
    List<MeetingDecision> previous,
    PagedCollection<MeetingDecision> page,
    String? status,
  ) {
    final ids = previous.map((item) => item.id).toSet();
    final remaining = page.totalElements - page.page * page.size;
    final expected = remaining < page.size ? remaining : page.size;
    if (expected < 0 || page.items.length != expected) throw _changed();
    var last = previous.lastOrNull;
    for (final item in page.items) {
      if (!ids.add(item.id) ||
          (status != null && item.status != status) ||
          (last != null &&
              (item.createdAt.isAfter(last.createdAt) ||
                  (item.createdAt == last.createdAt &&
                      item.id.compareTo(last.id) >= 0)))) {
        throw _changed();
      }
      last = item;
    }
    return DecisionCollection._(
      List.unmodifiable([...previous, ...page.items]),
      page,
      status,
    );
  }

  static ApiFailure _changed() => const ApiFailure(
    409,
    'DECISION_COLLECTION_CHANGED',
    'Danh sách quyết định đã thay đổi. Vui lòng tải lại.',
  );
}

enum DecisionCommand { create, edit, confirm, reject }

class DecisionCommandIntent {
  const DecisionCommandIntent(
    this.command,
    this.content, {
    this.snapshot,
    this.creationContext,
  });

  final DecisionCommand command;
  final String content;
  final MeetingDecision? snapshot;

  /// The exact content/source/evidence context dispatched for a manual create.
  ///
  /// This is recovery evidence only. It must never be used as a new command
  /// without a fresh transcript review.
  final ManualDecisionDraft? creationContext;
}

class ManualDecisionDraft {
  const ManualDecisionDraft(
    this.content,
    this.attachEvidence, {
    this.source,
    this.evidence = const {},
    this.requiresFreshEvidenceReview = false,
  });

  final String content;
  final bool attachEvidence;
  final Transcript? source;
  final Set<String> evidence;
  final bool requiresFreshEvidenceReview;
}

enum ManualDecisionRecoveryDisposition { discard, reuse }

/// Decision-owned recovery state, cleared by shared ownership revocation.
class DecisionReviewState {
  ManualDecisionDraft? draft;
  DecisionCommandIntent? unresolved;
  Object? _recoveryTicket;
  List<MeetingDecision>? _reviewed;
  int? _recoveryGeneration;

  void invalidateRecovery() {
    _recoveryTicket = null;
    _reviewed = null;
    _recoveryGeneration = null;
  }

  void recordUnresolved(DecisionCommandIntent intent) {
    invalidateRecovery();
    unresolved = intent;
  }

  Object beginRecovery() {
    invalidateRecovery();
    final ticket = Object();
    _recoveryTicket = ticket;
    return ticket;
  }

  bool ownsRecovery(Object ticket, DecisionCommandIntent intent) =>
      identical(_recoveryTicket, ticket) && identical(unresolved, intent);

  bool publishRecovery(
    Object ticket,
    DecisionCommandIntent intent,
    List<MeetingDecision> reviewed,
    int generation,
  ) {
    if (!ownsRecovery(ticket, intent)) return false;
    _reviewed = reviewed;
    _recoveryGeneration = generation;
    return true;
  }

  bool matchesRecovery(List<MeetingDecision> reviewed, int generation) =>
      unresolved != null &&
      identical(_reviewed, reviewed) &&
      _recoveryGeneration == generation;

  bool get isUnresolvedManualCreation =>
      unresolved?.command == DecisionCommand.create;

  void clear() {
    draft = null;
    unresolved = null;
    invalidateRecovery();
  }
}

typedef DecisionReviewStamp = (int, int, int, int);

/// Recovery intentionally reads the unfiltered canonical collection. Its
/// result is evidence for human review, not proof of command execution.
Future<List<MeetingDecision>?> readDecisionRecovery({
  required Future<PagedCollection<MeetingDecision>> Function(int page, int size)
  readPage,
  required bool Function() stillCurrent,
}) async {
  if (!stillCurrent()) return null;
  final first = await readPage(0, 20);
  if (!stillCurrent()) return null;
  try {
    var collection = DecisionCollection.first(first, null);
    while (collection.hasMore) {
      final next = await readPage(
        collection.lastPage.page + 1,
        collection.lastPage.size,
      );
      if (!stillCurrent()) return null;
      collection = collection.append(next);
    }
    return collection.items.length == first.totalElements
        ? collection.items
        : null;
  } on ApiFailure catch (error) {
    if (error.code == 'DECISION_COLLECTION_CHANGED') return null;
    rethrow;
  }
}

enum DecisionEvidenceQuality { reviewable, unknown, unsafe }

/// The backend rejects non-accepted segments and overlapping non-covered
/// regions. Absence of a coverage map is not evidence of complete coverage.
DecisionEvidenceQuality decisionEvidenceQuality(
  TranscriptReviewProjection? projection,
  SpeechSegment segment,
) {
  final coverage = projection?.coverage;
  if (segment.quality != 'ACCEPTED' ||
      (coverage?.regions.any(
            (region) =>
                region.status != 'COVERED' &&
                region.startMs < segment.endMs &&
                region.endMs > segment.startMs,
          ) ??
          false)) {
    return DecisionEvidenceQuality.unsafe;
  }
  if (coverage == null) return DecisionEvidenceQuality.unknown;

  // Covered regions must collectively span the segment. A partial overlap
  // or an intervening gap is unknown, not verified coverage. This is a
  // presentation distinction; the backend still owns confirmation eligibility.
  final overlapping =
      coverage.regions
          .where(
            (region) =>
                region.startMs < segment.endMs &&
                region.endMs > segment.startMs,
          )
          .toList()
        ..sort((a, b) => a.startMs.compareTo(b.startMs));
  var coveredUntil = segment.startMs;
  for (final region in overlapping) {
    if (region.startMs > coveredUntil) {
      return DecisionEvidenceQuality.unknown;
    }
    if (region.endMs > coveredUntil) coveredUntil = region.endMs;
    if (coveredUntil >= segment.endMs) {
      return DecisionEvidenceQuality.reviewable;
    }
  }
  return DecisionEvidenceQuality.unknown;
}

/// A review is bound to the decision's recorded source, never substituted by
/// the current transcript just because the segment text still looks similar.
class DecisionEvidenceReview {
  const DecisionEvidenceReview(this.decision, this.projection);

  final MeetingDecision decision;
  final TranscriptReviewProjection? projection;

  bool get hasCompatibleSource {
    final transcript = projection?.transcript;
    return transcript != null &&
        decision.transcriptId == transcript.id &&
        decision.contentRevision == transcript.contentRevision;
  }

  SpeechSegment? segment(String id) => hasCompatibleSource
      ? projection!.transcript.segments
            .where((segment) => segment.id == id)
            .firstOrNull
      : null;

  DecisionEvidenceQuality quality(SpeechSegment segment) =>
      decisionEvidenceQuality(projection, segment);

  bool isUnsafe(SpeechSegment segment) =>
      projection?.coverage == null ||
      quality(segment) == DecisionEvidenceQuality.unsafe;

  bool get canConfirm {
    if (decision.status != 'PROPOSED' || decision.stale) return false;
    if (decision.transcriptId == null) {
      return decision.sourceType != null &&
          decision.sourceType != 'AI_EXTRACTED' &&
          decision.evidenceSegmentIds.isEmpty;
    }
    if (!hasCompatibleSource ||
        !const {
          'READY',
          'READY_WITH_WARNINGS',
        }.contains(projection!.transcript.status) ||
        decision.evidenceSegmentIds.isEmpty ||
        decision.evidenceSegmentIds.length > 50 ||
        decision.evidenceSegmentIds.toSet().length !=
            decision.evidenceSegmentIds.length) {
      return false;
    }
    return decision.evidenceSegmentIds.every((id) {
      final value = segment(id);
      return value != null && !isUnsafe(value);
    });
  }
}
