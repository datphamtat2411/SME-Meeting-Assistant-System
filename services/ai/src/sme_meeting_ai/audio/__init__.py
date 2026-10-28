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
    SpeechEnergyEvidence,
    VadLabel,
)
from .normalization import AudioNormalizer
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
    "SileroVadBackend",
    "SpeechEnergyEvidence",
    "VadBackend",
    "VadLabel",
    "VadStream",
]
