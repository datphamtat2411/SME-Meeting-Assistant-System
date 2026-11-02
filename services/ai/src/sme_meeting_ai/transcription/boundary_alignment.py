"""Read-only temporal supports, never forced alignment or lexical reconciliation.

All intervals are absolute source samples. A segment remains one provider segment
even when it spans multiple cores; ownership intersections below are metadata,
not synthetic transcript segments. No candidate wording enters these records.
"""

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from enum import StrEnum
from fractions import Fraction

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import SampleInterval

from .asr import AsrError, AsrErrorCategory, AsrWord
from .chunk_execution import AsrChunkResult, AsrTimelineSegment, _translate_candidate
from .chunk_planning import (
    AsrChunkPlan,
    ChunkBoundaryReason,
    _require,
    validate_asr_chunk_plan,
)


class BoundaryRisk(StrEnum):
    NATURAL_CANDIDATE = "natural-candidate"
    FORCED_CONTINUOUS_SPEECH = "forced-continuous-speech"
    INCOMPLETE_EVIDENCE = "incomplete-evidence"


class WordTimingObservation(StrEnum):
    UNAVAILABLE = "unavailable"
    PROVIDER_REPORTED = "provider-reported"


@dataclass(frozen=True)
class BoundarySegmentSupport:
    chunk_id: str
    segment_ordinal: int
    interval: SampleInterval
    request_interval: SampleInterval
    core_interval: SampleInterval
    core_owned_interval: SampleInterval | None
    crosses_core_boundary: bool
    word_timing: WordTimingObservation


@dataclass(frozen=True)
class BoundaryEvidence:
    boundary_sample: int
    left_chunk_id: str
    right_chunk_id: str
    boundary_reason: ChunkBoundaryReason
    left_context_samples: int
    right_context_samples: int
    boundary_risk: BoundaryRisk
    left_evidence_count: int
    right_evidence_count: int
    segments_crossing_boundary: int
    segments_ending_near_boundary: int
    overlapping_evidence_samples: int
    requires_reconciliation_review: bool


@dataclass(frozen=True)
class BoundaryAlignmentMetrics:
    planner_version: str
    source_sample_count: int
    planned_chunk_count: int
    natural_boundary_count: int
    forced_boundary_count: int
    protected_boundary_count: int
    uncertain_boundary_count: int
    total_requested_samples: int
    total_core_samples: int
    total_context_samples: int
    total_adjacent_overlap_samples: int
    maximum_request_samples: int
    minimum_core_samples: int
    maximum_core_samples: int
    boundary_crossing_segment_count: int
    boundary_overlap_evidence_samples: int
    incomplete_boundary_count: int


@dataclass(frozen=True)
class BoundaryAlignmentReport:
    alignment_version: str
    boundaries: tuple[BoundaryEvidence, ...]
    segment_supports: tuple[BoundarySegmentSupport, ...]
    metrics: BoundaryAlignmentMetrics


def _union_length(intervals):
    """Union, not the sum of multiplicities; input is ordered by start."""
    total = end = 0
    for start, stop in intervals:
        if start < stop:
            total += max(0, stop - max(start, end))
            end = max(end, stop)
    return total


def _overlap_intervals(left, right, lower, upper):
    intervals = []
    i = j = 0
    while i < len(left) and j < len(right):
        a, b = left[i].interval, right[j].interval
        start, end = max(lower, a.start_sample, b.start_sample), min(upper, a.end_sample, b.end_sample)
        if start < end:
            intervals.append((start, end))
        if a.end_sample <= b.end_sample:
            i += 1
        else:
            j += 1
    return intervals


class _SupportIndex:
    def __init__(self, supports):
        self.supports = tuple(supports)
        self.starts = tuple(s.interval.start_sample for s in supports)
        self.ends = tuple(s.interval.end_sample for s in supports)

    def near(self, lower, upper):
        # Endpoint contact is a boundary observation, not positive sample overlap.
        return self.supports[bisect_left(self.ends, lower):bisect_right(self.starts, upper)]


def _word_observation(candidate, duration):
    if candidate.words is None or candidate.words == ():
        return WordTimingObservation.UNAVAILABLE
    _require(isinstance(candidate.words, tuple))
    previous = Fraction(0)
    previous_sample = 0
    for word in candidate.words:
        _require(isinstance(word, AsrWord) and isinstance(word.text, str)
                 and isinstance(word.start, Fraction) and isinstance(word.end, Fraction)
                 and previous <= word.start < word.end <= duration)
        start, end = round(word.start * 16000), round(word.end * 16000)
        _require(previous_sample <= start < end <= round(duration * 16000))
        previous, previous_sample = word.end, end
    return WordTimingObservation.PROVIDER_REPORTED


