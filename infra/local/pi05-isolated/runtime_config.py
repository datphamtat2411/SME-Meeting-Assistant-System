#!/usr/bin/env python3
"""Load reviewed, run-owned PI-05 process and harness configuration.

The loader intentionally reads only private files below one UUID-scoped run
directory.  It never consults the caller environment or a repository ``.env``
file.  Secrets are retained only in the returned in-memory mappings and are
never included in diagnostics.
"""

from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID


class RuntimeConfigError(RuntimeError):
    """Run configuration is missing, unsafe, or inconsistent."""


_KEY = re.compile(r"[A-Z][A-Z0-9_]*\Z")
_VALUE = re.compile(r"[A-Za-z0-9_./:@%+,=?-]*\Z")
_RUN_ID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z"
)
_LOOPBACK = "127.0.0.1"
_RABBIT_TLS_NAME = "rabbitmq.internal"
_STORAGE_TLS_NAME = "storage.internal"
_URL_SCHEMES = {
    "PI05_CORE_BASE_URL": "https",
    "PI05_AI_BASE_URL": "https",
    "PI05_STORAGE_ENDPOINT_URL": "https",
    "PI05_RABBIT_URL": "amqps",
}
_APPLICATION_URLS = {
    "APP_MEDIA_STORAGE_ENDPOINT": ("https", _STORAGE_TLS_NAME),
    "AI_RABBITMQ_URL": ("amqps", _RABBIT_TLS_NAME),
    "AI_S3_ENDPOINT_URL": ("https", _STORAGE_TLS_NAME),
}
_PATH_KEYS = frozenset({
    "PI05_CORE_CA_FILE", "PI05_CORE_CERT_FILE", "PI05_CORE_KEY_FILE",
    "PI05_CORE_OBSERVER_CERT_FILE", "PI05_CORE_OBSERVER_KEY_FILE",
    "PI05_AI_CA_FILE", "PI05_AI_CERT_FILE", "PI05_AI_KEY_FILE",
    "PI05_STORAGE_CA_FILE", "PI05_MEDIA_FILE", "PI05_QDRANT_CA_FILE",
    "AI_TLS_CERT_FILE", "AI_TLS_KEY_FILE", "AI_TLS_CLIENT_CA_FILE",
    "AI_CORE_API_SERVER_CA_FILE", "AI_CORE_API_CLIENT_CERT_FILE",
    "AI_CORE_API_CLIENT_KEY_FILE", "AI_RABBITMQ_CA_FILE", "AI_S3_CA_FILE",
    "AI_RAG_QDRANT_CA_FILE", "AI_RAG_MODEL_PATH",
    "AI_RAG_RERANKER_MODEL_PATH",
    "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE",
    "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE",
    "PI05_SCENARIO_FIXTURES_FILE",
})

# These are the actual environment prefixes consumed by application.properties
# and sme_meeting_ai.core.config.Settings.  The allowlists are deliberately
# prefix based because the Core properties file has a large set of independently
# gated knobs; the required sets below still prevent a partial runtime from
# being activated.
_PROCESS_PREFIXES = {
    "core": (
        "APP_", "DB_", "RABBITMQ_", "SPRING_", "SERVER_", "MANAGEMENT_", "JAVA_",
        "PI05_RUN_",
    ),
    "ai-http": (
        "AI_", "OPENROUTER_API_KEY", "REPLICATE_API_TOKEN", "SSL_CERT_FILE",
        "PI05_RUN_",
    ),
    "worker": (
        "AI_", "OPENROUTER_API_KEY", "REPLICATE_API_TOKEN", "SSL_CERT_FILE",
        "PI05_RUN_",
    ),
}
_HARNESS_KEYS = frozenset({
    "PI05_RUN_ID", "PI05_RUN_ROOT",
    "PI05_CORE_BASE_URL", "PI05_CORE_CA_FILE", "PI05_CORE_CERT_FILE",
    "PI05_CORE_KEY_FILE", "PI05_CORE_OBSERVER_CERT_FILE",
    "PI05_CORE_OBSERVER_KEY_FILE", "PI05_CORE_LEAF_SHA256",
    "PI05_CORE_CONNECT_HOST", "PI05_CORE_TLS_SERVER_NAME",
    "PI05_AI_BASE_URL", "PI05_AI_CA_FILE", "PI05_AI_CERT_FILE",
    "PI05_AI_KEY_FILE", "PI05_AI_LEAF_SHA256",
    "PI05_ACTION_EMAIL", "PI05_ACTION_PASSWORD",
    "PI05_OBSERVER_EMAIL", "PI05_OBSERVER_PASSWORD",
    "PI05_REVOKED_MEMBER_EMAIL", "PI05_REVOKED_MEMBER_PASSWORD",
    "PI05_STORAGE_ENDPOINT_URL", "PI05_STORAGE_BUCKET",
    "PI05_STORAGE_ACCESS_KEY", "PI05_STORAGE_SECRET_KEY",
    "PI05_STORAGE_CA_FILE", "PI05_STORAGE_LEAF_SHA256",
    "PI05_STORAGE_TLS_SERVER_NAME", "PI05_STORAGE_HOST_HEADER",
    "PI05_STORAGE_OBJECT_PREFIX",
    "PI05_RABBIT_URL", "PI05_RABBIT_CA_FILE", "PI05_RABBIT_USERNAME",
    "PI05_RABBIT_PASSWORD", "PI05_RABBIT_LEAF_SHA256",
    "PI05_RABBIT_TLS_SERVER_NAME", "PI05_RABBIT_QUEUE",
    "PI05_QDRANT_CA_FILE", "PI05_QDRANT_API_KEY",
    "PI05_MEDIA_FILE", "PI05_SCENARIO_TIMEOUT_SECONDS",
    "PI05_ENVIRONMENT_KIND", "PI05_HARNESS_URL", "PI05_SOURCE_COMMIT",
    "PI05_GENERATION_ID", "PI05_COLLECTION_NAME", "PI05_EVIDENCE_DIR",
    "PI05_PROOF_DIR",
    "PI05_POLL_INTERVAL_SECONDS", "PI05_RABBIT_MINIMUM_MESSAGE_COUNT",
    "PI05_SCENARIO_FIXTURES_FILE",
})

