import asyncio
import hashlib
import json
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from sme_meeting_ai.integrations.core_api import (
    CoreError,
    KnowledgeCoreApiClient,
    KnowledgeSnapshotResponse,
)
from sme_meeting_ai.integrations.knowledge_indexing import decode_notification
from sme_meeting_ai.rag import (
    ActionItemProjection,
    ActionItemSnapshot,
    CanonicalSourceIdentity,
    SnapshotMetadata,
    SourceRevision,
    validate_snapshot,
)
from sme_meeting_ai.rag.tokenizer import bge_m3_index_generation
from sme_meeting_ai.workers import knowledge_indexing as knowledge_worker_module
from sme_meeting_ai.workers.knowledge_indexing import (
    KnowledgeIndexingWorker,
    KnowledgeWorkerFailure,
    indexing_receipt,
)

ROOT = Path(__file__).resolve().parents[4]


def serialized_action_item_snapshot():
    meeting_id, source_id, snapshot_id, assignee_id = (str(uuid4()) for _ in range(4))
    snapshot = ActionItemSnapshot(
        contract_version="1.0",
        snapshot_type="ACTION_ITEM",
        metadata=SnapshotMetadata(
            snapshot_id=snapshot_id,
            meeting_id=meeting_id,
            source_identity=CanonicalSourceIdentity(
                source_type="ACTION_ITEM", source_id=source_id, meeting_id=meeting_id,
            ),
            source_revision=SourceRevision(number=9),
        ),
        content=ActionItemProjection(
            id=source_id,
            meeting_id=meeting_id,
            title="Gửi bảng phân tích chi phí",
            details="Đính kèm các giả định và phương án thay thế.",
            status="OPEN",
            source_type="MANUAL",
            is_official=True,
            assignee_user_id=assignee_id,
            due_date="2026-11-20",
            version=9,
            evidence_segment_ids=(),
        ),
    )
    return snapshot, snapshot.model_dump_json(by_alias=True).encode()


def snapshot_event(snapshot, raw):
    return SimpleNamespace(
        meeting_id=snapshot.metadata.meeting_id,
        source_identity=snapshot.metadata.source_identity,
        source_revision=snapshot.metadata.source_revision,
        snapshot=SimpleNamespace(
            snapshot_id=snapshot.metadata.snapshot_id,
            sha256=hashlib.sha256(raw).hexdigest(),
            size_bytes=len(raw),
        ),
    )


class ImmediateGuard:
    deadline = 0.0

    async def protect(self, awaitable):
        return await awaitable


class SnapshotCore:
    def __init__(self, raw, event):
        self.response = KnowledgeSnapshotResponse(
            event.snapshot.snapshot_id,
            event.snapshot.sha256,
            event.snapshot.size_bytes,
            raw,
        )

    async def snapshot(self, _event, _claim, *, deadline):
        assert deadline == 0.0
        return self.response


def run_worker_snapshot(snapshot, raw):
    event = snapshot_event(snapshot, raw)
    worker = KnowledgeIndexingWorker(
        SimpleNamespace(knowledge_indexing_worker_concurrency=1),
        SnapshotCore(raw, event),
        None,
        None,
        None,
    )
    return event, asyncio.run(worker._snapshot(event, None, ImmediateGuard()))


def mutate_snapshot(raw, mutation):
    if mutation == "duplicate-key":
        text = raw.decode()
        needle = '"evidenceSegmentIds":[]'
        assert needle in text
        return text.replace(needle, needle + ',"evidenceSegmentIds":[]', 1).encode()

    payload = json.loads(raw)
    if mutation == "unknown-field":
        payload["unexpected"] = "sensitive snapshot content"
    elif mutation == "contract-version":
        payload["contractVersion"] = "2.0"
    elif mutation == "field-type":
        payload["content"]["evidenceSegmentIds"] = "not-an-array"
    elif mutation == "identity":
        payload["content"]["id"] = str(uuid4())
    elif mutation == "malformed-value":
        payload["content"]["dueDate"] = "not-a-date"
    return json.dumps(payload, separators=(",", ":")).encode()


def test_serialized_action_item_with_empty_evidence_array_uses_json_validation(monkeypatch):
    snapshot, raw = serialized_action_item_snapshot()
    seen = []
    original = knowledge_worker_module.validate_snapshot

    def capture(value):
        seen.append(value)
        return original(value)

    monkeypatch.setattr(knowledge_worker_module, "validate_snapshot", capture)
    assert validate_snapshot(raw).content.evidence_segment_ids == ()
    _, parsed = run_worker_snapshot(snapshot, raw)

    assert seen == [raw]
    assert parsed.content.evidence_segment_ids == ()
    assert isinstance(parsed.content.evidence_segment_ids, tuple)


