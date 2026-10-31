import os
import traceback
from pathlib import Path

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
    assert settings.http_shutdown_timeout_seconds == 30
    assert settings.tls_cert_file is None
    assert settings.tls_key_file is None
    assert settings.tls_client_ca_file is None
    assert settings.worker_concurrency == 1
    assert settings.worker_shutdown_timeout_seconds == 30
    assert settings.service_identity == "ai-core"
    assert settings.internal_allowed_callers == ("core-api",)
    assert "internal_service_token" not in Settings.model_fields
    assert settings.audio_max_input_bytes == 536870912
    assert settings.audio_max_duration_seconds == 3600
    assert settings.audio_max_output_bytes == 134217728
    assert settings.audio_probe_timeout_seconds == 10
    assert settings.audio_decode_timeout_seconds == 900
    assert str(settings.audio_temp_dir) == "/tmp"


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
        "AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS": "12.5",
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
    assert settings.http_shutdown_timeout_seconds == 12.5
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


def test_example_dotenv_loads_documented_defaults():
    env_file = Path(__file__).resolve().parents[2] / ".env.example"

    settings = load_settings(env_file=env_file)

    assert settings.service_name == "sme-meeting-ai"
    assert settings.service_identity == "ai-core"
    assert settings.internal_allowed_callers == ("core-api",)
    assert settings.audio_vad_frame_samples == 512
    assert type(settings.audio_vad_frame_samples) is int
    assert settings.audio_vad_model_path is None
    assert settings.audio_vad_model_sha256 is None
    assert settings.audio_asr_chunk_target_samples == 320000
    assert settings.audio_asr_chunk_max_request_samples == 480000
    assert settings.audio_asr_chunk_overlap_samples == 80000
    assert settings.audio_asr_chunk_boundary_search_samples == 80000
    assert settings.audio_asr_chunk_max_chunks == 4096
    assert settings.audio_asr_max_concurrent_chunks == 1


