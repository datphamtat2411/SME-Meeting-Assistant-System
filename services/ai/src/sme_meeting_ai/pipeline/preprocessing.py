"""Synchronous composition of bounded normalization, detection, and speech mapping."""

import math
from collections.abc import Mapping
from contextlib import ExitStack
from dataclasses import fields, replace
from pathlib import Path

from sme_meeting_ai.audio.detection import AudioEvidenceDetector
from sme_meeting_ai.audio.errors import AudioErrorCategory, AudioProcessingError
from sme_meeting_ai.audio.models import (
    AudioProbe,
    AudioProvenance,
    AudioSource,
    DetectionProvenance,
    NormalizedAudioArtifact,
    SampleInterval,
    SpeechEnergyEvidence,
    SpeechMap,
    SpeechMapProvenance,
    SpeechMapQuality,
)
from sme_meeting_ai.audio.normalization import AudioNormalizer
from sme_meeting_ai.audio.speech_map import SpeechMapBuilder, _validate_contracts

from .models import (
    PreprocessingAudioMetadata,
    PreprocessingFailure,
    PreprocessingOutcome,
    PreprocessingProvenance,
    PreprocessingResult,
    PreprocessingStage,
    PreprocessingStatus,
    _close_ownership,
)

_PIPELINE_VERSION = "1"


