"""Deterministic speech candidates and boundary protection from existing evidence."""

import math
from numbers import Real

from sme_meeting_ai.core.config import Settings

from .errors import AudioProcessingError
from .models import (
    DetectionProvenance,
    EvidenceFrame,
    NormalizedAudioArtifact,
    SampleInterval,
    SpeechEnergyEvidence,
    SpeechMap,
    SpeechMapProvenance,
    SpeechMapQuality,
    VadLabel,
)

_RATE = 16000
_MAPPER_VERSION = "1"


def _finite_real(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, Real):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _validate_contracts(
    audio: NormalizedAudioArtifact, evidence: SpeechEnergyEvidence,
) -> tuple[int, float, float]:
    if not isinstance(audio, NormalizedAudioArtifact) or not isinstance(evidence, SpeechEnergyEvidence):
        raise AudioProcessingError("VALIDATION")
    if (
        not isinstance(audio.source_id, str) or not 0 < len(audio.source_id) <= 1024
        or not isinstance(evidence.source_id, str) or audio.source_id != evidence.source_id
        or type(audio.sample_count) is not int or audio.sample_count < 0
        or type(evidence.sample_count) is not int or audio.sample_count != evidence.sample_count
        or type(audio.sample_rate_hz) is not int or audio.sample_rate_hz != _RATE
        or not isinstance(evidence.provenance, DetectionProvenance)
    ):
        raise AudioProcessingError("VALIDATION")

    counts = (
        evidence.frame_count, evidence.likely_speech_frame_count,
        evidence.likely_non_speech_frame_count, evidence.uncertain_frame_count,
    )
    if any(type(count) is not int or count < 0 for count in counts) or sum(counts[1:]) != counts[0]:
        raise AudioProcessingError("VALIDATION")

    configuration = evidence.provenance.effective_configuration
    rate = configuration.get("sample_rate_hz")
    frame_samples = configuration.get("frame_samples")
    speech_threshold = configuration.get("speech_threshold")
    non_speech_threshold = configuration.get("non_speech_threshold")
    if (
        type(rate) is not int or rate != _RATE
        or type(frame_samples) is not int or frame_samples <= 0
        or configuration.get("tail_padding") != "model-only-zero-padding"
        or not _finite_real(speech_threshold) or not _finite_real(non_speech_threshold)
        or not 0 <= non_speech_threshold < speech_threshold <= 1
    ):
        raise AudioProcessingError("VALIDATION")
    expected_frames = (audio.sample_count + frame_samples - 1) // frame_samples
    if evidence.frame_count != expected_frames:
        raise AudioProcessingError("VALIDATION")
    return frame_samples, speech_threshold, non_speech_threshold


def _validate_frame(
    frame: EvidenceFrame, expected_start: int, sample_count: int, frame_samples: int,
    speech_threshold: float, non_speech_threshold: float,
) -> None:
    if not isinstance(frame, EvidenceFrame):
        raise AudioProcessingError("VALIDATION")
    if (
        type(frame.start_sample) is not int or type(frame.end_sample) is not int
        or frame.start_sample != expected_start
        or not 0 <= frame.start_sample < frame.end_sample <= sample_count
        or frame.end_sample != min(frame.start_sample + frame_samples, sample_count)
        or type(frame.padding_samples) is not int
        or frame.padding_samples != frame_samples - (frame.end_sample - frame.start_sample)
    ):
        raise AudioProcessingError("VALIDATION")

    if (
        not _finite_real(frame.vad_probability) or not 0 <= frame.vad_probability <= 1
        or not isinstance(frame.vad_label, VadLabel)
        or not _finite_real(frame.rms) or not 0 <= frame.rms <= 1
        or isinstance(frame.dbfs, bool) or not isinstance(frame.dbfs, Real)
    ):
        raise AudioProcessingError("VALIDATION")
    expected_label = (
        VadLabel.LIKELY_SPEECH if frame.vad_probability >= speech_threshold
        else VadLabel.LIKELY_NON_SPEECH if frame.vad_probability <= non_speech_threshold
        else VadLabel.UNCERTAIN
    )
    if frame.vad_label != expected_label:
        raise AudioProcessingError("VALIDATION")
    if frame.rms == 0:
        if frame.dbfs != -math.inf:
            raise AudioProcessingError("VALIDATION")
    elif (
        not _finite_real(frame.dbfs) or frame.dbfs > 0
        or not math.isclose(frame.dbfs, 20 * math.log10(frame.rms), rel_tol=1e-9, abs_tol=1e-9)
    ):
        raise AudioProcessingError("VALIDATION")


