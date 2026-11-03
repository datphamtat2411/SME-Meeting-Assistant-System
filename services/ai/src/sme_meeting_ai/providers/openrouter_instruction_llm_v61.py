"""V6.1 prompt-pinned adapter over the unchanged single-attempt V6 transport."""

from collections.abc import Mapping

from sme_meeting_ai.transcription.correction_v6_generation import V6CorrectionRequest
from sme_meeting_ai.transcription.correction_v61_generation import _validate_v61_request

from .openrouter_instruction_llm_v6 import OpenRouterInstructionLlmV6Adapter


class OpenRouterInstructionLlmV61Adapter(OpenRouterInstructionLlmV6Adapter):
    """Only the prompt-specific preflight differs; generation owns all retries.

    The inherited _complete dispatches this hook explicitly. Transport, schema,
    response limits, deadlines, client ownership and error sanitization stay V6's.
    """

    @staticmethod
    def _validate_request(request: V6CorrectionRequest, config: Mapping) -> int:
        return _validate_v61_request(request, config)
