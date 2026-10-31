"""Synchronous file-backed audio processing and independent speech/energy evidence."""

from .detection import AudioEvidenceDetector
from .errors import AudioErrorCategory, AudioProcessingError
from .models import (
    AudioProbe,
    AudioProvenance,
    AudioSource,
    DetectionProvenance,
    EvidenceFrame,
    NormalizedAudioArtifact,
    SampleInterval,
    SpeechEnergyEvidence,
    SpeechMap,
    SpeechMapProvenance,
    SpeechMapQuality,
    SpeechMapWarning,
    VadLabel,
)
from .normalization import AudioNormalizer
from .speech_map import SpeechMapBuilder
from .vad import SileroVadBackend, VadBackend, VadStream

__all__ = [
    "AudioErrorCategory",
    "AudioEvidenceDetector",
    "AudioNormalizer",
    "AudioProbe",
    "AudioProcessingError",
    "AudioProvenance",
    "AudioSource",
    "DetectionProvenance",
    "EvidenceFrame",
    "NormalizedAudioArtifact",
    "SampleInterval",
    "SileroVadBackend",
    "SpeechEnergyEvidence",
    "SpeechMap",
    "SpeechMapBuilder",
    "SpeechMapProvenance",
    "SpeechMapQuality",
    "SpeechMapWarning",
    "VadBackend",
    "VadLabel",
    "VadStream",
]
