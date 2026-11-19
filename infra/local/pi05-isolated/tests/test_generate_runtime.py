"""Offline tests for deterministic, run-owned PI-05 environment generation."""

from __future__ import annotations

import sys
from pathlib import Path
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from generate_runtime import (
    RuntimeGenerationError,
    generate_run_environments,
)
from runtime_config import (
    _AI_HTTP_REQUIRED,
    _CORE_REQUIRED,
    _HARNESS_REQUIRED,
    _KNOWLEDGE_WORKER_REQUIRED,
    _MI_WORKER_REQUIRED,
    _TRANSCRIPTION_WORKER_REQUIRED,
    load_run_configuration,
)


def _path(root: Path, name: str) -> str:
    return str(root / "pki" / name)


def _value(name: str, root: Path, run_id: str) -> str:
    if name in {"DB_URL"}:
        return "jdbc:postgresql://127.0.0.1:5432/pi05"
    if name == "DB_USERNAME":
        return "core"
    if name == "DB_PASSWORD":
        return "database-password"
    if name == "RABBITMQ_HOST":
        return "rabbitmq.internal"
    if name == "RABBITMQ_PORT":
        return "50101"
    if name == "RABBITMQ_VIRTUAL_HOST":
        return "sme-integration"
    if name == "RABBITMQ_CA_FILE":
        return _path(root, "broker-server/issuer-ca.crt")
    if name == "RABBITMQ_USERNAME":
        return "core"
    if name == "RABBITMQ_PASSWORD":
        return "broker-password"
    if name == "RABBITMQ_CONNECT_HOST":
        return "127.0.0.1"
    if name == "RABBITMQ_TLS_SERVER_NAME":
        return "rabbitmq.internal"
    if name == "APP_MEDIA_STORAGE_ENDPOINT":
        return "https://storage.internal:50102"
    if name == "APP_MEDIA_STORAGE_BUCKET":
        return "pi05-" + run_id
    if name == "APP_MEDIA_STORAGE_ACCESS_KEY":
        return "core-storage"
    if name == "APP_MEDIA_STORAGE_SECRET_KEY":
        return "storage-password"
    if name == "APP_MEDIA_STORAGE_CA_FILE":
        return _path(root, "storage-server/issuer-ca.crt")
    if name == "APP_MEDIA_STORAGE_CONNECT_HOST":
        return "127.0.0.1"
    if name == "APP_MEDIA_STORAGE_TLS_SERVER_NAME":
        return "storage.internal"
    if name.startswith("APP_"):
        return "true"
    if name == "AI_SERVICE_NAME":
        return "pi05-ai"
    if name == "AI_SERVICE_IDENTITY":
        return "ai-core"
    if name == "AI_ENVIRONMENT":
        return "staging"
    if name == "AI_WORKER_ROLE":
        return "transcription"
    if name == "AI_TLS_CERT_FILE":
        return _path(root, "ai-server/tls.crt")
    if name == "AI_TLS_KEY_FILE":
        return _path(root, "ai-server/tls.key")
    if name == "AI_TLS_CLIENT_CA_FILE":
        return _path(root, "ai-server/client-ca.crt")
    if name == "AI_CORE_API_BASE_URL":
        return "https://core-api.internal:50100"
    if name == "AI_CORE_API_SERVER_CA_FILE":
        return _path(root, "core/issuer-ca.crt")
    if name == "AI_CORE_API_CLIENT_CERT_FILE":
        return _path(root, "worker-client/tls.crt")
    if name == "AI_CORE_API_CLIENT_KEY_FILE":
        return _path(root, "worker-client/tls.key")
    if name == "AI_CORE_API_CONNECT_HOST":
        return "127.0.0.1"
    if name == "AI_CORE_API_TLS_SERVER_NAME":
        return "core-api.internal"
    if name == "AI_RABBITMQ_URL":
        return "amqps://rabbitmq.internal:50101/sme-integration"
    if name == "AI_RABBITMQ_USERNAME":
        return "worker"
    if name == "AI_RABBITMQ_PASSWORD":
        return "worker-password"
    if name == "AI_RABBITMQ_CA_FILE":
        return _path(root, "broker-server/issuer-ca.crt")
    if name == "AI_RABBITMQ_CONNECT_HOST":
        return "127.0.0.1"
    if name == "AI_RABBITMQ_TLS_SERVER_NAME":
        return "rabbitmq.internal"
    if name == "AI_S3_ENDPOINT_URL":
        return "https://storage.internal:50102"
    if name == "AI_S3_BUCKET":
        return "pi05-" + run_id
    if name == "AI_S3_ACCESS_KEY_ID":
        return "worker-storage"
    if name == "AI_S3_SECRET_ACCESS_KEY":
        return "worker-storage-password"
    if name == "AI_S3_CA_FILE":
        return _path(root, "storage-server/issuer-ca.crt")
    if name == "AI_S3_CONNECT_HOST":
        return "127.0.0.1"
    if name == "AI_S3_TLS_SERVER_NAME":
        return "storage.internal"
    if name == "AI_RAG_INDEX_GENERATION_ID":
        return "generation-" + run_id
    if name == "AI_RAG_QDRANT_URL":
        return "https://127.0.0.1:50103"
    if name == "AI_RAG_QDRANT_CA_FILE":
        return _path(root, "qdrant-server/issuer-ca.crt")
    if name == "AI_RAG_QDRANT_API_KEY":
        return "qdrant-password"
    if name == "AI_RAG_QDRANT_COLLECTION":
        return "collection-" + run_id
    if name in {"AI_RAG_MODEL_PATH", "AI_RAG_RERANKER_MODEL_PATH"}:
        return str(root / "models" / name.lower())
    if name == "AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN":
        return "mi-acceptance"
    if name == "AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID":
        return "mi-storage"
    if name == "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY":
        return "mi-storage-secret"
    if name == "AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME":
        return "mi-worker"
    if name == "AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD":
        return "mi-broker-password"
    if name == "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE":
        return _path(root, "mi-worker/tls.crt")
    if name == "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE":
        return _path(root, "mi-worker/tls.key")
    if name.startswith("PI05_"):
        if name == "PI05_ENVIRONMENT_KIND":
            return "DISPOSABLE"
        if name == "PI05_HARNESS_URL":
            return "https://localhost:50110"
        if name == "PI05_SOURCE_COMMIT":
            return "a" * 40
        if name == "PI05_GENERATION_ID":
            return "generation-" + run_id
        if name == "PI05_COLLECTION_NAME":
            return "collection-" + run_id
        if name in {"PI05_EVIDENCE_DIR", "PI05_PROOF_DIR"}:
            return str(root / name.lower())
        if name == "PI05_SCENARIO_TIMEOUT_SECONDS":
            return "60"
        if name.endswith("_BASE_URL"):
            return "https://127.0.0.1:50110"
        if name.endswith(("_CA_FILE", "_CERT_FILE", "_KEY_FILE")):
            return _path(root, "harness/" + name.lower())
        if name.endswith("_LEAF_SHA256"):
            return "a" * 64
        if name in {"PI05_CORE_CONNECT_HOST"}:
            return "127.0.0.1"
        if name == "PI05_CORE_TLS_SERVER_NAME":
            return "core-api.internal"
        if name == "PI05_STORAGE_TLS_SERVER_NAME":
            return "storage.internal"
        if name == "PI05_STORAGE_HOST_HEADER":
            return "storage.internal"
        if name == "PI05_RABBIT_TLS_SERVER_NAME":
            return "rabbitmq.internal"
        if name in {"PI05_STORAGE_ENDPOINT_URL", "PI05_RABBIT_URL"}:
            return "https://127.0.0.1:50102" if "STORAGE" in name else "amqps://127.0.0.1:50101/sme"
        if name == "PI05_STORAGE_BUCKET":
            return "pi05-" + run_id
        if name == "PI05_RABBIT_QUEUE":
            return "pi05-" + run_id + "-observer"
        if name == "PI05_MEDIA_FILE":
            return str(root / "media" / "fixture.wav")
        if name == "PI05_SCENARIO_FIXTURES_FILE":
            return str(root / "scenario-fixtures.json")
        return "fixture-" + name.lower()
    return "fixture"


