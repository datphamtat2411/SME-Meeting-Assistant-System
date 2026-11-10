import os
from pathlib import Path
from uuid import uuid4

import numpy as np
import pytest

from sme_meeting_ai.rag import (
    BgeM3EmbeddingAdapter,
    BgeM3EmbeddingConfig,
    BgeM3Provisioner,
    BgeM3Tokenizer,
    IndexingStatus,
    KnowledgeIndexingEngine,
    QdrantConfig,
    QdrantVectorStore,
    bge_m3_chunking_config,
    process_snapshot,
)
from sme_meeting_ai.rag.synthetic import synthetic_vietnamese_snapshot

pytestmark = [pytest.mark.evaluation, pytest.mark.live_infrastructure]


class _QdrantTestTokenizer:
    def __call__(self, text, **kwargs):
        del kwargs
        return {"input_ids": [0, *range(len(text.split())), 2]}


class _QdrantTestModel:
    def _encode(self, texts):
        dense = np.full((len(texts), 1024), 0.125, dtype=np.float32)
        sparse = [{"7": 0.5 + index, "100": 0.25} for index, _ in enumerate(texts)]
        return {"dense_vecs": dense, "lexical_weights": sparse}

    def encode_corpus(self, texts, **kwargs):
        del kwargs
        return self._encode(texts)

    def encode_queries(self, texts, **kwargs):
        del kwargs
        return self._encode(texts)


def _model_path() -> Path:
    value = os.getenv("AI_RAG_MODEL_PATH")
    if not value:
        pytest.skip("AI_RAG_MODEL_PATH is not configured")
    path = Path(value)
    if not path.is_dir():
        pytest.skip("AI_RAG_MODEL_PATH is not provisioned")
    return path


def _second_snapshot():
    snapshot = synthetic_vietnamese_snapshot()
    meeting_id = str(uuid4())
    source_id = str(uuid4())
    snapshot_id = str(uuid4())
    media_id = str(uuid4())
    job_id = str(uuid4())
    speaker_ids = (str(uuid4()), str(uuid4()))
    segment_ids = (str(uuid4()), str(uuid4()))
    identity = snapshot.metadata.source_identity.model_copy(
        update={"source_id": source_id, "meeting_id": meeting_id}
    )
    metadata = snapshot.metadata.model_copy(
        update={"snapshot_id": snapshot_id, "meeting_id": meeting_id, "source_identity": identity}
    )
    speakers = tuple(
        speaker.model_copy(update={"id": speaker_ids[index]})
        for index, speaker in enumerate(snapshot.payload.speakers)
    )
    segments = tuple(
        segment.model_copy(
            update={
                "id": segment_ids[index],
                "speaker_cluster_id": speaker_ids[index],
            }
        )
        for index, segment in enumerate(snapshot.payload.transcript.segments)
    )
    transcript = snapshot.payload.transcript.model_copy(
        update={
            "id": source_id,
            "meeting_id": meeting_id,
            "source_media_id": media_id,
            "processing_job_id": job_id,
            "segments": segments,
        }
    )
    payload = snapshot.payload.model_copy(update={"transcript": transcript, "speakers": speakers})
    return snapshot.model_copy(update={"metadata": metadata, "payload": payload})


def test_real_bge_m3_vietnamese_smoke():
    if os.getenv("AI_RUN_RAG_LIVE") != "1":
        pytest.skip("Set AI_RUN_RAG_LIVE=1 to run real BGE-M3 inference")
    model_path = _model_path()
    snapshot = BgeM3Provisioner(model_path).verify(model_path)
    tokenizer = BgeM3Tokenizer(model_path, manifest=snapshot.manifest)
    config = bge_m3_chunking_config(tokenizer)
    processing = process_snapshot(synthetic_vietnamese_snapshot(), token_counter=tokenizer, config=config)
    assert processing.status.value == "PROCESSED"
    adapter = BgeM3EmbeddingAdapter(
        BgeM3EmbeddingConfig(
            model_path=model_path,
            index_configuration_sha256=config.index_generation.configuration_sha256,
        ),
        tokenizer=tokenizer,
        manifest=snapshot.manifest,
    )
    try:
        embeddings = adapter.embed_documents(processing.chunks)
    finally:
        adapter.close()
    assert len(embeddings) == len(processing.chunks)
    assert all(len(value.dense) == 1024 for value in embeddings)
    assert all(value.sparse.indices and value.sparse.values for value in embeddings)