@pytest.mark.parametrize(
    ("key", "value", "field", "category"),
    [
        ("AI_HTTP_PORT", "0", "http_port", "greater_than_equal"),
        ("AI_HTTP_PORT", "65536", "http_port", "less_than_equal"),
        ("AI_HTTP_PORT", "invalid", "http_port", "int_parsing"),
        ("AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS", "0", "http_shutdown_timeout_seconds", "greater_than"),
        ("AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS", "301", "http_shutdown_timeout_seconds", "less_than_equal"),
        ("AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS", "private-value", "http_shutdown_timeout_seconds", "float_parsing"),
        ("AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS", "nan", "http_shutdown_timeout_seconds", "finite_number"),
        ("AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS", "inf", "http_shutdown_timeout_seconds", "finite_number"),
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


@pytest.mark.parametrize("timeout", [0.01, 300])
def test_http_shutdown_timeout_boundaries(timeout):
    settings = Settings(
        service_name="test-ai", service_identity="ai-core",
        http_shutdown_timeout_seconds=timeout, _env_file=None,
    )
    assert settings.http_shutdown_timeout_seconds == timeout


@pytest.mark.parametrize("present", [
    ("AI_TLS_CERT_FILE",), ("AI_TLS_KEY_FILE",), ("AI_TLS_CLIENT_CA_FILE",),
    ("AI_TLS_CERT_FILE", "AI_TLS_KEY_FILE"),
])
def test_partial_tls_configuration_is_rejected(monkeypatch, present):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    for field in present:
        monkeypatch.setenv(field, "/external/private-path")
    with pytest.raises(ConfigurationError) as caught:
        load_settings(env_file=None)
    assert "/external/private-path" not in str(caught.value)


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


@pytest.mark.parametrize("field,maximum", [
    ("audio_max_input_bytes", 2147483648),
    ("audio_max_output_bytes", 1073741824),
    ("audio_max_duration_seconds", 14400),
    ("audio_probe_timeout_seconds", 120),
    ("audio_decode_timeout_seconds", 3600),
])
@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf", "private-invalid", "over"])
def test_audio_limits_are_positive_finite_bounded(monkeypatch, field, maximum, value):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.setenv(f"AI_{field.upper()}", str(maximum + 1) if value == "over" else value)
    with pytest.raises(ConfigurationError) as caught:
        load_settings(env_file=None)
    assert field in str(caught.value)
    assert "private-invalid" not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None


def test_audio_environment_and_temp_directory_loading_is_lazy(monkeypatch, tmp_path):
    missing = tmp_path / "not-created"
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.setenv("AI_AUDIO_MAX_INPUT_BYTES", "1000")
    monkeypatch.setenv("AI_AUDIO_MAX_DURATION_SECONDS", "0.5")
    monkeypatch.setenv("AI_AUDIO_MAX_OUTPUT_BYTES", "2000")
    monkeypatch.setenv("AI_AUDIO_PROBE_TIMEOUT_SECONDS", "0.25")
    monkeypatch.setenv("AI_AUDIO_DECODE_TIMEOUT_SECONDS", "1.5")
    monkeypatch.setenv("AI_AUDIO_TEMP_DIR", str(missing))
    settings = load_settings(env_file=None)
    assert settings.audio_max_input_bytes == 1000
    assert settings.audio_max_duration_seconds == 0.5
    assert settings.audio_max_output_bytes == 2000
    assert settings.audio_probe_timeout_seconds == 0.25
    assert settings.audio_decode_timeout_seconds == 1.5
    assert settings.audio_temp_dir == missing
    assert not missing.exists()


def test_vad_defaults_and_lazy_model_configuration(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    defaults = load_settings(env_file=None)
    assert defaults.audio_vad_model_path is None
    assert defaults.audio_vad_model_id == "silero-vad"
    assert defaults.audio_vad_model_version == "5"
    assert defaults.audio_vad_model_sha256 is None
    assert defaults.audio_vad_frame_samples == 512
    assert defaults.audio_vad_speech_threshold == 0.60
    assert defaults.audio_vad_non_speech_threshold == 0.35
    assert defaults.audio_vad_max_concurrent_recordings == 1
    missing = tmp_path / "not-provisioned.onnx"
    monkeypatch.setenv("AI_AUDIO_VAD_MODEL_PATH", str(missing))
    monkeypatch.setenv("AI_AUDIO_VAD_MODEL_SHA256", "a" * 64)
    monkeypatch.setenv("AI_AUDIO_VAD_TIMEOUT_SECONDS", "12.5")
    settings = load_settings(env_file=None)
    assert settings.audio_vad_model_path == missing
    assert settings.audio_vad_model_sha256 == "a" * 64
    assert settings.audio_vad_timeout_seconds == 12.5
    assert not missing.exists()


@pytest.mark.parametrize("source", ["environment", "dotenv"])
def test_fixed_vad_frame_size_loads_from_text_configuration(monkeypatch, tmp_path, source):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    env_file = None
    if source == "environment":
        monkeypatch.setenv("AI_AUDIO_VAD_FRAME_SAMPLES", "512")
    else:
        env_file = tmp_path / ".env"
        env_file.write_text("AI_AUDIO_VAD_FRAME_SAMPLES=512\n")

    settings = load_settings(env_file=env_file)

    assert settings.audio_vad_frame_samples == 512
    assert type(settings.audio_vad_frame_samples) is int


@pytest.mark.parametrize("source", ["environment", "dotenv"])
@pytest.mark.parametrize("value", ["256", "1024", "512.0", "512.5", "true", "private-invalid"])
def test_unsupported_vad_frame_text_is_rejected_and_sanitized(monkeypatch, tmp_path, source, value):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    env_file = None
    if source == "environment":
        monkeypatch.setenv("AI_AUDIO_VAD_FRAME_SAMPLES", value)
    else:
        env_file = tmp_path / ".env"
        env_file.write_text(f"AI_AUDIO_VAD_FRAME_SAMPLES={value}\n")

    with pytest.raises(ConfigurationError) as caught:
        load_settings(env_file=env_file)

    assert str(caught.value) == "Invalid configuration: audio_vad_frame_samples: literal_error"
    assert value not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None


@pytest.mark.parametrize("field,maximum", [
    ("audio_vad_timeout_seconds", 3600),
    ("audio_vad_model_max_bytes", 268435456),
    ("audio_vad_max_concurrent_recordings", 16),
    ("audio_evidence_max_bytes", 1073741824),
])
@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf", "private-invalid", "over"])
def test_vad_resource_limits_are_finite_and_bounded(monkeypatch, field, maximum, value):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.setenv(f"AI_{field.upper()}", str(maximum + 1) if value == "over" else value)
    with pytest.raises(ConfigurationError) as caught:
        load_settings(env_file=None)
    assert field in str(caught.value)
    assert "private-invalid" not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None


@pytest.mark.parametrize("overrides", [
    {"audio_vad_frame_samples": 256},
    {"audio_vad_frame_samples": 1024},
    {"audio_vad_speech_threshold": float("nan")},
    {"audio_vad_non_speech_threshold": float("inf")},
    {"audio_vad_speech_threshold": 1.01},
    {"audio_vad_non_speech_threshold": -0.01},
    {"audio_vad_non_speech_threshold": 0.6},
    {"audio_vad_non_speech_threshold": 0.8},
    {"audio_vad_model_id": "private/path"},
    {"audio_vad_model_version": ""},
    {"audio_vad_model_sha256": "not-a-digest"},
])
def test_vad_contract_thresholds_and_identity_are_validated(overrides):
    with pytest.raises(ValueError):
        Settings(service_name="test-ai", service_identity="ai-core", _env_file=None, **overrides)


def test_speech_map_defaults_and_environment_overrides(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    defaults = load_settings(env_file=None)
    assert defaults.audio_speech_map_boundary_padding_samples == 1600
    assert defaults.audio_speech_map_merge_gap_samples == 512
    assert defaults.audio_speech_map_energy_floor_dbfs == -50

    monkeypatch.setenv("AI_AUDIO_SPEECH_MAP_BOUNDARY_PADDING_SAMPLES", "123")
    monkeypatch.setenv("AI_AUDIO_SPEECH_MAP_MERGE_GAP_SAMPLES", "456")
    monkeypatch.setenv("AI_AUDIO_SPEECH_MAP_ENERGY_FLOOR_DBFS", "-62.5")
    settings = load_settings(env_file=None)
    assert settings.audio_speech_map_boundary_padding_samples == 123
    assert settings.audio_speech_map_merge_gap_samples == 456
    assert settings.audio_speech_map_energy_floor_dbfs == -62.5


@pytest.mark.parametrize("field", [
    "audio_speech_map_boundary_padding_samples", "audio_speech_map_merge_gap_samples",
])
@pytest.mark.parametrize("value", [0, 230400000])
def test_speech_map_sample_setting_boundaries(field, value):
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        **{field: value},
    )
    assert getattr(settings, field) == value


@pytest.mark.parametrize("value", [-120, 0])
def test_speech_map_energy_floor_boundaries(value):
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        audio_speech_map_energy_floor_dbfs=value,
    )
    assert settings.audio_speech_map_energy_floor_dbfs == value


@pytest.mark.parametrize("field,values", [
    ("audio_speech_map_boundary_padding_samples", ["-1", "230400001", "0.5", "nan", "inf"]),
    ("audio_speech_map_merge_gap_samples", ["-1", "230400001", "0.5", "nan", "inf"]),
    ("audio_speech_map_energy_floor_dbfs", ["-120.01", "0.01", "nan", "inf", "-inf"]),
])
def test_speech_map_invalid_settings_are_sanitized(monkeypatch, field, values):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    for value in [*values, "private-invalid"]:
        monkeypatch.setenv(f"AI_{field.upper()}", value)
        with pytest.raises(ConfigurationError) as caught:
            load_settings(env_file=None)
        assert field in str(caught.value)
        assert "private-invalid" not in "".join(traceback.format_exception(caught.value))
        assert caught.value.__context__ is None


def test_asr_chunk_defaults_and_environment_overrides(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    defaults = load_settings(env_file=None)
    expected = {
        "audio_asr_chunk_target_samples": 320000,
        "audio_asr_chunk_max_request_samples": 480000,
        "audio_asr_chunk_overlap_samples": 80000,
        "audio_asr_chunk_boundary_search_samples": 80000,
        "audio_asr_chunk_max_chunks": 4096,
    }
    for field, value in expected.items():
        assert getattr(defaults, field) == value
    overrides = dict(zip(expected, (100, 150, 31, 20, 10), strict=True))
    for field, value in overrides.items():
        monkeypatch.setenv(f"AI_{field.upper()}", str(value))
    settings = load_settings(env_file=None)
    for field, value in overrides.items():
        assert getattr(settings, field) == value
        assert type(getattr(settings, field)) is int


@pytest.mark.parametrize("overrides", [
    {"audio_asr_chunk_target_samples": 1, "audio_asr_chunk_boundary_search_samples": 0,
     "audio_asr_chunk_overlap_samples": 0, "audio_asr_chunk_max_request_samples": 1,
     "audio_asr_chunk_max_chunks": 1},
    {"audio_asr_chunk_target_samples": 230400000,
     "audio_asr_chunk_max_request_samples": 230400000,
     "audio_asr_chunk_overlap_samples": 0,
     "audio_asr_chunk_boundary_search_samples": 230399999,
     "audio_asr_chunk_max_chunks": 65536},
    {"audio_asr_chunk_target_samples": 320000,
     "audio_asr_chunk_max_request_samples": 400000},
])
def test_asr_chunk_setting_boundaries(overrides):
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None, **overrides,
    )
    for field, value in overrides.items():
        assert getattr(settings, field) == value


@pytest.mark.parametrize("field,values", [
    ("audio_asr_chunk_target_samples", [0, -1, 230400001, True, 100.0, 1.5]),
    ("audio_asr_chunk_max_request_samples", [0, -1, 230400001, True, 480000.0, 1.5]),
    ("audio_asr_chunk_overlap_samples", [-1, 230400001, True, 80000.0, 1.5]),
    ("audio_asr_chunk_boundary_search_samples", [-1, 230400001, True, 80000.0, 1.5]),
    ("audio_asr_chunk_max_chunks", [0, -1, 65537, True, 4096.0, 1.5]),
])
def test_asr_chunk_direct_values_require_bounded_integers(field, values):
    for value in values:
        with pytest.raises(ValueError):
            Settings(
                service_name="test-ai", service_identity="ai-core", _env_file=None,
                **{field: value},
            )


@pytest.mark.parametrize("field", [
    "audio_asr_chunk_target_samples", "audio_asr_chunk_max_request_samples",
    "audio_asr_chunk_overlap_samples", "audio_asr_chunk_boundary_search_samples",
    "audio_asr_chunk_max_chunks",
])
@pytest.mark.parametrize("value", ["-1", "230400001", "1.5", "100.0", "nan", "inf", "true", "private-invalid"])
def test_asr_chunk_invalid_environment_values_are_sanitized(monkeypatch, field, value):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.setenv(f"AI_{field.upper()}", value)
    with pytest.raises(ConfigurationError) as caught:
        load_settings(env_file=None)
    assert field in str(caught.value)
    assert "private-invalid" not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None


@pytest.mark.parametrize("overrides", [
    {"audio_asr_chunk_max_request_samples": 399999},
    {"audio_asr_chunk_overlap_samples": 480000},
    {"audio_asr_chunk_boundary_search_samples": 320000},
    {"audio_asr_chunk_boundary_search_samples": 320001},
])
def test_asr_chunk_cross_field_contracts(overrides):
    with pytest.raises(ValueError):
        Settings(
            service_name="test-ai", service_identity="ai-core", _env_file=None, **overrides,
        )


def test_asr_provider_defaults():
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    assert settings.openrouter_api_key is None
    assert settings.audio_asr_model == "openai/whisper-large-v3"
    assert settings.audio_asr_language == "vi"
    assert settings.audio_asr_temperature == 0
    assert settings.audio_asr_max_payload_bytes == 26214400
    assert settings.audio_asr_timeout_seconds == 120
    assert settings.audio_asr_max_concurrent_chunks == 1


@pytest.mark.parametrize("source", ["environment", "dotenv"])
def test_asr_settings_alias_overrides_and_secret_redaction(monkeypatch, tmp_path, source):
    values = {
        "AI_SERVICE_NAME": "test-ai", "AI_SERVICE_IDENTITY": "ai-core",
        "OPENROUTER_API_KEY": "test-only-private-key",
        "AI_AUDIO_ASR_MODEL": "vendor/compatible-model",
        "AI_AUDIO_ASR_LANGUAGE": "en", "AI_AUDIO_ASR_TEMPERATURE": "0.2",
        "AI_AUDIO_ASR_MAX_PAYLOAD_BYTES": "4096", "AI_AUDIO_ASR_TIMEOUT_SECONDS": "2.5",
        "AI_AUDIO_ASR_MAX_CONCURRENT_CHUNKS": "4",
    }
    env_file = None
    if source == "environment":
        for key, value in values.items():
            monkeypatch.setenv(key, value)
    else:
        env_file = tmp_path / ".env"
        env_file.write_text("\n".join(f"{key}={value}" for key, value in values.items()))
    settings = load_settings(env_file)
    assert settings.openrouter_api_key.get_secret_value() == "test-only-private-key"
    assert "test-only-private-key" not in repr(settings)
    assert "test-only-private-key" not in settings.model_dump_json()
    assert settings.audio_asr_model == "vendor/compatible-model"
    assert settings.audio_asr_language == "en"
    assert settings.audio_asr_temperature == 0.2
    assert settings.audio_asr_max_payload_bytes == 4096
    assert settings.audio_asr_timeout_seconds == 2.5
    assert settings.audio_asr_max_concurrent_chunks == 4


@pytest.mark.parametrize("field,values", [
    ("audio_asr_model", ["", "private invalid", "x" * 257]),
    ("audio_asr_language", ["", "private invalid", "x" * 17]),
    ("audio_asr_temperature", ["nan", "inf", "-0.1", "1.1"]),
    ("audio_asr_timeout_seconds", ["0", "-1", "nan", "inf", "601"]),
    ("audio_asr_max_payload_bytes", ["0", "-1", "nan", "inf", "26214401", "1.5"]),
    ("audio_asr_max_concurrent_chunks", ["0", "-1", "5", "nan", "inf", "1.5", "1.0", "true"]),
])
def test_asr_provider_invalid_settings_are_sanitized(monkeypatch, field, values):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-only-private-key")
    for value in [*values, "private invalid value"]:
        monkeypatch.setenv(f"AI_{field.upper()}", value)
        with pytest.raises(ConfigurationError) as caught:
            load_settings(None)
        assert field in str(caught.value)
        rendered = "".join(traceback.format_exception(caught.value))
        assert "private invalid value" not in rendered
        assert "test-only-private-key" not in rendered
        assert caught.value.__context__ is None


@pytest.mark.parametrize("temperature,timeout,payload", [(0, 0.01, 1), (1, 600, 26214400)])
def test_asr_provider_setting_boundaries(temperature, timeout, payload):
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        audio_asr_temperature=temperature, audio_asr_timeout_seconds=timeout,
        audio_asr_max_payload_bytes=payload,
    )
    assert settings.audio_asr_temperature == temperature
    assert settings.audio_asr_timeout_seconds == timeout
    assert settings.audio_asr_max_payload_bytes == payload


@pytest.mark.parametrize("value", [1, 4])
def test_asr_concurrency_boundaries(value):
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        audio_asr_max_concurrent_chunks=value,
    )
    assert settings.audio_asr_max_concurrent_chunks == value


