"""Deterministic T02 indexing orchestration from T01 results to Qdrant points."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Sequence
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .contracts import KnowledgeChunk, ProcessingResult, ProcessingStatus
from .embedding import ChunkEmbedding, EmbeddingError, ModelAdapter
from .processing import TokenCounter
from .qdrant import QdrantError, VectorPoint, VectorStore


class IndexingError(ValueError):
    """The supplied T01 result cannot be indexed safely."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class IndexingStatus(StrEnum):
    INDEXED = "INDEXED"
    NO_ELIGIBLE_CONTENT = "NO_ELIGIBLE_CONTENT"
    REJECTED = "REJECTED"
    FAILED = "FAILED"
    PARTIAL = "PARTIAL"


class IndexingIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    code: str = Field(min_length=1)
    severity: str


class IndexingResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    status: IndexingStatus
    chunk_count: int = Field(ge=0, strict=True)
    attempted_count: int = Field(ge=0, strict=True)
    persisted_count: int = Field(ge=0, strict=True)
    point_ids: tuple[str, ...] = ()
    failed_chunk_ids: tuple[str, ...] = ()
    issues: tuple[IndexingIssue, ...] = ()
    index_generation_id: str | None = None
    model_id: str | None = None
    model_revision: str | None = None


def _issue(code: str, severity: str = "ERROR") -> IndexingIssue:
    return IndexingIssue(code=code, severity=severity)


def build_qdrant_payload(chunk: KnowledgeChunk, embedding: ChunkEmbedding) -> dict[str, Any]:
    """Build derived JSON payload with flat filter fields and full T01 provenance."""

    provenance = chunk.provenance
    identity = provenance.source_identity
    return {
        "meeting_id": provenance.meeting_id,
        "source_type": provenance.source_type,
        "canonical_source_id": identity.source_id,
        "canonical_source_revision": provenance.source_revision.number,
        "canonical_source_identity": identity.model_dump(mode="json", by_alias=True),
        "source_revision": provenance.source_revision.model_dump(mode="json", by_alias=True),
        "chunk_id": chunk.chunk_id,
        "chunk_position": chunk.position,
        "unit_count": chunk.unit_count,
        "token_count": chunk.token_count,
        "index_generation_id": chunk.index_generation.generation_id,
        "index_generation": chunk.index_generation.model_dump(mode="json", by_alias=True),
        "embedding_model_id": embedding.compatibility.model_id,
        "embedding_model_revision": embedding.compatibility.model_revision,
        "embedding_tokenizer_id": embedding.compatibility.tokenizer_id,
        "embedding_representation_version": embedding.compatibility.representation_version,
        "embedding_index_configuration_sha256": embedding.compatibility.index_configuration_sha256,
        "authority_class": provenance.authority_class,
        "quality_class": provenance.quality_class,
        "source_status": provenance.source_status,
        "source_current": provenance.source_current,
        "retrieval_text": chunk.retrieval_text,
        "display_text": chunk.display_text,
        "source_references": [
            reference.model_dump(mode="json", by_alias=True) for reference in provenance.source_references
        ],
        "evidence_references": [
            reference.model_dump(mode="json", by_alias=True) for reference in provenance.evidence_references
        ],
        "speakers": [speaker.model_dump(mode="json", by_alias=True) for speaker in provenance.speakers],
        "timeline_start_ms": provenance.timeline_start_ms,
        "timeline_end_ms": provenance.timeline_end_ms,
        "action_status": provenance.action_status,
        "assignee_user_id": provenance.assignee_user_id,
        "due_date": provenance.due_date,
        "snapshot_id": provenance.snapshot_id,
        "snapshot_sha256": provenance.snapshot_sha256,
        "snapshot_size_bytes": provenance.snapshot_size_bytes,
        "source_media_id": provenance.source_media_id,
        "processing_job_id": provenance.processing_job_id,
        "source_detail": provenance.source_detail,
        "selection_epoch": provenance.selection_epoch,
        "ai_warnings": list(provenance.ai_warnings),
        "confirmed_by_user_id": provenance.confirmed_by_user_id,
        "confirmed_at": provenance.confirmed_at,
        "provenance": provenance.model_dump(mode="json", by_alias=True),
    }


