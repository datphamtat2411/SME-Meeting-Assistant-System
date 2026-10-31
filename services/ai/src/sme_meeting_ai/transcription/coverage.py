"""Deterministic assessment of fallible ASR and speech evidence, never text repair.

COVERED means timestamped text supports likely speech under the captured evidence.
It is not a ground-truth transcription guarantee. Candidates remain caller-owned,
transient evidence; neither their text nor their segment objects enter the output.
"""

import math
from bisect import bisect_left, bisect_right
from collections import defaultdict
from dataclasses import dataclass, field, replace
from enum import StrEnum
from fractions import Fraction
from types import MappingProxyType
from typing import Mapping

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import SampleInterval, VadLabel
from sme_meeting_ai.audio.speech_map import _append_interval, _validate_contracts, _validate_frame
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import PreprocessingResult

from .asr import (
    AsrError, AsrErrorCategory, AsrProvenance, AsrQualityMetadata, AsrSegmentQuality,
)
from .chunk_execution import AsrChunkResult, AsrTimelineSegment, _translate_candidate
from .chunk_planning import (
    AsrChunk, AsrChunkPlan, ChunkPlanningProvenance, _validate_handoff, validate_asr_chunk_plan,
)


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


@dataclass(frozen=True)
class CoverageQuality:
    """Exact, union-based sample counts; speech states partition likely speech.

    Duplicate samples count positions with multiple timestamp supports, not the
    sum of repeated evidence durations. Reason counts can overlap each other.
    Zero likely-speech samples yield a zero rate, never perfect coverage.
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


@dataclass(frozen=True)
class CoverageProvenance:
    assessor_version: str
    planning: ChunkPlanningProvenance
    effective_configuration: Mapping[str, int | float]
    asr: tuple[tuple[str, AsrProvenance], ...]
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


def _configuration(settings: Settings) -> dict[str, int | float]:
    _require(isinstance(settings, Settings))
    gap = settings.audio_asr_coverage_max_tolerated_speech_map_gap_samples
    repetition = settings.audio_asr_coverage_repetition_min_chars
    confidence = settings.audio_asr_coverage_low_confidence_threshold
    _require(type(gap) is int and 0 <= gap <= 230400000)
    _require(type(repetition) is int and 1 <= repetition <= 65536)
    _require(type(confidence) in (float, int) and math.isfinite(confidence) and 0 <= confidence <= 1)
    return {"max_tolerated_speech_map_gap_samples": gap,
            "repetition_min_chars": repetition, "low_confidence_threshold": confidence}


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
        for item in translated:
            _require(isinstance(item.segment.quality, AsrSegmentQuality)
                     and _confidence(item.segment.quality.confidence))
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
    text_groups = defaultdict(list)
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
        if not _valid_result(item):
            failures.append((chunk.request_interval, CoverageReason.MALFORMED_CHUNK, chunk.chunk_id))
            continue
        candidate = item.candidate
        # Copy only the normalized inference settings, never arbitrary provider
        # metadata (which can include prompts or sensitive diagnostics).
        safe_config = tuple((key, value) for key, value in candidate.provenance.inference_config
                            if (key == "language" and isinstance(value, str)
                                and 0 < len(value) <= 16 and all(c.isalpha() or c == "-" for c in value))
                            or (key == "temperature" and type(value) in (int, float)
                                and math.isfinite(value) and 0 <= value <= 1))
        provenance.append((chunk.chunk_id, replace(candidate.provenance, inference_config=safe_config)))
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
    return supports, failures, tuple(provenance)


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


def _assess(preprocessing, plan, results, settings, recovery_results=None):
    configuration = _configuration(settings)
    _validate_handoff(preprocessing)
    validate_asr_chunk_plan(plan)
    _require(plan.source_id == preprocessing.provenance.source_id
             and plan.sample_count == preprocessing.normalized_artifact.sample_count
             and plan.provenance.preprocessing == preprocessing.provenance)
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
    supports, failures, asr_provenance = _collect_results(plan, results, configuration)
    recovery_ids = set()
    if recovery_results is not None:
        # Recovery is supplemental evidence, never a replacement partition.
        # Validate the complete handoff; only failure-free, structurally valid
        # candidates contribute support. Failed attempts stay in recovery output.
        from .recovery import _configuration as recovery_configuration, _validate_recovery_chunk

        limits = recovery_configuration(settings)
        _require(isinstance(recovery_results, tuple)
                 and len(recovery_results) <= limits["max_total_attempts"])
        requests = {c.request_interval for c in plan.chunks}
        ordinals = {c.ordinal for c in plan.chunks}
        accepted = []
        for item in sorted(recovery_results, key=lambda item: (item.chunk.ordinal, item.chunk.chunk_id)):
            _require(isinstance(item, AsrChunkResult))
            _validate_recovery_chunk(item.chunk, plan.sample_count, limits)
            chunk = item.chunk
            _require(chunk.chunk_id not in planned and chunk.chunk_id not in recovery_ids
                     and chunk.ordinal >= len(plan.chunks) and chunk.ordinal not in ordinals
                     and chunk.request_interval not in requests)
            recovery_ids.add(chunk.chunk_id)
            ordinals.add(chunk.ordinal)
            requests.add(chunk.request_interval)
            if item.failure is None and _valid_result(item):
                accepted.append(item)
        supports, failures, asr_provenance = _collect_results(
            replace(plan, chunks=(*plan.chunks, *(item.chunk for item in accepted))),
            (*results, *accepted), configuration,
        )
    indicators = _replay_indicators(preprocessing)
    speech_map = preprocessing.speech_map
    tolerated = _tolerated_gaps(speech_map, indicators, configuration["max_tolerated_speech_map_gap_samples"])

    # One boundary sweep counts every absolute sample once. Event multiplicities
    # retain duplicate support and overlapping failures without extending bounds.
    events = defaultdict(list)

    def add(interval, kind, identity=None):
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
    for interval, reason, chunk_id in failures:
        add(interval, reason, chunk_id)
    events[0]
    events[plan.sample_count]
    positions = sorted(events)
    active = set()
    active_errors = set()
    counts = defaultdict(int)
    coverage, regions = [], []
    for start, end in zip(positions, positions[1:]):
        for kind, identity, delta in events[start]:
            if kind == "support":
                if delta == 1:
                    active.add(identity)
                else:
                    active.remove(identity)
            else:
                counts[kind] += delta
                if identity is not None:
                    if delta == 1:
                        active_errors.add(identity)
                    else:
                        active_errors.remove(identity)
        likely, protected = bool(counts["speech"]), bool(counts["protected"])
        uncertain = bool(counts["uncertain"] or counts[CoverageReason.UNCERTAIN_VAD]
                         or counts[CoverageReason.HIGH_ENERGY_NON_SPEECH])
        chunk_ids = tuple(sorted({supports[i].chunk_id for i in active}))
        evidence_count = len(active)
        duplicate_count = max(0, evidence_count - 1)
        text_count = sum(supports[i].has_text for i in active)
        interval = SampleInterval(start, end)
        if active:
            _append_map(coverage, TranscriptCoverageInterval(
                interval, chunk_ids, evidence_count, duplicate_count, bool(text_count), text_count,
            ))
        reasons = {reason for reason in CoverageReason if counts[reason]}
        if not active and not likely:
            reasons.discard(CoverageReason.NON_SPEECH_VAD)
        failure = any(reason in reasons for reason in (
            CoverageReason.FAILED_CHUNK, CoverageReason.MALFORMED_CHUNK, CoverageReason.MISSING_CHUNK_RESULT,
        ))
        if not (likely or protected or uncertain or active or failure or reasons):
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
        # A baseline error remains visible in reasons/provenance but cannot
        # override newly validated recovery support at these exact samples.
        recovery_support = any(supports[i].chunk_id in recovery_ids and supports[i].has_text for i in active)
        if (failure and not (likely and recovery_support)) or ((likely or uncertain) and not text_count):
            state = CoverageState.UNRESOLVED_ERROR
        elif (not likely or uncertain or counts[CoverageReason.WEAK_SPEECH]
              or counts[CoverageReason.NON_SPEECH_VAD] or not text_count):
            state = CoverageState.SUSPICIOUS
        else:
            # Repetition and confidence remain visible weak indicators. They do
            # not alone override timestamped text supported by likely speech.
            state = CoverageState.COVERED
        _append_region(regions, CoverageRegion(
            interval, state, tuple(reason for reason in CoverageReason if reason in reasons),
            chunk_ids, tuple(sorted(active_errors)), evidence_count, duplicate_count, text_count,
            end - start if likely else 0, end - start if protected else 0,
            end - start if counts["uncertain"] else 0,
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
        if gap_neighbor or suspicious_neighbor:
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
        if actionable and not (artifact and region.state is not CoverageState.UNRESOLVED_ERROR):
            _append_interval(unresolved, region.interval.start_sample, region.interval.end_sample)
    quality = CoverageQuality(
        plan.sample_count, len(plan.chunks), sum(speech_counts.values()), speech_counts[CoverageState.COVERED],
        speech_counts[CoverageState.SUSPICIOUS], speech_counts[CoverageState.UNRESOLVED_ERROR],
        unsupported, duplicates, artifacts,
        sum(reason is CoverageReason.FAILED_CHUNK for _, reason, _ in failures),
        sum(reason is CoverageReason.MALFORMED_CHUNK for _, reason, _ in failures),
        sum(reason is CoverageReason.MISSING_CHUNK_RESULT for _, reason, _ in failures), reason_samples,
    )
    return SpeechCoverageAssessment(
        plan.source_id, plan.sample_count, tuple(coverage), tuple(regions), tuple(unresolved), quality,
        CoverageProvenance("1", plan.provenance, configuration, asr_provenance),
    )


def assess_speech_coverage(
    preprocessing: PreprocessingResult, plan: AsrChunkPlan,
    results: tuple[AsrChunkResult, ...], settings: Settings,
) -> SpeechCoverageAssessment:
    """Borrow preprocessing and chunk evidence without execution or ownership transfer.

    Missing results become explicit interval evidence. Duplicate/foreign results
    and inconsistent global handoffs fail closed. Invalid chunk output is isolated
    to its original request interval; no timestamp is clipped or repaired.
    """
    category = None
    try:
        return _assess(preprocessing, plan, results, settings)
    except AudioProcessingError as error:
        category = error.category
    except (MemoryError, OSError):
        category = "RESOURCE"
    except (AttributeError, TypeError, ValueError, KeyError, OverflowError):
        category = "VALIDATION"
    # Raise outside handlers so sensitive input-bearing exception context is gone.
    raise AudioProcessingError(category)


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
    category = "VALIDATION"
    try:
        return _assess(preprocessing, plan, baseline_results, settings, recovery_results)
    except AudioProcessingError as error:
        category = error.category
    except (MemoryError, OSError):
        category = "RESOURCE"
    except (AttributeError, TypeError, ValueError, KeyError, OverflowError):
        pass
    raise AudioProcessingError(category)
