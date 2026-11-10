import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from sme_meeting_ai.integrations.knowledge_indexing import decode_notification
from sme_meeting_ai.integrations.messaging import MessageError


def notification():
    meeting_id, source_id, event_id, snapshot_id = (str(uuid4()) for _ in range(4))
    body = {
        "contractVersion": "1.0",
        "schemaVersion": 1,
        "eventId": event_id,
        "occurredAt": "2026-10-31T12:00:00Z",
        "requestId": "request-1",
        "meetingId": meeting_id,
        "sourceIdentity": {"sourceType": "DECISION", "sourceId": source_id, "meetingId": meeting_id},
        "sourceRevision": {"number": 4},
        "operation": "UPSERT",
        "snapshot": {"snapshotId": snapshot_id, "sha256": "a" * 64, "sizeBytes": 100},
        "indexGeneration": {"generationId": "generation-1", "configurationVersion": "1",
                            "configurationSha256": "b" * 64, "tokenizerId": "bge-m3"},
        "reason": "NEW_REVISION",
    }
    delivery = SimpleNamespace(
        body=json.dumps(body).encode(), content_type="application/json", delivery_mode=2,
        routing_key="knowledge.indexing.requested", exchange="meeting.processing",
        message_id=event_id, redelivered=False,
        headers={"eventId": event_id, "eventType": "KNOWLEDGE_INDEXING_REQUESTED",
                 "eventSchemaVersion": 1},
    )
    return body, delivery


def test_valid_notification_reuses_lifecycle_contract():
    body, delivery = notification()
    event = decode_notification(delivery)
    assert event.event_id == body["eventId"]
    assert event.source_identity.source_type == "DECISION"
    assert event.source_revision.number == 4
    assert event.snapshot.snapshot_id == body["snapshot"]["snapshotId"]
    assert event.request_id == "request-1"


def test_valid_invalidation_notification_has_no_snapshot():
    body, delivery = notification()
    body.pop("snapshot")
    body.update(operation="INVALIDATE", reason="ELIGIBILITY_CHANGED")
    delivery.body = json.dumps(body).encode()

    event = decode_notification(delivery)

    assert event.operation == "INVALIDATE"
    assert event.snapshot is None
    assert event.reason == "ELIGIBILITY_CHANGED"


@pytest.mark.parametrize("change", [
    {"schemaVersion": True}, {"schemaVersion": 2}, {"contractVersion": "2.0"},
    {"operation": "OTHER"},
    {"requestId": "unsafe\nvalue"}, {"requestId": ""},
    {"sourceRevision": None}, {"sourceRevision": {"number": True}},
    {"sourceIdentity": {"sourceType": "RAW_ASR", "sourceId": str(uuid4()), "meetingId": str(uuid4())}},
    {"meetingId": str(uuid4())}, {"snapshot": None}, {"indexGeneration": None},
    {"unexpected": "sensitive-content"},
])
def test_invalid_contract_is_rejected(change):
    body, delivery = notification()
    body.update(change)
    delivery.body = json.dumps(body).encode()
    with pytest.raises(MessageError, match="WORKER_MESSAGE_INVALID"):
        decode_notification(delivery)


@pytest.mark.parametrize("field,value", [
    ("message_id", str(uuid4())), ("content_type", "text/plain"), ("delivery_mode", 1),
    ("routing_key", "processing.job.queued"), ("exchange", "other"),
    ("headers", {}), ("redelivered", True),
])
def test_transport_binding_rejected(field, value):
    _, delivery = notification()
    setattr(delivery, field, value)
    with pytest.raises(MessageError):
        decode_notification(delivery)


@pytest.mark.parametrize("key,value", [
    ("eventSchemaVersion", True), ("eventSchemaVersion", 2),
    ("eventId", str(uuid4())), ("eventType", "PROCESSING_JOB_QUEUED"),
    ("x-delivery-count", -1), ("x-delivery-count", True),
])
def test_header_binding_rejected(key, value):
    _, delivery = notification()
    delivery.headers[key] = value
    with pytest.raises(MessageError):
        decode_notification(delivery)


def test_redelivery_requires_broker_delivery_count():
    _, delivery = notification()
    delivery.redelivered = True
    delivery.headers["x-delivery-count"] = 1
    assert decode_notification(delivery).event_id == delivery.message_id


@pytest.mark.parametrize("raw", [
    b" " * 16385, b"{", b"\xef\xbb\xbf{}", b'{"schemaVersion":1,"schemaVersion":1}',
    b'{"schemaVersion":NaN}',
])
def test_malformed_or_unbounded_json_rejected(raw):
    _, delivery = notification()
    delivery.body = raw
    with pytest.raises(MessageError):
        decode_notification(delivery)
