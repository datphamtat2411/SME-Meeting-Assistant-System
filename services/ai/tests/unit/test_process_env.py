"""Focused tests for canonical AI-to-process environment mapping."""

from __future__ import annotations

import importlib.util
import stat
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "process_env.py"
SPEC = importlib.util.spec_from_file_location("ai_process_env", SCRIPT)
assert SPEC and SPEC.loader
process_env = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(process_env)


def _values() -> dict[str, str]:
    return {
        "AI_LOG_LEVEL": "INFO",
        "AI_TRANSCRIPTION_PROCESS_SERVICE_NAME": "transcription-ai",
        "AI_TRANSCRIPTION_PROCESS_SERVICE_IDENTITY": "ai-worker",
        "AI_TRANSCRIPTION_PROCESS_WORKER_ROLE": "transcription",
        "AI_TRANSCRIPTION_PROCESS_CORE_API_BASE_URL": "https://core-api.internal:8443",
        "AI_TRANSCRIPTION_PROCESS_CORE_API_SERVER_CA_FILE": "/run/core-ca.crt",
        "AI_TRANSCRIPTION_PROCESS_CORE_API_CLIENT_CERT_FILE": "/run/transcription.crt",
        "AI_TRANSCRIPTION_PROCESS_CORE_API_CLIENT_KEY_FILE": "/run/transcription.key",
        "AI_TRANSCRIPTION_PROCESS_RABBITMQ_URL": "amqps://rabbitmq.internal:5671/sme-integration",
        "AI_TRANSCRIPTION_PROCESS_RABBITMQ_USERNAME": "transcription-user",
        "AI_TRANSCRIPTION_PROCESS_RABBITMQ_PASSWORD": "transcription-password",
        "AI_TRANSCRIPTION_PROCESS_RABBITMQ_CA_FILE": "/run/broker-ca.crt",
        "AI_TRANSCRIPTION_PROCESS_S3_ENDPOINT_URL": "https://storage.internal:9443",
        "AI_TRANSCRIPTION_PROCESS_S3_BUCKET": "meeting-media",
        "AI_TRANSCRIPTION_PROCESS_S3_ACCESS_KEY_ID": "transcription-access",
        "AI_TRANSCRIPTION_PROCESS_S3_SECRET_ACCESS_KEY": "transcription-secret",
        "AI_TRANSCRIPTION_PROCESS_S3_CA_FILE": "/run/storage-ca.crt",
        "AI_TRANSCRIPTION_PROCESS_OPENROUTER_API_KEY": "transcription-provider",
        "AI_TRANSCRIPTION_PROCESS_REPLICATE_API_TOKEN": "transcription-replicate",
        "AI_MI_PROCESS_SERVICE_NAME": "mi-ai",
        "AI_MI_PROCESS_SERVICE_IDENTITY": "mi-worker",
        "AI_MI_PROCESS_WORKER_ROLE": "meeting-intelligence",
        "AI_MI_PROCESS_CORE_API_BASE_URL": "https://core-api.internal:8443",
        "AI_MI_PROCESS_CORE_API_SERVER_CA_FILE": "/run/core-ca.crt",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE": "/run/mi.crt",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE": "/run/mi.key",
        "AI_MI_PROCESS_RABBITMQ_URL": "amqps://rabbitmq.internal:5671/sme-integration",
        "AI_MI_PROCESS_RABBITMQ_CA_FILE": "/run/broker-ca.crt",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_RABBITMQ_USERNAME": "mi-user",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD": "mi-password",
        "AI_MI_PROCESS_S3_ENDPOINT_URL": "https://storage.internal:9443",
        "AI_MI_PROCESS_S3_BUCKET": "meeting-media",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID": "mi-access",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY": "mi-secret",
        "AI_MI_PROCESS_S3_CA_FILE": "/run/storage-ca.crt",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN": "mi-acceptance",
    }


