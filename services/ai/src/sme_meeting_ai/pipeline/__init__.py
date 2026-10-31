"""Transport-independent offline processing and safe aggregate outcomes."""

from .models import (
    PreprocessingAudioMetadata,
    PreprocessingFailure,
    PreprocessingOutcome,
    PreprocessingProvenance,
    PreprocessingResult,
    PreprocessingStage,
    PreprocessingStatus,
)
from .offline_transcription import (
    OfflineAsrEvidence,
    OfflineAsrProvenance,
    OfflineReconciliationEvidence,
    OfflineReconciliationSegment,
    OfflineRecoveryEvidence,
    OfflineTranscriptionEvidence,
    OfflineTranscriptionFailure,
    OfflineTranscriptionOutcome,
    OfflineTranscriptionPipeline,
    OfflineTranscriptionProvenance,
    OfflineTranscriptionStage,
    OfflineTranscriptionStatus,
    OfflineTranscriptionWarning,
)
from .preprocessing import AudioPreprocessingPipeline

__all__ = [
    "AudioPreprocessingPipeline",
    "OfflineAsrEvidence",
    "OfflineAsrProvenance",
    "OfflineReconciliationEvidence",
    "OfflineReconciliationSegment",
    "OfflineRecoveryEvidence",
    "OfflineTranscriptionEvidence",
    "OfflineTranscriptionFailure",
    "OfflineTranscriptionOutcome",
    "OfflineTranscriptionPipeline",
    "OfflineTranscriptionProvenance",
    "OfflineTranscriptionStage",
    "OfflineTranscriptionStatus",
    "OfflineTranscriptionWarning",
    "PreprocessingAudioMetadata",
    "PreprocessingFailure",
    "PreprocessingOutcome",
    "PreprocessingProvenance",
    "PreprocessingResult",
    "PreprocessingStage",
    "PreprocessingStatus",
]