_CORE_REQUIRED = frozenset({
    "DB_URL", "DB_USERNAME", "DB_PASSWORD",
    "RABBITMQ_HOST", "RABBITMQ_PORT", "RABBITMQ_VIRTUAL_HOST",
    "RABBITMQ_CA_FILE", "RABBITMQ_USERNAME", "RABBITMQ_PASSWORD",
    "RABBITMQ_CONNECT_HOST", "RABBITMQ_TLS_SERVER_NAME",
    "APP_MEDIA_STORAGE_ENDPOINT", "APP_MEDIA_STORAGE_BUCKET",
    "APP_MEDIA_STORAGE_ACCESS_KEY", "APP_MEDIA_STORAGE_SECRET_KEY",
    "APP_MEDIA_STORAGE_CA_FILE", "APP_MEDIA_STORAGE_CONNECT_HOST",
    "APP_MEDIA_STORAGE_TLS_SERVER_NAME",
    "APP_TRANSPORT_PRIVATE_ENABLED", "APP_TRANSPORT_AI_ENABLED",
    "APP_AUTH_TRANSPORT_ENABLED", "APP_MEDIA_OUTBOX_ENABLED",
    "APP_WORKER_TRANSCRIPTION_ENABLED", "APP_MEDIA_INTELLIGENCE_ENABLED",
    "APP_MEDIA_INTELLIGENCE_DISPATCH_ENABLED",
    "APP_MEDIA_KNOWLEDGE_INDEXING_ENABLED", "APP_ASSISTANT_ENABLED",
})
_AI_COMMON_REQUIRED = frozenset({
    "AI_SERVICE_NAME", "AI_SERVICE_IDENTITY", "AI_ENVIRONMENT",
})
_AI_TRANSPORT_REQUIRED = frozenset({
    "AI_CORE_API_BASE_URL", "AI_CORE_API_SERVER_CA_FILE",
    "AI_CORE_API_CLIENT_CERT_FILE", "AI_CORE_API_CLIENT_KEY_FILE",
    "AI_CORE_API_CONNECT_HOST", "AI_CORE_API_TLS_SERVER_NAME",
    "AI_RABBITMQ_URL", "AI_RABBITMQ_USERNAME", "AI_RABBITMQ_PASSWORD",
    "AI_RABBITMQ_CA_FILE", "AI_RABBITMQ_CONNECT_HOST",
    "AI_RABBITMQ_TLS_SERVER_NAME",
})
_AI_STORAGE_REQUIRED = frozenset({
    "AI_S3_ENDPOINT_URL", "AI_S3_BUCKET", "AI_S3_ACCESS_KEY_ID",
    "AI_S3_SECRET_ACCESS_KEY", "AI_S3_CA_FILE", "AI_S3_CONNECT_HOST",
    "AI_S3_TLS_SERVER_NAME",
})
_AI_HTTP_REQUIRED = _AI_COMMON_REQUIRED | frozenset({
    "AI_TLS_CERT_FILE", "AI_TLS_KEY_FILE", "AI_TLS_CLIENT_CA_FILE",
})
_WORKER_REQUIRED = _AI_COMMON_REQUIRED | _AI_TRANSPORT_REQUIRED | frozenset({
    "AI_WORKER_ROLE",
})
_TRANSCRIPTION_WORKER_REQUIRED = _WORKER_REQUIRED | _AI_STORAGE_REQUIRED
_KNOWLEDGE_WORKER_REQUIRED = _WORKER_REQUIRED | frozenset({
    "AI_RAG_INDEX_GENERATION_ID", "AI_RAG_QDRANT_URL",
    "AI_RAG_QDRANT_CA_FILE", "AI_RAG_QDRANT_API_KEY",
    "AI_RAG_QDRANT_COLLECTION", "AI_RAG_MODEL_PATH",
    "AI_RAG_RERANKER_MODEL_PATH",
})
_MI_WORKER_REQUIRED = _WORKER_REQUIRED | _AI_STORAGE_REQUIRED | frozenset({
    "AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN",
    "AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID",
    "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY",
    "AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME",
    "AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD",
    "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE",
    "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE",
})
_HARNESS_REQUIRED = frozenset({
    "PI05_RUN_ID", "PI05_RUN_ROOT",
    "PI05_CORE_BASE_URL", "PI05_CORE_CA_FILE", "PI05_CORE_CERT_FILE",
    "PI05_CORE_KEY_FILE", "PI05_CORE_OBSERVER_CERT_FILE",
    "PI05_CORE_OBSERVER_KEY_FILE", "PI05_CORE_LEAF_SHA256",
    "PI05_CORE_CONNECT_HOST", "PI05_CORE_TLS_SERVER_NAME",
    "PI05_AI_BASE_URL", "PI05_AI_CA_FILE", "PI05_AI_CERT_FILE",
    "PI05_AI_KEY_FILE", "PI05_AI_LEAF_SHA256",
    "PI05_ACTION_EMAIL", "PI05_ACTION_PASSWORD",
    "PI05_OBSERVER_EMAIL", "PI05_OBSERVER_PASSWORD",
    "PI05_STORAGE_ENDPOINT_URL", "PI05_STORAGE_BUCKET",
    "PI05_STORAGE_ACCESS_KEY", "PI05_STORAGE_SECRET_KEY",
    "PI05_STORAGE_CA_FILE", "PI05_STORAGE_LEAF_SHA256",
    "PI05_STORAGE_TLS_SERVER_NAME", "PI05_STORAGE_HOST_HEADER",
    "PI05_STORAGE_OBJECT_PREFIX",
    "PI05_RABBIT_URL", "PI05_RABBIT_CA_FILE", "PI05_RABBIT_USERNAME",
    "PI05_RABBIT_PASSWORD", "PI05_RABBIT_LEAF_SHA256",
    "PI05_RABBIT_TLS_SERVER_NAME", "PI05_RABBIT_QUEUE",
    "PI05_QDRANT_API_KEY", "PI05_MEDIA_FILE",
    "PI05_ENVIRONMENT_KIND", "PI05_HARNESS_URL", "PI05_SOURCE_COMMIT",
    "PI05_GENERATION_ID", "PI05_COLLECTION_NAME", "PI05_EVIDENCE_DIR",
    "PI05_PROOF_DIR", "PI05_SCENARIO_TIMEOUT_SECONDS",
})
_HARNESS_PATH_KEYS = frozenset({
    "PI05_EVIDENCE_DIR", "PI05_PROOF_DIR",
})
_HARNESS_PROCESS_NAMES = {
    "PI05_ENVIRONMENT_KIND": "AI_PI05_ENVIRONMENT_KIND",
    "PI05_HARNESS_URL": "AI_PI05_HARNESS_URL",
    "PI05_RUN_ID": "AI_PI05_RUN_ID",
    "PI05_SOURCE_COMMIT": "AI_PI05_SOURCE_COMMIT",
    "PI05_GENERATION_ID": "AI_PI05_GENERATION_ID",
    "PI05_COLLECTION_NAME": "AI_PI05_COLLECTION_NAME",
    "PI05_AI_CA_FILE": "AI_PI05_CA_FILE",
    "PI05_AI_CERT_FILE": "AI_PI05_CERT_FILE",
    "PI05_AI_KEY_FILE": "AI_PI05_KEY_FILE",
    "PI05_EVIDENCE_DIR": "AI_PI05_EVIDENCE_DIR",
    "PI05_PROOF_DIR": "AI_PI05_PROOF_DIR",
    "PI05_SCENARIO_TIMEOUT_SECONDS": "AI_PI05_SCENARIO_TIMEOUT_SECONDS",
}

