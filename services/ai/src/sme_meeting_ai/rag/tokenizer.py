"""The real BGE-M3 tokenizer adapter used by the T01 chunker."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from .contracts import ChunkingConfig, IndexGeneration
from .provisioning import BgeM3Provisioner, ModelManifest, load_bge_m3_manifest


class TokenizerError(ValueError):
    """The pinned tokenizer cannot count or validate model input."""


class TokenizerLike(Protocol):
    def __call__(self, text: str, **kwargs: Any) -> dict[str, Any]: ...


class BgeM3Tokenizer:
    """Count actual model input IDs, including the configured special tokens."""

    def __init__(
        self,
        snapshot_path: Path | None = None,
        *,
        tokenizer: TokenizerLike | None = None,
        manifest: ModelManifest | None = None,
    ):
        self.manifest = manifest or load_bge_m3_manifest()
        if tokenizer is None:
            if snapshot_path is None:
                raise TokenizerError("MODEL_PATH_REQUIRED")
            BgeM3Provisioner(Path(snapshot_path), self.manifest).verify(Path(snapshot_path))
            try:
                from transformers import AutoTokenizer

                tokenizer = AutoTokenizer.from_pretrained(
                    str(snapshot_path),
                    local_files_only=True,
                    use_fast=True,
                    trust_remote_code=False,
                )
            except Exception as error:
                raise TokenizerError("TOKENIZER_UNAVAILABLE") from error
        self._tokenizer = tokenizer

    @property
    def tokenizer_id(self) -> str:
        return self.manifest.tokenizer_id

    @property
    def max_model_tokens(self) -> int:
        return self.manifest.tokenizer_max_model_tokens

    def encode_ids(self, text: str) -> tuple[int, ...]:
        if not isinstance(text, str):
            raise TokenizerError("TOKENIZER_INPUT_INVALID")
        try:
            encoded = self._tokenizer(
                text,
                add_special_tokens=self.manifest.tokenizer_add_special_tokens,
                truncation=False,
                return_attention_mask=False,
            )
            ids = encoded["input_ids"]
        except Exception as error:
            raise TokenizerError("TOKENIZER_FAILED") from error
        if not isinstance(ids, (list, tuple)) or (ids and isinstance(ids[0], (list, tuple))):
            raise TokenizerError("TOKENIZER_OUTPUT_INVALID")
        try:
            result = tuple(int(token_id) for token_id in ids)
        except (TypeError, ValueError, OverflowError) as error:
            raise TokenizerError("TOKENIZER_OUTPUT_INVALID") from error
        return result

    def count(self, text: str) -> int:
        return len(self.encode_ids(text))

    def ensure_within_budget(self, text: str, maximum: int) -> int:
        count = self.count(text)
        if count <= 0 or count > maximum or maximum > self.max_model_tokens:
            raise TokenizerError("TOKEN_BUDGET_EXCEEDED")
        return count


def bge_m3_index_generation(
    *,
    generation_id: str = "rag-t02-bge-m3-v1",
    configuration_version: str = "rag-t02-bge-m3-v1",
    max_tokens: int = 512,
    target_tokens: int = 384,
    max_temporal_gap_ms: int = 5_000,
    max_units_per_chunk: int = 8,
    manifest: ModelManifest | None = None,
) -> IndexGeneration:
    """Build deterministic T01 generation metadata for the approved tokenizer."""

    import hashlib
    import json

    selected = manifest or load_bge_m3_manifest()
    configuration = {
        "modelId": selected.model_id,
        "modelRevision": selected.revision,
        "tokenizerId": selected.tokenizer_id,
        "configurationVersion": configuration_version,
        "maxTokens": max_tokens,
        "targetTokens": target_tokens,
        "maxTemporalGapMs": max_temporal_gap_ms,
        "maxUnitsPerChunk": max_units_per_chunk,
        "denseDimensions": selected.dense_dimensions,
        "sparseRepresentation": selected.sparse_representation,
        "normalizeDense": selected.normalize_dense,
        "colbertEnabled": selected.colbert_enabled,
    }
    digest = hashlib.sha256(
        json.dumps(configuration, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return IndexGeneration(
        generation_id=generation_id,
        configuration_version=configuration_version,
        configuration_sha256=digest,
        tokenizer_id=selected.tokenizer_id,
    )


def bge_m3_chunking_config(
    tokenizer: BgeM3Tokenizer,
    *,
    max_tokens: int = 512,
    target_tokens: int = 384,
    max_temporal_gap_ms: int = 5_000,
    max_units_per_chunk: int = 8,
    generation_id: str = "rag-t02-bge-m3-v1",
    configuration_version: str = "rag-t02-bge-m3-v1",
) -> ChunkingConfig:
    """Create the existing T01 chunking config for the real BGE-M3 counter."""

    if max_tokens > tokenizer.max_model_tokens:
        raise TokenizerError("TOKEN_BUDGET_EXCEEDS_MODEL")
    return ChunkingConfig(
        max_tokens=max_tokens,
        target_tokens=target_tokens,
        max_temporal_gap_ms=max_temporal_gap_ms,
        max_units_per_chunk=max_units_per_chunk,
        index_generation=bge_m3_index_generation(
            generation_id=generation_id,
            configuration_version=configuration_version,
            max_tokens=max_tokens,
            target_tokens=target_tokens,
            max_temporal_gap_ms=max_temporal_gap_ms,
            max_units_per_chunk=max_units_per_chunk,
            manifest=tokenizer.manifest,
        ),
    )
