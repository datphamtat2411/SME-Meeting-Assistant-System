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
        "AI_HTTP_PROCESS_OPENROUTER_API_KEY": "http-provider",
    }

    result = process_env.build_environment(values, "ai-http", inherited={})

    assert result["AI_SERVICE_NAME"] == "http-ai"
    assert result["AI_SERVICE_IDENTITY"] == "ai-core"
    assert result["AI_HTTP_HOST"] == "127.0.0.1"
    assert result["AI_HTTP_PORT"] == "9000"
    assert result["AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS"] == "12"
    assert result["AI_TLS_CERT_FILE"] == "/run/http.crt"
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
