#!/usr/bin/env python3
"""Generate PI-05 application environments from one private run manifest.

The manifest is run-owned input, not a repository dotenv file.  It contains
explicitly prefixed values such as ``PI05_TRANSCRIPTION_WORKER_AI_*``.  The
generator strips only the selected process prefix, injects the canonical run
identity, validates each resulting environment with ``runtime_config`` and
writes mode-0600 files without replacing existing files.

This module never creates credentials, certificates, Docker resources or
privileged workloads.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
from pathlib import Path

from runtime_config import (
    _AI_HTTP_REQUIRED,
    _AI_PROCESS_FORBIDDEN,
    _CORE_REQUIRED,
    _HARNESS_KEYS,
    _HARNESS_REQUIRED,
    _KNOWLEDGE_WORKER_REQUIRED,
    _MI_WORKER_REQUIRED,
    _TRANSCRIPTION_WORKER_REQUIRED,
    _VALUE,
    RuntimeConfigError,
    _canonical_run_id,
    _private_directory,
    _required,
    _validate_run_values,
    _validate_worker_role,
)


class RuntimeGenerationError(RuntimeError):
    """The run manifest is missing, unsafe or would overwrite a run file."""


_KEY = re.compile(r"[A-Z][A-Z0-9_]*\Z")
_SOURCE_PREFIXES = {
    "core": "PI05_CORE_",
    "ai-http": "PI05_AI_HTTP_",
    "transcription-worker": "PI05_TRANSCRIPTION_WORKER_",
    "mi-worker": "PI05_MI_WORKER_",
    "knowledge-worker": "PI05_KNOWLEDGE_WORKER_",
    "harness": "PI05_HARNESS_",
}
_OUTPUT_FILES = {
    "core": "core.env",
    "ai-http": "ai-http.env",
    "transcription-worker": "transcription-worker.env",
    "mi-worker": "mi-worker.env",
    "knowledge-worker": "knowledge-worker.env",
    "harness": "harness.env",
}
_REQUIRED = {
    "core": _CORE_REQUIRED,
    "ai-http": _AI_HTTP_REQUIRED,
    "transcription-worker": _TRANSCRIPTION_WORKER_REQUIRED,
    "mi-worker": _MI_WORKER_REQUIRED,
    "knowledge-worker": _KNOWLEDGE_WORKER_REQUIRED,
    "harness": _HARNESS_REQUIRED,
}
_MI_DERIVED_VALUES = {
    "AI_CORE_API_CLIENT_CERT_FILE": "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE",
    "AI_CORE_API_CLIENT_KEY_FILE": "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE",
    "AI_RABBITMQ_USERNAME": "AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME",
    "AI_RABBITMQ_PASSWORD": "AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD",
    "AI_S3_ACCESS_KEY_ID": "AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID",
    "AI_S3_SECRET_ACCESS_KEY": "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY",
}


def _manifest_file(path: Path) -> Path:
    path = Path(path).absolute()
    try:
        info = path.lstat()
    except OSError as error:
        raise RuntimeGenerationError("PI-05 run manifest is unavailable") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
        or info.st_mode & 0o077
        or info.st_size > 262_144
    ):
        raise RuntimeGenerationError("PI-05 run manifest must be a private regular file")
    return path


def read_manifest(path: str | Path) -> dict[str, str]:
    """Read a prefixed, literal manifest without interpolation or shell code."""
    path = _manifest_file(Path(path))
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise RuntimeGenerationError("PI-05 run manifest is unreadable") from error

    values: dict[str, str] = {}
    for line in lines:
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise RuntimeGenerationError("PI-05 run manifests require KEY=VALUE lines")
        name, value = line.split("=", 1)
        if (
            _KEY.fullmatch(name) is None
            or name in values
            or _VALUE.fullmatch(value) is None
        ):
            raise RuntimeGenerationError("PI-05 run manifest contains an unsafe setting")
        values[name] = value
    return values


def _target_names(process: str, values: dict[str, str]) -> dict[str, str]:
    prefix = _SOURCE_PREFIXES[process]
    selected: dict[str, str] = {}
    for name, value in values.items():
        if not name.startswith(prefix):
            continue
        target = name.removeprefix(prefix)
        if not target or target in selected:
            raise RuntimeGenerationError("PI-05 run manifest contains a duplicate or nested target")
        if process == "harness":
            allowed = target in _HARNESS_KEYS and target not in {"PI05_RUN_ID", "PI05_RUN_ROOT"}
        elif process == "core":
            allowed = target.startswith(("APP_", "DB_", "RABBITMQ_", "SPRING_",
                                         "SERVER_", "MANAGEMENT_", "JAVA_"))
        else:
            if target.startswith("PI05_"):
                raise RuntimeGenerationError("PI-05 run manifest contains a nested target")
            allowed = (
                target.startswith("AI_")
                or target in {"OPENROUTER_API_KEY", "REPLICATE_API_TOKEN", "SSL_CERT_FILE"}
            )
            if "_PROCESS_" in target:
                allowed = False
        if not allowed:
            raise RuntimeGenerationError("PI-05 run manifest contains a cross-module setting")
        if target in _AI_PROCESS_FORBIDDEN.get(process, frozenset()):
            raise RuntimeGenerationError("PI-05 run manifest contains a cross-role setting")
        if process == "mi-worker" and target in _MI_DERIVED_VALUES:
            raise RuntimeGenerationError("PI-05 MI credentials must use dedicated source names")
        selected[target] = value
    return selected


def _with_identity(run_id: str, root: Path, values: dict[str, str]) -> dict[str, str]:
    result = dict(values)
    if "PI05_RUN_ID" in result or "PI05_RUN_ROOT" in result:
        raise RuntimeGenerationError("PI-05 run identity is generated, not supplied by the manifest")
    result["PI05_RUN_ID"] = run_id
    result["PI05_RUN_ROOT"] = str(root)
    return result


def _with_worker_gates(process: str, values: dict[str, str]) -> dict[str, str]:
    if process == "transcription-worker":
        values.setdefault("AI_KNOWLEDGE_INDEXING_WORKER_ENABLED", "false")
        values.setdefault("AI_MEETING_INTELLIGENCE_WORKER_ENABLED", "false")
        values.setdefault("AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED", "false")
        values.setdefault("AI_MEETING_INTELLIGENCE_DECISION_ENABLED", "false")
    elif process == "mi-worker":
        values.setdefault("AI_KNOWLEDGE_INDEXING_WORKER_ENABLED", "false")
        values.setdefault("AI_MEETING_INTELLIGENCE_WORKER_ENABLED", "true")
        values.setdefault("AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED", "true")
        values.setdefault("AI_MEETING_INTELLIGENCE_DECISION_ENABLED", "true")
    elif process == "knowledge-worker":
        values.setdefault("AI_KNOWLEDGE_INDEXING_WORKER_ENABLED", "true")
        values.setdefault("AI_MEETING_INTELLIGENCE_WORKER_ENABLED", "false")
        values.setdefault("AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED", "false")
        values.setdefault("AI_MEETING_INTELLIGENCE_DECISION_ENABLED", "false")
    return values


def _with_derived_values(process: str, values: dict[str, str]) -> dict[str, str]:
    if process == "mi-worker":
        for generic, dedicated in _MI_DERIVED_VALUES.items():
            if dedicated in values:
                values[generic] = values[dedicated]
    return values


def build_run_environments(
    run_id: str,
    root: str | Path,
    manifest: dict[str, str],
) -> dict[str, dict[str, str]]:
    """Build all six deterministic run mappings without writing files."""
    run_id = _canonical_run_id(run_id)
    root = _private_directory(Path(root), "Run root")
    outputs = {
        process: _with_worker_gates(
            process,
            _with_derived_values(
                process,
                _with_identity(run_id, root, _target_names(process, manifest)),
            ),
        )
        for process in _SOURCE_PREFIXES
    }

    _required(outputs["core"], _REQUIRED["core"], "Core")
    _required(outputs["ai-http"], _REQUIRED["ai-http"], "AI HTTP")
    _required(outputs["transcription-worker"], _REQUIRED["transcription-worker"], "Transcription worker")
    _required(outputs["mi-worker"], _REQUIRED["mi-worker"], "Meeting Intelligence worker")
    _required(outputs["knowledge-worker"], _REQUIRED["knowledge-worker"], "Knowledge worker")
    _required(outputs["harness"], _REQUIRED["harness"], "Harness")

    for values in outputs.values():
        _validate_run_values(run_id, root, values)
    _validate_worker_role(outputs["transcription-worker"], "Transcription")
    _validate_worker_role(outputs["mi-worker"], "Meeting Intelligence")
    _validate_worker_role(outputs["knowledge-worker"], "Knowledge")
    if outputs["ai-http"].get("AI_SERVICE_IDENTITY") != "ai-core":
        raise RuntimeGenerationError("AI HTTP service identity is invalid")
    return outputs


def _write_exclusive(path: Path, values: dict[str, str]) -> None:
    if os.path.lexists(path):
        raise RuntimeGenerationError("PI-05 generated environment already exists")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            for name in sorted(values):
                output.write(f"{name}={values[name]}\n")
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise
    path.chmod(0o600)


def generate_run_environments(
    run_id: str,
    root: str | Path,
    *,
    manifest_path: str | Path | None = None,
) -> dict[str, Path]:
    """Validate one run manifest and create private process files exactly once."""
    run_id = _canonical_run_id(run_id)
    root = _private_directory(Path(root), "Run root")
    secrets = _private_directory(root / "secrets", "Run secrets directory")
    manifest_path = Path(manifest_path or secrets / "runtime-input.env").absolute()
    if root not in manifest_path.parents:
        raise RuntimeGenerationError("PI-05 run manifest must remain inside the run root")
    manifest = read_manifest(manifest_path)
    outputs = build_run_environments(run_id, root, manifest)
    destinations = {
        process: secrets / filename
        for process, filename in _OUTPUT_FILES.items()
    }
    if any(os.path.lexists(path) for path in destinations.values()):
        raise RuntimeGenerationError("PI-05 generated environment already exists")
    created: list[Path] = []
    try:
        for process, values in outputs.items():
            _write_exclusive(destinations[process], values)
            created.append(destinations[process])
    except BaseException:
        for path in created:
            path.unlink(missing_ok=True)
        raise
    return destinations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    try:
        generate_run_environments(args.run_id, args.run_root, manifest_path=args.manifest)
    except (RuntimeGenerationError, RuntimeConfigError, ValueError) as error:
        print("BLOCKED:", error, file=sys.stderr)
        return 1
    print("PASS: six private PI-05 process environments generated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
