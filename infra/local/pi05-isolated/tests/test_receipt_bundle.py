"""Synthetic unit-only tests; these receipts are never live acceptance evidence."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
from uuid import uuid4

import pytest
from pi05_live_contract import REQUIRED, verify_proof_files

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pi05_receipt_bundle", HERE / "receipt_bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)

RUN = str(uuid4())
COMMIT = "a" * 40
GENERATION = "unit-generation"
COLLECTION = "unit-collection"
ENVIRONMENT = {
    "disposable": True,
    "environmentId": "unit-fixture",
    "coreBuild": COMMIT,
    "aiBuild": COMMIT,
    "flywayVersion": "V59",
    "tlsMode": "MTLS",
    "generationId": GENERATION,
    "collectionName": COLLECTION,
}


def receipt(root, *, step, component, outcome, run=RUN, request=None):
    record = {
        "runId": run,
        "requestId": request or str(uuid4()),
        "step": step,
        "component": component,
        "observedResult": outcome,
        "observedAt": "2026-01-01T00:00:00Z",
    }
    raw = json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
    digest = hashlib.sha256(raw).hexdigest()
    path = root / f"{digest}.json"
    path.write_bytes(raw)
    path.chmod(0o600)
    return digest


def receipts(root, scenario="room-notification"):
    return [
        receipt(root, step=step, component=component, outcome=outcome)
        for step, (component, outcome) in REQUIRED[scenario].items()
    ]


def assemble(root, hashes, scenario="room-notification", environment=ENVIRONMENT):
    return bundle.assemble(
        scenario=scenario, run_id=RUN, commit=COMMIT, generation=GENERATION,
        collection=COLLECTION, environment=environment, proof_dir=root, digests=hashes,
    )


def test_assembles_only_existing_verified_observer_receipts(tmp_path):
    hashes = receipts(tmp_path)
    payload = assemble(tmp_path, hashes)
    assert payload["status"] == "PASS"
    assert {item["proofSha256"] for item in payload["observations"]} == set(hashes)
    verify_proof_files(payload, tmp_path)
    assert len(list(tmp_path.iterdir())) == len(hashes)


@pytest.mark.parametrize("problem", ["missing", "tampered", "symlink", "duplicate", "malformed"])
def test_rejects_unverifiable_receipts(tmp_path, problem):
    hashes = receipts(tmp_path)
    path = tmp_path / f"{hashes[0]}.json"
    if problem == "missing":
        path.unlink()
    elif problem == "tampered":
        path.write_text("{}")
    elif problem == "symlink":
        path.unlink()
        path.symlink_to(tmp_path / f"{hashes[1]}.json")
    elif problem == "duplicate":
        hashes[-1] = hashes[0]
    else:
        hashes[0] = "../not-a-sha256"
    with pytest.raises(ValueError):
        assemble(tmp_path, hashes)


@pytest.mark.parametrize("wrong", ["outcome", "component", "run", "step"])
def test_rejects_unrelated_or_incomplete_observations(tmp_path, wrong):
    hashes = receipts(tmp_path)
    first_step, (component, outcome) = next(iter(REQUIRED["room-notification"].items()))
    changes = {
        "step": first_step,
        "component": component,
        "outcome": outcome,
        "run": RUN,
    }
    changes[wrong] = {
        "outcome": "UNEXPECTED",
        "component": "AI",
        "run": str(uuid4()),
        "step": "unrelated-step",
    }[wrong]
    hashes[0] = receipt(tmp_path, **changes)
    with pytest.raises(ValueError):
        assemble(tmp_path, hashes)


def test_rejects_foreign_build_and_symbolic_proof_directory(tmp_path):
    hashes = receipts(tmp_path)
    with pytest.raises(ValueError):
        assemble(tmp_path, hashes, environment={**ENVIRONMENT, "coreBuild": "b" * 40})
    symbolic = tmp_path.parent / (tmp_path.name + "-link")
    symbolic.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError):
        assemble(symbolic, hashes)


def test_later_tampering_is_still_detected_by_original_verifier(tmp_path):
    hashes = receipts(tmp_path)
    payload = assemble(tmp_path, hashes)
    (tmp_path / f"{hashes[0]}.json").write_text("{}")
    with pytest.raises(ValueError):
        verify_proof_files(payload, tmp_path)