@pytest.mark.parametrize("value", [True, False, 1.0, 1.5, 0, -1, 5])
def test_asr_concurrency_requires_a_strict_bounded_integer(value):
    with pytest.raises(ValueError):
        Settings(
            service_name="test-ai", service_identity="ai-core", _env_file=None,
            audio_asr_max_concurrent_chunks=value,
        )


def test_coverage_defaults_match_documented_configuration():
    defaults = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    documented = load_settings(Path(__file__).resolve().parents[2] / ".env.example")
    for value in (defaults, documented):
        assert value.audio_asr_coverage_max_tolerated_speech_map_gap_samples == 0
        assert value.audio_asr_coverage_repetition_min_chars == 16
        assert value.audio_asr_coverage_low_confidence_threshold == 0.35


@pytest.mark.parametrize("source", ["environment", "dotenv"])
def test_coverage_configuration_overrides(monkeypatch, tmp_path, source):
    values = {
        "AI_SERVICE_NAME": "test-ai", "AI_SERVICE_IDENTITY": "ai-core",
        "AI_AUDIO_ASR_COVERAGE_MAX_TOLERATED_SPEECH_MAP_GAP_SAMPLES": "512",
        "AI_AUDIO_ASR_COVERAGE_REPETITION_MIN_CHARS": "24",
        "AI_AUDIO_ASR_COVERAGE_LOW_CONFIDENCE_THRESHOLD": "0.25",
    }
    env_file = None
    if source == "environment":
        for key, value in values.items():
            monkeypatch.setenv(key, value)
    else:
        env_file = tmp_path / ".env"
        env_file.write_text("\n".join(f"{k}={v}" for k, v in values.items()))
    loaded = load_settings(env_file)
    assert loaded.audio_asr_coverage_max_tolerated_speech_map_gap_samples == 512
    assert type(loaded.audio_asr_coverage_max_tolerated_speech_map_gap_samples) is int
    assert loaded.audio_asr_coverage_repetition_min_chars == 24
    assert loaded.audio_asr_coverage_low_confidence_threshold == 0.25


