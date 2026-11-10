from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from uuid import uuid4

import numpy as np
import pytest
from qdrant_client import QdrantClient, models

from sme_meeting_ai.rag import (
    AuthorizedRetrievalScope,
    BgeM3EmbeddingConfig,
    BgeRerankerProvisioner,
    ChunkProvenance,
    EmbeddingCompatibility,
    IndexGeneration,
    QueryEmbedding,
    RetrievalCandidate,
    RetrievalConfig,
    RetrievalEngine,
    RetrievalFilters,
    RetrievalRequest,
    RetrievalStatus,
    SourceVerification,
    SparseEmbedding,
    StaticAuthorizationProvider,
    StaticSourceVerificationProvider,
    bge_m3_chunking_config,
    build_authorization_filter,
    load_bge_m3_manifest,
    load_bge_reranker_manifest,
    process_snapshot,
)
from sme_meeting_ai.rag.qdrant import QdrantRetrievedPoint, QdrantSchemaError
from sme_meeting_ai.rag.reranking import (
    BgeRerankerAdapter,
    BgeRerankerConfig,
    RerankerError,
    RerankerScore,
)
from sme_meeting_ai.rag.synthetic import synthetic_vietnamese_snapshot
from sme_meeting_ai.rag.tokenizer import BgeM3Tokenizer

NOW = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)
MODEL_REVISION = load_bge_m3_manifest().revision
RERANKER_REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"


class FakeTokenizer:
    tokenizer_id = load_bge_m3_manifest().tokenizer_id

    def __call__(self, text, **kwargs):
        del kwargs
        return {"input_ids": [0, *range(len(text.split())), 2]}


class FakeEmbedding:
    def __init__(self, compatibility: EmbeddingCompatibility):
        self.compatibility = compatibility
        self.config = BgeM3EmbeddingConfig(
            model_path=None,
            max_input_tokens=64,
            index_generation_id=compatibility.index_generation_id,
            index_configuration_sha256=compatibility.index_configuration_sha256,
            index_target_tokens=32,
            index_max_units_per_chunk=8,
        )
        self.tokenizer = BgeM3Tokenizer(tokenizer=FakeTokenizer())
        self.queries: list[str] = []

    def embed_queries(self, queries):
        self.queries.extend(queries)
        return (
            QueryEmbedding(
                query_index=0,
                dense=(0.1,) * 1024,
                sparse={"indices": (7,), "values": (1.0,)},
                compatibility=self.compatibility,
            ),
        )


class FakeReranker:
    model_id = "BAAI/bge-reranker-v2-m3"
    model_revision = RERANKER_REVISION

    def __init__(self, scores: dict[str, float] | None = None, error: str | None = None):
        self.scores = scores or {}
        self.error = error
        self.calls: list[tuple[str, tuple[str, ...]]] = []

    def rerank(self, query, candidates):
        self.calls.append((query, tuple(candidate.chunk_id for candidate in candidates)))
        if self.error:
            raise RerankerError(self.error)
        return tuple(
            RerankerScore(
                candidate_id=candidate.chunk_id,
                score=self.scores.get(candidate.chunk_id, 1.0),
                input_truncated=False,
            )
            for candidate in candidates
        )


@dataclass
class FakeStore:
    points: tuple[QdrantRetrievedPoint, ...]
    calls: int = 0
    filters: list[object] = field(default_factory=list)

    def query_hybrid(self, query_embedding, query_filter, **kwargs):
        del query_embedding, kwargs
        self.calls += 1
        self.filters.append(query_filter)
        return self.points