_AI_PROCESS_FORBIDDEN = {
    "ai-http": frozenset({
        "AI_WORKER_ROLE",
        "AI_RABBITMQ_URL", "AI_RABBITMQ_USERNAME", "AI_RABBITMQ_PASSWORD",
        "AI_RABBITMQ_CA_FILE", "AI_RABBITMQ_CONNECT_HOST",
        "AI_RABBITMQ_TLS_SERVER_NAME",
        "AI_S3_ENDPOINT_URL", "AI_S3_BUCKET", "AI_S3_ACCESS_KEY_ID",
        "AI_S3_SECRET_ACCESS_KEY", "AI_S3_CA_FILE", "AI_S3_CONNECT_HOST",
        "AI_S3_TLS_SERVER_NAME",
        "AI_CORE_API_CLIENT_CERT_FILE", "AI_CORE_API_CLIENT_KEY_FILE",
        "AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID",
        "AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY",
        "AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN",
        "AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID",
        "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY",
        "AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME",
        "AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD",
        "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE",
        "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE",
        "REPLICATE_API_TOKEN",
    }),
    "transcription-worker": frozenset({
        "AI_RAG_QDRANT_API_KEY", "AI_RAG_QDRANT_CA_FILE",
        "AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN",
        "AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID",
        "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY",
        "AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME",
        "AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD",
        "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE",
        "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE",
    }),
    "knowledge-worker": frozenset({
        "AI_S3_ENDPOINT_URL", "AI_S3_BUCKET", "AI_S3_ACCESS_KEY_ID",
        "AI_S3_SECRET_ACCESS_KEY", "AI_S3_CA_FILE", "AI_S3_CONNECT_HOST",
        "AI_S3_TLS_SERVER_NAME",
        "OPENROUTER_API_KEY", "REPLICATE_API_TOKEN",
        "AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID",
        "AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY",
        "AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN",
        "AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID",
        "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY",
        "AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME",
        "AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD",
        "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE",
        "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE",
    }),
    "mi-worker": frozenset({
        "AI_RAG_QDRANT_API_KEY", "AI_RAG_QDRANT_CA_FILE",
        "AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID",
        "AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY",
        "AI_CORE_API_CLIENT_CERT_FILE", "AI_CORE_API_CLIENT_KEY_FILE",
        "AI_RABBITMQ_USERNAME", "AI_RABBITMQ_PASSWORD",
        "AI_S3_ACCESS_KEY_ID", "AI_S3_SECRET_ACCESS_KEY",
    }),
}