@pytest.mark.parametrize("field,values", [
    ("audio_asr_coverage_max_tolerated_speech_map_gap_samples", [-1, 230400001, True, 1.0, 1.5]),
    ("audio_asr_coverage_repetition_min_chars", [0, -1, 65537, True, 16.0, 1.5]),
    ("audio_asr_coverage_low_confidence_threshold", [-0.01, 1.01, float("nan"), float("inf")]),
])
def test_coverage_settings_are_bounded_and_strict(field, values):
    for value in values:
        with pytest.raises(ValueError):
            Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                     **{field: value})


@pytest.mark.parametrize("gap,repetition,confidence", [(0, 1, 0), (230400000, 65536, 1)])
def test_coverage_configuration_boundaries(gap, repetition, confidence):
    loaded = Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        audio_asr_coverage_max_tolerated_speech_map_gap_samples=gap,
        audio_asr_coverage_repetition_min_chars=repetition,
        audio_asr_coverage_low_confidence_threshold=confidence,
    )
    assert loaded.audio_asr_coverage_max_tolerated_speech_map_gap_samples == gap
    assert loaded.audio_asr_coverage_repetition_min_chars == repetition
    assert loaded.audio_asr_coverage_low_confidence_threshold == confidence


@pytest.mark.parametrize("field,values", [
    ("audio_asr_coverage_max_tolerated_speech_map_gap_samples", ["-1", "230400001", "1.0", "true"]),
    ("audio_asr_coverage_repetition_min_chars", ["0", "65537", "16.0", "true"]),
    ("audio_asr_coverage_low_confidence_threshold", ["-0.01", "1.01", "nan", "inf"]),
])
def test_invalid_coverage_environment_is_sanitized(monkeypatch, field, values):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    for value in [*values, "private-invalid"]:
        monkeypatch.setenv(f"AI_{field.upper()}", value)
        with pytest.raises(ConfigurationError) as caught:
            load_settings(None)
        assert field in str(caught.value)
        assert "private-invalid" not in "".join(traceback.format_exception(caught.value))
        assert caught.value.__context__ is None


