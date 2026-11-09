"""Normalized BGE-M3 dense/sparse inference behind a provider-neutral adapter."""

from __future__ import annotations

import math
import os
import signal
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Protocol, Sequence

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from sme_meeting_ai.core.config import Settings

from .contracts import KnowledgeChunk
from .provisioning import BgeM3Provisioner, ModelManifest, load_bge_m3_manifest
from .tokenizer import BgeM3Tokenizer, TokenizerError, bge_m3_index_generation

DENSE_DIMENSIONS = 1024
SPARSE_INDEX_MAX = 2**32 - 1
REPRESENTATION_VERSION = "bge-m3-dense-sparse-v1"


class EmbeddingError(RuntimeError):
    """Inference or normalization failed before persistence."""

    def __init__(self, category: str, message: str | None = None):
        self.category = category
        super().__init__(message or category)


class ModelAdapter(Protocol):
    model_id: str
    model_revision: str
    tokenizer_id: str

    def embed_documents(self, chunks: Sequence[KnowledgeChunk]) -> tuple["ChunkEmbedding", ...]: ...

    def embed_queries(self, queries: Sequence[str]) -> tuple["QueryEmbedding", ...]: ...


class SparseEmbedding(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    indices: tuple[int, ...]
    values: tuple[float, ...]

    @model_validator(mode="after")
    def validate_sparse(self) -> "SparseEmbedding":
        if not self.indices or len(self.indices) != len(self.values):
            raise ValueError("Sparse embedding must contain matching non-empty indices and values")
        if len(set(self.indices)) != len(self.indices):
            raise ValueError("Sparse embedding indices must be unique")
        if tuple(sorted(self.indices)) != self.indices:
            raise ValueError("Sparse embedding indices must be sorted")
        if any(index < 0 or index > SPARSE_INDEX_MAX for index in self.indices):
            raise ValueError("Sparse embedding index is out of range")
        if any(not math.isfinite(value) or value <= 0 for value in self.values):
            raise ValueError("Sparse embedding weights must be finite and positive")
        return self


class EmbeddingCompatibility(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    model_id: str = Field(min_length=1)
    model_revision: str = Field(pattern=r"^[a-f0-9]{40}$")
    tokenizer_id: str = Field(min_length=1)
    index_generation_id: str = Field(min_length=1)
    index_configuration_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    representation_version: str = REPRESENTATION_VERSION
    dense_dimensions: int = Field(default=DENSE_DIMENSIONS, strict=True)

    @model_validator(mode="after")
    def validate_dimensions(self) -> "EmbeddingCompatibility":
        if self.dense_dimensions != DENSE_DIMENSIONS:
            raise ValueError("BGE-M3 dense dimension must be 1024")
        return self


class EmbeddingVectors(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    dense: tuple[float, ...]
    sparse: SparseEmbedding
    compatibility: EmbeddingCompatibility

    @model_validator(mode="after")
    def validate_dense(self) -> "EmbeddingVectors":
        if len(self.dense) != DENSE_DIMENSIONS:
            raise ValueError("BGE-M3 dense embedding must have 1024 dimensions")
        if any(not math.isfinite(value) for value in self.dense):
            raise ValueError("Dense embedding must contain finite values")
        return self


class ChunkEmbedding(EmbeddingVectors):
    chunk_id: str = Field(min_length=1)


class QueryEmbedding(EmbeddingVectors):
    query_index: int = Field(ge=0, strict=True)


@dataclass(frozen=True)
class BgeM3EmbeddingConfig:
    model_path: Path | None
    model_id: str = "BAAI/bge-m3"
    model_revision: str = "5617a9f61b028005a4858fdac845db406aefb181"
    device: str = "cpu"
    precision: str = "fp32"
    batch_size: int = 8
    max_input_tokens: int = 512
    max_concurrent: int = 1
    init_timeout_seconds: float = 900
    execution_timeout_seconds: float = 900
    index_generation_id: str = "rag-t02-bge-m3-v1"
    index_configuration_version: str = "rag-t02-bge-m3-v1"
    index_target_tokens: int = 384
    index_max_temporal_gap_ms: int = 5_000
    index_max_units_per_chunk: int = 8
    index_configuration_sha256: str | None = None

    @classmethod
    def from_settings(cls, settings: Settings) -> "BgeM3EmbeddingConfig":
        generation = bge_m3_index_generation(
            generation_id=settings.rag_index_generation_id,
            configuration_version=settings.rag_index_configuration_version,
            max_tokens=settings.rag_embedding_max_input_tokens,
            target_tokens=settings.rag_chunk_target_tokens,
        )
        configuration_sha256 = settings.rag_index_configuration_sha256 or generation.configuration_sha256
        if configuration_sha256 != generation.configuration_sha256:
            raise ValueError("Index configuration fingerprint does not match the approved generation")
        return cls(
            model_path=settings.rag_model_path,
            model_id=settings.rag_model_id,
            model_revision=settings.rag_model_revision,
            device=settings.rag_inference_device,
            precision=settings.rag_inference_precision,
            batch_size=settings.rag_embedding_batch_size,
            max_input_tokens=settings.rag_embedding_max_input_tokens,
            max_concurrent=settings.rag_embedding_max_concurrent,
            init_timeout_seconds=settings.rag_model_init_timeout_seconds,
            execution_timeout_seconds=settings.rag_embedding_timeout_seconds,
            index_generation_id=settings.rag_index_generation_id,
            index_configuration_version=settings.rag_index_configuration_version,
            index_target_tokens=settings.rag_chunk_target_tokens,
            index_configuration_sha256=configuration_sha256,
        )

    def __post_init__(self) -> None:
        if self.model_id != "BAAI/bge-m3":
            raise ValueError("Only BAAI/bge-m3 is approved")
        if len(self.model_revision) != 40 or any(char not in "0123456789abcdef" for char in self.model_revision):
            raise ValueError("BGE-M3 revision must be an immutable commit")
        if self.device != "cpu" and not self.device.startswith("cuda"):
            raise ValueError("Unsupported BGE-M3 device")
        if self.precision not in {"fp32", "fp16"} or (self.precision == "fp16" and self.device == "cpu"):
            raise ValueError("Unsupported BGE-M3 precision for the selected device")
        if self.batch_size < 1 or self.batch_size > 256:
            raise ValueError("BGE-M3 batch size is outside the supported bound")
        if self.max_input_tokens < 1 or self.max_input_tokens > 8192:
            raise ValueError("BGE-M3 input token budget is outside the supported bound")
        if self.max_concurrent < 1 or self.max_concurrent > 4:
            raise ValueError("BGE-M3 concurrency is outside the supported bound")
        if self.init_timeout_seconds <= 0 or self.execution_timeout_seconds <= 0:
            raise ValueError("BGE-M3 timeouts must be positive")
        if (
            self.index_configuration_sha256 is None
            or len(self.index_configuration_sha256) != 64
            or any(char not in "0123456789abcdef" for char in self.index_configuration_sha256)
        ):
            raise ValueError("BGE-M3 indexing requires a deterministic configuration fingerprint")
        if self.index_target_tokens < 1 or self.index_target_tokens > self.max_input_tokens:
            raise ValueError("BGE-M3 index target token budget is invalid")
        if self.index_max_temporal_gap_ms < 0 or self.index_max_units_per_chunk < 1:
            raise ValueError("BGE-M3 index chunking limits are invalid")


def _to_numpy(value: Any) -> np.ndarray:
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    return np.asarray(value)


def _dense_batch(raw: Any, count: int) -> tuple[tuple[float, ...], ...]:
    try:
        array = _to_numpy(raw)
    except (TypeError, ValueError) as error:
        raise EmbeddingError("DENSE_OUTPUT_INVALID") from error
    if count == 1 and array.ndim == 1:
        array = array.reshape(1, -1)
    if array.ndim != 2 or array.shape[0] != count or array.shape[1] != DENSE_DIMENSIONS:
        raise EmbeddingError("DENSE_OUTPUT_SHAPE_INVALID")
    if not np.isfinite(array).all():
        raise EmbeddingError("DENSE_OUTPUT_NONFINITE")
    return tuple(tuple(float(value) for value in row) for row in array)


def _sparse_batch(raw: Any, count: int) -> tuple[SparseEmbedding, ...]:
    if count == 1 and isinstance(raw, dict):
        values = [raw]
    elif isinstance(raw, (list, tuple)):
        values = list(raw)
    else:
        raise EmbeddingError("SPARSE_OUTPUT_INVALID")
    if len(values) != count or any(not isinstance(item, dict) for item in values):
        raise EmbeddingError("SPARSE_OUTPUT_COUNT_INVALID")

    result: list[SparseEmbedding] = []
    for item in values:
        pairs: list[tuple[int, float]] = []
        seen: set[int] = set()
        for raw_index, raw_weight in item.items():
            if isinstance(raw_index, bool):
                raise EmbeddingError("SPARSE_INDEX_INVALID")
            try:
                index = int(raw_index)
                weight = float(raw_weight)
            except (TypeError, ValueError, OverflowError) as error:
                raise EmbeddingError("SPARSE_OUTPUT_INVALID") from error
            if str(raw_index).strip() != str(index) and not isinstance(raw_index, int):
                raise EmbeddingError("SPARSE_INDEX_INVALID")
            if index in seen:
                raise EmbeddingError("SPARSE_DUPLICATE_INDEX")
            seen.add(index)
            pairs.append((index, weight))
        pairs.sort(key=lambda pair: pair[0])
        try:
            result.append(
                SparseEmbedding(
                    indices=tuple(index for index, _ in pairs),
                    values=tuple(weight for _, weight in pairs),
                )
            )
        except ValueError as error:
            raise EmbeddingError("SPARSE_VECTOR_INVALID") from error
    return tuple(result)


def normalize_bge_m3_output(
    raw: Any,
    *,
    texts: Sequence[str],
    compatibility: EmbeddingCompatibility,
    chunk_ids: Sequence[str] | None = None,
) -> tuple[EmbeddingVectors | ChunkEmbedding, ...]:
    """Convert FlagEmbedding's raw response into validated internal results."""

    if not isinstance(raw, dict) or "dense_vecs" not in raw or "lexical_weights" not in raw:
        raise EmbeddingError("MODEL_OUTPUT_INVALID")
    count = len(texts)
    if count == 0:
        return ()
    dense = _dense_batch(raw["dense_vecs"], count)
    sparse = _sparse_batch(raw["lexical_weights"], count)
    if chunk_ids is not None and len(chunk_ids) != count:
        raise EmbeddingError("CHUNK_OUTPUT_COUNT_INVALID")
    results: list[EmbeddingVectors | ChunkEmbedding] = []
    for index in range(count):
        try:
            if chunk_ids is None:
                value = EmbeddingVectors(dense=dense[index], sparse=sparse[index], compatibility=compatibility)
            else:
                value = ChunkEmbedding(
                    chunk_id=chunk_ids[index],
                    dense=dense[index],
                    sparse=sparse[index],
                    compatibility=compatibility,
                )
        except ValueError as error:
            raise EmbeddingError("EMBEDDING_CONTRACT_INVALID") from error
        results.append(value)
    return tuple(results)


@contextmanager
def _deadline(seconds: float, category: str):
    """Use a process-local Linux timer where safe; never create runaway retries."""

    if threading.current_thread() is not threading.main_thread() or not hasattr(signal, "setitimer"):
        yield
        return
    previous_handler = signal.getsignal(signal.SIGALRM)

    def alarm_handler(_signum, _frame):
        raise EmbeddingError(category)

    signal.signal(signal.SIGALRM, alarm_handler)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


@contextmanager
def _offline_huggingface_environment():
    names = ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")
    previous = {name: os.environ.get(name) for name in names}
    os.environ.update({name: "1" for name in names})
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


_MODEL_INIT_LOCK = threading.Lock()


class BgeM3EmbeddingAdapter:
    """Managed BGE-M3 document/query adapter with no inference-time downloads."""

    def __init__(
        self,
        config: BgeM3EmbeddingConfig,
        *,
        tokenizer: BgeM3Tokenizer | None = None,
        model: Any | None = None,
        manifest: ModelManifest | None = None,
    ):
        self.config = config
        self.manifest = manifest or load_bge_m3_manifest()
        if config.model_id != self.manifest.model_id or config.model_revision != self.manifest.revision:
            raise EmbeddingError("MODEL_MANIFEST_MISMATCH")
        generation = bge_m3_index_generation(
            generation_id=config.index_generation_id,
            configuration_version=config.index_configuration_version,
            max_tokens=config.max_input_tokens,
            target_tokens=config.index_target_tokens,
            max_temporal_gap_ms=config.index_max_temporal_gap_ms,
            max_units_per_chunk=config.index_max_units_per_chunk,
            manifest=self.manifest,
        )
        if config.index_configuration_sha256 != generation.configuration_sha256:
            raise EmbeddingError("INDEX_CONFIGURATION_MISMATCH")
        if config.max_input_tokens > self.manifest.tokenizer_max_model_tokens:
            raise EmbeddingError("MODEL_INPUT_BUDGET_INVALID")
        if tokenizer is None:
            if config.model_path is None:
                raise EmbeddingError("MODEL_PATH_REQUIRED")
            try:
                tokenizer = BgeM3Tokenizer(config.model_path, manifest=self.manifest)
            except TokenizerError as error:
                raise EmbeddingError(error.args[0] if error.args else "TOKENIZER_UNAVAILABLE") from error
        if tokenizer.tokenizer_id != self.manifest.tokenizer_id:
            raise EmbeddingError("TOKENIZER_MANIFEST_MISMATCH")
        self.tokenizer = tokenizer
        self.model_id = self.manifest.model_id
        self.model_revision = self.manifest.revision
        self.tokenizer_id = self.manifest.tokenizer_id
        self._compatibility = EmbeddingCompatibility(
            model_id=self.model_id,
            model_revision=self.model_revision,
            tokenizer_id=self.tokenizer_id,
            index_generation_id=config.index_generation_id,
            index_configuration_sha256=config.index_configuration_sha256,
        )
        self._closed = False
        self._state_lock = threading.RLock()
        self._inference_slots = threading.BoundedSemaphore(config.max_concurrent)
        if model is None:
            if config.model_path is None:
                raise EmbeddingError("MODEL_PATH_REQUIRED")
            try:
                BgeM3Provisioner(config.model_path, self.manifest).verify(config.model_path)
                with _MODEL_INIT_LOCK, _offline_huggingface_environment(), _deadline(
                    config.init_timeout_seconds, "MODEL_INITIALIZATION_TIMEOUT"
                ):
                    from FlagEmbedding import BGEM3FlagModel

                    model = BGEM3FlagModel(
                        str(config.model_path),
                        normalize_embeddings=self.manifest.normalize_dense,
                        use_fp16=config.precision == "fp16",
                        use_bf16=False,
                        devices=[config.device],
                        batch_size=config.batch_size,
                        query_max_length=config.max_input_tokens,
                        passage_max_length=config.max_input_tokens,
                        return_dense=True,
                        return_sparse=True,
                        return_colbert_vecs=False,
                        trust_remote_code=False,
                    )
            except EmbeddingError:
                raise
            except ImportError as error:
                raise EmbeddingError("INFERENCE_DEPENDENCY_UNAVAILABLE") from error
            except Exception as error:
                raise EmbeddingError("MODEL_INITIALIZATION_FAILED") from error
        self._model = model

    @classmethod
    def from_settings(cls, settings: Settings, **kwargs: Any) -> "BgeM3EmbeddingAdapter":
        return cls(BgeM3EmbeddingConfig.from_settings(settings), **kwargs)

    @property
    def compatibility(self) -> EmbeddingCompatibility:
        return self._compatibility

    def _ensure_open(self) -> None:
        if self._closed:
            raise EmbeddingError("ADAPTER_CLOSED")

    def _validate_texts(self, texts: Iterable[str]) -> tuple[str, ...]:
        result = tuple(texts)
        if any(not isinstance(text, str) or not text for text in result):
            raise EmbeddingError("EMBEDDING_INPUT_INVALID")
        try:
            for text in result:
                self.tokenizer.ensure_within_budget(text, self.config.max_input_tokens)
        except TokenizerError as error:
            raise EmbeddingError(error.args[0] if error.args else "TOKEN_BUDGET_EXCEEDED") from error
        return result

    def _encode(self, texts: Sequence[str], *, query: bool) -> Any:
        self._ensure_open()
        if not texts:
            return ()
        if not self._inference_slots.acquire(timeout=self.config.execution_timeout_seconds):
            raise EmbeddingError("INFERENCE_CONCURRENCY_TIMEOUT")
        try:
            method_name = "encode_queries" if query else "encode_corpus"
            method = getattr(self._model, method_name, None)
            if method is None:
                method = getattr(self._model, "encode", None)
            if method is None:
                raise EmbeddingError("MODEL_INTERFACE_INVALID")
            with _deadline(self.config.execution_timeout_seconds, "INFERENCE_TIMEOUT"):
                return method(
                    list(texts),
                    batch_size=self.config.batch_size,
                    max_length=self.config.max_input_tokens,
                    return_dense=True,
                    return_sparse=True,
                    return_colbert_vecs=False,
                )
        except EmbeddingError:
            raise
        except Exception as error:
            raise EmbeddingError("INFERENCE_FAILED") from error
        finally:
            self._inference_slots.release()

    def embed_documents(self, chunks: Sequence[KnowledgeChunk]) -> tuple[ChunkEmbedding, ...]:
        chunk_tuple = tuple(chunks)
        if not chunk_tuple:
            return ()
        texts = self._validate_texts(chunk.retrieval_text for chunk in chunk_tuple)
        raw = self._encode(texts, query=False)
        values = normalize_bge_m3_output(
            raw,
            texts=texts,
            compatibility=self._compatibility,
            chunk_ids=tuple(chunk.chunk_id for chunk in chunk_tuple),
        )
        return tuple(value for value in values if isinstance(value, ChunkEmbedding))

    def embed_queries(self, queries: Sequence[str]) -> tuple[QueryEmbedding, ...]:
        query_tuple = self._validate_texts(queries)
        if not query_tuple:
            return ()
        raw = self._encode(query_tuple, query=True)
        values = normalize_bge_m3_output(raw, texts=query_tuple, compatibility=self._compatibility)
        return tuple(
            QueryEmbedding(query_index=index, dense=value.dense, sparse=value.sparse, compatibility=value.compatibility)
            for index, value in enumerate(values)
        )

    def close(self) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            model = self._model
            self._model = None
        if model is not None:
            try:
                model_model = getattr(model, "model", None)
                if model_model is not None and hasattr(model_model, "cpu"):
                    model_model.cpu()
            except Exception:
                pass
            del model

    def __enter__(self) -> "BgeM3EmbeddingAdapter":
        self._ensure_open()
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.close()
