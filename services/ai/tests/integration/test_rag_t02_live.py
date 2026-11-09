import os
from pathlib import Path

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


def _model_path() -> Path:
    value = os.getenv("AI_RAG_MODEL_PATH")
    if not value:
        pytest.skip("AI_RAG_MODEL_PATH is not configured")
    path = Path(value)
    if not path.is_dir():
        pytest.skip("AI_RAG_MODEL_PATH is not provisioned")
    return path


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
        BgeM3EmbeddingConfig(model_path=model_path), tokenizer=tokenizer, manifest=snapshot.manifest
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
    collection = os.getenv("AI_RAG_QDRANT_COLLECTION", "sme_meeting_knowledge_bge_m3_live")
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
    try:
        result = KnowledgeIndexingEngine(adapter, store, token_counter=tokenizer).index(processing)
        assert result.status is IndexingStatus.INDEXED
        assert result.persisted_count == len(processing.chunks)
        point = store.get_point(result.point_ids[0])
        assert point is not None
        assert len(point.vector["dense"]) == 1024
        assert point.payload["source_type"] == "TRANSCRIPT"
    finally:
        adapter.close()
        store.close()
