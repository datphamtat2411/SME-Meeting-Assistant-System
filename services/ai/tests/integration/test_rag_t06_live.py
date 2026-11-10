"""Opt-in T06 acceptance driver for an isolated Core/AI/Qdrant harness.

The harness is deliberately external to the application packages. It creates
synthetic canonical sources through Core, runs the real worker and broker, and
returns only bounded acceptance evidence. Production or shared endpoints must
never be used for this test.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import pytest

pytestmark = [pytest.mark.evaluation, pytest.mark.live_infrastructure]

_SCENARIOS = {
    "revision-replacement": (
        "oldRevisionRejected",
        "currentRevisionAccepted",
        "supersededWorkRecorded",
    ),
    "invalidate-delete": (
        "invalidatedEvidenceRejected",
        "deletedEvidenceRejected",
        "unrelatedEvidencePreserved",
    ),
    "reindex-generation": (
        "sameRevisionReindexIdempotent",
        "generationCollectionsIsolated",
        "activationReadinessEnforced",
    ),
    "reconciliation": (
        "staleFindingRecorded",
        "repairCheckpointed",
        "repairIdempotent",
    ),
    "recovery": (
        "duplicateDeliveryIdempotent",
        "leaseLossFenced",
        "workerRestartRecovered",
    ),
}


def _client() -> httpx.Client:
    if os.getenv("AI_RUN_RAG_T06_LIVE") != "1":
        pytest.skip("Set AI_RUN_RAG_T06_LIVE=1 to run the real T06 acceptance test")
    base_url = os.getenv("AI_T06_HARNESS_URL")
    if not base_url:
        pytest.skip("AI_T06_HARNESS_URL is not configured")
    run_id = os.getenv("AI_T06_RUN_ID")
    if not run_id:
        pytest.skip("AI_T06_RUN_ID is not configured")
    ca_file = os.getenv("AI_T06_HARNESS_CA_FILE")
    cert_file = os.getenv("AI_T06_HARNESS_CLIENT_CERT_FILE")
    key_file = os.getenv("AI_T06_HARNESS_CLIENT_KEY_FILE")
    if not all((ca_file, cert_file, key_file)):
        pytest.skip("AI_T06_HARNESS_CA_FILE and client mTLS files are not configured")
    for name, value in (
        ("AI_T06_HARNESS_CA_FILE", ca_file),
        ("AI_T06_HARNESS_CLIENT_CERT_FILE", cert_file),
        ("AI_T06_HARNESS_CLIENT_KEY_FILE", key_file),
    ):
        if not Path(value).is_file():
            pytest.skip(f"{name} is not provisioned")
    return httpx.Client(
        base_url=base_url.rstrip("/"),
        verify=ca_file,
        cert=(cert_file, key_file),
        trust_env=False,
        timeout=30,
        follow_redirects=False,
        headers={"X-T06-Run-Id": run_id},
    )


@pytest.mark.parametrize("scenario,required_evidence", _SCENARIOS.items())
def test_real_t06_lifecycle_scenario(scenario, required_evidence):
    """Run one scenario through a real isolated harness and require evidence."""

    with _client() as client:
        response = client.post(
            f"/v1/rag/t06/scenarios/{scenario}",
            json={
                "runId": os.environ["AI_T06_RUN_ID"],
                "generationId": os.getenv("AI_RAG_INDEX_GENERATION_ID", "rag-t02-bge-m3-v1"),
                "collectionName": os.getenv("AI_RAG_QDRANT_COLLECTION", ""),
            },
        )
        assert response.status_code == 200, response.text[:512]
        payload = response.json()
        assert isinstance(payload, dict)
        assert payload.get("status") == "PASS"
        evidence = payload.get("evidence")
        assert isinstance(evidence, dict)
        assert all(evidence.get(key) is True for key in required_evidence), json.dumps(
            {"scenario": scenario, "evidence": evidence}, sort_keys=True
        )
