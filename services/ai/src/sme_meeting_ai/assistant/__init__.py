"""Grounded Assistant contracts and bounded orchestration."""

from .context import (
    CONTEXTUALIZATION_SYSTEM_INSTRUCTIONS,
    GROUNDING_PROMPT_VERSION,
    GROUNDING_SYSTEM_INSTRUCTIONS,
    AssistantSettings,
    ContextBudgetError,
    build_grounding_context,
    estimate_prompt_tokens,
    grounding_user_payload,
)
from .contracts import (
    AnswerClaim,
    AnswerSupport,
    AnswerUnit,
    AssistantAnswer,
    AssistantAnswerStatus,
    AssistantDiagnostics,
    AssistantFailure,
    AssistantFailureCategory,
    AssistantRequest,
    Citation,
    ContextualizedQuestion,
    ConversationMessage,
    ConversationRole,
    EvidenceContextItem,
    GeneratedAnswer,
    GeneratedAnswerStatus,
    GenerationResult,
    GroundingContext,
    ModelProvenance,
)
from .errors import AssistantProviderError, FinalVerificationError
from .service import (
    AssistantOrchestrator,
    FinalVerifier,
    GenerationCapability,
    RetrievalCapability,
    TrustedFinalVerifier,
    question_requires_context,
)


def __getattr__(name: str):
    if name == "build_assistant_service":
        from .runtime import build_assistant_service

        return build_assistant_service
    raise AttributeError(name)

__all__ = [
    "AnswerClaim",
    "AnswerSupport",
    "AnswerUnit",
    "AssistantAnswer",
    "AssistantAnswerStatus",
    "AssistantDiagnostics",
    "AssistantFailure",
    "AssistantFailureCategory",
    "AssistantOrchestrator",
    "AssistantProviderError",
    "AssistantRequest",
    "AssistantSettings",
    "Citation",
    "CONTEXTUALIZATION_SYSTEM_INSTRUCTIONS",
    "ContextBudgetError",
    "ContextualizedQuestion",
    "ConversationMessage",
    "ConversationRole",
    "EvidenceContextItem",
    "FinalVerificationError",
    "FinalVerifier",
    "GeneratedAnswer",
    "GeneratedAnswerStatus",
    "GenerationCapability",
    "GenerationResult",
    "GROUNDING_PROMPT_VERSION",
    "GROUNDING_SYSTEM_INSTRUCTIONS",
    "GroundingContext",
    "ModelProvenance",
    "RetrievalCapability",
    "TrustedFinalVerifier",
    "build_grounding_context",
    "build_assistant_service",
    "estimate_prompt_tokens",
    "grounding_user_payload",
    "question_requires_context",
]