def test_reconciliation_defaults_match_documented_configuration():
    defaults = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    documented = load_settings(Path(__file__).resolve().parents[2] / ".env.example")
    assert defaults.audio_asr_reconciliation_min_shared_tokens == 2
    assert documented.audio_asr_reconciliation_min_shared_tokens == 2


@pytest.mark.parametrize("source", ["environment", "dotenv"])
def test_reconciliation_configuration_overrides(monkeypatch, tmp_path, source):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    env_file = None
    if source == "environment":
        monkeypatch.setenv("AI_AUDIO_ASR_RECONCILIATION_MIN_SHARED_TOKENS", "5")
    else:
        env_file = tmp_path / ".env"
        env_file.write_text("AI_AUDIO_ASR_RECONCILIATION_MIN_SHARED_TOKENS=5\n")
    assert load_settings(env_file).audio_asr_reconciliation_min_shared_tokens == 5


@pytest.mark.parametrize("value", [2, 64])
def test_reconciliation_configuration_boundaries(value):
    loaded = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                      audio_asr_reconciliation_min_shared_tokens=value)
    assert loaded.audio_asr_reconciliation_min_shared_tokens == value


@pytest.mark.parametrize("value", [True, False, 2.0, 2.5, 1, 65])
def test_reconciliation_configuration_requires_strict_bounded_integer(value):
    with pytest.raises(ValueError):
        Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                 audio_asr_reconciliation_min_shared_tokens=value)