def test_real_bge_m3_qdrant_vietnamese_indexing():
    if os.getenv("AI_RUN_RAG_LIVE") != "1":
        pytest.skip("Set AI_RUN_RAG_LIVE=1 to run the isolated live indexing test")
    model_path = _model_path()
    qdrant_url = os.getenv("AI_RAG_QDRANT_URL")
    if not qdrant_url:
        pytest.skip("AI_RAG_QDRANT_URL is not configured")
    collection = os.getenv("AI_RAG_QDRANT_COLLECTION", f"sme_meeting_knowledge_bge_m3_live_{uuid4().hex[:16]}")
    snapshot = BgeM3Provisioner(model_path).verify(model_path)
    tokenizer = BgeM3Tokenizer(model_path, manifest=snapshot.manifest)
    chunking = bge_m3_chunking_config(tokenizer)
    processing = process_snapshot(synthetic_vietnamese_snapshot(), token_counter=tokenizer, config=chunking)
    adapter = BgeM3EmbeddingAdapter(
        BgeM3EmbeddingConfig(
            model_path=model_path,
            index_configuration_sha256=chunking.index_generation.configuration_sha256,
        ),
        tokenizer=tokenizer,
        manifest=snapshot.manifest,
    )
    store = QdrantVectorStore(
        QdrantConfig(url=qdrant_url, collection_name=collection, api_key=os.getenv("AI_RAG_QDRANT_API_KEY")),
        compatibility=adapter.compatibility,
    )
    second_processing = process_snapshot(
        _second_snapshot(), token_counter=tokenizer, config=chunking
    )
    assert second_processing.status.value == "PROCESSED"
    try:
        engine = KnowledgeIndexingEngine(adapter, store, token_counter=tokenizer)
        first = engine.index(processing)
        repeated = engine.index(processing)
        assert first.status is IndexingStatus.INDEXED
        assert repeated.status is IndexingStatus.INDEXED
        assert repeated.point_ids == first.point_ids
        first_count = store.client.get_collection(collection).points_count
        assert first_count == len(processing.chunks)

        additional = engine.index(second_processing)
        assert additional.status is IndexingStatus.INDEXED
        assert additional.persisted_count == len(second_processing.chunks)
        assert store.client.get_collection(collection).points_count == (
            first_count + len(second_processing.chunks)
        )

        incompatible_compatibility = adapter.compatibility.model_copy(
            update={"index_configuration_sha256": "b" * 64}
        )
        incompatible_store = QdrantVectorStore(
            QdrantConfig(url=qdrant_url, collection_name=collection, api_key=os.getenv("AI_RAG_QDRANT_API_KEY")),
            compatibility=incompatible_compatibility,
        )
        try:
            rejected = KnowledgeIndexingEngine(adapter, incompatible_store, token_counter=tokenizer).index(processing)
        finally:
            incompatible_store.close()
        assert rejected.status is IndexingStatus.REJECTED
        assert rejected.issues[0].code == "SCHEMA_INCOMPATIBLE"
        assert store.client.get_collection(collection).points_count == (
            first_count + len(second_processing.chunks)
        )

        point = store.get_point(first.point_ids[0])
        assert point is not None
        assert len(point.vector["dense"]) == 1024
        assert point.payload["source_type"] == "TRANSCRIPT"
    finally:
        adapter.close()
        store.close()


def test_real_qdrant_reuse_and_compatibility_rejection():
    if os.getenv("AI_RUN_RAG_LIVE") != "1":
        pytest.skip("Set AI_RUN_RAG_LIVE=1 to run the real Qdrant integration test")
    qdrant_url = os.getenv("AI_RAG_QDRANT_URL")
    if not qdrant_url:
        pytest.skip("AI_RAG_QDRANT_URL is not configured")
    collection = os.getenv("AI_RAG_QDRANT_COLLECTION", f"sme_meeting_knowledge_bge_m3_test_{uuid4().hex[:16]}")
    tokenizer = BgeM3Tokenizer(tokenizer=_QdrantTestTokenizer())
    chunking = bge_m3_chunking_config(tokenizer)
    processing = process_snapshot(synthetic_vietnamese_snapshot(), token_counter=tokenizer, config=chunking)
    additional_processing = process_snapshot(_second_snapshot(), token_counter=tokenizer, config=chunking)
    assert processing.status.value == "PROCESSED"
    assert additional_processing.status.value == "PROCESSED"
    adapter = BgeM3EmbeddingAdapter(
        BgeM3EmbeddingConfig(
            model_path=None,
            index_configuration_sha256=chunking.index_generation.configuration_sha256,
        ),
        tokenizer=tokenizer,
        model=_QdrantTestModel(),
    )
    store = QdrantVectorStore(
        QdrantConfig(url=qdrant_url, collection_name=collection, api_key=os.getenv("AI_RAG_QDRANT_API_KEY")),
        compatibility=adapter.compatibility,
    )
    try:
        engine = KnowledgeIndexingEngine(adapter, store, token_counter=tokenizer)
        first = engine.index(processing)
        repeated = engine.index(processing)
        assert first.status is IndexingStatus.INDEXED
        assert repeated.status is IndexingStatus.INDEXED
        assert repeated.point_ids == first.point_ids
        first_count = store.client.get_collection(collection).points_count
        assert first_count == len(processing.chunks)

        additional = engine.index(additional_processing)
        assert additional.status is IndexingStatus.INDEXED
        assert store.client.get_collection(collection).points_count == (
            first_count + len(additional_processing.chunks)
        )

        incompatible_store = QdrantVectorStore(
            QdrantConfig(url=qdrant_url, collection_name=collection, api_key=os.getenv("AI_RAG_QDRANT_API_KEY")),
            compatibility=adapter.compatibility.model_copy(
                update={"index_configuration_sha256": "b" * 64}
            ),
        )
        try:
            rejected = KnowledgeIndexingEngine(adapter, incompatible_store, token_counter=tokenizer).index(processing)
        finally:
            incompatible_store.close()
        assert rejected.status is IndexingStatus.REJECTED
        assert rejected.issues[0].code == "SCHEMA_INCOMPATIBLE"
        assert store.client.get_collection(collection).points_count == (
            first_count + len(additional_processing.chunks)
        )
    finally:
        adapter.close()
        store.close()