def _candidate_payload(candidate: RetrievalCandidate) -> dict[str, object]:
    provenance = candidate.provenance
    identity = provenance.source_identity
    compatibility = candidate.embedding_compatibility
    return {
        "meeting_id": provenance.meeting_id,
        "source_type": provenance.source_type,
        "canonical_source_id": identity.source_id,
        "canonical_source_revision": provenance.source_revision.number,
        "canonical_source_identity": identity.model_dump(mode="json", by_alias=True),
        "source_revision": provenance.source_revision.model_dump(mode="json", by_alias=True),
        "chunk_id": candidate.chunk_id,
        "index_generation_id": candidate.index_generation.generation_id,
        "index_generation": candidate.index_generation.model_dump(mode="json", by_alias=True),
        "embedding_model_id": compatibility.model_id,
        "embedding_model_revision": compatibility.model_revision,
        "embedding_tokenizer_id": compatibility.tokenizer_id,
        "embedding_representation_version": compatibility.representation_version,
        "embedding_index_configuration_sha256": compatibility.index_configuration_sha256,
        "source_current": provenance.source_current,
        "retrieval_text": candidate.retrieval_text,
        "display_text": candidate.display_text,
        "provenance": provenance.model_dump(mode="json", by_alias=True),
    }


def _compatibility(generation_id: str = "rag-t03-test-v1") -> EmbeddingCompatibility:
    return EmbeddingCompatibility(
        model_id="BAAI/bge-m3",
        model_revision=MODEL_REVISION,
        tokenizer_id=load_bge_m3_manifest().tokenizer_id,
        index_generation_id=generation_id,
        index_configuration_sha256="a" * 64,
    )


def _processing(compatibility: EmbeddingCompatibility):
    tokenizer = BgeM3Tokenizer(tokenizer=FakeTokenizer())
    config = bge_m3_chunking_config(
        tokenizer,
        generation_id=compatibility.index_generation_id,
        max_tokens=64,
        target_tokens=32,
        max_units_per_chunk=8,
    )
    return process_snapshot(synthetic_vietnamese_snapshot(), token_counter=tokenizer, config=config)


def _candidate(
    compatibility: EmbeddingCompatibility,
    *,
    text: str,
    point_id: str | None = None,
    meeting_id: str | None = None,
    source_id: str | None = None,
    source_revision: int = 1,
    source_type: str = "TRANSCRIPT",
    authority_class: str = "PRIMARY_TRANSCRIPT",
) -> RetrievalCandidate:
    meeting_id = meeting_id or str(uuid4())
    source_id = source_id or str(uuid4())
    point_id = point_id or str(uuid4())
    provenance = ChunkProvenance(
        snapshot_id=str(uuid4()),
        meeting_id=meeting_id,
        source_type=source_type,
        source_identity={"sourceType": source_type, "sourceId": source_id, "meetingId": meeting_id},
        source_revision={"number": source_revision},
        index_generation_id=compatibility.index_generation_id,
        authority_class=authority_class,
        quality_class="ACCEPTED",
        source_status="READY",
        source_current=True,
        source_references=(
            {
                "sourceIdentity": {"sourceType": source_type, "sourceId": source_id, "meetingId": meeting_id},
                "sourceRevision": {"number": source_revision},
                "segmentId": str(uuid4()) if source_type == "TRANSCRIPT" else None,
            },
        ),
    )
    return RetrievalCandidate(
        point_id=point_id,
        chunk_id=point_id,
        display_text=text,
        retrieval_text=text,
        rrf_score=0.5,
        provenance=provenance,
        index_generation=IndexGeneration(
            generationId=compatibility.index_generation_id,
            configurationVersion="rag-t03-test-v1",
            configurationSha256=compatibility.index_configuration_sha256,
            tokenizerId=compatibility.tokenizer_id,
        ),
        embedding_compatibility=compatibility,
    )


def _scope(*meeting_ids: str, source_ids=(), source_types=()) -> AuthorizedRetrievalScope:
    return AuthorizedRetrievalScope(
        contractVersion="1.0",
        scopeId=str(uuid4()),
        principalId=str(uuid4()),
        scopeVersion="core-auth-v1",
        issuedAt="2026-11-09T11:00:00Z",
        expiresAt="2026-11-09T13:00:00Z",
        allowedMeetingIds=meeting_ids,
        allowedSourceIds=source_ids,
        allowedSourceTypes=source_types,
    )


