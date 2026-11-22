#!/usr/bin/env python3
"""Create isolated bootstrap credentials only after explicit operator approval.

Never touches existing configuration, provisions accounts, or prints credentials.
Application identities must be provisioned separately after infrastructure starts.
"""

from __future__ import annotations

import argparse
import os
import secrets
from pathlib import Path

from preflight import Blocked, _directory, _run_id, check_fresh_project


def create_secrets(run_id: str, root: Path, *, runs_base: Path | None = None) -> None:
    run_id = _run_id(run_id)
    base = runs_base or Path.home() / ".local/share/sme-pi05/runs"
    root = Path(os.path.abspath(root))
    base = Path(os.path.abspath(base))
    if root != base / run_id:
        raise Blocked("Run directory must match the dedicated UUID-scoped location")
    _directory(root, private=True)
    directory = root / "secrets"
    _directory(directory, private=True)
    check_fresh_project(run_id)
    names = ("postgres.env", "broker.env", "storage.env", "qdrant.env")
    if any(os.path.lexists(directory / name) for name in names):
        raise Blocked("Bootstrap credential files already exist; never overwrite them")

    pg, broker, storage, qdrant = (secrets.token_urlsafe(48) for _ in names)
    documents = {
        "postgres.env": {
            "POSTGRES_DB": "pi05_fixture",
            "POSTGRES_USER": "pi05_pg_operator",
            "POSTGRES_PASSWORD": pg,
        },
        "broker.env": {
            "RABBITMQ_DEFAULT_USER": "pi05_broker_operator",
            "RABBITMQ_DEFAULT_PASS": broker,
            "RABBITMQ_DEFAULT_VHOST": "sme-integration",
        },
        "storage.env": {
            "RUSTFS_ACCESS_KEY": "pi05_storage_operator",
            "RUSTFS_SECRET_KEY": storage,
        },
        "qdrant.env": {"QDRANT__SERVICE__API_KEY": qdrant},
    }
    directory_fd = None
    try:
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for name, values in documents.items():
            descriptor = os.open(
                name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600,
                dir_fd=directory_fd,
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                for key, value in values.items():
                    output.write(f"{key}={value}\n")
                output.flush()
                os.fsync(output.fileno())
    except OSError as error:
        raise Blocked(
            "Credential creation was incomplete; preserve and review task-owned files before retrying"
        ) from error
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        create_secrets(args.run_id, args.run_root)
    except Blocked as error:
        print("BLOCKED:", error)
        return 1
    print("PASS: four isolated bootstrap credential files created; no accounts were provisioned")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
