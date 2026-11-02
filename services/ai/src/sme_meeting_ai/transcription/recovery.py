"""Selective Recovery V2: bounded observations with monotonic canonical admission.

T05 selects wording; T06 measures independent acoustic/canonical evidence. Only
admitted trials become current state. Admission is structural corroboration, not
human-reference accuracy. Rejected wording never enters operational evidence.
"""

import math
import re
import time
import traceback
import wave
from bisect import bisect_left
from concurrent.futures import CancelledError
from dataclasses import dataclass, field, replace
from enum import StrEnum
from itertools import islice
from types import MappingProxyType
from typing import TYPE_CHECKING, Mapping

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import (
    AudioSource,
    NormalizedAudioArtifact,
    SampleInterval,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import PreprocessingResult
from sme_meeting_ai.pipeline.preprocessing import _validate_normalization

from .asr import AsrError, AsrErrorCategory, AsrTranscriber
from .chunk_execution import AsrChunkResult, _validate_wav, execute_asr_windows
from .chunk_planning import (
    AsrChunk,
    AsrChunkPlan,
    ChunkBoundaryReason,
    ChunkPlanningProvenance,
    validate_asr_chunk_plan,
)
from .chunk_planning import (
    _request_limits as _planning_request_limits,
)
from .coverage import (
    AcousticEvidenceState,
    CoveragePhase,
    CoverageReason,
    CoverageRegion,
    CoverageState,
    SpeechCoverageAssessment,
    assess_speech_coverage,
)

if TYPE_CHECKING:
    from .boundary_alignment import BoundaryAlignmentReport
    from .reconciliation import TranscriptReconciliation


class RecoveryAdmissionDecision(StrEnum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    FAILED = "failed"


class RecoveryAdmissionReason(StrEnum):
    NEW_SUPPORTED_SPEECH = "new-supported-speech"
    RESOLVED_CANONICAL_AMBIGUITY = "resolved-canonical-ambiguity"
    NO_CANONICAL_IMPROVEMENT = "no-canonical-improvement"
    REDUNDANT_HYPOTHESIS = "redundant-hypothesis"
    INSUFFICIENT_ACOUSTIC_CORROBORATION = "insufficient-acoustic-corroboration"
    CANONICAL_REGRESSION = "canonical-regression"
    NEW_CONFLICT = "new-conflict"
    NEW_AMBIGUITY = "new-ambiguity"
    UNSUPPORTED_TEXT_RISK = "unsupported-text-risk"
    INVALID_CANDIDATE = "invalid-candidate"
    INVALID_TIMELINE = "invalid-timeline"
    RESOURCE_LIMIT = "resource-limit"


class RecoveryTargetReason(StrEnum):
    MISSING_CANONICAL_SPEECH = "missing-canonical-speech"
    FAILED_SPEECH_REQUEST = "failed-speech-request"
    RAW_ONLY_SPEECH_SUPPORT = "raw-only-speech-support"
    UNCERTAIN_MISSING_SPEECH = "uncertain-missing-speech"
    CANONICAL_BOUNDARY_CONFLICT = "canonical-boundary-conflict"


class RecoveryStopReason(StrEnum):
    SKIPPED_BY_ASR_STRATEGY = "skipped-by-asr-strategy"
    SUFFICIENT_COVERAGE = "sufficient-coverage"
    NO_ACTIONABLE_REGIONS = "no-actionable-regions"
    NO_DISTINCT_WINDOW = "no-distinct-window"
    NO_PROGRESS = "no-progress"
    TERMINAL_FAILURE = "terminal-failure"
    REGION_ATTEMPT_LIMIT = "region-attempt-limit"
    REGION_SAMPLE_LIMIT = "region-sample-limit"
    TOTAL_ATTEMPT_LIMIT = "total-attempt-limit"
    TOTAL_SAMPLE_LIMIT = "total-sample-limit"
    WALL_TIME_LIMIT = "wall-time-limit"
    NO_ADMISSIBLE_IMPROVEMENT = "no-admissible-improvement"
    CANONICAL_REGRESSION_PREVENTED = "canonical-regression-prevented"


@dataclass(frozen=True)
class RecoveryWindow:
    chunk: AsrChunk
    target_region: CoverageRegion
    attempt_index: int
    boundary_strategy: str
    baseline_context_ids: tuple[str, ...]
    planning: ChunkPlanningProvenance
    target_reason: RecoveryTargetReason = RecoveryTargetReason.MISSING_CANONICAL_SPEECH

    def __post_init__(self) -> None:
        object.__setattr__(self, "baseline_context_ids", tuple(self.baseline_context_ids))


@dataclass(frozen=True)
class RecoveryProvenance:
    recovery_version: str
    planning: ChunkPlanningProvenance
    effective_configuration: Mapping[str, int | float]
    target_region_count: int = 0
    actual_attempt_count: int = 0
    accepted_attempt_count: int = 0
    rejected_attempt_count: int = 0
    failed_attempt_count: int = 0
    total_requested_samples: int = 0
    accepted_recovery_result_count: int = 0
    remaining_actionable_region_count: int = 0
    target_resolved_samples: int = 0
    canonical_support_gain_samples: int = 0
    canonical_ambiguity_reduction_samples: int = 0
    rejected_regression_count: int = 0
    rejected_redundancy_count: int = 0
    execution_duration_ns: int = field(default=0, compare=False)
    sample_rate_hz: int = field(default=16000, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "planning", replace(self.planning))
        object.__setattr__(self, "effective_configuration", MappingProxyType(dict(self.effective_configuration)))


@dataclass(frozen=True)
class RecoveryPlan:
    source_id: str
    sample_count: int
    target_regions: tuple[CoverageRegion, ...]
    windows: tuple[RecoveryWindow, ...]
    provenance: RecoveryProvenance


@dataclass(frozen=True)
class RecoveryAttempt:
    window: RecoveryWindow
    failure: AsrErrorCategory | None
    unresolved_samples_before: int
    unresolved_samples_after: int
    covered_speech_delta: int
    meaningful_progress: bool
    stop_reason: RecoveryStopReason | None
    admission: RecoveryAdmissionDecision | None = None
    admission_reason: RecoveryAdmissionReason | None = None
    global_unresolved_speech_samples_before: int = 0
    global_unresolved_speech_samples_after: int = 0
    new_canonical_supported_speech_samples: int = 0
    resolved_ambiguity_samples: int = 0
    new_conflict_samples: int = 0
    new_unsupported_text_samples: int = 0
    requested_samples: int = 0
    request_duration_ns: int = field(default=0, compare=False)

    @property
    def target_unresolved_samples_before(self) -> int:
        return self.unresolved_samples_before

    @property
    def target_unresolved_samples_after(self) -> int:
        return self.unresolved_samples_after


@dataclass(frozen=True)
class SpeechRecoveryResult:
    """Candidate-bearing results are borrowed transient evidence, never log data."""

    original_results: tuple[AsrChunkResult, ...] = field(repr=False)
    recovered_results: tuple[AsrChunkResult, ...] = field(repr=False)
    initial_assessment: SpeechCoverageAssessment
    final_assessment: SpeechCoverageAssessment
    attempts: tuple[RecoveryAttempt, ...]
    stop_reason: RecoveryStopReason
    provenance: RecoveryProvenance
    initial_canonical_assessment: SpeechCoverageAssessment | None = None
    accepted_reconciliation: "TranscriptReconciliation | None" = field(default=None, repr=False)
    evaluation_failure: AsrErrorCategory | None = None


_STRATEGIES = ("balanced-context", "left-context", "right-context", "tight-context")
_TRANSIENT = frozenset((AsrErrorCategory.TIMEOUT, AsrErrorCategory.TRANSPORT))
_GLOBAL_FAILURES = frozenset((AsrErrorCategory.AUTHENTICATION, AsrErrorCategory.VALIDATION,
                              AsrErrorCategory.RESOURCE, AsrErrorCategory.RATE_LIMIT))


def _require(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("VALIDATION")


def _configuration(settings: Settings) -> dict[str, int | float]:
    # Share validation/request limits, not T04's baseline forced-core feasibility.
    # Each Recovery window has its own unchanged core/context admission below.
    geometry = _planning_request_limits(settings)
    configuration = {}
    for key, maximum in (
        ("context_samples", 230400000), ("max_attempts_per_region", 64),
        ("max_request_samples_per_region", 230400000), ("max_total_attempts", 256),
        ("max_total_request_samples", 230400000),
    ):
        value = getattr(settings, f"audio_asr_recovery_{key}")
        _require(type(value) is int and 1 <= value <= maximum)
        configuration[key] = value
    for key, value, maximum in (
        ("max_wall_time_seconds", settings.audio_asr_recovery_max_wall_time_seconds, 3600),
        ("provider_timeout_seconds", settings.audio_asr_timeout_seconds, 600),
    ):
        _require(type(value) in (int, float) and math.isfinite(value) and 0 < value <= maximum)
        configuration[key] = value
    payload = settings.audio_asr_max_payload_bytes
    concurrency = settings.audio_asr_max_concurrent_chunks
    _require(type(payload) is int and 0 < payload <= 26214400)
    _require(type(concurrency) is int and 1 <= concurrency <= 4)
    configuration.update({
        "max_request_samples": min(geometry["max_request_samples"], max(0, (payload - 44) // 2)),
        "max_payload_bytes": payload, "max_timeline_samples": geometry["max_timeline_samples"],
        "concurrency": 1, "fair_observation_rounds": 1,
    })
    return configuration


def _interval(interval: SampleInterval, sample_count: int) -> bool:
    return (isinstance(interval, SampleInterval)
            and type(interval.start_sample) is int and type(interval.end_sample) is int
            and 0 <= interval.start_sample < interval.end_sample <= sample_count)


def _validate_recovery_chunk(chunk: AsrChunk, sample_count: int, configuration) -> None:
    _require(isinstance(chunk, AsrChunk))
    _require(isinstance(chunk.chunk_id, str) and bool(re.fullmatch(r"recovery-[0-9]{6}", chunk.chunk_id)))
    _require(type(chunk.ordinal) is int and chunk.ordinal >= 0)
    _require(_interval(chunk.core_interval, sample_count) and _interval(chunk.request_interval, sample_count))
    core, request = chunk.core_interval, chunk.request_interval
    _require(request.start_sample <= core.start_sample < core.end_sample <= request.end_sample)
    _require(request.end_sample - request.start_sample <= configuration["max_request_samples"])
    _require(44 + 2 * (request.end_sample - request.start_sample) <= configuration["max_payload_bytes"])
    _require(sample_count <= configuration["max_timeline_samples"])
    _require(isinstance(chunk.start_boundary_reason, ChunkBoundaryReason)
             and isinstance(chunk.end_boundary_reason, ChunkBoundaryReason))


def _validate_execution_windows(windows, audio, transcriber, settings) -> None:
    configuration = _configuration(settings)
    _require(isinstance(windows, tuple) and len(windows) <= configuration["max_total_attempts"])
    _require(isinstance(audio, NormalizedAudioArtifact) and callable(getattr(transcriber, "transcribe", None)))
    _validate_normalization(AudioSource(audio.source_id, audio.path), audio)
    ids, ordinals, requests = set(), set(), set()
    total_samples = 0
    regions = {}
    for window in windows:
        _require(isinstance(window, RecoveryWindow))
        _validate_recovery_chunk(window.chunk, audio.sample_count, configuration)
        _require(isinstance(window.target_region, CoverageRegion)
                 and _interval(window.target_region.interval, audio.sample_count))
        core, target = window.chunk.core_interval, window.target_region.interval
        _require(target.start_sample <= core.start_sample < core.end_sample <= target.end_sample)
        _require(type(window.attempt_index) is int
                 and 1 <= window.attempt_index <= configuration["max_attempts_per_region"])
        _require(window.boundary_strategy in _STRATEGIES)
        _require(isinstance(window.target_reason, RecoveryTargetReason) and _risk(window.target_region) is not None)
        _require(isinstance(window.planning, ChunkPlanningProvenance)
                 and window.planning.sample_rate_hz == 16000
                 and window.planning.preprocessing.source_id == audio.source_id
                 and window.planning.preprocessing.sample_count == audio.sample_count
                 and window.planning.preprocessing.normalization == audio.provenance)
        _require(all(isinstance(identity, str) and re.fullmatch(r"chunk-[0-9]{6}", identity)
                     for identity in window.baseline_context_ids))
        chunk = window.chunk
        _require(chunk.chunk_id not in ids and chunk.ordinal not in ordinals and chunk.request_interval not in requests)
        ids.add(chunk.chunk_id)
        ordinals.add(chunk.ordinal)
        requests.add(chunk.request_interval)
        length = chunk.request_interval.end_sample - chunk.request_interval.start_sample
        effective = window.planning.effective_configuration
        _require(length <= effective.get("provider_max_request_samples", 230400000)
                 and 44 + 2 * length <= effective.get("effective_payload_limit", 25000000))
        total_samples += length
        count, samples = regions.get(target, (0, 0))
        regions[target] = (count + 1, samples + length)
        _require(count + 1 <= configuration["max_attempts_per_region"]
                 and samples + length <= configuration["max_request_samples_per_region"])
    _require(total_samples <= configuration["max_total_request_samples"])
    with wave.open(str(audio.path), "rb") as reader:
        _validate_wav(reader, audio.sample_count)


def _risk(region: CoverageRegion):
    evidence = region.evidence
    if evidence is None or region.state is CoverageState.COVERED:
        return None
    likely = evidence.acoustic_state is AcousticEvidenceState.LIKELY_SPEECH
    credible = likely or (evidence.acoustic_state is AcousticEvidenceState.ACOUSTICALLY_UNCERTAIN
                          and bool(region.likely_speech_samples or region.uncertain_samples
                                   or evidence.vad_energy_disagreement))
    if not credible:
        return None
    if not evidence.has_canonical_text_support:
        if likely:
            if region.error_chunk_ids:
                return 1, RecoveryTargetReason.FAILED_SPEECH_REQUEST
            if evidence.has_raw_text_support:
                return 2, RecoveryTargetReason.RAW_ONLY_SPEECH_SUPPORT
            return 0, RecoveryTargetReason.MISSING_CANONICAL_SPEECH
        return 3, RecoveryTargetReason.UNCERTAIN_MISSING_SPEECH
    if evidence.has_conflicting_hypotheses or evidence.has_ambiguous_alignment:
        return 4, RecoveryTargetReason.CANONICAL_BOUNDARY_CONFLICT
    return None


def _final_contract(assessment, plan):
    _require(isinstance(assessment, SpeechCoverageAssessment)
             and assessment.source_id == plan.source_id and assessment.sample_count == plan.sample_count
             and assessment.sample_rate_hz == 16000 and assessment.provenance.planning == plan.provenance
             and assessment.provenance.assessor_version == "2"
             and assessment.provenance.assessment_phase is CoveragePhase.FINAL_CANONICAL)
    for name in ("likely_speech_with_canonical_text_samples", "likely_speech_without_canonical_text_samples",
                 "raw_only_support_samples", "unsupported_canonical_text_samples",
                 "conflicting_canonical_samples", "ambiguous_canonical_samples"):
        _require(type(getattr(assessment.quality, name)) is int)
    ordered = sorted(assessment.regions, key=lambda r: r.interval.start_sample)
    previous = 0
    for region in ordered:
        _require(isinstance(region, CoverageRegion) and _interval(region.interval, plan.sample_count)
                 and region.interval.start_sample >= previous and region.evidence is not None)
        previous = region.interval.end_sample


def _union(intervals):
    output = []
    for interval in sorted(intervals, key=lambda i: (i.start_sample, i.end_sample)):
        if output and interval.start_sample <= output[-1].end_sample:
            output[-1] = SampleInterval(output[-1].start_sample, max(output[-1].end_sample, interval.end_sample))
        else:
            output.append(interval)
    return tuple(output)


def _difference(left, right):
    """Linear difference of sorted interval unions; no frame/text comparisons."""
    output, index = [], 0
    for interval in left:
        position = interval.start_sample
        while index < len(right) and right[index].end_sample <= position:
            index += 1
        cursor = index
        while cursor < len(right) and right[cursor].start_sample < interval.end_sample:
            other = right[cursor]
            if position < other.start_sample:
                output.append(SampleInterval(position, min(other.start_sample, interval.end_sample)))
            position = max(position, other.end_sample)
            if position >= interval.end_sample:
                break
            cursor += 1
        if position < interval.end_sample:
            output.append(SampleInterval(position, interval.end_sample))
    return tuple(output)


def _length(intervals, target=None):
    return sum(max(0, min(i.end_sample, target.end_sample) - max(i.start_sample, target.start_sample))
               if target else i.end_sample - i.start_sample for i in intervals)


def _stream(assessment, kind):
    # Project existing T06 observations, never derive another coverage state.
    def present(region):
        e = region.evidence
        if kind == "missing":
            return region.likely_speech_samples and not e.has_canonical_text_support
        if kind == "supported":
            return region.likely_speech_samples and e.has_canonical_text_support
        if kind == "unsupported":
            return CoverageReason.CANONICAL_ACOUSTIC_DISAGREEMENT in region.reasons
        if kind == "conflict":
            return e.has_conflicting_hypotheses
        if kind == "ambiguity":
            return e.has_ambiguous_alignment
        if kind == "speech-risk":
            return (region.likely_speech_samples or e.acoustic_state is AcousticEvidenceState.ACOUSTICALLY_UNCERTAIN
                    ) and region.state is not CoverageState.COVERED
        return _risk(region) is not None

    return _union(r.interval for r in assessment.regions if present(r))


def _remaining(assessment, interval=None):
    return _length(_stream(assessment, "actionable"), interval)


def _request(core, sample_count, context, maximum, strategy):
    spare = maximum - (core.end_sample - core.start_sample)
    if strategy == "balanced-context":
        left, right = min(context, spare // 2), min(context, spare - spare // 2)
    elif strategy == "left-context":
        left, right = min(context, spare), 0
    elif strategy == "right-context":
        left, right = 0, min(context, spare)
    else:
        left = right = 0
    return SampleInterval(max(0, core.start_sample - left), min(sample_count, core.end_sample + right))


def _boundary_samples(report, plan):
    if report is None:
        return (), ()
    from .boundary_alignment import BoundaryAlignmentReport, BoundaryRisk

    _require(isinstance(report, BoundaryAlignmentReport) and report.alignment_version == "boundary-alignment-v2"
             and report.metrics.planner_version == plan.provenance.planner_version
             and report.metrics.source_sample_count == plan.sample_count
             and report.metrics.planned_chunk_count == len(plan.chunks)
             and len(report.boundaries) == len(plan.chunks) - 1)
    forced, natural = [], []
    for boundary, left, right in zip(report.boundaries, plan.chunks[:-1], plan.chunks[1:], strict=True):
        _require(boundary.boundary_sample == left.core_interval.end_sample == right.core_interval.start_sample
                 and boundary.left_chunk_id == left.chunk_id and boundary.right_chunk_id == right.chunk_id
                 and boundary.boundary_reason is left.end_boundary_reason
                 and isinstance(boundary.boundary_risk, BoundaryRisk))
        (natural if boundary.boundary_risk is BoundaryRisk.NATURAL_CANDIDATE else forced).append(
            boundary.boundary_sample)
    return tuple(forced), tuple(natural)


def _near(samples, interval, context):
    index = bisect_left(samples, max(0, interval.start_sample - context))
    return index < len(samples) and samples[index] <= interval.end_sample + context


def _planning_context(assessment, plan, settings, boundary_alignment):
    validate_asr_chunk_plan(plan)
    configuration = _configuration(settings)
    _final_contract(assessment, plan)
    _require(plan.sample_count <= configuration["max_timeline_samples"])
    effective = plan.provenance.effective_configuration
    configuration["max_request_samples"] = min(configuration["max_request_samples"],
                                               effective.get("provider_max_request_samples", 230400000),
                                               max(0, (effective.get("effective_payload_limit", 25000000) - 44) // 2))
    forced, natural = _boundary_samples(boundary_alignment, plan)
    regions = tuple(sorted((r for r in assessment.regions if _risk(r) is not None), key=lambda r: (
        _risk(r)[0], r.interval.start_sample, r.interval.end_sample,
    )))
    return configuration, regions, forced, natural


def _iter_windows(regions, plan, configuration, forced, natural):
    """One observation per target before another context strategy on early targets.

    Risk order remains deterministic within each round. No target is discarded
    for being short/weak, and runtime admission/budgets remain independent.
    """
    seen = {c.request_interval for c in plan.chunks}
    maximum = configuration["max_request_samples"]
    alternatives = {}
    number = 0
    if maximum:
        for strategy in _STRATEGIES:
            for region in regions:
                start, end = region.interval.start_sample, region.interval.end_sample
                context = configuration["context_samples"]
                if _near(natural, region.interval, context) and not _near(forced, region.interval, context):
                    context //= 2
                # Context is optional when an intact target fits. Split only
                # for the hard request ceiling, never to manufacture more work.
                size = (maximum - min(2 * context, maximum // 2) if end - start > maximum else end - start)
                while start < end:
                    core = SampleInterval(start, min(end, start + size))
                    key = (region.interval, core)
                    request = _request(core, plan.sample_count, context, maximum, strategy)
                    start = core.end_sample
                    count = alternatives.get(key, 0)
                    if count >= configuration["max_attempts_per_region"] or request in seen:
                        continue
                    chunk = AsrChunk(
                        f"recovery-{number:06d}", len(plan.chunks) + number, core, request,
                        ChunkBoundaryReason.TIMELINE_START if core.start_sample == 0
                        else ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH,
                        ChunkBoundaryReason.TIMELINE_END if core.end_sample == plan.sample_count
                        else ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH,
                    )
                    _validate_recovery_chunk(chunk, plan.sample_count, configuration)
                    context_ids = tuple(c.chunk_id for c in plan.chunks if (
                        c.request_interval.start_sample < request.end_sample
                        and request.start_sample < c.request_interval.end_sample
                    ))
                    alternatives[key] = count + 1
                    seen.add(request)
                    yield RecoveryWindow(chunk, region, count + 1, strategy, context_ids,
                                          plan.provenance, _risk(region)[1])
                    number += 1


def _plan(assessment, plan, settings, boundary_alignment=None):
    configuration, regions, forced, natural = _planning_context(assessment, plan, settings, boundary_alignment)
    windows = tuple(islice(_iter_windows(regions, plan, configuration, forced, natural),
                           configuration["max_total_attempts"]))
    return RecoveryPlan(plan.source_id, plan.sample_count, regions, windows,
                        RecoveryProvenance("2", plan.provenance, configuration, target_region_count=len(regions)))


def plan_recovery_windows(
    assessment: SpeechCoverageAssessment, plan: AsrChunkPlan, settings: Settings,
    *, boundary_alignment: "BoundaryAlignmentReport | None" = None,
) -> RecoveryPlan:
    """Plan bounded distinct alternatives without executing or transferring ownership.

    Alternatives are bounded metadata, not authorization to exceed execution
    budgets. Targets beyond those budgets remain in the assessment unresolved.
    """
    category = "VALIDATION"
    try:
        return _plan(assessment, plan, settings, boundary_alignment)
    except AudioProcessingError as error:
        category = error.category
    except MemoryError:
        category = "RESOURCE"
    except (AttributeError, TypeError, ValueError, KeyError, OverflowError):
        pass
    raise AudioProcessingError(category)


def _baseline_state(preprocessing, plan, baseline_results, settings, boundary_alignment=None):
    from .coverage import assess_canonical_coverage
    from .reconciliation import reconcile_transcript

    initial = assess_speech_coverage(preprocessing, plan, baseline_results, settings)
    canonical = reconcile_transcript(plan, baseline_results, settings, boundary_alignment=boundary_alignment)
    final = assess_canonical_coverage(preprocessing, plan, baseline_results, (), canonical, settings)
    _final_contract(final, plan)
    return initial, canonical, final


def _protected(current, trial):
    # Ordinals can shift after insertion. The source evidence identities cannot.
    by_identity = {}
    for segment in trial.segments:
        for identity in segment.supporting_evidence_ids:
            by_identity.setdefault(identity, []).append(segment)
    represented = set()
    for segment in current.segments:
        matches = [s for s in by_identity.get(segment.selected_evidence_id, ())
                   if s.interval == segment.interval and s.text == segment.text]
        if len(matches) != 1 or matches[0].selected_evidence_id in represented:
            return False
        represented.add(matches[0].selected_evidence_id)
    return True


def _ambiguity_proof(current, trial, candidate_id, target):
    from .reconciliation import OccurrenceRelationship

    unresolved = {i for r in current.relationships
                  if r.classification in (OccurrenceRelationship.AMBIGUOUS,
                                          OccurrenceRelationship.PARTIAL_SUPPORT,
                                          OccurrenceRelationship.CONFLICTING_HYPOTHESIS)
                  for i in (*r.left, *r.right)
                  if i.interval.start_sample < target.end_sample and target.start_sample < i.interval.end_sample}
    established = set()
    for relation in trial.relationships:
        nodes = (*relation.left, *relation.right)
        if (relation.classification is OccurrenceRelationship.SAME_OCCURRENCE
                and any(i.chunk_id == candidate_id for i in nodes)):
            established.update(i for i in nodes if i in unresolved)
    return bool(unresolved) and unresolved <= established


def _admission(current, before, trial, after, candidate_id, target):
    """Deterministic non-compensating comparison of actual T05/T06 snapshots."""
    from .reconciliation import OccurrenceRelationship

    Reason = RecoveryAdmissionReason
    metrics = {
        "new_canonical_supported_speech_samples": _length(_difference(_stream(after, "supported"),
                                                                       _stream(before, "supported"))),
        "resolved_ambiguity_samples": _length(_difference(
            _union((*_stream(before, "ambiguity"), *_stream(before, "conflict"))),
            _union((*_stream(after, "ambiguity"), *_stream(after, "conflict"))))),
        "new_conflict_samples": _length(_difference(_stream(after, "conflict"), _stream(before, "conflict"))),
        "new_unsupported_text_samples": _length(_difference(_stream(after, "unsupported"),
                                                            _stream(before, "unsupported"))),
    }
    if not _protected(current, trial):
        return Reason.CANONICAL_REGRESSION, metrics
    if metrics["new_unsupported_text_samples"]:
        return Reason.UNSUPPORTED_TEXT_RISK, metrics
    new_relationships = set(trial.relationships) - set(current.relationships)
    if any(r.classification is OccurrenceRelationship.CONFLICTING_HYPOTHESIS for r in new_relationships):
        return Reason.NEW_CONFLICT, metrics
    if any(r.classification in (OccurrenceRelationship.AMBIGUOUS, OccurrenceRelationship.PARTIAL_SUPPORT)
           for r in new_relationships):
        return Reason.NEW_AMBIGUITY, metrics
    if (_difference(_stream(after, "missing"), _stream(before, "missing"))
            or _difference(after.unresolved_intervals, before.unresolved_intervals)):
        return Reason.CANONICAL_REGRESSION, metrics
    if metrics["new_conflict_samples"]:
        return Reason.NEW_CONFLICT, metrics
    if _difference(_stream(after, "ambiguity"), _stream(before, "ambiguity")):
        return Reason.NEW_AMBIGUITY, metrics
    selected_candidate = any(s.selected_evidence_id.chunk_id == candidate_id
                             and s.interval.start_sample < target.end_sample
                             and target.start_sample < s.interval.end_sample for s in trial.segments)
    target_gain = _length(_difference(_stream(after, "supported"), _stream(before, "supported")), target)
    if (selected_candidate and target_gain > 0 and _remaining(after, target) < _remaining(before, target)
            and _length(after.unresolved_intervals) < _length(before.unresolved_intervals)):
        return Reason.NEW_SUPPORTED_SPEECH, metrics
    reduced = _difference(_union((*_stream(before, "ambiguity"), *_stream(before, "conflict"))),
                          _union((*_stream(after, "ambiguity"), *_stream(after, "conflict"))))
    if _length(reduced, target) and _ambiguity_proof(current, trial, candidate_id, target):
        return Reason.RESOLVED_CANONICAL_AMBIGUITY, metrics
    if not selected_candidate:
        return Reason.REDUNDANT_HYPOTHESIS, metrics
    if not target_gain:
        return Reason.INSUFFICIENT_ACOUSTIC_CORROBORATION, metrics
    return Reason.NO_CANONICAL_IMPROVEMENT, metrics


def _evaluate(preprocessing, plan, baseline, accepted, candidate, current, before, settings, boundary_alignment):
    from .coverage import _valid_result, assess_canonical_coverage
    from .reconciliation import _safe_provenance, reconcile_transcript

    trial = after = None
    metrics = {}
    failure = candidate.failure
    reason = RecoveryAdmissionReason.INVALID_CANDIDATE
    try:
        if failure is not None:
            return RecoveryAdmissionDecision.FAILED, reason, failure, None, None, metrics
        _require(_valid_result(candidate))
        provenance = _safe_provenance(candidate.candidate.provenance)
        _require(provenance.provider == "openrouter" and provenance.requested_model == settings.audio_asr_model
                 == "openai/whisper-large-v3" and settings.audio_asr_language == "vi"
                 and all(k != "language" or v == "vi" for k, v in provenance.inference_config))
        trial = reconcile_transcript(plan, (*baseline, *accepted, candidate), settings,
                                     boundary_alignment=boundary_alignment)
        after = assess_canonical_coverage(preprocessing, plan, baseline, (*accepted, candidate), trial, settings)
        _final_contract(after, plan)
        # Reuse the unchanged downstream validator without invoking correction.
        from .correction import _handoff

        _handoff(trial, after)
        reason, metrics = _admission(current, before, trial, after, candidate.chunk.chunk_id,
                                     candidate.chunk.core_interval)
        admitted = reason in (RecoveryAdmissionReason.NEW_SUPPORTED_SPEECH,
                              RecoveryAdmissionReason.RESOLVED_CANONICAL_AMBIGUITY)
        return (RecoveryAdmissionDecision.ACCEPTED if admitted else RecoveryAdmissionDecision.REJECTED,
                reason, None, trial if admitted else None, after if admitted else None, metrics)
    except AudioProcessingError as error:
        failure = AsrErrorCategory.RESOURCE if error.category == "RESOURCE" else AsrErrorCategory.MALFORMED_OUTPUT
        reason = (RecoveryAdmissionReason.RESOURCE_LIMIT if failure is AsrErrorCategory.RESOURCE
                  else RecoveryAdmissionReason.INVALID_CANDIDATE)
        traceback.clear_frames(error.__traceback__)
    finally:
        preprocessing = baseline = accepted = candidate = current = before = trial = after = None
    return RecoveryAdmissionDecision.FAILED, reason, failure, None, None, metrics


def _provenance(plan, initial_plan, final, attempts, started_ns):
    Decision, Reason = RecoveryAdmissionDecision, RecoveryAdmissionReason
    accepted = tuple(a for a in attempts if a.admission is Decision.ACCEPTED)
    return replace(
        initial_plan.provenance, actual_attempt_count=len(attempts), accepted_attempt_count=len(accepted),
        rejected_attempt_count=sum(a.admission is Decision.REJECTED for a in attempts),
        failed_attempt_count=sum(a.admission is Decision.FAILED for a in attempts),
        total_requested_samples=sum(a.requested_samples for a in attempts),
        accepted_recovery_result_count=len(accepted),
        remaining_actionable_region_count=sum(_risk(r) is not None for r in final.regions),
        target_resolved_samples=sum(a.unresolved_samples_before - a.unresolved_samples_after for a in accepted),
        canonical_support_gain_samples=sum(a.new_canonical_supported_speech_samples for a in accepted),
        canonical_ambiguity_reduction_samples=sum(a.resolved_ambiguity_samples for a in accepted),
        rejected_regression_count=sum(a.admission is Decision.REJECTED and a.admission_reason in (
            Reason.CANONICAL_REGRESSION, Reason.NEW_CONFLICT, Reason.NEW_AMBIGUITY, Reason.UNSUPPORTED_TEXT_RISK,
        ) for a in attempts),
        rejected_redundancy_count=sum(a.admission_reason is Reason.REDUNDANT_HYPOTHESIS for a in attempts),
        execution_duration_ns=time.monotonic_ns() - started_ns,
    )


def _recover(preprocessing, plan, baseline_results, transcriber, settings, boundary_alignment):
    _require(settings.audio_asr_model == "openai/whisper-large-v3" and settings.audio_asr_language == "vi")
    started, started_ns = time.monotonic(), time.monotonic_ns()
    initial, current, final = _baseline_state(preprocessing, plan, baseline_results, settings, boundary_alignment)
    initial_final = final
    initial_plan = plan_recovery_windows(final, plan, settings, boundary_alignment=boundary_alignment)
    configuration = initial_plan.provenance.effective_configuration
    roots = sorted((r.interval for r in initial_plan.target_regions), key=lambda i: i.start_sample)
    root_ends = [r.end_sample for r in roots]
    counts, samples, rejections = [0] * len(roots), [0] * len(roots), [0] * len(roots)
    blocked = set()
    seen = {c.request_interval for c in plan.chunks}
    accepted, attempts = (), []
    total_samples = 0
    evaluation_failure = None
    stop = RecoveryStopReason.NO_ACTIONABLE_REGIONS
    while roots:
        _, regions, forced, natural = _planning_context(final, plan, settings, boundary_alignment)
        if not regions:
            stop = RecoveryStopReason.SUFFICIENT_COVERAGE
            break
        if len(attempts) >= configuration["max_total_attempts"]:
            stop = RecoveryStopReason.TOTAL_ATTEMPT_LIMIT
            break
        proposed = None
        owners = ()
        for window in _iter_windows(regions, plan, configuration, forced, natural):
            target = window.target_region.interval
            index = bisect_left(root_ends, target.start_sample + 1)
            own = []
            while index < len(roots) and roots[index].start_sample < target.end_sample:
                own.append(index)
                index += 1
            if not own or any(i in blocked for i in own) or window.chunk.request_interval in seen:
                continue
            if any(counts[i] >= configuration["max_attempts_per_region"] for i in own):
                stop = RecoveryStopReason.REGION_ATTEMPT_LIMIT
                blocked.update(own)
                continue
            length = window.chunk.request_interval.end_sample - window.chunk.request_interval.start_sample
            if any(samples[i] + length > configuration["max_request_samples_per_region"] for i in own):
                stop = RecoveryStopReason.REGION_SAMPLE_LIMIT
                blocked.update(own)
                continue
            proposed, owners = window, tuple(own)
            break
        if proposed is None:
            if not attempts:
                if stop is RecoveryStopReason.NO_ACTIONABLE_REGIONS:
                    stop = RecoveryStopReason.NO_DISTINCT_WINDOW
            elif stop not in (RecoveryStopReason.REGION_ATTEMPT_LIMIT, RecoveryStopReason.REGION_SAMPLE_LIMIT,
                              RecoveryStopReason.TERMINAL_FAILURE):
                stop = (RecoveryStopReason.CANONICAL_REGRESSION_PREVENTED
                        if any(a.admission_reason is RecoveryAdmissionReason.CANONICAL_REGRESSION for a in attempts)
                        else RecoveryStopReason.NO_ADMISSIBLE_IMPROVEMENT)
            break
        length = proposed.chunk.request_interval.end_sample - proposed.chunk.request_interval.start_sample
        if total_samples + length > configuration["max_total_request_samples"]:
            stop = RecoveryStopReason.TOTAL_SAMPLE_LIMIT
            break
        if time.monotonic() - started + configuration["provider_timeout_seconds"] > configuration["max_wall_time_seconds"]:
            stop = RecoveryStopReason.WALL_TIME_LIMIT
            break
        # T03 owns the actual provider boundary and total-call accounting. This
        # optional preflight prevents extraction/submission after its budget ends.
        preflight = getattr(transcriber, "validate_recovery_request", None)
        if callable(preflight):
            try:
                preflight()
            except AsrError:
                stop = RecoveryStopReason.TERMINAL_FAILURE
                break
        number = len(attempts)
        window = replace(proposed, chunk=replace(proposed.chunk, chunk_id=f"recovery-{number:06d}",
                                                ordinal=len(plan.chunks) + number),
                         attempt_index=max(counts[i] for i in owners) + 1)
        # Complete source/WAV/window preflight before the actual request. Failures
        # here are global handoff faults, not fictional initiated provider calls.
        _validate_execution_windows((window,), preprocessing.normalized_artifact, transcriber, settings)
        if time.monotonic() - started + configuration["provider_timeout_seconds"] > configuration["max_wall_time_seconds"]:
            stop = RecoveryStopReason.WALL_TIME_LIMIT
            break
        before = _remaining(final, window.target_region.interval)
        global_before = _length(_stream(final, "speech-risk"))
        covered_before = final.quality.likely_speech_with_canonical_text_samples
        call_started = time.monotonic_ns()
        evidence, = execute_asr_windows((window,), preprocessing.normalized_artifact, transcriber, settings)
        duration = time.monotonic_ns() - call_started
        seen.add(window.chunk.request_interval)
        total_samples += length
        for i in owners:
            counts[i] += 1
            samples[i] += length
        decision, reason, failure, trial, assessment, metrics = _evaluate(
            preprocessing, plan, baseline_results, accepted, evidence, current, final, settings, boundary_alignment)
        progress = decision is RecoveryAdmissionDecision.ACCEPTED
        if progress:
            accepted = (*accepted, evidence)
            current, final = trial, assessment
        disposition = None
        terminal = failure in _GLOBAL_FAILURES
        if reason is RecoveryAdmissionReason.RESOURCE_LIMIT:
            evaluation_failure = AsrErrorCategory.RESOURCE
        if failure is not None and failure not in _TRANSIENT:
            disposition = stop = RecoveryStopReason.TERMINAL_FAILURE
            blocked.update(owners)
        elif decision is RecoveryAdmissionDecision.REJECTED:
            for i in owners:
                rejections[i] += 1
            if any(rejections[i] >= 2 for i in owners):
                blocked.update(owners)
                disposition = stop = RecoveryStopReason.NO_ADMISSIBLE_IMPROVEMENT
        after = _remaining(final, window.target_region.interval)
        if not _remaining(final):
            disposition = stop = RecoveryStopReason.SUFFICIENT_COVERAGE
        attempts.append(RecoveryAttempt(
            window, failure, before, after,
            final.quality.likely_speech_with_canonical_text_samples - covered_before,
            progress, disposition, decision, reason, global_before, _length(_stream(final, "speech-risk")),
            **metrics, requested_samples=length, request_duration_ns=duration,
        ))
        # No rejected candidate/graph survives this iteration or enters the next.
        evidence = trial = assessment = None
        if terminal:
            break
    provenance = _provenance(plan, initial_plan, final, attempts, started_ns)
    return SpeechRecoveryResult(baseline_results, accepted, initial, final, tuple(attempts), stop,
                                provenance, initial_final, current, evaluation_failure)


def recover_speech(
    preprocessing: PreprocessingResult, plan: AsrChunkPlan,
    baseline_results: tuple[AsrChunkResult, ...], transcriber: AsrTranscriber, settings: Settings,
    *, boundary_alignment: "BoundaryAlignmentReport | None" = None,
) -> SpeechRecoveryResult:
    """Borrow audio/providers; execute one distinct observation and one trial at a time."""
    category = "VALIDATION"
    cancellation = None
    try:
        return _recover(preprocessing, plan, baseline_results, transcriber, settings, boundary_alignment)
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
        preprocessing = baseline_results = transcriber = settings = boundary_alignment = None
    if cancellation is not None:
        raise cancellation.with_traceback(None)
    raise AudioProcessingError(category)
