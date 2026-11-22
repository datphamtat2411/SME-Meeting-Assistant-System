#!/usr/bin/env python3
"""Safe launch-time environment mapping for the Core API."""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import stat
import sys
from pathlib import Path


class ModuleEnvironmentError(RuntimeError):
    """A canonical module environment is missing or unsafe."""


_KEY = re.compile(r"[A-Z][A-Z0-9_]*\Z")
_SAFE_VALUE = re.compile(r"[^\x00-\x1f\x7f]*\Z")
_REPO = Path(__file__).resolve().parents[1]
_CORE_PREFIXES = ("APP_", "SPRING_", "RABBITMQ_", "SERVER_", "MANAGEMENT_", "JAVA_")
_INHERITED_NAMES = frozenset({
    "HOME",
    "JAVA_HOME",
    "LANG",
    "LC_ALL",
    "MAVEN_ARGS",
    "MAVEN_OPTS",
    "PATH",
    "TMPDIR",
    "USER",
})


def _decode_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        if value[0] == "'":
            return value[1:-1]
        try:
            parsed = ast.literal_eval(value)
        except (SyntaxError, ValueError) as error:
            raise ModuleEnvironmentError("Environment file contains an invalid quoted value") from error
        if not isinstance(parsed, str):
            raise ModuleEnvironmentError("Environment file contains an invalid quoted value")
        return parsed
    return value


def read_environment(path: str | Path) -> dict[str, str]:
    path = Path(path)
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > 1_048_576:
            raise ModuleEnvironmentError("Environment file is not a bounded regular file")
        lines = path.read_text(encoding="utf-8").splitlines()
    except ModuleEnvironmentError:
        raise
    except (OSError, UnicodeError) as error:
        raise ModuleEnvironmentError("Environment file is unavailable") from error

    values: dict[str, str] = {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            raise ModuleEnvironmentError("Environment files require KEY=VALUE lines")
        name, raw = line.split("=", 1)
        if _KEY.fullmatch(name) is None or name in values or "\x00" in raw:
            raise ModuleEnvironmentError("Environment file contains an unsafe setting")
        values[name] = _decode_value(raw)
    return values


def _with_precedence(values: dict[str, str], names: set[str] | None = None) -> dict[str, str]:
    result = dict(values)
    for name, value in os.environ.items():
        if _KEY.fullmatch(name) is not None and (names is None or name in names):
            result[name] = value
    return result


def _process_overrides() -> dict[str, str]:
    names = {
        name for name in os.environ
        if (
            name.startswith((
                "APP_", "SPRING_", "RABBITMQ_", "SERVER_", "MANAGEMENT_", "JAVA_",
                "DB_", "POSTGRES_",
            ))
        )
    }
    return {name: os.environ[name] for name in names}


def _protected_secret(path_value: str) -> str:
    path = Path(path_value).expanduser().absolute()
    try:
        info = path.lstat()
        resolved = path.resolve()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_size > 1_048_576
            or resolved.is_relative_to(_REPO)
            or any(item.is_symlink() for item in (path, *path.parents))
        ):
            raise ModuleEnvironmentError("protected secret source is unsafe")
        value = path.read_text(encoding="utf-8")
    except ModuleEnvironmentError:
        raise
    except (OSError, UnicodeError) as error:
        raise ModuleEnvironmentError("protected secret source is unavailable") from error
    lines = value.splitlines()
    if len(lines) != 1 or not lines[0].strip() or _SAFE_VALUE.fullmatch(lines[0]) is None:
        raise ModuleEnvironmentError("protected secret source is invalid")
    return lines[0].strip()


def _resolve_protected_secrets(api: dict[str, str]) -> None:
    reference_name = "APP_MI_INTERNAL_RESULT_TOKEN_FILE"
    reference = api.pop(reference_name, "").strip()
    if not reference:
        return
    if api.get("APP_MI_INTERNAL_RESULT_TOKEN", "").strip():
        raise ModuleEnvironmentError(
            "a setting and its protected secret source are both configured"
        )
    api["APP_MI_INTERNAL_RESULT_TOKEN"] = _protected_secret(reference)


def build_core_environment(
    api_values: dict[str, str],
    postgres_values: dict[str, str],
    *,
    inherited: dict[str, str] | None = None,
) -> dict[str, str]:
    """Map API and PostgreSQL ownership into one explicit Spring environment."""
    inherited = _process_overrides() if inherited is None else inherited
    api = dict(api_values)
    postgres = dict(postgres_values)
    for name, value in inherited.items():
        if name.startswith(_CORE_PREFIXES) or name.startswith(("DB_", "POSTGRES_")):
            if name in api:
                api[name] = value
            if name in postgres:
                postgres[name] = value

    _resolve_protected_secrets(api)
    selected = {
        name: value for name, value in api.items()
        if name.startswith(_CORE_PREFIXES) and name not in {"SPRING_APPLICATION_JSON"}
    }
    required = ("POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD")
    if any(not postgres.get(name, "").strip() for name in required):
        raise ModuleEnvironmentError("PostgreSQL configuration is incomplete")

    # POSTGRES_* belongs exclusively to the infrastructure module.  The API
    # receives only the derived Spring datasource contract.
    host = postgres.get("POSTGRES_HOST", "127.0.0.1")
    port = postgres.get("POSTGRES_PORT", "5433")
    if host != "127.0.0.1" or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ModuleEnvironmentError("PostgreSQL connection destination is invalid")
    selected["DB_URL"] = f"jdbc:postgresql://{host}:{port}/{postgres['POSTGRES_DB']}"
    selected["DB_USERNAME"] = postgres["POSTGRES_USER"]
    selected["DB_PASSWORD"] = postgres["POSTGRES_PASSWORD"]

    def boolean(name: str, default: bool = False) -> bool:
        value = api.get(name)
        if value is None or value == "":
            return default
        if value.lower() not in {"true", "false"}:
            raise ModuleEnvironmentError(f"{name} must be true or false")
        return value.lower() == "true"

    selected["SPRING_APPLICATION_JSON"] = json.dumps({
        "app": {
            "media": {
                "outbox": {"enabled": boolean("APP_MEDIA_OUTBOX_ENABLED")},
            },
            "worker": {
                "transcription": {
                    "enabled": boolean("APP_WORKER_TRANSCRIPTION_ENABLED"),
                    "infrastructure-verified": boolean(
                        "APP_WORKER_TRANSCRIPTION_INFRASTRUCTURE_VERIFIED"
                    ),
                },
                "dead-letter": {
                    "enabled": boolean("APP_WORKER_DEAD_LETTER_ENABLED"),
                },
            },
        },
    }, separators=(",", ":"))
    return selected


def _scrubbed_environment(values: dict[str, str]) -> dict[str, str]:
    return {
        name: value for name, value in os.environ.items()
        if name in _INHERITED_NAMES
    } | values


def main() -> int:
    raw_arguments = sys.argv[1:]
    command: list[str] = []
    if "--" in raw_arguments:
        separator = raw_arguments.index("--")
        command = raw_arguments[separator + 1:]
        raw_arguments = raw_arguments[:separator]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("core",))
    parser.add_argument("--api-file", required=True, type=Path)
    parser.add_argument("--postgres-file", required=True, type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(raw_arguments)
    try:
        environment = build_core_environment(
            read_environment(args.api_file),
            read_environment(args.postgres_file),
        )
        if command:
            os.execvpe(command[0], command, _scrubbed_environment(environment))
        if not args.check:
            raise ModuleEnvironmentError("No Core command was supplied")
        return 0
    except ModuleEnvironmentError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
