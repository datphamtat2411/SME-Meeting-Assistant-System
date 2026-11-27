#!/usr/bin/env python3
"""Run the existing secure smoke against host-loopback development listeners.

The service names remain the TLS identities.  Only DNS resolution is mapped to
the local listeners; certificate hostname verification is left enabled.
"""

from __future__ import annotations

import argparse
import os
import re
import socket
import sys
from pathlib import Path


_KEY = re.compile(r"[A-Z][A-Z0-9_]*\Z")
_ALLOWED_AI_NAMES = {"OPENROUTER_API_KEY", "REPLICATE_API_TOKEN"}
_LOOPBACK_NAMES = {
    "core-api.internal": "127.0.0.1",
    "rabbitmq.internal": "127.0.0.1",
    "storage.internal": "127.0.0.1",
}


def _read_environment(path: Path) -> dict[str, str]:
    try:
        info = path.lstat()
        if (
            not info
            or not path.is_file()
            or path.is_symlink()
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_size > 1_048_576
        ):
            raise ValueError
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError, ValueError) as error:
        raise SystemExit(f"BLOCKED: secure smoke environment is unavailable: {path}") from error
    values: dict[str, str] = {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if (
            not separator
            or _KEY.fullmatch(name) is None
            or name in values
            or "\x00" in value
        ):
            raise SystemExit("BLOCKED: secure smoke environment contains an unsafe setting")
        values[name] = value
    return values


def _loopback_getaddrinfo(host, *args, **kwargs):
    return _ORIGINAL_GETADDRINFO(_LOOPBACK_NAMES.get(host, host), *args, **kwargs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ai-env", required=True, type=Path)
    parser.add_argument("--secure-env", required=True, type=Path)
    parser.add_argument("smoke_args", nargs=argparse.REMAINDER)
    args, unknown = parser.parse_known_args()
    smoke_args = args.smoke_args or unknown
    if smoke_args[:1] == ["--"]:
        smoke_args = smoke_args[1:]

    ai = _read_environment(args.ai_env)
    secure = _read_environment(args.secure_env)
    if any(
        not (name.startswith("AI_") or name in _ALLOWED_AI_NAMES)
        for name in ai
    ):
        raise SystemExit("BLOCKED: generated AI smoke environment contains an unexpected setting")
    probe_key = secure.get("E2E01_STORAGE_PROBE_KEY", "").strip()
    if not probe_key:
        raise SystemExit("BLOCKED: secure smoke probe key is unavailable")

    environment = {
        name: value
        for name, value in ai.items()
        if name.startswith("AI_") or name in _ALLOWED_AI_NAMES
    }
    environment["E2E01_STORAGE_PROBE_KEY"] = probe_key
    os.environ.clear()
    os.environ.update(environment)

    global _ORIGINAL_GETADDRINFO
    _ORIGINAL_GETADDRINFO = socket.getaddrinfo
    socket.getaddrinfo = _loopback_getaddrinfo

    smoke_directory = Path(__file__).parent
    sys.path.insert(0, str(smoke_directory))
    import smoke

    sys.argv = [str(smoke_directory / "smoke.py"), *smoke_args]
    return smoke.main()


if __name__ == "__main__":
    raise SystemExit(main())
