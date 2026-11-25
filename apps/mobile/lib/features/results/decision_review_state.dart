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

  bool isUnsafe(SpeechSegment segment) {
    final coverage = projection?.coverage;
    return segment.quality != 'ACCEPTED' ||
        coverage == null ||
        coverage.regions.any(
          (region) =>
              region.status != 'COVERED' &&
              region.startMs < segment.endMs &&
              region.endMs > segment.startMs,
        );
  }

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
