"""Qdrant collection/schema adapter for one dense+sparse knowledge point."""

from __future__ import annotations

import math
from dataclasses import dataclass
from math import ceil
from typing import Any, Protocol, Sequence

from qdrant_client import QdrantClient, models

from sme_meeting_ai.core.config import Settings

from .embedding import (
    DENSE_DIMENSIONS,
    EmbeddingCompatibility,
    QueryEmbedding,
    SparseEmbedding,
)


class QdrantError(RuntimeError):
    """A sanitized Qdrant operation failure."""

    def __init__(self, category: str, message: str | None = None):
        self.category = category
        super().__init__(message or category)


class QdrantSchemaError(QdrantError):
    def __init__(self, message: str = "Qdrant collection schema is incompatible"):
        super().__init__("SCHEMA_INCOMPATIBLE", message)


class QdrantPersistenceError(QdrantError):
    def __init__(self, category: str = "PERSISTENCE_FAILED", message: str | None = None):
        super().__init__(category, message)


@dataclass(frozen=True)
class QdrantConfig:
    url: str
    collection_name: str
    api_key: str | None = None
    timeout_seconds: float = 10
    prefer_grpc: bool = False
    upsert_batch_size: int = 64

    @classmethod
    def from_settings(cls, settings: Settings) -> "QdrantConfig":
        return cls(
            url=settings.rag_qdrant_url,
            collection_name=settings.rag_qdrant_collection,
            api_key=settings.rag_qdrant_api_key.get_secret_value()
            if settings.rag_qdrant_api_key is not None
            else None,
            timeout_seconds=settings.rag_qdrant_timeout_seconds,
            upsert_batch_size=settings.rag_qdrant_upsert_batch_size,
        )

    def __post_init__(self) -> None:
        if not self.url.startswith(("http://", "https://")):
            raise ValueError("Qdrant URL must use HTTP or HTTPS")
        if not self.collection_name or len(self.collection_name) > 127:
            raise ValueError("Qdrant collection name is invalid")
        if self.timeout_seconds <= 0 or self.upsert_batch_size < 1:
            raise ValueError("Qdrant limits must be positive")


@dataclass(frozen=True)
class QdrantCollectionSpec:
    collection_name: str
    compatibility: EmbeddingCompatibility
    dense_name: str = "dense"
    sparse_name: str = "sparse"
    dense_dimensions: int = DENSE_DIMENSIONS
    dense_distance: str = "Cosine"

    @property
    def payload_indexes(self) -> dict[str, models.PayloadSchemaType]:
        return {
            "meeting_id": models.PayloadSchemaType.KEYWORD,
            "source_type": models.PayloadSchemaType.KEYWORD,
            "canonical_source_id": models.PayloadSchemaType.KEYWORD,
            "canonical_source_revision": models.PayloadSchemaType.INTEGER,
            "index_generation_id": models.PayloadSchemaType.KEYWORD,
            "embedding_model_id": models.PayloadSchemaType.KEYWORD,
            "embedding_model_revision": models.PayloadSchemaType.KEYWORD,
            "embedding_tokenizer_id": models.PayloadSchemaType.KEYWORD,
            "embedding_representation_version": models.PayloadSchemaType.KEYWORD,
            "embedding_index_configuration_sha256": models.PayloadSchemaType.KEYWORD,
            "authority_class": models.PayloadSchemaType.KEYWORD,
            "quality_class": models.PayloadSchemaType.KEYWORD,
            "source_status": models.PayloadSchemaType.KEYWORD,
            "source_current": models.PayloadSchemaType.BOOL,
        }


@dataclass(frozen=True)
class VectorPoint:
    point_id: str
    dense: tuple[float, ...]
    sparse: SparseEmbedding
    payload: dict[str, Any]


@dataclass(frozen=True)
class QdrantRetrievedPoint:
    """Provider-neutral scored point returned by the native hybrid query."""

    point_id: str
    score: float
    payload: dict[str, Any]


class VectorStore(Protocol):
    def ensure_schema(self) -> None: ...

    def upsert(self, points: Sequence[VectorPoint]) -> int: ...

    def invalidate_source(
        self, meeting_id: str, source_type: str, source_id: str, source_revision: int,
        generation_id: str,
    ) -> int: ...

    def delete_source(
        self, meeting_id: str, source_type: str, source_id: str, source_revision: int,
        generation_id: str,
    ) -> int: ...


