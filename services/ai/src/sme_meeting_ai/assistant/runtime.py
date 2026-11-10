"""Explicit Assistant runtime assembly; no model or network initialization at import time."""

from __future__ import annotations

from sme_meeting_ai.core.config import ConfigurationError, Environment, Settings
from sme_meeting_ai.providers.openrouter_assistant import OpenRouterAssistantAdapter

from .context import AssistantSettings
from .service import AssistantOrchestrator


def build_assistant_service(
    settings: Settings,
    *,
    retrieval_engine,
    generator=None,
    final_verifier=None,
    trusted_runtime: bool = False,
) -> AssistantOrchestrator | None:
    """Assemble T04 only after an already-ready, Core-trusted T03 engine is supplied.

    T04 does not create authorization or source-verification providers. Production
    callers must inject those providers through ``retrieval_engine`` and explicitly
    attest that the assembled dependencies are the deployment-approved ones.
    """

    if not settings.assistant_enabled:
        return None
    if retrieval_engine is None:
        raise ConfigurationError("Assistant retrieval dependencies unavailable")
    if not settings.assistant_inference_enabled or settings.openrouter_api_key is None or not settings.openrouter_api_key.get_secret_value():
        raise ConfigurationError("Assistant provider configuration unavailable")
    authorization_provider = getattr(retrieval_engine, "authorization_provider", None)
    source_provider = getattr(retrieval_engine, "source_provider", None)
    if not callable(getattr(authorization_provider, "verify", None)):
        raise ConfigurationError("Assistant authorization provider unavailable")
    if not callable(getattr(source_provider, "verify", None)):
        raise ConfigurationError("Assistant source verification provider unavailable")
    if settings.environment in {Environment.STAGING, Environment.PRODUCTION}:
        provider_ids = {
            getattr(authorization_provider, "provider_id", ""),
            getattr(source_provider, "provider_id", ""),
        }
        if not trusted_runtime or provider_ids & {"test-fixture", "test-source-fixture"}:
            raise ConfigurationError("Assistant production trust dependencies unavailable")
    if generator is None:
        generator = OpenRouterAssistantAdapter(settings)
    return AssistantOrchestrator(
        retrieval_engine,
        generator,
        config=AssistantSettings.from_settings(settings),
        final_verifier=final_verifier,
        production_ready=trusted_runtime,
    )


__all__ = ["build_assistant_service"]
