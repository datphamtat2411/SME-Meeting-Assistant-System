"""Versioned acoustic planning on an immutable, complete source sample timeline."""

import math
from bisect import bisect_right
from collections import deque
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
from sme_meeting_ai.audio.speech_map import _validate_contracts, _validate_frame
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
_PLANNER_VERSION = "speech-aware-v2"


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
class AcousticBoundaryDecision:
    boundary_sample: int
    reason: ChunkBoundaryReason
    protected: bool
    uncertain: bool
    candidate_gap: SampleInterval | None = None


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
    boundary_decisions: tuple[AcousticBoundaryDecision, ...] = ()
    protected_intervals: tuple[SampleInterval, ...] = ()
    uncertain_intervals: tuple[SampleInterval, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "chunks", tuple(self.chunks))
        for name in ("boundary_decisions", "protected_intervals", "uncertain_intervals"):
            object.__setattr__(self, name, tuple(getattr(self, name)))


def _require(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("VALIDATION")


def _request_limits(
    settings: Settings, effective_payload_limit: int | None = None,
    provider_max_request_samples: int = 230400000,
) -> Mapping[str, int]:
    """Validate shared request bounds, independently of baseline cut feasibility.

    Recovery windows do not require a frame-grid core plus baseline forced context.
    They still obey these same duration, configured geometry and upload limits.
    """
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
    payload = settings.audio_asr_max_payload_bytes
    _require(type(payload) is int and 0 < payload <= 26214400)
    if effective_payload_limit is not None:
        _require(type(effective_payload_limit) is int and 0 < effective_payload_limit <= 26214400)
        payload = min(payload, effective_payload_limit)
    payload = min(payload, 25000000)  # T02 OpenRouter multipart upload ceiling.
    _require(type(provider_max_request_samples) is int and 0 < provider_max_request_samples <= 230400000)
    configuration.update({
        "configured_max_request_samples": maximum,
        "effective_payload_limit": payload,
        "provider_max_request_samples": provider_max_request_samples,
        "max_timeline_samples": timeline_limit.numerator // timeline_limit.denominator,
    })
    configuration["max_request_samples"] = max(0, min(maximum, (payload - 44) // 2, provider_max_request_samples))
    return MappingProxyType(configuration)


def _configuration(
    settings: Settings, effective_payload_limit: int | None = None,
    provider_max_request_samples: int = 230400000,
) -> Mapping[str, int]:
    configuration = dict(_request_limits(settings, effective_payload_limit, provider_max_request_samples))
    maximum = configuration["max_request_samples"]
    target, overlap = configuration["target_core_samples"], configuration["overlap_samples"]
    forced = min(16000, overlap // 2)
    if maximum - 2 * forced <= 0:
        raise AudioProcessingError("RESOURCE")
    configuration.update({
        "max_request_samples": maximum,
        "max_core_samples": maximum - 2 * forced,
        "natural_context_samples": min(1600, overlap // 2),
        "forced_context_samples": forced,
        "minimum_progress_samples": max(1, min(80000, target // 2, (maximum - 2 * forced) // 2)),
        "minimum_gap_samples": 3200, "gap_margin_samples": 800,
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
    """Historical v1/native geometry only; never used for production V2 plans."""
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
            provenance.planner_version in ("1", _PLANNER_VERSION, "whole-file-v1")
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
        if provenance.planner_version == _PLANNER_VERSION:
            _validate_v2(plan)
            return
        if provenance.planner_version == "whole-file-v1":
            # A native request has its own truthful geometry and eligibility
            # snapshot; relabeling arbitrary legacy geometry is never sufficient.
            count = plan.sample_count
            expected = {
                "target_core_samples": count, "max_request_samples": count,
                "overlap_samples": 0, "boundary_search_samples": 0, "max_chunks": 1,
                "max_core_samples": count, "left_context_samples": 0,
                "right_context_samples": 0, "minimum_progress_samples": count,
                "expected_wav_bytes": 44 + count * 2,
            }
            _require(set(configuration) == set(expected) | {
                "max_timeline_samples", "native_max_samples", "effective_payload_limit",
            })
            _require(all(type(configuration[key]) is int and configuration[key] == value
                         for key, value in expected.items()))
            for key in ("max_timeline_samples", "native_max_samples"):
                _require(type(configuration[key]) is int and count <= configuration[key] <= 230400000)
            limit = configuration["effective_payload_limit"]
            _require(type(limit) is int and expected["expected_wav_bytes"] <= limit <= 26214400)
            _require(len(plan.chunks) == 1)
            _require(not plan.boundary_decisions and not plan.protected_intervals and not plan.uncertain_intervals)
            _validate_plan(plan, configuration)
            return
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


def _context(reason: ChunkBoundaryReason, configuration: Mapping[str, int]) -> int:
    if reason is ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE:
        return configuration["natural_context_samples"]
    if reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH:
        return configuration["forced_context_samples"]
    _require(reason in (ChunkBoundaryReason.TIMELINE_START, ChunkBoundaryReason.TIMELINE_END))
    return 0


def _boundary_window(start, sample_count, configuration):
    """Preferred target is a preference; hard request/context bounds take priority."""
    minimum = configuration["minimum_progress_samples"]
    target = min(start + configuration["target_core_samples"],
                 start + configuration["max_core_samples"], sample_count - minimum)
    lower = max(start + minimum, target - configuration["boundary_search_samples"])
    upper = min(target + configuration["boundary_search_samples"],
                start + configuration["max_core_samples"], sample_count - minimum)
    _require(lower <= upper)
    return target, lower, upper


def _forced_boundary_window(start, sample_count, configuration):
    target, lower, upper = _boundary_window(start, sample_count, configuration)
    if ((lower + 511) // 512) * 512 > upper:
        # A capped or sub-frame preferred window can contain no actual VAD frame.
        # Use its preceding real frame if progress/tail bounds permit it. Only
        # when none exists may a real following frame leave a short final tail.
        earlier = upper // 512 * 512
        if earlier >= start + configuration["minimum_progress_samples"]:
            lower = upper = earlier
        else:
            following = ((lower + 511) // 512) * 512
            if following > min(start + configuration["max_core_samples"], sample_count - 1):
                raise AudioProcessingError("RESOURCE")
            lower = upper = following
    return target, lower, upper


class _IntervalIndex:
    def __init__(self, intervals):
        self.intervals = intervals
        self.starts = tuple(i.start_sample for i in intervals)

    def contains(self, sample):
        index = bisect_right(self.starts, sample) - 1
        return index >= 0 and sample < self.intervals[index].end_sample

    def intersects(self, interval):
        index = bisect_right(self.starts, interval.end_sample - 1) - 1
        return index >= 0 and self.intervals[index].end_sample > interval.start_sample


class _AcousticFrontier:
    """One replay; monotone range-min frontier bounded by the search window.

    Each frame-start uses that frame's observations. Protection risk is
    2*protected + uncertain (0..3), preferring uncertainty over protected speech.
    Probability and linear RMS normalize to exact binary rational values in [0,1]
    without lossy decimal buckets. RMS orders energy monotonically; zero needs no
    logarithm. The shared validator accepts -inf dBFS only with RMS exactly zero.

    Dominated candidates expire permanently. Equal-score positions are advanced
    toward the monotonically increasing target. Time is O(frames + queries), plus
    interval-index lookups; storage is interval metadata and a bounded frontier
    of at most ceil((2*search+1)/frame_samples)+1 candidates, never PCM.
    """

    def __init__(self, result, protected, uncertain):
        self.evidence = result.speech_evidence
        self.contract = _validate_contracts(result.normalized_artifact, self.evidence)
        _require(self.contract[0] == 512)  # Existing locked Silero frame geometry.
        self.protected, self.uncertain = protected, uncertain
        self.frames = iter(self.evidence.iter_frames())
        self.position = self.count = 0
        self.labels = {}
        self.frontier = deque()
        self.pending = None

    def _read(self):
        frame = next(self.frames, None)
        if frame is not None:
            _require(self.count < self.evidence.frame_count)
            _validate_frame(frame, self.position, self.evidence.sample_count, *self.contract)
            self.position, self.count = frame.end_sample, self.count + 1
            self.labels[frame.vad_label.value] = self.labels.get(frame.vad_label.value, 0) + 1
        return frame

    def best(self, lower, upper, target):
        self._expire(lower)
        if self.pending is None:
            self.pending = self._read()
        while self.pending is not None and self.pending.start_sample <= upper:
            frame = self.pending
            sample = frame.start_sample
            if sample >= lower:
                key = (2 * int(self.protected.contains(sample)) + int(self.uncertain.contains(sample)),
                       Fraction(float(frame.vad_probability)), Fraction(float(frame.rms)))
                while self.frontier and self.frontier[-1][0] > key:
                    self.frontier.pop()
                if self.frontier and self.frontier[-1][0] == key:
                    positions = self.frontier[-1][1]
                    # Older equal-score positions below target can never win a
                    # later query either. Keep only the nearest such position.
                    while positions and sample <= target:
                        positions.pop()
                    positions.append(sample)
                else:
                    self.frontier.append((key, deque((sample,))))
            self.pending = self._read()
        self._expire(lower)
        _require(bool(self.frontier))
        positions = self.frontier[0][1]
        while len(positions) > 1 and abs(positions[1] - target) < abs(positions[0] - target):
            positions.popleft()
        return positions[0]

    def _expire(self, lower):
        while self.frontier:
            positions = self.frontier[0][1]
            while positions and positions[0] < lower:
                positions.popleft()
            if positions:
                break
            self.frontier.popleft()

    def finish(self):
        # Validate even frames after the last search, with no frame retention.
        self.pending = None
        while self._read() is not None:
            pass
        _require(self.count == self.evidence.frame_count and self.position == self.evidence.sample_count)
        for label, expected in (
            ("likely-speech", self.evidence.likely_speech_frame_count),
            ("likely-non-speech", self.evidence.likely_non_speech_frame_count),
            ("uncertain", self.evidence.uncertain_frame_count),
        ):
            _require(self.labels.get(label, 0) == expected)

    def close(self):
        close = getattr(self.frames, "close", None)
        if close is not None:
            close()  # Close our reader only; never the borrowed artifact.


def _validate_v2(plan: AsrChunkPlan) -> None:
    c = plan.provenance.effective_configuration
    keys = {
        "target_core_samples", "configured_max_request_samples", "max_request_samples", "overlap_samples",
        "boundary_search_samples", "max_chunks", "max_timeline_samples", "effective_payload_limit",
        "provider_max_request_samples", "max_core_samples", "natural_context_samples",
        "forced_context_samples", "minimum_progress_samples", "minimum_gap_samples", "gap_margin_samples",
    }
    _require(set(c) == keys)
    _require(all(type(value) is int and 0 <= value <= 230400000 for value in c.values()))
    target, configured, overlap = c["target_core_samples"], c["configured_max_request_samples"], c["overlap_samples"]
    _require(0 < target and overlap < configured and target + overlap <= configured
             and c["boundary_search_samples"] < target and 0 < c["max_chunks"] <= 65536
             and 0 < plan.sample_count <= c["max_timeline_samples"] <= 230400000
             and 44 < c["effective_payload_limit"] <= 25000000
             and 0 < c["provider_max_request_samples"] <= 230400000)
    maximum = min(configured, (c["effective_payload_limit"] - 44) // 2, c["provider_max_request_samples"])
    forced = min(16000, overlap // 2)
    expected = {
        "max_request_samples": maximum, "max_core_samples": maximum - 2 * forced,
        "forced_context_samples": forced, "natural_context_samples": min(1600, overlap // 2),
        "minimum_progress_samples": max(1, min(80000, target // 2, (maximum - 2 * forced) // 2)),
        "minimum_gap_samples": 3200, "gap_margin_samples": 800,
    }
    _require(maximum > 2 * forced and all(c[key] == value for key, value in expected.items()))
    normalization = plan.provenance.preprocessing.normalization
    _require(plan.provenance.preprocessing.detection.effective_configuration.get("frame_samples") == 512)
    _require(all(isinstance(v, str) and bool(v.strip()) for v in (
        normalization.normalizer_version, normalization.decoder, normalization.decoder_version,
    )))
    _require(all(normalization.target_format.get(key) == value for key, value in {
        "container": "wav", "codec": "pcm_s16le", "sample_format": "s16", "sample_rate_hz": 16000, "channels": 1,
    }.items()))
    for intervals in (plan.protected_intervals, plan.uncertain_intervals):
        _require(isinstance(intervals, tuple))
        previous = -1
        for interval in intervals:
            _require(isinstance(interval, SampleInterval)
                     and type(interval.start_sample) is int and type(interval.end_sample) is int
                     and previous < interval.start_sample < interval.end_sample <= plan.sample_count)
            previous = interval.end_sample
    protected, uncertain = _IntervalIndex(plan.protected_intervals), _IntervalIndex(plan.uncertain_intervals)
    _require(0 < len(plan.chunks) <= c["max_chunks"] and len(plan.boundary_decisions) == len(plan.chunks) - 1)
    position, reason = 0, ChunkBoundaryReason.TIMELINE_START
    for ordinal, chunk in enumerate(plan.chunks):
        _require(isinstance(chunk, AsrChunk))
        core, request = chunk.core_interval, chunk.request_interval
        _require(all(isinstance(i, SampleInterval) and type(i.start_sample) is int and type(i.end_sample) is int
                     for i in (core, request)))
        size = core.end_sample - core.start_sample
        final = ordinal == len(plan.chunks) - 1
        _require(type(chunk.ordinal) is int and chunk.ordinal == ordinal and chunk.chunk_id == f"chunk-{ordinal:06d}"
                 and chunk.start_boundary_reason is reason and core.start_sample == position
                 and 0 < size <= c["max_core_samples"]
                 and 0 <= request.start_sample <= core.start_sample < core.end_sample <= request.end_sample <= plan.sample_count
                 and request.start_sample == max(0, position - _context(reason, c))
                 and request.end_sample == min(plan.sample_count, core.end_sample + _context(chunk.end_boundary_reason, c))
                 and request.end_sample - request.start_sample <= maximum
                 and 44 + 2 * (request.end_sample - request.start_sample) <= c["effective_payload_limit"])
        if final:
            _require(chunk.end_boundary_reason is ChunkBoundaryReason.TIMELINE_END)
            if ordinal and size < c["minimum_progress_samples"]:
                previous_start = plan.chunks[ordinal - 1].core_interval.start_sample
                _, lower, upper = _boundary_window(previous_start, plan.sample_count, c)
                _require(reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH
                         and ((lower + 511) // 512) * 512 > upper)
        else:
            _require(size >= c["minimum_progress_samples"])
            _, lower, upper = (_forced_boundary_window(position, plan.sample_count, c)
                               if chunk.end_boundary_reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH
                               else _boundary_window(position, plan.sample_count, c))
            _require(lower <= core.end_sample <= upper)
            decision = plan.boundary_decisions[ordinal]
            _require(isinstance(decision, AcousticBoundaryDecision)
                     and type(decision.boundary_sample) is int and decision.boundary_sample == core.end_sample
                     and decision.reason is chunk.end_boundary_reason
                     and type(decision.protected) is bool and decision.protected == protected.contains(core.end_sample)
                     and type(decision.uncertain) is bool and decision.uncertain == uncertain.contains(core.end_sample))
            if decision.reason is ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE:
                gap = decision.candidate_gap
                _require(isinstance(gap, SampleInterval) and 0 <= gap.start_sample < gap.end_sample <= plan.sample_count
                         and gap.end_sample - gap.start_sample >= 3200
                         and gap.start_sample + 800 < core.end_sample < gap.end_sample - 800
                         and not protected.intersects(gap) and not uncertain.intersects(gap))
                _require(gap.start_sample == 0 or protected.contains(gap.start_sample - 1)
                         or uncertain.contains(gap.start_sample - 1))
                _require(gap.end_sample == plan.sample_count or protected.contains(gap.end_sample)
                         or uncertain.contains(gap.end_sample))
            else:
                _require(decision.reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH
                         and decision.candidate_gap is None and forced > 0 and core.end_sample % 512 == 0)
        position, reason = core.end_sample, chunk.end_boundary_reason
    _require(position == plan.sample_count)


class SpeechAwareAsrChunkPlanner:
    """Read-only planning on the original absolute, integer sample timeline."""

    def __init__(self, settings: Settings):
        category = None
        try:
            self._configuration = _configuration(settings)
            self._settings = settings.model_copy(deep=True)
            return
        except AudioProcessingError as error:
            category = error.category
        except (AttributeError, TypeError, ValueError, OverflowError):
            category = "VALIDATION"
        raise AudioProcessingError(category)

    def plan(
        self, result: PreprocessingResult, *, effective_payload_limit: int | None = None,
        provider_max_request_samples: int = 230400000,
    ) -> AsrChunkPlan:
        category = None
        try:
            configuration = _configuration(self._settings, effective_payload_limit, provider_max_request_samples)
            return self._plan(result, configuration)
        except AudioProcessingError as error:
            category = error.category
        except MemoryError:
            category = "RESOURCE"
        except (AttributeError, TypeError, ValueError, KeyError, OverflowError, OSError):
            category = "VALIDATION"
        # No input-bearing exception context or partial plan escapes.
        raise AudioProcessingError(category)

    def _plan(self, result: PreprocessingResult, configuration: Mapping[str, int]) -> AsrChunkPlan:
        _validate_handoff(result)
        sample_count = result.normalized_artifact.sample_count
        maximum = configuration["max_core_samples"]
        if (
            sample_count > configuration["max_timeline_samples"]
            or (sample_count + maximum - 1) // maximum > configuration["max_chunks"]
        ):
            raise AudioProcessingError("RESOURCE")
        candidates = _silence_candidates(result)
        protected = _IntervalIndex(result.speech_map.protected_intervals)
        uncertain = _IntervalIndex(result.speech_map.uncertain_intervals)
        candidate_index = 0
        chunks, decisions = [], []
        start = 0
        start_reason = ChunkBoundaryReason.TIMELINE_START
        frames = _AcousticFrontier(result, protected, uncertain)
        try:
            while start < sample_count:
                if len(chunks) >= configuration["max_chunks"]:
                    raise AudioProcessingError("RESOURCE")
                if sample_count - start <= maximum:
                    end = sample_count
                    end_reason = ChunkBoundaryReason.TIMELINE_END
                else:
                    target, lower, upper = _boundary_window(start, sample_count, configuration)
                    while candidate_index < len(candidates) and candidates[candidate_index].end_sample <= lower:
                        candidate_index += 1
                    best = None
                    index = candidate_index
                    while index < len(candidates) and candidates[index].start_sample <= upper:
                        gap = candidates[index]
                        first, last = max(lower, gap.start_sample + 801), min(upper, gap.end_sample - 801)
                        if gap.end_sample - gap.start_sample >= 3200 and first <= last:
                            cut = max(first, min((gap.start_sample + gap.end_sample) // 2, last))
                            rank = (abs(cut - target), -(gap.end_sample - gap.start_sample), cut)
                            if best is None or rank < best[0]:
                                best = (rank, gap)
                        index += 1
                    if best is None:
                        _require(configuration["forced_context_samples"] > 0)
                        target, lower, upper = _forced_boundary_window(start, sample_count, configuration)
                        end = frames.best(lower, upper, target)
                        end_reason = ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH
                        gap = None
                    else:
                        end, gap = best[0][2], best[1]
                        end_reason = ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE
                    decisions.append(AcousticBoundaryDecision(
                        end, end_reason, protected.contains(end), uncertain.contains(end), gap,
                    ))
                ordinal = len(chunks)
                chunks.append(AsrChunk(
                    chunk_id=f"chunk-{ordinal:06d}", ordinal=ordinal,
                    core_interval=SampleInterval(start, end),
                    request_interval=SampleInterval(
                        max(0, start - _context(start_reason, configuration)),
                        min(sample_count, end + _context(end_reason, configuration)),
                    ),
                    start_boundary_reason=start_reason, end_boundary_reason=end_reason,
                ))
                start, start_reason = end, end_reason
            frames.finish()
        finally:
            frames.close()
        plan = AsrChunkPlan(
            source_id=result.normalized_artifact.source_id, sample_count=sample_count,
            chunks=tuple(chunks),
            provenance=ChunkPlanningProvenance(_PLANNER_VERSION, result.provenance, configuration),
            boundary_decisions=tuple(decisions),
            protected_intervals=result.speech_map.protected_intervals,
            uncertain_intervals=result.speech_map.uncertain_intervals,
        )
        validate_asr_chunk_plan(plan)
        return plan
