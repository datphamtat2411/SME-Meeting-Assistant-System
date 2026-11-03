"""Prompt-pinned V6.2 adapter; inherit the existing single-request transport."""

from collections.abc import Mapping

from sme_meeting_ai.transcription.correction_v6_generation import V6CorrectionRequest
from sme_meeting_ai.transcription.correction_v62_generation import _validate_v62_request

from .openrouter_instruction_llm_v6 import OpenRouterInstructionLlmV6Adapter


class OpenRouterInstructionLlmV62Adapter(OpenRouterInstructionLlmV6Adapter):
    @staticmethod
    def _validate_request(request: V6CorrectionRequest, config: Mapping) -> int:
        return _validate_v62_request(request, config)