def test_http_mapping_uses_process_identity_and_does_not_copy_worker_credentials():
    values = _values() | {
        "AI_HTTP_PROCESS_SERVICE_NAME": "http-ai",
        "AI_HTTP_PROCESS_SERVICE_IDENTITY": "ai-core",
        "AI_HTTP_PROCESS_HOST": "127.0.0.1",
        "AI_HTTP_PROCESS_PORT": "9000",
        "AI_HTTP_PROCESS_SHUTDOWN_TIMEOUT_SECONDS": "12",
        "AI_HTTP_PROCESS_TLS_CERT_FILE": "/run/http.crt",
        "AI_HTTP_PROCESS_TLS_KEY_FILE": "/run/http.key",
        "AI_HTTP_PROCESS_TLS_CLIENT_CA_FILE": "/run/client-ca.crt",
        "AI_RAG_QDRANT_URL": "https://localhost:6333",
        "AI_HTTP_PROCESS_RAG_QDRANT_API_KEY": "http-qdrant",
        "AI_HTTP_PROCESS_RAG_QDRANT_CA_FILE": "/run/qdrant-ca.crt",
        "AI_HTTP_PROCESS_OPENROUTER_API_KEY": "http-provider",
    }

    result = process_env.build_environment(values, "ai-http", inherited={})

    assert result["AI_SERVICE_NAME"] == "http-ai"
    assert result["AI_SERVICE_IDENTITY"] == "ai-core"
    assert result["AI_HTTP_HOST"] == "127.0.0.1"
    assert result["AI_HTTP_PORT"] == "9000"
    assert result["AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS"] == "12"
    assert result["AI_TLS_CERT_FILE"] == "/run/http.crt"
    assert result["AI_RAG_QDRANT_URL"] == "https://localhost:6333"
    assert result["AI_RAG_QDRANT_API_KEY"] == "http-qdrant"
    assert result["AI_RAG_QDRANT_CA_FILE"] == "/run/qdrant-ca.crt"
    assert result["OPENROUTER_API_KEY"] == "http-provider"
    assert "AI_RABBITMQ_PASSWORD" not in result
    assert "AI_S3_SECRET_ACCESS_KEY" not in result
    assert not any(name.startswith("AI_TRANSCRIPTION_PROCESS_") for name in result)
    assert result["AI_SETTINGS_ENV_FILE"] == ""


def test_worker_mapping_is_role_specific():
    result = process_env.build_environment(_values(), "transcription-worker", inherited={})

    assert result["AI_SERVICE_IDENTITY"] == "ai-worker"
    assert result["AI_WORKER_ROLE"] == "transcription"
    assert result["AI_RABBITMQ_USERNAME"] == "transcription-user"
    assert result["AI_RABBITMQ_PASSWORD"] == "transcription-password"
    assert result["AI_S3_ACCESS_KEY_ID"] == "transcription-access"
    assert result["OPENROUTER_API_KEY"] == "transcription-provider"
    assert result["REPLICATE_API_TOKEN"] == "transcription-replicate"
    assert "AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN" not in result
    assert "AI_RAG_QDRANT_API_KEY" not in result


def test_transcription_mapping_preserves_diarization_approval_and_capability_settings():
    values = _values() | {
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_ENABLED": "true",
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_PROVIDER_APPROVED": "true",
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_PROJECTION_READY": "true",
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_S3_ACCESS_KEY_ID": "diarization-access",
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY": "diarization-secret",
    }

    result = process_env.build_environment(values, "transcription-worker", inherited={})

    assert result["AI_DIARIZATION_WORKER_ENABLED"] == "true"
    assert result["AI_DIARIZATION_WORKER_PROVIDER_APPROVED"] == "true"
    assert result["AI_DIARIZATION_WORKER_PROJECTION_READY"] == "true"
    assert result["AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID"] == "diarization-access"
    assert result["AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY"] == "diarization-secret"


def test_transcription_mapping_resolves_dedicated_diarization_storage_files(tmp_path):
    access = tmp_path / "diarization-access"
    access.write_text("diarization-access\n", encoding="utf-8")
    access.chmod(0o600)
    secret = tmp_path / "diarization-secret"
    secret.write_text("diarization-secret\n", encoding="utf-8")
    secret.chmod(0o600)
    values = _values() | {
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_ENABLED": "true",
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_PROVIDER_APPROVED": "true",
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_PROJECTION_READY": "true",
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_S3_ACCESS_KEY_ID": "",
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_S3_ACCESS_KEY_ID_FILE": str(access),
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY": "",
        "AI_TRANSCRIPTION_PROCESS_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY_FILE": str(secret),
    }

    result = process_env.build_environment(values, "transcription-worker", inherited={})

    assert result["AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID"] == "diarization-access"
    assert result["AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY"] == "diarization-secret"
    assert "AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID_FILE" not in result
    assert "AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY_FILE" not in result


