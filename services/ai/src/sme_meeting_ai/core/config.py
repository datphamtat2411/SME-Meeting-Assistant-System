"""Typed configuration without runtime or infrastructure initialization."""

from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import Field, ValidationError, model_validator
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
    worker_concurrency: int = Field(default=1, gt=0)
    worker_shutdown_timeout_seconds: float = Field(
        default=30, gt=0, le=300, allow_inf_nan=False,
    )
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