def _require(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("VALIDATION")


def _identifier(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _close_artifact(artifact: NormalizedAudioArtifact | SpeechEnergyEvidence) -> None:
    artifact.close()


def _take_ownership(
    ownership: ExitStack, artifacts: list, artifact: NormalizedAudioArtifact | SpeechEnergyEvidence,
    source: AudioSource,
) -> None:
    """Never accept a temporary directory capable of deleting original media."""
    category = None
    try:
        root = Path(artifact._temporary.name).resolve()
        original = source.path.resolve()
        if original.is_relative_to(root):
            raise AudioProcessingError("RESOURCE")
        for previous in artifacts:
            previous_root = Path(previous._temporary.name).resolve()
            if root.is_relative_to(previous_root) or previous_root.is_relative_to(root):
                raise AudioProcessingError("RESOURCE")
        # From here cleanup is safe, even if the returned file reference is bad.
        ownership.callback(_close_artifact, artifact)
        artifacts.append(artifact)
        path = artifact.path if isinstance(artifact, NormalizedAudioArtifact) else artifact._path
        if path.resolve().parent != root or path.resolve() == original:
            raise AudioProcessingError("RESOURCE")
    except (OSError, AttributeError, TypeError, ValueError):
        category = "RESOURCE"
    if category is not None:
        raise AudioProcessingError(category)


def _validate_normalization(source: AudioSource, audio: NormalizedAudioArtifact) -> None:
    _require(
        audio.source_id == source.source_id
        and isinstance(audio.source_metadata, AudioProbe)
        and audio.source_metadata.source_id == source.source_id
        and type(audio.sample_count) is int and audio.sample_count > 0
        and type(audio.sample_rate_hz) is int and audio.sample_rate_hz == 16000
        and type(audio.channels) is int and audio.channels == 1
        and audio.sample_format == "s16"
        and isinstance(audio.provenance, AudioProvenance)
    )
    provenance = audio.provenance
    _require(
        provenance.source_id == source.source_id
        and all(_identifier(value) for value in (
            provenance.normalizer_version, provenance.decoder, provenance.decoder_version,
        ))
        and isinstance(provenance.target_format, Mapping)
        and isinstance(provenance.effective_configuration, Mapping)
        and all(provenance.target_format.get(key) == value for key, value in {
            "container": "wav", "codec": "pcm_s16le", "sample_format": "s16",
            "sample_rate_hz": 16000, "channels": 1,
        }.items())
    )


def _validate_detection(audio: NormalizedAudioArtifact, evidence: SpeechEnergyEvidence) -> None:
    # Reuse the existing cross-stage contract validation, not another frame or
    # signal-processing algorithm. The builder performs the single full replay.
    _validate_contracts(audio, evidence)
    provenance = evidence.provenance
    _require(
        isinstance(provenance, DetectionProvenance)
        and all(_identifier(value) for value in (
            provenance.model_id, provenance.model_version, provenance.model_sha256,
            provenance.backend, provenance.detector_version,
        ))
        and len(provenance.model_sha256) == 64
        and all(character in "0123456789abcdef" for character in provenance.model_sha256)
    )


def _validate_map(audio: NormalizedAudioArtifact, evidence: SpeechEnergyEvidence, speech_map: SpeechMap) -> None:
    _require(isinstance(speech_map, SpeechMap))
    provenance = speech_map.provenance
    _require(
        isinstance(provenance, SpeechMapProvenance)
        and provenance.source_id == audio.source_id
        and type(provenance.sample_count) is int and provenance.sample_count == audio.sample_count
        and type(provenance.sample_rate_hz) is int and provenance.sample_rate_hz == audio.sample_rate_hz
        and provenance.detector_provenance == evidence.provenance
        and _identifier(provenance.mapper_version)
    )
    configuration = provenance.effective_configuration
    _require(all(
        type(configuration.get(key)) is int and configuration[key] >= 0
        for key in ("boundary_padding_samples", "merge_gap_samples")
    ))
    energy_floor = configuration.get("energy_floor_dbfs")
    _require(type(energy_floor) in (int, float) and math.isfinite(energy_floor) and energy_floor <= 0)

    # Validate published bounds and coverage relationships without reconstructing
    # candidate, uncertainty, merging, or padding decisions made by the mapper.
    for intervals in (
        speech_map.speech_intervals, speech_map.protected_intervals, speech_map.uncertain_intervals,
    ):
        previous_end = -1
        for interval in intervals:
            _require(
                isinstance(interval, SampleInterval)
                and type(interval.start_sample) is int and type(interval.end_sample) is int
                and previous_end < interval.start_sample < interval.end_sample <= audio.sample_count
            )
            previous_end = interval.end_sample
    protected_index = 0
    for interval in speech_map.speech_intervals:
        while (
            protected_index < len(speech_map.protected_intervals)
            and speech_map.protected_intervals[protected_index].end_sample <= interval.start_sample
        ):
            protected_index += 1
        _require(protected_index < len(speech_map.protected_intervals))
        protected = speech_map.protected_intervals[protected_index]
        _require(protected.start_sample <= interval.start_sample and interval.end_sample <= protected.end_sample)

    quality = speech_map.quality
    _require(isinstance(quality, SpeechMapQuality))
    _require(all(
        type(getattr(quality, attribute.name)) is int
        and 0 <= getattr(quality, attribute.name) <= evidence.frame_count
        for attribute in fields(SpeechMapQuality)
    ))
    _require(
        quality.frame_count == evidence.frame_count
        and quality.likely_speech_frame_count == evidence.likely_speech_frame_count
        and quality.likely_non_speech_frame_count == evidence.likely_non_speech_frame_count
        and quality.uncertain_frame_count == evidence.uncertain_frame_count
        and quality.weak_speech_frame_count <= quality.likely_speech_frame_count
        and quality.high_energy_non_speech_frame_count <= quality.likely_non_speech_frame_count
        and quality.vad_energy_disagreement_frame_count == (
            quality.weak_speech_frame_count + quality.high_energy_non_speech_frame_count
        )
        and quality.protected_window_coalescing_count == (
            len(speech_map.speech_intervals) - len(speech_map.protected_intervals)
        )
        and bool(speech_map.speech_intervals) == bool(quality.likely_speech_frame_count)
        and bool(speech_map.uncertain_intervals) == bool(
            quality.uncertain_frame_count + quality.high_energy_non_speech_frame_count
        )
    )


class AudioPreprocessingPipeline:
    """Compose injected stages; their finite settings bound work and storage.

    Construct all stages with the same Settings instance and inject a worker-owned
    VAD backend into the detector. This layer never loads models or owns workers.
    """

    def __init__(
        self, normalizer: AudioNormalizer, detector: AudioEvidenceDetector,
        speech_map_builder: SpeechMapBuilder, pipeline_version: str = _PIPELINE_VERSION,
    ):
        _require(_identifier(pipeline_version))
        self._normalizer = normalizer
        self._detector = detector
        self._speech_map_builder = speech_map_builder
        self._pipeline_version = pipeline_version

    def run(self, source: AudioSource) -> PreprocessingOutcome:
        ownership = ExitStack()
        artifacts = []
        completed = []
        metadata = None
        provenance = PreprocessingProvenance(
            pipeline_version=self._pipeline_version,
            source_id=source.source_id if isinstance(source, AudioSource) else "",
        )
        stage = PreprocessingStage.NORMALIZATION
        category = None
        try:
            _require(isinstance(source, AudioSource))
            audio = self._normalizer.normalize(source)
            _require(isinstance(audio, NormalizedAudioArtifact))
            _take_ownership(ownership, artifacts, audio, source)
            _validate_normalization(source, audio)
            metadata = PreprocessingAudioMetadata(audio.source_metadata, audio.sample_count)
            provenance = replace(provenance, normalization=audio.provenance, sample_count=audio.sample_count)
            completed.append(stage)

            stage = PreprocessingStage.DETECTION
            evidence = self._detector.detect(
                AudioSource(source.source_id, audio.path), expected_sample_count=audio.sample_count,
            )
            _require(isinstance(evidence, SpeechEnergyEvidence))
            _take_ownership(ownership, artifacts, evidence, source)
            _validate_detection(audio, evidence)
            provenance = replace(provenance, detection=evidence.provenance)
            completed.append(stage)

            stage = PreprocessingStage.SPEECH_MAP
            speech_map = self._speech_map_builder.build(audio, evidence)
            _validate_map(audio, evidence, speech_map)
            provenance = replace(provenance, speech_map=speech_map.provenance)
            completed.append(stage)
            warnings = speech_map.quality.warnings
            result = PreprocessingResult(audio, metadata, evidence, speech_map, warnings, provenance)
            return PreprocessingOutcome(
                status=(PreprocessingStatus.COMPLETED_WITH_WARNINGS if warnings else PreprocessingStatus.COMPLETED),
                completed_stages=tuple(completed), result=result, failure=None,
                audio_metadata=metadata, provenance=provenance, partial_artifacts=(), _ownership=ownership,
            )
        except AudioProcessingError as error:
            category = error.category
        except TimeoutError:
            category = AudioErrorCategory.TIMEOUT
        except (OSError, MemoryError):
            category = AudioErrorCategory.RESOURCE
        except Exception:
            category = {
                PreprocessingStage.NORMALIZATION: AudioErrorCategory.DECODING,
                PreprocessingStage.DETECTION: AudioErrorCategory.INFERENCE,
                PreprocessingStage.SPEECH_MAP: AudioErrorCategory.VALIDATION,
            }[stage]
        except BaseException:
            # Cancellation/interrupts are not ordinary terminal stage outcomes.
            _close_ownership(ownership)
            raise
        return PreprocessingOutcome(
            status=PreprocessingStatus.FAILED, completed_stages=tuple(completed), result=None,
            failure=PreprocessingFailure(stage, category), audio_metadata=metadata,
            provenance=provenance, partial_artifacts=tuple(artifacts), _ownership=ownership,
        )
