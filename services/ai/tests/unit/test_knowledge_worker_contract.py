import asyncio
import hashlib
import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from sme_meeting_ai.integrations.core_api import CoreError, KnowledgeCoreApiClient
from sme_meeting_ai.integrations.knowledge_indexing import decode_notification
from sme_meeting_ai.rag.tokenizer import bge_m3_index_generation
from sme_meeting_ai.workers.knowledge_indexing import indexing_receipt

ROOT = Path(__file__).resolve().parents[4]


def knowledge_event():
    meeting_id, source_id, event_id, snapshot_id = (str(uuid4()) for _ in range(4))
    body = {
        "contractVersion": "1.0",
        "schemaVersion": 1,
        "eventId": event_id,
        "occurredAt": "2026-10-31T12:00:00Z",
        "requestId": "request-1",
        "meetingId": meeting_id,
        "sourceIdentity": {"sourceType": "SUMMARY", "sourceId": source_id, "meetingId": meeting_id},
        "sourceRevision": {"number": 4},
        "operation": "UPSERT",
        "snapshot": {"snapshotId": snapshot_id, "sha256": "a" * 64, "sizeBytes": 100},
        "indexGeneration": {
            "generationId": "rag-t02-bge-m3-v1",
            "configurationVersion": "rag-t02-bge-m3-v1",
            "configurationSha256": "b" * 64,
            "tokenizerId": "tokenizer",
        },
        "reason": "NEW_REVISION",
    }
    delivery = SimpleNamespace(
        body=json.dumps(body).encode(),
        content_type="application/json",
        delivery_mode=2,
        routing_key="knowledge.indexing.requested",
        exchange="meeting.processing",
        message_id=event_id,
        redelivered=False,
        headers={
            "eventId": event_id,
            "eventType": "KNOWLEDGE_INDEXING_REQUESTED",
            "eventSchemaVersion": 1,
        },
    )
    return decode_notification(delivery)


def claim_payload(event):
    return {
        "contractVersion": "1.0",
        "eventId": event.event_id,
        "meetingId": event.meeting_id,
        "sourceIdentity": event.source_identity.model_dump(mode="json", by_alias=True),
        "sourceRevision": event.source_revision.model_dump(
            mode="json", by_alias=True, exclude_none=True,
        ),
        "snapshot": event.snapshot.model_dump(mode="json", by_alias=True),
        "indexGeneration": event.index_generation.model_dump(mode="json", by_alias=True),
        "claimToken": str(uuid4()),
        "leaseExpiresAt": "2026-10-31T12:30:00Z",
        "serverTime": "2026-10-31T12:00:00Z",
        "leaseSeconds": 1800,
        "renewAfterSeconds": 600,
        "replay": False,
    }


def test_approved_generation_artifact_matches_real_bge_generation():
    artifact = json.loads((ROOT / "contracts/RAG_T05_BGE_M3_INDEX_GENERATION_V1.json").read_text())
    generation = bge_m3_index_generation(
        generation_id=artifact["generationId"],
        configuration_version=artifact["configurationVersion"],
        **{
            "max_tokens": artifact["configuration"]["maxTokens"],
            "target_tokens": artifact["configuration"]["targetTokens"],
            "max_temporal_gap_ms": artifact["configuration"]["maxTemporalGapMs"],
            "max_units_per_chunk": artifact["configuration"]["maxUnitsPerChunk"],
        },
    )

    assert generation.tokenizer_id == artifact["tokenizerId"]
    assert generation.configuration_sha256 == artifact["configurationSha256"]


def test_indexing_receipt_is_canonical_and_deterministic():
    event_id = str(uuid4())
    fields = dict(
        event_id=event_id,
        meeting_id=str(uuid4()),
        source_type="SUMMARY",
        source_id=str(uuid4()),
        source_revision=3,
        snapshot_id=str(uuid4()),
        snapshot_sha256="a" * 64,
        snapshot_size_bytes=100,
        generation_id="rag-t02-bge-m3-v1",
        configuration_version="rag-t02-bge-m3-v1",
        configuration_sha256="b" * 64,
        tokenizer_id="tokenizer",
        outcome="INDEXED",
        chunk_count=2,
        point_ids=("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"),
        error_code="NONE",
    )

    first = indexing_receipt(**fields)
    second = indexing_receipt(**{**fields, "point_ids": tuple(reversed(fields["point_ids"]))})

    assert first == second
    assert first == hashlib.sha256(
        json.dumps(
            {
                "chunkCount": 2,
                "configurationSha256": "b" * 64,
                "configurationVersion": "rag-t02-bge-m3-v1",
                "contractVersion": "1.0",
                "errorCode": "NONE",
                "eventId": event_id,
                "generationId": "rag-t02-bge-m3-v1",
                "meetingId": fields["meeting_id"],
                "outcome": "INDEXED",
                "pointIds": sorted(fields["point_ids"]),
                "snapshotId": fields["snapshot_id"],
                "snapshotSha256": "a" * 64,
                "snapshotSizeBytes": 100,
                "sourceId": fields["source_id"],
                "sourceRevision": 3,
                "sourceType": "SUMMARY",
                "tokenizerId": "tokenizer",
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode(),
    ).hexdigest()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda payload: payload["sourceIdentity"].update(sourceType="TRANSCRIPT"),
        lambda payload: payload["sourceRevision"].update(number=5),
        lambda payload: payload["snapshot"].update(sizeBytes=101),
        lambda payload: payload["indexGeneration"].update(generationId="rag-t03-v1"),
        lambda payload: payload["indexGeneration"].update(configurationSha256="c" * 64),
        lambda payload: payload["indexGeneration"].update(tokenizerId="other-tokenizer"),
    ],
)
def test_claim_response_is_bound_to_the_exact_event_revision_and_generation(mutation):
    event = knowledge_event()
    payload = claim_payload(event)
    changed = deepcopy(payload)
    mutation(changed)

    with pytest.raises(CoreError) as caught:
        KnowledgeCoreApiClient.decode_knowledge_response(event, "claim", changed)

    assert caught.value.code == "WORKER_IDENTITY_CONFLICT"


def test_claim_request_omits_optional_source_revision_fields():
    event = knowledge_event()

    class CaptureClient(KnowledgeCoreApiClient):
        async def request_knowledge(self, _event, _operation, body=None, **_options):
            self.body = body
            return None

    client = CaptureClient.__new__(CaptureClient)
    asyncio.run(client.claim(event, claim_request_id=uuid4()))

    assert client.body["sourceRevision"] == {"number": event.source_revision.number}
