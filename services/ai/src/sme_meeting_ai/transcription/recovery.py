"""Bounded alternative-audio recovery of transient ASR evidence, before reconciliation."""

import math
import re
import time
import wave
from dataclasses import dataclass, field, replace
from enum import StrEnum
from types import MappingProxyType
from typing import Mapping

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import AudioSource, NormalizedAudioArtifact, SampleInterval
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import PreprocessingResult
from sme_meeting_ai.pipeline.preprocessing import _validate_normalization

from .asr import AsrError, AsrErrorCategory, AsrTranscriber
from .chunk_execution import AsrChunkResult, _validate_wav, execute_asr_windows
from .chunk_planning import (
    AsrChunk, AsrChunkPlan, ChunkBoundaryReason, ChunkPlanningProvenance,
    _configuration as _planning_configuration, validate_asr_chunk_plan,
)
from .coverage import (
    CoverageReason, CoverageRegion, CoverageState, SpeechCoverageAssessment,
    assess_speech_coverage, revalidate_speech_coverage,
)


class RecoveryStopReason(StrEnum):
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


@dataclass(frozen=True)
class RecoveryWindow:
    chunk: AsrChunk
    target_region: CoverageRegion
    attempt_index: int
    boundary_strategy: str
    baseline_context_ids: tuple[str, ...]
    planning: ChunkPlanningProvenance

    def __post_init__(self) -> None:
        object.__setattr__(self, "baseline_context_ids", tuple(self.baseline_context_ids))


@dataclass(frozen=True)
class RecoveryProvenance:
    recovery_version: str
    planning: ChunkPlanningProvenance
    effective_configuration: Mapping[str, int | float]
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


_STRATEGIES = ("balanced-context", "left-context", "right-context", "tight-context")
_TRANSIENT = frozenset((AsrErrorCategory.TIMEOUT, AsrErrorCategory.TRANSPORT))
_GLOBAL_FAILURES = frozenset((AsrErrorCategory.AUTHENTICATION, AsrErrorCategory.VALIDATION,
                              AsrErrorCategory.RESOURCE, AsrErrorCategory.RATE_LIMIT))


