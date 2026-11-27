#!/usr/bin/env python3
"""Render one allowlisted AI process environment from the canonical AI file.

The canonical file may contain settings for every AI capability.  This module
maps only the selected process block to the generic names consumed by
``Settings``.  It never prints rendered values because rendered values may be
credentials.
"""

from __future__ import annotations

import argparse
import ast
import os
import re
import stat
import tempfile
from pathlib import Path


class ProcessEnvironmentError(RuntimeError):
    """The canonical AI configuration is missing or unsafe."""


_KEY = re.compile(r"[A-Z][A-Z0-9_]*\Z")
_PROCESS_PREFIXES = {
    "ai-http": "AI_HTTP_PROCESS_",
    "transcription-worker": "AI_TRANSCRIPTION_PROCESS_",
    "knowledge-worker": "AI_KNOWLEDGE_PROCESS_",
    "mi-worker": "AI_MI_PROCESS_",
}
_ROLE_SOURCE_PREFIXES = tuple(_PROCESS_PREFIXES.values())
_PROCESS_EXCLUDED_SHARED_PREFIXES = {
    "transcription-worker": ("AI_RAG_",),
    "mi-worker": ("AI_RAG_",),
}
_INHERITED_NAMES = frozenset({
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    "USER",
    "VIRTUAL_ENV",
})