def _source_verification(candidate: RetrievalCandidate, *, status="CURRENT") -> SourceVerification:
    return SourceVerification(
        sourceIdentity=candidate.provenance.source_identity,
        sourceRevision=candidate.provenance.source_revision,
        currentRevision=candidate.provenance.source_revision if status == "CURRENT" else None,
        status=status,
        eligible=status == "CURRENT",
        available=status == "CURRENT",
        visible=status == "CURRENT",
        verifiedAt="2026-11-09T12:00:01Z",
    )


def _engine(
    candidate: RetrievalCandidate,
    *,
    scope: AuthorizedRetrievalScope,
    reranker: FakeReranker | None = None,
    source_provider=None,
    extra_points=(),
):
    compatibility = candidate.embedding_compatibility
    embedding = FakeEmbedding(compatibility)
    store = FakeStore(
        tuple(
            QdrantRetrievedPoint(point_id=value.point_id, score=value.rrf_score, payload=_candidate_payload(value))
            for value in (candidate, *extra_points)
        )
    )
    source_provider = source_provider or StaticSourceVerificationProvider(
        [_source_verification(value) for value in (candidate, *extra_points)]
    )
    engine = RetrievalEngine(
        embedding=embedding,
        store=store,
        reranker=reranker or FakeReranker(),
        authorization_provider=StaticAuthorizationProvider([scope]),
        source_provider=source_provider,
        config=RetrievalConfig(reranker_score_cutoff=0.0),
        clock=lambda: NOW,
    )
    return engine, embedding, store


def test_query_preparation_preserves_original_and_normalizes_only_whitespace():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="Kế hoạch phát hành bản thử nghiệm vào thứ Sáu.")
    meeting_id = candidate.provenance.meeting_id
    scope = _scope(meeting_id)
    engine, embedding, _ = _engine(candidate, scope=scope)

    result = engine.retrieve(
        RetrievalRequest(
            contractVersion="1.0",
            query="  Kế hoạch   phát hành\tAPI thứ Sáu?  ",
            authorizedScope=scope,
        )
    )

    assert result.status is RetrievalStatus.EVIDENCE_AVAILABLE
    assert result.query_original == "  Kế hoạch   phát hành\tAPI thứ Sáu?  "
    assert result.query_normalized == "Kế hoạch phát hành API thứ Sáu?"
    assert embedding.queries == [result.query_normalized]


def test_empty_authorized_scope_returns_without_querying_qdrant():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="nội dung không được truy cập")
    scope = _scope()
    engine, embedding, store = _engine(candidate, scope=scope)

    result = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="Nội dung là gì?", authorizedScope=scope)
    )

    assert result.status is RetrievalStatus.EMPTY_AUTHORIZATION
    assert store.calls == 0
    assert embedding.queries == []
    assert result.evidence == ()


def test_empty_and_excessive_questions_are_explicit_invalid_results():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="nội dung")
    scope = _scope(candidate.provenance.meeting_id)
    engine, _, store = _engine(candidate, scope=scope)

    empty = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query=" \t\n ", authorizedScope=scope)
    )
    excessive = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="x" * 4_097, authorizedScope=scope)
    )

    assert empty.status is RetrievalStatus.INVALID_QUESTION
    assert excessive.status is RetrievalStatus.INVALID_QUESTION
    assert store.calls == 0


def test_expired_scope_fails_closed_without_qdrant_access():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="nội dung")
    scope = _scope(candidate.provenance.meeting_id).model_copy(
        update={"expires_at": "2026-11-09T11:59:59Z"}
    )
    engine, _, store = _engine(candidate, scope=scope)

    result = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="Nội dung là gì?", authorizedScope=scope)
    )

    assert result.status is RetrievalStatus.INVALID_AUTHORIZATION
    assert result.failures[0].code == "SCOPE_EXPIRED"
    assert store.calls == 0