def _collect(plan, results, boundary_samples):
    _require(isinstance(results, tuple) and len(results) <= len(plan.chunks))
    chunks = {c.chunk_id: c for c in plan.chunks}
    by_id, supports = {}, []
    for result in results:
        _require(isinstance(result, AsrChunkResult))
        chunk = result.chunk
        _require(chunk.chunk_id in chunks and chunk == chunks[chunk.chunk_id] and chunk.chunk_id not in by_id)
        local = []
        if result.failure is not None:
            _require(isinstance(result.failure, AsrErrorCategory) and result.candidate is None
                     and result.timeline_segments == ())
        else:
            translated = _translate_candidate(result.candidate, chunk)
            _require(isinstance(result.timeline_segments, tuple) and translated == result.timeline_segments)
            word_timing = _word_observation(result.candidate, chunk.request_interval.duration)
            for ordinal, item in enumerate(result.timeline_segments):
                _require(isinstance(item, AsrTimelineSegment) and isinstance(item.interval, SampleInterval))
                interval = item.interval
                _require(type(interval.start_sample) is int and type(interval.end_sample) is int
                         and chunk.request_interval.start_sample <= interval.start_sample < interval.end_sample
                         <= chunk.request_interval.end_sample)
                a, b = max(interval.start_sample, chunk.core_interval.start_sample), min(
                    interval.end_sample, chunk.core_interval.end_sample,
                )
                crossing = bisect_right(boundary_samples, interval.start_sample) < bisect_left(
                    boundary_samples, interval.end_sample,
                )
                local.append(BoundarySegmentSupport(
                    chunk.chunk_id, ordinal, interval, chunk.request_interval, chunk.core_interval,
                    SampleInterval(a, b) if a < b else None, crossing, word_timing,
                ))
        by_id[chunk.chunk_id] = _SupportIndex(local)
    # Stable plan/segment order regardless of result arrival order.
    for chunk in plan.chunks:
        index = by_id.setdefault(chunk.chunk_id, _SupportIndex(()))
        supports.extend(index.supports)
    return by_id, tuple(supports)


def _analyze(plan, results):
    validate_asr_chunk_plan(plan)
    _require(plan.provenance.planner_version in ("speech-aware-v2", "speech-aware-v3"))
    boundary_samples = tuple(c.core_interval.end_sample for c in plan.chunks[:-1])
    by_id, supports = _collect(plan, results, boundary_samples)
    boundaries, temporal_overlaps, request_overlaps = [], [], []
    for left, right in zip(plan.chunks, plan.chunks[1:]):
        boundary = left.core_interval.end_sample
        lower = max(left.request_interval.start_sample, right.request_interval.start_sample)
        upper = min(left.request_interval.end_sample, right.request_interval.end_sample)
        request_overlaps.append((lower, upper))
        left_support = by_id[left.chunk_id].near(lower, upper)
        right_support = by_id[right.chunk_id].near(lower, upper)
        incomplete = not all(any(s.interval.start_sample <= boundary <= s.interval.end_sample for s in side)
                             for side in (left_support, right_support))
        overlaps = _overlap_intervals(left_support, right_support, lower, upper)
        temporal_overlaps.extend(overlaps)
        reason = left.end_boundary_reason
        risk = (BoundaryRisk.INCOMPLETE_EVIDENCE if incomplete else
                BoundaryRisk.NATURAL_CANDIDATE if reason in (
                    ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE, ChunkBoundaryReason.SPEECH_RESUMPTION,
                )
                else BoundaryRisk.FORCED_CONTINUOUS_SPEECH)
        both = (*left_support, *right_support)
        crossing = sum(s.interval.start_sample < boundary < s.interval.end_sample for s in both)
        ending = sum(lower <= s.interval.end_sample <= upper for s in both)
        overlapping = _union_length(overlaps)
        boundaries.append(BoundaryEvidence(
            boundary, left.chunk_id, right.chunk_id, reason,
            boundary - lower, upper - boundary, risk, len(left_support), len(right_support),
            crossing, ending, overlapping,
            incomplete or reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH or bool(crossing or overlapping),
        ))
    requests = tuple(c.request_interval.end_sample - c.request_interval.start_sample for c in plan.chunks)
    cores = tuple(c.core_interval.end_sample - c.core_interval.start_sample for c in plan.chunks)
    metrics = BoundaryAlignmentMetrics(
        plan.provenance.planner_version, plan.sample_count, len(plan.chunks),
        sum(b.reason in (ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE, ChunkBoundaryReason.SPEECH_RESUMPTION)
            for b in plan.boundary_decisions),
        sum(b.reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH for b in plan.boundary_decisions),
        sum(b.protected for b in plan.boundary_decisions), sum(b.uncertain for b in plan.boundary_decisions),
        sum(requests), sum(cores), sum(requests) - plan.sample_count, _union_length(sorted(request_overlaps)),
        max(requests), min(cores), max(cores), sum(s.crosses_core_boundary for s in supports),
        _union_length(sorted(temporal_overlaps)),
        sum(b.boundary_risk is BoundaryRisk.INCOMPLETE_EVIDENCE for b in boundaries),
    )
    return BoundaryAlignmentReport("boundary-alignment-v2", tuple(boundaries), supports, metrics)


def analyze_boundary_alignment(
    plan: AsrChunkPlan, results: tuple[AsrChunkResult, ...],
) -> BoundaryAlignmentReport:
    """Reject invalid timing; missing/failed evidence stays explicitly incomplete.

    Counts refer to timestamped segments, not utterances or recognized words.
    Near-boundary endpoints use the actual adjacent request intersection, inclusive
    for endpoint observations only. Completeness means both sides have a segment
    touching the boundary, never verified acoustic coverage or word completeness.
    Optional words are validated and reported available, never used to retime text.
    """
    category = "VALIDATION"
    try:
        return _analyze(plan, results)
    except MemoryError:
        category = "RESOURCE"
    except (AudioProcessingError, AsrError, AttributeError, TypeError, ValueError, KeyError, OverflowError):
        pass
    raise AudioProcessingError(category)