class HybridVectorStore(Protocol):
    def query_hybrid(
        self,
        query_embedding: QueryEmbedding,
        query_filter: models.Filter,
        *,
        dense_limit: int,
        sparse_limit: int,
        fusion_limit: int,
    ) -> tuple[QdrantRetrievedPoint, ...]: ...


def bge_m3_collection_spec(
    collection_name: str, compatibility: EmbeddingCompatibility
) -> QdrantCollectionSpec:
    return QdrantCollectionSpec(collection_name=collection_name, compatibility=compatibility)


def _is_not_found(error: Exception) -> bool:
    status_code = getattr(error, "status_code", None)
    if status_code == 404:
        return True
    response = getattr(error, "response", None)
    if getattr(response, "status_code", None) == 404:
        return True
    return isinstance(error, ValueError) and "not found" in str(error).lower()


def _is_transient(error: Exception) -> bool:
    status_code = getattr(error, "status_code", None)
    if status_code is None:
        response = getattr(error, "response", None)
        status_code = getattr(response, "status_code", None)
    return status_code is not None and status_code >= 500


def _enum_name(value: Any) -> str:
    value = getattr(value, "value", value)
    return str(value).split(".")[-1].lower()


def _mapping_value(value: Any, name: str) -> Any:
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


class QdrantVectorStore:
    """Non-destructive Qdrant adapter with schema and write verification."""

    def __init__(
        self,
        config: QdrantConfig,
        *,
        compatibility: EmbeddingCompatibility,
        client: QdrantClient | Any | None = None,
    ):
        self.config = config
        self.spec = bge_m3_collection_spec(config.collection_name, compatibility)
        self.client = client or QdrantClient(
            url=config.url,
            api_key=config.api_key,
            timeout=config.timeout_seconds,
            prefer_grpc=config.prefer_grpc,
        )

    @classmethod
    def from_settings(cls, settings: Settings, compatibility: EmbeddingCompatibility) -> "QdrantVectorStore":
        return cls(QdrantConfig.from_settings(settings), compatibility=compatibility)

    def _get_collection(self) -> Any | None:
        try:
            return self.client.get_collection(collection_name=self.spec.collection_name)
        except Exception as error:
            if _is_not_found(error):
                return None
            category = "QDRANT_UNAVAILABLE" if _is_transient(error) else "SCHEMA_READ_FAILED"
            raise QdrantError(category) from error

    def _create_collection(self) -> None:
        try:
            self.client.create_collection(
                collection_name=self.spec.collection_name,
                vectors_config={
                    self.spec.dense_name: models.VectorParams(
                        size=self.spec.dense_dimensions,
                        distance=models.Distance.COSINE,
                    )
                },
                sparse_vectors_config={
                    self.spec.sparse_name: models.SparseVectorParams(),
                },
                metadata=self._collection_metadata(),
            )
        except Exception as error:
            if _is_transient(error):
                raise QdrantError("QDRANT_UNAVAILABLE") from error
            # A concurrent creator is safe; schema validation below remains authoritative.
            if self._get_collection() is None:
                raise QdrantError("SCHEMA_CREATE_FAILED") from error

    def _collection_metadata(self) -> dict[str, str]:
        compatibility = self.spec.compatibility
        return {
            "index_generation_id": compatibility.index_generation_id,
            "embedding_model_id": compatibility.model_id,
            "embedding_model_revision": compatibility.model_revision,
            "tokenizer_id": compatibility.tokenizer_id,
            "representation_version": compatibility.representation_version,
            "index_configuration_sha256": compatibility.index_configuration_sha256,
        }

    def _validate_vectors(self, info: Any) -> None:
        params = getattr(getattr(info, "config", None), "params", None)
        vectors = getattr(params, "vectors", None)
        dense = _mapping_value(vectors, self.spec.dense_name)
        if dense is None or _mapping_value(vectors, "size") is not None:
            raise QdrantSchemaError()
        size = getattr(dense, "size", None)
        distance = getattr(dense, "distance", None)
        if size != self.spec.dense_dimensions or _enum_name(distance) != self.spec.dense_distance.lower():
            raise QdrantSchemaError()

        sparse_vectors = getattr(params, "sparse_vectors", None)
        sparse = _mapping_value(sparse_vectors, self.spec.sparse_name)
        if sparse is None or _mapping_value(sparse_vectors, "index") is not None:
            raise QdrantSchemaError()

    def _validate_payload_indexes(
        self,
        info: Any,
        *,
        create_missing: bool = True,
        require_all: bool = True,
    ) -> None:
        payload_schema = getattr(info, "payload_schema", None) or {}
        for field_name, expected_type in self.spec.payload_indexes.items():
            existing = payload_schema.get(field_name)
            if existing is None:
                if not create_missing:
                    if require_all:
                        raise QdrantSchemaError("Required Qdrant payload index is missing")
                    continue
                try:
                    self.client.create_payload_index(
                        collection_name=self.spec.collection_name,
                        field_name=field_name,
                        field_schema=expected_type,
                        wait=True,
                    )
                except Exception as error:
                    if _is_transient(error):
                        raise QdrantError("QDRANT_UNAVAILABLE") from error
                    raise QdrantSchemaError("Required Qdrant payload index cannot be created") from error
                continue
            actual_type = getattr(existing, "data_type", existing)
            if _enum_name(actual_type) != _enum_name(expected_type):
                raise QdrantSchemaError("Qdrant payload index has an incompatible type")

    def _scroll_existing_records(self) -> tuple[Any, ...]:
        try:
            records: list[Any] = []
            offset = None
            while True:
                kwargs = {
                    "collection_name": self.spec.collection_name,
                    "limit": 256,
                    "with_payload": True,
                    "with_vectors": False,
                }
                if offset is not None:
                    kwargs["offset"] = offset
                page, next_offset = self.client.scroll(**kwargs)
                records.extend(page)
                if next_offset is None:
                    break
                if next_offset == offset:
                    raise QdrantError("SCHEMA_READ_FAILED")
                offset = next_offset
        except Exception as error:
            if isinstance(error, QdrantError):
                raise
            if _is_transient(error):
                raise QdrantError("QDRANT_UNAVAILABLE") from error
            raise QdrantError("SCHEMA_READ_FAILED") from error
        return tuple(records)

    def _validate_existing_generation(self, records: Sequence[Any] | None = None) -> None:
        records = self._scroll_existing_records() if records is None else records
        expected = {
            "index_generation_id": self.spec.compatibility.index_generation_id,
            "embedding_model_id": self.spec.compatibility.model_id,
            "embedding_model_revision": self.spec.compatibility.model_revision,
            "embedding_tokenizer_id": self.spec.compatibility.tokenizer_id,
            "embedding_representation_version": self.spec.compatibility.representation_version,
            "embedding_index_configuration_sha256": self.spec.compatibility.index_configuration_sha256,
        }
        for record in records:
            payload = getattr(record, "payload", None) or {}
            if any(payload.get(field) != value for field, value in expected.items()):
                raise QdrantSchemaError("Existing Qdrant points belong to another embedding generation")

    def _validate_collection_metadata(self, info: Any, *, populated: bool) -> None:
        expected = self._collection_metadata()
        metadata = getattr(getattr(info, "config", None), "metadata", None)
        metadata = metadata if isinstance(metadata, dict) else {}
        if any(field in metadata and metadata[field] != value for field, value in expected.items()):
            raise QdrantSchemaError("Qdrant collection belongs to another embedding generation")
        if populated and any(field not in metadata for field in expected):
            raise QdrantSchemaError("Populated Qdrant collection has unverifiable generation metadata")
        if all(field in metadata for field in expected):
            return

        try:
            self.client.update_collection(
                collection_name=self.spec.collection_name,
                metadata=expected,
            )
        except Exception as error:
            if _is_transient(error):
                raise QdrantError("QDRANT_UNAVAILABLE") from error
            raise QdrantSchemaError("Qdrant collection generation metadata cannot be established") from error

    @staticmethod
    def _collection_is_populated(info: Any) -> bool:
        """Use collection metadata without reading individual points."""

        points_count = getattr(info, "points_count", None)
        if isinstance(points_count, bool) or points_count is None:
            # An unknown count cannot safely authorize adopting missing metadata.
            return True
        try:
            normalized_count = int(points_count)
        except (TypeError, ValueError, OverflowError):
            return True
        return normalized_count < 0 or normalized_count > 0

    def ensure_schema(self) -> None:
        info = self._get_collection()
        if info is None:
            self._create_collection()
            info = self._get_collection()
            if info is None:
                raise QdrantError("SCHEMA_CREATE_UNVERIFIED")
        self._validate_vectors(info)
        populated = self._collection_is_populated(info)
        self._validate_collection_metadata(info, populated=populated)
        self._validate_payload_indexes(info)

    def audit_existing_generation(self) -> None:
        """Explicitly scan persisted payloads for diagnosis or reconciliation."""

        info = self._get_collection()
        if info is None:
            raise QdrantSchemaError("Qdrant collection does not exist")
        self._validate_vectors(info)
        populated = self._collection_is_populated(info)
        self._validate_collection_metadata(info, populated=populated)
        self._validate_payload_indexes(info, create_missing=False, require_all=True)
        self._validate_existing_generation()

    def validate_retrieval_schema(self) -> None:
        """Validate the active query schema without scanning or mutating points."""

        info = self._get_collection()
        if info is None:
            raise QdrantSchemaError("Qdrant retrieval collection does not exist")
        self._validate_vectors(info)
        # Payload indexes are created by the explicit schema command.  Missing
        # indexes do not weaken the filter, and local Qdrant does not report
        # them after creation, so query preflight validates existing types but
        # never mutates or scans the collection.
        self._validate_payload_indexes(info, create_missing=False, require_all=False)
        metadata = getattr(getattr(info, "config", None), "metadata", None)
        metadata = metadata if isinstance(metadata, dict) else {}
        expected = self._collection_metadata()
        if any(metadata.get(field) != value for field, value in expected.items()):
            raise QdrantSchemaError("Qdrant retrieval collection generation metadata is incompatible")

    def query_hybrid(
        self,
        query_embedding: QueryEmbedding,
        query_filter: models.Filter,
        *,
        dense_limit: int,
        sparse_limit: int,
        fusion_limit: int,
    ) -> tuple[QdrantRetrievedPoint, ...]:
        """Run bounded dense+sparse prefetches fused by Qdrant's native RRF."""

        if query_embedding.compatibility != self.spec.compatibility:
            raise QdrantSchemaError("Query embedding compatibility does not match the active collection")
        for name, limit in (
            ("dense", dense_limit),
            ("sparse", sparse_limit),
            ("fusion", fusion_limit),
        ):
            if limit < 1 or limit > 256:
                raise ValueError(f"Qdrant {name} retrieval limit is outside the supported bound")
        filter_conditions = getattr(query_filter, "must", None) or []
        filter_keys = {getattr(condition, "key", None) for condition in filter_conditions}
        if not {
            "meeting_id",
            "source_current",
            "index_generation_id",
            "embedding_model_revision",
        }.issubset(filter_keys):
            raise QdrantSchemaError("Authorized retrieval filter is incomplete")
        self.validate_retrieval_schema()
        try:
            response = self.client.query_points(
                collection_name=self.spec.collection_name,
                prefetch=[
                    models.Prefetch(
                        query=list(query_embedding.dense),
                        using=self.spec.dense_name,
                        filter=query_filter,
                        limit=dense_limit,
                    ),
                    models.Prefetch(
                        query=models.SparseVector(
                            indices=list(query_embedding.sparse.indices),
                            values=list(query_embedding.sparse.values),
                        ),
                        using=self.spec.sparse_name,
                        filter=query_filter,
                        limit=sparse_limit,
                    ),
                ],
                query=models.FusionQuery(fusion=models.Fusion.RRF),
                limit=fusion_limit,
                with_payload=True,
                with_vectors=False,
                timeout=max(1, ceil(self.config.timeout_seconds)),
            )
        except Exception as error:
            if _is_transient(error):
                raise QdrantError("QDRANT_UNAVAILABLE") from error
            raise QdrantError("QUERY_FAILED") from error

        raw_points = getattr(response, "points", None)
        if not isinstance(raw_points, (list, tuple)):
            raise QdrantError("QUERY_RESPONSE_INVALID")
        result: list[QdrantRetrievedPoint] = []
        for point in raw_points:
            point_id = getattr(point, "id", None)
            score = getattr(point, "score", None)
            payload = getattr(point, "payload", None)
            if point_id is None or not isinstance(payload, dict):
                raise QdrantError("QUERY_RESPONSE_INVALID")
            try:
                normalized_score = float(score)
            except (TypeError, ValueError, OverflowError) as error:
                raise QdrantError("QUERY_RESPONSE_INVALID") from error
            if not math.isfinite(normalized_score):
                raise QdrantError("QUERY_RESPONSE_INVALID")
            result.append(
                QdrantRetrievedPoint(point_id=str(point_id), score=normalized_score, payload=payload)
            )
        return tuple(sorted(result, key=lambda item: (-item.score, item.point_id)))

    @staticmethod
    def _source_filter(
        meeting_id: str, source_type: str, source_id: str, source_revision: int, generation_id: str,
    ) -> models.Filter:
        if not all(isinstance(value, str) and value for value in
                   (meeting_id, source_type, source_id, generation_id)):
            raise ValueError("Qdrant lifecycle identity is invalid")
        if not isinstance(source_revision, int) or isinstance(source_revision, bool) or source_revision < 0:
            raise ValueError("Qdrant lifecycle revision is invalid")
        return models.Filter(must=[
            models.FieldCondition(key="meeting_id", match=models.MatchValue(value=meeting_id)),
            models.FieldCondition(key="source_type", match=models.MatchValue(value=source_type)),
            models.FieldCondition(key="canonical_source_id", match=models.MatchValue(value=source_id)),
            models.FieldCondition(
                key="canonical_source_revision", match=models.MatchValue(value=source_revision),
            ),
            models.FieldCondition(key="index_generation_id", match=models.MatchValue(value=generation_id)),
        ])

    def _scroll_filter(self, query_filter: models.Filter) -> tuple[Any, ...]:
        try:
            records: list[Any] = []
            offset = None
            while True:
                page, next_offset = self.client.scroll(
                    collection_name=self.spec.collection_name,
                    scroll_filter=query_filter,
                    limit=256,
                    offset=offset,
                    with_payload=True,
                    with_vectors=False,
                )
                records.extend(page)
                if next_offset is None:
                    return tuple(records)
                if next_offset == offset:
                    raise QdrantError("PERSISTENCE_VERIFY_FAILED")
                offset = next_offset
        except QdrantError:
            raise
        except Exception as error:
            if _is_transient(error):
                raise QdrantError("QDRANT_UNAVAILABLE") from error
            raise QdrantError("PERSISTENCE_VERIFY_FAILED") from error

    @staticmethod
    def _write_completed(response: Any) -> bool:
        status = getattr(response, "status", None)
        return status is None or _enum_name(status) in {"completed", "ok"}

    def invalidate_source(
        self, meeting_id: str, source_type: str, source_id: str, source_revision: int,
        generation_id: str,
    ) -> int:
        """Mark only the exact source revision non-authoritative and verify it."""

        query_filter = self._source_filter(meeting_id, source_type, source_id, source_revision, generation_id)
        before = self._scroll_filter(query_filter)
        try:
            response = self.client.set_payload(
                collection_name=self.spec.collection_name,
                payload={"source_current": False, "source_status": "INVALIDATED"},
                points=query_filter,
                wait=True,
            )
        except Exception as error:
            if _is_transient(error):
                raise QdrantPersistenceError("QDRANT_UNAVAILABLE") from error
            raise QdrantPersistenceError("PERSISTENCE_FAILED") from error
        if not self._write_completed(response):
            raise QdrantPersistenceError("PERSISTENCE_NOT_COMPLETED")
        after = self._scroll_filter(query_filter)
        if len(after) != len(before) or any(
            not isinstance(getattr(record, "payload", None), dict)
            or record.payload.get("source_current") is not False
            or record.payload.get("source_status") != "INVALIDATED"
            for record in after
        ):
            raise QdrantPersistenceError("PERSISTENCE_VERIFY_FAILED")
        return len(after)

    def delete_source(
        self, meeting_id: str, source_type: str, source_id: str, source_revision: int,
        generation_id: str,
    ) -> int:
        """Physically delete only the exact source revision and verify absence."""

        query_filter = self._source_filter(meeting_id, source_type, source_id, source_revision, generation_id)
        before = self._scroll_filter(query_filter)
        try:
            response = self.client.delete(
                collection_name=self.spec.collection_name,
                points_selector=query_filter,
                wait=True,
            )
        except Exception as error:
            if _is_transient(error):
                raise QdrantPersistenceError("QDRANT_UNAVAILABLE") from error
            raise QdrantPersistenceError("PERSISTENCE_FAILED") from error
        if not self._write_completed(response):
            raise QdrantPersistenceError("PERSISTENCE_NOT_COMPLETED")
        if self._scroll_filter(query_filter):
            raise QdrantPersistenceError("PERSISTENCE_VERIFY_FAILED")
        return len(before)

    def upsert(self, points: Sequence[VectorPoint]) -> int:
        point_tuple = tuple(points)
        if not point_tuple:
            return 0
        seen_ids: set[str] = set()
        expected = {
            "index_generation_id": self.spec.compatibility.index_generation_id,
            "embedding_model_id": self.spec.compatibility.model_id,
            "embedding_model_revision": self.spec.compatibility.model_revision,
            "embedding_tokenizer_id": self.spec.compatibility.tokenizer_id,
            "embedding_representation_version": self.spec.compatibility.representation_version,
            "embedding_index_configuration_sha256": self.spec.compatibility.index_configuration_sha256,
        }
        for point in point_tuple:
            if not isinstance(point, VectorPoint) or not isinstance(point.payload, dict):
                raise QdrantSchemaError("Incoming Qdrant point is invalid")
            if point.point_id in seen_ids or point.payload.get("chunk_id") != point.point_id:
                raise QdrantSchemaError("Incoming Qdrant point identity is invalid")
            seen_ids.add(point.point_id)
            if len(point.dense) != self.spec.dense_dimensions:
                raise QdrantSchemaError("Incoming dense vector has an incompatible dimension")
            try:
                if any(not math.isfinite(float(value)) for value in point.dense):
                    raise QdrantSchemaError("Incoming dense vector contains a non-finite value")
            except (TypeError, ValueError, OverflowError) as error:
                raise QdrantSchemaError("Incoming dense vector is invalid") from error
            if not isinstance(point.sparse, SparseEmbedding):
                raise QdrantSchemaError("Incoming sparse vector is invalid")
            if any(point.payload.get(field) != value for field, value in expected.items()):
                raise QdrantSchemaError("Incoming point belongs to another embedding generation")
            generation = point.payload.get("index_generation")
            if not isinstance(generation, dict) or any(
                generation.get(field) != value
                for field, value in {
                    "generationId": self.spec.compatibility.index_generation_id,
                    "configurationSha256": self.spec.compatibility.index_configuration_sha256,
                    "tokenizerId": self.spec.compatibility.tokenizer_id,
                }.items()
            ):
                raise QdrantSchemaError("Incoming point generation metadata is incompatible")
        qdrant_points = [
            models.PointStruct(
                id=point.point_id,
                vector={
                    self.spec.dense_name: list(point.dense),
                    self.spec.sparse_name: models.SparseVector(
                        indices=list(point.sparse.indices), values=list(point.sparse.values)
                    ),
                },
                payload=point.payload,
            )
            for point in point_tuple
        ]
        try:
            response = self.client.upsert(
                collection_name=self.spec.collection_name,
                points=qdrant_points,
                wait=True,
            )
        except Exception as error:
            if _is_transient(error):
                raise QdrantPersistenceError("QDRANT_UNAVAILABLE") from error
            raise QdrantPersistenceError() from error
        status = getattr(response, "status", None)
        if status is not None and _enum_name(status) not in {"completed", "ok"}:
            raise QdrantPersistenceError("PERSISTENCE_NOT_COMPLETED")

        try:
            persisted = self.client.retrieve(
                collection_name=self.spec.collection_name,
                ids=[point.point_id for point in points],
                with_payload=False,
                with_vectors=False,
            )
        except Exception as error:
            if _is_transient(error):
                raise QdrantPersistenceError("QDRANT_UNAVAILABLE") from error
            raise QdrantPersistenceError("PERSISTENCE_VERIFY_FAILED") from error
        persisted_ids = {str(getattr(record, "id", "")) for record in persisted}
        expected_ids = {point.point_id for point in point_tuple}
        if persisted_ids != expected_ids:
            raise QdrantPersistenceError("PERSISTENCE_VERIFY_FAILED")
        return len(point_tuple)

    def get_point(self, point_id: str) -> Any | None:
        try:
            records = self.client.retrieve(
                collection_name=self.spec.collection_name,
                ids=[point_id],
                with_payload=True,
                with_vectors=True,
            )
        except Exception as error:
            if _is_transient(error):
                raise QdrantError("QDRANT_UNAVAILABLE") from error
            raise QdrantError("POINT_READ_FAILED") from error
        return records[0] if records else None

    def close(self) -> None:
        close = getattr(self.client, "close", None)
        if close is not None:
            close()
