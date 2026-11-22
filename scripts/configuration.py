#!/usr/bin/env python3
"""Non-destructive local configuration checks.

Only key names and file metadata are reported.  Values are never printed.
"""

from __future__ import annotations

import argparse
import errno
import os
import re
import stat
import struct
import sys
import tempfile
from pathlib import Path


class ConfigurationCheckError(RuntimeError):
    """A local configuration file is unavailable or unsafe."""


_KEY = re.compile(r"[A-Z][A-Z0-9_]*\Z")
_VALUE = re.compile(r"[^\x00-\x1f\x7f]*\Z")
_ACL_XATTR = "system.posix_acl_access"
_ACL_VERSION = 2
_ACL_USER_OBJ = 1
_ACL_USER = 2
_ACL_GROUP_OBJ = 4
_ACL_GROUP = 8
_ACL_MASK = 16
_ACL_OTHER = 32

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


def _protected_secret(path_value: str) -> str:
    path = Path(path_value).expanduser().absolute()
    try:
        info = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_size > 1_048_576
            or any(item.is_symlink() for item in (path, *path.parents))
        ):
            raise ConfigurationCheckError("protected secret source is unsafe")
        value = path.read_text(encoding="utf-8")
    except ConfigurationCheckError:
        raise
    except (OSError, UnicodeError) as error:
        raise ConfigurationCheckError("protected secret source is unavailable") from error
    lines = value.splitlines()
    if len(lines) != 1 or _VALUE.fullmatch(lines[0]) is None or not lines[0].strip():
        raise ConfigurationCheckError("protected secret source is invalid")
    return lines[0].strip()


def _write_private_environment(path: Path, values: dict[str, str]) -> None:
    destination = Path(path).absolute()
    parent = destination.parent
    if any(item.is_symlink() for item in (parent, *parent.parents)):
        raise ConfigurationCheckError("generated configuration directory cannot be symbolic")
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent.chmod(0o700)
    info = parent.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ConfigurationCheckError("generated configuration directory must be private")
    if destination.is_symlink():
        raise ConfigurationCheckError("generated configuration path cannot be symbolic")
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            for name in sorted(values):
                if _KEY.fullmatch(name) is None or _VALUE.fullmatch(values[name]) is None:
                    raise ConfigurationCheckError("generated configuration contains an unsafe setting")
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


def render_secure_environment(source: Path, destination: Path) -> None:
    """Render Compose interpolation values without storing external secrets in Git."""
    values = read_literal(source)
    reference = values.get("QDRANT_API_KEY_FILE", "").strip()
    direct = values.get("QDRANT_API_KEY", "").strip()
    if reference and direct:
        raise ConfigurationCheckError("Qdrant API key and protected source are both configured")
    if reference:
        values["QDRANT_API_KEY"] = _protected_secret(reference)
    values.pop("QDRANT_API_KEY_FILE", None)
    _write_private_environment(destination, values)


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


def _read_posix_acl(path: Path) -> dict[tuple[int, int], int] | None:
    """Read a Linux access ACL without treating its mode mask as group access."""
    try:
        raw = os.getxattr(path, _ACL_XATTR, follow_symlinks=False)
    except OSError as error:
        if error.errno in {errno.ENODATA, errno.ENOTSUP, errno.EOPNOTSUPP}:
            return None
        raise
    if len(raw) < 4 or (len(raw) - 4) % 8:
        raise ConfigurationCheckError("configuration ACL is malformed")
    if struct.unpack_from("<I", raw)[0] != _ACL_VERSION:
        raise ConfigurationCheckError("configuration ACL version is unsupported")
    entries: dict[tuple[int, int], int] = {}
    known_tags = {_ACL_USER_OBJ, _ACL_USER, _ACL_GROUP_OBJ, _ACL_GROUP, _ACL_MASK, _ACL_OTHER}
    for offset in range(4, len(raw), 8):
        tag, permissions, identifier = struct.unpack_from("<HHI", raw, offset)
        if tag not in known_tags or permissions & ~0o7:
            raise ConfigurationCheckError("configuration ACL is malformed")
        qualifier = identifier if tag in {_ACL_USER, _ACL_GROUP} else 0
        entry = (tag, qualifier)
        if entry in entries:
            raise ConfigurationCheckError("configuration ACL is malformed")
        entries[entry] = permissions
    return entries


def _acl_permission(
    acl: dict[tuple[int, int], int],
    tag: int,
    qualifier: int = 0,
) -> int | None:
    return acl.get((tag, qualifier))


