"""Opt-in production correction path with synthetic Vietnamese text only."""

import os

import pytest

from sme_meeting_ai.audio.models import (
    AudioProvenance,
    DetectionProvenance,
    SampleInterval,
    SpeechMapProvenance,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import PreprocessingProvenance
from sme_meeting_ai.providers.openrouter_instruction_llm import (
    OpenRouterInstructionLlmAdapter,
)
from sme_meeting_ai.transcription import (
    ChunkPlanningProvenance,
    CoverageProvenance,
    CoverageQuality,
    ReconciledSegment,
    SpeechCoverageAssessment,
    TranscriptCorrectionStatus,
    TranscriptReconciliation,
    correct_transcript,
)
from sme_meeting_ai.transcription.reconciliation import ReconciliationProvenance

pytestmark = pytest.mark.live_provider


def test_luna_medium_synthetic_whole_meeting_correction():
    if os.environ.get("RUN_OPENROUTER_LIVE_CORRECTION") != "1":
        pytest.skip("Explicit live correction opt-in is required")
    # No dotenv reads and no media, ASR, storage, or private meeting inputs.
    settings = Settings(
        _env_file=None, service_name="synthetic-correction-probe", service_identity="ai-core",
        transcript_correction_model="openai/gpt-6-luna",
        transcript_correction_reasoning_effort="medium", transcript_correction_temperature=None,
        transcript_correction_max_attempts=1,
    )
    if settings.openrouter_api_key is None:
        pytest.fail("OPENROUTER_API_KEY is required for the opted-in test")
    source, count = "synthetic-live-correction", 96000
    detection = DetectionProvenance("synthetic", "1", "a" * 64, "synthetic", "1", {})
    preprocessing = PreprocessingProvenance(
        "1", source, count, AudioProvenance(source, "1", "synthetic", "1", {}, {}),
        detection, SpeechMapProvenance(source, count, "1", detection, {}),
    )
    planning = ChunkPlanningProvenance("1", preprocessing, {})
    texts = ("chúng ta triển khai API v2 vào ngày mai", "vâng vâng tôi sẽ kiểm tra API v2")
    segments = tuple(ReconciledSegment(
        SampleInterval(index * 48000, (index + 1) * 48000), text, (f"chunk-{index:06d}",),
        segment_id=f"segment-{index:06d}", ordinal=index,
    ) for index, text in enumerate(texts))
    reconciliation = TranscriptReconciliation(
        source, count, segments, (), (), ReconciliationProvenance("1", planning, {}, (), ()),
    )
    coverage = SpeechCoverageAssessment(
        source, count, (), (), (),
        CoverageQuality(count, 2, count, count, 0, 0, 0, 0, 0, 0, 0, 0, {}),
        CoverageProvenance("1", planning, {}, ()),
    )
    with OpenRouterInstructionLlmAdapter(settings) as adapter:
        outcome = correct_transcript(reconciliation, coverage, adapter, settings)
    assert outcome.status is TranscriptCorrectionStatus.COMPLETED
    assert outcome.result is not None
    assert outcome.result.coverage is coverage
    assert outcome.result.provenance.requested_model == "openai/gpt-6-luna"
    assert outcome.result.provenance.effective_configuration["reasoning_effort"] == "medium"
    assert outcome.result.quality.validated_segment_count == 2
    for original, corrected in zip(segments, outcome.result.segments, strict=True):
        for name in ("segment_id", "ordinal", "interval", "source_chunk_ids", "flags"):
            assert getattr(original, name) == getattr(corrected, name)
