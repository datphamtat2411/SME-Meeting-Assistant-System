import json
from dataclasses import dataclass

import numpy as np
import pytest
from pydantic import ValidationError
from qdrant_client import QdrantClient, models

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.rag import (
    BgeM3EmbeddingAdapter,
    BgeM3EmbeddingConfig,
    BgeM3Provisioner,
    BgeM3Tokenizer,
    EmbeddingCompatibility,
    EmbeddingError,
    IndexingStatus,
    KnowledgeIndexingEngine,
    ProcessingResult,
    ProcessingStatus,
    QdrantConfig,
    QdrantSchemaError,
    QdrantVectorStore,
    SparseEmbedding,
    VectorPoint,
    bge_m3_chunking_config,
    build_qdrant_payload,
    load_bge_m3_manifest,
    normalize_bge_m3_output,
    process_snapshot,
)
from sme_meeting_ai.rag.synthetic import synthetic_vietnamese_snapshot


class FakeTokenizer:
    def __call__(self, text, **kwargs):
        del kwargs
        return {"input_ids": [0, *range(len(text.split())), 2]}


class FakeFlagModel:
    def _encode(self, texts):
        dense = np.full((len(texts), 1024), 0.125, dtype=np.float32)
        sparse = [{"100": 0.25, "7": 0.5 + index} for index, _ in enumerate(texts)]
        return {"dense_vecs": dense, "lexical_weights": sparse, "colbert_vecs": None}

    def encode_corpus(self, texts, **kwargs):
        del kwargs
        return self._encode(texts)

    def encode_queries(self, texts, **kwargs):
        del kwargs
        return self._encode(texts)


@dataclass
class FakeStore:
    fail_on_call: int | None = None

    def __post_init__(self):
        self.points = {}
        self.ensure_calls = 0
        self.upsert_calls = 0

    def ensure_schema(self):
        self.ensure_calls += 1

    def upsert(self, points):
        self.upsert_calls += 1
        if self.fail_on_call == self.upsert_calls:
            raise RuntimeError("simulated qdrant failure")
        for point in points:
            self.points[point.point_id] = point
        return len(points)


def tokenizer_and_processing(max_tokens=40):
    tokenizer = BgeM3Tokenizer(tokenizer=FakeTokenizer())
    config = bge_m3_chunking_config(
        tokenizer,
        max_tokens=max_tokens,
        target_tokens=max_tokens // 2,
        max_units_per_chunk=1,
    )
    processing = process_snapshot(synthetic_vietnamese_snapshot(), token_counter=tokenizer, config=config)
    assert processing.status is ProcessingStatus.PROCESSED
    return tokenizer, processing