def test_explicit_worker_launcher_enables_only_selected_knowledge_capability():
    values = {
        "AI_KNOWLEDGE_PROCESS_SERVICE_NAME": "knowledge-ai",
        "AI_KNOWLEDGE_PROCESS_SERVICE_IDENTITY": "knowledge-worker",
        "AI_KNOWLEDGE_PROCESS_WORKER_ROLE": "knowledge-indexing",
        "AI_KNOWLEDGE_PROCESS_CORE_API_BASE_URL": "https://core-api.internal:8443",
        "AI_KNOWLEDGE_PROCESS_CORE_API_SERVER_CA_FILE": "/run/core-ca.crt",
        "AI_KNOWLEDGE_PROCESS_CORE_API_CLIENT_CERT_FILE": "/run/knowledge.crt",
        "AI_KNOWLEDGE_PROCESS_CORE_API_CLIENT_KEY_FILE": "/run/knowledge.key",
        "AI_KNOWLEDGE_PROCESS_RABBITMQ_URL": "amqps://rabbitmq.internal:5671/sme-integration",
        "AI_KNOWLEDGE_PROCESS_RABBITMQ_USERNAME": "knowledge-user",
        "AI_KNOWLEDGE_PROCESS_RABBITMQ_PASSWORD": "knowledge-password",
        "AI_KNOWLEDGE_PROCESS_RABBITMQ_CA_FILE": "/run/broker-ca.crt",
        "AI_KNOWLEDGE_PROCESS_RAG_MODEL_PATH": "/run/bge-m3",
        "AI_KNOWLEDGE_PROCESS_RAG_RERANKER_MODEL_PATH": "/run/reranker",
        "AI_KNOWLEDGE_PROCESS_RAG_QDRANT_API_KEY": "qdrant-key",
        "AI_KNOWLEDGE_PROCESS_RAG_QDRANT_CA_FILE": "/run/qdrant-ca.crt",
        "AI_RAG_QDRANT_URL": "https://qdrant.internal:6333",
        "AI_KNOWLEDGE_PROCESS_KNOWLEDGE_INDEXING_WORKER_ENABLED": "false",
        "AI_KNOWLEDGE_PROCESS_MEETING_INTELLIGENCE_WORKER_ENABLED": "false",
        "AI_KNOWLEDGE_PROCESS_MEETING_INTELLIGENCE_INFERENCE_ENABLED": "false",
        "AI_KNOWLEDGE_PROCESS_MEETING_INTELLIGENCE_DECISION_ENABLED": "false",
    }

    result = process_env.build_environment(
        values,
        "knowledge-worker",
        inherited={},
        enable_selected_worker=True,
    )

    assert result["AI_KNOWLEDGE_INDEXING_WORKER_ENABLED"] == "true"
    assert result["AI_RAG_QDRANT_URL"] == "https://qdrant.internal:6333"
    assert result["AI_MEETING_INTELLIGENCE_WORKER_ENABLED"] == "false"
    assert result["AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED"] == "false"
    assert result["AI_MEETING_INTELLIGENCE_DECISION_ENABLED"] == "false"


def test_explicit_mi_launcher_enables_all_meeting_intelligence_capability_gates():
    values = _values() | {
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_WORKER_ENABLED": "false",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_INFERENCE_ENABLED": "false",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_SUMMARY_ENABLED": "false",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_DECISION_ENABLED": "false",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_ACTION_ITEM_ENABLED": "false",
    }
    gate_names = (
        "AI_MEETING_INTELLIGENCE_WORKER_ENABLED",
        "AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED",
        "AI_MEETING_INTELLIGENCE_SUMMARY_ENABLED",
        "AI_MEETING_INTELLIGENCE_DECISION_ENABLED",
        "AI_MEETING_INTELLIGENCE_ACTION_ITEM_ENABLED",
    )

    disabled = process_env.build_environment(values, "mi-worker", inherited={})
    assert all(disabled[name] == "false" for name in gate_names)

    enabled = process_env.build_environment(
        values,
        "mi-worker",
        inherited={},
        enable_selected_worker=True,
    )
    assert all(enabled[name] == "true" for name in gate_names)


