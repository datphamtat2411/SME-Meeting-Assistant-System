import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import ValidationError

from sme_meeting_ai.integrations.intelligence import (
    IntelligenceClaim,
    IntelligenceStatus,
    decode_notification,
)
from sme_meeting_ai.integrations.messaging import MessageError


def delivery():
    event = dict(eventId=str(uuid4()), schemaVersion=1, processingJobId=str(uuid4()),
                 executionStageRunId=str(uuid4()), executionStageCode="GENERATING_SUMMARY",
                 occurredAt="2026-11-09T12:00:00Z", requestId=None)
    return SimpleNamespace(body=json.dumps(event).encode(), content_type="application/json",
        delivery_mode=2, routing_key="processing.intelligence.requested", exchange="meeting.processing",
        headers=dict(eventId=event["eventId"], eventType="PROCESSING_INTELLIGENCE_STAGE_REQUESTED",
                     eventSchemaVersion=1), message_id=event["eventId"], redelivered=False), event


def test_dispatch_identity_and_nullable_correlation():
    message, data = delivery()
    event = decode_notification(message)
    assert event.eventId == data["eventId"]
    assert event.correlation_id == data["eventId"]


@pytest.mark.parametrize("mutation", ["version", "stage", "message", "header", "route", "duplicate"])
def test_dispatch_poison_rejected(mutation):
    message, data = delivery()
    if mutation == "version":
        data["schemaVersion"] = 2
    elif mutation == "stage":
        data["executionStageCode"] = "TRANSCRIPTION"
    elif mutation == "message":
        message.message_id = str(uuid4())
    elif mutation == "header":
        message.headers["eventSchemaVersion"] = True
    elif mutation == "route":
        message.routing_key = "processing.job.queued"
    message.body = json.dumps(data).encode()
    if mutation == "duplicate":
        message.body = message.body[:-1] + b',"schemaVersion":1}'
    with pytest.raises(MessageError):
        decode_notification(message)


def test_status_requires_consistent_durable_disposition():
    message, event = delivery()
    base = dict(contractVersion="1.0", processingJobId=event["processingJobId"],
        eventId=event["eventId"], executionStageRunId=event["executionStageRunId"],
        executionStageCode=event["executionStageCode"])
    assert IntelligenceStatus.model_validate(dict(base, state="RESULT_ACCEPTED", acknowledge=True)).durable
    with pytest.raises(ValidationError):
        IntelligenceStatus.model_validate(dict(base, state="RUNNING", acknowledge=True))
    with pytest.raises(ValidationError):
        IntelligenceStatus.model_validate(dict(base, state="FAILURE_RECORDED", acknowledge=True))


def test_claim_rejects_unapproved_snapshot_or_result_slot():
    _, event = delivery()
    job, stage, snap = event["processingJobId"], event["executionStageRunId"], str(uuid4())
    claim = dict(contractVersion="1.0", processingJobId=job, eventId=event["eventId"],
        executionStageRunId=stage, executionStageCode="GENERATING_SUMMARY",
        eventType="PROCESSING_INTELLIGENCE_STAGE_REQUESTED", eventSchemaVersion=1,
        meetingId=str(uuid4()), sourceMediaId=str(uuid4()), claimToken=str(uuid4()),
        leaseExpiresAt="2026-11-09T12:01:00Z", serverTime="2026-11-09T12:00:00Z",
        leaseSeconds=60, renewAfterSeconds=15,
        source=dict(snapshotId=snap, storageId="private", objectKey=f"processing/{job}/intelligence/source/{snap}.json",
                    sha256="a" * 64, sizeBytes=32, transcriptId=str(uuid4()), contentRevision=1, schemaVersion=1),
        resultSlot=dict(storageId="private", objectKey=f"processing/{job}/intelligence/results/{stage}.json",
                        producerStageRunId=stage, maxBytes=4194304, createOnly=True, requiredIfNoneMatch="*"))
    assert IntelligenceClaim.model_validate(claim).source.snapshotId == snap
    claim["resultSlot"]["objectKey"] = "processing/other.json"
    with pytest.raises(ValidationError):
        IntelligenceClaim.model_validate(claim)