def _manifest(root: Path, run_id: str) -> dict[str, str]:
    groups = {
        "PI05_CORE_": _CORE_REQUIRED,
        "PI05_AI_HTTP_": _AI_HTTP_REQUIRED,
        "PI05_TRANSCRIPTION_WORKER_": _TRANSCRIPTION_WORKER_REQUIRED,
        "PI05_MI_WORKER_": _MI_WORKER_REQUIRED,
        "PI05_KNOWLEDGE_WORKER_": _KNOWLEDGE_WORKER_REQUIRED,
        "PI05_HARNESS_": _HARNESS_REQUIRED,
    }
    values: dict[str, str] = {}
    for prefix, names in groups.items():
        for name in names:
            if prefix == "PI05_HARNESS_" and name in {"PI05_RUN_ID", "PI05_RUN_ROOT"}:
                continue
            if prefix == "PI05_MI_WORKER_" and name in {
                "AI_CORE_API_CLIENT_CERT_FILE",
                "AI_CORE_API_CLIENT_KEY_FILE",
                "AI_RABBITMQ_USERNAME",
                "AI_RABBITMQ_PASSWORD",
                "AI_S3_ACCESS_KEY_ID",
                "AI_S3_SECRET_ACCESS_KEY",
            }:
                continue
            value = _value(name, root, run_id)
            if prefix in {"PI05_MI_WORKER_", "PI05_KNOWLEDGE_WORKER_"} and name == "AI_SERVICE_IDENTITY":
                value = "mi-worker" if "MI_" in prefix else "knowledge-worker"
            if prefix == "PI05_MI_WORKER_" and name == "AI_WORKER_ROLE":
                value = "meeting-intelligence"
            if prefix == "PI05_KNOWLEDGE_WORKER_" and name == "AI_WORKER_ROLE":
                value = "knowledge-indexing"
            values[prefix + name] = value
    values.update({
        "PI05_AI_HTTP_AI_SERVICE_IDENTITY": "ai-core",
        "PI05_TRANSCRIPTION_WORKER_AI_SERVICE_IDENTITY": "ai-worker",
        "PI05_TRANSCRIPTION_WORKER_AI_WORKER_ROLE": "transcription",
    })
    return values


