"""Strict AIMI-T01 Meeting Intelligence dispatch and ownership wire models."""

import asyncio
import base64
import re
from typing import Literal
from uuid import uuid4

import httpx
from pydantic import Field, SecretStr, ValidationError, field_validator, model_validator

from .core_api import (
    CoreApiClient, CoreError, Count, Digest, Timestamp, Uuid, WireModel,
    strict_json, uuid_string,
)
from .messaging import MessageError

QUEUE = "meeting.processing.intelligence"
ROUTE = "processing.intelligence.requested"
EVENT_TYPE = "PROCESSING_INTELLIGENCE_STAGE_REQUESTED"
Stage = Literal["GENERATING_SUMMARY", "EXTRACTING_DECISIONS", "EXTRACTING_ACTION_ITEMS"]
TERMINAL = frozenset(("RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED"))


class IntelligenceEvent(WireModel):
    eventId: Uuid
    schemaVersion: Literal[1]
    processingJobId: Uuid
    executionStageRunId: Uuid
    executionStageCode: Stage
    occurredAt: Timestamp
    requestId: str | None = Field(max_length=128)

    @field_validator("requestId")
    @classmethod
    def valid_correlation(cls, value):
        if value is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value):
            raise ValueError("Invalid request identity")
        return value

    @property
    def correlation_id(self):
        return self.requestId or self.eventId

    @property
    def event_type(self):
        return EVENT_TYPE


def decode_notification(delivery):
    try:
        if (delivery.content_type != "application/json" or delivery.delivery_mode != 2
                or delivery.routing_key != ROUTE or delivery.exchange != "meeting.processing"):
            raise ValueError
        event = IntelligenceEvent.model_validate(strict_json(delivery.body, 16384))
        headers = delivery.headers
        version, count = headers.get("eventSchemaVersion"), headers.get("x-delivery-count", 0)
        if (type(version) is not int or version != event.schemaVersion
                or headers.get("eventId") != event.eventId or delivery.message_id != event.eventId
                or headers.get("eventType") != EVENT_TYPE or type(count) is not int or count < 0
                or delivery.redelivered and "x-delivery-count" not in headers):
            raise ValueError
        return event
    except (ValueError, TypeError, AttributeError, RecursionError, ValidationError):
        pass
    raise MessageError()


class Identity(WireModel):
    contractVersion: Literal["1.0"]
    processingJobId: Uuid
    eventId: Uuid
    executionStageRunId: Uuid
    executionStageCode: Stage


class IntelligenceStatus(Identity):
    state: Literal["AVAILABLE", "RUNNING", "AWAITING_RECONCILIATION", "RESULT_ACCEPTED",
                   "FAILURE_RECORDED", "SUPERSEDED"]
    acknowledge: bool
    errorCode: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]{0,79}$")
    retryable: bool | None = None

    @model_validator(mode="after")
    def validate_disposition(self):
        if self.acknowledge != (self.state in TERMINAL):
            raise ValueError("Invalid acknowledgment")
        if self.state == "FAILURE_RECORDED":
            if self.errorCode is None or self.retryable is None:
                raise ValueError("Missing failure disposition")
        elif self.errorCode is not None or self.retryable is not None:
            raise ValueError("Unexpected failure disposition")
        return self

    @property
    def durable(self):
        return self.acknowledge


class Source(WireModel):
    snapshotId: Uuid
    storageId: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    objectKey: str = Field(min_length=1, max_length=1024, repr=False)
    sha256: Digest
    sizeBytes: int = Field(gt=0, le=8 * 1024 * 1024)
    transcriptId: Uuid
    contentRevision: Count
    schemaVersion: Literal[1]


class ResultSlot(WireModel):
    storageId: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    objectKey: str = Field(min_length=1, max_length=1024, repr=False)
    producerStageRunId: Uuid
    maxBytes: Literal[4194304]
    createOnly: Literal[True]
    requiredIfNoneMatch: Literal["*"]


class IntelligenceLease(Identity):
    leaseExpiresAt: Timestamp
    serverTime: Timestamp
    leaseSeconds: int = Field(gt=0, le=86400)
    renewAfterSeconds: int = Field(gt=0, le=86400)


