import os
import traceback

import pytest

from sme_meeting_ai.core.config import (
    ConfigurationError,
    Environment,
    Settings,
    get_settings,
    load_settings,
)


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    monkeypatch.setattr(os, "environ", {})
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_explicit_settings_defaults_without_external_configuration():
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)

    assert settings.service_name == "test-ai"
    assert settings.environment is Environment.DEVELOPMENT
    assert settings.debug is False
    assert settings.log_level == "INFO"
    assert settings.http_host == "127.0.0.1"
    assert settings.http_port == 8000
    assert settings.worker_concurrency == 1
    assert settings.worker_shutdown_timeout_seconds == 30
    assert settings.service_identity == "ai-core"
    assert settings.internal_allowed_callers == ("core-api",)
    assert "internal_service_token" not in Settings.model_fields


def test_environment_overrides_are_typed_and_case_insensitive(monkeypatch):
    values = {
        "ai_service_name": "worker-ai",
        "AI_SERVICE_IDENTITY": "worker-ai",
        "AI_INTERNAL_ALLOWED_CALLERS": '[]',
        "AI_ENVIRONMENT": "production",
        "AI_DEBUG": "true",
        "AI_LOG_LEVEL": "WARNING",
        "AI_HTTP_HOST": "0.0.0.0",
        "AI_HTTP_PORT": "9000",
        "AI_WORKER_CONCURRENCY": "4",
        "AI_WORKER_SHUTDOWN_TIMEOUT_SECONDS": "12.5",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)

    settings = load_settings(env_file=None)

    assert settings.service_name == "worker-ai"
    assert settings.service_identity == "worker-ai"
    assert settings.internal_allowed_callers == ()
    assert settings.environment is Environment.PRODUCTION
    assert settings.debug is True
    assert settings.log_level == "WARNING"
    assert settings.http_host == "0.0.0.0"
    assert settings.http_port == 9000
    assert settings.worker_concurrency == 4
    assert settings.worker_shutdown_timeout_seconds == 12.5


def test_dotenv_loading_ignores_unrelated_keys_and_environment_wins(
    tmp_path, monkeypatch
):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "AI_SERVICE_NAME=dotenv-ai\nAI_SERVICE_IDENTITY=ai-core\nAI_HTTP_PORT=8080\n"
        "UNRELATED_SETTING=ignored\nAI_FUTURE_SETTING=ignored\n"
    )
    monkeypatch.setenv("AI_HTTP_PORT", "9001")

    settings = load_settings(env_file=env_file)

    assert settings.service_name == "dotenv-ai"
    assert settings.http_port == 9001


@pytest.mark.parametrize(
    ("key", "value", "field", "category"),
    [
        ("AI_HTTP_PORT", "0", "http_port", "greater_than_equal"),
        ("AI_HTTP_PORT", "65536", "http_port", "less_than_equal"),
        ("AI_HTTP_PORT", "invalid", "http_port", "int_parsing"),
        ("AI_WORKER_CONCURRENCY", "0", "worker_concurrency", "greater_than"),
        ("AI_WORKER_SHUTDOWN_TIMEOUT_SECONDS", "0", "worker_shutdown_timeout_seconds", "greater_than"),
        ("AI_WORKER_SHUTDOWN_TIMEOUT_SECONDS", "301", "worker_shutdown_timeout_seconds", "less_than_equal"),
        ("AI_WORKER_SHUTDOWN_TIMEOUT_SECONDS", "private-value", "worker_shutdown_timeout_seconds", "float_parsing"),
        ("AI_WORKER_SHUTDOWN_TIMEOUT_SECONDS", "nan", "worker_shutdown_timeout_seconds", "finite_number"),
        ("AI_DEBUG", "invalid", "debug", "bool_parsing"),
        ("AI_ENVIRONMENT", "invalid", "environment", "enum"),
        ("AI_LOG_LEVEL", "invalid", "log_level", "literal_error"),
        ("AI_SERVICE_IDENTITY", "Bearer private-token", "service_identity", "string_pattern_mismatch"),
        ("AI_INTERNAL_ALLOWED_CALLERS", '["unknown"]', "internal_allowed_callers.0", "literal_error"),
    ],
)
def test_invalid_values_have_sanitized_field_and_category(
    monkeypatch, key, value, field, category
):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.setenv(key, value)

    with pytest.raises(ConfigurationError) as caught:
        load_settings(env_file=None)

    assert str(caught.value) == f"Invalid configuration: {field}: {category}"
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None


def test_missing_service_name_is_reported_as_required():
    with pytest.raises(ConfigurationError, match="service_name: missing"):
        load_settings(env_file=None)


@pytest.mark.parametrize("port", [1, 65535])
def test_port_boundaries(port):
    assert Settings(service_name="test-ai", service_identity="ai-core", http_port=port, _env_file=None).http_port == port


@pytest.mark.parametrize("timeout", [0.01, 300])
def test_worker_shutdown_timeout_boundaries(timeout):
    settings = Settings(
        service_name="test-ai", service_identity="ai-core",
        worker_shutdown_timeout_seconds=timeout, _env_file=None,
    )
    assert settings.worker_shutdown_timeout_seconds == timeout


def test_service_identity_is_required(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    with pytest.raises(ConfigurationError, match="service_identity: missing"):
        load_settings(env_file=None)


@pytest.mark.parametrize("identity", ["", "Core-API", " core-api", "core-api ", "a/b", "a" * 64, "core-api"])
def test_invalid_or_self_authorized_identity_is_rejected(monkeypatch, identity):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", identity)
    with pytest.raises(ConfigurationError):
        load_settings(env_file=None)


def test_malformed_caller_json_is_sanitized(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.setenv("AI_INTERNAL_ALLOWED_CALLERS", "private-invalid-json")
    with pytest.raises(ConfigurationError) as caught:
        load_settings(env_file=None)
    assert "private-invalid-json" not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None


def test_invalid_secret_like_input_is_absent_from_error_and_traceback(monkeypatch):
    secret = "test-only-sensitive-value"
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.setenv("AI_INTERNAL_SERVICE_TOKEN", secret)
    monkeypatch.setenv("AI_HTTP_PORT", secret)

    with pytest.raises(ConfigurationError) as caught:
        load_settings(env_file=None)

    assert secret not in str(caught.value)
    assert secret not in repr(caught.value)
    assert secret not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None


def test_cached_access_is_lazy_and_explicit_loading_is_uncached(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text("AI_SERVICE_NAME=first-ai\nAI_SERVICE_IDENTITY=ai-core\n")

    first = get_settings()
    monkeypatch.setenv("AI_SERVICE_NAME", "second-ai")

    assert get_settings() is first
    assert first.service_name == "first-ai"
    assert load_settings().service_name == "second-ai"
    get_settings.cache_clear()
    assert get_settings().service_name == "second-ai"