def _write_manifest(root: Path, values: dict[str, str]) -> Path:
    path = root / "secrets" / "runtime-input.env"
    path.write_text("".join(f"{name}={value}\n" for name, value in sorted(values.items())))
    path.chmod(0o600)
    return path


def _run(tmp_path: Path):
    run_id = str(uuid4())
    root = tmp_path / "runs" / run_id
    (root / "secrets").mkdir(mode=0o700, parents=True)
    root.chmod(0o700)
    for name in ("pi05_evidence_dir", "pi05_proof_dir"):
        (root / name).mkdir(mode=0o700)
    manifest = _write_manifest(root, _manifest(root, run_id))
    return run_id, root, manifest


def test_generation_is_deterministic_private_and_loader_compatible(tmp_path):
    run_id, root, manifest = _run(tmp_path)

    generated = generate_run_environments(run_id, root, manifest_path=manifest)

    assert set(generated) == {
        "core", "ai-http", "transcription-worker", "mi-worker",
        "knowledge-worker", "harness",
    }
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in generated.values())
    config = load_run_configuration(run_id, root, runs_base=tmp_path / "runs")
    environments = config.application_environments()
    assert environments["transcription-worker"]["AI_SERVICE_IDENTITY"] == "ai-worker"
    assert environments["mi-worker"]["AI_SERVICE_IDENTITY"] == "mi-worker"
    assert environments["knowledge-worker"]["AI_SERVICE_IDENTITY"] == "knowledge-worker"
    assert "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY" not in environments["transcription-worker"]
    assert "AI_RAG_QDRANT_API_KEY" not in environments["mi-worker"]


def test_generation_never_overwrites_existing_process_file(tmp_path):
    run_id, root, manifest = _run(tmp_path)
    existing = root / "secrets" / "core.env"
    existing.write_text("operator-owned\n", encoding="utf-8")
    existing.chmod(0o600)

    with pytest.raises(RuntimeGenerationError, match="already exists"):
        generate_run_environments(run_id, root, manifest_path=manifest)

    assert existing.read_text(encoding="utf-8") == "operator-owned\n"


def test_generation_rejects_manifest_setting_from_another_process(tmp_path):
    run_id, root, manifest = _run(tmp_path)
    raw = manifest.read_text(encoding="utf-8")
    manifest.write_text(
        raw + "PI05_TRANSCRIPTION_WORKER_AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY=leak\n",
        encoding="utf-8",
    )
    manifest.chmod(0o600)

    with pytest.raises(RuntimeGenerationError):
        generate_run_environments(run_id, root, manifest_path=manifest)
