#!/usr/bin/env python3
"""Small readiness probes for dev.sh.

The probes return only status.  They do not print environment values or
application responses.
"""

from __future__ import annotations

import argparse
import re
import socket
import sys
import time
from pathlib import Path


class ReadinessError(RuntimeError):
    """A bounded readiness probe could not complete."""


def _environment_port(path: Path, name: str) -> int:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise ReadinessError("generated readiness environment is unavailable") from error
    found: str | None = None
    for line in lines:
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if separator and key == name:
            if found is not None:
                raise ReadinessError("generated readiness environment is duplicated")
            found = value
    if found is None or re.fullmatch(r"[1-9][0-9]{0,4}", found) is None:
        raise ReadinessError("generated readiness port is invalid")
    port = int(found)
    if port > 65535:
        raise ReadinessError("generated readiness port is invalid")
    return port


def wait_listener(host: str, port: int, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=min(2.0, max(0.1, deadline - time.monotonic()))):
                return
        except OSError:
            time.sleep(0.25)
    raise ReadinessError("development listener did not become ready")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)

    port = subparsers.add_parser("port")
    port.add_argument("--file", required=True, type=Path)
    port.add_argument("--name", required=True)

    listener = subparsers.add_parser("wait-listener")
    listener.add_argument("--host", required=True)
    listener.add_argument("--port", required=True, type=int)
    listener.add_argument("--timeout", type=float, default=60)

    args = parser.parse_args()
    try:
        if args.action == "port":
            print(_environment_port(args.file, args.name))
        else:
            if not 1 <= args.port <= 65535 or args.timeout <= 0:
                raise ReadinessError("readiness probe arguments are invalid")
            wait_listener(args.host, args.port, args.timeout)
    except ReadinessError as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