def adapter(tokenizer, generation_id="rag-t02-bge-m3-v1", max_tokens=40):
    chunking = bge_m3_chunking_config(
        tokenizer,
        generation_id=generation_id,
        max_tokens=max_tokens,
        target_tokens=max(1, max_tokens // 2),
        max_units_per_chunk=1,
    )
    return BgeM3EmbeddingAdapter(
        BgeM3EmbeddingConfig(
            model_path=None,
            max_input_tokens=max_tokens,
            index_generation_id=generation_id,
            index_target_tokens=max(1, max_tokens // 2),
            index_max_units_per_chunk=1,
            index_configuration_sha256=chunking.index_generation.configuration_sha256,
        ),
        tokenizer=tokenizer,
        model=FakeFlagModel(),
    )


def test_manifest_is_immutable_bge_m3_and_offline_artifact_verification(tmp_path):
    manifest = load_bge_m3_manifest()
    assert manifest.model_id == "BAAI/bge-m3"
    assert manifest.revision == "5617a9f61b028005a4858fdac845db406aefb181"
    assert manifest.artifact_format == "pytorch_model.bin"

    snapshot = tmp_path / manifest.revision
    snapshot.mkdir()
    for name in manifest.required_files:
        (snapshot / name).write_bytes(b"artifact")
    (snapshot / "config.json").write_text(
        json.dumps({"model_type": "xlm-roberta", "hidden_size": 1024, "max_position_embeddings": 8192})
    )
    (snapshot / "tokenizer_config.json").write_text(json.dumps({"model_type": "xlm-roberta"}))
    (snapshot / "special_tokens_map.json").write_text("{}")

    verified = BgeM3Provisioner(tmp_path).verify(snapshot)
    assert verified.path == snapshot
    (snapshot / "sparse_linear.pt").unlink()
    with pytest.raises(Exception) as error:
        BgeM3Provisioner(tmp_path).verify(snapshot)
    assert getattr(error.value, "category", None) == "MODEL_ARTIFACT_INCOMPLETE"


def test_real_tokenizer_boundary_is_deterministic_for_vietnamese_and_mixed_text():
    tokenizer = BgeM3Tokenizer(tokenizer=FakeTokenizer())
    text = "Chốt kế hoạch quý IV với API English và dữ liệu Việt Nam."
    assert tokenizer.count(text) == tokenizer.count(text)
    assert tokenizer.count(text) > len(text.split())
    assert tokenizer.ensure_within_budget(text, 64) == tokenizer.count(text)
    with pytest.raises(Exception):
        tokenizer.ensure_within_budget(text, 2)


def test_bge_m3_output_normalization_preserves_order_and_rejects_bad_vectors():
    manifest = load_bge_m3_manifest()
    compatibility = EmbeddingCompatibility(
        model_id=manifest.model_id,
        model_revision=manifest.revision,
        tokenizer_id=manifest.tokenizer_id,
        index_generation_id="rag-t02-bge-m3-v1",
        index_configuration_sha256="a" * 64,
    )
    values = normalize_bge_m3_output(
        {
            "dense_vecs": np.vstack([np.full(1024, 1.0), np.full(1024, 2.0)]),
            "lexical_weights": [{"9": 0.2}, {"3": 0.4}],
        },
        texts=("một", "hai"),
        compatibility=compatibility,
        chunk_ids=("first", "second"),
    )
    assert [value.chunk_id for value in values] == ["first", "second"]
    assert values[0].sparse.indices == (9,)
    assert values[1].dense[0] == 2.0

    with pytest.raises(EmbeddingError, match="DENSE_OUTPUT_SHAPE_INVALID"):
        normalize_bge_m3_output(
            {"dense_vecs": np.zeros((1, 3)), "lexical_weights": [{"1": 1.0}]},
            texts=("một",),
            compatibility=compatibility,
        )
    with pytest.raises(EmbeddingError, match="SPARSE_VECTOR_INVALID"):
        normalize_bge_m3_output(
            {"dense_vecs": np.zeros((1, 1024)), "lexical_weights": [{"1": 0.0}]},
            texts=("một",),
            compatibility=compatibility,
        )


def test_adapter_supports_query_embeddings_through_the_same_model_contract():
    tokenizer = BgeM3Tokenizer(tokenizer=FakeTokenizer())
    model = adapter(tokenizer)
    values = model.embed_queries(("Kế hoạch phát hành là gì?", "What is the release plan?"))
    assert [value.query_index for value in values] == [0, 1]
    assert all(len(value.dense) == 1024 for value in values)
    assert all(value.compatibility.model_revision == model.model_revision for value in values)


def test_indexing_is_idempotent_and_payload_retains_canonical_provenance():
    tokenizer, processing = tokenizer_and_processing()
    model = adapter(tokenizer)
    store = FakeStore()
    engine = KnowledgeIndexingEngine(
        model,
        store,
        token_counter=tokenizer,
        batch_size=1,
        expected_generation_id="rag-t02-bge-m3-v1",
    )

    first = engine.index(processing)
    second = engine.index(processing)

    assert first.status is IndexingStatus.INDEXED
    assert second.status is IndexingStatus.INDEXED
    assert first.point_ids == second.point_ids
    assert len(store.points) == len(processing.chunks)
    point = next(iter(store.points.values()))
    assert point.point_id == processing.chunks[0].chunk_id
    assert point.payload["meeting_id"] == processing.chunks[0].provenance.meeting_id
    assert point.payload["canonical_source_revision"] == 1
    assert point.payload["evidence_references"]
    assert point.payload["embedding_model_revision"] == model.model_revision
    assert point.payload["embedding_tokenizer_id"] == model.tokenizer_id
    assert point.payload["embedding_representation_version"] == model.compatibility.representation_version
    assert point.payload["embedding_index_configuration_sha256"] == (
        model.compatibility.index_configuration_sha256
    )
    assert engine.index_chunks(processing.chunks).status is IndexingStatus.INDEXED


def test_indexing_rejects_ineligible_and_reports_partial_batch_failure():
    tokenizer, processing = tokenizer_and_processing(max_tokens=20)
    model = adapter(tokenizer, max_tokens=20)
    store = FakeStore(fail_on_call=2)
    engine = KnowledgeIndexingEngine(model, store, token_counter=tokenizer, batch_size=1)

    partial = engine.index(processing)
    assert partial.status in {IndexingStatus.PARTIAL, IndexingStatus.FAILED}
    assert partial.persisted_count == 1
    assert partial.failed_chunk_ids

    ineligible = processing.model_copy(update={"status": ProcessingStatus.INELIGIBLE, "chunks": ()})
    rejected = engine.index(ineligible)
    assert rejected.status is IndexingStatus.REJECTED
    assert rejected.persisted_count == 0

    no_content = engine.index(
        ProcessingResult(contract_version="1.0", status=ProcessingStatus.NO_ELIGIBLE_CONTENT)
    )
    assert no_content.status is IndexingStatus.NO_ELIGIBLE_CONTENT
    assert no_content.persisted_count == 0


def test_indexing_rejects_configuration_mismatch_before_schema_or_writes():
    tokenizer, processing = tokenizer_and_processing()
    model = adapter(tokenizer, max_tokens=20)
    store = FakeStore()

    result = KnowledgeIndexingEngine(model, store, token_counter=tokenizer).index(processing)

    assert result.status is IndexingStatus.REJECTED
    assert result.issues[0].code == "INDEX_CONFIGURATION_MISMATCH"
    assert store.ensure_calls == 0
    assert not store.points

    with pytest.raises(ValidationError):
        EmbeddingCompatibility(
            model_id=model.model_id,
            model_revision=model.model_revision,
            tokenizer_id=model.tokenizer_id,
            index_generation_id=model.compatibility.index_generation_id,
        )
    with pytest.raises(ValueError, match="configuration fingerprint"):
        BgeM3EmbeddingConfig(model_path=None)


def test_qdrant_schema_is_named_compatible_and_non_destructive():
    tokenizer, processing = tokenizer_and_processing()
    model = adapter(tokenizer)
    client = QdrantClient(location=":memory:")
    store = QdrantVectorStore(
        QdrantConfig(url="http://127.0.0.1:6333", collection_name="rag-t02-test"),
        compatibility=model.compatibility,
        client=client,
    )
    store.ensure_schema()
    store.ensure_schema()
    info = client.get_collection("rag-t02-test")
    assert set(info.config.params.vectors) == {"dense"}
    assert set(info.config.params.sparse_vectors) == {"sparse"}
    assert info.config.metadata["index_generation_id"] == model.compatibility.index_generation_id

    embedding = model.embed_documents(processing.chunks[:1])[0]
    chunk = processing.chunks[0]
    point = VectorPoint(
        point_id=chunk.chunk_id,
        dense=embedding.dense,
        sparse=embedding.sparse,
        payload=build_qdrant_payload(chunk, embedding),
    )
    assert store.upsert((point,)) == 1
    store.ensure_schema()
    stored = store.get_point(chunk.chunk_id)
    assert stored is not None
    assert len(stored.vector["dense"]) == 1024
    assert stored.payload["source_type"] == "TRANSCRIPT"

    empty_without_metadata = QdrantClient(location=":memory:")
    empty_without_metadata.create_collection(
        collection_name="rag-t02-empty-without-metadata",
        vectors_config={"dense": models.VectorParams(size=1024, distance=models.Distance.COSINE)},
        sparse_vectors_config={"sparse": models.SparseVectorParams()},
    )
    empty_store = QdrantVectorStore(
        QdrantConfig(url="http://127.0.0.1:6333", collection_name="rag-t02-empty-without-metadata"),
        compatibility=model.compatibility,
        client=empty_without_metadata,
    )
    empty_store.ensure_schema()
    assert empty_without_metadata.get_collection("rag-t02-empty-without-metadata").config.metadata == (
        empty_store._collection_metadata()
    )

    populated_without_metadata = QdrantClient(location=":memory:")
    populated_without_metadata.create_collection(
        collection_name="rag-t02-populated-without-metadata",
        vectors_config={"dense": models.VectorParams(size=1024, distance=models.Distance.COSINE)},
        sparse_vectors_config={"sparse": models.SparseVectorParams()},
    )
    legacy_store = QdrantVectorStore(
        QdrantConfig(url="http://127.0.0.1:6333", collection_name="rag-t02-populated-without-metadata"),
        compatibility=model.compatibility,
        client=populated_without_metadata,
    )
    populated_without_metadata.upsert(
        collection_name="rag-t02-populated-without-metadata",
        points=[
            models.PointStruct(
                id=chunk.chunk_id,
                vector={
                    "dense": list(embedding.dense),
                    "sparse": models.SparseVector(
                        indices=list(embedding.sparse.indices), values=list(embedding.sparse.values)
                    ),
                },
                payload=build_qdrant_payload(chunk, embedding),
            )
        ],
        wait=True,
    )
    with pytest.raises(QdrantSchemaError):
        legacy_store.ensure_schema()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("index_generation_id", "rag-t02-other"),
        ("embedding_model_id", "BAAI/other-model"),
        ("embedding_model_revision", "0" * 40),
        ("tokenizer_id", "other-tokenizer"),
        ("representation_version", "other-representation"),
        ("index_configuration_sha256", "d" * 64),
    ],
)
def test_qdrant_rejects_incompatible_collection_compatibility(field, value):
    tokenizer, _ = tokenizer_and_processing()
    model = adapter(tokenizer)
    client = QdrantClient(location=":memory:")
    expected_store = QdrantVectorStore(
        QdrantConfig(url="http://127.0.0.1:6333", collection_name=f"bad-{field}"),
        compatibility=model.compatibility,
        client=client,
    )
    metadata = expected_store._collection_metadata()
    metadata[field] = value
    client.create_collection(
        collection_name=f"bad-{field}",
        vectors_config={"dense": models.VectorParams(size=1024, distance=models.Distance.COSINE)},
        sparse_vectors_config={"sparse": models.SparseVectorParams()},
        metadata=metadata,
    )

    with pytest.raises(QdrantSchemaError):
        expected_store.ensure_schema()