def test_transcription_mapping_excludes_unrelated_shared_rag_settings():
    values = _values() | {
        "AI_RAG_MODEL_PATH": "/run/knowledge-model",
        "AI_RAG_QDRANT_URL": "https://qdrant.internal:6333",
        "AI_RAG_QDRANT_CA_FILE": "/run/qdrant-ca.crt",
    }

    result = process_env.build_environment(values, "transcription-worker", inherited={})

    assert not any(name.startswith("AI_RAG_") for name in result)


def test_protected_secret_file_references_feed_http_and_knowledge_processes(tmp_path):
    rabbit_secret = tmp_path / "knowledge-worker.env"
    rabbit_secret.write_text("AI_RABBITMQ_PASSWORD=knowledge-password\n", encoding="utf-8")
    rabbit_secret.chmod(0o600)
    qdrant_secret = tmp_path / "qdrant-api-key"
    qdrant_secret.write_text("qdrant-api-key-value\n", encoding="utf-8")
    qdrant_secret.chmod(0o600)

    values = _values() | {
        "AI_HTTP_PROCESS_SERVICE_NAME": "http-ai",
        "AI_HTTP_PROCESS_SERVICE_IDENTITY": "ai-core",
        "AI_HTTP_PROCESS_HOST": "127.0.0.1",
        "AI_HTTP_PROCESS_PORT": "9000",
        "AI_HTTP_PROCESS_SHUTDOWN_TIMEOUT_SECONDS": "12",
        "AI_HTTP_PROCESS_TLS_CERT_FILE": "/run/http.crt",
        "AI_HTTP_PROCESS_TLS_KEY_FILE": "/run/http.key",
        "AI_HTTP_PROCESS_TLS_CLIENT_CA_FILE": "/run/client-ca.crt",
        "AI_HTTP_PROCESS_RAG_QDRANT_API_KEY_FILE": str(qdrant_secret),
        "AI_HTTP_PROCESS_RAG_QDRANT_CA_FILE": "/run/qdrant-ca.crt",
        "AI_KNOWLEDGE_PROCESS_SERVICE_NAME": "knowledge-ai",
        "AI_KNOWLEDGE_PROCESS_SERVICE_IDENTITY": "knowledge-worker",
        "AI_KNOWLEDGE_PROCESS_WORKER_ROLE": "knowledge-indexing",
        "AI_KNOWLEDGE_PROCESS_CORE_API_BASE_URL": "https://core-api.internal:8443",
        "AI_KNOWLEDGE_PROCESS_CORE_API_SERVER_CA_FILE": "/run/core-ca.crt",
        "AI_KNOWLEDGE_PROCESS_CORE_API_CLIENT_CERT_FILE": "/run/knowledge.crt",
        "AI_KNOWLEDGE_PROCESS_CORE_API_CLIENT_KEY_FILE": "/run/knowledge.key",
        "AI_KNOWLEDGE_PROCESS_RABBITMQ_URL": "amqps://rabbitmq.internal:5671/sme-integration",
        "AI_KNOWLEDGE_PROCESS_RABBITMQ_USERNAME": "knowledge-user",
        "AI_KNOWLEDGE_PROCESS_RABBITMQ_PASSWORD": "",
        "AI_KNOWLEDGE_PROCESS_RABBITMQ_PASSWORD_FILE": str(rabbit_secret),
        "AI_KNOWLEDGE_PROCESS_RABBITMQ_CA_FILE": "/run/broker-ca.crt",
        "AI_KNOWLEDGE_PROCESS_RAG_MODEL_PATH": "/run/bge-m3",
        "AI_KNOWLEDGE_PROCESS_RAG_RERANKER_MODEL_PATH": "/run/reranker",
        "AI_KNOWLEDGE_PROCESS_RAG_QDRANT_API_KEY": "",
        "AI_KNOWLEDGE_PROCESS_RAG_QDRANT_API_KEY_FILE": str(qdrant_secret),
        "AI_KNOWLEDGE_PROCESS_RAG_QDRANT_CA_FILE": "/run/qdrant-ca.crt",
    }

    http = process_env.build_environment(values, "ai-http", inherited={})
    knowledge = process_env.build_environment(values, "knowledge-worker", inherited={})

    assert http["AI_RAG_QDRANT_API_KEY"] == "qdrant-api-key-value"
    assert http["AI_RAG_QDRANT_CA_FILE"] == "/run/qdrant-ca.crt"
    assert knowledge["AI_RABBITMQ_PASSWORD"] == "knowledge-password"
    assert knowledge["AI_RAG_QDRANT_API_KEY"] == "qdrant-api-key-value"
    assert "AI_RAG_QDRANT_API_KEY_FILE" not in http
    assert "AI_RAG_QDRANT_API_KEY_FILE" not in knowledge
    assert "AI_RABBITMQ_PASSWORD_FILE" not in knowledge


