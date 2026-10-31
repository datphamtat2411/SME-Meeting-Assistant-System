"""Deterministic metadata-only ASR planning; evidence never removes source audio."""

import math
from dataclasses import dataclass, field, replace
from enum import StrEnum
from fractions import Fraction
from heapq import merge
from types import MappingProxyType
from typing import Mapping

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import (
    AudioProvenance,
    AudioSource,
    DetectionProvenance,
    NormalizedAudioArtifact,
    SampleInterval,
    SpeechMapProvenance,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import (
    PreprocessingAudioMetadata,
    PreprocessingProvenance,
    PreprocessingResult,
)
from sme_meeting_ai.pipeline.preprocessing import (
    _validate_detection,
    _validate_map,
    _validate_normalization,
)

_RATE = 16000
_PLANNER_VERSION = "1"


class ChunkBoundaryReason(StrEnum):
    TIMELINE_START = "timeline-start"
    NATURAL_SILENCE_CANDIDATE = "natural-silence-candidate"
    FORCED_CONTINUOUS_SPEECH = "forced-continuous-speech"
    TIMELINE_END = "timeline-end"


@dataclass(frozen=True)
class AsrChunk:
    chunk_id: str
    ordinal: int
    core_interval: SampleInterval
    request_interval: SampleInterval
    start_boundary_reason: ChunkBoundaryReason
    end_boundary_reason: ChunkBoundaryReason


@dataclass(frozen=True)
class ChunkPlanningProvenance:
    planner_version: str
    preprocessing: PreprocessingProvenance
    effective_configuration: Mapping[str, int]
    sample_rate_hz: int = field(default=_RATE, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "preprocessing", replace(self.preprocessing))
        object.__setattr__(self, "effective_configuration", MappingProxyType(dict(self.effective_configuration)))


@dataclass(frozen=True)
class AsrChunkPlan:
    source_id: str
    sample_count: int
    chunks: tuple[AsrChunk, ...]
    provenance: ChunkPlanningProvenance

    def __post_init__(self) -> None:
        object.__setattr__(self, "chunks", tuple(self.chunks))


def _require(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("VALIDATION")


def _configuration(settings: Settings) -> Mapping[str, int]:
    _require(isinstance(settings, Settings))
    configuration = {
        "target_core_samples": settings.audio_asr_chunk_target_samples,
        "max_request_samples": settings.audio_asr_chunk_max_request_samples,
        "overlap_samples": settings.audio_asr_chunk_overlap_samples,
        "boundary_search_samples": settings.audio_asr_chunk_boundary_search_samples,
        "max_chunks": settings.audio_asr_chunk_max_chunks,
    }
    # Also defend against Settings.model_copy(update=...) and later mutation.
    for key, value in configuration.items():
        minimum = 0 if key in ("overlap_samples", "boundary_search_samples") else 1
        maximum = 65536 if key == "max_chunks" else 230400000
        _require(type(value) is int and minimum <= value <= maximum)
    target = configuration["target_core_samples"]
    overlap = configuration["overlap_samples"]
    maximum = configuration["max_request_samples"]
    search = configuration["boundary_search_samples"]
    _require(overlap < maximum and target + overlap <= maximum and search < target)
    duration = settings.audio_max_duration_seconds
    _require(type(duration) in (int, float) and math.isfinite(duration) and 0 < duration <= 14400)
    # Decimal configuration is exact; never multiply or round a float timestamp.
    timeline_limit = Fraction(str(duration)) * _RATE
    configuration.update({
        "max_core_samples": maximum - overlap,
        "left_context_samples": overlap // 2,
        "right_context_samples": overlap - overlap // 2,
        "minimum_progress_samples": target - search,
        "max_timeline_samples": timeline_limit.numerator // timeline_limit.denominator,
    })
    return MappingProxyType(configuration)


def _validate_handoff(result: PreprocessingResult) -> None:
    _require(isinstance(result, PreprocessingResult))
    audio = result.normalized_artifact
    _require(isinstance(audio, NormalizedAudioArtifact))
    # Reuse published preprocessing contracts without reading files, replaying
    # evidence, invoking stages, or taking ownership of temporary artifacts.
    _validate_normalization(AudioSource(audio.source_id, audio.path), audio)
    _validate_detection(audio, result.speech_evidence)
    _validate_map(audio, result.speech_evidence, result.speech_map)
    metadata = result.audio_metadata
    _require(
        isinstance(metadata, PreprocessingAudioMetadata)
        and type(metadata.sample_count) is int and metadata.sample_count == audio.sample_count
        and type(metadata.sample_rate_hz) is int and metadata.sample_rate_hz == _RATE
        and type(metadata.channels) is int and metadata.channels == 1
        and metadata.sample_format == "s16"
        and metadata.source_metadata == audio.source_metadata
    )
    provenance = result.provenance
    _require(
        isinstance(provenance, PreprocessingProvenance)
        and isinstance(provenance.pipeline_version, str) and bool(provenance.pipeline_version.strip())
        and provenance.source_id == audio.source_id
        and type(provenance.sample_count) is int and provenance.sample_count == audio.sample_count
        and type(provenance.sample_rate_hz) is int and provenance.sample_rate_hz == _RATE
        and provenance.normalization == audio.provenance
        and provenance.detection == result.speech_evidence.provenance
        and provenance.speech_map == result.speech_map.provenance
        and result.warnings == result.speech_map.quality.warnings
    )


def _silence_candidates(result: PreprocessingResult) -> tuple[SampleInterval, ...]:
    """Complement of the union of protected/uncertain half-open intervals.

    These are provisional boundary candidates, never permission to skip samples.
    A blocked region's start is excluded; its end can begin a candidate region.
    """
    candidates = []
    blocked_end = 0
    for interval in merge(
        result.speech_map.protected_intervals, result.speech_map.uncertain_intervals,
        key=lambda item: item.start_sample,
    ):
        if blocked_end < interval.start_sample:
            candidates.append(SampleInterval(blocked_end, interval.start_sample))
        blocked_end = max(blocked_end, interval.end_sample)
    if blocked_end < result.normalized_artifact.sample_count:
        candidates.append(SampleInterval(blocked_end, result.normalized_artifact.sample_count))
    return tuple(candidates)


def _validate_plan(plan: AsrChunkPlan, configuration: Mapping[str, int]) -> None:
    """Validate the complete partition and expanded bounds before publication."""
    _require(0 < len(plan.chunks) <= configuration["max_chunks"])
    position = 0
    start_reason = ChunkBoundaryReason.TIMELINE_START
    for ordinal, chunk in enumerate(plan.chunks):
        _require(isinstance(chunk, AsrChunk))
        core, request = chunk.core_interval, chunk.request_interval
        _require(all(
            isinstance(interval, SampleInterval)
            and type(interval.start_sample) is int and type(interval.end_sample) is int
            for interval in (core, request)
        ))
        _require(
            type(chunk.ordinal) is int and chunk.ordinal == ordinal
            and chunk.chunk_id == f"chunk-{ordinal:06d}"
            and chunk.start_boundary_reason is start_reason
            and core.start_sample == position
            and 0 < core.end_sample - core.start_sample <= configuration["max_core_samples"]
            and 0 <= request.start_sample <= core.start_sample < core.end_sample <= request.end_sample <= plan.sample_count
            and request.start_sample == max(0, core.start_sample - configuration["left_context_samples"])
            and request.end_sample == min(plan.sample_count, core.end_sample + configuration["right_context_samples"])
            and request.end_sample - request.start_sample <= configuration["max_request_samples"]
        )
        if ordinal == len(plan.chunks) - 1:
            _require(chunk.end_boundary_reason is ChunkBoundaryReason.TIMELINE_END)
        else:
            _require(core.end_sample - core.start_sample >= configuration["minimum_progress_samples"])
            _require(chunk.end_boundary_reason in (
                ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE,
                ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH,
            ))
        position = core.end_sample
        start_reason = chunk.end_boundary_reason
    _require(position == plan.sample_count)


def validate_asr_chunk_plan(plan: AsrChunkPlan) -> None:
    """Validate published structure against captured rules, never new settings.

    This does not recalculate boundaries or replay preprocessing evidence.
    Execution separately validates the borrowed normalized audio and its WAV.
    """
    try:
        _require(
            isinstance(plan, AsrChunkPlan)
            and isinstance(plan.source_id, str) and bool(plan.source_id.strip())
            and type(plan.sample_count) is int and plan.sample_count > 0
            and isinstance(plan.chunks, tuple)
            and isinstance(plan.provenance, ChunkPlanningProvenance)
        )
        provenance = plan.provenance
        _require(
            provenance.planner_version == _PLANNER_VERSION
            and type(provenance.sample_rate_hz) is int and provenance.sample_rate_hz == _RATE
            and isinstance(provenance.preprocessing, PreprocessingProvenance)
        )
        preprocessing = provenance.preprocessing
        _require(
            isinstance(preprocessing.pipeline_version, str) and bool(preprocessing.pipeline_version.strip())
            and preprocessing.source_id == plan.source_id
            and type(preprocessing.sample_count) is int and preprocessing.sample_count == plan.sample_count
            and type(preprocessing.sample_rate_hz) is int and preprocessing.sample_rate_hz == _RATE
            and isinstance(preprocessing.normalization, AudioProvenance)
            and preprocessing.normalization.source_id == plan.source_id
            and isinstance(preprocessing.detection, DetectionProvenance)
            and isinstance(preprocessing.speech_map, SpeechMapProvenance)
        )
        speech_map = preprocessing.speech_map
        _require(
            speech_map.source_id == plan.source_id
            and isinstance(speech_map.mapper_version, str) and bool(speech_map.mapper_version.strip())
            and type(speech_map.sample_count) is int and speech_map.sample_count == plan.sample_count
            and type(speech_map.sample_rate_hz) is int and speech_map.sample_rate_hz == _RATE
            and speech_map.detector_provenance == preprocessing.detection
        )
        detection = preprocessing.detection
        _require(all(isinstance(value, str) and bool(value.strip()) for value in (
            detection.model_id, detection.model_version, detection.backend, detection.detector_version,
        )))
        _require(
            isinstance(detection.model_sha256, str) and len(detection.model_sha256) == 64
            and all(character in "0123456789abcdef" for character in detection.model_sha256)
        )
        configuration = provenance.effective_configuration
        for key in (
            "target_core_samples", "max_request_samples", "overlap_samples",
            "boundary_search_samples", "max_chunks", "max_timeline_samples",
        ):
            value = configuration[key]
            minimum = 0 if key in ("overlap_samples", "boundary_search_samples") else 1
            maximum = 65536 if key == "max_chunks" else 230400000
            _require(type(value) is int and minimum <= value <= maximum)
        target, maximum = configuration["target_core_samples"], configuration["max_request_samples"]
        overlap, search = configuration["overlap_samples"], configuration["boundary_search_samples"]
        _require(overlap < maximum and target + overlap <= maximum and search < target)
        for key, expected in {
            "max_core_samples": maximum - overlap,
            "left_context_samples": overlap // 2,
            "right_context_samples": overlap - overlap // 2,
            "minimum_progress_samples": target - search,
        }.items():
            _require(type(configuration[key]) is int and configuration[key] == expected)
        _require(plan.sample_count <= configuration["max_timeline_samples"])
        _validate_plan(plan, configuration)
        return
    except (AudioProcessingError, AttributeError, TypeError, ValueError, KeyError, OverflowError):
        pass
    raise AudioProcessingError("VALIDATION")


class SpeechAwareAsrChunkPlanner:
    """Read-only planning on the original absolute, integer sample timeline."""

    def __init__(self, settings: Settings):
        category = None
        try:
            self._configuration = _configuration(settings)
            return
        except AudioProcessingError as error:
            category = error.category
        except (AttributeError, TypeError, ValueError, OverflowError):
            category = "VALIDATION"
        raise AudioProcessingError(category)

    def plan(self, result: PreprocessingResult) -> AsrChunkPlan:
        category = None
        try:
            return self._plan(result)
        except AudioProcessingError as error:
            category = error.category
        except MemoryError:
            category = "RESOURCE"
        except (AttributeError, TypeError, ValueError, KeyError, OverflowError):
            category = "VALIDATION"
        # No input-bearing exception context or partial plan escapes.
        raise AudioProcessingError(category)

    def _plan(self, result: PreprocessingResult) -> AsrChunkPlan:
        _validate_handoff(result)
        configuration = self._configuration
        sample_count = result.normalized_artifact.sample_count
        maximum = configuration["max_core_samples"]
        if (
            sample_count > configuration["max_timeline_samples"]
            or (sample_count + maximum - 1) // maximum > configuration["max_chunks"]
        ):
            raise AudioProcessingError("RESOURCE")
        candidates = _silence_candidates(result)
        candidate_index = 0
        chunks = []
        start = 0
        start_reason = ChunkBoundaryReason.TIMELINE_START
        while start < sample_count:
            if len(chunks) >= configuration["max_chunks"]:
                raise AudioProcessingError("RESOURCE")
            if sample_count - start <= maximum:
                end = sample_count
                end_reason = ChunkBoundaryReason.TIMELINE_END
            else:
                target = start + configuration["target_core_samples"]
                lower = target - configuration["boundary_search_samples"]
                upper = min(target + configuration["boundary_search_samples"], start + maximum)
                while candidate_index < len(candidates) and candidates[candidate_index].end_sample <= lower:
                    candidate_index += 1
                best = None
                index = candidate_index
                while index < len(candidates) and candidates[index].start_sample <= upper:
                    interval = candidates[index]
                    first = max(lower, interval.start_sample)
                    last = min(upper, interval.end_sample - 1)
                    if first <= last:
                        boundary = max(first, min(target, last))
                        candidate = (abs(boundary - target), boundary)
                        if best is None or candidate < best:
                            best = candidate
                    index += 1
                if best is None:
                    end = start + maximum
                    end_reason = ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH
                else:
                    end = best[1]
                    end_reason = ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE
            ordinal = len(chunks)
            chunks.append(AsrChunk(
                chunk_id=f"chunk-{ordinal:06d}", ordinal=ordinal,
                core_interval=SampleInterval(start, end),
                request_interval=SampleInterval(
                    max(0, start - configuration["left_context_samples"]),
                    min(sample_count, end + configuration["right_context_samples"]),
                ),
                start_boundary_reason=start_reason, end_boundary_reason=end_reason,
            ))
            start, start_reason = end, end_reason
        plan = AsrChunkPlan(
            source_id=result.normalized_artifact.source_id, sample_count=sample_count,
            chunks=tuple(chunks),
            provenance=ChunkPlanningProvenance(_PLANNER_VERSION, result.provenance, configuration),
        )
        validate_asr_chunk_plan(plan)
        return plan