@pytest.mark.parametrize(
    "field",
    [
        "index_generation_id",
        "embedding_model_id",
        "embedding_model_revision",
        "embedding_tokenizer_id",
        "embedding_representation_version",
        "embedding_index_configuration_sha256",
    ],
)
def test_qdrant_rejects_incompatible_persisted_point_compatibility(field):
    tokenizer, processing = tokenizer_and_processing()
    model = adapter(tokenizer)
    chunk = processing.chunks[0]
    embedding = model.embed_documents((chunk,))[0]
    client = QdrantClient(location=":memory:")
    store = QdrantVectorStore(
        QdrantConfig(url="http://127.0.0.1:6333", collection_name=f"point-{field}"),
        compatibility=model.compatibility,
        client=client,
    )
    client.create_collection(
        collection_name=f"point-{field}",
        vectors_config={"dense": models.VectorParams(size=1024, distance=models.Distance.COSINE)},
        sparse_vectors_config={"sparse": models.SparseVectorParams()},
        metadata=store._collection_metadata(),
    )
    payload = build_qdrant_payload(chunk, embedding)
    payload[field] = {
        "index_generation_id": "rag-t02-other",
        "embedding_model_id": "BAAI/other-model",
        "embedding_model_revision": "0" * 40,
        "embedding_tokenizer_id": "other-tokenizer",
        "embedding_representation_version": "other-representation",
        "embedding_index_configuration_sha256": "d" * 64,
    }[field]
    client.upsert(
        collection_name=f"point-{field}",
        points=[
            models.PointStruct(
                id=chunk.chunk_id,
                vector={
                    "dense": list(embedding.dense),
                    "sparse": models.SparseVector(
                        indices=list(embedding.sparse.indices), values=list(embedding.sparse.values)
                    ),
                },
                payload=payload,
            )
        ],
        wait=True,
    )

    with pytest.raises(QdrantSchemaError):
        store.ensure_schema()

    incompatible = QdrantClient(location=":memory:")
    incompatible.create_collection(
        collection_name="rag-t02-incompatible",
        vectors_config={"dense": models.VectorParams(size=3, distance=models.Distance.COSINE)},
        sparse_vectors_config={"sparse": models.SparseVectorParams()},
    )
    bad_store = QdrantVectorStore(
        QdrantConfig(url="http://127.0.0.1:6333", collection_name="rag-t02-incompatible"),
        compatibility=model.compatibility,
        client=incompatible,
    )
    with pytest.raises(QdrantSchemaError):
        bad_store.ensure_schema()

    wrong_generation = QdrantClient(location=":memory:")
    wrong_generation.create_collection(
        collection_name="rag-t02-wrong-generation",
        vectors_config={"dense": models.VectorParams(size=1024, distance=models.Distance.COSINE)},
        sparse_vectors_config={"sparse": models.SparseVectorParams()},
        metadata={
            "index_generation_id": "rag-t02-other",
            "embedding_model_id": model.model_id,
            "embedding_model_revision": model.model_revision,
            "tokenizer_id": model.tokenizer_id,
            "representation_version": "bge-m3-dense-sparse-v1",
        },
    )
    wrong_store = QdrantVectorStore(
        QdrantConfig(url="http://127.0.0.1:6333", collection_name="rag-t02-wrong-generation"),
        compatibility=model.compatibility,
        client=wrong_generation,
    )
    with pytest.raises(QdrantSchemaError):
        wrong_store.ensure_schema()


