"""Typed configuration without runtime or infrastructure initialization."""

import re
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal, Self
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict, SettingsError

SERVICE_IDENTITY_PATTERN = r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
ServiceIdentity = Annotated[str, Field(pattern=SERVICE_IDENTITY_PATTERN, max_length=63)]


class Environment(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    STAGING = "staging"
    PRODUCTION = "production"


class ConfigurationError(Exception):
    """Configuration failure containing only field locations and categories."""


class Settings(BaseSettings):
    """Settings shared by future HTTP and worker runtimes."""

    model_config = SettingsConfigDict(
        env_prefix="AI_",
        case_sensitive=False,
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
    )

    service_name: str
    service_identity: ServiceIdentity
    internal_allowed_callers: tuple[Literal["core-api"], ...] = ("core-api",)
    environment: Environment = Environment.DEVELOPMENT
    debug: bool = False
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    http_host: str = "127.0.0.1"
    http_port: int = Field(default=8000, ge=1, le=65535)
    http_shutdown_timeout_seconds: float = Field(
        default=30, gt=0, le=300, allow_inf_nan=False,
    )
    tls_cert_file: Path | None = None
    tls_key_file: Path | None = None
    tls_client_ca_file: Path | None = None
    worker_concurrency: int = Field(default=1, gt=0, le=64)
    worker_shutdown_timeout_seconds: float = Field(
        default=30, gt=0, le=300, allow_inf_nan=False,
    )
    worker_execution_timeout_seconds: float = Field(default=14400, gt=0, le=86400, allow_inf_nan=False)
    rabbitmq_url: str | None = Field(default=None, repr=False)
    rabbitmq_username: SecretStr | None = Field(default=None, repr=False)
    rabbitmq_password: SecretStr | None = Field(default=None, repr=False)
    rabbitmq_ca_file: Path | None = None
    rabbitmq_exchange: Literal["meeting.processing"] = "meeting.processing"
    rabbitmq_routing_key: Literal["processing.job.queued"] = "processing.job.queued"
    rabbitmq_queue: Literal["meeting.processing.jobs"] = "meeting.processing.jobs"
    rabbitmq_delivery_limit: Literal[5] = 5
    rabbitmq_connect_timeout_seconds: float = Field(default=10, gt=0, le=30, allow_inf_nan=False)
    s3_endpoint_url: str | None = Field(default=None, repr=False)
    s3_storage_id: str = Field(default="private", pattern=r"^[A-Za-z0-9_-]{1,64}$")
    s3_region: str = Field(default="us-east-1", pattern=r"^[A-Za-z0-9_-]{1,80}$")
    s3_bucket: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
    s3_access_key_id: SecretStr | None = Field(default=None, repr=False)
    s3_secret_access_key: SecretStr | None = Field(default=None, repr=False)
    s3_ca_file: Path | None = None
    s3_path_style: bool = True
    s3_connect_timeout_seconds: float = Field(default=3, gt=0, le=3, allow_inf_nan=False)
    s3_read_timeout_seconds: float = Field(default=15, gt=0, le=30, allow_inf_nan=False)
    s3_download_timeout_seconds: float = Field(default=300, gt=0, le=900, allow_inf_nan=False)
    core_api_base_url: str | None = Field(default=None, repr=False)
    core_api_server_ca_file: Path | None = None
    core_api_client_cert_file: Path | None = None
    core_api_client_key_file: Path | None = Field(default=None, repr=False)
    core_api_connect_timeout_seconds: float = Field(default=3, gt=0, le=3, allow_inf_nan=False)
    core_api_timeout_seconds: float = Field(default=15, gt=0, le=15, allow_inf_nan=False)
    core_api_max_attempts: int = Field(default=3, ge=1, le=3, strict=True)
    audio_max_input_bytes: int = Field(default=536870912, gt=0, le=2147483648)
    audio_max_duration_seconds: float = Field(
        default=3600, gt=0, le=14400, allow_inf_nan=False,
    )
    audio_max_output_bytes: int = Field(default=134217728, gt=0, le=1073741824)
    audio_probe_timeout_seconds: float = Field(
        default=10, gt=0, le=120, allow_inf_nan=False,
    )
    audio_decode_timeout_seconds: float = Field(
        default=900, gt=0, le=3600, allow_inf_nan=False,
    )
    audio_temp_dir: Path = Path("/tmp")
    audio_vad_model_path: Path | None = None
    audio_vad_model_id: str = Field(
        default="silero-vad", min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_.-]+$",
    )
    audio_vad_model_version: str = Field(
        default="5", min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_.-]+$",
    )
    audio_vad_model_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    audio_vad_frame_samples: Literal[512] = 512
    audio_vad_speech_threshold: float = Field(
        default=0.60, ge=0, le=1, allow_inf_nan=False,
    )
    audio_vad_non_speech_threshold: float = Field(
        default=0.35, ge=0, le=1, allow_inf_nan=False,
    )
    audio_vad_timeout_seconds: float = Field(
        default=900, gt=0, le=3600, allow_inf_nan=False,
    )
    audio_vad_model_max_bytes: int = Field(default=16777216, gt=0, le=268435456)
    audio_vad_max_concurrent_recordings: int = Field(default=1, gt=0, le=16)
    audio_evidence_max_bytes: int = Field(default=16777216, gt=0, le=1073741824)
    # Sample limits match the maximum supported four-hour normalized timeline.
    audio_speech_map_boundary_padding_samples: int = Field(default=1600, ge=0, le=230400000)
    audio_speech_map_merge_gap_samples: int = Field(default=512, ge=0, le=230400000)
    audio_speech_map_energy_floor_dbfs: float = Field(
        default=-50, ge=-120, le=0, allow_inf_nan=False,
    )
    # Absolute integer counts on the normalized 16 kHz timeline.
    audio_asr_chunk_target_samples: int = Field(
        default=320000, gt=0, le=230400000, strict=True,
    )
    audio_asr_chunk_max_request_samples: int = Field(
        default=480000, gt=0, le=230400000, strict=True,
    )
    audio_asr_chunk_overlap_samples: int = Field(
        default=80000, ge=0, le=230400000, strict=True,
    )
    audio_asr_chunk_boundary_search_samples: int = Field(
        default=80000, ge=0, le=230400000, strict=True,
    )
    audio_asr_chunk_max_chunks: int = Field(default=4096, gt=0, le=65536, strict=True)
    openrouter_api_key: SecretStr | None = Field(
        default=None, validation_alias="OPENROUTER_API_KEY", repr=False,
    )
    audio_asr_model: str = Field(
        default="openai/whisper-large-v3", min_length=1, max_length=256,
        pattern=r"^[a-zA-Z0-9_./:-]+$",
    )
    audio_asr_language: str = Field(
        default="vi", min_length=1, max_length=16, pattern=r"^[a-zA-Z-]+$",
    )
    audio_asr_temperature: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    audio_asr_max_payload_bytes: int = Field(default=26214400, gt=0, le=26214400)
    audio_asr_max_concurrent_chunks: int = Field(default=1, gt=0, le=4, strict=True)
    audio_asr_timeout_seconds: float = Field(
        default=120, gt=0, le=600, allow_inf_nan=False,
    )
    audio_asr_coverage_max_tolerated_speech_map_gap_samples: int = Field(
        default=0, ge=0, le=230400000, strict=True,
    )
    audio_asr_coverage_repetition_min_chars: int = Field(
        default=16, ge=1, le=65536, strict=True,
    )
    audio_asr_coverage_low_confidence_threshold: float = Field(
        default=0.35, ge=0, le=1, allow_inf_nan=False,
    )
    audio_asr_reconciliation_min_shared_tokens: int = Field(
        default=2, ge=2, le=64, strict=True,
    )
    audio_asr_recovery_context_samples: int = Field(
        default=16000, gt=0, le=230400000, strict=True,
    )
    audio_asr_recovery_max_attempts_per_region: int = Field(
        default=3, gt=0, le=64, strict=True,
    )
    audio_asr_recovery_max_request_samples_per_region: int = Field(
        default=1440000, gt=0, le=230400000, strict=True,
    )
    audio_asr_recovery_max_total_attempts: int = Field(
        default=16, gt=0, le=256, strict=True,
    )
    audio_asr_recovery_max_total_request_samples: int = Field(
        default=2400000, gt=0, le=230400000, strict=True,
    )
    audio_asr_recovery_max_wall_time_seconds: float = Field(
        default=300, gt=0, le=3600, allow_inf_nan=False,
    )
    transcript_correction_model: str | None = Field(
        default=None, min_length=1, max_length=256, pattern=r"^[a-zA-Z0-9_./:-]+$",
    )
    transcript_correction_timeout_seconds: float = Field(
        default=120, gt=0, le=600, allow_inf_nan=False,
    )
    transcript_correction_context_window_tokens: int = Field(
        default=131072, gt=0, le=2000000, strict=True,
    )
    transcript_correction_max_input_tokens: int = Field(
        default=98304, gt=0, le=2000000, strict=True,
    )
    transcript_correction_max_output_tokens: int = Field(
        default=32768, gt=0, le=131072, strict=True,
    )
    transcript_correction_max_response_bytes: int = Field(
        default=4194304, gt=0, le=16777216, strict=True,
    )
    transcript_correction_max_attempts: int = Field(default=2, gt=0, le=3, strict=True)
    transcript_correction_temperature: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    transcript_correction_min_text_ratio: float = Field(default=0.65, gt=0, le=1, allow_inf_nan=False)
    transcript_correction_max_text_ratio: float = Field(default=1.5, ge=1, le=3, allow_inf_nan=False)

    @field_validator("rabbitmq_url", "s3_endpoint_url", "core_api_base_url")
    @classmethod
    def private_endpoint(cls, value: str | None, info) -> str | None:
        if value is None:
            return None
        parts = urlsplit(value)
        scheme = "amqps" if info.field_name == "rabbitmq_url" else "https"
        if (parts.scheme != scheme or not parts.hostname or parts.username or parts.password
                or parts.query or parts.fragment or any(ord(c) <= 32 for c in value)
                or (scheme == "https" and parts.path not in ("", "/"))):
            raise ValueError("Invalid private endpoint")
        # Validate port eagerly; endpoints are the deployment allowlist, never wire data.
        _ = parts.port
        return value.rstrip("/") if scheme == "https" else value

    @field_validator("rabbitmq_delivery_limit", "core_api_max_attempts", mode="before")
    @classmethod
    def parse_worker_integers(cls, value: object) -> object:
        return cls.parse_asr_chunk_integers(value)

    @model_validator(mode="after")
    def complete_outbound_tls(self) -> Self:
        material = (self.core_api_server_ca_file, self.core_api_client_cert_file,
                    self.core_api_client_key_file)
        if any(p is not None for p in material) and not all(p is not None for p in material):
            raise ValueError("Outbound mTLS requires all three files")
        if self.core_api_client_key_file is not None and self.core_api_client_key_file == self.tls_key_file:
            raise ValueError("Worker client credentials must be distinct")
        return self

    @field_validator(
        "audio_asr_chunk_target_samples", "audio_asr_chunk_max_request_samples",
        "audio_asr_chunk_overlap_samples", "audio_asr_chunk_boundary_search_samples",
        "audio_asr_chunk_max_chunks", "audio_asr_max_concurrent_chunks",
        "audio_asr_coverage_max_tolerated_speech_map_gap_samples",
        "audio_asr_coverage_repetition_min_chars",
        "audio_asr_recovery_context_samples", "audio_asr_recovery_max_attempts_per_region",
        "audio_asr_recovery_max_request_samples_per_region",
        "audio_asr_recovery_max_total_attempts", "audio_asr_recovery_max_total_request_samples",
        "audio_asr_reconciliation_min_shared_tokens", mode="before",
    )
    @classmethod
    def parse_asr_chunk_integers(cls, value: object) -> object:
        # Accept integer environment/dotenv text without rounding floats or bools.
        if isinstance(value, str) and re.fullmatch(r"[+-]?[0-9]+", value):
            return int(value)
        return value

    @field_validator(
        "transcript_correction_context_window_tokens", "transcript_correction_max_input_tokens",
        "transcript_correction_max_output_tokens", "transcript_correction_max_response_bytes",
        "transcript_correction_max_attempts", mode="before",
    )
    @classmethod
    def parse_correction_integers(cls, value: object) -> object:
        return cls.parse_asr_chunk_integers(value)

    @field_validator(
        "transcript_correction_timeout_seconds", "transcript_correction_temperature",
        "transcript_correction_min_text_ratio", "transcript_correction_max_text_ratio",
        mode="before",
    )
    @classmethod
    def reject_boolean_correction_numbers(cls, value: object) -> object:
        if isinstance(value, bool):
            raise ValueError("Correction settings must be numeric")
        return value

    @model_validator(mode="after")
    def valid_correction_context(self) -> Self:
        if (self.transcript_correction_max_input_tokens + self.transcript_correction_max_output_tokens
                > self.transcript_correction_context_window_tokens):
            raise ValueError("Correction input and output allowances must fit the context window")
        return self

    @field_validator("audio_asr_recovery_max_wall_time_seconds", mode="before")
    @classmethod
    def reject_boolean_recovery_time(cls, value: object) -> object:
        if isinstance(value, bool):
            raise ValueError("Recovery wall time must be numeric")
        return value

    @model_validator(mode="after")
    def valid_asr_chunk_geometry(self) -> Self:
        if self.audio_asr_chunk_overlap_samples >= self.audio_asr_chunk_max_request_samples:
            raise ValueError("ASR overlap must be below maximum request size")
        if (
            self.audio_asr_chunk_target_samples + self.audio_asr_chunk_overlap_samples
            > self.audio_asr_chunk_max_request_samples
        ):
            raise ValueError("ASR target and overlap must fit the maximum request size")
        if self.audio_asr_chunk_boundary_search_samples >= self.audio_asr_chunk_target_samples:
            raise ValueError("ASR boundary search must be below the target core size")
        return self

    @field_validator("audio_vad_frame_samples", mode="before")
    @classmethod
    def parse_vad_frame_samples(cls, value: object) -> object:
        # Environment/dotenv values are text; retain the fixed Silero contract.
        return 512 if isinstance(value, str) and value == "512" else value

    @model_validator(mode="after")
    def ordered_vad_probability_bands(self) -> Self:
        if self.audio_vad_non_speech_threshold >= self.audio_vad_speech_threshold:
            raise ValueError("VAD non-speech threshold must be below speech threshold")
        return self

    @model_validator(mode="after")
    def complete_tls_configuration(self) -> Self:
        paths = (self.tls_cert_file, self.tls_key_file, self.tls_client_ca_file)
        if any(path is not None for path in paths) and any(path is None for path in paths):
            raise ValueError("TLS requires server certificate, key and client CA")
        return self

    @model_validator(mode="after")
    def distinct_service_identity(self) -> Self:
        if self.service_identity in self.internal_allowed_callers:
            raise ValueError("Service identity must be distinct from callers")
        return self


def load_settings(env_file: str | Path | None = ".env") -> Settings:
    """Load and validate settings, discarding input-bearing validation errors."""
    try:
        return Settings(_env_file=env_file)
    except ValidationError as error:
        details = "; ".join(
            f"{'.'.join(str(part) for part in item['loc'])}: {item['type']}"
            for item in error.errors(include_input=False, include_context=False)
        )
    except SettingsError:
        details = "settings: invalid_encoding"

    # Raise outside the handler so even exception context cannot leak raw inputs.
    raise ConfigurationError(f"Invalid configuration: {details}")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Lazily load a shared runtime snapshot; clear the cache to reload it."""
    return load_settings()
