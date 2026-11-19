#!/usr/bin/env python3
"""Non-destructive local configuration checks.

Only key names and file metadata are reported.  Values are never printed.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
from pathlib import Path


class ConfigurationCheckError(RuntimeError):
    """A local configuration file is unavailable or unsafe."""


_KEY = re.compile(r"[A-Z][A-Z0-9_]*\Z")
_VALUE = re.compile(r"[^\x00-\x1f\x7f]*\Z")

_LEGACY_FILES = {
    "services/ai/.env.knowledge": "services/ai/.env",
    "services/ai/.env.worker": "services/ai/.env",
    "services/ai/.env.transcription": "services/ai/.env",
    "infra/local/secure-integration/compose.env": "infra/local/secure-integration/.env",
    "infra/local/secure-integration/core.env": "services/api/.env",
    "infra/local/secure-integration/worker.env": "services/ai/.env",
    "infra/local/secure-integration/intelligence-worker.env": "services/ai/.env",
    "infra/local/secure-integration/broker.env": "infra/local/secure-integration/.env",
    "infra/local/secure-integration/storage.env": "infra/local/secure-integration/.env",
    "infra/local/secure-integration/.env.storage-bootstrap": "infra/local/secure-integration/.env",
}


def read_literal(path: Path, *, private: bool = True) -> dict[str, str]:
    path = Path(path).absolute()
    try:
        info = path.lstat()
    except OSError as error:
        raise ConfigurationCheckError("configuration file is unavailable") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_size > 1_048_576
        or (private and (info.st_uid != os.getuid() or info.st_mode & 0o077))
    ):
        raise ConfigurationCheckError("configuration file is not a private regular file")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise ConfigurationCheckError("configuration file is unreadable") from error
    values: dict[str, str] = {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            raise ConfigurationCheckError("configuration requires KEY=VALUE lines")
        name, value = line.split("=", 1)
        if _KEY.fullmatch(name) is None or name in values or _VALUE.fullmatch(value) is None:
            raise ConfigurationCheckError("configuration contains an unsafe setting")
        values[name] = value
    return values


def migration_check(root: Path) -> int:
    root = Path(root).absolute()
    found = 0
    invalid = 0
    for relative, target in _LEGACY_FILES.items():
        path = root / relative
        if not path.exists() and not path.is_symlink():
            continue
        found += 1
        try:
            values = read_literal(path)
        except ConfigurationCheckError:
            invalid += 1
            print(f"BLOCKED: legacy configuration is unreadable or unsafe: {relative}")
            continue
        canonical = root / target
        state = "present" if canonical.is_file() and not canonical.is_symlink() else "missing"
        print(
            f"WARN: legacy configuration detected: {relative}; "
            f"canonical target {target} is {state}; {len(values)} settings found; "
            "review and merge manually; no files changed"
        )
    if not found:
        print("PASS: no known pre-refactor dotenv files detected; no files changed")
    elif invalid:
        print("BLOCKED: legacy configuration check found unsafe files; no files changed")
        return 1
    else:
        print("PASS: legacy configuration inventory completed; no files changed")
    return 0


def require_settings(path: Path, names: tuple[str, ...]) -> int:
    try:
        values = read_literal(path)
    except ConfigurationCheckError as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 1
    for name in names:
        if not _KEY.fullmatch(name) or not values.get(name, "").strip():
            print(f"BLOCKED: required setting is missing: {name}", file=sys.stderr)
            return 1
    return 0


def check_directory_setting(path: Path, key: str, filenames: tuple[str, ...]) -> int:
    try:
        values = read_literal(path)
    except ConfigurationCheckError as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 1
    value = values.get(key, "").strip()
    if not value or "$" in value:
        print(f"BLOCKED: required directory setting is missing: {key}", file=sys.stderr)
        return 1
    directory = Path(value).expanduser().absolute()
    try:
        parts = (directory, *directory.parents)
        info = directory.stat()
        valid = (
            stat.S_ISDIR(info.st_mode)
            and info.st_uid == os.getuid()
            and not info.st_mode & 0o007
            and not any(item.is_symlink() for item in parts)
        )
        for filename in filenames:
            candidate = directory / filename
            file_info = candidate.stat()
            valid = valid and (
                stat.S_ISREG(file_info.st_mode)
                and file_info.st_uid == os.getuid()
                and file_info.st_nlink == 1
                and not file_info.st_mode & 0o077
                and not any(item.is_symlink() for item in (candidate, *candidate.parents))
            )
    except OSError:
        valid = False
    if not valid:
        print(f"BLOCKED: directory setting is not private and complete: {key}", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)

    migration = subparsers.add_parser("migration")
    migration.add_argument("--root", required=True, type=Path)

    require = subparsers.add_parser("require")
    require.add_argument("--file", required=True, type=Path)
    require.add_argument("names", nargs="+")

    paths = subparsers.add_parser("paths")
    paths.add_argument("--file", required=True, type=Path)
    paths.add_argument("--directory-key", required=True)
    paths.add_argument("filenames", nargs="+")

    args = parser.parse_args()
    if args.action == "migration":
        return migration_check(args.root)
    if args.action == "require":
        return require_settings(args.file, tuple(args.names))
    return check_directory_setting(args.file, args.directory_key, tuple(args.filenames))


if __name__ == "__main__":
    raise SystemExit(main())