def test_sparse_embedding_contract_rejects_duplicate_or_zero_values():
    with pytest.raises(ValueError):
        SparseEmbedding(indices=(1, 1), values=(0.1, 0.2))
    with pytest.raises(ValueError):
        SparseEmbedding(indices=(1,), values=(0.0,))


def test_rag_settings_are_explicit_and_fail_closed_for_unsafe_runtime_choices():
    defaults = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    assert defaults.rag_model_id == "BAAI/bge-m3"
    assert defaults.rag_model_revision == load_bge_m3_manifest().revision
    assert defaults.rag_embedding_max_input_tokens == 512
    assert defaults.rag_chunk_target_tokens == 384

    with pytest.raises(ValidationError):
        Settings(
            service_name="test-ai",
            service_identity="ai-core",
            _env_file=None,
            rag_inference_precision="fp16",
            rag_inference_device="cpu",
        )
    with pytest.raises(ValidationError):
        Settings(
            service_name="test-ai",
            service_identity="ai-core",
            _env_file=None,
            rag_qdrant_url="http://qdrant.internal:6333",
        )
    assert Settings(
        service_name="test-ai",
        service_identity="ai-core",
        _env_file=None,
        rag_qdrant_url="https://qdrant.internal",
    ).rag_qdrant_url == "https://qdrant.internal"