# These names are deliberately not shared.  They are supplied only through a
# selected process block below.
_PROCESS_SENSITIVE_NAMES = frozenset({
    "AI_SERVICE_NAME",
    "AI_SERVICE_IDENTITY",
    "AI_WORKER_ROLE",
    "AI_HTTP_HOST",
    "AI_HTTP_PORT",
    "AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS",
    "AI_TLS_CERT_FILE",
    "AI_TLS_KEY_FILE",
    "AI_TLS_CLIENT_CA_FILE",
    "AI_CORE_API_BASE_URL",
    "AI_CORE_API_SERVER_CA_FILE",
    "AI_CORE_API_CLIENT_CERT_FILE",
    "AI_CORE_API_CLIENT_KEY_FILE",
    "AI_CORE_API_CONNECT_HOST",
    "AI_CORE_API_TLS_SERVER_NAME",
    "AI_RABBITMQ_URL",
    "AI_RABBITMQ_USERNAME",
    "AI_RABBITMQ_PASSWORD",
    "AI_RABBITMQ_CA_FILE",
    "AI_RABBITMQ_CONNECT_HOST",
    "AI_RABBITMQ_TLS_SERVER_NAME",
    "AI_S3_ENDPOINT_URL",
    "AI_S3_BUCKET",
    "AI_S3_ACCESS_KEY_ID",
    "AI_S3_SECRET_ACCESS_KEY",
    "AI_S3_CA_FILE",
    "AI_S3_CONNECT_HOST",
    "AI_S3_TLS_SERVER_NAME",
    "AI_RAG_QDRANT_API_KEY",
    "AI_RAG_QDRANT_CA_FILE",
    "AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID",
    "AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY",
    "AI_KNOWLEDGE_INDEXING_WORKER_ENABLED",
    "AI_KNOWLEDGE_INDEXING_WORKER_CONCURRENCY",
    "AI_KNOWLEDGE_INDEXING_WORKER_EXECUTION_TIMEOUT_SECONDS",
    "AI_MEETING_INTELLIGENCE_WORKER_ENABLED",
    "AI_MEETING_INTELLIGENCE_WORKER_CONCURRENCY",
    "AI_MEETING_INTELLIGENCE_WORKER_EXECUTION_TIMEOUT_SECONDS",
    "AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED",
    "AI_MEETING_INTELLIGENCE_SUMMARY_ENABLED",
    "AI_MEETING_INTELLIGENCE_DECISION_ENABLED",
    "AI_MEETING_INTELLIGENCE_ACTION_ITEM_ENABLED",
    "AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN",
    "AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID",
    "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY",
    "AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME",
    "AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD",
    "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE",
    "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE",
    "AI_DIARIZATION_WORKER_ENABLED",
    "AI_DIARIZATION_WORKER_CONCURRENCY",
    "AI_DIARIZATION_WORKER_EXECUTION_TIMEOUT_SECONDS",
    "AI_DIARIZATION_WORKER_S3_ACCESS_KEY_ID",
    "AI_DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY",
    "AI_DIARIZATION_WORKER_PROVIDER_APPROVED",
    "AI_DIARIZATION_WORKER_PROJECTION_READY",
    "OPENROUTER_API_KEY",
    "REPLICATE_API_TOKEN",
})
_PROCESS_REQUIRED_SUFFIXES = {
    "ai-http": frozenset({
        "SERVICE_NAME",
        "SERVICE_IDENTITY",
        "TLS_CERT_FILE",
        "TLS_KEY_FILE",
        "TLS_CLIENT_CA_FILE",
    }),
    "transcription-worker": frozenset({
        "SERVICE_NAME",
        "SERVICE_IDENTITY",
        "WORKER_ROLE",
        "CORE_API_BASE_URL",
        "CORE_API_SERVER_CA_FILE",
        "CORE_API_CLIENT_CERT_FILE",
        "CORE_API_CLIENT_KEY_FILE",
        "RABBITMQ_URL",
        "RABBITMQ_USERNAME",
        "RABBITMQ_PASSWORD",
        "RABBITMQ_CA_FILE",
        "S3_ENDPOINT_URL",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
        "S3_CA_FILE",
    }),
    "knowledge-worker": frozenset({
        "SERVICE_NAME",
        "SERVICE_IDENTITY",
        "WORKER_ROLE",
        "CORE_API_BASE_URL",
        "CORE_API_SERVER_CA_FILE",
        "CORE_API_CLIENT_CERT_FILE",
        "CORE_API_CLIENT_KEY_FILE",
        "RABBITMQ_URL",
        "RABBITMQ_USERNAME",
        "RABBITMQ_PASSWORD",
        "RABBITMQ_CA_FILE",
        "RAG_MODEL_PATH",
        "RAG_RERANKER_MODEL_PATH",
        "RAG_QDRANT_API_KEY",
        "RAG_QDRANT_CA_FILE",
    }),
    "mi-worker": frozenset({
        "SERVICE_NAME",
        "SERVICE_IDENTITY",
        "WORKER_ROLE",
        "CORE_API_BASE_URL",
        "CORE_API_SERVER_CA_FILE",
        "RABBITMQ_URL",
        "RABBITMQ_CA_FILE",
        "S3_ENDPOINT_URL",
        "S3_BUCKET",
        "MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN",
        "MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID",
        "MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY",
        "MEETING_INTELLIGENCE_RABBITMQ_USERNAME",
        "MEETING_INTELLIGENCE_RABBITMQ_PASSWORD",
        "MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE",
        "MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE",
    }),
}
_PROCESS_EXPECTATIONS = {
    "ai-http": {"SERVICE_IDENTITY": "ai-core"},
    "transcription-worker": {
        "SERVICE_IDENTITY": "ai-worker",
        "WORKER_ROLE": "transcription",
    },
    "knowledge-worker": {
        "SERVICE_IDENTITY": "knowledge-worker",
        "WORKER_ROLE": "knowledge-indexing",
    },
    "mi-worker": {
        "SERVICE_IDENTITY": "mi-worker",
        "WORKER_ROLE": "meeting-intelligence",
    },
}
_PROTECTED_SOURCE_ENV_KEYS = {
    "RABBITMQ_PASSWORD": "AI_RABBITMQ_PASSWORD",
    "RAG_QDRANT_API_KEY": None,
    "DIARIZATION_WORKER_S3_ACCESS_KEY_ID": None,
    "DIARIZATION_WORKER_S3_SECRET_ACCESS_KEY": None,
    "MEETING_INTELLIGENCE_RABBITMQ_USERNAME": "MI_RABBITMQ_USERNAME",
    "MEETING_INTELLIGENCE_RABBITMQ_PASSWORD": "MI_RABBITMQ_PASSWORD",
    "MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID": "MI_STORAGE_ACCESS_KEY_ID",
    "MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY": "MI_STORAGE_SECRET_ACCESS_KEY",
    "MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN": None,
    "OPENROUTER_API_KEY": None,
}


def _decode_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        if value[0] == "'":
            return value[1:-1]
        try:
            decoded = ast.literal_eval(value)
        except (SyntaxError, ValueError) as error:
            raise ProcessEnvironmentError("Environment file contains an invalid quoted value") from error
        if not isinstance(decoded, str):
            raise ProcessEnvironmentError("Environment file contains an invalid quoted value")
        return decoded
    return value