def test_protected_secret_file_references_fail_closed_when_permissions_are_broad(tmp_path):
    secret = tmp_path / "qdrant-api-key"
    secret.write_text("qdrant-api-key-value\n", encoding="utf-8")
    secret.chmod(0o644)
    values = {
        "AI_HTTP_PROCESS_SERVICE_NAME": "http-ai",
        "AI_HTTP_PROCESS_SERVICE_IDENTITY": "ai-core",
        "AI_HTTP_PROCESS_HOST": "127.0.0.1",
        "AI_HTTP_PROCESS_PORT": "9000",
        "AI_HTTP_PROCESS_SHUTDOWN_TIMEOUT_SECONDS": "12",
        "AI_HTTP_PROCESS_TLS_CERT_FILE": "/run/http.crt",
        "AI_HTTP_PROCESS_TLS_KEY_FILE": "/run/http.key",
        "AI_HTTP_PROCESS_TLS_CLIENT_CA_FILE": "/run/client-ca.crt",
        "AI_HTTP_PROCESS_RAG_QDRANT_API_KEY_FILE": str(secret),
    }

    with pytest.raises(process_env.ProcessEnvironmentError, match="(?i)protected secret"):
        process_env.build_environment(values, "ai-http", inherited={})


def test_meeting_intelligence_protected_credential_files_are_resolved(tmp_path):
    broker = tmp_path / "mi-worker-rabbitmq.env"
    broker.write_text(
        "MI_RABBITMQ_USERNAME=mi-user\n"
        "MI_RABBITMQ_PASSWORD=mi-password\n",
        encoding="utf-8",
    )
    broker.chmod(0o600)
    storage = tmp_path / "mi-worker-storage.env"
    storage.write_text(
        "MI_STORAGE_ACCESS_KEY_ID=mi-access\n"
        "MI_STORAGE_SECRET_ACCESS_KEY=mi-secret\n",
        encoding="utf-8",
    )
    storage.chmod(0o600)
    token = tmp_path / "mi-worker-result-acceptance-token"
    token.write_text("mi-acceptance\n", encoding="utf-8")
    token.chmod(0o600)

    values = _values() | {
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_RABBITMQ_USERNAME": "",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_RABBITMQ_USERNAME_FILE": str(broker),
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD": "",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD_FILE": str(broker),
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID": "",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID_FILE": str(storage),
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY": "",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY_FILE": str(storage),
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN": "",
        "AI_MI_PROCESS_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN_FILE": str(token),
    }

    result = process_env.build_environment(values, "mi-worker", inherited={})

    assert result["AI_RABBITMQ_USERNAME"] == "mi-user"
    assert result["AI_RABBITMQ_PASSWORD"] == "mi-password"
    assert result["AI_S3_ACCESS_KEY_ID"] == "mi-access"
    assert result["AI_S3_SECRET_ACCESS_KEY"] == "mi-secret"
    assert result["AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN"] == "mi-acceptance"
    assert not any(name in result for name in (
        "AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME_FILE",
        "AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD_FILE",
        "AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID_FILE",
        "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY_FILE",
        "AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN_FILE",
    ))


def test_meeting_intelligence_provider_uses_its_dedicated_one_line_file(tmp_path):
    provider = tmp_path / "mi-worker-openrouter-api-key"
    provider.write_text("mi-provider-key\n", encoding="utf-8")
    provider.chmod(0o600)

    values = _values() | {
        "AI_MI_PROCESS_OPENROUTER_API_KEY_FILE": str(provider),
    }

    result = process_env.build_environment(values, "mi-worker", inherited={})
    transcription = process_env.build_environment(values, "transcription-worker", inherited={})

    assert result["OPENROUTER_API_KEY"] == "mi-provider-key"
    assert transcription["OPENROUTER_API_KEY"] == "transcription-provider"
    assert "AI_MI_PROCESS_OPENROUTER_API_KEY_FILE" not in result


