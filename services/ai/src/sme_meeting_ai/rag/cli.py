"""Opt-in local tooling for BGE-M3 provisioning, schema setup, and smoke indexing."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Sequence

from .contracts import ProcessingStatus
from .embedding import (
    BgeM3EmbeddingAdapter,
    BgeM3EmbeddingConfig,
    EmbeddingCompatibility,
)
from .indexing import KnowledgeIndexingEngine
from .processing import process_snapshot
from .provisioning import BgeM3Provisioner, ModelProvisioningError, load_bge_m3_manifest
from .qdrant import QdrantConfig, QdrantVectorStore
from .synthetic import synthetic_vietnamese_snapshot
from .tokenizer import BgeM3Tokenizer, bge_m3_chunking_config, bge_m3_index_generation


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sme-ai-rag")
    commands = parser.add_subparsers(dest="command", required=True)

    provision = commands.add_parser("provision-model", help="download or verify the pinned BGE-M3 snapshot")
    provision.add_argument("--cache-dir", type=Path, default=Path(os.getenv("AI_RAG_MODEL_CACHE_DIR", "/var/lib/sme-meeting-ai/models")))
    provision.add_argument("--offline", action="store_true", help="verify the local Hugging Face cache without network access")

    verify = commands.add_parser("verify-model", help="verify an already mounted BGE-M3 snapshot")
    verify.add_argument("--model-path", type=Path, required=True)

    schema = commands.add_parser("init-schema", help="create or validate the named dense/sparse Qdrant collection")
    _add_qdrant_options(schema)
    schema.add_argument("--generation-id", default=os.getenv("AI_RAG_INDEX_GENERATION_ID", "rag-t02-bge-m3-v1"))

    index = commands.add_parser("index-synthetic", help="index the canonical synthetic Vietnamese snapshot")
    index.add_argument("--model-path", type=Path, default=_optional_path("AI_RAG_MODEL_PATH"))
    index.add_argument("--device", default=os.getenv("AI_RAG_INFERENCE_DEVICE", "cpu"))
    index.add_argument("--precision", choices=("fp32", "fp16"), default=os.getenv("AI_RAG_INFERENCE_PRECISION", "fp32"))
    _add_qdrant_options(index)
    index.add_argument("--generation-id", default=os.getenv("AI_RAG_INDEX_GENERATION_ID", "rag-t02-bge-m3-v1"))

    inspect = commands.add_parser("inspect-point", help="inspect one persisted point without issuing a search")
    _add_qdrant_options(inspect)
    inspect.add_argument("--point-id", required=True)
    return parser


def _optional_path(name: str) -> Path | None:
    value = os.getenv(name)
    return Path(value) if value else None


def _add_qdrant_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--qdrant-url", default=os.getenv("AI_RAG_QDRANT_URL", "http://127.0.0.1:6333"))
    parser.add_argument("--collection", default=os.getenv("AI_RAG_QDRANT_COLLECTION", "sme_meeting_knowledge_bge_m3"))


def _compatibility(generation_id: str) -> EmbeddingCompatibility:
    manifest = load_bge_m3_manifest()
    generation = bge_m3_index_generation(
        generation_id=generation_id,
        configuration_version=os.getenv("AI_RAG_INDEX_CONFIGURATION_VERSION", "rag-t02-bge-m3-v1"),
        max_tokens=int(os.getenv("AI_RAG_EMBEDDING_MAX_INPUT_TOKENS", "512")),
        target_tokens=int(os.getenv("AI_RAG_CHUNK_TARGET_TOKENS", "384")),
        manifest=manifest,
    )
    return EmbeddingCompatibility(
        model_id=manifest.model_id,
        model_revision=manifest.revision,
        tokenizer_id=manifest.tokenizer_id,
        index_generation_id=generation_id,
        index_configuration_sha256=generation.configuration_sha256,
    )


def _qdrant_store(url: str, collection: str, generation_id: str) -> QdrantVectorStore:
    return QdrantVectorStore(
        QdrantConfig(
            url=url,
            collection_name=collection,
            api_key=os.getenv("AI_RAG_QDRANT_API_KEY"),
        ),
        compatibility=_compatibility(generation_id),
    )


def _run(args: argparse.Namespace) -> dict[str, object]:
    if args.command == "provision-model":
        snapshot = BgeM3Provisioner(args.cache_dir).provision(offline=args.offline)
        return {"status": "verified", "path": str(snapshot.path), "revision": snapshot.manifest.revision, "offline": args.offline}
    if args.command == "verify-model":
        snapshot = BgeM3Provisioner(args.model_path).verify(args.model_path)
        return {"status": "verified", "path": str(snapshot.path), "revision": snapshot.manifest.revision, "offline": True}
    if args.command == "init-schema":
        store = _qdrant_store(args.qdrant_url, args.collection, args.generation_id)
        try:
            store.ensure_schema()
        finally:
            store.close()
        return {"status": "verified", "collection": args.collection, "generation": args.generation_id}
    if args.command == "index-synthetic":
        if args.model_path is None:
            raise ModelProvisioningError("MODEL_PATH_REQUIRED", "--model-path or AI_RAG_MODEL_PATH is required")
        manifest = load_bge_m3_manifest()
        tokenizer = BgeM3Tokenizer(args.model_path, manifest=manifest)
        chunking = bge_m3_chunking_config(
            tokenizer,
            generation_id=args.generation_id,
            max_tokens=int(os.getenv("AI_RAG_EMBEDDING_MAX_INPUT_TOKENS", "512")),
            target_tokens=int(os.getenv("AI_RAG_CHUNK_TARGET_TOKENS", "384")),
            configuration_version=os.getenv("AI_RAG_INDEX_CONFIGURATION_VERSION", "rag-t02-bge-m3-v1"),
        )
        processing = process_snapshot(
            synthetic_vietnamese_snapshot(), token_counter=tokenizer, config=chunking
        )
        if processing.status is not ProcessingStatus.PROCESSED:
            return {"status": processing.status.value, "issues": [issue.code for issue in processing.issues]}
        config = BgeM3EmbeddingConfig(
            model_path=args.model_path,
            device=args.device,
            precision=args.precision,
            index_generation_id=args.generation_id,
            index_configuration_version=chunking.index_generation.configuration_version,
            index_target_tokens=chunking.target_tokens or chunking.max_tokens,
            index_max_temporal_gap_ms=chunking.max_temporal_gap_ms,
            index_max_units_per_chunk=chunking.max_units_per_chunk,
            index_configuration_sha256=chunking.index_generation.configuration_sha256,
        )
        adapter = BgeM3EmbeddingAdapter(config, tokenizer=tokenizer, manifest=manifest)
        store = _qdrant_store(args.qdrant_url, args.collection, args.generation_id)
        try:
            result = KnowledgeIndexingEngine(
                adapter,
                store,
                token_counter=tokenizer,
                batch_size=64,
                expected_generation_id=args.generation_id,
            ).index(processing)
        finally:
            adapter.close()
            store.close()
        return result.model_dump(mode="json")
    if args.command == "inspect-point":
        store = _qdrant_store(args.qdrant_url, args.collection, os.getenv("AI_RAG_INDEX_GENERATION_ID", "rag-t02-bge-m3-v1"))
        try:
            point = store.get_point(args.point_id)
        finally:
            store.close()
        if point is None:
            return {"status": "not_found", "point_id": args.point_id}
        vectors = getattr(point, "vector", {}) or {}
        dense = vectors.get("dense", []) if isinstance(vectors, dict) else []
        sparse = vectors.get("sparse") if isinstance(vectors, dict) else None
        return {
            "status": "found",
            "point_id": str(getattr(point, "id", args.point_id)),
            "payload": getattr(point, "payload", {}) or {},
            "vectors": {
                "dense_dimensions": len(dense) if isinstance(dense, list) else None,
                "sparse_indices": len(getattr(sparse, "indices", []) or []) if sparse is not None else None,
            },
        }
    raise ValueError("Unsupported command")


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        print(json.dumps(_run(args), ensure_ascii=False, sort_keys=True))
    except (ModelProvisioningError, ValueError) as error:
        category = getattr(error, "category", "COMMAND_FAILED")
        print(json.dumps({"status": "failed", "category": category}, sort_keys=True))
        return 2
    return 0
