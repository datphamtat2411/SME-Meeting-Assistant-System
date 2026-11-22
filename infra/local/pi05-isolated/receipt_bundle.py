"""Assemble a PI-05 response from separately collected, immutable receipts.

This module does not run scenarios, observe services, write proof files, or prove
the observer's independence. The operator must review the underlying source logs.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
AI_TESTS = ROOT / "services" / "ai" / "tests"
if str(AI_TESTS) not in sys.path:
    sys.path.insert(0, str(AI_TESTS))

from pi05_live_contract import REQUIRED, validate_live_evidence, verify_proof_files  # noqa: E402


def _read_receipt(root: Path, digest: str) -> dict:
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError("Invalid observer receipt digest")
    try:
        descriptor = os.open(root / (digest + ".json"), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as source:
            info = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_nlink != 1
                or info.st_mode & 0o077
                or info.st_size > 4096
            ):
                raise ValueError("Invalid observer receipt file")
            raw = source.read(4097)
    except OSError as error:
        raise ValueError("Observer receipt is unavailable") from error
    if len(raw) > 4096 or hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("Observer receipt digest mismatch")
    try:
        record = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise ValueError("Invalid observer receipt JSON") from error
    if not isinstance(record, dict) or set(record) != {
        "runId", "requestId", "step", "component", "observedResult", "observedAt",
    }:
        raise ValueError("Unexpected observer receipt schema")
    return record


def assemble(
    *, scenario: str, run_id: str, commit: str, generation: str, collection: str,
    environment: dict, proof_dir: Path, digests: list[str],
) -> dict:
    """Validate receipt hashes and the unchanged PI-05 contract; write nothing."""
    if not isinstance(scenario, str) or scenario not in REQUIRED:
        raise ValueError("Unknown PI-05 scenario")
    if not isinstance(proof_dir, Path) or proof_dir.is_symlink() or not proof_dir.is_dir():
        raise ValueError("Independent proof directory is unavailable")
    directory_info = proof_dir.stat()
    if directory_info.st_uid != os.getuid() or directory_info.st_mode & 0o077:
        raise ValueError("Independent proof directory must be private")
    if not isinstance(digests, (list, tuple)) or len(digests) != len(REQUIRED[scenario]):
        raise ValueError("Every required observation needs a separate receipt")
    if not isinstance(environment, dict):
        raise ValueError("Observed environment details are required")
    observations = [
        {**_read_receipt(proof_dir, digest), "proofSha256": digest} for digest in digests
    ]
    payload = {
        "contractVersion": "1.0",
        "scenario": scenario,
        "status": "PASS",
        "runId": run_id,
        "sourceCommit": commit,
        "environment": dict(environment),
        "observations": observations,
    }
    validate_live_evidence(
        scenario, payload, run_id=run_id, commit=commit,
        generation=generation, collection=collection,
    )
    verify_proof_files(payload, proof_dir)
    return payload