def _require(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("VALIDATION")


def _configuration(settings: Settings) -> dict[str, int | float]:
    geometry = _planning_configuration(settings)
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
        "concurrency": 1,
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
        total_samples += length
        count, samples = regions.get(target, (0, 0))
        regions[target] = (count + 1, samples + length)
        _require(count + 1 <= configuration["max_attempts_per_region"]
                 and samples + length <= configuration["max_request_samples_per_region"])
    _require(total_samples <= configuration["max_total_request_samples"])
    with wave.open(str(audio.path), "rb") as reader:
        _validate_wav(reader, audio.sample_count)


def _actionable(region: CoverageRegion) -> bool:
    # Silence hallucinations stay unresolved in assessment, but never justify
    # another external request without likely/uncertain acoustic evidence.
    return region.state is not CoverageState.COVERED and bool(
        region.likely_speech_samples or region.uncertain_samples
        or CoverageReason.UNCERTAIN_VAD in region.reasons
        or CoverageReason.HIGH_ENERGY_NON_SPEECH in region.reasons
    )


def _remaining(assessment: SpeechCoverageAssessment, interval: SampleInterval | None = None) -> int:
    return sum(max(0, min(r.interval.end_sample, interval.end_sample if interval else assessment.sample_count)
                   - max(r.interval.start_sample, interval.start_sample if interval else 0))
               for r in assessment.regions if _actionable(r))


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


def _plan(assessment, plan, settings):
    validate_asr_chunk_plan(plan)
    configuration = _configuration(settings)
    _require(isinstance(assessment, SpeechCoverageAssessment)
             and assessment.source_id == plan.source_id and assessment.sample_count == plan.sample_count
             and assessment.sample_rate_hz == 16000 and assessment.provenance.planning == plan.provenance)
    _require(plan.sample_count <= configuration["max_timeline_samples"])
    for region in assessment.regions:
        _require(isinstance(region, CoverageRegion) and _interval(region.interval, plan.sample_count))
    regions = tuple(sorted((r for r in assessment.regions if _actionable(r)), key=lambda r: (
        not bool(r.likely_speech_samples), r.interval.start_sample, r.interval.end_sample,
    )))
    seen = {c.request_interval for c in plan.chunks}
    maximum = configuration["max_request_samples"]
    windows = []
    core_count = 0
    if maximum:
        # Reserve context while retaining positive progress at even tiny limits.
        core_size = maximum - min(2 * configuration["context_samples"], maximum // 2)
        for region in regions[:configuration["max_total_attempts"]]:
            if core_count >= configuration["max_total_attempts"]:
                break
            start, end = region.interval.start_sample, region.interval.end_sample
            size = core_size
            # A whole-source request has no alternative context. Split its core
            # instead, preserving the exact original target and absolute clock.
            if start == 0 and end == plan.sample_count and end <= size and end > 1:
                size = (end + 1) // 2
            for _ in range(configuration["max_attempts_per_region"]):
                if start >= end or core_count >= configuration["max_total_attempts"]:
                    break
                core = SampleInterval(start, min(end, start + size))
                core_count += 1
                alternatives = 0
                for strategy in _STRATEGIES:
                    if alternatives >= configuration["max_attempts_per_region"]:
                        break
                    request = _request(core, plan.sample_count, configuration["context_samples"], maximum, strategy)
                    if request in seen:
                        continue
                    number = len(windows)
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
                    alternatives += 1
                    windows.append(RecoveryWindow(chunk, region, alternatives, strategy, context_ids, plan.provenance))
                    seen.add(request)
                start = core.end_sample
    return RecoveryPlan(plan.source_id, plan.sample_count, regions, tuple(windows),
                        RecoveryProvenance("1", plan.provenance, configuration))


def plan_recovery_windows(
    assessment: SpeechCoverageAssessment, plan: AsrChunkPlan, settings: Settings,
) -> RecoveryPlan:
    """Plan bounded distinct alternatives without executing or transferring ownership.

    Alternatives are bounded metadata, not authorization to exceed execution
    budgets. Targets beyond those budgets remain in the assessment unresolved.
    """
    category = "VALIDATION"
    try:
        return _plan(assessment, plan, settings)
    except AudioProcessingError as error:
        category = error.category
    except MemoryError:
        category = "RESOURCE"
    except (AttributeError, TypeError, ValueError, KeyError, OverflowError):
        pass
    raise AudioProcessingError(category)


def recover_speech(
    preprocessing: PreprocessingResult, plan: AsrChunkPlan,
    baseline_results: tuple[AsrChunkResult, ...], transcriber: AsrTranscriber, settings: Settings,
) -> SpeechRecoveryResult:
    """Revalidate each sequential alternative; success is acoustic coverage progress.

    TIMEOUT/TRANSPORT alone permit retry without progress, always on different
    audio bounds. A full existing provider timeout is reserved before starting a
    request; no detached work, unbounded thread, or client timeout mutation occurs.
    Candidates remain transient in the explicit result fields, never provenance.
    """
    started = time.monotonic()
    initial = assess_speech_coverage(preprocessing, plan, baseline_results, settings)
    recovery_plan = plan_recovery_windows(initial, plan, settings)
    configuration = recovery_plan.provenance.effective_configuration
    final = initial
    recovered, attempts = [], []
    total_samples = 0
    stop = RecoveryStopReason.NO_ACTIONABLE_REGIONS
    global_stop = False
    for region in recovery_plan.target_regions:
        if not _remaining(final, region.interval):
            continue
        region_attempts = region_samples = 0
        stop = RecoveryStopReason.NO_DISTINCT_WINDOW
        for proposed in recovery_plan.windows:
            if proposed.target_region != region:
                continue
            if not _remaining(final, proposed.chunk.core_interval):
                continue
            length = proposed.chunk.request_interval.end_sample - proposed.chunk.request_interval.start_sample
            if len(attempts) >= configuration["max_total_attempts"]:
                stop, global_stop = RecoveryStopReason.TOTAL_ATTEMPT_LIMIT, True
                break
            if total_samples + length > configuration["max_total_request_samples"]:
                stop, global_stop = RecoveryStopReason.TOTAL_SAMPLE_LIMIT, True
                break
            if time.monotonic() - started + configuration["provider_timeout_seconds"] > configuration["max_wall_time_seconds"]:
                stop, global_stop = RecoveryStopReason.WALL_TIME_LIMIT, True
                break
            if region_attempts >= configuration["max_attempts_per_region"]:
                stop = RecoveryStopReason.REGION_ATTEMPT_LIMIT
                break
            if region_samples + length > configuration["max_request_samples_per_region"]:
                stop = RecoveryStopReason.REGION_SAMPLE_LIMIT
                break
            window = replace(proposed, attempt_index=region_attempts + 1)
            before = _remaining(final, region.interval)
            covered_before = final.quality.covered_speech_samples
            try:
                evidence, = execute_asr_windows((window,), preprocessing.normalized_artifact, transcriber, settings)
            except AsrError as error:
                # A global artifact/handoff failure must also preserve all
                # completed evidence and the still-unresolved source intervals.
                evidence = AsrChunkResult(window.chunk, failure=error.category)
            recovered.append(evidence)
            region_attempts += 1
            region_samples += length
            total_samples += length
            final = revalidate_speech_coverage(preprocessing, plan, baseline_results, tuple(recovered), settings)
            after = _remaining(final, region.interval)
            delta = final.quality.covered_speech_samples - covered_before
            progress = after < before or delta > 0
            disposition = None
            if evidence.failure is not None and evidence.failure not in _TRANSIENT:
                disposition = RecoveryStopReason.TERMINAL_FAILURE
                global_stop = evidence.failure in _GLOBAL_FAILURES
            elif not after:
                disposition = RecoveryStopReason.SUFFICIENT_COVERAGE
            elif evidence.failure is None and not progress:
                disposition = RecoveryStopReason.NO_PROGRESS
            elif len(attempts) + 1 >= configuration["max_total_attempts"]:
                disposition, global_stop = RecoveryStopReason.TOTAL_ATTEMPT_LIMIT, True
            elif region_attempts >= configuration["max_attempts_per_region"]:
                disposition = RecoveryStopReason.REGION_ATTEMPT_LIMIT
            attempts.append(RecoveryAttempt(window, evidence.failure, before, after, delta, progress, disposition))
            if disposition is not None:
                stop = disposition
                break
        if global_stop:
            break
    if recovery_plan.target_regions and not _remaining(final):
        stop = RecoveryStopReason.SUFFICIENT_COVERAGE
    return SpeechRecoveryResult(baseline_results, tuple(recovered), initial, final, tuple(attempts),
                                stop, recovery_plan.provenance)
