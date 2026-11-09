"""Bounded local BGE Reranker V2 M3 inference."""

from __future__ import annotations

import math
import os
import signal
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sme_meeting_ai.core.config import Settings

from .provisioning import (
    BgeRerankerProvisioner,
    RerankerManifest,
    load_bge_reranker_manifest,
)
from .retrieval_contracts import RetrievalCandidate


class RerankerError(RuntimeError):
    """A reranker could not produce a complete, finite score set."""

    def __init__(self, category: str, message: str | None = None):
        self.category = category
        super().__init__(message or category)


class RerankerScore(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, populate_by_name=True)

    candidate_id: str = Field(alias="candidateId", min_length=1)
    score: float
    input_truncated: bool = Field(alias="inputTruncated")

    @model_validator(mode="after")
    def finite(self) -> "RerankerScore":
        if not math.isfinite(self.score):
            raise ValueError("Reranker score must be finite")
        return self


class RerankerAdapter(Protocol):
    model_id: str
    model_revision: str

    def rerank(self, query: str, candidates: Sequence[RetrievalCandidate]) -> tuple[RerankerScore, ...]: ...


@dataclass(frozen=True)
class BgeRerankerConfig:
    model_path: Path | None
    model_id: str = "BAAI/bge-reranker-v2-m3"
    model_revision: str = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
    device: str = "cpu"
    precision: str = "fp32"
    batch_size: int = 8
    query_max_tokens: int = 256
    passage_max_tokens: int = 512
    pair_max_tokens: int = 768
    max_candidates: int = 40
    max_concurrent: int = 1
    init_timeout_seconds: float = 900
    execution_timeout_seconds: float = 900

    @classmethod
    def from_settings(cls, settings: Settings) -> "BgeRerankerConfig":
        return cls(
            model_path=settings.rag_reranker_model_path,
            model_id=settings.rag_reranker_model_id,
            model_revision=settings.rag_reranker_model_revision,
            device=settings.rag_inference_device,
            precision=settings.rag_inference_precision,
            batch_size=settings.rag_reranker_batch_size,
            query_max_tokens=settings.rag_reranker_query_max_tokens,
            passage_max_tokens=settings.rag_reranker_passage_max_tokens,
            pair_max_tokens=settings.rag_reranker_pair_max_tokens,
            max_candidates=settings.rag_retrieval_rerank_limit,
            max_concurrent=settings.rag_reranker_max_concurrent,
            init_timeout_seconds=settings.rag_model_init_timeout_seconds,
            execution_timeout_seconds=settings.rag_reranker_timeout_seconds,
        )

    def __post_init__(self) -> None:
        if self.model_id != "BAAI/bge-reranker-v2-m3":
            raise ValueError("Only BAAI/bge-reranker-v2-m3 is approved")
        if len(self.model_revision) != 40 or any(c not in "0123456789abcdef" for c in self.model_revision):
            raise ValueError("BGE reranker revision must be an immutable commit")
        if self.device != "cpu" and not self.device.startswith("cuda"):
            raise ValueError("Unsupported BGE reranker device")
        if self.precision not in {"fp32", "fp16"} or (self.precision == "fp16" and self.device == "cpu"):
            raise ValueError("Unsupported BGE reranker precision for the selected device")
        if not 1 <= self.batch_size <= 64:
            raise ValueError("BGE reranker batch size is outside the supported bound")
        if not 1 <= self.query_max_tokens <= 512:
            raise ValueError("BGE reranker query token budget is outside the supported bound")
        if not 1 <= self.passage_max_tokens <= 2048:
            raise ValueError("BGE reranker passage token budget is outside the supported bound")
        if not 1 <= self.pair_max_tokens <= 4096:
            raise ValueError("BGE reranker pair token budget is outside the supported bound")
        if not 1 <= self.max_candidates <= 256:
            raise ValueError("BGE reranker candidate bound is outside the supported bound")
        if not 1 <= self.max_concurrent <= 4:
            raise ValueError("BGE reranker concurrency is outside the supported bound")
        if self.init_timeout_seconds <= 0 or self.execution_timeout_seconds <= 0:
            raise ValueError("BGE reranker timeouts must be positive")