class KnowledgeIndexingEngine:
    """Index validated T01 chunks using bounded, idempotent upsert batches."""

    def __init__(
        self,
        embedding: ModelAdapter,
        store: VectorStore,
        *,
        token_counter: TokenCounter | None = None,
        batch_size: int | None = None,
        expected_generation_id: str | None = None,
    ):
        batch_size = batch_size or getattr(getattr(store, "config", None), "upsert_batch_size", 64)
        if batch_size < 1 or batch_size > 256:
            raise ValueError("Indexing batch size is outside the supported bound")
        self.embedding = embedding
        self.store = store
        self.token_counter = token_counter or getattr(embedding, "tokenizer", None)
        self.batch_size = batch_size
        self.expected_generation_id = expected_generation_id

    def _base_result(
        self,
        status: IndexingStatus,
        *,
        chunk_count: int = 0,
        attempted_count: int = 0,
        persisted_count: int = 0,
        point_ids: Sequence[str] = (),
        failed_chunk_ids: Sequence[str] = (),
        issues: Sequence[IndexingIssue] = (),
        generation_id: str | None = None,
    ) -> IndexingResult:
        compatibility = getattr(self.embedding, "compatibility", None)
        return IndexingResult(
            status=status,
            chunk_count=chunk_count,
            attempted_count=attempted_count,
            persisted_count=persisted_count,
            point_ids=tuple(point_ids),
            failed_chunk_ids=tuple(failed_chunk_ids),
            issues=tuple(issues),
            index_generation_id=generation_id or getattr(compatibility, "index_generation_id", None),
            model_id=getattr(compatibility, "model_id", None),
            model_revision=getattr(compatibility, "model_revision", None),
        )

    def _validate_chunks(self, chunks: Sequence[KnowledgeChunk]) -> str:
        if not chunks:
            raise IndexingError("NO_CHUNKS")
        compatibility = getattr(self.embedding, "compatibility", None)
        if compatibility is None:
            raise IndexingError("EMBEDDING_COMPATIBILITY_MISSING")
        generation_ids = {chunk.index_generation.generation_id for chunk in chunks}
        if len(generation_ids) != 1:
            raise IndexingError("MIXED_INDEX_GENERATIONS")
        generation_fingerprints = {
            chunk.index_generation.model_dump_json() for chunk in chunks
        }
        if len(generation_fingerprints) != 1:
            raise IndexingError("MIXED_INDEX_GENERATION_CONFIGURATIONS")
        generation_id = next(iter(generation_ids))
        if self.expected_generation_id is not None and generation_id != self.expected_generation_id:
            raise IndexingError("INDEX_GENERATION_MISMATCH")
        if generation_id != compatibility.index_generation_id:
            raise IndexingError("EMBEDDING_GENERATION_MISMATCH")
        if any(
            chunk.index_generation.configuration_sha256 != compatibility.index_configuration_sha256
            for chunk in chunks
        ):
            raise IndexingError("INDEX_CONFIGURATION_MISMATCH")
        if any(chunk.index_generation.tokenizer_id != compatibility.tokenizer_id for chunk in chunks):
            raise IndexingError("TOKENIZER_GENERATION_MISMATCH")
        if len({chunk.chunk_id for chunk in chunks}) != len(chunks):
            raise IndexingError("DUPLICATE_CHUNK_ID")
        source_keys = {
            (
                chunk.provenance.source_identity.source_type,
                chunk.provenance.source_identity.source_id,
                chunk.provenance.source_revision.number,
            )
            for chunk in chunks
        }
        if len(source_keys) != 1:
            raise IndexingError("MIXED_SOURCE_REVISIONS")
        if self.token_counter is not None:
            for chunk in chunks:
                try:
                    counted = self.token_counter.count(chunk.retrieval_text)
                except Exception as error:
                    raise IndexingError("TOKEN_COUNTER_FAILED") from error
                if counted != chunk.token_count:
                    raise IndexingError("CHUNK_TOKEN_COUNT_MISMATCH")
        for chunk in chunks:
            if chunk.token_count <= 0:
                raise IndexingError("CHUNK_TOKEN_COUNT_INVALID")
            try:
                UUID(chunk.chunk_id)
            except (ValueError, AttributeError, TypeError) as error:
                raise IndexingError("CHUNK_ID_NOT_QDRANT_UUID") from error
        return generation_id

    def index_chunks(self, chunks: Sequence[KnowledgeChunk]) -> IndexingResult:
        """Index an already validated T01 chunk sequence without rebuilding it."""

        try:
            chunk_tuple = tuple(chunks)
        except TypeError:
            return self._base_result(IndexingStatus.REJECTED, issues=(_issue("CHUNKS_INVALID"),))
        if not all(isinstance(chunk, KnowledgeChunk) for chunk in chunk_tuple):
            return self._base_result(IndexingStatus.REJECTED, issues=(_issue("CHUNKS_INVALID"),))
        return self.index(
            ProcessingResult(contract_version="1.0", status=ProcessingStatus.PROCESSED, chunks=chunk_tuple)
        )

    def index(self, processing: ProcessingResult) -> IndexingResult:
        if not isinstance(processing, ProcessingResult):
            return self._base_result(IndexingStatus.REJECTED, issues=(_issue("PROCESSING_RESULT_INVALID"),))

        if processing.status == ProcessingStatus.NO_ELIGIBLE_CONTENT:
            return self._base_result(
                IndexingStatus.NO_ELIGIBLE_CONTENT,
                issues=tuple(_issue(issue.code, issue.severity) for issue in processing.issues),
            )
        if processing.status != ProcessingStatus.PROCESSED:
            return self._base_result(
                IndexingStatus.REJECTED,
                issues=(
                    _issue(f"PROCESSING_{processing.status.value}"),
                    *tuple(_issue(issue.code, issue.severity) for issue in processing.issues),
                ),
            )

        chunks = tuple(processing.chunks)
        try:
            generation_id = self._validate_chunks(chunks)
        except IndexingError as error:
            return self._base_result(
                IndexingStatus.REJECTED,
                chunk_count=len(chunks),
                failed_chunk_ids=tuple(chunk.chunk_id for chunk in chunks),
                issues=(_issue(error.code),),
            )

        try:
            self.store.ensure_schema()
        except QdrantError as error:
            status = IndexingStatus.REJECTED if error.category == "SCHEMA_INCOMPATIBLE" else IndexingStatus.FAILED
            return self._base_result(
                status,
                chunk_count=len(chunks),
                failed_chunk_ids=tuple(chunk.chunk_id for chunk in chunks),
                issues=(_issue(error.category),),
                generation_id=generation_id,
            )
        except Exception:
            return self._base_result(
                IndexingStatus.FAILED,
                chunk_count=len(chunks),
                failed_chunk_ids=tuple(chunk.chunk_id for chunk in chunks),
                issues=(_issue("SCHEMA_INITIALIZATION_FAILED"),),
                generation_id=generation_id,
            )

        point_ids: list[str] = []
        failed_ids: list[str] = []
        persisted_count = 0
        attempted_count = 0
        for offset in range(0, len(chunks), self.batch_size):
            batch = chunks[offset:offset + self.batch_size]
            attempted_count += len(batch)
            try:
                embeddings = tuple(self.embedding.embed_documents(batch))
                if len(embeddings) != len(batch):
                    raise EmbeddingError("EMBEDDING_OUTPUT_COUNT_INVALID")
                points: list[VectorPoint] = []
                for chunk, embedding in zip(batch, embeddings, strict=True):
                    if not isinstance(embedding, ChunkEmbedding) or embedding.chunk_id != chunk.chunk_id:
                        raise EmbeddingError("EMBEDDING_CHUNK_ORDER_INVALID")
                    if embedding.compatibility != self.embedding.compatibility:
                        raise EmbeddingError("EMBEDDING_COMPATIBILITY_MISMATCH")
                    if embedding.compatibility.index_generation_id != generation_id:
                        raise EmbeddingError("EMBEDDING_GENERATION_MISMATCH")
                    point_ids.append(str(UUID(chunk.chunk_id)))
                    points.append(
                        VectorPoint(
                            point_id=str(UUID(chunk.chunk_id)),
                            dense=embedding.dense,
                            sparse=embedding.sparse,
                            payload=build_qdrant_payload(chunk, embedding),
                        )
                    )
                persisted = self.store.upsert(points)
                if persisted != len(points):
                    raise QdrantError("PERSISTENCE_COUNT_MISMATCH")
                persisted_count += persisted
            except EmbeddingError as error:
                failed_ids.extend(chunk.chunk_id for chunk in chunks[offset:])
                return self._base_result(
                    IndexingStatus.PARTIAL if persisted_count else IndexingStatus.FAILED,
                    chunk_count=len(chunks),
                    attempted_count=attempted_count,
                    persisted_count=persisted_count,
                    point_ids=point_ids[:persisted_count],
                    failed_chunk_ids=failed_ids,
                    issues=(_issue(error.category),),
                    generation_id=generation_id,
                )
            except QdrantError as error:
                failed_ids.extend(chunk.chunk_id for chunk in chunks[offset:])
                return self._base_result(
                    IndexingStatus.PARTIAL if persisted_count else IndexingStatus.FAILED,
                    chunk_count=len(chunks),
                    attempted_count=attempted_count,
                    persisted_count=persisted_count,
                    point_ids=point_ids[:persisted_count],
                    failed_chunk_ids=failed_ids,
                    issues=(_issue(error.category),),
                    generation_id=generation_id,
                )
            except Exception:
                failed_ids.extend(chunk.chunk_id for chunk in chunks[offset:])
                return self._base_result(
                    IndexingStatus.PARTIAL if persisted_count else IndexingStatus.FAILED,
                    chunk_count=len(chunks),
                    attempted_count=attempted_count,
                    persisted_count=persisted_count,
                    point_ids=point_ids[:persisted_count],
                    failed_chunk_ids=failed_ids,
                    issues=(_issue("INDEXING_BATCH_FAILED"),),
                    generation_id=generation_id,
                )

        return self._base_result(
            IndexingStatus.INDEXED,
            chunk_count=len(chunks),
            attempted_count=attempted_count,
            persisted_count=persisted_count,
            point_ids=point_ids,
            generation_id=generation_id,
        )
