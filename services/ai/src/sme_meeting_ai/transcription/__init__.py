"""Transcription planning and provider-independent provisional ASR evidence."""

from .asr import (
    AsrAudioChunk,
    AsrCandidate,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrSegmentQuality,
    AsrTranscriber,
    AsrUsage,
)
from .chunk_planning import (
    AsrChunk,
    AsrChunkPlan,
    ChunkBoundaryReason,
    ChunkPlanningProvenance,
    SpeechAwareAsrChunkPlanner,
    validate_asr_chunk_plan,
)
from .chunk_execution import (
    AsrChunkResult,
    AsrTimelineSegment,
    execute_asr_chunks,
)

__all__ = [
    "AsrAudioChunk",
    "AsrCandidate",
    "AsrChunk",
    "AsrChunkPlan",
    "AsrChunkResult",
    "AsrError",
    "AsrErrorCategory",
    "AsrProvenance",
    "AsrQualityMetadata",
    "AsrSegment",
    "AsrSegmentQuality",
    "AsrTranscriber",
    "AsrTimelineSegment",
    "AsrUsage",
    "ChunkBoundaryReason",
    "ChunkPlanningProvenance",
    "SpeechAwareAsrChunkPlanner",
    "execute_asr_chunks",
    "validate_asr_chunk_plan",
]