def _safe_access(
    path: Path,
    info: os.stat_result,
    *,
    directory: bool,
    private_material: bool,
    allowed_acl_uids: frozenset[int],
) -> bool:
    """Require owner control and deny group/other writes or unintended access."""
    acl = _read_posix_acl(path)
    mode = stat.S_IMODE(info.st_mode)
    if acl is None:
        if directory or private_material:
            return not mode & 0o077
        # CA and certificate files are public material, but must not be
        # writable or executable by group/other.
        return not mode & 0o022 and not mode & 0o111

    required = (_ACL_USER_OBJ, _ACL_GROUP_OBJ, _ACL_MASK, _ACL_OTHER)
    if any(_acl_permission(acl, tag) is None for tag in required):
        return False
    group_permissions = _acl_permission(acl, _ACL_GROUP_OBJ)
    other_permissions = _acl_permission(acl, _ACL_OTHER)
    mask_permissions = _acl_permission(acl, _ACL_MASK)
    assert group_permissions is not None
    assert other_permissions is not None
    assert mask_permissions is not None

    named_users = {
        qualifier: permissions
        for (tag, qualifier), permissions in acl.items()
        if tag == _ACL_USER
    }
    named_groups = [tag for tag, _ in acl if tag == _ACL_GROUP]
    if named_groups or any(uid not in allowed_acl_uids for uid in named_users):
        return False

    if directory:
        if group_permissions != 0 or other_permissions != 0:
            return False
        if mask_permissions & 0o2 or mask_permissions & ~0o5:
            return False
        return all(not permissions & 0o2 and not permissions & ~0o5
                   for permissions in named_users.values())

    if private_material and (group_permissions != 0 or other_permissions != 0):
        return False
    if mask_permissions & 0o3 or mask_permissions & ~0o4:
        return False
    if not private_material and (
        group_permissions & 0o3
        or group_permissions & ~0o4
        or other_permissions & 0o3
        or other_permissions & ~0o4
    ):
        return False
    return all(not permissions & 0o3 and not permissions & ~0o4
               for permissions in named_users.values())


def _acl_uid(value: str) -> int:
    try:
        result = int(value, 10)
    except ValueError as error:
        raise argparse.ArgumentTypeError("ACL UID must be a non-negative integer") from error
    if not 0 <= result <= 0xFFFFFFFF:
        raise argparse.ArgumentTypeError("ACL UID is out of range")
    return result


def _is_public_certificate(filename: str) -> bool:
    lowered = filename.lower()
    return lowered.endswith((".crt", "cert.pem"))


def check_directory_setting(
    path: Path,
    key: str,
    filenames: tuple[str, ...],
    *,
    allowed_acl_uids: frozenset[int] = frozenset(),
) -> int:
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
            and not any(item.is_symlink() for item in parts)
            and _safe_access(
                directory,
                info,
                directory=True,
                private_material=True,
                allowed_acl_uids=allowed_acl_uids,
            )
        )
        for filename in filenames:
            candidate = directory / filename
            file_info = candidate.stat()
            valid = valid and (
                stat.S_ISREG(file_info.st_mode)
                and file_info.st_uid == os.getuid()
                and file_info.st_nlink == 1
                and not any(item.is_symlink() for item in (candidate, *candidate.parents))
                and _safe_access(
                    candidate,
                    file_info,
                    directory=False,
                    private_material=not _is_public_certificate(filename),
                    allowed_acl_uids=allowed_acl_uids,
                )
            )
    except (ConfigurationCheckError, OSError):
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

    render_secure = subparsers.add_parser("render-secure")
    render_secure.add_argument("--file", required=True, type=Path)
    render_secure.add_argument("--output", required=True, type=Path)

    paths = subparsers.add_parser("paths")
    paths.add_argument("--file", required=True, type=Path)
    paths.add_argument("--directory-key", required=True)
    paths.add_argument("--allow-acl-uid", action="append", type=_acl_uid, default=[])
    paths.add_argument("filenames", nargs="+")

    args = parser.parse_args()
    if args.action == "migration":
        return migration_check(args.root)
    if args.action == "require":
        return require_settings(args.file, tuple(args.names))
    if args.action == "render-secure":
        try:
            render_secure_environment(args.file, args.output)
        except ConfigurationCheckError as error:
            print(f"BLOCKED: {error}", file=sys.stderr)
            return 1
        return 0
    return check_directory_setting(
        args.file,
        args.directory_key,
        tuple(args.filenames),
        allowed_acl_uids=frozenset(args.allow_acl_uid),
    )


if __name__ == "__main__":
    raise SystemExit(main())
