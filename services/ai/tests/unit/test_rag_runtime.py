from datetime import datetime, timezone
from uuid import uuid4

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.rag.contracts import AuthorizedRetrievalScope
from sme_meeting_ai.rag.embedding import EmbeddingCompatibility
from sme_meeting_ai.rag.retrieval import AuthorizationVerificationError
from sme_meeting_ai.rag.runtime import (
    CoreApprovedAuthorizationProvider,
    build_retrieval_runtime,
)

NOW = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)


def _scope():
    return AuthorizedRetrievalScope(
        contractVersion="1.0",
        scopeId=str(uuid4()),
        principalId=str(uuid4()),
        scopeVersion="core-auth-v1",
        issuedAt="2026-11-10T11:00:00Z",
        expiresAt="2026-11-10T13:00:00Z",
        allowedMeetingIds=(str(uuid4()),),
    )


class FakeEmbedding:
    compatibility = EmbeddingCompatibility(
        model_id="BAAI/bge-m3",
        model_revision="5617a9f61b028005a4858fdac845db406aefb181",
        tokenizer_id="BAAI/bge-m3-tokenizer:5617a9f61b028005a4858fdac845db406aefb181",
        index_generation_id="rag-t02-bge-m3-v1",
        index_configuration_sha256="b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1",
    )

    def close(self):
        self.closed = True


class FakeReranker:
    model_id = "BAAI/bge-reranker-v2-m3"
    model_revision = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"

    def close(self):
        self.closed = True


class FakeStore:
    def validate_retrieval_schema(self):
        self.validated = True

    def close(self):
        self.closed = True


class FakeSourceProvider:
    provider_id = "core-mtls"

    def close(self):
        self.closed = True


def test_core_approved_provider_verifies_only_live_core_scope():
    scope = _scope()
    provider = CoreApprovedAuthorizationProvider()

    context = provider.verify(scope, now=NOW)

    assert provider.provider_id == "core-mtls-scope"
    assert context.scope == scope
    assert context.scope_digest
    assert context.verification_reference == scope.scope_id

    expired = scope.model_copy(update={"expires_at": "2026-11-10T12:00:00Z"})
    with pytest.raises(AuthorizationVerificationError) as error:
        provider.verify(expired, now=NOW)
    assert error.value.category == "SCOPE_EXPIRED"


def test_production_runtime_assembles_core_verification_and_closes_resources():
    embedding = FakeEmbedding()
    reranker = FakeReranker()
    store = FakeStore()
    source_provider = FakeSourceProvider()
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)

    runtime = build_retrieval_runtime(
        settings,
        embedding=embedding,
        reranker=reranker,
        store=store,
        source_provider=source_provider,
    )

    assert runtime.engine.authorization_provider.provider_id == "core-mtls-scope"
    assert runtime.engine.source_provider is source_provider
    assert store.validated is True

    runtime.close()

    assert embedding.closed is True
    assert reranker.closed is True
    assert store.closed is True
    assert source_provider.closed is True