@contextmanager
def _deadline(seconds: float, category: str):
    if threading.current_thread() is not threading.main_thread() or not hasattr(signal, "setitimer"):
        yield
        return
    previous_handler = signal.getsignal(signal.SIGALRM)

    def alarm_handler(_signum, _frame):
        raise RerankerError(category)

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


class BgeRerankerAdapter:
    """Managed FlagReranker adapter that never downloads during inference."""

    def __init__(
        self,
        config: BgeRerankerConfig,
        *,
        model: Any | None = None,
        tokenizer: Any | None = None,
        manifest: RerankerManifest | None = None,
    ):
        self.config = config
        self.manifest = manifest or load_bge_reranker_manifest()
        if config.model_id != self.manifest.model_id or config.model_revision != self.manifest.revision:
            raise RerankerError("MODEL_MANIFEST_MISMATCH")
        if config.pair_max_tokens > self.manifest.tokenizer_max_model_tokens:
            raise RerankerError("MODEL_INPUT_BUDGET_INVALID")
        self._closed = False
        self._state_lock = threading.RLock()
        self._inference_slots = threading.BoundedSemaphore(config.max_concurrent)
        if model is None:
            if config.model_path is None:
                raise RerankerError("MODEL_PATH_REQUIRED")
            try:
                BgeRerankerProvisioner(config.model_path, self.manifest).verify(config.model_path)
                with _MODEL_INIT_LOCK, _offline_huggingface_environment(), _deadline(
                    config.init_timeout_seconds, "MODEL_INITIALIZATION_TIMEOUT"
                ):
                    from FlagEmbedding import FlagReranker

                    model = FlagReranker(
                        str(config.model_path),
                        use_fp16=config.precision == "fp16",
                        trust_remote_code=False,
                        devices=config.device,
                        batch_size=config.batch_size,
                        query_max_length=config.query_max_tokens,
                        max_length=config.pair_max_tokens,
                        normalize=False,
                    )
            except RerankerError:
                raise
            except ImportError as error:
                raise RerankerError("INFERENCE_DEPENDENCY_UNAVAILABLE") from error
            except Exception as error:
                raise RerankerError("MODEL_INITIALIZATION_FAILED") from error
        self._model = model
        self._tokenizer = tokenizer or getattr(model, "tokenizer", None)
        if self._tokenizer is None:
            raise RerankerError("TOKENIZER_UNAVAILABLE")
        self.model_id = self.manifest.model_id
        self.model_revision = self.manifest.revision

    @classmethod
    def from_settings(cls, settings: Settings, **kwargs: Any) -> "BgeRerankerAdapter":
        return cls(BgeRerankerConfig.from_settings(settings), **kwargs)

    def _ensure_open(self) -> None:
        if self._closed:
            raise RerankerError("ADAPTER_CLOSED")

    def _token_ids(self, text: str) -> tuple[int, ...]:
        try:
            encoded = self._tokenizer(text, add_special_tokens=False, truncation=False, return_attention_mask=False)
            ids = encoded["input_ids"]
        except Exception as error:
            raise RerankerError("TOKENIZER_FAILED") from error
        if not isinstance(ids, (list, tuple)) or (ids and isinstance(ids[0], (list, tuple))):
            raise RerankerError("TOKENIZER_OUTPUT_INVALID")
        try:
            return tuple(int(value) for value in ids)
        except (TypeError, ValueError, OverflowError) as error:
            raise RerankerError("TOKENIZER_OUTPUT_INVALID") from error

    def _special_token_count(self) -> int:
        builder = getattr(self._tokenizer, "build_inputs_with_special_tokens", None)
        if builder is None:
            return 4
        try:
            count = len(builder([], []))
        except Exception as error:
            raise RerankerError("TOKENIZER_OUTPUT_INVALID") from error
        return max(1, count)

    def _truncate(self, text: str, maximum: int) -> tuple[str, bool, int]:
        ids = self._token_ids(text)
        if len(ids) <= maximum:
            return text, False, len(ids)
        decode = getattr(self._tokenizer, "decode", None)
        if decode is None:
            raise RerankerError("TOKENIZER_TRUNCATION_UNAVAILABLE")
        try:
            truncated = decode(
                list(ids[:maximum]),
                skip_special_tokens=True,
                clean_up_tokenization_spaces=False,
            )
        except Exception as error:
            raise RerankerError("TOKENIZER_TRUNCATION_FAILED") from error
        if not isinstance(truncated, str) or not truncated.strip():
            raise RerankerError("TOKENIZER_TRUNCATION_FAILED")
        return truncated, True, maximum

    def _prepare_pair(self, query: str, passage: str) -> tuple[tuple[str, str], bool]:
        bounded_query, query_truncated, query_count = self._truncate(query, self.config.query_max_tokens)
        available_passage = self.config.pair_max_tokens - query_count - self._special_token_count()
        if available_passage < 1:
            raise RerankerError("PAIR_TOKEN_BUDGET_INVALID")
        bounded_passage, passage_truncated, _ = self._truncate(
            passage, min(self.config.passage_max_tokens, available_passage)
        )
        return (bounded_query, bounded_passage), query_truncated or passage_truncated

    @staticmethod
    def _scores(raw: Any, count: int) -> tuple[float, ...]:
        if hasattr(raw, "tolist"):
            raw = raw.tolist()
        if count == 1 and isinstance(raw, (int, float)):
            raw = [raw]
        if not isinstance(raw, (list, tuple)) or len(raw) != count:
            raise RerankerError("SCORE_COUNT_INVALID")
        try:
            scores = tuple(float(value) for value in raw)
        except (TypeError, ValueError, OverflowError) as error:
            raise RerankerError("SCORE_OUTPUT_INVALID") from error
        if any(not math.isfinite(value) for value in scores):
            raise RerankerError("SCORE_NONFINITE")
        return scores

    def rerank(self, query: str, candidates: Sequence[RetrievalCandidate]) -> tuple[RerankerScore, ...]:
        self._ensure_open()
        values = tuple(candidates)
        if not isinstance(query, str) or not query or not values:
            raise RerankerError("RERANKER_INPUT_INVALID")
        if len(values) > self.config.max_candidates:
            raise RerankerError("RERANKER_CANDIDATE_LIMIT_EXCEEDED")
        if len({candidate.chunk_id for candidate in values}) != len(values):
            raise RerankerError("RERANKER_CANDIDATE_DUPLICATE")
        pairs: list[tuple[str, str]] = []
        truncated: list[bool] = []
        for candidate in values:
            pair, was_truncated = self._prepare_pair(query, candidate.retrieval_text)
            pairs.append(pair)
            truncated.append(was_truncated)
        if not self._inference_slots.acquire(timeout=self.config.execution_timeout_seconds):
            raise RerankerError("INFERENCE_CONCURRENCY_TIMEOUT")
        try:
            with _deadline(self.config.execution_timeout_seconds, "INFERENCE_TIMEOUT"):
                raw = self._model.compute_score(
                    pairs,
                    batch_size=self.config.batch_size,
                    query_max_length=self.config.query_max_tokens,
                    max_length=self.config.pair_max_tokens,
                    normalize=False,
                )
            scores = self._scores(raw, len(values))
        except RerankerError:
            raise
        except Exception as error:
            raise RerankerError("INFERENCE_FAILED") from error
        finally:
            self._inference_slots.release()
        try:
            return tuple(
                RerankerScore(candidateId=candidate.chunk_id, score=score, inputTruncated=was_truncated)
                for candidate, score, was_truncated in zip(values, scores, truncated, strict=True)
            )
        except Exception as error:
            raise RerankerError("SCORE_CONTRACT_INVALID") from error

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

    def __enter__(self) -> "BgeRerankerAdapter":
        self._ensure_open()
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.close()
