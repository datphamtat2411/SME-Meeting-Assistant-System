"""Evidence-separated Coverage V2 on the unchanged 16 kHz half-open timeline.

Independent acoustic, raw hypothesis and selected canonical support streams precede
state derivation. Temporal wording support NEVER verifies lexical completeness.
Recovery consumes only PRE_CANONICAL state counts; FINAL_CANONICAL requires T05
selected evidence. Borrowed wording/audio never enters the immutable output.
"""

import math
import traceback
from bisect import bisect_left, bisect_right
from collections import defaultdict
from concurrent.futures import CancelledError
from dataclasses import dataclass, field, replace
from enum import StrEnum
from fractions import Fraction
from types import MappingProxyType
from typing import TYPE_CHECKING, Mapping

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import SampleInterval, VadLabel
from sme_meeting_ai.audio.speech_map import (
    _append_interval,
    _validate_contracts,
    _validate_frame,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import PreprocessingResult

from .asr import (
    AsrCandidate,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegmentQuality,
)
from .chunk_execution import AsrChunkResult, AsrTimelineSegment, _translate_candidate
from .chunk_planning import (
    AsrChunk,
    AsrChunkPlan,
    ChunkPlanningProvenance,
    _validate_handoff,
    validate_asr_chunk_plan,
)

if TYPE_CHECKING:
    from .reconciliation import TranscriptReconciliation

_MAX_SEGMENTS = 262144
_MAX_REFERENCES = 1048576
_MAX_ACTIVE = 256
_MAX_EVENTS = 4194304


class CoveragePhase(StrEnum):
    PRE_CANONICAL = "pre-canonical"
    FINAL_CANONICAL = "final-canonical"


class AcousticEvidenceState(StrEnum):
    LIKELY_SPEECH = "likely-speech"
    LIKELY_NON_SPEECH = "likely-non-speech"
    ACOUSTICALLY_UNCERTAIN = "acoustically-uncertain"


@dataclass(frozen=True, slots=True)
class CoverageEvidence:
    acoustic_state: AcousticEvidenceState
    raw_asr_support_count: int
    canonical_support_count: int
    has_raw_text_support: bool
    has_canonical_text_support: bool
    has_conflicting_hypotheses: bool
    has_ambiguous_alignment: bool
    weak_speech: bool = False
    high_energy_non_speech: bool = False
    vad_energy_disagreement: bool = False
    protected_only: bool = False
    # Segment timestamps cannot establish this, even with optional word evidence.
    lexical_completeness_verified: bool = field(default=False, init=False)


class CoverageState(StrEnum):
    COVERED = "COVERED"
    SUSPICIOUS = "SUSPICIOUS"
    UNRESOLVED_ERROR = "UNRESOLVED_ERROR"


class CoverageReason(StrEnum):
    MISSING_SPEECH = "missing-speech"
    FAILED_CHUNK = "failed-chunk"
    MALFORMED_CHUNK = "malformed-chunk"
    MISSING_CHUNK_RESULT = "missing-chunk-result"
    UNCERTAIN_VAD = "uncertain-vad"
    NON_SPEECH_VAD = "non-speech-vad"
    PROTECTED_ONLY = "protected-only"
    UNSUPPORTED_CANDIDATE = "unsupported-candidate"
    MISSING_TEXT_SUPPORT = "missing-text-support"
    REPEATED_NON_OVERLAP_TEXT = "repeated-non-overlap-text"
    LOW_CONFIDENCE = "low-confidence"
    WEAK_SPEECH = "weak-speech"
    HIGH_ENERGY_NON_SPEECH = "high-energy-non-speech"
    VAD_ENERGY_DISAGREEMENT = "vad-energy-disagreement"
    NEIGHBORING_GAP = "neighboring-gap"
    DUPLICATE_OVERLAP = "duplicate-overlap"
    TOLERATED_MAP_ARTIFACT = "tolerated-map-artifact"
    MISSING_CANONICAL_TEXT = "missing-canonical-text"
    RAW_ONLY_SUPPORT = "raw-only-support"
    CANONICAL_CONFLICT = "canonical-conflict"
    AMBIGUOUS_RECONCILIATION = "ambiguous-reconciliation"
    CANONICAL_ACOUSTIC_DISAGREEMENT = "canonical-acoustic-disagreement"


@dataclass(frozen=True)
class TranscriptCoverageInterval:
    """Deduplicated timestamp union, with support metadata rather than raw text."""

    interval: SampleInterval
    supporting_chunk_ids: tuple[str, ...]
    evidence_count: int
    duplicate_count: int
    has_text_support: bool
    text_support_count: int


@dataclass(frozen=True)
class CoverageRegion:
    interval: SampleInterval
    state: CoverageState
    reasons: tuple[CoverageReason, ...]
    supporting_chunk_ids: tuple[str, ...]
    error_chunk_ids: tuple[str, ...]
    evidence_count: int
    duplicate_count: int
    text_support_count: int
    likely_speech_samples: int
    protected_samples: int
    uncertain_samples: int
    evidence: CoverageEvidence | None = None


@dataclass(frozen=True)
class CoverageQuality:
    """Exact, union-based sample counts; speech states partition likely speech.

    Duplicate samples count positions with multiple timestamp supports, not the
    sum of repeated evidence durations. Reason counts can overlap each other.
    Legacy state counts partition likely speech under the recorded phase; only
    PRE_CANONICAL counts are Recovery progress. V2 canonical metrics are undefined
    (None) before selection. V2 rates with no speech denominator are also None.
    All other observation categories overlap and must not be summed as partitions.
    """

    sample_count: int
    chunk_count: int
    likely_speech_samples: int
    covered_speech_samples: int
    suspicious_speech_samples: int
    unresolved_speech_samples: int
    unsupported_candidate_samples: int
    duplicate_coverage_samples: int
    tolerated_map_artifact_samples: int
    failed_chunk_count: int
    malformed_chunk_count: int
    missing_chunk_count: int
    reason_sample_counts: Mapping[CoverageReason, int]
    uncertain_acoustic_samples: int = 0
    protected_only_samples: int = 0
    raw_timestamp_supported_samples: int = 0
    raw_text_supported_samples: int = 0
    raw_empty_or_untimed_samples: int = 0
    likely_speech_with_raw_text_samples: int = 0
    duplicate_raw_hypothesis_samples: int = 0
    failed_request_region_samples: int = 0
    unresolved_risk_samples: int = 0
    canonical_text_supported_samples: int | None = None
    likely_speech_with_canonical_text_samples: int | None = None
    likely_speech_without_canonical_text_samples: int | None = None
    uncertain_acoustic_with_canonical_support_samples: int | None = None
    raw_only_support_samples: int | None = None
    unsupported_canonical_text_samples: int | None = None
    conflicting_canonical_samples: int | None = None
    ambiguous_canonical_samples: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "reason_sample_counts", MappingProxyType(dict(self.reason_sample_counts)))

    @property
    def covered_speech_rate(self) -> Fraction:
        return Fraction(self.covered_speech_samples, self.likely_speech_samples or 1)

    @property
    def suspicious_speech_rate(self) -> Fraction:
        return Fraction(self.suspicious_speech_samples, self.likely_speech_samples or 1)

    @property
    def unresolved_speech_rate(self) -> Fraction:
        return Fraction(self.unresolved_speech_samples, self.likely_speech_samples or 1)

    @property
    def likely_speech_rate(self) -> Fraction:
        return Fraction(self.likely_speech_samples, self.sample_count)

    @property
    def unsupported_candidate_rate(self) -> Fraction:
        return Fraction(self.unsupported_candidate_samples, self.sample_count)

    @property
    def duplicate_coverage_rate(self) -> Fraction:
        return Fraction(self.duplicate_coverage_samples, self.sample_count)

    @property
    def failed_chunk_rate(self) -> Fraction:
        return Fraction(self.failed_chunk_count, self.chunk_count)

    @property
    def malformed_chunk_rate(self) -> Fraction:
        return Fraction(self.malformed_chunk_count, self.chunk_count)

    @property
    def missing_chunk_rate(self) -> Fraction:
        return Fraction(self.missing_chunk_count, self.chunk_count)

    @property
    def reason_sample_rates(self) -> Mapping[CoverageReason, Fraction]:
        return MappingProxyType({reason: Fraction(count, self.sample_count)
                                  for reason, count in self.reason_sample_counts.items()})

    @property
    def canonical_speech_support_rate(self) -> Fraction | None:
        if not self.likely_speech_samples or self.likely_speech_with_canonical_text_samples is None:
            return None
        return Fraction(self.likely_speech_with_canonical_text_samples, self.likely_speech_samples)


