"""File ownership, exact sample timing, and audio processing evidence."""

import struct
from collections.abc import Iterator
from dataclasses import dataclass, field
from enum import StrEnum
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from types import MappingProxyType
from typing import Mapping, Self

from .errors import AudioProcessingError


@dataclass(frozen=True)
class AudioSource:
    source_id: str
    path: Path


@dataclass(frozen=True)
class AudioProbe:
    source_id: str
    container: str
    codec: str
    sample_rate_hz: int
    channels: int
    channel_layout: str | None
    declared_duration: Fraction | None
    stream_index: int


@dataclass(frozen=True)
class AudioProvenance:
    source_id: str
    normalizer_version: str
    decoder: str
    decoder_version: str
    target_format: Mapping[str, str | int]
    effective_configuration: Mapping[str, str | int | float]


@dataclass(frozen=True)
class NormalizedAudioArtifact:
    """Owns temporary storage until close(); sample bounds are half-open."""

    path: Path
    source_id: str
    source_metadata: AudioProbe
    sample_count: int
    provenance: AudioProvenance
    _temporary: TemporaryDirectory = field(repr=False, compare=False)
    sample_rate_hz: int = field(default=16000, init=False)
    channels: int = field(default=1, init=False)
    sample_format: str = field(default="s16", init=False)

    @property
    def duration(self) -> Fraction:
        return Fraction(self.sample_count, self.sample_rate_hz)

    @property
    def start_sample(self) -> int:
        return 0

    @property
    def end_sample(self) -> int:
        return self.sample_count

    @property
    def start_time(self) -> Fraction:
        return Fraction(0)

    @property
    def end_time(self) -> Fraction:
        return self.duration

    def close(self) -> None:
        try:
            self._temporary.cleanup()
            return
        except OSError:
            pass
        raise AudioProcessingError("RESOURCE")

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type, exc_value, exc_traceback) -> None:
        self.close()


class VadLabel(StrEnum):
    """Probability-band evidence, never a ground-truth speech assertion."""

    LIKELY_SPEECH = "likely-speech"
    LIKELY_NON_SPEECH = "likely-non-speech"
    UNCERTAIN = "uncertain"


@dataclass(frozen=True)
class EvidenceFrame:
    """Absolute, half-open bounds cover real samples only; RMS is full-scale relative."""

    start_sample: int
    end_sample: int
    vad_probability: float
    vad_label: VadLabel
    rms: float
    dbfs: float
    padding_samples: int

    @property
    def start_time(self) -> Fraction:
        return Fraction(self.start_sample, 16000)

    @property
    def end_time(self) -> Fraction:
        return Fraction(self.end_sample, 16000)


@dataclass(frozen=True)
class DetectionProvenance:
    model_id: str
    model_version: str
    model_sha256: str
    backend: str
    detector_version: str
    effective_configuration: Mapping[str, str | int | float]

    def __post_init__(self) -> None:
        object.__setattr__(self, "effective_configuration", MappingProxyType(dict(self.effective_configuration)))


@dataclass(frozen=True)
class SampleInterval:
    """Absolute half-open bounds on the normalized 16 kHz sample timeline."""

    start_sample: int
    end_sample: int

    def __post_init__(self) -> None:
        if (
            type(self.start_sample) is not int or type(self.end_sample) is not int
            or not 0 <= self.start_sample < self.end_sample
        ):
            raise AudioProcessingError("VALIDATION")

    @property
    def start_time(self) -> Fraction:
        return Fraction(self.start_sample, 16000)

    @property
    def end_time(self) -> Fraction:
        return Fraction(self.end_sample, 16000)

    @property
    def duration(self) -> Fraction:
        return Fraction(self.end_sample - self.start_sample, 16000)


class SpeechMapWarning(StrEnum):
    """Evidence indicators, never definitive speech or silence classifications."""

    WEAK_SPEECH = "weak-speech"
    UNCERTAIN_VAD = "uncertain-vad"
    VAD_ENERGY_DISAGREEMENT = "vad-energy-disagreement"
    HIGH_ENERGY_NON_SPEECH = "high-energy-non-speech"
    PROTECTED_WINDOW_COALESCING = "protected-window-coalescing"


