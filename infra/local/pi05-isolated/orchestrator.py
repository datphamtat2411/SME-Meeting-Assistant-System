#!/usr/bin/env python3
"""Run read-only PI-05 admission/readiness checks and an isolated command.

The repository PI-05 dotenv file contains orchestration metadata only.  All
application credentials, certificates, harness identities and generated
process environments remain in one private UUID-scoped run directory.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

from preflight import Blocked, check_active_run, check_files, check_fresh_project
from runtime_config import RuntimeConfigError, load_run_configuration
from runtime_inspection import inspect_topology


class OrchestrationError(RuntimeError):
    """PI-05 orchestration metadata or run state is unavailable."""


_KEY = re.compile(r"[A-Z][A-Z0-9_]*\Z")
_VALUE = re.compile(r"[^\x00-\x1f\x7f]*\Z")
_CONFIG_KEYS = frozenset({
    "PI05_RUN_BASE_DIR",
    "PI05_RUN_ID",
    "PI05_RUN_ROOT",
    "PI05_MANIFEST_PATH",
    "PI05_SOURCE_COMMIT",
    "PI05_GENERATION_ID",
    "PI05_COLLECTION_NAME",
    "PI05_ENVIRONMENT_KIND",
    "PI05_HARNESS_URL",
    "PI05_EVIDENCE_DIR",
    "PI05_PROOF_DIR",
    "PI05_SCENARIO_TIMEOUT_SECONDS",
    "PI05_POLL_INTERVAL_SECONDS",
    "PI05_RABBIT_MINIMUM_MESSAGE_COUNT",
    "PI05_COMPOSE_FILE",
    "PI05_REQUIRE_FRESH_PROJECT",
})
_INHERITED = frozenset({"HOME", "LANG", "LC_ALL", "PATH", "VIRTUAL_ENV"})


def _private_config(path: Path) -> Path:
    path = Path(path).absolute()
    try:
        info = path.lstat()
    except OSError as error:
        raise OrchestrationError("PI-05 canonical configuration is unavailable") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_size > 1_048_576
    ):
        raise OrchestrationError("PI-05 canonical configuration must be private")
    return path


def read_orchestration_config(path: Path) -> dict[str, str]:
    path = _private_config(path)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise OrchestrationError("PI-05 canonical configuration is unreadable") from error
    values: dict[str, str] = {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            raise OrchestrationError("PI-05 canonical configuration requires KEY=VALUE lines")
        name, value = line.split("=", 1)
        if (
            _KEY.fullmatch(name) is None
            or name in values
            or _VALUE.fullmatch(value) is None
        ):
            raise OrchestrationError("PI-05 canonical configuration contains an unsafe setting")
        if name in _CONFIG_KEYS:
            values[name] = value
    return values


def _expanded_path(value: str, *, default: Path | None = None) -> Path:
    if not value:
        if default is None:
            raise OrchestrationError("PI-05 orchestration setting is missing")
        return default.absolute()
    if "$" in value:
        raise OrchestrationError("PI-05 paths must not use shell interpolation")
    return Path(value).expanduser().absolute()


def resolve_run(config: dict[str, str]) -> tuple[str, Path, Path, Path]:
    base = _expanded_path(
        os.environ.get("PI05_RUN_BASE_DIR", config.get("PI05_RUN_BASE_DIR", "")),
        default=Path.home() / ".local/share/sme-pi05/runs",
    )
    run_id = os.environ.get("PI05_RUN_ID", config.get("PI05_RUN_ID", ""))
    if not run_id:
        raise OrchestrationError("PI05_RUN_ID must identify the prepared private run")
    root = _expanded_path(
        os.environ.get("PI05_RUN_ROOT", config.get("PI05_RUN_ROOT", "")),
        default=base / run_id,
    )
    manifest = _expanded_path(
        os.environ.get("PI05_MANIFEST_PATH", config.get("PI05_MANIFEST_PATH", "")),
        default=root / "secrets/runtime-input.env",
    )
    return run_id, root, base, manifest


def _admit(run_id: str, root: Path, base: Path) -> None:
    check_files(run_id, root, runs_base=base)
    check_fresh_project(run_id)


def _active(
    run_id: str,
    root: Path,
    base: Path,
    orchestration: dict[str, str],
) -> dict[str, str]:
    check_active_run(run_id, root, runs_base=base)
    try:
        configuration = load_run_configuration(run_id, root, runs_base=base)
    except RuntimeConfigError as error:
        raise OrchestrationError("PI-05 generated run configuration is not ready") from error
    try:
        process_environment = configuration.harness_process_environment()
        for setting, source in {
            "PI05_ENVIRONMENT_KIND": "AI_PI05_ENVIRONMENT_KIND",
            "PI05_HARNESS_URL": "AI_PI05_HARNESS_URL",
            "PI05_SOURCE_COMMIT": "AI_PI05_SOURCE_COMMIT",
            "PI05_GENERATION_ID": "AI_PI05_GENERATION_ID",
            "PI05_COLLECTION_NAME": "AI_PI05_COLLECTION_NAME",
        }.items():
            configured = orchestration.get(setting)
            if not configured:
                configured = os.environ.get(setting)
            # Empty canonical values mean "take the reviewed run manifest".
            if configured and process_environment.get(source) != configured:
                raise OrchestrationError("PI-05 canonical and run-owned metadata disagree")
        return process_environment | {
            "AI_PI05_RUN_BASE_DIR": str(base),
        }
    except RuntimeConfigError as error:
        raise OrchestrationError("PI-05 harness environment is incomplete") from error


def _exec(command: list[str], environment: dict[str, str]) -> None:
    if not command or any(not item or "\x00" in item for item in command):
        raise OrchestrationError("PI-05 command is invalid")
    # The active foundation check is intentionally separate from fresh-project
    # admission.  It only reads labels, health and mount metadata.
    os.execvpe(command[0], command, environment)


def main() -> int:
    raw = sys.argv[1:]
    command: list[str] = []
    if "--" in raw:
        separator = raw.index("--")
        command = raw[separator + 1:]
        raw = raw[:separator]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--admit", action="store_true")
    parser.add_argument("--active", action="store_true")
    args = parser.parse_args(raw)
    if args.admit == args.active:
        parser.error("select exactly one of --admit or --active")
    try:
        config = read_orchestration_config(args.config)
        run_id, root, base, _manifest = resolve_run(config)
        if args.admit:
            _admit(run_id, root, base)
            print("PASS: PI-05 fresh-project admission only; no resources were started")
            return 0
        environment = _active(run_id, root, base, config)
        inspect_topology(run_id, root, runs_base=base)
        if not command:
            print("PASS: PI-05 active run files and Docker topology are ready")
            return 0
        selected = {
            name: value for name, value in os.environ.items() if name in _INHERITED
        }
        selected.update(environment)
        _exec(command, selected)
    except (Blocked, OrchestrationError, RuntimeConfigError, OSError, subprocess.SubprocessError) as error:
        print("BLOCKED: PI-05 orchestration readiness failed", file=sys.stderr)
        # Keep diagnostics generic: no path values, credentials or command
        # environment values are exposed by this wrapper.
        print(f"BLOCKED: {type(error).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
