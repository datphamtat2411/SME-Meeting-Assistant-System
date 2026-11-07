"""Provider-independent diarization models and alignment."""

from .alignment import align_speakers
from .models import (
    DiarizationError,
    DiarizationErrorCategory,
    DiarizationResult,
    SpeakerAssignment,
    SpeakerTurn,
    TimedTranscriptSegment,
)
from .service import (
    DiarizationProvider,
    DiarizationRequest,
    DiarizationResponse,
    DiarizationService,
    SpeakerHints,
)

__all__ = [
    "DiarizationError", "DiarizationErrorCategory", "DiarizationResult", "SpeakerAssignment",
    "SpeakerTurn", "TimedTranscriptSegment", "align_speakers", "DiarizationProvider", "DiarizationRequest",
    "DiarizationResponse", "DiarizationService", "SpeakerHints",
]
