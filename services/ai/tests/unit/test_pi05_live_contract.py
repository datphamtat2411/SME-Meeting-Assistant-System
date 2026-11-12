"""The PI-05 live contract rejects booleans, missing evidence and leaked secrets."""
from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
from uuid import uuid4

import pytest
from pi05_live_contract import REQUIRED, validate_live_evidence

RUN = str(uuid4())
SHA = "a" * 40
GEN = "rag-t02-bge-m3-v1"
COLL = "isolated-pi05"


def valid(scenario):
    return {
        "contractVersion": "1.0",
        "scenario": scenario,
        "status": "PASS",
        "runId": RUN,
        "sourceCommit": SHA,
        "environment": {
            "disposable": True,
            "environmentId": "isolated-lab",
            "coreBuild": SHA,
            "aiBuild": SHA,
            "flywayVersion": "V51",
            "tlsMode": "MTLS",
            "generationId": GEN,
            "collectionName": COLL,
        },
        "observations": [
            {
                "step": step,
                "component": component,
                "observedResult": outcome,
                "runId": RUN,
                "requestId": str(uuid4()),
                "proofSha256": sha256(f"{scenario}:{step}".encode()).hexdigest(),
                "observedAt": datetime.now(UTC).isoformat(),
            }
            for step, (component, outcome) in REQUIRED[scenario].items()
        ],
    }


@pytest.mark.parametrize("scenario", list(REQUIRED))
def test_all_live_scenarios_require_typed_observations(scenario):
    validate_live_evidence(
        scenario, valid(scenario), run_id=RUN, commit=SHA,
        generation=GEN, collection=COLL,
    )


def test_ai_proposal_cannot_be_falsely_reported_as_human_confirmation():
    scenario = "full-pipeline"
    payload = valid(scenario)
    proposed = next(o for o in payload["observations"] if o["step"] == "intelligence-proposal")
    proposed["observedResult"] = "ACCEPTED"
    with pytest.raises(ValueError):
        validate_live_evidence(scenario, payload, run_id=RUN, commit=SHA,
                               generation=GEN, collection=COLL)
    payload = valid(scenario)
    next(o for o in payload["observations"] if o["step"] == "human-decision-confirmed")["observedResult"] = "PROPOSED"
    with pytest.raises(ValueError):
        validate_live_evidence(scenario, payload, run_id=RUN, commit=SHA,
                               generation=GEN, collection=COLL)


def test_malformed_disposable_environment_identity_is_rejected():
    for bad in ("../prod", "https://prod.example", "production", "my isolated env"):
        payload = valid("full-pipeline")
        payload["environment"]["environmentId"] = bad
        with pytest.raises(ValueError):
            validate_live_evidence("full-pipeline", payload, run_id=RUN, commit=SHA,
                                   generation=GEN, collection=COLL)


def test_bare_pass_and_missing_step_fail():
    scenario = "full-pipeline"
    with pytest.raises(ValueError):
        validate_live_evidence(
            scenario, {"status": "PASS"}, run_id=RUN, commit=SHA,
            generation=GEN, collection=COLL,
        )
    payload = valid(scenario)
    payload["observations"].pop()
    with pytest.raises(ValueError):
        validate_live_evidence(scenario, payload, run_id=RUN, commit=SHA,
                               generation=GEN, collection=COLL)


def test_wrong_outcome_duplicate_step_and_revoked_tls_fail():
    scenario = "membership-revocation"
    payload = valid(scenario)
    payload["observations"][1]["observedResult"] = "AUTHORIZED"
    with pytest.raises(ValueError):
        validate_live_evidence(scenario, payload, run_id=RUN, commit=SHA,
                               generation=GEN, collection=COLL)
    payload = valid(scenario)
    payload["observations"][1]["step"] = payload["observations"][0]["step"]
    with pytest.raises(ValueError):
        validate_live_evidence(scenario, payload, run_id=RUN, commit=SHA,
                               generation=GEN, collection=COLL)
    payload = valid(scenario)
    payload["environment"]["tlsMode"] = "NONE"
    with pytest.raises(ValueError):
        validate_live_evidence(scenario, payload, run_id=RUN, commit=SHA,
                               generation=GEN, collection=COLL)


def test_untrusted_run_generation_or_secrets_fail():
    scenario = "generation-rollback"
    payload = valid(scenario)
    payload["environment"]["generationId"] = "other-generation"
    with pytest.raises(ValueError):
        validate_live_evidence(scenario, payload, run_id=RUN, commit=SHA,
                               generation=GEN, collection=COLL)
    payload = valid(scenario)
    payload["clientAccessToken"] = "sensitive"
    with pytest.raises(ValueError):
        validate_live_evidence(scenario, payload, run_id=RUN, commit=SHA,
                               generation=GEN, collection=COLL)


def test_evidence_without_timezone_or_digest_fails():
    scenario = "qdrant-outage"
    payload = valid(scenario)
    payload["observations"][0]["observedAt"] = "2026-11-12T04:00:00"
    with pytest.raises(ValueError):
        validate_live_evidence(scenario, payload, run_id=RUN, commit=SHA,
                               generation=GEN, collection=COLL)
    payload = valid(scenario)
    payload["observations"][0]["proofSha256"] = "PASS"
    with pytest.raises(ValueError):
        validate_live_evidence(scenario, payload, run_id=RUN, commit=SHA,
                               generation=GEN, collection=COLL)

def test_proof_receipts_are_external_and_content_verified(tmp_path):
    import hashlib
    import json

    from pi05_live_contract import verify_proof_files

    scenario = "room-notification"
    payload = valid(scenario)
    for observation in payload["observations"]:
        receipt = {key: observation[key] for key in (
            "runId", "requestId", "step", "component", "observedResult", "observedAt",
        )}
        raw = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(raw).hexdigest()
        observation["proofSha256"] = digest
        (tmp_path / f"{digest}.json").write_bytes(raw)
    verify_proof_files(payload, tmp_path)
    first = payload["observations"][0]["proofSha256"]
    (tmp_path / f"{first}.json").write_text('{"status":"PASS"}')
    with pytest.raises(ValueError, match="SHA-256"):
        verify_proof_files(payload, tmp_path)


def test_missing_proof_is_not_sufficient_to_claim_live_pass(tmp_path):
    from pi05_live_contract import verify_proof_files

    with pytest.raises(ValueError, match="Missing"):
        verify_proof_files(valid("qdrant-outage"), tmp_path)