def read_environment(path: str | Path) -> dict[str, str]:
    """Read literal dotenv lines without shell evaluation or interpolation."""
    path = Path(path)
    try:
        info = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_size > 1_048_576
        ):
            raise ProcessEnvironmentError("AI environment file is not a bounded regular file")
        lines = path.read_text(encoding="utf-8").splitlines()
    except ProcessEnvironmentError:
        raise
    except (OSError, UnicodeError) as error:
        raise ProcessEnvironmentError("AI environment file is unavailable") from error

    values: dict[str, str] = {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            raise ProcessEnvironmentError("AI environment files require KEY=VALUE lines")
        name, raw = line.split("=", 1)
        if (
            _KEY.fullmatch(name) is None
            or name in values
            or "\x00" in raw
        ):
            raise ProcessEnvironmentError("AI environment file contains an unsafe setting")
        values[name] = _decode_value(raw)
    return values


def _merged_values(values: dict[str, str]) -> dict[str, str]:
    """Apply normal process-environment precedence without broad inheritance."""
    merged = dict(values)
    for name, value in os.environ.items():
        if (
            _KEY.fullmatch(name) is not None
            and (
                name.startswith("AI_")
                or name in {"OPENROUTER_API_KEY", "REPLICATE_API_TOKEN"}
            )
        ):
            merged[name] = value
    return merged


def _protected_secret_path(value: str) -> Path:
    path = Path(value).expanduser()
    try:
        info = path.lstat()
    except OSError as error:
        raise ProcessEnvironmentError("Protected secret source is unavailable") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_size > 1_048_576
        or any(item.is_symlink() for item in (path, *path.parents))
    ):
        raise ProcessEnvironmentError("Protected secret source is unsafe")
    return path


def _read_protected_secret(path_value: str, suffix: str) -> str:
    path = _protected_secret_path(path_value)
    try:
        source_key = _PROTECTED_SOURCE_ENV_KEYS[suffix]
        if source_key is not None:
            secret = read_environment(path).get(source_key, "")
        else:
            lines = path.read_text(encoding="utf-8").splitlines()
            secret = lines[0].strip() if len(lines) == 1 else ""
    except (OSError, UnicodeError) as error:
        raise ProcessEnvironmentError("Protected secret source is unavailable") from error
    if not secret or "\x00" in secret or "\n" in secret or "\r" in secret:
        raise ProcessEnvironmentError("Protected secret source is invalid")
    return secret


def _resolve_protected_secrets(source_suffixes: dict[str, str]) -> None:
    for reference_suffix in tuple(source_suffixes):
        if not reference_suffix.endswith("_FILE"):
            continue
        suffix = reference_suffix.removesuffix("_FILE")
        if suffix not in _PROTECTED_SOURCE_ENV_KEYS:
            continue
        reference = source_suffixes.pop(reference_suffix)
        if not reference.strip():
            continue
        if source_suffixes.get(suffix, "").strip():
            raise ProcessEnvironmentError("A setting and its protected secret source are both configured")
        source_suffixes[suffix] = _read_protected_secret(reference, suffix)


def _target_name(suffix: str, process: str) -> tuple[str, ...]:
    if suffix in {"OPENROUTER_API_KEY", "REPLICATE_API_TOKEN"}:
        return (suffix,)
    if process == "ai-http" and suffix in {"HOST", "PORT", "SHUTDOWN_TIMEOUT_SECONDS"}:
        return ("AI_HTTP_" + suffix,)
    if suffix == "WORKER_ROLE":
        return ("AI_WORKER_ROLE",)
    if suffix.startswith("INDEXING_WORKER_") or suffix == "INDEXING_WORKER_ENABLED":
        return ("AI_KNOWLEDGE_" + suffix,)
    if suffix.startswith("MEETING_INTELLIGENCE_"):
        targets = ["AI_" + suffix]
        if suffix.startswith((
            "MEETING_INTELLIGENCE_S3_",
            "MEETING_INTELLIGENCE_RABBITMQ_",
            "MEETING_INTELLIGENCE_CORE_API_CLIENT_",
        )):
            targets.append("AI_" + suffix.removeprefix("MEETING_INTELLIGENCE_"))
        return tuple(targets)
    if suffix.startswith("DIARIZATION_WORKER_"):
        return ("AI_" + suffix,)
    if suffix.startswith("RAG_"):
        return ("AI_" + suffix,)
    return ("AI_" + suffix,)