def test_user_meeting_filter_only_intersects_authorized_scope():
    compatibility = _compatibility()
    allowed = _candidate(compatibility, text="kế hoạch", meeting_id=str(uuid4()))
    denied_meeting = str(uuid4())
    scope = _scope(allowed.provenance.meeting_id, denied_meeting)
    engine, _, store = _engine(allowed, scope=scope)
    store.points = ()

    result = engine.retrieve(
        RetrievalRequest(
            contractVersion="1.0",
            query="Kế hoạch là gì?",
            authorizedScope=scope,
            userFilters=RetrievalFilters(meetingIds=(denied_meeting,)),
        )
    )

    assert result.status is RetrievalStatus.INSUFFICIENT_EVIDENCE
    assert store.calls == 1


def test_out_of_scope_qdrant_candidate_is_integrity_failure_and_never_reranked():
    compatibility = _compatibility()
    authorized = _candidate(compatibility, text="kế hoạch", meeting_id=str(uuid4()))
    outside = _candidate(compatibility, text="kế hoạch bí mật", meeting_id=str(uuid4()))
    scope = _scope(authorized.provenance.meeting_id)
    reranker = FakeReranker()
    engine, _, _ = _engine(authorized, scope=scope, reranker=reranker, extra_points=(outside,))

    result = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="Kế hoạch là gì?", authorizedScope=scope)
    )

    assert result.status is RetrievalStatus.RETRIEVAL_FAILURE
    assert result.failures[0].code == "FILTER_INTEGRITY_FAILURE"
    assert reranker.calls == []
    assert result.evidence == ()


def test_stale_source_is_removed_before_reranking():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="kế hoạch phát hành")
    scope = _scope(candidate.provenance.meeting_id)
    source_provider = StaticSourceVerificationProvider([_source_verification(candidate, status="SUPERSEDED")])
    reranker = FakeReranker()
    engine, _, _ = _engine(
        candidate,
        scope=scope,
        reranker=reranker,
        source_provider=source_provider,
    )

    result = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="Kế hoạch phát hành là gì?", authorizedScope=scope)
    )

    assert result.status is RetrievalStatus.INSUFFICIENT_EVIDENCE
    assert reranker.calls == []
    assert result.diagnostics.source_verification_rejected_count == 1


@pytest.mark.parametrize("status", ["DELETED", "INELIGIBLE", "REVOKED"])
def test_non_current_source_states_never_become_evidence(status):
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="kế hoạch phát hành")
    scope = _scope(candidate.provenance.meeting_id)
    source_provider = StaticSourceVerificationProvider([_source_verification(candidate, status=status)])
    reranker = FakeReranker()
    engine, _, _ = _engine(
        candidate,
        scope=scope,
        reranker=reranker,
        source_provider=source_provider,
    )

    result = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="Kế hoạch phát hành là gì?", authorizedScope=scope)
    )

    assert result.status is RetrievalStatus.INSUFFICIENT_EVIDENCE
    assert result.evidence == ()
    assert reranker.calls == []


def test_missing_source_verification_provider_fails_closed_before_qdrant():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="kế hoạch phát hành")
    scope = _scope(candidate.provenance.meeting_id)
    engine, embedding, store = _engine(candidate, scope=scope)
    engine.source_provider = None

    result = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="Kế hoạch phát hành là gì?", authorizedScope=scope)
    )

    assert result.status is RetrievalStatus.SOURCE_VERIFICATION_UNAVAILABLE
    assert result.evidence == ()
    assert embedding.queries == []
    assert store.calls == 0


def test_reranker_failure_is_not_silently_downgraded_to_rrf():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="kế hoạch phát hành")
    scope = _scope(candidate.provenance.meeting_id)
    engine, _, _ = _engine(
        candidate,
        scope=scope,
        reranker=FakeReranker(error="INFERENCE_FAILED"),
    )

    result = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="Kế hoạch phát hành là gì?", authorizedScope=scope)
    )

    assert result.status is RetrievalStatus.RERANKER_FAILURE
    assert result.failures[0].code == "INFERENCE_FAILED"
    assert result.evidence == ()


