"""Transport-independent terminal outcomes and explicit temporary artifact ownership."""

from contextlib import ExitStack
from dataclasses import dataclass, field, replace
from enum import StrEnum
from fractions import Fraction
from types import MappingProxyType
from typing import Mapping, Self

from sme_meeting_ai.audio.errors import AudioErrorCategory, AudioProcessingError
from sme_meeting_ai.audio.models import (
    AudioProbe,
    AudioProvenance,
    DetectionProvenance,
    NormalizedAudioArtifact,
    SpeechEnergyEvidence,
    SpeechMap,
    SpeechMapProvenance,
    SpeechMapWarning,
)


class PreprocessingStatus(StrEnum):
    COMPLETED = "COMPLETED"
    COMPLETED_WITH_WARNINGS = "COMPLETED_WITH_WARNINGS"
    FAILED = "FAILED"


class PreprocessingStage(StrEnum):
    NORMALIZATION = "normalization"
    DETECTION = "detection"
    SPEECH_MAP = "speech_map"


@dataclass(frozen=True)
class PreprocessingAudioMetadata:
    """Source metadata and the complete, zero-based normalized sample timeline."""

    source_metadata: AudioProbe
    sample_count: int
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


@dataclass(frozen=True)
class PreprocessingProvenance:
    """Only validated, completed stages enter aggregate provenance."""

    pipeline_version: str
    source_id: str
    sample_count: int | None = None
    normalization: AudioProvenance | None = None
    detection: DetectionProvenance | None = None
    speech_map: SpeechMapProvenance | None = None
    sample_rate_hz: int = field(default=16000, init=False)

    def __post_init__(self) -> None:
        # AudioProvenance predates the immutable evidence/map configuration types.
        # Snapshot its mappings so the aggregate cannot change after publication.
        if self.normalization is not None:
            object.__setattr__(self, "normalization", replace(
                self.normalization,
                target_format=MappingProxyType(dict(self.normalization.target_format)),
                effective_configuration=MappingProxyType(dict(self.normalization.effective_configuration)),
            ))

    @property
    def effective_configuration(self) -> Mapping[str, Mapping[str, str | int | float]]:
        return MappingProxyType({
            stage.value: provenance.effective_configuration
            for stage, provenance in (
                (PreprocessingStage.NORMALIZATION, self.normalization),
                (PreprocessingStage.DETECTION, self.detection),
                (PreprocessingStage.SPEECH_MAP, self.speech_map),
            ) if provenance is not None
        })


@dataclass(frozen=True)
class PreprocessingResult:
    """Complete audio and provisional speech evidence; never confirmed speech."""

    normalized_artifact: NormalizedAudioArtifact
    audio_metadata: PreprocessingAudioMetadata
    speech_evidence: SpeechEnergyEvidence
    speech_map: SpeechMap
    warnings: tuple[SpeechMapWarning, ...]
    provenance: PreprocessingProvenance


@dataclass(frozen=True)
class PreprocessingFailure:
    stage: PreprocessingStage
    category: AudioErrorCategory

    def __post_init__(self) -> None:
        object.__setattr__(self, "stage", PreprocessingStage(self.stage))
        object.__setattr__(self, "category", AudioErrorCategory(self.category))


def _close_ownership(ownership: ExitStack) -> None:
    failed = False
    try:
        # ExitStack attempts every callback, including when an earlier close fails.
        ownership.close()
    except Exception:
        failed = True
    if failed:
        # Do not retain input-bearing exception context from artifact cleanup.
        raise AudioProcessingError("RESOURCE")


@dataclass(frozen=True)
class PreprocessingOutcome:
    """Owns complete or partial artifacts until close(), including on failure.

    Partial artifacts may include the failed stage's unvalidated output. Only
    completed_stages, audio_metadata, and provenance describe validated work.
    close() is idempotent after successful release; cleanup errors raise RESOURCE.
    """

    status: PreprocessingStatus
    completed_stages: tuple[PreprocessingStage, ...]
    result: PreprocessingResult | None = field(repr=False)
    failure: PreprocessingFailure | None
    audio_metadata: PreprocessingAudioMetadata | None = field(repr=False)
    provenance: PreprocessingProvenance = field(repr=False)
    partial_artifacts: tuple[NormalizedAudioArtifact | SpeechEnergyEvidence, ...] = field(repr=False)
    _ownership: ExitStack = field(repr=False, compare=False)

    def __post_init__(self) -> None:
        if self.status == PreprocessingStatus.FAILED:
            valid = self.result is None and self.failure is not None
        else:
            valid = (
                self.result is not None and self.failure is None and not self.partial_artifacts
                and self.completed_stages == tuple(PreprocessingStage)
                and (self.status == PreprocessingStatus.COMPLETED_WITH_WARNINGS) == bool(self.result.warnings)
            )
        if not valid:
            raise AudioProcessingError("VALIDATION")

    def close(self) -> None:
        _close_ownership(self._ownership)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type, exc_value, exc_traceback) -> None:
        self.close()