@dataclass(frozen=True)
class CoverageProvenance:
    assessor_version: str
    planning: ChunkPlanningProvenance
    effective_configuration: Mapping[str, int | float]
    asr: tuple[tuple[str, AsrProvenance], ...]
    assessment_phase: CoveragePhase = CoveragePhase.PRE_CANONICAL
    sample_rate_hz: int = field(default=16000, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "planning", replace(self.planning))
        object.__setattr__(self, "effective_configuration", MappingProxyType(dict(self.effective_configuration)))
        object.__setattr__(self, "asr", tuple(self.asr))


@dataclass(frozen=True)
class SpeechCoverageAssessment:
    source_id: str
    sample_count: int
    transcript_coverage: tuple[TranscriptCoverageInterval, ...]
    regions: tuple[CoverageRegion, ...]
    unresolved_intervals: tuple[SampleInterval, ...]
    quality: CoverageQuality
    provenance: CoverageProvenance
    sample_rate_hz: int = field(default=16000, init=False)


def _require(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("VALIDATION")


def _resource(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("RESOURCE")


def _configuration(settings: Settings) -> dict[str, int | float]:
    _require(isinstance(settings, Settings))
    gap = settings.audio_asr_coverage_max_tolerated_speech_map_gap_samples
    repetition = settings.audio_asr_coverage_repetition_min_chars
    confidence = settings.audio_asr_coverage_low_confidence_threshold
    _require(type(gap) is int and 0 <= gap <= 230400000)
    _require(type(repetition) is int and 1 <= repetition <= 65536)
    _require(type(confidence) in (float, int) and math.isfinite(confidence) and 0 <= confidence <= 1)
    return {"max_tolerated_speech_map_gap_samples": gap,
            "repetition_min_chars": repetition, "low_confidence_threshold": confidence,
            "max_segments": _MAX_SEGMENTS, "max_references": _MAX_REFERENCES,
            "max_active_supports": _MAX_ACTIVE, "max_events": _MAX_EVENTS}


def _confidence(value: float | None) -> bool:
    return value is None or (type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1)


def _valid_asr_provenance(provenance: AsrProvenance) -> bool:
    if not isinstance(provenance, AsrProvenance):
        return False
    if not all(isinstance(value, str) and 0 < len(value) <= 256 for value in (
        provenance.provider, provenance.requested_model,
    )):
        return False
    if not all(value is None or (isinstance(value, str) and 0 < len(value) <= 256)
               for value in (provenance.resolved_model, provenance.upstream_provider)):
        return False
    return isinstance(provenance.inference_config, tuple) and all(
        isinstance(item, tuple) and len(item) == 2 and isinstance(item[0], str)
        and (isinstance(item[1], str) or (type(item[1]) in (int, float) and math.isfinite(item[1])))
        for item in provenance.inference_config
    )


def _valid_result(result: AsrChunkResult) -> bool:
    """Validate a chunk locally. No clipping, partial salvage, or timestamp repair."""
    try:
        from .reconciliation import _quality, _safe_provenance, _words

        candidate = result.candidate
        translated = _translate_candidate(candidate, result.chunk)
        _require(isinstance(result.timeline_segments, tuple))
        for item in result.timeline_segments:
            _require(isinstance(item, AsrTimelineSegment) and isinstance(item.interval, SampleInterval))
            interval = item.interval
            _require(type(interval.start_sample) is int and type(interval.end_sample) is int
                     and 0 <= interval.start_sample < interval.end_sample)
        _require(translated == result.timeline_segments)
        _require(isinstance(candidate.quality, AsrQualityMetadata) and _confidence(candidate.quality.confidence))
        _require(_valid_asr_provenance(candidate.provenance))
        _safe_provenance(candidate.provenance)
        # Reuse T05's structural validator only: words do not create support.
        _words(candidate, result.chunk)
        for item in translated:
            _require(isinstance(item.segment.quality, AsrSegmentQuality)
                      and _confidence(item.segment.quality.confidence))
            _quality(item.segment.quality)
        return True
    except (AsrError, AudioProcessingError, AttributeError, TypeError, ValueError, OverflowError):
        return False


@dataclass(frozen=True)
class _Support:
    interval: SampleInterval
    chunk_id: str
    has_text: bool
    low_confidence: bool
    repeated: bool = False


def _collect_results(plan, results, configuration):
    """Use text transiently for support/repetition; return only text-free evidence."""
    by_id = {item.chunk.chunk_id: item for item in results}
    supports = []
    failures = []
    provenance = []
    empty = []
    text_groups = defaultdict(list)
    observed = words = characters = 0
    for chunk in plan.chunks:
        item = by_id.get(chunk.chunk_id)
        if item is None:
            failures.append((chunk.request_interval, CoverageReason.MISSING_CHUNK_RESULT, chunk.chunk_id))
            continue
        if item.failure is not None:
            valid_failure = (isinstance(item.failure, AsrErrorCategory)
                             and item.candidate is None and item.timeline_segments == ())
            reason = (CoverageReason.FAILED_CHUNK if valid_failure
                      and item.failure is not AsrErrorCategory.MALFORMED_OUTPUT
                      else CoverageReason.MALFORMED_CHUNK)
            failures.append((chunk.request_interval, reason, chunk.chunk_id))
            continue
        candidate = item.candidate
        if isinstance(candidate, AsrCandidate) and isinstance(candidate.segments, tuple):
            observed += len(candidate.segments)
            words += len(candidate.words) if isinstance(candidate.words, tuple) else 0
            _resource(observed <= _MAX_SEGMENTS and words <= _MAX_REFERENCES)
            characters += sum(len(s.text) for s in candidate.segments if isinstance(getattr(s, "text", None), str))
            _resource(characters <= 8388608)
        if not _valid_result(item):
            failures.append((chunk.request_interval, CoverageReason.MALFORMED_CHUNK, chunk.chunk_id))
            continue
        candidate = item.candidate
        # Copy only the normalized inference settings, never arbitrary provider
        # metadata (which can include prompts or sensitive diagnostics).
        from .reconciliation import _safe_provenance

        provenance.append((chunk.chunk_id, _safe_provenance(candidate.provenance)))
        if not item.timeline_segments:
            empty.append(chunk.request_interval)
        for timeline in item.timeline_segments:
            segment = timeline.segment
            text = " ".join(segment.text.casefold().split())
            confidence = segment.quality.confidence
            if confidence is None:
                confidence = candidate.quality.confidence
            index = len(supports)
            supports.append(_Support(
                timeline.interval, chunk.chunk_id, bool(text),
                confidence is not None and confidence < configuration["low_confidence_threshold"],
            ))
            if not text:
                empty.append(timeline.interval)
            if len(text) >= configuration["repetition_min_chars"]:
                text_groups[text].append(index)
    for indexes in text_groups.values():
        if len(indexes) < 2:
            continue
        first_end = min(supports[i].interval.end_sample for i in indexes)
        last_start = max(supports[i].interval.start_sample for i in indexes)
        for index in indexes:
            support = supports[index]
            if first_end <= support.interval.start_sample or last_start >= support.interval.end_sample:
                supports[index] = replace(support, repeated=True)
    return supports, failures, tuple(provenance), tuple(empty)


def _replay_indicators(preprocessing):
    audio, evidence = preprocessing.normalized_artifact, preprocessing.speech_evidence
    frame_samples, speech_threshold, non_speech_threshold = _validate_contracts(audio, evidence)
    floor = preprocessing.speech_map.provenance.effective_configuration["energy_floor_dbfs"]
    indicators = {reason: [] for reason in (
        CoverageReason.UNCERTAIN_VAD, CoverageReason.WEAK_SPEECH, CoverageReason.HIGH_ENERGY_NON_SPEECH,
        CoverageReason.NON_SPEECH_VAD,
    )}
    counts = dict.fromkeys(VadLabel, 0)
    weak = high = position = 0
    for frame in evidence.iter_frames():
        _require(sum(counts.values()) < evidence.frame_count)
        _validate_frame(frame, position, audio.sample_count, frame_samples, speech_threshold, non_speech_threshold)
        position = frame.end_sample
        counts[frame.vad_label] += 1
        if frame.vad_label is VadLabel.LIKELY_NON_SPEECH:
            _append_interval(indicators[CoverageReason.NON_SPEECH_VAD], frame.start_sample, frame.end_sample)
        reason = None
        if frame.vad_label is VadLabel.UNCERTAIN:
            reason = CoverageReason.UNCERTAIN_VAD
        elif frame.vad_label is VadLabel.LIKELY_SPEECH and frame.dbfs < floor:
            reason = CoverageReason.WEAK_SPEECH
            weak += 1
        elif frame.vad_label is VadLabel.LIKELY_NON_SPEECH and frame.dbfs >= floor:
            reason = CoverageReason.HIGH_ENERGY_NON_SPEECH
            high += 1
        if reason is not None:
            _append_interval(indicators[reason], frame.start_sample, frame.end_sample)
    quality = preprocessing.speech_map.quality
    _require(position == audio.sample_count and sum(counts.values()) == evidence.frame_count
             and counts[VadLabel.LIKELY_SPEECH] == evidence.likely_speech_frame_count
             and counts[VadLabel.LIKELY_NON_SPEECH] == evidence.likely_non_speech_frame_count
             and counts[VadLabel.UNCERTAIN] == evidence.uncertain_frame_count
             and weak == quality.weak_speech_frame_count and high == quality.high_energy_non_speech_frame_count)
    return indicators


def _tolerated_gaps(speech_map, indicators, maximum):
    if not maximum:
        return ()
    # A gap must be flanked by speech-map intervals, never at a recording edge.
    # Both published uncertainty and replayed uncertainty/disagreement block it.
    blocked = sorted((*speech_map.uncertain_intervals,
                      *(i for reason, values in indicators.items()
                        if reason is not CoverageReason.NON_SPEECH_VAD for i in values)),
                     key=lambda i: i.start_sample)
    gaps = []
    blocked_index = 0
    for left, right in zip(speech_map.speech_intervals, speech_map.speech_intervals[1:]):
        start, end = left.end_sample, right.start_sample
        while blocked_index < len(blocked) and blocked[blocked_index].end_sample <= start:
            blocked_index += 1
        if (end - start <= maximum and
                (blocked_index == len(blocked) or blocked[blocked_index].start_sample >= end)):
            gaps.append(SampleInterval(start, end))
    return tuple(gaps)


def _append_map(coverage, interval):
    if coverage:
        previous = coverage[-1]
        if (previous.interval.end_sample == interval.interval.start_sample
                and replace(previous, interval=interval.interval) == interval):
            coverage[-1] = replace(previous, interval=SampleInterval(
                previous.interval.start_sample, interval.interval.end_sample,
            ))
            return
    coverage.append(interval)


def _append_region(regions, region):
    if regions:
        previous = regions[-1]
        # Sample metrics are additive; evidence multiplicity is not.
        metrics = ("likely_speech_samples", "protected_samples", "uncertain_samples")
        comparable = replace(previous, interval=region.interval,
                             **{name: getattr(region, name) for name in metrics})
        # Keep boundaries where the kinds of acoustic evidence change, even when
        # the state/reasons happen to match.
        if (previous.interval.end_sample == region.interval.start_sample and comparable == region
                and all(bool(getattr(previous, name)) == bool(getattr(region, name)) for name in metrics)):
            regions[-1] = replace(previous, interval=SampleInterval(
                previous.interval.start_sample, region.interval.end_sample,
            ), **{name: getattr(previous, name) + getattr(region, name) for name in metrics})
            return
    regions.append(region)


def _canonical_streams(reconciliation, plan, results, asr):
    """Cross-stage consistency, not another lexical reconciliation algorithm.

    The private identity index is borrowed only here. The return value contains
    intervals/IDs/enum observations, never selected or alternative wording.
    """
    from .reconciliation import (
        OccurrenceRelationship,
        ReconciledSegment,
        ReconciliationEvidenceIdentity,
        ReconciliationFlag,
        ReconciliationProvenance,
        ReconciliationRelationship,
        TranscriptReconciliation,
        _unresolved,
        _valid_interval,
    )

    _require(isinstance(reconciliation, TranscriptReconciliation)
             and reconciliation.source_id == plan.source_id
             and type(reconciliation.sample_count) is int and reconciliation.sample_count == plan.sample_count
             and reconciliation.sample_rate_hz == 16000)
    provenance = reconciliation.provenance
    _require(isinstance(provenance, ReconciliationProvenance) and provenance.reconciler_version == "2"
             and provenance.sample_rate_hz == 16000 and provenance.planning == plan.provenance)
    planned_ids = {c.chunk_id for c in plan.chunks}
    extras = sorted((r.chunk for r in results if r.chunk.chunk_id not in planned_ids),
                    key=lambda c: (c.ordinal, c.chunk_id))
    _require(provenance.source_chunks == (*plan.chunks, *extras) and provenance.asr == asr)
    valid_ids = {identity for identity, _ in asr}
    observed = {(r.chunk.chunk_id, index): t for r in results if r.chunk.chunk_id in valid_ids
                for index, t in enumerate(r.timeline_segments) if t.segment.text.strip()}
    references = 0

    def identities(values):
        nonlocal references
        _require(isinstance(values, tuple))
        references += len(values)
        _resource(references <= _MAX_REFERENCES)
        seen = set()
        for identity in values:
            _require(isinstance(identity, ReconciliationEvidenceIdentity)
                     and isinstance(identity.chunk_id, str) and type(identity.segment_index) is int
                     and _valid_interval(identity.interval, plan.sample_count))
            key = (identity.chunk_id, identity.segment_index)
            _require(key in observed and observed[key].interval == identity.interval and identity not in seen)
            seen.add(identity)
        return seen

    _require(isinstance(reconciliation.relationships, tuple))
    _resource(len(reconciliation.relationships) <= _MAX_REFERENCES)
    conflicts, ambiguous, conflict_ids, duplicate_ids = [], [], set(), set()
    established = defaultdict(list)
    for relationship in reconciliation.relationships:
        _require(isinstance(relationship, ReconciliationRelationship)
                 and isinstance(relationship.classification, OccurrenceRelationship))
        left, right = identities(relationship.left), identities(relationship.right)
        _require(bool(left) and bool(right) and not left.intersection(right))
        for path in (relationship.left, relationship.right):
            _require(len({i.chunk_id for i in path}) == 1
                     and all(a.segment_index < b.segment_index and a.interval.end_sample <= b.interval.start_sample
                             for a, b in zip(path, path[1:])))
        _require(relationship.left[0].chunk_id != relationship.right[0].chunk_id)
        nodes = left | right
        kind = relationship.classification
        if kind is OccurrenceRelationship.CONFLICTING_HYPOTHESIS:
            conflicts.extend(i.interval for i in nodes)
            conflict_ids.update(nodes)
        elif kind is OccurrenceRelationship.SAME_OCCURRENCE:
            duplicate_ids.update(nodes)
        elif kind in (OccurrenceRelationship.PARTIAL_SUPPORT, OccurrenceRelationship.AMBIGUOUS):
            ambiguous.extend(i.interval for i in nodes)
        if kind in (OccurrenceRelationship.SAME_OCCURRENCE, OccurrenceRelationship.CONFLICTING_HYPOTHESIS):
            for identity in nodes:
                established[identity].append(nodes)

    _require(isinstance(reconciliation.segments, tuple))
    _resource(len(reconciliation.segments) <= _MAX_SEGMENTS)
    canonical, selected, previous = [], set(), None
    for ordinal, segment in enumerate(reconciliation.segments):
        _require(isinstance(segment, ReconciledSegment)
                 and _valid_interval(segment.interval, plan.sample_count)
                 and type(segment.ordinal) is int and segment.ordinal == ordinal
                 and segment.segment_id == f"segment-{ordinal:06d}")
        identity = segment.selected_evidence_id
        identities((identity,))
        support, alternatives = identities(segment.supporting_evidence_ids), identities(segment.alternative_evidence_ids)
        _require(identity not in selected and identity in support and alternatives <= support
                 and identity not in alternatives and segment.interval == identity.interval)
        related = {identity}
        for group in established[identity]:
            references += len(group)
            _resource(references <= _MAX_REFERENCES)
            related.update(group)
        _require(support <= related and alternatives == {i for i in support if i.chunk_id != identity.chunk_id})
        selected.add(identity)
        original = observed[(identity.chunk_id, identity.segment_index)].segment
        _require(isinstance(segment.text, str) and bool(segment.text.strip()) and segment.text == original.text)
        _require(segment.source_chunk_ids == tuple(sorted({i.chunk_id for i in support})))
        key = (segment.interval.start_sample, segment.interval.end_sample,
               segment.source_chunk_ids, identity.segment_index)
        _require(previous is None or previous <= key)
        previous = key
        _require(isinstance(segment.flags, tuple) and len(set(segment.flags)) == len(segment.flags)
                 and all(isinstance(flag, ReconciliationFlag) for flag in segment.flags))
        _require(isinstance(segment.alternatives, tuple) and segment.alternatives == tuple(dict.fromkeys(
            observed[(i.chunk_id, i.segment_index)].segment.text for i in segment.alternative_evidence_ids
            if observed[(i.chunk_id, i.segment_index)].segment.text != segment.text)))
        if ReconciliationFlag.CONFLICTING_OVERLAP in segment.flags:
            _require(bool(alternatives) and bool(support & conflict_ids))
            conflicts.append(segment.interval)
        if ReconciliationFlag.DUPLICATE_OVERLAP in segment.flags:
            _require(bool(alternatives) and bool(support & duplicate_ids))
        if ReconciliationFlag.UNRESOLVED_BOUNDARY in segment.flags:
            ambiguous.append(segment.interval)
        # Operational support IDs identify selected wording only. An unselected
        # recovery alternative must not masquerade as accepted recovered speech.
        canonical.append((segment.interval, (identity.chunk_id,)))
    _require(all(_valid_interval(i, plan.sample_count) for i in reconciliation.unresolved_intervals)
             and reconciliation.unresolved_intervals == _unresolved(plan.sample_count, reconciliation.segments)
             and reconciliation.observations.canonical_segment_count == len(canonical))
    return tuple(canonical), tuple(conflicts), tuple(ambiguous)


def _assess(preprocessing, plan, results, settings, recovery_results=(), reconciliation=None):
    configuration = _configuration(settings)
    _validate_handoff(preprocessing)
    validate_asr_chunk_plan(plan)
    _require(plan.source_id == preprocessing.provenance.source_id
             and plan.sample_count == preprocessing.normalized_artifact.sample_count
             and plan.provenance.preprocessing == preprocessing.provenance
             and plan.sample_count <= 230400000)
    _require(isinstance(results, tuple) and len(results) <= len(plan.chunks))
    planned = {chunk.chunk_id: chunk for chunk in plan.chunks}
    seen = set()
    for item in results:
        _require(isinstance(item, AsrChunkResult))
        _require(isinstance(item.chunk, AsrChunk) and type(item.chunk.ordinal) is int)
        _require(all(isinstance(interval, SampleInterval)
                     and type(interval.start_sample) is int and type(interval.end_sample) is int
                     for interval in (item.chunk.core_interval, item.chunk.request_interval)))
        _require(item.chunk.chunk_id in planned and item.chunk == planned[item.chunk.chunk_id]
                 and item.chunk.chunk_id not in seen)
        seen.add(item.chunk.chunk_id)
    recovery_ids = set()
    _require(isinstance(recovery_results, tuple))
    if recovery_results:
        # Recovery is supplemental evidence, never a replacement partition.
        # Validate the complete handoff; only failure-free, structurally valid
        # candidates contribute support. Failed attempts stay in recovery output.
        from .recovery import _configuration as recovery_configuration
        from .recovery import _validate_recovery_chunk

        limits = recovery_configuration(settings)
        _require(isinstance(recovery_results, tuple)
                 and len(recovery_results) <= limits["max_total_attempts"])
        requests = {c.request_interval for c in plan.chunks}
        ordinals = {c.ordinal for c in plan.chunks}
        for item in recovery_results:
            _require(isinstance(item, AsrChunkResult))
            _validate_recovery_chunk(item.chunk, plan.sample_count, limits)
            chunk = item.chunk
            _require(chunk.chunk_id not in planned and chunk.chunk_id not in recovery_ids
                     and chunk.ordinal >= len(plan.chunks) and chunk.ordinal not in ordinals
                     and chunk.request_interval not in requests)
            recovery_ids.add(chunk.chunk_id)
            ordinals.add(chunk.ordinal)
            requests.add(chunk.request_interval)
    combined = (*results, *recovery_results)
    chunks = (*plan.chunks, *sorted((r.chunk for r in recovery_results), key=lambda c: (c.ordinal, c.chunk_id)))
    supports, failures, asr_provenance, empty = _collect_results(replace(plan, chunks=chunks), combined, configuration)
    final = reconciliation is not None
    if final:
        _require(all(p.provider == "openrouter" and p.requested_model == settings.audio_asr_model
                     == "openai/whisper-large-v3" and all(key != "language" or value == settings.audio_asr_language
                                                         for key, value in p.inference_config)
                     for _, p in asr_provenance))
        canonical, conflicts, ambiguous = _canonical_streams(reconciliation, plan, combined, asr_provenance)
    else:
        canonical, conflicts, ambiguous = (), (), ()
    indicators = _replay_indicators(preprocessing)
    speech_map = preprocessing.speech_map
    tolerated = _tolerated_gaps(speech_map, indicators, configuration["max_tolerated_speech_map_gap_samples"])

    # Independent streams share only exact event boundaries. Every measurement is
    # a union predicate over each elementary interval, never a sum of hypotheses.
    events = defaultdict(list)
    event_count = 0

    def add(interval, kind, identity=None):
        nonlocal event_count
        event_count += 2
        _resource(event_count <= _MAX_EVENTS)
        events[interval.start_sample].append((kind, identity, 1))
        events[interval.end_sample].append((kind, identity, -1))

    for kind, intervals in (("speech", speech_map.speech_intervals),
                            ("protected", speech_map.protected_intervals),
                            ("uncertain", speech_map.uncertain_intervals),
                            (CoverageReason.TOLERATED_MAP_ARTIFACT, tolerated), *indicators.items()):
        for interval in intervals:
            add(interval, kind)
    for index, support in enumerate(supports):
        add(support.interval, "support", index)
    for index, (interval, _) in enumerate(canonical):
        add(interval, "canonical", index)
    for kind, intervals in (("conflict", conflicts), ("ambiguous", ambiguous), ("empty", empty)):
        for interval in intervals:
            add(interval, kind)
    for interval, reason, chunk_id in failures:
        add(interval, reason, chunk_id)
    events[0]
    events[plan.sample_count]
    positions = sorted(events)
    active = set()
    selected = set()
    active_errors = set()
    counts = defaultdict(int)
    coverage, regions = [], []
    measurements = defaultdict(int)
    for start, end in zip(positions, positions[1:]):
        for kind, identity, delta in events[start]:
            if kind in ("support", "canonical"):
                stream = active if kind == "support" else selected
                if delta == 1:
                    stream.add(identity)
                else:
                    stream.remove(identity)
            else:
                counts[kind] += delta
                if identity is not None:
                    if delta == 1:
                        active_errors.add(identity)
                    else:
                        active_errors.remove(identity)
        _resource(len(active) <= _MAX_ACTIVE and len(selected) <= _MAX_ACTIVE)
        likely, protected = bool(counts["speech"]), bool(counts["protected"])
        uncertain = bool(counts["uncertain"] or counts[CoverageReason.UNCERTAIN_VAD]
                         or counts[CoverageReason.HIGH_ENERGY_NON_SPEECH])
        raw_ids = tuple(sorted({supports[i].chunk_id for i in active}))
        chunk_ids = tuple(sorted({identity for i in selected for identity in canonical[i][1]})) if final else raw_ids
        evidence_count = len(active)
        duplicate_count = max(0, evidence_count - 1)
        text_count = sum(supports[i].has_text for i in active)
        canonical_count = len(selected)
        weak = bool(counts[CoverageReason.WEAK_SPEECH])
        high = bool(counts[CoverageReason.HIGH_ENERGY_NON_SPEECH])
        contradiction = weak or high or bool(counts[CoverageReason.NON_SPEECH_VAD])
        acoustic_state = (AcousticEvidenceState.LIKELY_SPEECH
                          if likely and not uncertain and not counts[CoverageReason.NON_SPEECH_VAD]
                          else AcousticEvidenceState.ACOUSTICALLY_UNCERTAIN if uncertain or likely
                          else AcousticEvidenceState.LIKELY_NON_SPEECH)
        evidence = CoverageEvidence(
            acoustic_state, evidence_count, canonical_count, bool(text_count), bool(canonical_count),
            bool(counts["conflict"]), bool(counts["ambiguous"]), weak, high, weak or high,
            protected and not likely,
        )
        length = end - start
        observations = {
            "uncertain_acoustic_samples": acoustic_state is AcousticEvidenceState.ACOUSTICALLY_UNCERTAIN,
            "protected_only_samples": protected and not likely,
            "raw_timestamp_supported_samples": bool(active),
            "raw_text_supported_samples": bool(text_count),
            "raw_empty_or_untimed_samples": bool(counts["empty"]),
            "likely_speech_with_raw_text_samples": likely and bool(text_count),
            "duplicate_raw_hypothesis_samples": evidence_count > 1,
        }
        if final:
            observations.update({
                "canonical_text_supported_samples": bool(canonical_count),
                "likely_speech_with_canonical_text_samples": likely and bool(canonical_count),
                "likely_speech_without_canonical_text_samples": likely and not canonical_count,
                "uncertain_acoustic_with_canonical_support_samples": (
                    acoustic_state is AcousticEvidenceState.ACOUSTICALLY_UNCERTAIN and bool(canonical_count)),
                "raw_only_support_samples": bool(text_count) and not canonical_count,
                "unsupported_canonical_text_samples": bool(canonical_count) and (not likely or uncertain or contradiction),
                "conflicting_canonical_samples": bool(counts["conflict"]),
                "ambiguous_canonical_samples": bool(counts["ambiguous"]),
            })
        for name, present in observations.items():
            measurements[name] += length if present else 0
        interval = SampleInterval(start, end)
        if active:
            _append_map(coverage, TranscriptCoverageInterval(
                interval, raw_ids, evidence_count, duplicate_count, bool(text_count), text_count,
            ))
        reasons = {reason for reason in CoverageReason if counts[reason]}
        if not active and not likely:
            reasons.discard(CoverageReason.NON_SPEECH_VAD)
        failure = any(reason in reasons for reason in (
            CoverageReason.FAILED_CHUNK, CoverageReason.MALFORMED_CHUNK, CoverageReason.MISSING_CHUNK_RESULT,
        ))
        if failure:
            measurements["failed_request_region_samples"] += length
        if not (likely or protected or uncertain or active or selected or failure or reasons):
            continue
        if protected and not likely:
            reasons.add(CoverageReason.PROTECTED_ONLY)
        if active and not likely:
            reasons.add(CoverageReason.UNSUPPORTED_CANDIDATE)
        if active and not text_count:
            reasons.add(CoverageReason.MISSING_TEXT_SUPPORT)
        if likely and not text_count:
            reasons.add(CoverageReason.MISSING_SPEECH)
        if uncertain and not any(reason in reasons for reason in (
            CoverageReason.UNCERTAIN_VAD, CoverageReason.HIGH_ENERGY_NON_SPEECH,
        )):
            reasons.add(CoverageReason.UNCERTAIN_VAD)
        if counts[CoverageReason.WEAK_SPEECH] or counts[CoverageReason.HIGH_ENERGY_NON_SPEECH]:
            reasons.add(CoverageReason.VAD_ENERGY_DISAGREEMENT)
        if duplicate_count:
            reasons.add(CoverageReason.DUPLICATE_OVERLAP)
        if any(supports[i].low_confidence for i in active):
            reasons.add(CoverageReason.LOW_CONFIDENCE)
        if any(supports[i].repeated for i in active):
            reasons.add(CoverageReason.REPEATED_NON_OVERLAP_TEXT)
        # Phase-specific derivation happens AFTER evidence collection. Raw source
        # support cannot substitute for actual canonical selection in FINAL.
        recovery_support = any(supports[i].chunk_id in recovery_ids and supports[i].has_text for i in active)
        baseline_failure = any(identity in planned for identity in active_errors)
        if final:
            if likely and not canonical_count:
                reasons.add(CoverageReason.MISSING_CANONICAL_TEXT)
                reasons.add(CoverageReason.MISSING_SPEECH)
            if text_count and not canonical_count:
                reasons.add(CoverageReason.RAW_ONLY_SUPPORT)
            if evidence.has_conflicting_hypotheses:
                reasons.add(CoverageReason.CANONICAL_CONFLICT)
            if evidence.has_ambiguous_alignment:
                reasons.add(CoverageReason.AMBIGUOUS_RECONCILIATION)
            if canonical_count and (not likely or uncertain or contradiction):
                reasons.add(CoverageReason.CANONICAL_ACOUSTIC_DISAGREEMENT)
                if not likely:
                    reasons.add(CoverageReason.UNSUPPORTED_CANDIDATE)
            if (likely or uncertain or failure) and not canonical_count:
                state = CoverageState.UNRESOLVED_ERROR
            elif (not likely or uncertain or contradiction or evidence.has_conflicting_hypotheses
                  or evidence.has_ambiguous_alignment):
                state = CoverageState.SUSPICIOUS
            else:
                state = CoverageState.COVERED
        elif (baseline_failure and not (likely and recovery_support)) or ((likely or uncertain) and not text_count):
            state = CoverageState.UNRESOLVED_ERROR
        elif (not likely or uncertain or counts[CoverageReason.WEAK_SPEECH]
              or counts[CoverageReason.NON_SPEECH_VAD] or not text_count):
            state = CoverageState.SUSPICIOUS
        else:
            state = CoverageState.COVERED
        _append_region(regions, CoverageRegion(
            interval, state, tuple(reason for reason in CoverageReason if reason in reasons),
            chunk_ids, tuple(sorted(active_errors)), evidence_count, duplicate_count, text_count,
            end - start if likely else 0, end - start if protected else 0,
            end - start if counts["uncertain"] else 0, evidence,
        ))

    # Neighboring chunk gaps are contextual suspicion evidence, not timestamp
    # extension. Keep the omitted speech itself at its exact original bounds.
    core_starts = [chunk.core_interval.start_sample for chunk in plan.chunks]

    def core_ordinals(interval):
        first = bisect_right(core_starts, interval.start_sample) - 1
        stop = bisect_left(core_starts, interval.end_sample)
        return range(first, stop)

    gap_chunks = set()
    for region in regions:
        if CoverageReason.MISSING_SPEECH in region.reasons:
            gap_chunks.update(core_ordinals(region.interval))
    contextual_chunks = set()
    supported_chunks = {identity for region in regions if region.evidence_count
                        for identity in region.supporting_chunk_ids}
    for ordinal in gap_chunks:
        if any(0 <= neighbor < len(plan.chunks) and plan.chunks[neighbor].chunk_id in supported_chunks
               for neighbor in (ordinal - 1, ordinal + 1)):
            contextual_chunks.add(ordinal)
    contextual_ids = {plan.chunks[i].chunk_id for ordinal in gap_chunks
                      for i in (ordinal - 1, ordinal + 1) if 0 <= i < len(plan.chunks)}
    for index, region in enumerate(regions):
        gap_neighbor = (CoverageReason.MISSING_SPEECH in region.reasons
                        and any(i in contextual_chunks for i in core_ordinals(region.interval)))
        suspicious_neighbor = (region.state is CoverageState.SUSPICIOUS
                               and bool(contextual_ids.intersection(region.supporting_chunk_ids)))
        if not final and (gap_neighbor or suspicious_neighbor):
            reasons = {*region.reasons, CoverageReason.NEIGHBORING_GAP}
            regions[index] = replace(region, reasons=tuple(r for r in CoverageReason if r in reasons))

    unresolved = []
    reason_samples = dict.fromkeys(CoverageReason, 0)
    speech_counts = dict.fromkeys(CoverageState, 0)
    unsupported = duplicates = artifacts = 0
    for region in regions:
        length = region.interval.end_sample - region.interval.start_sample
        speech_counts[region.state] += region.likely_speech_samples
        for reason in region.reasons:
            reason_samples[reason] += length
        if CoverageReason.UNSUPPORTED_CANDIDATE in region.reasons:
            unsupported += length
        if region.duplicate_count:
            duplicates += length
        artifact = CoverageReason.TOLERATED_MAP_ARTIFACT in region.reasons
        if artifact:
            artifacts += length
        # Protection alone is boundary evidence, not actionable omitted speech.
        # Unsupported candidate text remains actionable even on apparent silence.
        actionable = (region.state is CoverageState.UNRESOLVED_ERROR or
                      (region.state is CoverageState.SUSPICIOUS
                       and (region.likely_speech_samples or region.uncertain_samples or region.evidence_count
                            or CoverageReason.UNCERTAIN_VAD in region.reasons
                            or CoverageReason.HIGH_ENERGY_NON_SPEECH in region.reasons)))
        if actionable and (final or not (artifact and region.state is not CoverageState.UNRESOLVED_ERROR)):
            _append_interval(unresolved, region.interval.start_sample, region.interval.end_sample)
    measurements["unresolved_risk_samples"] = sum(i.end_sample - i.start_sample for i in unresolved)
    # Legacy chunk counters remain baseline request counters for Recovery and
    # Correction. V2 failed_request_region_samples includes supplemental failures.
    baseline_failures = tuple(f for f in failures if f[2] in planned)
    quality = CoverageQuality(
        plan.sample_count, len(plan.chunks), sum(speech_counts.values()), speech_counts[CoverageState.COVERED],
        speech_counts[CoverageState.SUSPICIOUS], speech_counts[CoverageState.UNRESOLVED_ERROR],
        unsupported, duplicates, artifacts,
        sum(reason is CoverageReason.FAILED_CHUNK for _, reason, _ in baseline_failures),
        sum(reason is CoverageReason.MALFORMED_CHUNK for _, reason, _ in baseline_failures),
        sum(reason is CoverageReason.MISSING_CHUNK_RESULT for _, reason, _ in baseline_failures), reason_samples,
        **measurements,
    )
    return SpeechCoverageAssessment(
        plan.source_id, plan.sample_count, tuple(coverage), tuple(regions), tuple(unresolved), quality,
        CoverageProvenance("2", plan.provenance, configuration, asr_provenance,
                           CoveragePhase.FINAL_CANONICAL if final else CoveragePhase.PRE_CANONICAL),
    )


def _run_assessment(preprocessing, plan, results, settings, recovery_results=(), reconciliation=None):
    category = "VALIDATION"
    cancellation = None
    try:
        return _assess(preprocessing, plan, results, settings, recovery_results, reconciliation)
    except AudioProcessingError as error:
        category = error.category
        traceback.clear_frames(error.__traceback__)
    except (MemoryError, OSError) as error:
        category = "RESOURCE"
        traceback.clear_frames(error.__traceback__)
    except BaseException as error:
        if not isinstance(error, Exception) or isinstance(error, CancelledError):
            cancellation = error
            error.args = ()
            error.__cause__ = error.__context__ = None
        traceback.clear_frames(error.__traceback__)
    finally:
        preprocessing = plan = results = settings = recovery_results = reconciliation = None
    if cancellation is not None:
        raise cancellation.with_traceback(None)
    raise AudioProcessingError(category)


def assess_speech_coverage(
    preprocessing: PreprocessingResult, plan: AsrChunkPlan,
    results: tuple[AsrChunkResult, ...], settings: Settings,
) -> SpeechCoverageAssessment:
    """Borrow preprocessing and chunk evidence without execution or ownership transfer.

    Missing results become explicit interval evidence. Duplicate/foreign results
    and inconsistent global handoffs fail closed. Invalid chunk output is isolated
    to its original request interval; no timestamp is clipped or repaired.
    """
    try:
        return _run_assessment(preprocessing, plan, results, settings)
    finally:
        preprocessing = plan = results = settings = None


def revalidate_speech_coverage(
    preprocessing: PreprocessingResult, plan: AsrChunkPlan,
    baseline_results: tuple[AsrChunkResult, ...], recovery_results: tuple[AsrChunkResult, ...],
    settings: Settings,
) -> SpeechCoverageAssessment:
    """Assess cumulative evidence on the unchanged baseline/source timeline.

    Supplemental failures or malformed candidates never erase baseline success.
    Recovered timestamps without text or acoustic support never verify speech.
    All evidence is borrowed; only text-free assessment metadata is returned.
    """
    try:
        return _run_assessment(preprocessing, plan, baseline_results, settings, recovery_results)
    finally:
        preprocessing = plan = baseline_results = recovery_results = settings = None


def assess_canonical_coverage(
    preprocessing: PreprocessingResult, plan: AsrChunkPlan,
    baseline_results: tuple[AsrChunkResult, ...], recovery_results: tuple[AsrChunkResult, ...],
    reconciliation: "TranscriptReconciliation", settings: Settings,
) -> SpeechCoverageAssessment:
    """Assess actual T05 selection once, without modifying it or scheduling work.

    Canonical metrics measure temporal support for selected wording, never human
    accuracy or word completeness. Unresolved intervals are an evidence-risk union.
    """
    try:
        if reconciliation is None:
            raise AudioProcessingError("VALIDATION")
        return _run_assessment(preprocessing, plan, baseline_results, settings, recovery_results, reconciliation)
    finally:
        preprocessing = plan = baseline_results = recovery_results = reconciliation = settings = None