@dataclass(frozen=True)
class SpeechMapQuality:
    frame_count: int
    likely_speech_frame_count: int
    likely_non_speech_frame_count: int
    uncertain_frame_count: int
    weak_speech_frame_count: int
    high_energy_non_speech_frame_count: int
    vad_energy_disagreement_frame_count: int
    protected_window_coalescing_count: int

    @property
    def warnings(self) -> tuple[SpeechMapWarning, ...]:
        """Stable indicator ordering, derived solely from the corresponding counts."""
        return tuple(warning for warning, count in (
            (SpeechMapWarning.WEAK_SPEECH, self.weak_speech_frame_count),
            (SpeechMapWarning.UNCERTAIN_VAD, self.uncertain_frame_count),
            (SpeechMapWarning.VAD_ENERGY_DISAGREEMENT, self.vad_energy_disagreement_frame_count),
            (SpeechMapWarning.HIGH_ENERGY_NON_SPEECH, self.high_energy_non_speech_frame_count),
            (SpeechMapWarning.PROTECTED_WINDOW_COALESCING, self.protected_window_coalescing_count),
        ) if count)


@dataclass(frozen=True)
class SpeechMapProvenance:
    source_id: str
    sample_count: int
    mapper_version: str
    detector_provenance: DetectionProvenance
    effective_configuration: Mapping[str, int | float]
    sample_rate_hz: int = field(default=16000, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "effective_configuration", MappingProxyType(dict(self.effective_configuration)))


@dataclass(frozen=True)
class SpeechMap:
    """Candidate regions and protection, without silence or coverage guarantees.

    Speech intervals may bridge configured gaps between VAD candidates; uncertainty
    remains independently observable even inside detected or protected regions.
    """

    speech_intervals: tuple[SampleInterval, ...]
    protected_intervals: tuple[SampleInterval, ...]
    uncertain_intervals: tuple[SampleInterval, ...]
    quality: SpeechMapQuality
    provenance: SpeechMapProvenance

    def __post_init__(self) -> None:
        for attribute in ("speech_intervals", "protected_intervals", "uncertain_intervals"):
            object.__setattr__(self, attribute, tuple(getattr(self, attribute)))


# Internal, versioned little-endian storage; each record is 45 bytes. No PCM or
# provider payload is persisted. Doubles retain probabilities/energy on replay.
_EVIDENCE_HEADER = b"SMEEVD\x00\x01"
_EVIDENCE_RECORD = struct.Struct("<QQdddBI")
_EVIDENCE_LABELS = tuple(VadLabel)


@dataclass(frozen=True)
class SpeechEnergyEvidence:
    """Owns replayable temporary evidence, with constant-memory frame iteration."""

    source_id: str
    sample_count: int
    frame_count: int
    likely_speech_frame_count: int
    likely_non_speech_frame_count: int
    uncertain_frame_count: int
    provenance: DetectionProvenance
    _path: Path = field(repr=False, compare=False)
    _temporary: TemporaryDirectory = field(repr=False, compare=False)
    _closed: bool = field(default=False, init=False, repr=False, compare=False)

    @property
    def duration(self) -> Fraction:
        return Fraction(self.sample_count, 16000)

    def iter_frames(self) -> Iterator[EvidenceFrame]:
        """Each call opens an independent reader; close invalidates paused readers."""
        category = None
        try:
            if self._closed:
                raise AudioProcessingError("RESOURCE")
            with self._path.open("rb") as evidence:
                if evidence.read(len(_EVIDENCE_HEADER)) != _EVIDENCE_HEADER:
                    raise AudioProcessingError("RESOURCE")
                for _ in range(self.frame_count):
                    if self._closed:
                        raise AudioProcessingError("RESOURCE")
                    data = evidence.read(_EVIDENCE_RECORD.size)
                    start, end, probability, rms, dbfs, label, padding = _EVIDENCE_RECORD.unpack(data)
                    yield EvidenceFrame(start, end, probability, _EVIDENCE_LABELS[label], rms, dbfs, padding)
                if evidence.read(1):
                    raise AudioProcessingError("RESOURCE")
        except (AudioProcessingError, OSError, ValueError, IndexError, struct.error):
            category = "RESOURCE"
        if category is not None:
            raise AudioProcessingError(category)

    def close(self) -> None:
        category = None
        try:
            self._temporary.cleanup()
            object.__setattr__(self, "_closed", True)
        except OSError:
            category = "RESOURCE"
        if category is not None:
            raise AudioProcessingError(category)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type, exc_value, exc_traceback) -> None:
        self.close()