def test_weak_or_unrelated_evidence_returns_insufficient_evidence():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="chi phí lưu trữ không liên quan")
    scope = _scope(candidate.provenance.meeting_id)
    engine, _, _ = _engine(
        candidate,
        scope=scope,
        reranker=FakeReranker(scores={candidate.point_id: -1.0}),
    )

    result = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="Ai phụ trách kế hoạch phát hành?", authorizedScope=scope)
    )

    assert result.status is RetrievalStatus.INSUFFICIENT_EVIDENCE
    assert result.evidence == ()


def test_source_verification_unavailable_is_explicit():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="kế hoạch phát hành")
    scope = _scope(candidate.provenance.meeting_id)
    source_provider = StaticSourceVerificationProvider([], unavailable=True)
    engine, _, _ = _engine(candidate, scope=scope, source_provider=source_provider)

    result = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="Kế hoạch phát hành là gì?", authorizedScope=scope)
    )

    assert result.status is RetrievalStatus.SOURCE_VERIFICATION_UNAVAILABLE
    assert result.evidence == ()


def test_retrieval_candidate_requires_complete_compatible_provenance():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text="nội dung")
    payload = candidate.model_dump(mode="json", by_alias=True)
    payload["provenance"]["sourceCurrent"] = False

    with pytest.raises(ValueError):
        RetrievalCandidate.model_validate(payload)


def test_reranker_manifest_is_pinned_and_verified_offline(tmp_path):
    manifest = load_bge_reranker_manifest()
    assert manifest.model_id == "BAAI/bge-reranker-v2-m3"
    assert manifest.revision == RERANKER_REVISION
    snapshot = tmp_path / manifest.revision
    snapshot.mkdir()
    for name in manifest.required_files:
        (snapshot / name).write_bytes(b"artifact")
    (snapshot / "config.json").write_text(
        '{"architectures":["XLMRobertaForSequenceClassification"],"model_type":"xlm-roberta",'
        '"max_position_embeddings":8194}'
    )
    (snapshot / "tokenizer_config.json").write_text('{"model_type":"xlm-roberta"}')
    (snapshot / "special_tokens_map.json").write_text("{}")

    assert BgeRerankerProvisioner(tmp_path).verify(snapshot).path == snapshot
    (snapshot / "model.safetensors").unlink()
    with pytest.raises(Exception) as error:
        BgeRerankerProvisioner(tmp_path).verify(snapshot)
    assert getattr(error.value, "category", None) == "MODEL_ARTIFACT_INCOMPLETE"