class IntelligenceClaim(IntelligenceLease):
    eventType: Literal["PROCESSING_INTELLIGENCE_STAGE_REQUESTED"]
    eventSchemaVersion: Literal[1]
    meetingId: Uuid
    sourceMediaId: Uuid
    claimToken: SecretStr = Field(repr=False)
    source: Source = Field(repr=False)
    resultSlot: ResultSlot | None = Field(default=None, repr=False)

    @model_validator(mode="after")
    def validate_binding(self):
        uuid_string(self.claimToken.get_secret_value())
        prefix = f"processing/{self.processingJobId}/intelligence/"
        if self.source.objectKey != f"{prefix}source/{self.source.snapshotId}.json":
            raise ValueError("Invalid snapshot location")
        if self.executionStageCode == "EXTRACTING_ACTION_ITEMS":
            if self.resultSlot is not None:
                raise ValueError("Unexpected result slot")
        elif (self.resultSlot is None
              or self.resultSlot.objectKey != f"{prefix}results/{self.executionStageRunId}.json"
              or self.resultSlot.producerStageRunId != self.executionStageRunId
              or self.resultSlot.storageId != self.source.storageId):
            raise ValueError("Invalid result slot")
        return self


class AcceptedResult(WireModel):
    replay: bool
    writtenRows: int = Field(ge=0)


def owner_fields(claim):
    return dict(contractVersion="1.0", eventId=claim.eventId,
                executionStageRunId=claim.executionStageRunId,
                claimToken=claim.claimToken.get_secret_value())


class IntelligenceCoreClient(CoreApiClient):
    """T01 worker-control transport and separately authenticated acceptance."""

    capability = "intelligence"

    def __init__(self, settings, *, acceptance_token, client=None, sleep=asyncio.sleep):
        token = acceptance_token.get_secret_value() if isinstance(acceptance_token, SecretStr) else acceptance_token
        try:
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
                raise ValueError
            decoded = base64.urlsafe_b64decode(token + "=")
            if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).decode().rstrip("=") != token:
                raise ValueError
        except (ValueError, TypeError):
            raise CoreError(403) from None
        self._acceptance_token = token
        super().__init__(settings, client=client, sleep=sleep)

    async def request(self, event, operation, body=None, **options):
        # The dispatch correlation field can be null, while T01 HTTP requires it.
        return await super().request(event.model_copy(update={"requestId": event.correlation_id}),
                                     operation, body, **options)

    def decode_response(self, event, operation, data):
        payload = data["data"]
        if payload.get("contractVersion") != "1.0":
            raise CoreError(422, "WORKER_CONTRACT_UNSUPPORTED")
        model = (IntelligenceClaim if operation == "claim" and "claimToken" in payload
                 else IntelligenceLease if operation == "renew" else IntelligenceStatus)
        result = model.model_validate(payload)
        if (result.processingJobId != event.processingJobId or result.eventId != event.eventId
                or result.executionStageRunId != event.executionStageRunId
                or result.executionStageCode != event.executionStageCode):
            raise CoreError(409, "WORKER_IDENTITY_CONFLICT")
        return result

    async def claim(self, event, *, deadline=None):
        command = dict(contractVersion="1.0", eventId=event.eventId, eventType=EVENT_TYPE,
            eventSchemaVersion=event.schemaVersion, executionStageRunId=event.executionStageRunId,
            executionStageCode=event.executionStageCode, claimRequestId=str(uuid4()))
        return await self.request(event, "claim", command, deadline=deadline)

    async def accept(self, event, claim_token, digest, *, deadline=None):
        uuid_string(claim_token)
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise CoreError(422, "VALIDATION_ERROR")
        duration = self.settings.core_api_timeout_seconds
        if deadline is not None:
            duration = min(duration, deadline - asyncio.get_running_loop().time())
        if duration <= 0:
            raise CoreError(409, "WORKER_LEASE_LOST")
        body = dict(stageRunId=event.executionStageRunId, claimToken=claim_token, artifactSha256=digest)
        try:
            async with asyncio.timeout(duration):
                async with self.http.stream("POST", self.settings.core_api_base_url
                    + "/internal/api/v1/meeting-intelligence/results/accept", json=body,
                    headers={"Authorization": "Bearer " + self._acceptance_token,
                             "X-Request-Id": event.correlation_id}, follow_redirects=False,
                    timeout=httpx.Timeout(duration, connect=min(duration, self.settings.core_api_connect_timeout_seconds))) as response:
                    if response.status_code != 200:
                        raise CoreError(response.status_code)
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(raw) + len(chunk) > 65536:
                            raise CoreError(0, "WORKER_RESPONSE_INVALID")
                        raw.extend(chunk)
                    envelope = strict_json(bytes(raw), 65536)
                    if (not isinstance(envelope, dict) or envelope.get("success") is not True
                            or set(envelope) - {"success", "code", "message", "data", "meta", "errors"}
                            or "no-store" not in response.headers.get("cache-control", "").lower().split(", ")):
                        raise CoreError(0, "WORKER_RESPONSE_INVALID")
                    return AcceptedResult.model_validate(envelope["data"])
        except CoreError:
            raise
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError, ValidationError):
            raise CoreError() from None