def _append_interval(intervals: list[SampleInterval], start: int, end: int, gap: int = 0) -> None:
    """Coalesce already ordered intervals without altering input evidence."""
    if intervals and start - intervals[-1].end_sample <= gap:
        previous = intervals[-1]
        intervals[-1] = SampleInterval(previous.start_sample, max(previous.end_sample, end))
    else:
        intervals.append(SampleInterval(start, end))


class SpeechMapBuilder:
    """Read-only mapping of provisional evidence, with no audio ownership transfer."""

    def __init__(self, settings: Settings):
        self._padding = settings.audio_speech_map_boundary_padding_samples
        self._merge_gap = settings.audio_speech_map_merge_gap_samples
        self._energy_floor = settings.audio_speech_map_energy_floor_dbfs

    def build(self, normalized_audio: NormalizedAudioArtifact, evidence: SpeechEnergyEvidence) -> SpeechMap:
        frame_samples, speech_threshold, non_speech_threshold = _validate_contracts(normalized_audio, evidence)
        speech_intervals = []
        uncertain_intervals = []
        counts = dict.fromkeys(VadLabel, 0)
        weak_speech_count = 0
        high_energy_non_speech_count = 0
        position = 0
        # Replay errors deliberately propagate with their original resource category.
        # No result is published until the complete evidence timeline is validated.
        for frame in evidence.iter_frames():
            _validate_frame(
                frame, position, normalized_audio.sample_count, frame_samples,
                speech_threshold, non_speech_threshold,
            )
            position = frame.end_sample
            counts[frame.vad_label] += 1
            if frame.vad_label == VadLabel.LIKELY_SPEECH:
                _append_interval(speech_intervals, frame.start_sample, frame.end_sample, self._merge_gap)
                if frame.dbfs < self._energy_floor:
                    weak_speech_count += 1
            elif frame.vad_label == VadLabel.UNCERTAIN:
                _append_interval(uncertain_intervals, frame.start_sample, frame.end_sample)
            elif frame.dbfs >= self._energy_floor:
                # Energy disagreement remains uncertain; it never creates speech.
                high_energy_non_speech_count += 1
                _append_interval(uncertain_intervals, frame.start_sample, frame.end_sample)

        if (
            position != normalized_audio.sample_count
            or sum(counts.values()) != evidence.frame_count
            or counts[VadLabel.LIKELY_SPEECH] != evidence.likely_speech_frame_count
            or counts[VadLabel.LIKELY_NON_SPEECH] != evidence.likely_non_speech_frame_count
            or counts[VadLabel.UNCERTAIN] != evidence.uncertain_frame_count
        ):
            raise AudioProcessingError("VALIDATION")

        protected_intervals = []
        for interval in speech_intervals:
            _append_interval(
                protected_intervals, max(0, interval.start_sample - self._padding),
                min(normalized_audio.sample_count, interval.end_sample + self._padding),
            )
        return SpeechMap(
            speech_intervals=tuple(speech_intervals),
            protected_intervals=tuple(protected_intervals),
            uncertain_intervals=tuple(uncertain_intervals),
            quality=SpeechMapQuality(
                frame_count=evidence.frame_count,
                likely_speech_frame_count=counts[VadLabel.LIKELY_SPEECH],
                likely_non_speech_frame_count=counts[VadLabel.LIKELY_NON_SPEECH],
                uncertain_frame_count=counts[VadLabel.UNCERTAIN],
                weak_speech_frame_count=weak_speech_count,
                high_energy_non_speech_frame_count=high_energy_non_speech_count,
                vad_energy_disagreement_frame_count=weak_speech_count + high_energy_non_speech_count,
                protected_window_coalescing_count=len(speech_intervals) - len(protected_intervals),
            ),
            provenance=SpeechMapProvenance(
                source_id=normalized_audio.source_id, sample_count=normalized_audio.sample_count,
                mapper_version=_MAPPER_VERSION, detector_provenance=evidence.provenance,
                effective_configuration={
                    "boundary_padding_samples": self._padding,
                    "merge_gap_samples": self._merge_gap,
                    "energy_floor_dbfs": self._energy_floor,
                },
            ),
        )