def _allowlisted_ai_environment(process: str, values: dict[str, str]) -> dict[str, str]:
    forbidden = _AI_PROCESS_FORBIDDEN[process]
    return {name: value for name, value in values.items() if name not in forbidden}


def _canonical_run_id(value: object) -> str:
    if not isinstance(value, str) or _RUN_ID.fullmatch(value) is None:
        raise RuntimeConfigError("A canonical run UUID is required")
    try:
        if str(UUID(value)) != value:
            raise ValueError
    except (ValueError, TypeError, AttributeError) as error:
        raise RuntimeConfigError("A canonical run UUID is required") from error
    return value


def _no_symlink(path: Path) -> None:
    for item in (path, *path.parents):
        if item.is_symlink():
            raise RuntimeConfigError("Run configuration paths cannot be symbolic")


def _private_directory(path: Path, label: str) -> Path:
    path = Path(path).absolute()
    _no_symlink(path)
    try:
        info = path.stat()
    except OSError as error:
        raise RuntimeConfigError(f"{label} is unavailable") from error
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise RuntimeConfigError(f"{label} must be private and owner-controlled")
    return path


def _private_file(path: Path, label: str) -> Path:
    path = Path(path).absolute()
    _no_symlink(path)
    try:
        info = path.stat()
    except OSError as error:
        raise RuntimeConfigError(f"{label} is unavailable") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
        or info.st_mode & 0o077
        or info.st_size > 262_144
    ):
        raise RuntimeConfigError(f"{label} must be a private regular file")
    return path


def _allowed(name: str, prefixes: tuple[str, ...]) -> bool:
    return any(name.startswith(prefix) for prefix in prefixes)


