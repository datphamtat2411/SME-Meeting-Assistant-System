"""Strict SPK-07 notifications and SPK-08 control types; no execution authority."""

from typing import Literal
from uuid import uuid4

from pydantic import Field, SecretStr, ValidationError, model_validator

from sme_meeting_ai.diarization.contract import MAX_ASSIGNMENTS

from .core_api import (
    TERMINAL,
    CoreApiClient,
    CoreError,
    Count,
    Digest,
    SourceDescriptor,
    Timestamp,
    Uuid,
    WireModel,
    strict_json,
    uuid_string,
)
from .messaging import MessageError

QUEUE = "meeting.processing.diarization"
ROUTE = "processing.diarization.requested"


class DiarizationEvent(WireModel):
    eventId: Uuid
    processingJobId: Uuid
    meetingId: Uuid
    sourceMediaId: Uuid
    sourceRevision: Digest
    transcriptId: Uuid
    transcriptRevision: Count
    stageRunId: Uuid
    schemaVersion: Literal[1]
    occurredAt: Timestamp

    @property
    def requestId(self):
        return self.eventId

    @property
    def event_type(self):
        return "PROCESSING_DIARIZATION_REQUESTED"


def decode_notification(delivery):
    try:
        if (delivery.content_type != "application/json" or delivery.delivery_mode != 2
                or delivery.routing_key != ROUTE or delivery.exchange != "meeting.processing"):
            raise ValueError
        event = DiarizationEvent.model_validate(strict_json(delivery.body, 16384))
        headers = delivery.headers
        version = headers.get("eventSchemaVersion")
        count = headers.get("x-delivery-count", 0)
        if (type(version) is not int or version != event.schemaVersion
                or headers.get("eventId") != event.eventId or delivery.message_id != event.eventId
                or headers.get("eventType") != event.event_type
                or type(count) is not int or count < 0
                or delivery.redelivered and "x-delivery-count" not in headers):
            raise ValueError
        return event
    except (ValueError, TypeError, AttributeError, RecursionError, ValidationError):
        pass
    raise MessageError()


class TranscriptBinding(WireModel):
    transcriptId: Uuid
    transcriptRevision: Count


class DiarizationSlot(WireModel):
    storageId: str = Field(min_length=1, max_length=64)
    objectKey: str = Field(min_length=1, max_length=1024, repr=False)
    producerStageRunId: Uuid
    maxBytes: Literal[16777216]
    createOnly: bool
    requiredIfNoneMatch: Literal["*"]

    @model_validator(mode="after")
    def immutable(self):
        if not self.createOnly:
            raise ValueError("Immutable slot required")
        return self


class DiarizationLease(WireModel):
    contractVersion: Literal["1.0"]
    leaseExpiresAt: Timestamp
    serverTime: Timestamp
    leaseSeconds: int = Field(gt=0, le=3600)
    renewAfterSeconds: int = Field(gt=0, le=900)


class DiarizationClaim(DiarizationLease):
    eventId: Uuid
    eventType: Literal["PROCESSING_DIARIZATION_REQUESTED"]
    eventSchemaVersion: Literal[1]
    processingJobId: Uuid
    meetingId: Uuid
    executionStageRunId: Uuid
    executionStageCode: Literal["DIARIZING"]
    claimToken: SecretStr = Field(repr=False)
    source: SourceDescriptor = Field(repr=False)
    transcript: TranscriptBinding
    resultSlot: DiarizationSlot = Field(repr=False)

    @model_validator(mode="after")
    def slot_binding(self):
        uuid_string(self.claimToken.get_secret_value())
        expected = f"processing/{self.processingJobId}/diarization/results/{self.executionStageRunId}.json"
        if (self.resultSlot.objectKey != expected or self.resultSlot.producerStageRunId != self.executionStageRunId
                or self.resultSlot.storageId != self.source.storageId):
            raise ValueError("Invalid authorized slot")
        return self


class TimingSegment(WireModel):
    ordinal: Count
    startMs: Count
    endMs: int = Field(gt=0)


