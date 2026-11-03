"""Explicit experimental V6.2 binding to the unchanged canonical result contract."""

from sme_meeting_ai.core.config import Settings

from .correction import TranscriptCorrectionOutcome
from .correction_v6_generation import V6CorrectionProvider
from .correction_v6_pipeline import _correct_span_transcript
from .correction_v62 import V62_ENGINE_VERSION, apply_v62_edits
from .correction_v62_generation import V62_PROMPT_VERSION, generate_v62_proposal
from .coverage import SpeechCoverageAssessment
from .reconciliation import TranscriptReconciliation


def correct_transcript_v62(
    reconciliation: TranscriptReconciliation, coverage: SpeechCoverageAssessment,
    provider: V6CorrectionProvider, settings: Settings,
) -> TranscriptCorrectionOutcome:
    return _correct_span_transcript(
        reconciliation, coverage, provider, settings,
        generate=generate_v62_proposal, apply=apply_v62_edits, prompt_version=V62_PROMPT_VERSION,
        correction_version="6.2", correction_mode="v62_edits", validator_version=V62_ENGINE_VERSION,
    )