def _shared_values(values: dict[str, str], process: str) -> dict[str, str]:
    excluded_prefixes = _PROCESS_EXCLUDED_SHARED_PREFIXES.get(process, ())
    result = {}
    for name, value in values.items():
        if not name.startswith("AI_") or name.startswith(_ROLE_SOURCE_PREFIXES):
            continue
        if name in _PROCESS_SENSITIVE_NAMES:
            continue
        if any(name.startswith(prefix) for prefix in excluded_prefixes):
            continue
        result[name] = value
    return result


def build_environment(
    values: dict[str, str],
    process: str,
    *,
    inherited: dict[str, str] | None = None,
    validate_files: bool = False,
    enable_selected_worker: bool = False,
) -> dict[str, str]:
    """Build a process environment with explicit role mapping and allowlisting."""
    if process not in _PROCESS_PREFIXES:
        raise ProcessEnvironmentError("Unknown AI process")
    merged = dict(values)
    if inherited is not None:
        merged.update(inherited)
    else:
        merged = _merged_values(merged)

    prefix = _PROCESS_PREFIXES[process]
    selected = _shared_values(merged, process)
    source_suffixes = {
        name.removeprefix(prefix): value
        for name, value in merged.items()
        if name.startswith(prefix)
    }
    _resolve_protected_secrets(source_suffixes)
    required = _PROCESS_REQUIRED_SUFFIXES[process]
    if process == "ai-http" and merged.get("AI_RAG_QDRANT_URL", "").startswith("https://"):
        required = required | frozenset({"RAG_QDRANT_API_KEY", "RAG_QDRANT_CA_FILE"})
    missing = [
        suffix for suffix in required
        if not source_suffixes.get(suffix, "").strip()
    ]
    if missing:
        raise ProcessEnvironmentError(f"{process} configuration is incomplete")
    if any(
        source_suffixes.get(suffix) != expected
        for suffix, expected in _PROCESS_EXPECTATIONS[process].items()
    ):
        raise ProcessEnvironmentError(f"{process} service identity or worker role is invalid")

    for suffix, value in source_suffixes.items():
        for target in _target_name(suffix, process):
            selected[target] = value

    # Role-specific gates are explicit.  These defaults prevent a copied
    # process file from accidentally activating another worker capability.
    if process == "transcription-worker":
        selected.setdefault("AI_KNOWLEDGE_INDEXING_WORKER_ENABLED", "false")
        selected.setdefault("AI_MEETING_INTELLIGENCE_WORKER_ENABLED", "false")
        selected.setdefault("AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED", "false")
        selected.setdefault("AI_MEETING_INTELLIGENCE_DECISION_ENABLED", "false")
    elif process == "knowledge-worker":
        selected.setdefault("AI_KNOWLEDGE_INDEXING_WORKER_ENABLED", "true")
        selected.setdefault("AI_MEETING_INTELLIGENCE_WORKER_ENABLED", "false")
        selected.setdefault("AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED", "false")
        selected.setdefault("AI_MEETING_INTELLIGENCE_DECISION_ENABLED", "false")
    elif process == "mi-worker":
        selected.setdefault("AI_KNOWLEDGE_INDEXING_WORKER_ENABLED", "false")
        selected.setdefault("AI_MEETING_INTELLIGENCE_WORKER_ENABLED", "false")
        selected.setdefault("AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED", "false")
        selected.setdefault("AI_MEETING_INTELLIGENCE_SUMMARY_ENABLED", "false")
        selected.setdefault("AI_MEETING_INTELLIGENCE_DECISION_ENABLED", "false")
        selected.setdefault("AI_MEETING_INTELLIGENCE_ACTION_ITEM_ENABLED", "false")

    if enable_selected_worker:
        if process == "knowledge-worker":
            selected["AI_KNOWLEDGE_INDEXING_WORKER_ENABLED"] = "true"
        elif process == "mi-worker":
            selected["AI_MEETING_INTELLIGENCE_WORKER_ENABLED"] = "true"
            selected["AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED"] = "true"
            selected["AI_MEETING_INTELLIGENCE_SUMMARY_ENABLED"] = "true"
            selected["AI_MEETING_INTELLIGENCE_DECISION_ENABLED"] = "true"
            selected["AI_MEETING_INTELLIGENCE_ACTION_ITEM_ENABLED"] = "true"

    selected["AI_SETTINGS_ENV_FILE"] = ""
    if validate_files:
        _validate_files(selected, process)
    return selected