def read_private_environment(
    path: Path,
    *,
    names: frozenset[str] | None = None,
    prefixes: tuple[str, ...] = (),
) -> dict[str, str]:
    """Read a strict, literal environment file without interpolation."""
    path = _private_file(path, "Environment file")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise RuntimeConfigError("Environment file is unreadable") from error

    result: dict[str, str] = {}
    for line in lines:
        if not line or line.startswith("#"):
            continue
        if line.count("=") < 1:
            raise RuntimeConfigError("Environment files require KEY=VALUE lines")
        name, value = line.split("=", 1)
        if (
            _KEY.fullmatch(name) is None
            or name in result
            or (names is not None and name not in names)
            or (names is None and not _allowed(name, prefixes))
            or _VALUE.fullmatch(value) is None
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
        ):
            raise RuntimeConfigError("Environment file contains an unsafe setting")
        result[name] = value
    return result


def _required(values: dict[str, str], required: frozenset[str], label: str) -> None:
    missing = required.difference(values)
    if missing:
        raise RuntimeConfigError(f"{label} environment is incomplete")
    if any(not values[name] for name in required):
        raise RuntimeConfigError(f"{label} environment contains an empty required setting")


def _validate_run_values(run_id: str, root: Path, values: dict[str, str]) -> None:
    if values.get("PI05_RUN_ID") != run_id or values.get("PI05_RUN_ROOT") != str(root):
        raise RuntimeConfigError("Run configuration identity does not match its directory")
    for name, scheme in _URL_SCHEMES.items():
        if name not in values:
            continue
        value = values[name]
        if not re.fullmatch(
            rf"{scheme}://[A-Za-z0-9.:-]+(?:/[A-Za-z0-9._/-]+)?", value,
        ):
            raise RuntimeConfigError("Run endpoint has an invalid scheme or form")
    for name in _PATH_KEYS.intersection(values):
        value = values[name]
        if not value or "\x00" in value:
            raise RuntimeConfigError("Run file reference is invalid")
        path = Path(value).absolute()
        if root not in path.parents:
            raise RuntimeConfigError("Run file reference must remain inside the run root")
        _no_symlink(path)
    for name in _HARNESS_PATH_KEYS.intersection(values):
        value = values[name]
        path = _private_directory(Path(value), "PI-05 evidence directory")
        if root not in path.parents:
            raise RuntimeConfigError("PI-05 evidence directories must remain inside the run root")
    for name, expected_scheme in _URL_SCHEMES.items():
        if name not in values:
            continue
        parts = urlsplit(values[name])
        try:
            port = parts.port
        except ValueError as error:
            raise RuntimeConfigError("Run endpoint has an invalid port") from error
        if (
            parts.scheme != expected_scheme
            or parts.username is not None
            or parts.password is not None
            or (
                name != "PI05_RABBIT_URL"
                and parts.path not in ("", "/")
            )
            or parts.query
            or parts.fragment
            or parts.hostname != _LOOPBACK
            or port is None
            or not 1 <= port <= 65535
        ):
            raise RuntimeConfigError("Run endpoints must use explicit loopback ports")
    for name, (expected_scheme, expected_host) in _APPLICATION_URLS.items():
        if name not in values:
            continue
        parts = urlsplit(values[name])
        try:
            port = parts.port
        except ValueError as error:
            raise RuntimeConfigError("Application endpoint has an invalid port") from error
        if (
            parts.scheme != expected_scheme
            or parts.username is not None
            or parts.password is not None
            or parts.query
            or parts.fragment
            or parts.hostname != expected_host
            or port is None
            or not 1 <= port <= 65535
            or (expected_scheme == "https" and parts.path not in ("", "/"))
        ):
            raise RuntimeConfigError(
                "Application endpoints must preserve their TLS identities and explicit ports"
            )
    if "AI_RAG_QDRANT_URL" in values:
        qdrant = urlsplit(values["AI_RAG_QDRANT_URL"])
        try:
            qdrant_port = qdrant.port
        except ValueError as error:
            raise RuntimeConfigError("AI Qdrant endpoint has an invalid port") from error
        if (
            qdrant.scheme != "https"
            or qdrant.hostname != _LOOPBACK
            or qdrant_port is None
            or not 1 <= qdrant_port <= 65535
            or qdrant.username is not None
            or qdrant.password is not None
            or qdrant.path not in ("", "/")
            or qdrant.query
            or qdrant.fragment
        ):
            raise RuntimeConfigError("AI Qdrant endpoint must use verified HTTPS loopback")
    if "PI05_SOURCE_COMMIT" in values and not re.fullmatch(
        r"[0-9a-f]{40}", values["PI05_SOURCE_COMMIT"]
    ):
        raise RuntimeConfigError("PI-05 source commit must be a pinned 40-hex value")
    if "PI05_ENVIRONMENT_KIND" in values and values["PI05_ENVIRONMENT_KIND"] != "DISPOSABLE":
        raise RuntimeConfigError("PI-05 environment must be disposable")
    if "PI05_HARNESS_URL" in values:
        harness = urlsplit(values["PI05_HARNESS_URL"])
        if (
            harness.scheme != "https"
            or harness.hostname is None
            or harness.username is not None
            or harness.password is not None
            or harness.query
            or harness.fragment
            or harness.path not in ("", "/")
            or not (
                harness.hostname == "localhost"
                or harness.hostname.endswith((".internal", ".test"))
                or harness.hostname == _LOOPBACK
            )
        ):
            raise RuntimeConfigError("PI-05 harness endpoint must be private HTTPS")
    if "RABBITMQ_PORT" in values:
        try:
            broker_port = int(values["RABBITMQ_PORT"])
        except ValueError as error:
            raise RuntimeConfigError("RabbitMQ port is invalid") from error
        if not 1 <= broker_port <= 65535:
            raise RuntimeConfigError("RabbitMQ port is invalid")
    if "RABBITMQ_CONNECT_HOST" in values and values["RABBITMQ_CONNECT_HOST"] != _LOOPBACK:
        raise RuntimeConfigError("RabbitMQ connection destination must be loopback")
    if (
        "RABBITMQ_HOST" in values
        and "RABBITMQ_CONNECT_HOST" in values
        and values["RABBITMQ_HOST"] != _RABBIT_TLS_NAME
    ):
        raise RuntimeConfigError("RabbitMQ application endpoint must preserve its DNS identity")
    if "RABBITMQ_TLS_SERVER_NAME" in values and (
        values["RABBITMQ_TLS_SERVER_NAME"] != _RABBIT_TLS_NAME
    ):
        raise RuntimeConfigError("RabbitMQ TLS identity is not the isolated identity")
    if "APP_MEDIA_STORAGE_CONNECT_HOST" in values and (
        values["APP_MEDIA_STORAGE_CONNECT_HOST"] != _LOOPBACK
    ):
        raise RuntimeConfigError("Storage connection destination must be loopback")
    if "APP_MEDIA_STORAGE_ENDPOINT" in values and "APP_MEDIA_STORAGE_CONNECT_HOST" in values:
        parts = urlsplit(values["APP_MEDIA_STORAGE_ENDPOINT"])
        if parts.scheme != "https" or parts.hostname != _STORAGE_TLS_NAME or parts.port is None:
            raise RuntimeConfigError("Storage application endpoint must preserve its DNS identity")
    if "APP_MEDIA_STORAGE_TLS_SERVER_NAME" in values and (
        values["APP_MEDIA_STORAGE_TLS_SERVER_NAME"] != _STORAGE_TLS_NAME
    ):
        raise RuntimeConfigError("Storage TLS identity is not the isolated identity")
    if "AI_RABBITMQ_CONNECT_HOST" in values and (
        values["AI_RABBITMQ_CONNECT_HOST"] != _LOOPBACK
    ):
        raise RuntimeConfigError("AI RabbitMQ connection destination must be loopback")
    if "AI_RABBITMQ_URL" in values and "AI_RABBITMQ_CONNECT_HOST" in values:
        parts = urlsplit(values["AI_RABBITMQ_URL"])
        if parts.scheme != "amqps" or parts.hostname != _RABBIT_TLS_NAME or parts.port is None:
            raise RuntimeConfigError("AI RabbitMQ endpoint must preserve its DNS identity")
    if "AI_RABBITMQ_TLS_SERVER_NAME" in values and (
        values["AI_RABBITMQ_TLS_SERVER_NAME"] != _RABBIT_TLS_NAME
    ):
        raise RuntimeConfigError("AI RabbitMQ TLS identity is not the isolated identity")
    if "AI_S3_CONNECT_HOST" in values and values["AI_S3_CONNECT_HOST"] != _LOOPBACK:
        raise RuntimeConfigError("AI storage connection destination must be loopback")
    if "AI_S3_ENDPOINT_URL" in values and "AI_S3_CONNECT_HOST" in values:
        parts = urlsplit(values["AI_S3_ENDPOINT_URL"])
        if parts.scheme != "https" or parts.hostname != _STORAGE_TLS_NAME or parts.port is None:
            raise RuntimeConfigError("AI storage endpoint must preserve its DNS identity")
    if "AI_S3_TLS_SERVER_NAME" in values and (
        values["AI_S3_TLS_SERVER_NAME"] != _STORAGE_TLS_NAME
    ):
        raise RuntimeConfigError("AI storage TLS identity is not the isolated identity")
    if "AI_CORE_API_CONNECT_HOST" in values and (
        values["AI_CORE_API_CONNECT_HOST"] != _LOOPBACK
    ):
        raise RuntimeConfigError("Core API connection destination must be loopback")
    if "AI_CORE_API_BASE_URL" in values and "AI_CORE_API_CONNECT_HOST" in values:
        parts = urlsplit(values["AI_CORE_API_BASE_URL"])
        if (
            parts.scheme != "https"
            or parts.hostname != "core-api.internal"
            or parts.port is None
        ):
            raise RuntimeConfigError("Core API endpoint must preserve its DNS identity")
    if "AI_CORE_API_TLS_SERVER_NAME" in values and (
        values["AI_CORE_API_TLS_SERVER_NAME"] != "core-api.internal"
    ):
        raise RuntimeConfigError("Core API TLS identity is not the isolated identity")
    if "PI05_CORE_CONNECT_HOST" in values and (
        values["PI05_CORE_CONNECT_HOST"] != _LOOPBACK
    ):
        raise RuntimeConfigError("Harness Core connection destination must be loopback")
    if "PI05_CORE_BASE_URL" in values and "PI05_CORE_CONNECT_HOST" in values:
        parts = urlsplit(values["PI05_CORE_BASE_URL"])
        if (
            parts.scheme != "https"
            or parts.hostname != _LOOPBACK
            or parts.port is None
        ):
            raise RuntimeConfigError("Harness Core endpoint must use its reviewed loopback route")
    if "PI05_CORE_TLS_SERVER_NAME" in values and (
        values["PI05_CORE_TLS_SERVER_NAME"] != "core-api.internal"
    ):
        raise RuntimeConfigError("Harness Core TLS identity is not the isolated identity")
    if "PI05_STORAGE_TLS_SERVER_NAME" in values and (
        values["PI05_STORAGE_TLS_SERVER_NAME"] != _STORAGE_TLS_NAME
        or values.get("PI05_STORAGE_HOST_HEADER") != _STORAGE_TLS_NAME
    ):
        raise RuntimeConfigError("Storage TLS and Host identities must be storage.internal")
    if "PI05_RABBIT_TLS_SERVER_NAME" in values and (
        values["PI05_RABBIT_TLS_SERVER_NAME"] != _RABBIT_TLS_NAME
    ):
        raise RuntimeConfigError("RabbitMQ TLS identity is not rabbitmq.internal")


