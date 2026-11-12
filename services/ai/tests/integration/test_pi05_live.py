"""Opt-in PI-05 real isolated-infrastructure acceptance driver.

No in-memory substitute is accepted here. The external harness must run real
Core, AI, RabbitMQ, Qdrant, PostgreSQL and object storage. Missing environment
requirements skip the test, never produce a false PASS.
"""
from __future__ import annotations

import ipaddress
import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

import httpx
import pytest
from pi05_live_contract import REQUIRED, validate_live_evidence

pytestmark = [pytest.mark.evaluation, pytest.mark.live_infrastructure]


def _client() -> httpx.Client:
    if os.getenv("AI_RUN_PI05_LIVE") != "1":
        pytest.skip("PI-05 live E2E is not enabled")
    if os.getenv("AI_PI05_ENVIRONMENT_KIND") != "DISPOSABLE":
        pytest.skip("A disposable isolated environment is mandatory")
    url = os.getenv("AI_PI05_HARNESS_URL")
    if not url:
        pytest.skip("No isolated PI-05 harness provisioned")
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
    files = {
        name: os.getenv(name) for name in (
            "AI_PI05_CA_FILE", "AI_PI05_CERT_FILE", "AI_PI05_KEY_FILE",
        )
    }
    if not all(value and Path(value).is_file() for value in files.values()):
        pytest.skip("PI-05 mTLS identity or CA files are not provisioned")
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
        pytest.skip("PI-05 run/commit/generation/collection provenance not configured")
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
        validate_live_evidence(
            scenario, response.json(), run_id=run_id, commit=sha,
            generation=generation, collection=collection,
        )
