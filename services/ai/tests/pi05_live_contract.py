"""Strict PI-05 live-evidence schema; never accept bare scenario PASS booleans."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from uuid import UUID

# Every required observation must have the named component and actual outcome.
# The harness is responsible for producing source-backed sanitized proof digests.
REQUIRED = {
    "full-pipeline": {
        "meeting-record": ("CORE", "PERSISTED"),
        "source-media-verified": ("STORAGE", "VERIFIED"),
        "broker-message-delivered": ("RABBITMQ", "DELIVERED"),
        "media-worker-completed": ("AI", "COMPLETED"),
        "transcript-current": ("CORE", "READY"),
        "intelligence-proposal": ("CORE", "PROPOSED"),
        "human-decision-confirmed": ("CORE", "CONFIRMED"),
        "qdrant-points": ("QDRANT", "INDEXED"),
        "assistant-grounded": ("CORE", "GROUNDED"),
    },
    "revision-retrieval": {
        "transcript-revised": ("CORE", "NEW_REVISION"),
        "old-revision-rejected": ("AI", "REJECTED"),
        "new-revision-retrieved": ("AI", "CURRENT"),
    },
    "membership-revocation": {
        "authorized-before": ("CORE", "AUTHORIZED"),
        "revoked-during-generation": ("CORE", "REVOKED"),
        "assistant-citation-redacted": ("CORE", "REDACTED"),
    },
    "broker-redelivery": {
        "broker-redelivered": ("RABBITMQ", "REDELIVERED"),
        "worker-idempotent": ("AI", "IDEMPOTENT"),
        "core-single-result": ("CORE", "SINGLE_COMMIT"),
    },
    "worker-restart": {
        "original-lease-expired": ("CORE", "LEASE_EXPIRED"),
        "old-owner-fenced": ("CORE", "REJECTED"),
        "restarted-worker-recovered": ("AI", "RECOVERED"),
    },
    "qdrant-outage": {
        "qdrant-outage-observed": ("QDRANT", "UNAVAILABLE"),
        "core-failed-closed": ("CORE", "FAILED"),
        "reconciliation-resumed": ("CORE", "COMPLETED"),
    },
    "inventory-coverage": {
        "missing-work-reported": ("CORE", "MISSING_WORK"),
        "orphan-point-reported": ("CORE", "ORPHANED_POINTS"),
        "unsafe-auto-delete-prevented": ("CORE", "MANUAL_REVIEW"),
    },
    "generation-rollback": {
        "incomplete-candidate-rejected": ("CORE", "REJECTED"),
        "clean-candidate-activated": ("CORE", "ACTIVE"),
        "old-generation-rollback": ("CORE", "ACTIVE"),
    },
    "export-revocation": {
        "historical-export-stale": ("CORE", "STALE"),
        "revoke-download-access": ("CORE", "DENIED"),
        "historical-record-preserved": ("CORE", "PRESERVED"),
    },
    "room-notification": {
        "overlap-rejected": ("CORE", "CONFLICT"),
        "cancellation-released-room": ("CORE", "RELEASED"),
        "notification-recovered": ("CORE", "DELIVERED"),
    },
}
_ALLOWED_COMPONENTS = {"CORE", "AI", "RABBITMQ", "QDRANT", "STORAGE"}
_UNSAFE = re.compile(
    r"password|privatekey|clientkey|secret|accesstoken|refreshtoken|"
    r"authorization|presigned|signedurl|audio|transcripttext|prompt|rawcontent",
    re.IGNORECASE,
)


def _uuid(value: object) -> bool:
    try:
        return isinstance(value, str) and str(UUID(value)) == value.lower()
    except (ValueError, TypeError, AttributeError):
        return False


def _safe_fields(value: object) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or _UNSAFE.search(key):
                raise ValueError("Protected evidence field")
            _safe_fields(item)
    elif isinstance(value, list):
        for item in value:
            _safe_fields(item)


def validate_live_evidence(
    scenario: str, payload: object, *, run_id: str, commit: str, generation: str,
    collection: str,
) -> None:
    if scenario not in REQUIRED:
        raise ValueError("Unknown PI-05 live scenario")
    if not isinstance(payload, dict):
        raise ValueError("Live evidence must be a JSON object")
    if set(payload) != {"contractVersion", "scenario", "status", "runId",
                        "sourceCommit", "environment", "observations"}:
        raise ValueError("Unexpected or missing top-level evidence fields")
    _safe_fields(payload)
    if payload.get("contractVersion") != "1.0" or payload.get("scenario") != scenario:
        raise ValueError("Live evidence contract mismatch")
    if payload.get("status") != "PASS" or payload.get("runId") != run_id or not _uuid(run_id):
        raise ValueError("Live run identity or outcome mismatch")
    if payload.get("sourceCommit") != commit or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Live code revision not pinned")

    environment = payload.get("environment")
    if not isinstance(environment, dict) or environment.get("disposable") is not True:
        raise ValueError("Live environment is not declared disposable")
    if set(environment) != {"disposable", "environmentId", "coreBuild", "aiBuild",
                            "flywayVersion", "tlsMode", "generationId", "collectionName"}:
        raise ValueError("Incomplete or overbroad environment evidence")
    if environment.get("coreBuild") != commit or environment.get("aiBuild") != commit:
        raise ValueError("Reported service build does not match source commit")
    migration = environment.get("flywayVersion")
    if not isinstance(migration, str) or not re.fullmatch(r"V[0-9]+", migration) or int(migration[1:]) < 51:
        raise ValueError("Observed Core schema version is not current enough")
    for key in ("environmentId", "coreBuild", "aiBuild", "flywayVersion"):
        if not isinstance(environment.get(key), str) or not environment[key].strip():
            raise ValueError("Incomplete real-service provenance")
    # A well-formed claim is not proof of an isolated environment, but do not
    # accept arbitrary paths/URLs or operator notes in the evidence identifier.
    identity = environment.get("environmentId")
    if (not isinstance(identity, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{2,127}", identity)
            or identity.casefold() in {"prod", "production", "live", "main"}):
        raise ValueError("Isolated environment identifier is invalid")
    if environment.get("tlsMode") != "MTLS":
        raise ValueError("Service boundary did not report mTLS")
    if environment.get("generationId") != generation or environment.get("collectionName") != collection:
        raise ValueError("Vector generation or collection mismatch")

    observations = payload.get("observations")
    if not isinstance(observations, list) or len(observations) != len(REQUIRED[scenario]):
        raise ValueError("Missing or excessive observation identities")
    seen: set[str] = set()
    observed_requests: set[str] = set()
    observed_proofs: set[str] = set()
    for record in observations:
        if not isinstance(record, dict):
            raise ValueError("Malformed live observation")
        if set(record) != {"step", "component", "observedResult", "runId",
                           "requestId", "proofSha256", "observedAt"}:
            raise ValueError("Incomplete or overbroad live observation")
        identity = record.get("step")
        if not isinstance(identity, str) or identity not in REQUIRED[scenario] or identity in seen:
            raise ValueError("Missing, repeated or unknown observation step")
        seen.add(identity)
        component, outcome = REQUIRED[scenario][identity]
        if record.get("component") != component or component not in _ALLOWED_COMPONENTS:
            raise ValueError("Wrong evidence service boundary")
        if record.get("observedResult") != outcome:
            raise ValueError("Observed result does not satisfy the acceptance invariant")
        request_id = record.get("requestId")
        if record.get("runId") != run_id or not _uuid(request_id):
            raise ValueError("Observation cannot be correlated to a real request")
        if request_id in observed_requests:
            raise ValueError("Observations cannot reuse the same request ID")
        observed_requests.add(request_id)
        proof = record.get("proofSha256")
        if not isinstance(proof, str) or not re.fullmatch(r"[0-9a-f]{64}", proof):
            raise ValueError("Missing immutable proof digest")
        if proof in observed_proofs:
            raise ValueError("Observations cannot reuse unrelated proof digests")
        observed_proofs.add(proof)
        observed_at = record.get("observedAt")
        if not isinstance(observed_at, str):
            raise ValueError("Missing observation timestamp")
        try:
            timestamp = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("Invalid observation timestamp") from error
        if timestamp.utcoffset() is None:
            raise ValueError("Observation time must be timezone-aware")
    if seen != set(REQUIRED[scenario]):
        raise ValueError("Incomplete live acceptance observations")



def verify_proof_files(payload: dict, root: Path) -> None:
    """Verify every claimed digest against a separate content-addressed receipt.

    Receipts are emitted by the isolated observer, not synthesized from the
    harness's PASS response. This verifies integrity, not the observer's honesty:
    independent operator review of underlying system logs remains mandatory.
    """
    import hashlib
    import json

    if not isinstance(root, Path) or not root.is_dir() or root.is_symlink():
        raise ValueError("Proof directory missing or symbolic")
    for observation in payload["observations"]:
        digest = observation["proofSha256"]
        path = root / (digest + ".json")
        if path.is_symlink() or not path.is_file():
            raise ValueError("Missing independently captured proof receipt")
        if path.stat().st_size > 4096:
            raise ValueError("Proof receipt exceeds bound")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError("Proof receipt SHA-256 does not match claim")
        try:
            receipt = json.loads(raw)
        except (ValueError, UnicodeError) as error:
            raise ValueError("Invalid proof receipt JSON") from error
        if not isinstance(receipt, dict) or set(receipt) != {
            "runId", "requestId", "step", "component", "observedResult", "observedAt",
        }:
            raise ValueError("Unexpected receipt schema")
        _safe_fields(receipt)
        if any(receipt[key] != observation[key] for key in receipt):
            raise ValueError("Receipt and observation disagree")
