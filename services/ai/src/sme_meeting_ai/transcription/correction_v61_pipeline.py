"""Explicit V6.1 generation/validation binding to the canonical correction result."""

from sme_meeting_ai.core.config import Settings

from .correction import TranscriptCorrectionOutcome
from .correction_v6_generation import V6CorrectionProvider
from .correction_v6_pipeline import _correct_span_transcript
from .correction_v61 import V61_ENGINE_VERSION, apply_v61_edits
from .correction_v61_generation import V61_PROMPT_VERSION, generate_v61_proposal
from .coverage import SpeechCoverageAssessment
from .reconciliation import TranscriptReconciliation


def correct_transcript_v61(
    reconciliation: TranscriptReconciliation,
    coverage: SpeechCoverageAssessment,
    provider: V6CorrectionProvider,
    settings: Settings,
) -> TranscriptCorrectionOutcome:
    """Generate once, validate once against the original, publish only engine texts.

    Generation owns its configured attempt budget. Local rejections never retry;
    global failures never publish a partial correction or an ASR-only fallback.
    The shared V6 bridge preserves trusted metadata, quality and warning semantics.
    """
    return _correct_span_transcript(
        reconciliation, coverage, provider, settings,
        generate=generate_v61_proposal, apply=apply_v61_edits, prompt_version=V61_PROMPT_VERSION,
        correction_version="6.1", correction_mode="v61_edits", validator_version=V61_ENGINE_VERSION,
    )
