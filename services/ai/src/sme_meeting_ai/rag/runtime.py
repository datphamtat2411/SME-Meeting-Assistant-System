"""Explicit production assembly for the Core-authorized retrieval runtime."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sme_meeting_ai.core.config import ConfigurationError, Settings
from sme_meeting_ai.integrations.source_verification import (
    CoreSourceVerificationProvider,
)

from .embedding import BgeM3EmbeddingAdapter
from .qdrant import QdrantVectorStore
from .reranking import BgeRerankerAdapter
from .retrieval import (
    AuthorizationProvider,
    CoreApprovedAuthorizationProvider,
    RetrievalConfig,
    RetrievalEngine,
    SourceVerificationProvider,
)


@dataclass
class RetrievalRuntime:
    """Owned retrieval resources and the engine that consumes them."""

    engine: RetrievalEngine
    embedding: Any
    reranker: Any
    store: Any
    source_provider: Any

    def close(self) -> None:
        for resource in (self.source_provider, self.store, self.reranker, self.embedding):
            close = getattr(resource, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass


def _close_owned(resources: list[Any]) -> None:
    for resource in reversed(resources):
        close = getattr(resource, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass


def build_retrieval_runtime(
    settings: Settings,
    *,
    embedding: Any | None = None,
    reranker: Any | None = None,
    store: Any | None = None,
    source_provider: SourceVerificationProvider | None = None,
    authorization_provider: AuthorizationProvider | None = None,
) -> RetrievalRuntime:
    """Build only a ready, Core-trusted retrieval runtime.

    Dependency injection is retained for deterministic unit tests. The default
    path owns local model adapters, the Qdrant client, and the Core mTLS
    provider, and validates the active collection before returning.
    """

    owned: list[Any] = []
    try:
        if embedding is None:
            embedding = BgeM3EmbeddingAdapter.from_settings(settings)
            owned.append(embedding)
        compatibility = getattr(embedding, "compatibility", None)
        if compatibility is None:
            raise ConfigurationError("Retrieval embedding compatibility unavailable")

        if reranker is None:
            reranker = BgeRerankerAdapter.from_settings(settings)
            owned.append(reranker)
        if store is None:
            store = QdrantVectorStore.from_settings(settings, compatibility)
            owned.append(store)
        validate_schema = getattr(store, "validate_retrieval_schema", None)
        if not callable(validate_schema):
            raise ConfigurationError("Retrieval vector store schema validation unavailable")
        validate_schema()

        if source_provider is None:
            source_provider = CoreSourceVerificationProvider(settings)
            owned.append(source_provider)
        if getattr(source_provider, "provider_id", None) != CoreSourceVerificationProvider.provider_id:
            raise ConfigurationError("Core source verification provider unavailable")

        if authorization_provider is None:
            authorization_provider = CoreApprovedAuthorizationProvider()
        if getattr(authorization_provider, "provider_id", None) != CoreApprovedAuthorizationProvider.provider_id:
            raise ConfigurationError("Core authorization provider unavailable")

        engine = RetrievalEngine(
            embedding=embedding,
            store=store,
            reranker=reranker,
            authorization_provider=authorization_provider,
            source_provider=source_provider,
            config=RetrievalConfig.from_settings(settings),
        )
        return RetrievalRuntime(
            engine=engine,
            embedding=embedding,
            reranker=reranker,
            store=store,
            source_provider=source_provider,
        )
    except Exception:
        _close_owned(owned)
        raise


__all__ = ["CoreApprovedAuthorizationProvider", "RetrievalRuntime", "build_retrieval_runtime"]
