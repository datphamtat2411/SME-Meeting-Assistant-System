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
import tempfile
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
    safe_transport: bool = False,
    full_mode: bool = False,
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

    if safe_transport and full_mode:
        raise ModuleEnvironmentError("safe transport and full Core mode are mutually exclusive")
    if safe_transport:
        # Preserve the historical non-full launcher contract.  The secure
        # Spring profile consumes these values through placeholders; it must
        # not contain hard-coded feature overrides because full mode uses the
        # same profile with the canonical activation settings.
        for name in (
            "APP_MEDIA_OUTBOX_ENABLED",
            "APP_WORKER_TRANSCRIPTION_ENABLED",
            "APP_MEDIA_INTELLIGENCE_ENABLED",
            "APP_MEDIA_INTELLIGENCE_DISPATCH_ENABLED",
            "APP_MEDIA_INTELLIGENCE_REGENERATION_ENABLED",
            "APP_MEDIA_INTELLIGENCE_INFRASTRUCTURE_VERIFIED",
            "APP_MI_INTERNAL_RESULT_ENABLED",
            "APP_MEDIA_KNOWLEDGE_INDEXING_ENABLED",
            "APP_EXPORTS_WORKER_ENABLED",
            "APP_EXPORTS_PUBLIC_ADMISSION_ENABLED",
            "APP_WORKER_DEAD_LETTER_ENABLED",
            "APP_WORKER_DEAD_LETTER_REPLAY_ENABLED",
            "APP_WORKER_TRANSCRIPTION_INFRASTRUCTURE_VERIFIED",
            "APP_WORKER_DIARIZATION_ENABLED",
            "APP_WORKER_DIARIZATION_INFRASTRUCTURE_VERIFIED",
            "APP_MEDIA_PROCESSING_ACTION_ITEM_HANDOFF_ENABLED",
            "APP_MEDIA_PROCESSING_DIARIZATION_ENABLED",
            "APP_ASSISTANT_ENABLED",
        ):
            api[name] = "false"
        for name in (
            "APP_MEDIA_PROCESSING_REQUIRED_DOWNSTREAM_STAGES",
            "APP_MEDIA_INTELLIGENCE_ENABLED_STAGES",
            "APP_MEDIA_INTELLIGENCE_STORAGE_ID",
            "APP_WORKER_DIARIZATION_STORAGE_ID",
        ):
            api[name] = ""
    if full_mode:
        # The DLQ capability gate is required by the verified transcription
        # contract, but full startup must not consume historical deliveries.
        api["APP_WORKER_DEAD_LETTER_REPLAY_ENABLED"] = "false"
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
            "assistant": {
                "enabled": boolean("APP_ASSISTANT_ENABLED"),
            },
            "account-setup": {
                "worker-enabled": boolean("APP_ACCOUNT_SETUP_WORKER_ENABLED", True),
            },
            "auth": {
                "recovery": {
                    "enabled": boolean("APP_AUTH_RECOVERY_ENABLED"),
                },
            },
            "email": {
                "delivery": {
                    "worker-enabled": boolean("APP_EMAIL_DELIVERY_WORKER_ENABLED", True),
                },
            },
            "exports": {
                "public-admission-enabled": boolean("APP_EXPORTS_PUBLIC_ADMISSION_ENABLED"),
                "worker": {
                    "enabled": boolean("APP_EXPORTS_WORKER_ENABLED"),
                },
            },
            "media": {
                "outbox": {"enabled": boolean("APP_MEDIA_OUTBOX_ENABLED")},
                "processing": {
                    "action-item-handoff-enabled": boolean(
                        "APP_MEDIA_PROCESSING_ACTION_ITEM_HANDOFF_ENABLED"
                    ),
                    "diarization-enabled": boolean("APP_MEDIA_PROCESSING_DIARIZATION_ENABLED"),
                },
                "intelligence": {
                    "enabled": boolean("APP_MEDIA_INTELLIGENCE_ENABLED"),
                    "dispatch-enabled": boolean("APP_MEDIA_INTELLIGENCE_DISPATCH_ENABLED"),
                    "regeneration-enabled": boolean(
                        "APP_MEDIA_INTELLIGENCE_REGENERATION_ENABLED"
                    ),
                    "infrastructure-verified": boolean(
                        "APP_MEDIA_INTELLIGENCE_INFRASTRUCTURE_VERIFIED"
                    ),
                },
                "knowledge-indexing": {
                    "enabled": boolean("APP_MEDIA_KNOWLEDGE_INDEXING_ENABLED"),
                },
            },
            "mi": {
                "internal-result": {
                    "enabled": boolean("APP_MI_INTERNAL_RESULT_ENABLED"),
                },
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


def _write_private_environment(path: str | Path, values: dict[str, str]) -> None:
    destination = Path(path).absolute()
    parent = destination.parent
    if any(item.is_symlink() for item in (parent, *parent.parents)):
        raise ModuleEnvironmentError("Generated environment directory cannot be symbolic")
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent.chmod(0o700)
    info = parent.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ModuleEnvironmentError("Generated environment directory must be private")
    if destination.is_symlink():
        raise ModuleEnvironmentError("Generated environment path cannot be symbolic")
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            for name in sorted(values):
                if _KEY.fullmatch(name) is None or _SAFE_VALUE.fullmatch(values[name]) is None:
                    raise ModuleEnvironmentError("Generated environment contains an unsafe setting")
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


def _read_runtime_environment(path: str | Path) -> dict[str, str]:
    destination = Path(path).absolute()
    try:
        info = destination.lstat()
    except OSError as error:
        raise ModuleEnvironmentError("Generated Core environment is unavailable") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise ModuleEnvironmentError("Generated Core environment is not private")
    return read_environment(destination)


def _json_setting(document: dict, *path: str) -> object:
    current: object = document
    for item in path:
        if not isinstance(current, dict) or item not in current:
            return None
        current = current[item]
    return current


def validate_effective_environment(environment: dict[str, str], *, full_mode: bool) -> None:
    """Fail closed when the selected launch mode is not actually effective."""
    if environment.get("APP_ENVIRONMENT") != "development":
        raise ModuleEnvironmentError(
            "APP_ENVIRONMENT must be development for local orchestration"
        )
    try:
        application = json.loads(environment["SPRING_APPLICATION_JSON"])
    except (KeyError, TypeError, ValueError) as error:
        raise ModuleEnvironmentError("Spring feature configuration is malformed") from error

    def boolean(name: str, default: bool = False) -> bool:
        value = environment.get(name, "")
        if value == "":
            return default
        if value.lower() not in {"true", "false"}:
            raise ModuleEnvironmentError(f"{name} must be true or false")
        return value.lower() == "true"

    diarization_admission = boolean("APP_MEDIA_PROCESSING_DIARIZATION_ENABLED")
    diarization_worker = boolean("APP_WORKER_DIARIZATION_ENABLED")
    diarization_infrastructure = boolean("APP_WORKER_DIARIZATION_INFRASTRUCTURE_VERIFIED")
    diarization_storage = environment.get("APP_WORKER_DIARIZATION_STORAGE_ID", "").strip()
    expected = {
        ("app", "media", "outbox", "enabled"): full_mode,
        ("app", "worker", "transcription", "enabled"): full_mode,
        ("app", "worker", "transcription", "infrastructure-verified"): full_mode,
        ("app", "media", "intelligence", "enabled"): full_mode,
        ("app", "media", "intelligence", "dispatch-enabled"): full_mode,
        ("app", "media", "intelligence", "infrastructure-verified"): full_mode,
        ("app", "mi", "internal-result", "enabled"): full_mode,
        ("app", "media", "knowledge-indexing", "enabled"): full_mode,
        ("app", "media", "processing", "action-item-handoff-enabled"): full_mode,
        # Diarization is an explicit full-mode opt-in; safe transport always
        # forces the admission gate off before this validation runs.
        ("app", "media", "processing", "diarization-enabled"): full_mode and diarization_admission,
        ("app", "assistant", "enabled"): full_mode,
        # Historical DLQ messages are retained evidence, not automatic input.
        ("app", "worker", "dead-letter", "enabled"): full_mode,
    }
    for path, value in expected.items():
        if _json_setting(application, *path) is not value:
            label = ".".join(path)
            raise ModuleEnvironmentError(
                f"effective {label} does not match the selected launch mode"
            )

    if not full_mode and (
        diarization_worker or diarization_infrastructure or diarization_storage
    ):
        raise ModuleEnvironmentError(
            "safe Core mode must disable the diarization worker capability"
        )
    if full_mode and diarization_admission and (
        not diarization_worker
        or not diarization_infrastructure
        or not diarization_storage
    ):
        raise ModuleEnvironmentError(
            "full Core mode requires the verified diarization worker capability "
            "when diarization admission is enabled"
        )

    if full_mode:
        if environment.get("APP_WORKER_DEAD_LETTER_REPLAY_ENABLED") != "false":
            raise ModuleEnvironmentError(
                "full Core mode must disable historical DLQ replay"
            )
        required_stages = environment.get("APP_MEDIA_PROCESSING_REQUIRED_DOWNSTREAM_STAGES", "")
        if "GENERATING_SUMMARY" not in required_stages or "INDEXING" not in required_stages:
            raise ModuleEnvironmentError(
                "full Core mode requires transcription, intelligence, and indexing stages"
            )


def main() -> int:
    raw_arguments = sys.argv[1:]
    command: list[str] = []
    if "--" in raw_arguments:
        separator = raw_arguments.index("--")
        command = raw_arguments[separator + 1:]
        raw_arguments = raw_arguments[:separator]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("core",), nargs="?")
    parser.add_argument("--api-file", type=Path)
    parser.add_argument("--postgres-file", type=Path)
    parser.add_argument("--runtime-env", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--safe-transport", action="store_true")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(raw_arguments)
    try:
        if args.runtime_env is not None:
            if args.api_file is not None or args.postgres_file is not None or args.mode is not None:
                raise ModuleEnvironmentError(
                    "--runtime-env cannot be combined with canonical Core inputs"
                )
            if args.output is not None or args.check or args.safe_transport or args.full:
                raise ModuleEnvironmentError("--runtime-env accepts only an executable command")
            environment = _read_runtime_environment(args.runtime_env)
        else:
            if args.mode != "core" or args.api_file is None or args.postgres_file is None:
                raise ModuleEnvironmentError(
                    "canonical Core mode requires --api-file and --postgres-file"
                )
            environment = build_core_environment(
                read_environment(args.api_file),
                read_environment(args.postgres_file),
                safe_transport=args.safe_transport,
                full_mode=args.full,
            )
        if args.safe_transport or args.full:
            validate_effective_environment(environment, full_mode=args.full)
        if args.output is not None:
            _write_private_environment(args.output, environment)
        if command:
            os.execvpe(command[0], command, _scrubbed_environment(environment))
        if args.output is None and not args.check:
            raise ModuleEnvironmentError("No Core command was supplied")
        return 0
    except ModuleEnvironmentError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