@pytest.mark.parametrize(
    "mutation",
    ["duplicate-key", "unknown-field", "contract-version", "field-type", "identity", "malformed-value"],
)
def test_worker_boundary_rejects_invalid_snapshot_contracts_without_raw_details(mutation):
    snapshot, valid_raw = serialized_action_item_snapshot()
    raw = mutate_snapshot(valid_raw, mutation)

    with pytest.raises(KnowledgeWorkerFailure) as caught:
        run_worker_snapshot(snapshot, raw)

    assert caught.value.code == "SNAPSHOT_CONTRACT_INVALID"
    assert str(caught.value) == "SNAPSHOT_CONTRACT_INVALID"
    assert "sensitive snapshot content" not in str(caught.value)


def test_duplicate_keys_are_rejected_before_pydantic_json_validation(monkeypatch):
    snapshot, valid_raw = serialized_action_item_snapshot()
    raw = mutate_snapshot(valid_raw, "duplicate-key")
    calls = []

    def bypass(_value):
        calls.append(True)
        return snapshot

    monkeypatch.setattr(knowledge_worker_module, "validate_snapshot", bypass)
    with pytest.raises(KnowledgeWorkerFailure) as caught:
        run_worker_snapshot(snapshot, raw)

    assert caught.value.code == "SNAPSHOT_CONTRACT_INVALID"
    assert calls == []


@pytest.mark.parametrize("raw", [b"{", b"\xff"])
def test_worker_boundary_rejects_malformed_or_invalidly_encoded_json(raw):
    snapshot, _ = serialized_action_item_snapshot()

    with pytest.raises(KnowledgeWorkerFailure) as caught:
        run_worker_snapshot(snapshot, raw)

    assert caught.value.code == "SNAPSHOT_CONTRACT_INVALID"


def test_worker_boundary_rejects_oversized_snapshot():
    snapshot, _ = serialized_action_item_snapshot()
    raw = b"{" + b" " * (8 * 1024 * 1024) + b"}"

    with pytest.raises(KnowledgeWorkerFailure) as caught:
        run_worker_snapshot(snapshot, raw)

    assert caught.value.code == "SNAPSHOT_CONTRACT_INVALID"


def test_worker_boundary_rejects_snapshot_integrity_metadata_mismatch():
    snapshot, valid_raw = serialized_action_item_snapshot()
    payload = json.loads(valid_raw)
    payload["metadata"]["integrity"] = {"sha256": "0" * 64, "sizeBytes": 1}
    raw = json.dumps(payload, separators=(",", ":")).encode()

    with pytest.raises(KnowledgeWorkerFailure) as caught:
        run_worker_snapshot(snapshot, raw)

    assert caught.value.code == "SNAPSHOT_INTEGRITY_MISMATCH"


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


def test_permit_protocol_reserves_spends_and_completes_one_execution_identity():
    event = knowledge_event()
    claim_token = str(uuid4())
    permit_id = str(uuid4())

    class CaptureClient(KnowledgeCoreApiClient):
        async def request_knowledge(self, _event, operation, body=None, **_options):
            self.calls.append((operation, body))
            if operation == "permit":
                return SimpleNamespace(
                    permitId=permit_id,
                    state="RESERVED",
                    mutationExecutionId=body["mutationExecutionId"],
                )
            if operation.endswith("/start"):
                return SimpleNamespace(
                    permitId=permit_id,
                    state="RUNNING",
                    mutationExecutionId=body["mutationExecutionId"],
                )
            return SimpleNamespace(
                permitId=permit_id,
                state="SUCCEEDED",
                mutationExecutionId=body["mutationExecutionId"],
            )

    client = CaptureClient.__new__(CaptureClient)
    client.calls = []
    claim = SimpleNamespace(
        claimToken=SimpleNamespace(get_secret_value=lambda: claim_token),
    )

    permit = asyncio.run(client.acquire_write_permit(event, claim))
    started = asyncio.run(client.start_write_permit(event, claim, permit))
    asyncio.run(client.complete_write_permit(
        event, claim, started, state="SUCCEEDED", outcome_code="NONE",
    ))

    assert [operation for operation, _ in client.calls] == [
        "permit", f"permit/{permit_id}/start", f"permit/{permit_id}/complete",
    ]
    _, acquired = client.calls[0]
    _, start = client.calls[1]
    _, complete = client.calls[2]
    assert acquired["generationId"] == event.index_generation.generation_id
    assert acquired["mutationExecutionId"]
    assert start["mutationExecutionId"] == acquired["mutationExecutionId"]
    assert complete["mutationExecutionId"] == acquired["mutationExecutionId"]
