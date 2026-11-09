from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

import pytest

from sme_meeting_ai.rag import (
    AuthorizedRetrievalScope,
    BgeM3EmbeddingAdapter,
    BgeM3EmbeddingConfig,
    BgeM3Provisioner,
    BgeM3Tokenizer,
    BgeRerankerAdapter,
    BgeRerankerConfig,
    IndexingStatus,
    KnowledgeIndexingEngine,
    ProcessingStatus,
    QdrantConfig,
    QdrantVectorStore,
    RetrievalConfig,
    RetrievalEngine,
    RetrievalRequest,
    RetrievalStatus,
    SourceVerification,
    StaticAuthorizationProvider,
    StaticSourceVerificationProvider,
    bge_m3_chunking_config,
    process_snapshot,
)
from sme_meeting_ai.rag.synthetic import synthetic_vietnamese_snapshot

pytestmark = [pytest.mark.evaluation, pytest.mark.live_infrastructure]


def _live_enabled() -> None:
    if os.getenv("AI_RUN_RAG_LIVE") != "1":
        pytest.skip("Set AI_RUN_RAG_LIVE=1 to run the real T03 retrieval test")


def _model_path(name: str) -> Path:
    value = os.getenv(name)
    if not value:
        pytest.skip(f"{name} is not configured")
    path = Path(value)
    if not path.is_dir():
        pytest.skip(f"{name} is not provisioned")
    return path


def _second_snapshot():
    base = synthetic_vietnamese_snapshot()
    meeting_id = str(uuid4())
    source_id = str(uuid4())
    snapshot_id = str(uuid4())
    media_id = str(uuid4())
    job_id = str(uuid4())
    speaker_ids = (str(uuid4()), str(uuid4()))
    segment_ids = (str(uuid4()), str(uuid4()))
    identity = base.metadata.source_identity.model_copy(
        update={"source_id": source_id, "meeting_id": meeting_id}
    )
    metadata = base.metadata.model_copy(
        update={"snapshot_id": snapshot_id, "meeting_id": meeting_id, "source_identity": identity}
    )
    speakers = tuple(
        speaker.model_copy(update={"id": speaker_ids[index]})
        for index, speaker in enumerate(base.payload.speakers)
    )
    segments = tuple(
        segment.model_copy(
            update={
                "id": segment_ids[index],
                "speaker_cluster_id": speaker_ids[index],
                "text": (
                    "Cuộc họp thứ hai thống nhất kiểm thử OAuth API vào ngày thứ Hai."
                    if index == 0
                    else "Nhóm nền tảng sẽ gửi báo cáo OAuth trước cuộc họp tiếp theo."
                ),
            }
        )
        for index, segment in enumerate(base.payload.transcript.segments)
    )
    transcript = base.payload.transcript.model_copy(
        update={
            "id": source_id,
            "meeting_id": meeting_id,
            "source_media_id": media_id,
            "processing_job_id": job_id,
            "segments": segments,
        }
    )
    payload = base.payload.model_copy(update={"transcript": transcript, "speakers": speakers})
    return base.model_copy(update={"metadata": metadata, "payload": payload})