def _validate_worker_role(values: dict[str, str], label: str) -> None:
    role = values.get("AI_WORKER_ROLE")
    identity = values.get("AI_SERVICE_IDENTITY")
    expected = {
        "transcription": "ai-worker",
        "meeting-intelligence": "mi-worker",
        "knowledge-indexing": "knowledge-worker",
    }.get(role)
    if expected is None or identity != expected:
        raise RuntimeConfigError(f"{label} worker role or identity is invalid")

    knowledge = values.get("AI_KNOWLEDGE_INDEXING_WORKER_ENABLED")
    intelligence = values.get("AI_MEETING_INTELLIGENCE_WORKER_ENABLED")
    inference = values.get("AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED")
    decision = values.get("AI_MEETING_INTELLIGENCE_DECISION_ENABLED")
    if role == "transcription" and (
        knowledge != "false"
        or intelligence != "false"
        or inference != "false"
        or decision != "false"
    ):
        raise RuntimeConfigError(f"{label} worker capability isolation is invalid")
    if role == "meeting-intelligence" and (
        knowledge != "false"
        or intelligence != "true"
        or inference != "true"
        or decision != "true"
    ):
        raise RuntimeConfigError(f"{label} worker capability isolation is invalid")
    if role == "knowledge-indexing" and (
        knowledge != "true"
        or intelligence != "false"
        or inference != "false"
        or decision != "false"
    ):
        raise RuntimeConfigError(f"{label} worker capability isolation is invalid")