def test_meeting_intelligence_does_not_inherit_knowledge_rag_settings():
    values = _values() | {
        "AI_RAG_MODEL_PATH": "/run/knowledge-model",
        "AI_RAG_QDRANT_URL": "https://localhost:6333",
        "AI_RAG_QDRANT_CA_FILE": "/run/qdrant-ca.crt",
    }

    result = process_env.build_environment(values, "mi-worker", inherited={})

    assert not any(name.startswith("AI_RAG_") for name in result)


def test_meeting_intelligence_mapping_keeps_its_dedicated_credentials():
    result = process_env.build_environment(_values(), "mi-worker", inherited={})

    assert result["AI_SERVICE_IDENTITY"] == "mi-worker"
    assert result["AI_WORKER_ROLE"] == "meeting-intelligence"
    assert result["AI_RABBITMQ_USERNAME"] == "mi-user"
    assert result["AI_RABBITMQ_PASSWORD"] == "mi-password"
    assert result["AI_S3_ACCESS_KEY_ID"] == "mi-access"
    assert result["AI_S3_SECRET_ACCESS_KEY"] == "mi-secret"
    assert result["AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN"] == "mi-acceptance"
    assert "AI_RAG_QDRANT_API_KEY" not in result
    assert all(result[name] == "false" for name in (
        "AI_MEETING_INTELLIGENCE_WORKER_ENABLED",
        "AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED",
        "AI_MEETING_INTELLIGENCE_SUMMARY_ENABLED",
        "AI_MEETING_INTELLIGENCE_DECISION_ENABLED",
        "AI_MEETING_INTELLIGENCE_ACTION_ITEM_ENABLED",
    ))


def test_process_environment_precedence_is_explicit():
    values = _values() | {
        "AI_TRANSCRIPTION_PROCESS_SERVICE_NAME": "from-file",
    }

    result = process_env.build_environment(
        values,
        "transcription-worker",
        inherited={"AI_TRANSCRIPTION_PROCESS_SERVICE_NAME": "from-process"},
    )

    assert result["AI_SERVICE_NAME"] == "from-process"


def test_process_environment_rejects_wrong_role_identity():
    values = _values() | {
        "AI_TRANSCRIPTION_PROCESS_SERVICE_IDENTITY": "mi-worker",
    }

    with pytest.raises(process_env.ProcessEnvironmentError, match="identity"):
        process_env.build_environment(values, "transcription-worker", inherited={})


def test_missing_process_setting_is_sanitized():
    values = _values()
    secret = values.pop("AI_TRANSCRIPTION_PROCESS_RABBITMQ_PASSWORD")

    with pytest.raises(process_env.ProcessEnvironmentError) as caught:
        process_env.build_environment(values, "transcription-worker", inherited={})

    assert secret not in str(caught.value)
    assert "incomplete" in str(caught.value)


def test_literal_reader_does_not_evaluate_values(tmp_path):
    path = tmp_path / ".env"
    path.write_text("AI_SERVICE_NAME=$(touch /tmp/should-not-exist)\n", encoding="utf-8")

    assert process_env.read_environment(path)["AI_SERVICE_NAME"] == "$(touch /tmp/should-not-exist)"


def test_generated_environment_is_private_and_sorted(tmp_path):
    destination = tmp_path / "private" / "worker.env"
    process_env.write_environment(destination, {"Z_KEY": "z", "A_KEY": "a"})

    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert destination.read_text(encoding="utf-8").splitlines() == ["A_KEY=a", "Z_KEY=z"]


def test_generated_runtime_environment_can_be_consumed_without_role_sources(tmp_path):
    destination = tmp_path / "private" / "runtime.env"
    process_env.write_environment(
        destination,
        {"AI_SERVICE_NAME": "ai", "AI_SERVICE_IDENTITY": "ai-core"},
    )

    result = process_env._read_runtime_environment(destination)

    assert result == {"AI_SERVICE_NAME": "ai", "AI_SERVICE_IDENTITY": "ai-core"}
