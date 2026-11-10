"""Explicit production assembly for the Core-authorized retrieval runtime."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sme_meeting_ai.core.config import ConfigurationError, Settings
from sme_meeting_ai.integrations.source_verification import (
    CoreSourceVerificationProvider,
)

from .embedding import BgeM3EmbeddingAdapter, EmbeddingCompatibility
from .provisioning import load_bge_m3_manifest
from .qdrant import QdrantVectorStore
from .reranking import BgeRerankerAdapter
from .retrieval import (
    AuthorizationProvider,
    CoreApprovedAuthorizationProvider,
    RetrievalConfig,
    RetrievalEngine,
    SourceVerificationProvider,
)
from .tokenizer import bge_m3_index_generation


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


def build_qdrant_audit_store(settings: Settings) -> QdrantVectorStore:
    """Build the read-only Qdrant adapter without loading inference artifacts."""

    manifest = load_bge_m3_manifest()
    generation = bge_m3_index_generation(
        generation_id=settings.rag_index_generation_id,
        configuration_version=settings.rag_index_configuration_version,
        max_tokens=settings.rag_embedding_max_input_tokens,
        target_tokens=settings.rag_chunk_target_tokens,
        manifest=manifest,
    )
    configuration_sha256 = settings.rag_index_configuration_sha256 or generation.configuration_sha256
    if configuration_sha256 != generation.configuration_sha256:
        raise ConfigurationError("Index configuration fingerprint does not match the approved generation")
    compatibility = EmbeddingCompatibility(
        model_id=manifest.model_id,
        model_revision=manifest.revision,
        tokenizer_id=manifest.tokenizer_id,
        index_generation_id=generation.generation_id,
        index_configuration_sha256=configuration_sha256,
    )
    store = QdrantVectorStore.from_settings(settings, compatibility)
    try:
        store.validate_retrieval_schema()
    except Exception:
        store.close()
        raise
    return store


__all__ = [
    "CoreApprovedAuthorizationProvider",
    "RetrievalRuntime",
    "build_qdrant_audit_store",
    "build_retrieval_runtime",
]