def _validate_ai_http_identity(values: dict[str, str]) -> None:
    if values.get("AI_SERVICE_IDENTITY") != "ai-core":
        raise RuntimeConfigError("AI HTTP service identity is invalid")


@dataclass(frozen=True)
class RunConfiguration:
    """All reviewed settings required to assemble one isolated L01 run."""

    run_id: str
    root: Path
    core_env: dict[str, str]
    ai_http_env: dict[str, str]
    transcription_worker_env: dict[str, str]
    mi_worker_env: dict[str, str]
    knowledge_worker_env: dict[str, str]
    harness_env: dict[str, str]

    def __post_init__(self) -> None:
        run_id = _canonical_run_id(self.run_id)
        root = _private_directory(self.root, "Run root")
        if not isinstance(self.core_env, dict) or not isinstance(self.ai_http_env, dict):
            raise RuntimeConfigError("Process environments are invalid")
        if (
            not isinstance(self.transcription_worker_env, dict)
            or not isinstance(self.mi_worker_env, dict)
            or not isinstance(self.knowledge_worker_env, dict)
            or not isinstance(self.harness_env, dict)
        ):
            raise RuntimeConfigError("Process environments are invalid")
        for values in (
            self.core_env,
            self.ai_http_env,
            self.transcription_worker_env,
            self.mi_worker_env,
            self.knowledge_worker_env,
            self.harness_env,
        ):
            _validate_run_values(run_id, root, values)
        _validate_ai_http_identity(self.ai_http_env)
        _validate_worker_role(self.transcription_worker_env, "Transcription")
        _validate_worker_role(self.mi_worker_env, "Meeting Intelligence")
        _validate_worker_role(self.knowledge_worker_env, "Knowledge")
        object.__setattr__(self, "run_id", run_id)
        object.__setattr__(self, "root", root)

    def application_environments(self) -> dict[str, dict[str, str]]:
        """Return process settings; supervisor supplies fixed PI05 identity vars."""
        process = {
            "core": dict(self.core_env),
            "ai-http": _allowlisted_ai_environment("ai-http", self.ai_http_env),
            "transcription-worker": _allowlisted_ai_environment(
                "transcription-worker", self.transcription_worker_env,
            ),
            "mi-worker": _allowlisted_ai_environment("mi-worker", self.mi_worker_env),
            "knowledge-worker": _allowlisted_ai_environment(
                "knowledge-worker", self.knowledge_worker_env,
            ),
        }
        for values in process.values():
            values.pop("PI05_RUN_ID", None)
            values.pop("PI05_RUN_ROOT", None)
            # AI's Settings defaults to .env.  An explicit empty override is
            # interpreted by the entrypoints as ``_env_file=None``.
            values["AI_SETTINGS_ENV_FILE"] = ""
        return process

    def harness(self, name: str) -> str:
        if name not in self.harness_env:
            raise RuntimeConfigError("Requested harness setting is unavailable")
        return self.harness_env[name]

    def harness_process_environment(self) -> dict[str, str]:
        """Map only reviewed harness inputs into the live-test namespace."""
        result = {
            target: self.harness_env[source]
            for source, target in _HARNESS_PROCESS_NAMES.items()
            if source in self.harness_env
        }
        result["AI_RUN_PI05_LIVE"] = "1"
        return result


