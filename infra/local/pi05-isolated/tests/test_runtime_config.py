"""Offline tests for run-scoped PI-05 application configuration."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from runtime_config import (
    RuntimeConfigError,
    load_run_configuration,
)


def _write_environment(root: Path, name: str, values: dict[str, str]) -> None:
    path = root / "secrets" / name
    path.write_text(
        "".join(f"{key}={value}\n" for key, value in values.items()),
        encoding="utf-8",
    )
    path.chmod(0o600)


def _files(tmp_path: Path, run_id: str) -> tuple[Path, dict[str, str]]:
    root = tmp_path / "runs" / run_id
    (root / "secrets").mkdir(mode=0o700, parents=True)
    root.chmod(0o700)
    (root / "evidence").mkdir(mode=0o700)
    (root / "proofs").mkdir(mode=0o700)
    common = {
        "PI05_RUN_ID": run_id,
        "PI05_RUN_ROOT": str(root),
    }
    _write_environment(root, "core.env", {
        **common,
        "DB_URL": "jdbc:postgresql://127.0.0.1:5432/pi05",
        "DB_USERNAME": "core",
        "DB_PASSWORD": "database-password",
        "RABBITMQ_HOST": "rabbitmq.internal",
        "RABBITMQ_PORT": "50101",
        "RABBITMQ_VIRTUAL_HOST": "sme-integration",
        "RABBITMQ_CA_FILE": str(root / "pki" / "broker-server" / "issuer-ca.crt"),
        "RABBITMQ_USERNAME": "core",
        "RABBITMQ_PASSWORD": "broker-password",
        "RABBITMQ_CONNECT_HOST": "127.0.0.1",
        "RABBITMQ_TLS_SERVER_NAME": "rabbitmq.internal",
        "APP_MEDIA_STORAGE_ENDPOINT": "https://storage.internal:50102",
        "APP_MEDIA_STORAGE_BUCKET": "pi05-" + run_id,
        "APP_MEDIA_STORAGE_ACCESS_KEY": "core-storage",
        "APP_MEDIA_STORAGE_SECRET_KEY": "storage-password",
        "APP_MEDIA_STORAGE_CA_FILE": str(root / "pki" / "storage-server" / "issuer-ca.crt"),
        "APP_MEDIA_STORAGE_CONNECT_HOST": "127.0.0.1",
        "APP_MEDIA_STORAGE_TLS_SERVER_NAME": "storage.internal",
        "APP_TRANSPORT_PRIVATE_ENABLED": "true",
        "APP_TRANSPORT_AI_ENABLED": "true",
        "APP_AUTH_TRANSPORT_ENABLED": "true",
        "APP_MEDIA_OUTBOX_ENABLED": "true",
        "APP_WORKER_TRANSCRIPTION_ENABLED": "true",
        "APP_MEDIA_INTELLIGENCE_ENABLED": "true",
        "APP_MEDIA_INTELLIGENCE_DISPATCH_ENABLED": "true",
        "APP_MEDIA_KNOWLEDGE_INDEXING_ENABLED": "true",
        "APP_ASSISTANT_ENABLED": "true",
    })
    ai = {
        **common,
        "AI_SERVICE_NAME": "pi05-ai",
        "AI_SERVICE_IDENTITY": "ai-core",
        "AI_ENVIRONMENT": "staging",
        "AI_CORE_API_BASE_URL": "https://core-api.internal:8443",
        "AI_CORE_API_SERVER_CA_FILE": str(root / "pki" / "core" / "issuer-ca.crt"),
        "AI_CORE_API_CLIENT_CERT_FILE": str(root / "pki" / "worker-client" / "tls.crt"),
        "AI_CORE_API_CLIENT_KEY_FILE": str(root / "pki" / "worker-client" / "tls.key"),
        "AI_CORE_API_CONNECT_HOST": "127.0.0.1",
        "AI_CORE_API_TLS_SERVER_NAME": "core-api.internal",
        "AI_RABBITMQ_URL": "amqps://rabbitmq.internal:50101/sme-integration",
        "AI_RABBITMQ_USERNAME": "worker",
        "AI_RABBITMQ_PASSWORD": "broker-password",
        "AI_RABBITMQ_CA_FILE": str(root / "pki" / "broker-server" / "issuer-ca.crt"),
        "AI_RABBITMQ_CONNECT_HOST": "127.0.0.1",
        "AI_RABBITMQ_TLS_SERVER_NAME": "rabbitmq.internal",
        "AI_S3_ENDPOINT_URL": "https://storage.internal:50102",
        "AI_S3_BUCKET": "pi05-" + run_id,
        "AI_S3_ACCESS_KEY_ID": "worker-storage",
        "AI_S3_SECRET_ACCESS_KEY": "storage-password",
        "AI_S3_CA_FILE": str(root / "pki" / "storage-server" / "issuer-ca.crt"),
        "AI_S3_CONNECT_HOST": "127.0.0.1",
        "AI_S3_TLS_SERVER_NAME": "storage.internal",
        "AI_RAG_INDEX_GENERATION_ID": "generation-" + run_id,
        "AI_RAG_QDRANT_URL": "https://127.0.0.1:6333",
        "AI_RAG_QDRANT_CA_FILE": str(root / "pki" / "qdrant-server" / "issuer-ca.crt"),
        "AI_RAG_QDRANT_API_KEY": "qdrant-password",
        "AI_RAG_QDRANT_COLLECTION": "collection-" + run_id,
        "AI_RAG_MODEL_PATH": str(root / "models" / "embedding"),
        "AI_RAG_RERANKER_MODEL_PATH": str(root / "models" / "reranker"),
        "AI_KNOWLEDGE_INDEXING_WORKER_ENABLED": "true",
        "AI_MEETING_INTELLIGENCE_WORKER_ENABLED": "true",
        "AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED": "true",
        "AI_MEETING_INTELLIGENCE_DECISION_ENABLED": "true",
        "AI_ASSISTANT_ENABLED": "true",
        "AI_ASSISTANT_INFERENCE_ENABLED": "true",
        "OPENROUTER_API_KEY": "provider-key",
    }
    _write_environment(root, "ai-http.env", {
        **ai,
        "AI_CORE_API_CLIENT_CERT_FILE": str(root / "pki" / "core-client" / "tls.crt"),
        "AI_CORE_API_CLIENT_KEY_FILE": str(root / "pki" / "core-client" / "tls.key"),
        "AI_SERVICE_IDENTITY": "ai-core",
        "AI_TLS_CERT_FILE": str(root / "pki" / "ai-server" / "tls.crt"),
        "AI_TLS_KEY_FILE": str(root / "pki" / "ai-server" / "tls.key"),
        "AI_TLS_CLIENT_CA_FILE": str(root / "pki" / "ai-server" / "client-ca.crt"),
    })
    _write_environment(root, "transcription-worker.env", {
        **ai,
        "AI_SERVICE_NAME": "pi05-ai-transcription-worker",
        "AI_SERVICE_IDENTITY": "ai-worker",
        "AI_WORKER_ROLE": "transcription",
        "AI_KNOWLEDGE_INDEXING_WORKER_ENABLED": "false",
        "AI_MEETING_INTELLIGENCE_WORKER_ENABLED": "false",
        "AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED": "false",
        "AI_MEETING_INTELLIGENCE_DECISION_ENABLED": "false",
    })
    _write_environment(root, "mi-worker.env", {
        **ai,
        "AI_SERVICE_NAME": "pi05-ai-mi-worker",
        "AI_SERVICE_IDENTITY": "mi-worker",
        "AI_WORKER_ROLE": "meeting-intelligence",
        "AI_KNOWLEDGE_INDEXING_WORKER_ENABLED": "false",
        "AI_MEETING_INTELLIGENCE_WORKER_ENABLED": "true",
        "AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED": "true",
        "AI_MEETING_INTELLIGENCE_DECISION_ENABLED": "true",
        "AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN": "mi-acceptance",
        "AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID": "mi-storage",
        "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY": "mi-storage-secret",
        "AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME": "mi-worker",
        "AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD": "mi-broker-password",
        "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE": str(root / "pki" / "mi-worker" / "tls.crt"),
        "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE": str(root / "pki" / "mi-worker" / "tls.key"),
        "AI_CORE_API_CLIENT_CERT_FILE": str(root / "pki" / "mi-worker" / "tls.crt"),
        "AI_CORE_API_CLIENT_KEY_FILE": str(root / "pki" / "mi-worker" / "tls.key"),
    })
    _write_environment(root, "knowledge-worker.env", {
        **ai,
        "AI_SERVICE_NAME": "pi05-ai-knowledge-worker",
        "AI_SERVICE_IDENTITY": "knowledge-worker",
        "AI_WORKER_ROLE": "knowledge-indexing",
        "AI_KNOWLEDGE_INDEXING_WORKER_ENABLED": "true",
        "AI_MEETING_INTELLIGENCE_WORKER_ENABLED": "false",
        "AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED": "false",
        "AI_MEETING_INTELLIGENCE_DECISION_ENABLED": "false",
        "AI_CORE_API_CLIENT_CERT_FILE": str(root / "pki" / "knowledge-worker" / "tls.crt"),
        "AI_CORE_API_CLIENT_KEY_FILE": str(root / "pki" / "knowledge-worker" / "tls.key"),
    })
    _write_environment(root, "harness.env", {
        **common,
        "PI05_ENVIRONMENT_KIND": "DISPOSABLE",
        "PI05_HARNESS_URL": "https://localhost:50110",
        "PI05_SOURCE_COMMIT": "a" * 40,
        "PI05_GENERATION_ID": "generation-" + run_id,
        "PI05_COLLECTION_NAME": "collection-" + run_id,
        "PI05_EVIDENCE_DIR": str(root / "evidence"),
        "PI05_PROOF_DIR": str(root / "proofs"),
        "PI05_SCENARIO_TIMEOUT_SECONDS": "60",
        "PI05_CORE_BASE_URL": "https://127.0.0.1:8080",
        "PI05_CORE_CA_FILE": str(root / "pki" / "core" / "issuer-ca.crt"),
        "PI05_CORE_CERT_FILE": str(root / "pki" / "action" / "tls.crt"),
        "PI05_CORE_KEY_FILE": str(root / "pki" / "action" / "tls.key"),
        "PI05_CORE_OBSERVER_CERT_FILE": str(root / "pki" / "core-observer" / "tls.crt"),
        "PI05_CORE_OBSERVER_KEY_FILE": str(root / "pki" / "core-observer" / "tls.key"),
        "PI05_CORE_LEAF_SHA256": "a" * 64,
        "PI05_CORE_CONNECT_HOST": "127.0.0.1",
        "PI05_CORE_TLS_SERVER_NAME": "core-api.internal",
        "PI05_AI_BASE_URL": "https://127.0.0.1:8000",
        "PI05_AI_CA_FILE": str(root / "pki" / "ai" / "issuer-ca.crt"),
        "PI05_AI_CERT_FILE": str(root / "pki" / "ai-action" / "tls.crt"),
        "PI05_AI_KEY_FILE": str(root / "pki" / "ai-action" / "tls.key"),
        "PI05_AI_LEAF_SHA256": "b" * 64,
        "PI05_ACTION_EMAIL": "operator@example.test",
        "PI05_ACTION_PASSWORD": "action-password",
        "PI05_OBSERVER_EMAIL": "observer@example.test",
        "PI05_OBSERVER_PASSWORD": "observer-password",
        "PI05_REVOKED_MEMBER_EMAIL": "member@example.test",
        "PI05_REVOKED_MEMBER_PASSWORD": "member-password",
        "PI05_STORAGE_ENDPOINT_URL": "https://127.0.0.1:50102",
        "PI05_STORAGE_BUCKET": "pi05-" + run_id,
        "PI05_STORAGE_ACCESS_KEY": "observer-storage",
        "PI05_STORAGE_SECRET_KEY": "storage-password",
        "PI05_STORAGE_CA_FILE": str(root / "pki" / "storage-server" / "issuer-ca.crt"),
        "PI05_STORAGE_LEAF_SHA256": "c" * 64,
        "PI05_STORAGE_TLS_SERVER_NAME": "storage.internal",
        "PI05_STORAGE_HOST_HEADER": "storage.internal",
        "PI05_STORAGE_OBJECT_PREFIX": "meetings/",
        "PI05_RABBIT_URL": "amqps://127.0.0.1:50101/sme-integration",
        "PI05_RABBIT_CA_FILE": str(root / "pki" / "broker-server" / "issuer-ca.crt"),
        "PI05_RABBIT_USERNAME": "observer",
        "PI05_RABBIT_PASSWORD": "broker-password",
        "PI05_RABBIT_LEAF_SHA256": "d" * 64,
        "PI05_RABBIT_TLS_SERVER_NAME": "rabbitmq.internal",
        "PI05_RABBIT_QUEUE": "pi05-" + run_id + "-observer",
        "PI05_MEDIA_FILE": str(root / "media" / "fixture.wav"),
        "PI05_QDRANT_API_KEY": "qdrant-password",
        "PI05_SCENARIO_FIXTURES_FILE": str(root / "scenario-fixtures.json"),
    })
    return root, common


def test_loader_reads_only_private_run_files_and_adds_no_parent_environment(
    tmp_path, monkeypatch,
):
    run_id = str(uuid4())
    root, _ = _files(tmp_path, run_id)
    monkeypatch.setenv("DB_PASSWORD", "must-not-be-inherited")

    config = load_run_configuration(run_id, root, runs_base=tmp_path / "runs")

    assert config.run_id == run_id
    assert config.core_env["DB_PASSWORD"] == "database-password"
    assert config.core_env["PI05_RUN_ROOT"] == str(root)
    assert config.harness("PI05_REVOKED_MEMBER_EMAIL") == "member@example.test"
    assert config.harness_process_environment()["AI_PI05_ENVIRONMENT_KIND"] == "DISPOSABLE"
    assert config.harness_process_environment()["AI_PI05_RUN_ID"] == run_id
    assert config.application_environments()["ai-http"]["AI_SETTINGS_ENV_FILE"] == ""
    environments = config.application_environments()
    assert "AI_RABBITMQ_PASSWORD" not in environments["ai-http"]
    assert "AI_S3_SECRET_ACCESS_KEY" not in environments["ai-http"]
    assert "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY" not in environments["transcription-worker"]
    assert "AI_RAG_QDRANT_API_KEY" not in environments["transcription-worker"]
    assert "AI_S3_SECRET_ACCESS_KEY" not in environments["knowledge-worker"]
    assert "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY" not in environments["knowledge-worker"]
    assert "AI_RABBITMQ_PASSWORD" not in environments["mi-worker"]
    assert "AI_S3_SECRET_ACCESS_KEY" not in environments["mi-worker"]
    assert config.transcription_worker_env["AI_SERVICE_IDENTITY"] == "ai-worker"
    assert config.mi_worker_env["AI_SERVICE_IDENTITY"] == "mi-worker"
    assert config.knowledge_worker_env["AI_SERVICE_IDENTITY"] == "knowledge-worker"
    assert set(config.application_environments()) == {
        "core", "ai-http", "transcription-worker", "mi-worker", "knowledge-worker",
    }
    assert "DB_PASSWORD" not in os.environ or config.core_env["DB_PASSWORD"] != os.environ["DB_PASSWORD"]


def test_loader_rejects_wrong_run_root_and_duplicate_or_unknown_settings(tmp_path):
    run_id = str(uuid4())
    root, _ = _files(tmp_path, run_id)

    with pytest.raises(RuntimeConfigError):
        load_run_configuration(run_id, root, runs_base=tmp_path / "other-runs")

    path = root / "secrets" / "harness.env"
    path.write_text(path.read_text(encoding="utf-8") + "PI05_CORE_BASE_URL=again\n", encoding="utf-8")
    path.chmod(0o600)
    with pytest.raises(RuntimeConfigError):
        load_run_configuration(run_id, root, runs_base=tmp_path / "runs")


@pytest.mark.parametrize(
    "setting,value",
    [
        ("PI05_STORAGE_TLS_SERVER_NAME", "127.0.0.1"),
        ("PI05_STORAGE_HOST_HEADER", "localhost"),
        ("PI05_RABBIT_TLS_SERVER_NAME", "localhost"),
    ],
)
def test_loader_rejects_endpoint_identity_mismatch(tmp_path, setting, value):
    run_id = str(uuid4())
    root, _ = _files(tmp_path, run_id)
    path = root / "secrets" / "harness.env"
    raw = path.read_text(encoding="utf-8")
    path.write_text(
        raw.replace(f"{setting}={dict(line.split('=', 1) for line in raw.splitlines())[setting]}",
                    f"{setting}={value}"),
        encoding="utf-8",
    )
    path.chmod(0o600)
    with pytest.raises(RuntimeConfigError, match="identit"):
        load_run_configuration(run_id, root, runs_base=tmp_path / "runs")

    path.write_text(path.read_text(encoding="utf-8") + "NOT_A_RUNTIME_SETTING=value\n", encoding="utf-8")
    with pytest.raises(RuntimeConfigError):
        load_run_configuration(run_id, root, runs_base=tmp_path / "runs")


@pytest.mark.parametrize(
    "filename,setting,value",
    [
        ("core.env", "RABBITMQ_HOST", "localhost"),
        ("core.env", "APP_MEDIA_STORAGE_ENDPOINT", "https://localhost:50102"),
        ("ai-http.env", "AI_S3_ENDPOINT_URL", "https://localhost:50102"),
        ("ai-http.env", "AI_SERVICE_IDENTITY", "ai-worker"),
    ],
)
def test_loader_rejects_application_identity_mismatch(tmp_path, filename, setting, value):
    run_id = str(uuid4())
    root, _ = _files(tmp_path, run_id)
    path = root / "secrets" / filename
    lines = path.read_text(encoding="utf-8").splitlines()
    path.write_text(
        "\n".join(
            f"{setting}={value}" if line.startswith(f"{setting}=") else line
            for line in lines
        )
        + "\n",
        encoding="utf-8",
    )
    path.chmod(0o600)
    with pytest.raises(RuntimeConfigError, match="identit"):
        load_run_configuration(run_id, root, runs_base=tmp_path / "runs")


def test_loader_rejects_non_https_qdrant_endpoint(tmp_path):
    run_id = str(uuid4())
    root, _ = _files(tmp_path, run_id)
    path = root / "secrets" / "ai-http.env"
    lines = path.read_text(encoding="utf-8").splitlines()
    path.write_text(
        "\n".join(
            "AI_RAG_QDRANT_URL=http://127.0.0.1:6333"
            if line.startswith("AI_RAG_QDRANT_URL=")
            else line
            for line in lines
        )
        + "\n",
        encoding="utf-8",
    )
    path.chmod(0o600)

    with pytest.raises(
        RuntimeConfigError,
        match="Qdrant endpoint must use verified HTTPS loopback",
    ):
        load_run_configuration(run_id, root, runs_base=tmp_path / "runs")


def test_loader_rejects_qdrant_trust_material_outside_the_run(tmp_path):
    run_id = str(uuid4())
    root, _ = _files(tmp_path, run_id)
    path = root / "secrets" / "ai-http.env"
    raw = path.read_text(encoding="utf-8")
    path.write_text(
        raw.replace(
            f"AI_RAG_QDRANT_CA_FILE={root}/pki/qdrant-server/issuer-ca.crt",
            "AI_RAG_QDRANT_CA_FILE=/etc/ssl/certs/shared-qdrant-ca.crt",
        ),
        encoding="utf-8",
    )
    path.chmod(0o600)

    with pytest.raises(RuntimeConfigError, match="run"):
        load_run_configuration(run_id, root, runs_base=tmp_path / "runs")


@pytest.mark.parametrize(
    ("filename", "setting", "value"),
    [
        ("transcription-worker.env", "AI_SERVICE_IDENTITY", "mi-worker"),
        ("mi-worker.env", "AI_WORKER_ROLE", "knowledge-indexing"),
        ("knowledge-worker.env", "AI_KNOWLEDGE_INDEXING_WORKER_ENABLED", "false"),
    ],
)
def test_loader_rejects_worker_role_identity_or_capability_reuse(
    tmp_path, filename, setting, value,
):
    run_id = str(uuid4())
    root, _ = _files(tmp_path, run_id)
    path = root / "secrets" / filename
    lines = path.read_text(encoding="utf-8").splitlines()
    path.write_text(
        "\n".join(
            f"{setting}={value}" if line.startswith(f"{setting}=") else line
            for line in lines
        )
        + "\n",
        encoding="utf-8",
    )
    path.chmod(0o600)

    with pytest.raises(RuntimeConfigError, match="worker"):
        load_run_configuration(run_id, root, runs_base=tmp_path / "runs")
