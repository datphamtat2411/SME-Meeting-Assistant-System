"""Opt-in PI-05 real isolated-infrastructure acceptance driver.

No in-memory substitute is accepted here. The external harness must run real
Core, AI, RabbitMQ, Qdrant, PostgreSQL and object storage. Missing prerequisites are NOT_RUN when disabled and are hard failures when an
operator explicitly enables live execution; no skip can conceal a broken run.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

import httpx
import pytest
from pi05_live_contract import REQUIRED, validate_live_evidence, verify_proof_files

pytestmark = [pytest.mark.evaluation, pytest.mark.live_infrastructure]


def _client() -> httpx.Client:
    if os.getenv("AI_RUN_PI05_LIVE") != "1":
        pytest.skip("PI-05 live E2E is not enabled")
    if os.getenv("AI_PI05_ENVIRONMENT_KIND") != "DISPOSABLE":
        pytest.fail("PI-05 live requires a disposable isolated environment")
    url = os.getenv("AI_PI05_HARNESS_URL")
    if not url:
        pytest.fail("PI-05 live harness is not provisioned")
    parts = urlsplit(url)
    if (
        parts.scheme != "https" or not parts.hostname or parts.username or parts.password
        or parts.query or parts.fragment or parts.path not in ("", "/")
    ):
        pytest.fail("PI-05 harness must be an HTTPS origin without credentials")
    # Never target a public production hostname merely because a test toggle
    # was accidentally enabled. Private-address or loopback origins only.
    try:
        ip = ipaddress.ip_address(parts.hostname)
        safe = ip.is_private or ip.is_loopback
    except ValueError:
        safe = parts.hostname.lower() == "localhost" or parts.hostname.lower().endswith(
            (".internal", ".test")
        )
    if not safe:
        pytest.fail("PI-05 live harness is not a private/isolation-scoped endpoint")
    evidence_dir = os.getenv("AI_PI05_EVIDENCE_DIR")
    proof_dir = os.getenv("AI_PI05_PROOF_DIR")
    if not proof_dir or not Path(proof_dir).is_dir() or Path(proof_dir).is_symlink():
        pytest.fail("PI-05 independently collected proof directory must exist before live faults")
    if not evidence_dir or not Path(evidence_dir).is_dir() or Path(evidence_dir).is_symlink():
        pytest.fail("PI-05 evidence directory must exist BEFORE invoking destructive scenarios")
    files = {
        name: os.getenv(name) for name in (
            "AI_PI05_CA_FILE", "AI_PI05_CERT_FILE", "AI_PI05_KEY_FILE",
        )
    }
    if not all(value and Path(value).is_file() for value in files.values()):
        pytest.fail("PI-05 mTLS identity or CA files are not provisioned")
    return httpx.Client(
        base_url=url.rstrip("/"),
        verify=files["AI_PI05_CA_FILE"],
        cert=(files["AI_PI05_CERT_FILE"], files["AI_PI05_KEY_FILE"]),
        timeout=60,
        follow_redirects=False,
        trust_env=False,
    )


@pytest.mark.parametrize("scenario", list(REQUIRED))
def test_pi05_real_system_scenario(scenario):
    run_id = os.getenv("AI_PI05_RUN_ID", "")
    sha = os.getenv("AI_PI05_SOURCE_COMMIT", "")
    generation = os.getenv("AI_PI05_GENERATION_ID", "")
    collection = os.getenv("AI_PI05_COLLECTION_NAME", "")
    if (
        not run_id or not re.fullmatch(r"[0-9a-f]{40}", sha)
        or not generation or not collection
    ):
        if os.getenv("AI_RUN_PI05_LIVE") == "1":
            pytest.fail("PI-05 pinned run/commit/generation/collection provenance is required")
        pytest.skip("PI-05 live execution is not enabled")
    try:
        UUID(run_id)
    except ValueError:
        pytest.fail("PI-05 run ID must be a UUID")
    with _client() as client:
        response = client.post(
            f"/v1/pi05/scenarios/{scenario}",
            json={
                "contractVersion": "1.0",
                "runId": run_id,
                "sourceCommit": sha,
                "generationId": generation,
                "collectionName": collection,
            },
        )
        assert response.status_code == 200, f"{scenario}: unexpected harness HTTP status"
        payload = response.json()
        validate_live_evidence(
            scenario, payload, run_id=run_id, commit=sha,
            generation=generation, collection=collection,
        )
        proof_dir = os.environ.get("AI_PI05_PROOF_DIR")
        if not proof_dir:
            pytest.fail("PI-05 independently captured proof directory is required")
        verify_proof_files(payload, Path(proof_dir))
        # Retain only the already schema-validated, sanitized evidence. Exclusive
        # creation avoids overwriting observations from a prior real test run.
        evidence_dir = os.environ.get("AI_PI05_EVIDENCE_DIR")
        if not evidence_dir:
            pytest.fail("PI-05 live evidence directory is required")
        destination = Path(evidence_dir)
        if not destination.is_dir() or destination.is_symlink():
            pytest.fail("PI-05 evidence directory must be preprovisioned")
        path = destination / f"{run_id}-{scenario}.json"
        try:
            # Mode 0600 even if the environment has an overly permissive umask.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(payload, output, indent=2, sort_keys=True)
                output.write("\n")
        except FileExistsError:
            pytest.fail("PI-05 evidence already exists; use a new isolated run ID")