@pytest.mark.parametrize("value", ["1", "65", "2.0", "true", "nan", "private-invalid"])
def test_invalid_reconciliation_configuration_is_sanitized(monkeypatch, value):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.setenv("AI_AUDIO_ASR_RECONCILIATION_MIN_SHARED_TOKENS", value)
    with pytest.raises(ConfigurationError) as caught:
        load_settings(None)
    assert "audio_asr_reconciliation_min_shared_tokens" in str(caught.value)
    assert "private-invalid" not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None


def test_recovery_defaults_match_documented_configuration():
    expected = {
        "audio_asr_recovery_context_samples": 16000,
        "audio_asr_recovery_max_attempts_per_region": 3,
        "audio_asr_recovery_max_request_samples_per_region": 1440000,
        "audio_asr_recovery_max_total_attempts": 16,
        "audio_asr_recovery_max_total_request_samples": 2400000,
        "audio_asr_recovery_max_wall_time_seconds": 300,
    }
    for configuration in (Settings(service_name="test-ai", service_identity="ai-core", _env_file=None),
                          load_settings(Path(__file__).resolve().parents[2] / ".env.example")):
        for field, value in expected.items():
            assert getattr(configuration, field) == value


@pytest.mark.parametrize("field", [
    "audio_asr_recovery_context_samples", "audio_asr_recovery_max_attempts_per_region",
    "audio_asr_recovery_max_request_samples_per_region", "audio_asr_recovery_max_total_attempts",
    "audio_asr_recovery_max_total_request_samples",
])
@pytest.mark.parametrize("value", [0, -1, True, 1.0, 1.5, 230400001])
def test_recovery_counts_are_strict_positive_and_bounded(field, value):
    with pytest.raises(ValueError):
        Settings(service_name="test-ai", service_identity="ai-core", _env_file=None, **{field: value})


@pytest.mark.parametrize("value", [0, -1, True, float("nan"), float("inf"), 3601])
def test_recovery_wall_time_is_positive_finite_bounded(value):
    with pytest.raises(ValueError):
        Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                 audio_asr_recovery_max_wall_time_seconds=value)


def test_recovery_environment_accepts_integer_text_and_sanitizes_invalid_input(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.setenv("AI_AUDIO_ASR_RECOVERY_MAX_TOTAL_ATTEMPTS", "4")
    assert load_settings(None).audio_asr_recovery_max_total_attempts == 4
    monkeypatch.setenv("AI_AUDIO_ASR_RECOVERY_MAX_TOTAL_ATTEMPTS", "private-invalid")
    with pytest.raises(ConfigurationError) as caught:
        load_settings(None)
    assert "private-invalid" not in "".join(traceback.format_exception(caught.value))