def _validate_files(values: dict[str, str], process: str) -> None:
    files = []
    directories = []
    if process == "ai-http":
        files.extend(("AI_TLS_CERT_FILE", "AI_TLS_KEY_FILE", "AI_TLS_CLIENT_CA_FILE"))
        if values.get("AI_RAG_QDRANT_URL", "").startswith("https://"):
            files.append("AI_RAG_QDRANT_CA_FILE")
    else:
        files.extend(("AI_CORE_API_SERVER_CA_FILE", "AI_CORE_API_CLIENT_CERT_FILE",
                      "AI_CORE_API_CLIENT_KEY_FILE", "AI_RABBITMQ_CA_FILE"))
        if process in {"transcription-worker", "mi-worker"}:
            files.append("AI_S3_CA_FILE")
        if process == "knowledge-worker":
            files.append("AI_RAG_QDRANT_CA_FILE")
            directories.extend(("AI_RAG_MODEL_PATH", "AI_RAG_RERANKER_MODEL_PATH"))
    if (
        any(not Path(values.get(name, "")).is_file() for name in files)
        or any(not Path(values.get(name, "")).is_dir() for name in directories)
    ):
        raise ProcessEnvironmentError(f"{process} TLS/model files are unavailable")


def write_environment(path: str | Path, values: dict[str, str]) -> None:
    """Write a generated environment as a private, deterministic artifact."""
    destination = Path(path)
    parent = destination.parent.absolute()
    if any(item.is_symlink() for item in (parent, *parent.parents)):
        raise ProcessEnvironmentError("Generated environment directory cannot be symbolic")
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = parent.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ProcessEnvironmentError("Generated environment directory must be private")
    if destination.is_symlink():
        raise ProcessEnvironmentError("Generated environment path cannot be symbolic")
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            for name in sorted(values):
                if _KEY.fullmatch(name) is None or "\n" in values[name] or "\x00" in values[name]:
                    raise ProcessEnvironmentError("Generated environment contains an unsafe setting")
                output.write(f"{name}={values[name]}\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        os.chmod(destination, 0o600)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def _scrubbed_environment(values: dict[str, str]) -> dict[str, str]:
    return {
        name: value for name, value in os.environ.items()
        if name in _INHERITED_NAMES
    } | values


def _read_runtime_environment(path: str | Path) -> dict[str, str]:
    destination = Path(path).absolute()
    try:
        info = destination.lstat()
    except OSError as error:
        raise ProcessEnvironmentError("Generated AI environment is unavailable") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise ProcessEnvironmentError("Generated AI environment is not private")
    values = read_environment(destination)
    if any(
        not (name.startswith("AI_") or name in {"OPENROUTER_API_KEY", "REPLICATE_API_TOKEN"})
        for name in values
    ):
        raise ProcessEnvironmentError("Generated AI environment contains an unexpected setting")
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=".env", type=Path)
    parser.add_argument("--process", choices=tuple(_PROCESS_PREFIXES))
    parser.add_argument("--runtime-env", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--validate-files", action="store_true")
    parser.add_argument("--enable-selected-worker", action="store_true")
    parser.add_argument("--exec", dest="command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        if args.runtime_env is not None:
            if (
                args.process is not None
                or args.output is not None
                or args.validate_files
                or args.enable_selected_worker
            ):
                raise ProcessEnvironmentError(
                    "--runtime-env cannot be combined with canonical process options"
                )
            values = _read_runtime_environment(args.runtime_env)
        else:
            if args.process is None:
                raise ProcessEnvironmentError("--process is required without --runtime-env")
            values = build_environment(
                read_environment(args.config),
                args.process,
                validate_files=args.validate_files,
                enable_selected_worker=args.enable_selected_worker,
            )
        if args.output is not None:
            write_environment(args.output, values)
        if args.command:
            command = list(args.command)
            if command and command[0] == "--":
                command.pop(0)
            if not command:
                raise ProcessEnvironmentError("An executable is required after --exec")
            os.execvpe(command[0], command, _scrubbed_environment(values))
        if args.output is None:
            raise ProcessEnvironmentError("Refusing to print a rendered environment")
        return 0
    except ProcessEnvironmentError as error:
        print(f"ERROR: {error}", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
