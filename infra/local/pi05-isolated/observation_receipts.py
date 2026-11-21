#!/usr/bin/env python3
"""Write one sanitized, content-addressed observation from an observer process.

This module records an observation made elsewhere; it does not contact a
service and cannot establish that the caller was independent.  Source records
are bounded audit aids and must never contain payloads, credentials or content.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
from uuid import UUID


_COMPONENTS = frozenset({"CORE", "AI", "RABBITMQ", "QDRANT", "STORAGE"})
_UNSAFE = re.compile(
    r"password|privatekey|clientkey|secret|accesstoken|refreshtoken|"
    r"authorization|presigned|signedurl|audio|transcripttext|prompt|rawcontent",
    re.IGNORECASE,
)
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
_DIGEST = re.compile(r"[0-9a-f]{64}")


def _private_directory(path: Path) -> None:
    path = Path(path)
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError("receipt directory cannot be symbolic")
    info = path.stat()
    if not path.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("receipt directory must be private and owner-controlled")


def _uuid(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("receipt identity must be a UUID")
    try:
        canonical = str(UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("receipt identity must be a UUID") from error
    if canonical != value:
        raise ValueError("receipt identity must be canonical")
    return canonical


def _safe_tree(value: object, *, depth: int = 0) -> None:
    if depth > 6:
        raise ValueError("source record is too deep")
    if isinstance(value, dict):
        if len(value) > 64:
            raise ValueError("source record has too many fields")
        for key, item in value.items():
            if (
                type(key) is not str
                or len(key) > 128
                or _UNSAFE.search(key)
            ):
                raise ValueError("source record contains a protected field")
            _safe_tree(item, depth=depth + 1)
        return
    if isinstance(value, (list, tuple)):
        if len(value) > 64:
            raise ValueError("source record has too many values")
        for item in value:
            _safe_tree(item, depth=depth + 1)
        return
    if isinstance(value, str):
        if len(value) > 512:
            raise ValueError("source record contains an oversized value")
        return
    if value is None or type(value) is bool or type(value) is int:
        return
    if type(value) is float and math.isfinite(value):
        return
    raise ValueError("source record contains an unsupported value")


def _canonical_json(value: object) -> bytes:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError("source record is not canonical JSON") from error


def _write_once(directory: Path, filename: str, raw: bytes) -> None:
    if len(raw) > 4096:
        raise ValueError("receipt exceeds size bound")
    try:
        descriptor = os.open(
            directory,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
        try:
            info = os.fstat(descriptor)
            if (
                not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_mode & 0o077
            ):
                raise ValueError("receipt directory is unsafe")
            output = os.open(
                filename,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=descriptor,
            )
            with os.fdopen(output, "wb") as stream:
                stream.write(raw)
        finally:
            os.close(descriptor)
    except FileExistsError as error:
        raise ValueError("receipt already exists") from error
    except OSError as error:
        raise ValueError("receipt output is unavailable") from error


@dataclass(frozen=True)
class Observation:
    run_id: str
    request_id: str
    step: str
    component: str
    observed_result: str
    observed_at: datetime

    def __post_init__(self) -> None:
        _uuid(self.run_id)
        _uuid(self.request_id)
        if not _SAFE_ID.fullmatch(self.step or ""):
            raise ValueError("observation step is invalid")
        if self.component not in _COMPONENTS:
            raise ValueError("observation component is invalid")
        if (
            not isinstance(self.observed_result, str)
            or not re.fullmatch(r"[A-Z][A-Z0-9_]{1,63}", self.observed_result)
        ):
            raise ValueError("observation result is invalid")
        if not isinstance(self.observed_at, datetime) or self.observed_at.tzinfo is None:
            raise ValueError("observation time must be timezone-aware")

    def record(self) -> dict[str, object]:
        return {
            "runId": self.run_id,
            "requestId": self.request_id,
            "step": self.step,
            "component": self.component,
            "observedResult": self.observed_result,
            "observedAt": self.observed_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        }


class ReceiptWriter:
    """Exclusively write one receipt and its separate sanitized source record."""

    def __init__(self, proof_dir: Path, source_dir: Path):
        _private_directory(proof_dir)
        _private_directory(source_dir)
        self.proof_dir = Path(proof_dir)
        self.source_dir = Path(source_dir)

    def write(self, observation: Observation, source: dict[str, object]) -> str:
        if not isinstance(observation, Observation) or not isinstance(source, dict):
            raise ValueError("observation and source record are required")
        _safe_tree(source)
        receipt = observation.record()
        raw = _canonical_json(receipt)
        digest = hashlib.sha256(raw).hexdigest()
        if not _DIGEST.fullmatch(digest):
            raise ValueError("receipt digest could not be generated")

        source_record = dict(source)
        identity = {
            "proofSha256": digest,
            "runId": observation.run_id,
            "requestId": observation.request_id,
            "observedAt": receipt["observedAt"],
        }
        for key, value in identity.items():
            if key in source_record and source_record[key] != value:
                raise ValueError("source identity disagrees with receipt")
            source_record[key] = value
        source_raw = _canonical_json(source_record)

        # Preserve a source record if proof installation fails; never replace
        # either artifact or hide an earlier observation.
        _write_once(self.source_dir, digest + ".json", source_raw)
        _write_once(self.proof_dir, digest + ".json", raw)
        return digest
