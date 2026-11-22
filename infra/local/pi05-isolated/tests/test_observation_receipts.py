"""Offline tests for independent observer receipt emission."""

from __future__ import annotations

from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path
import sys
from uuid import uuid4

import pytest


HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from observation_receipts import Observation, ReceiptWriter  # noqa: E402


def directories(tmp_path):
    proofs = tmp_path / "proofs"
    sources = tmp_path / "sources"
    proofs.mkdir(mode=0o700)
    sources.mkdir(mode=0o700)
    return proofs, sources


def observation():
    return Observation(
        run_id=str(uuid4()),
        request_id=str(uuid4()),
        step="qdrant-points",
        component="QDRANT",
        observed_result="INDEXED",
        observed_at=datetime.now(UTC),
    )


def test_writer_emits_content_addressed_receipt_and_source(tmp_path):
    proofs, sources = directories(tmp_path)
    item = observation()
    digest = ReceiptWriter(proofs, sources).write(
        item,
        {"boundary": "QDRANT", "pointCount": 4, "tlsLeafSha256": "a" * 64},
    )

    proof = proofs / f"{digest}.json"
    source = sources / f"{digest}.json"
    raw = proof.read_bytes()
    record = json.loads(raw)
    source_record = json.loads(source.read_bytes())

    assert hashlib.sha256(raw).hexdigest() == digest
    assert record["step"] == "qdrant-points"
    assert record["observedResult"] == "INDEXED"
    assert source_record["proofSha256"] == digest
    assert source_record["pointCount"] == 4
    assert proof.stat().st_mode & 0o777 == 0o600
    assert source.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize(
    "source",
    [
        {"authorization": "never-retain"},
        {"nested": {"transcriptText": "never-retain"}},
        {"tooLarge": "x" * 5000},
    ],
)
def test_writer_rejects_sensitive_or_oversized_source(tmp_path, source):
    proofs, sources = directories(tmp_path)

    with pytest.raises(ValueError):
        ReceiptWriter(proofs, sources).write(observation(), source)

    assert list(proofs.iterdir()) == []
    assert list(sources.iterdir()) == []


def test_writer_is_exclusive_and_validates_observation_identity(tmp_path):
    proofs, sources = directories(tmp_path)
    writer = ReceiptWriter(proofs, sources)
    item = observation()
    digest = writer.write(item, {"boundary": "QDRANT"})

    with pytest.raises(ValueError, match="already exists"):
        writer.write(item, {"boundary": "QDRANT"})

    with pytest.raises(ValueError):
        Observation(
            run_id=item.run_id,
            request_id=item.request_id,
            step="qdrant-points",
            component="NOT_A_COMPONENT",
            observed_result="INDEXED",
            observed_at=item.observed_at,
        )

    assert (proofs / f"{digest}.json").exists()