def test_qdrant_query_uses_identical_filters_for_dense_sparse_and_native_rrf():
    from types import SimpleNamespace

    from sme_meeting_ai.rag.qdrant import QdrantConfig, QdrantVectorStore
    from sme_meeting_ai.rag.retrieval import build_effective_scope

    compatibility = _compatibility()
    meeting_id = str(uuid4())
    scope = _scope(meeting_id)
    context = StaticAuthorizationProvider([scope]).verify(scope, now=NOW)
    effective = build_effective_scope(context, RetrievalFilters(), compatibility)
    query = QueryEmbedding(
        query_index=0,
        dense=(0.1,) * 1024,
        sparse=SparseEmbedding(indices=(7,), values=(1.0,)),
        compatibility=compatibility,
    )
    client = QdrantClient(location=":memory:")
    store = QdrantVectorStore(
        QdrantConfig(url="http://127.0.0.1:6333", collection_name="rag-t03-query"),
        compatibility=compatibility,
        client=client,
    )
    store.ensure_schema()
    calls = []

    with pytest.raises(QdrantSchemaError, match="Authorized retrieval filter is incomplete"):
        store.query_hybrid(query, models.Filter(), dense_limit=40, sparse_limit=40, fusion_limit=40)

    def query_points(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(points=[])

    client.query_points = query_points
    try:
        assert store.query_hybrid(
            query,
            build_authorization_filter(effective),
            dense_limit=40,
            sparse_limit=40,
            fusion_limit=40,
        ) == ()
    finally:
        store.close()

    assert len(calls) == 1
    call = calls[0]
    assert call["with_vectors"] is False
    assert call["query"].fusion.value == "rrf"
    assert len(call["prefetch"]) == 2
    assert call["prefetch"][0].using == "dense"
    assert call["prefetch"][1].using == "sparse"
    assert call["prefetch"][0].filter is call["prefetch"][1].filter


class FakeRerankerTokenizer:
    def __call__(self, text, **kwargs):
        del kwargs
        return {"input_ids": list(range(len(text.split())))}

    def decode(self, token_ids, **kwargs):
        del kwargs
        return " ".join(f"t{token_id}" for token_id in token_ids)

    def build_inputs_with_special_tokens(self, first, second):
        return [0, *first, 2, 2, *second, 2]


class FakeRerankerModel:
    def __init__(self, scores):
        self.scores = scores
        self.calls = []

    def compute_score(self, pairs, **kwargs):
        self.calls.append((pairs, kwargs))
        return self.scores


def test_reranker_adapter_bounds_pairs_and_rejects_nonfinite_scores():
    compatibility = _compatibility()
    candidate = _candidate(compatibility, text=" ".join(f"t{i}" for i in range(700)))
    model = FakeRerankerModel([2.0])
    adapter = BgeRerankerAdapter(
        BgeRerankerConfig(model_path=None),
        model=model,
        tokenizer=FakeRerankerTokenizer(),
    )

    scores = adapter.rerank(" ".join(f"q{i}" for i in range(300)), (candidate,))

    assert scores[0].score == 2.0
    assert scores[0].input_truncated is True
    assert len(model.calls[0][0][0][0].split()) <= 256
    assert len(model.calls[0][0][0][1].split()) <= 512
    assert model.calls[0][1]["normalize"] is False

    bad = BgeRerankerAdapter(
        BgeRerankerConfig(model_path=None),
        model=FakeRerankerModel([np.nan]),
        tokenizer=FakeRerankerTokenizer(),
    )
    with pytest.raises(RerankerError, match="SCORE_NONFINITE"):
        bad.rerank("query", (candidate,))


def test_dedup_prefers_confirmed_decision_and_diversifies_meetings():
    compatibility = _compatibility()
    first = _candidate(compatibility, text="Kế hoạch phát hành vào thứ Sáu.", meeting_id=str(uuid4()))
    duplicate_summary = _candidate(
        compatibility,
        text=first.retrieval_text,
        meeting_id=first.provenance.meeting_id,
        source_type="SUMMARY",
        authority_class="SECONDARY_APPROVED_SUMMARY",
    )
    second_meeting = _candidate(
        compatibility,
        text="Nhóm kỹ thuật gửi báo cáo trước cuộc họp tiếp theo.",
        meeting_id=str(uuid4()),
    )
    decision = _candidate(
        compatibility,
        text=first.retrieval_text,
        meeting_id=first.provenance.meeting_id,
        source_type="DECISION",
        authority_class="CONFIRMED_DECISION",
    )
    scope = _scope(first.provenance.meeting_id, second_meeting.provenance.meeting_id)
    reranker = FakeReranker(
        scores={first.point_id: 0.8, duplicate_summary.point_id: 0.9, second_meeting.point_id: 0.7, decision.point_id: 0.75}
    )
    engine, _, _ = _engine(
        first,
        scope=scope,
        reranker=reranker,
        extra_points=(duplicate_summary, second_meeting, decision),
    )

    result = engine.retrieve(
        RetrievalRequest(contractVersion="1.0", query="Kế hoạch phát hành và báo cáo là gì?", authorizedScope=scope)
    )

    assert result.status is RetrievalStatus.EVIDENCE_AVAILABLE
    assert len(result.evidence) == 2
    assert result.evidence[0].provenance.authority_class == "CONFIRMED_DECISION"
    assert {item.provenance.meeting_id for item in result.evidence} == {
        first.provenance.meeting_id,
        second_meeting.provenance.meeting_id,
    }