def test_real_t03_authorized_hybrid_and_reranking():
    _live_enabled()
    embedding_path = _model_path("AI_RAG_MODEL_PATH")
    reranker_path = _model_path("AI_RAG_RERANKER_MODEL_PATH")
    qdrant_url = os.getenv("AI_RAG_QDRANT_URL")
    if not qdrant_url:
        pytest.skip("AI_RAG_QDRANT_URL is not configured")

    embedding_snapshot = BgeM3Provisioner(embedding_path).verify(embedding_path)
    tokenizer = BgeM3Tokenizer(embedding_path, manifest=embedding_snapshot.manifest)
    chunking = bge_m3_chunking_config(tokenizer)
    first_snapshot = synthetic_vietnamese_snapshot()
    second_snapshot = _second_snapshot()
    first_processing = process_snapshot(first_snapshot, token_counter=tokenizer, config=chunking)
    second_processing = process_snapshot(second_snapshot, token_counter=tokenizer, config=chunking)
    assert first_processing.status is second_processing.status is ProcessingStatus.PROCESSED

    embedding = BgeM3EmbeddingAdapter(
        BgeM3EmbeddingConfig(
            model_path=embedding_path,
            index_configuration_sha256=chunking.index_generation.configuration_sha256,
        ),
        tokenizer=tokenizer,
        manifest=embedding_snapshot.manifest,
    )
    reranker = BgeRerankerAdapter(
        BgeRerankerConfig(model_path=reranker_path),
    )
    collection = f"sme_meeting_rag_t03_{uuid4().hex[:16]}"
    store = QdrantVectorStore(
        QdrantConfig(
            url=qdrant_url,
            collection_name=collection,
            api_key=os.getenv("AI_RAG_QDRANT_API_KEY"),
        ),
        compatibility=embedding.compatibility,
    )
    first_meeting = first_snapshot.metadata.meeting_id
    second_meeting = second_snapshot.metadata.meeting_id
    try:
        engine = KnowledgeIndexingEngine(embedding, store, token_counter=tokenizer)
        assert engine.index(first_processing).status is IndexingStatus.INDEXED
        assert engine.index(second_processing).status is IndexingStatus.INDEXED

        source_records = []
        for processing in (first_processing, second_processing):
            assert processing.normalized is not None
            metadata = processing.normalized.metadata
            source_records.append(
                SourceVerification(
                    sourceIdentity=metadata.source_identity,
                    sourceRevision=metadata.source_revision,
                    currentRevision=metadata.source_revision,
                    status="CURRENT",
                    eligible=True,
                    available=True,
                    visible=True,
                    verifiedAt="2026-11-09T12:00:00Z",
                )
            )
        source_provider = StaticSourceVerificationProvider(source_records)
        authorized_scope = AuthorizedRetrievalScope(
            contractVersion="1.0",
            scopeId=str(uuid4()),
            principalId=str(uuid4()),
            scopeVersion="core-live-fixture-v1",
            issuedAt="2026-11-09T11:00:00Z",
            expiresAt="2026-11-09T13:00:00Z",
            allowedMeetingIds=(first_meeting,),
        )
        retrieval = RetrievalEngine(
            embedding=embedding,
            store=store,
            reranker=reranker,
            authorization_provider=StaticAuthorizationProvider([authorized_scope]),
            source_provider=source_provider,
            config=RetrievalConfig(reranker_score_cutoff=0.0),
        )
        result = retrieval.retrieve(
            RetrievalRequest(
                contractVersion="1.0",
                query="Kế hoạch phát hành bản thử nghiệm là gì?",
                authorizedScope=authorized_scope,
            )
        )
        assert result.status is RetrievalStatus.EVIDENCE_AVAILABLE
        assert result.reranker_model_id == "BAAI/bge-reranker-v2-m3"
        assert result.evidence
        assert {item.provenance.meeting_id for item in result.evidence} == {first_meeting}
        assert all(item.verification_status == "AUTHORITATIVELY_VERIFIED" for item in result.evidence)

        cross_scope = authorized_scope.model_copy(update={"allowed_meeting_ids": (first_meeting, second_meeting)})
        cross_retrieval = RetrievalEngine(
            embedding=embedding,
            store=store,
            reranker=reranker,
            authorization_provider=StaticAuthorizationProvider([cross_scope]),
            source_provider=source_provider,
            config=RetrievalConfig(reranker_score_cutoff=0.0),
        )
        cross_result = cross_retrieval.retrieve(
            RetrievalRequest(
                contractVersion="1.0",
                query="OAuth API và báo cáo cuộc họp thứ hai là gì?",
                authorizedScope=cross_scope,
            )
        )
        assert cross_result.status is RetrievalStatus.EVIDENCE_AVAILABLE
        assert any(item.provenance.meeting_id == second_meeting for item in cross_result.evidence)

        unauthorized_result = retrieval.retrieve(
            RetrievalRequest(
                contractVersion="1.0",
                query="OAuth API cuộc họp thứ hai",
                authorizedScope=authorized_scope,
            )
        )
        assert all(item.provenance.meeting_id != second_meeting for item in unauthorized_result.evidence)
    finally:
        reranker.close()
        embedding.close()
        try:
            store.client.delete_collection(collection_name=collection)
        finally:
            store.close()
