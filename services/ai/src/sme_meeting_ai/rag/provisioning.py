"""Explicit, local-only provisioning and verification for the approved BGE-M3 snapshot."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any


class ModelProvisioningError(RuntimeError):
    """A model snapshot cannot be provisioned or used safely."""

    def __init__(self, category: str, message: str):
        self.category = category
        super().__init__(message)


@dataclass(frozen=True)
class ModelManifest:
    schema_version: str
    model_id: str
    revision: str
    revision_type: str
    artifact_format: str
    inference_package: str
    inference_class: str
    inference_version_specifier: str
    required_files: tuple[str, ...]
    tokenizer_id: str
    tokenizer_implementation: str
    tokenizer_add_special_tokens: bool
    tokenizer_max_model_tokens: int
    dense_dimensions: int
    dense_distance: str
    normalize_dense: bool
    sparse_representation: str
    sparse_index_semantics: str
    colbert_enabled: bool
    default_max_input_tokens: int
    target_chunk_tokens: int
    cpu_precision: str
    cuda_precision: str

    @classmethod
    def from_mapping(cls, value: dict[str, Any]) -> "ModelManifest":
        try:
            inference = value["inference_implementation"]
            tokenizer = value["tokenizer"]
            embedding = value["embedding"]
            runtime = value["runtime"]
            manifest = cls(
                schema_version=value["schema_version"],
                model_id=value["model_id"],
                revision=value["revision"],
                revision_type=value["revision_type"],
                artifact_format=value["artifact_format"],
                inference_package=inference["package"],
                inference_class=inference["class"],
                inference_version_specifier=inference["version_specifier"],
                required_files=tuple(value["required_files"]),
                tokenizer_id=tokenizer["tokenizer_id"],
                tokenizer_implementation=tokenizer["implementation"],
                tokenizer_add_special_tokens=tokenizer["add_special_tokens"],
                tokenizer_max_model_tokens=tokenizer["max_model_tokens"],
                dense_dimensions=embedding["dense_dimensions"],
                dense_distance=embedding["dense_distance"],
                normalize_dense=embedding["normalize_dense"],
                sparse_representation=embedding["sparse_representation"],
                sparse_index_semantics=embedding["sparse_index_semantics"],
                colbert_enabled=embedding["colbert_enabled"],
                default_max_input_tokens=runtime["default_max_input_tokens"],
                target_chunk_tokens=runtime["target_chunk_tokens"],
                cpu_precision=runtime["cpu_precision"],
                cuda_precision=runtime["cuda_precision"],
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ModelProvisioningError("MANIFEST_INVALID", "BGE-M3 manifest is invalid") from error
        if (
            manifest.model_id != "BAAI/bge-m3"
            or manifest.revision_type != "commit"
            or len(manifest.revision) != 40
            or any(char not in "0123456789abcdef" for char in manifest.revision)
            or manifest.artifact_format != "pytorch_model.bin"
            or manifest.dense_dimensions != 1024
            or manifest.dense_distance != "Cosine"
            or manifest.colbert_enabled
            or manifest.tokenizer_max_model_tokens < manifest.default_max_input_tokens
        ):
            raise ModelProvisioningError("MANIFEST_UNAPPROVED", "BGE-M3 manifest is not an approved configuration")
        return manifest


def load_bge_m3_manifest(path: Path | None = None) -> ModelManifest:
    """Load the versioned repository manifest without contacting Hugging Face."""

    if path is None:
        path = Path(resources.files("sme_meeting_ai.rag").joinpath("bge_m3_manifest.json"))
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError) as error:
        raise ModelProvisioningError("MANIFEST_UNAVAILABLE", "BGE-M3 manifest cannot be read") from error
    if not isinstance(value, dict):
        raise ModelProvisioningError("MANIFEST_INVALID", "BGE-M3 manifest is not an object")
    return ModelManifest.from_mapping(value)


_MARKER_NAME = ".sme-bge-m3-snapshot.json"


@dataclass(frozen=True)
class ModelSnapshot:
    path: Path
    manifest: ModelManifest
    offline: bool


class BgeM3Provisioner:
    """Provision only the approved immutable snapshot and verify it offline."""

    def __init__(self, cache_dir: Path, manifest: ModelManifest | None = None):
        self.cache_dir = Path(cache_dir).expanduser()
        self.manifest = manifest or load_bge_m3_manifest()

    def provision(self, *, offline: bool = False) -> ModelSnapshot:
        """Return a valid snapshot, downloading only during an explicit call."""

        try:
            from huggingface_hub import snapshot_download
        except ImportError as error:
            raise ModelProvisioningError(
                "DEPENDENCY_UNAVAILABLE", "huggingface_hub is required for BGE-M3 provisioning"
            ) from error

        try:
            snapshot_path = Path(
                snapshot_download(
                    repo_id=self.manifest.model_id,
                    revision=self.manifest.revision,
                    cache_dir=str(self.cache_dir),
                    allow_patterns=list(self.manifest.required_files),
                    local_files_only=offline,
                )
            )
        except Exception as error:
            category = "MODEL_CACHE_MISS" if offline else "MODEL_DOWNLOAD_FAILED"
            raise ModelProvisioningError(category, "Approved BGE-M3 snapshot is unavailable") from error

        self.verify(snapshot_path)
        marker = snapshot_path / _MARKER_NAME
        if snapshot_path.name == self.manifest.revision or marker.is_file():
            return ModelSnapshot(path=snapshot_path, manifest=self.manifest, offline=offline)
        try:
            marker.write_text(
                json.dumps(
                    {
                        "model_id": self.manifest.model_id,
                        "revision": self.manifest.revision,
                        "required_files": list(self.manifest.required_files),
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n",
                encoding="utf-8",
            )
        except OSError as error:
            raise ModelProvisioningError("MODEL_CACHE_NOT_WRITABLE", "BGE-M3 snapshot marker cannot be written") from error
        return ModelSnapshot(path=snapshot_path, manifest=self.manifest, offline=offline)

    def verify(self, snapshot_path: Path) -> ModelSnapshot:
        """Validate a provisioned snapshot without making a network request."""

        path = Path(snapshot_path).expanduser()
        if not path.is_dir():
            raise ModelProvisioningError("MODEL_NOT_FOUND", "BGE-M3 model path is not a directory")

        revision_is_explicit = path.name == self.manifest.revision
        marker_path = path / _MARKER_NAME
        if not revision_is_explicit:
            try:
                marker = json.loads(marker_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, TypeError) as error:
                raise ModelProvisioningError(
                    "MODEL_REVISION_UNVERIFIED", "BGE-M3 model revision cannot be verified"
                ) from error
            if marker.get("model_id") != self.manifest.model_id or marker.get("revision") != self.manifest.revision:
                raise ModelProvisioningError("MODEL_REVISION_MISMATCH", "BGE-M3 model revision does not match the manifest")

        for required_file in self.manifest.required_files:
            candidate = path / required_file
            if not candidate.is_file() or candidate.stat().st_size <= 0:
                raise ModelProvisioningError("MODEL_ARTIFACT_INCOMPLETE", "BGE-M3 model artifacts are incomplete")

        try:
            config = json.loads((path / "config.json").read_text(encoding="utf-8"))
            tokenizer_config = json.loads((path / "tokenizer_config.json").read_text(encoding="utf-8"))
            special_tokens = json.loads((path / "special_tokens_map.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError) as error:
            raise ModelProvisioningError("MODEL_CONFIGURATION_INVALID", "BGE-M3 model configuration is invalid") from error

        if (
            config.get("model_type") != "xlm-roberta"
            or config.get("hidden_size") != self.manifest.dense_dimensions
            or config.get("max_position_embeddings", 0) < self.manifest.tokenizer_max_model_tokens
            or tokenizer_config.get("model_type") not in {None, "xlm-roberta"}
            or not isinstance(special_tokens, dict)
        ):
            raise ModelProvisioningError("MODEL_CONFIGURATION_INCOMPATIBLE", "BGE-M3 model configuration is incompatible")
        return ModelSnapshot(path=path, manifest=self.manifest, offline=True)


@dataclass(frozen=True)
class RerankerManifest:
    """Approved immutable metadata for the local cross-encoder snapshot."""

    schema_version: str
    model_id: str
    revision: str
    revision_type: str
    required_files: tuple[str, ...]
    inference_package: str
    inference_class: str
    tokenizer_id: str
    tokenizer_max_model_tokens: int
    default_query_max_tokens: int
    default_passage_max_tokens: int
    default_pair_max_tokens: int
    cpu_precision: str
    cuda_precision: str

    @classmethod
    def from_mapping(cls, value: dict[str, Any]) -> "RerankerManifest":
        try:
            inference = value["inference_implementation"]
            tokenizer = value["tokenizer"]
            runtime = value["runtime"]
            manifest = cls(
                schema_version=value["schema_version"],
                model_id=value["model_id"],
                revision=value["revision"],
                revision_type=value["revision_type"],
                required_files=tuple(value["required_files"]),
                inference_package=inference["package"],
                inference_class=inference["class"],
                tokenizer_id=tokenizer["tokenizer_id"],
                tokenizer_max_model_tokens=tokenizer["max_model_tokens"],
                default_query_max_tokens=runtime["default_query_max_tokens"],
                default_passage_max_tokens=runtime["default_passage_max_tokens"],
                default_pair_max_tokens=runtime["default_pair_max_tokens"],
                cpu_precision=runtime["cpu_precision"],
                cuda_precision=runtime["cuda_precision"],
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ModelProvisioningError("MANIFEST_INVALID", "BGE reranker manifest is invalid") from error
        if (
            manifest.model_id != "BAAI/bge-reranker-v2-m3"
            or manifest.revision_type != "commit"
            or re.fullmatch(r"[a-f0-9]{40}", manifest.revision) is None
            or manifest.inference_package != "FlagEmbedding"
            or manifest.inference_class != "FlagReranker"
            or manifest.tokenizer_max_model_tokens < manifest.default_pair_max_tokens
            or manifest.default_query_max_tokens < 1
            or manifest.default_passage_max_tokens < 1
            or manifest.default_pair_max_tokens < 1
        ):
            raise ModelProvisioningError("MANIFEST_UNAPPROVED", "BGE reranker manifest is not approved")
        return manifest


def load_bge_reranker_manifest(path: Path | None = None) -> RerankerManifest:
    """Load the pinned reranker manifest without contacting Hugging Face."""

    if path is None:
        path = Path(resources.files("sme_meeting_ai.rag").joinpath("bge_reranker_manifest.json"))
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError) as error:
        raise ModelProvisioningError("MANIFEST_UNAVAILABLE", "BGE reranker manifest cannot be read") from error
    if not isinstance(value, dict):
        raise ModelProvisioningError("MANIFEST_INVALID", "BGE reranker manifest is not an object")
    return RerankerManifest.from_mapping(value)


@dataclass(frozen=True)
class RerankerModelSnapshot:
    path: Path
    manifest: RerankerManifest
    offline: bool


_RERANKER_MARKER_NAME = ".sme-bge-reranker-v2-m3-snapshot.json"


class BgeRerankerProvisioner:
    """Provision and verify only the approved local reranker revision."""

    def __init__(self, cache_dir: Path, manifest: RerankerManifest | None = None):
        self.cache_dir = Path(cache_dir).expanduser()
        self.manifest = manifest or load_bge_reranker_manifest()

    def provision(self, *, offline: bool = False) -> RerankerModelSnapshot:
        try:
            from huggingface_hub import snapshot_download
        except ImportError as error:
            raise ModelProvisioningError(
                "DEPENDENCY_UNAVAILABLE", "huggingface_hub is required for BGE reranker provisioning"
            ) from error
        try:
            snapshot_path = Path(
                snapshot_download(
                    repo_id=self.manifest.model_id,
                    revision=self.manifest.revision,
                    cache_dir=str(self.cache_dir),
                    allow_patterns=list(self.manifest.required_files),
                    local_files_only=offline,
                )
            )
        except Exception as error:
            category = "MODEL_CACHE_MISS" if offline else "MODEL_DOWNLOAD_FAILED"
            raise ModelProvisioningError(category, "Approved BGE reranker snapshot is unavailable") from error
        self.verify(snapshot_path)
        marker = snapshot_path / _RERANKER_MARKER_NAME
        if snapshot_path.name == self.manifest.revision or marker.is_file():
            return RerankerModelSnapshot(path=snapshot_path, manifest=self.manifest, offline=offline)
        try:
            marker.write_text(
                json.dumps(
                    {
                        "model_id": self.manifest.model_id,
                        "revision": self.manifest.revision,
                        "required_files": list(self.manifest.required_files),
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n",
                encoding="utf-8",
            )
        except OSError as error:
            raise ModelProvisioningError(
                "MODEL_CACHE_NOT_WRITABLE", "BGE reranker snapshot marker cannot be written"
            ) from error
        return RerankerModelSnapshot(path=snapshot_path, manifest=self.manifest, offline=offline)

    def verify(self, snapshot_path: Path) -> RerankerModelSnapshot:
        """Validate a mounted snapshot without making a network request."""

        path = Path(snapshot_path).expanduser()
        if not path.is_dir():
            raise ModelProvisioningError("MODEL_NOT_FOUND", "BGE reranker model path is not a directory")
        if path.name != self.manifest.revision:
            try:
                marker = json.loads((path / _RERANKER_MARKER_NAME).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, TypeError) as error:
                raise ModelProvisioningError(
                    "MODEL_REVISION_UNVERIFIED", "BGE reranker model revision cannot be verified"
                ) from error
            if marker.get("model_id") != self.manifest.model_id or marker.get("revision") != self.manifest.revision:
                raise ModelProvisioningError(
                    "MODEL_REVISION_MISMATCH", "BGE reranker model revision does not match the manifest"
                )
        for required_file in self.manifest.required_files:
            candidate = path / required_file
            if not candidate.is_file() or candidate.stat().st_size <= 0:
                raise ModelProvisioningError("MODEL_ARTIFACT_INCOMPLETE", "BGE reranker artifacts are incomplete")
        try:
            config = json.loads((path / "config.json").read_text(encoding="utf-8"))
            tokenizer_config = json.loads((path / "tokenizer_config.json").read_text(encoding="utf-8"))
            special_tokens = json.loads((path / "special_tokens_map.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError) as error:
            raise ModelProvisioningError(
                "MODEL_CONFIGURATION_INVALID", "BGE reranker model configuration is invalid"
            ) from error
        architectures = config.get("architectures")
        if (
            config.get("model_type") != "xlm-roberta"
            or not isinstance(architectures, list)
            or "XLMRobertaForSequenceClassification" not in architectures
            or config.get("max_position_embeddings", 0) < self.manifest.tokenizer_max_model_tokens
            or tokenizer_config.get("model_type") not in {None, "xlm-roberta"}
            or not isinstance(special_tokens, dict)
        ):
            raise ModelProvisioningError(
                "MODEL_CONFIGURATION_INCOMPATIBLE", "BGE reranker model configuration is incompatible"
            )
        return RerankerModelSnapshot(path=path, manifest=self.manifest, offline=True)