class DiarizationSnapshot(TranscriptBinding):
    durationMs: int = Field(gt=0)
    segments: list[TimingSegment] = Field(max_length=MAX_ASSIGNMENTS, repr=False)

    @model_validator(mode="after")
    def timeline(self):
        previous = -1
        for segment in self.segments:
            if (segment.ordinal <= previous or not 0 <= segment.startMs < segment.endMs <= self.durationMs):
                raise ValueError("Invalid timing snapshot")
            previous = segment.ordinal
        return self


class Acceptance(WireModel):
    receiptId: Uuid
    recordedAt: Timestamp
    verificationId: Uuid
    resultSha256: Digest


class Failure(WireModel):
    receiptId: Uuid
    recordedAt: Timestamp
    errorCode: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,79}$")
    retryable: bool


class Supersession(WireModel):
    supersedingAttemptNumber: int = Field(gt=0)


class Verification(WireModel):
    verificationId: Uuid
    resultSha256: Digest
    verifiedAt: Timestamp


class DiarizationStatus(WireModel):
    contractVersion: Literal["1.0"]
    processingJobId: Uuid
    eventId: Uuid
    executionStageRunId: Uuid
    state: Literal["AVAILABLE", "RUNNING", "AWAITING_RECONCILIATION", "RESULT_VERIFIED",
                   "RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED"]
    acknowledge: bool
    receipt: dict | None = Field(default=None, repr=False)
    verification: Verification | None = None

    @model_validator(mode="after")
    def durable_evidence(self):
        if self.acknowledge != (self.state in TERMINAL):
            raise ValueError("Invalid acknowledgment disposition")
        model = {"RESULT_ACCEPTED": Acceptance, "FAILURE_RECORDED": Failure, "SUPERSEDED": Supersession}.get(self.state)
        if model:
            model.model_validate(self.receipt)
        elif self.receipt is not None:
            raise ValueError("Unexpected receipt")
        if (self.state == "RESULT_VERIFIED") != (self.verification is not None):
            raise ValueError("Invalid verification disposition")
        return self

    @property
    def durable(self):
        return self.state in TERMINAL and self.acknowledge


def owner_fields(claim):
    return dict(contractVersion="1.0", eventId=claim.eventId,
                executionStageRunId=claim.executionStageRunId, claimToken=claim.claimToken.get_secret_value())


class DiarizationCoreClient(CoreApiClient):
    capability = "diarization"

    def response_limit(self, operation):
        # Text-free 16,384-segment snapshot can exceed the transcription control limit.
        return 2097152 if operation == "snapshot" else 65536

    def decode_response(self, event, operation, data):
        payload = data["data"]
        if operation != "snapshot" and payload.get("contractVersion") != "1.0":
            raise CoreError(422, "WORKER_CONTRACT_UNSUPPORTED")
        model = (DiarizationSnapshot if operation == "snapshot" else DiarizationLease if operation == "renew"
                 else DiarizationClaim if operation == "claim" and "claimToken" in payload else DiarizationStatus)
        result = model.model_validate(payload)
        if isinstance(result, (DiarizationClaim, DiarizationStatus)) and (
            result.eventId != event.eventId or result.processingJobId != event.processingJobId
            or result.executionStageRunId != event.stageRunId
        ):
            raise CoreError(409, "WORKER_IDENTITY_CONFLICT")
        if isinstance(result, DiarizationClaim) and (
            result.meetingId != event.meetingId or result.eventSchemaVersion != event.schemaVersion
            or result.source.sourceMediaId != event.sourceMediaId or result.source.sourceRevision != event.sourceRevision
            or result.transcript.transcriptId != event.transcriptId
            or result.transcript.transcriptRevision != event.transcriptRevision
            or result.source.objectKey != f"meetings/{result.meetingId}/sources/{result.source.sourceMediaId}"
        ):
            raise CoreError(409, "WORKER_IDENTITY_CONFLICT")
        return result

    async def claim(self, event, *, deadline=None):
        body = dict(contractVersion="1.0", eventId=event.eventId, eventType=event.event_type,
                    eventSchemaVersion=event.schemaVersion, meetingId=event.meetingId,
                    sourceMediaId=event.sourceMediaId, executionStageRunId=event.stageRunId,
                    claimRequestId=str(uuid4()))
        # The same body/request ID survives every uncertain transport retry.
        return await self.request(event, "claim", body, deadline=deadline)
