#!/usr/bin/env python3
"""Read-only checks for a fresh, task-owned PI-05 infrastructure project.

This does not create resources, issue certificates, validate live TLS, or approve
the deployment. Secret values are never printed.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import subprocess
from pathlib import Path
from uuid import UUID


class Blocked(Exception):
    """The proposed run is not safe to start."""


ENV_KEYS = {
    "postgres.env": {"POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"},
    "broker.env": {"RABBITMQ_DEFAULT_USER", "RABBITMQ_DEFAULT_PASS", "RABBITMQ_DEFAULT_VHOST"},
    "storage.env": {"RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY"},
    "qdrant.env": {"QDRANT__SERVICE__API_KEY"},
}
SECRET_KEYS = (
    ("postgres.env", "POSTGRES_PASSWORD"),
    ("broker.env", "RABBITMQ_DEFAULT_PASS"),
    ("storage.env", "RUSTFS_SECRET_KEY"),
    ("qdrant.env", "QDRANT__SERVICE__API_KEY"),
)
ROLE_FILES = {
    "broker-server": ("tls.crt", "tls.key", "issuer-ca.crt"),
    "storage-server": ("rustfs_cert.pem", "rustfs_key.pem", "issuer-ca.crt"),
    "qdrant-server": ("tls.crt", "tls.key", "issuer-ca.crt"),
}


def _run_id(value: str) -> str:
    try:
        if str(UUID(value)) != value:
            raise ValueError
    except (ValueError, TypeError, AttributeError) as error:
        raise Blocked("A canonical run UUID is required") from error
    return value


def _no_symlinks(path: Path) -> None:
    for item in (path, *path.parents):
        if item.is_symlink():
            raise Blocked("Symbolic links are not permitted in run paths")


def _directory(path: Path, *, private: bool = False) -> None:
    _no_symlinks(path)
    try:
        info = path.stat()
    except OSError as error:
        raise Blocked("Required run directory is missing") from error
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise Blocked("Run directories must be owned by the current user")
    prohibited = 0o077 if private else 0o027
    if info.st_mode & prohibited:
        raise Blocked("Run directory permissions are not restricted")


def _file(path: Path, *, private: bool = False, key: bool = False) -> None:
    _no_symlinks(path)
    try:
        info = path.stat()
    except OSError as error:
        raise Blocked("Required run material is missing") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
        or not 0 < info.st_size <= 1_048_576
    ):
        raise Blocked("Run material must be a bounded, owner-controlled regular file")
    prohibited = 0o077 if private else 0o027 if key else 0o022
    if info.st_mode & prohibited:
        raise Blocked("Run material permissions are not restricted")


def _read_env(path: Path, expected: set[str]) -> dict[str, str]:
    _file(path, private=True)
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise Blocked("A private environment file is unreadable") from error
    for line in lines:
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=([A-Za-z0-9_-]+)", line)
        if match is None or match[1] not in expected or match[1] in values:
            raise Blocked("Private environment files require unique, allowlisted literal settings")
        values[match[1]] = match[2]
    if set(values) != expected:
        raise Blocked("Required private environment settings are missing")
    return values


def check_files(run_id: str, root: Path, *, runs_base: Path | None = None) -> None:
    """Check a private run layout, never proving certificate trust or runtime isolation."""
    run_id = _run_id(run_id)
    base = runs_base or Path.home() / ".local/share/sme-pi05/runs"
    root = Path(os.path.abspath(root))
    base = Path(os.path.abspath(base))
    if root != base / run_id:
        raise Blocked("Run directory must match the dedicated UUID-scoped location")
    _directory(root, private=True)
    _directory(root / "secrets", private=True)
    _directory(root / "pki")
    envs = {name: _read_env(root / "secrets" / name, keys) for name, keys in ENV_KEYS.items()}
    if envs["broker.env"]["RABBITMQ_DEFAULT_VHOST"] != "sme-integration":
        raise Blocked("The isolated broker must use the documented vhost")
    secrets = [envs[filename][key] for filename, key in SECRET_KEYS]
    if len(set(secrets)) != len(secrets) or any(
        not 32 <= len(value) <= 256 or len(set(value)) < 12 for value in secrets
    ):
        raise Blocked("Separate, non-placeholder secret values of at least 32 characters are required")
    for role, names in ROLE_FILES.items():
        directory = root / "pki" / role
        _directory(directory)
        for name in names:
            _file(directory / name, key=name.endswith((".key", "_key.pem")))


def check_fresh_project(run_id: str) -> None:
    """Refuse labeled resources and unlabelled names that could collide."""
    project = "pi05-" + _run_id(run_id)
    for command in (
        ["docker", "ps", "-aq"],
        ["docker", "volume", "ls", "-q"],
        ["docker", "network", "ls", "-q"],
    ):
        try:
            output = subprocess.check_output(
                [*command, "--filter", "label=com.docker.compose.project=" + project],
                text=True, stderr=subprocess.DEVNULL, timeout=20,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise Blocked("Docker resource inspection is unavailable") from error
        if output.strip():
            raise Blocked("The run's Compose project already exists; do not reuse it as a fresh run")
    for command, matches in (
        (["docker", "ps", "-a", "--format", "{{.Names}}"],
         lambda name: name.startswith(project + "-") or name.startswith(project + "_")),
        (["docker", "volume", "ls", "--format", "{{.Name}}"],
         lambda name: name in {project + "_" + suffix for suffix in
                               ("postgres_data", "broker_data", "storage_data", "qdrant_data")}),
        (["docker", "network", "ls", "--format", "{{.Name}}"],
         lambda name: name in {project + "_integration", project + "_storage-backend"}),
    ):
        try:
            names = subprocess.check_output(
                command, text=True, stderr=subprocess.DEVNULL, timeout=20,
            ).splitlines()
        except (OSError, subprocess.SubprocessError) as error:
            raise Blocked("Docker resource inspection is unavailable") from error
        if any(matches(name) for name in names):
            raise Blocked("A resource with this run's project name already exists")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        check_files(args.run_id, args.run_root)
        check_fresh_project(args.run_id)
    except Blocked as error:
        print("BLOCKED:", error)
        return 1
    print("PASS: private file layout and fresh project only; TLS and deployment remain unverified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