def load_run_configuration(
    run_id: str,
    root: Path,
    *,
    runs_base: Path | None = None,
) -> RunConfiguration:
    run_id = _canonical_run_id(run_id)
    root = Path(root).absolute()
    base = Path(runs_base or Path.home() / ".local/share/sme-pi05/runs").absolute()
    if root != base / run_id:
        raise RuntimeConfigError("Run root must be the dedicated UUID directory")
    _private_directory(root, "Run root")
    secrets = _private_directory(root / "secrets", "Run secrets directory")
    core = read_private_environment(
        secrets / "core.env", prefixes=_PROCESS_PREFIXES["core"],
    )
    ai_http = read_private_environment(
        secrets / "ai-http.env", prefixes=_PROCESS_PREFIXES["ai-http"],
    )
    transcription_worker = read_private_environment(
        secrets / "transcription-worker.env", prefixes=_PROCESS_PREFIXES["worker"],
    )
    mi_worker = read_private_environment(
        secrets / "mi-worker.env", prefixes=_PROCESS_PREFIXES["worker"],
    )
    knowledge_worker = read_private_environment(
        secrets / "knowledge-worker.env", prefixes=_PROCESS_PREFIXES["worker"],
    )
    harness = read_private_environment(secrets / "harness.env", names=_HARNESS_KEYS)
    _required(core, _CORE_REQUIRED, "Core")
    _required(ai_http, _AI_HTTP_REQUIRED, "AI HTTP")
    _required(
        transcription_worker,
        _TRANSCRIPTION_WORKER_REQUIRED,
        "Transcription worker",
    )
    _required(mi_worker, _MI_WORKER_REQUIRED, "Meeting Intelligence worker")
    _required(knowledge_worker, _KNOWLEDGE_WORKER_REQUIRED, "Knowledge worker")
    _required(harness, _HARNESS_REQUIRED, "Harness")
    return RunConfiguration(
        run_id,
        root,
        core,
        ai_http,
        transcription_worker,
        mi_worker,
        knowledge_worker,
        harness,
    )


__all__ = [
    "RunConfiguration",
    "RuntimeConfigError",
    "load_run_configuration",
    "read_private_environment",
]
