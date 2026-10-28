"""File ownership, exact sample timing, and audio processing evidence."""

from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
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
