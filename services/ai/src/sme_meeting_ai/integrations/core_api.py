"""Contract V1 wire types and bounded outbound mTLS; no canonical state authority."""

import asyncio
import json
import random
import re
import ssl
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Annotated, Any, Literal, get_args, get_origin
from uuid import UUID

import httpx
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    ValidationError,
    model_validator,
)

from sme_meeting_ai.core.config import Settings

MAX_RESULT_BYTES = 8388608
KNOWLEDGE_EVENT_TYPE = "KNOWLEDGE_INDEXING_REQUESTED"
STAGES = ("TRANSCRIPTION", "CONTEXTUAL_CORRECTION", "FINALIZING_TRANSCRIPT")
TERMINAL = frozenset(("RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED"))


def uuid_string(value: str) -> str:
    UUID(value)
    if not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value):
        raise ValueError("Invalid UUID")
    return value


def timestamp(value: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value):
        raise ValueError("Invalid timestamp")
    if datetime.fromisoformat(value).utcoffset() is None:
        raise ValueError("Invalid timestamp")
    return value


Uuid = Annotated[str, AfterValidator(uuid_string)]
Timestamp = Annotated[str, AfterValidator(timestamp)]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Count = Annotated[int, Field(ge=0)]
StageCode = Literal["TRANSCRIPTION", "CONTEXTUAL_CORRECTION", "FINALIZING_TRANSCRIPT"]


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    @model_validator(mode="before")
    @classmethod
    def strict_integer_literals(cls, values):
        if isinstance(values, dict):
            for name, field in cls.model_fields.items():
                if get_origin(field.annotation) is Literal and any(type(v) is int for v in get_args(field.annotation)):
                    if name in values and type(values[name]) is not int:
                        raise ValueError("Invalid integer literal")
        return values


def strict_json(raw: bytes, maximum: int) -> object:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate property")
            result[key] = value
        return result

    if len(raw) > maximum or raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError("Invalid JSON size or encoding")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid number")))


class SourceDescriptor(WireModel):
    sourceMediaId: Uuid
    sourceRevision: Digest
    storageId: str = Field(min_length=1, max_length=64)
    objectKey: str = Field(min_length=1, max_length=1024, repr=False)
    contentType: str = Field(min_length=1, max_length=128)
    sizeBytes: int = Field(gt=0)
    sha256: Digest
    durationMs: int = Field(gt=0)

    @model_validator(mode="after")
    def immutable_revision(self):
        if self.sha256 != self.sourceRevision:
            raise ValueError("Invalid source revision")
        return self


class ResultSlot(WireModel):
    storageId: str = Field(min_length=1, max_length=64)
    objectKey: str = Field(min_length=1, max_length=1024, repr=False)
    maxBytes: Literal[8388608]


class ReusableResult(WireModel):
    storageId: str = Field(min_length=1, max_length=64)
    objectKey: str = Field(min_length=1, max_length=1024, repr=False)
    producerStageRunId: Uuid


class Lease(WireModel):
    contractVersion: Literal["1.0"]
    leaseExpiresAt: Timestamp
    serverTime: Timestamp
    renewAfterSeconds: int = Field(gt=0, le=120)


class Claim(Lease):
    eventId: Uuid
    generation: Count
    processingJobId: Uuid
    meetingId: Uuid
    sourceMediaId: Uuid
    executionStageRunId: Uuid
    executionStageCode: StageCode
    claimToken: SecretStr = Field(repr=False)
    leaseSeconds: int = Field(gt=5, le=3600)
    source: SourceDescriptor = Field(repr=False)
    resultSlot: ResultSlot = Field(repr=False)
    reusableResult: ReusableResult | None = Field(repr=False)

    @model_validator(mode="after")
    def validate_binding(self):
        uuid_string(self.claimToken.get_secret_value())
        if self.source.sourceMediaId != self.sourceMediaId:
            raise ValueError("Invalid source binding")
        prefix = f"processing/{self.processingJobId}/transcription/results/"
        if self.resultSlot.objectKey != f"{prefix}{self.executionStageRunId}.json":
            raise ValueError("Invalid result slot")
        if self.reusableResult and self.reusableResult.objectKey != f"{prefix}{self.reusableResult.producerStageRunId}.json":
            raise ValueError("Invalid reusable result binding")
        return self


class SuccessReceipt(WireModel):
    receiptId: Uuid
    resultSha256: Digest
    correctionSha256: Digest
    transcriptId: Uuid
    transcriptStatus: Literal["READY", "READY_WITH_WARNINGS"]
    acceptedAt: Timestamp


class FailureReceipt(WireModel):
    receiptId: Uuid
    errorCode: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,79}$")
    retryable: bool
    retryExhausted: bool
    recordedAt: Timestamp


class DeliveryStatus(WireModel):
    contractVersion: Literal["1.0"]
    processingJobId: Uuid
    eventId: Uuid
    generation: Count
    state: Literal["RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED", "AVAILABLE",
                   "RUNNING", "AWAITING_RECONCILIATION"]
    # Supersession's covering receipt/generation is Core-owned opaque metadata.
    receipt: dict | None = Field(repr=False)
    replay: bool | None = None

    @model_validator(mode="after")
    def validate_receipt(self):
        if self.state == "RESULT_ACCEPTED":
            SuccessReceipt.model_validate(self.receipt)
        elif self.state == "FAILURE_RECORDED":
            FailureReceipt.model_validate(self.receipt)
        elif self.state not in TERMINAL and self.receipt is not None:
            raise ValueError("Invalid nonterminal receipt")
        return self

    @property
    def durable(self) -> bool:
        return self.state in TERMINAL


class KnowledgeSourceIdentity(WireModel):
    sourceType: Literal["TRANSCRIPT", "SUMMARY", "DECISION", "ACTION_ITEM"]
    sourceId: Uuid
    meetingId: Uuid


class KnowledgeSourceRevision(WireModel):
    number: Count


class KnowledgeSnapshotReference(WireModel):
    snapshotId: Uuid
    sha256: Digest
    sizeBytes: int = Field(gt=0, le=8 * 1024 * 1024)


class KnowledgeIndexGeneration(WireModel):
    generationId: str = Field(min_length=1, max_length=128)
    configurationVersion: str = Field(min_length=1, max_length=128)
    configurationSha256: Digest
    tokenizerId: str = Field(min_length=1, max_length=128)


class KnowledgeLease(WireModel):
    contractVersion: Literal["1.0"]
    eventId: Uuid
    leaseExpiresAt: Timestamp
    serverTime: Timestamp
    renewAfterSeconds: int = Field(gt=0, le=7200)


class KnowledgeClaim(KnowledgeLease):
    meetingId: Uuid
    sourceIdentity: KnowledgeSourceIdentity
    sourceRevision: KnowledgeSourceRevision
    operation: Literal["UPSERT", "INVALIDATE", "DELETE"] = "UPSERT"
    reason: Literal[
        "NEW_REVISION", "ELIGIBILITY_CHANGED", "SOURCE_SUPERSEDED", "SOURCE_DELETED",
        "REINDEX_REQUESTED", "RECONCILIATION_REQUESTED",
    ] = "NEW_REVISION"
    snapshot: KnowledgeSnapshotReference | None = None
    indexGeneration: KnowledgeIndexGeneration
    claimToken: SecretStr = Field(repr=False)
    leaseSeconds: int = Field(gt=5, le=7200)
    replay: bool

    @model_validator(mode="after")
    def validate_binding(self):
        uuid_string(self.claimToken.get_secret_value())
        if self.meetingId != self.sourceIdentity.meetingId:
            raise ValueError("Invalid knowledge claim identity")
        if self.operation == "UPSERT" and self.snapshot is None:
            raise ValueError("Knowledge upsert claim requires a snapshot")
        if self.operation != "UPSERT" and self.snapshot is not None:
            raise ValueError("Knowledge lifecycle claim cannot carry a snapshot")
        if self.operation == "UPSERT" and self.reason not in {
            "NEW_REVISION", "REINDEX_REQUESTED", "RECONCILIATION_REQUESTED",
        }:
            raise ValueError("Knowledge upsert claim reason is incompatible")
        if self.operation == "INVALIDATE" and self.reason not in {
            "ELIGIBILITY_CHANGED", "SOURCE_SUPERSEDED", "SOURCE_DELETED", "RECONCILIATION_REQUESTED",
        }:
            raise ValueError("Knowledge invalidation claim reason is incompatible")
        if self.operation == "DELETE" and self.reason != "SOURCE_DELETED":
            raise ValueError("Knowledge delete claim requires source deletion reason")
        return self


class KnowledgeDeliveryStatus(WireModel):
    contractVersion: Literal["1.0"]
    eventId: Uuid
    meetingId: Uuid
    sourceType: Literal["TRANSCRIPT", "SUMMARY", "DECISION", "ACTION_ITEM"]
    sourceId: Uuid
    sourceRevision: Count
    indexGenerationId: str = Field(min_length=1, max_length=128)
    state: Literal[
        "PENDING", "CLAIMED", "INDEXED", "RETRYABLE_FAILURE", "TERMINAL_FAILURE",
        "INVALIDATED", "DELETED", "SUPERSEDED", "NO_ELIGIBLE_CONTENT",
    ]
    operation: Literal["UPSERT", "INVALIDATE", "DELETE"] = "UPSERT"
    reason: Literal[
        "NEW_REVISION", "ELIGIBILITY_CHANGED", "SOURCE_SUPERSEDED", "SOURCE_DELETED",
        "REINDEX_REQUESTED", "RECONCILIATION_REQUESTED",
    ] = "NEW_REVISION"
    acknowledge: bool
    attemptCount: Count
    replay: bool
    resultId: Uuid | None = None
    chunkCount: Count | None = None
    receiptSha256: Digest | None = None
    errorCode: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]{0,79}$")

    @property
    def durable(self) -> bool:
        return self.state in {
            "INDEXED", "INVALIDATED", "DELETED", "NO_ELIGIBLE_CONTENT", "TERMINAL_FAILURE", "SUPERSEDED",
        }


@dataclass(frozen=True)
class KnowledgeSnapshotResponse:
    snapshot_id: str
    sha256: str
    size_bytes: int
    bytes: bytes

    def __post_init__(self):
        object.__setattr__(self, "bytes", bytes(self.bytes))


class CoreError(Exception):
    """Only allowlisted classifications, never HTTP request/response objects."""

    def __init__(self, status=0, code="WORKER_TRANSPORT", retry_after=0):
        self.status = status
        self.code = code if isinstance(code, str) and code in {
            "WORKER_CONTRACT_UNSUPPORTED", "WORKER_DELIVERY_NOT_FOUND", "WORKER_IDENTITY_CONFLICT",
            "WORKER_DELIVERY_UNKNOWN", "WORKER_DELIVERY_NOT_PUBLISHED", "WORKER_ATTEMPT_BUSY",
            "WORKER_RETRY_BACKOFF", "WORKER_SOURCE_SUPERSEDED", "WORKER_GENERATION_CONFLICT",
            "WORKER_LEASE_LOST", "WORKER_SNAPSHOT_INTEGRITY_UNAVAILABLE", "WORKER_RESULT_CONFLICT",
            "WORKER_COMMAND_CONFLICT", "WORKER_ATTEMPTS_EXHAUSTED",
            "WORKER_RESPONSE_INVALID", "VALIDATION_ERROR", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE",
            "SERVICE_UNAVAILABLE",
            "DIARIZATION_SOURCE_STALE", "DIARIZATION_RESULT_INVALID", "DIARIZATION_RESULT_MISSING",
        } else "WORKER_TRANSPORT"
        self.retry_after = min(30, max(0, retry_after))
        self.stop_intake = status in (401, 403) or self.code == "WORKER_CONTRACT_UNSUPPORTED"
        self.retryable = status in (0, 408, 429, 502, 503, 504)
        super().__init__(self.code)


class TransportBudget:
    def __init__(self, attempts=3):
        self.remaining = attempts
        self.used = 0


class CoreApiClient:
    capability = "transcription"

    def response_limit(self, operation):
        return 65536

    def __init__(self, settings: Settings, *, client=None, sleep=asyncio.sleep):
        self.settings = settings
        self.sleep = sleep
        self._owned = client is None
        if client is None:
            if not all((settings.core_api_base_url, settings.core_api_server_ca_file,
                        settings.core_api_client_cert_file, settings.core_api_client_key_file)):
                raise CoreError(403)
            failed = False
            try:
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.minimum_version = ssl.TLSVersion.TLSv1_2
                context.load_verify_locations(cafile=str(settings.core_api_server_ca_file))
                context.load_cert_chain(str(settings.core_api_client_cert_file), str(settings.core_api_client_key_file))
                client = httpx.AsyncClient(verify=context, trust_env=False, follow_redirects=False,
                         limits=httpx.Limits(max_connections=max(
                             settings.worker_concurrency,
                             getattr(settings, "knowledge_indexing_worker_concurrency", 1),
                         ) + 1))
            except Exception:
                failed = True
            if failed:
                raise CoreError(403)
        self.http = client

    async def aclose(self):
        if self._owned:
            await self.http.aclose()

    async def backoff(self, budget, error, deadline=None):
        delay = max(min(2 ** max(0, budget.used - 1), 2) + random.uniform(0, 0.2), error.retry_after)
        if deadline is not None and asyncio.get_running_loop().time() + delay >= deadline:
            raise CoreError(409, "WORKER_LEASE_LOST")
        await self.sleep(delay)

    async def request(self, event, operation, body=None, *, budget=None, once=False, deadline=None):
        budget = budget or TransportBudget(self.settings.core_api_max_attempts)
        error = CoreError()
        while budget.remaining:
            budget.remaining -= 1
            budget.used += 1
            try:
                return await self._once(event, operation, body, deadline)
            except CoreError as caught:
                error = caught
            if once or not error.retryable or not budget.remaining:
                break
            await self.backoff(budget, error, deadline)
        raise CoreError(error.status, error.code, error.retry_after)

    async def _once(self, event, operation, body, deadline):
        base = self.settings.core_api_base_url or "https://core.invalid"
        path = f"/internal/v1/worker/processing-jobs/{event.processingJobId}/{self.capability}/{operation}"
        maximum = self.response_limit(operation)
        duration = self.settings.core_api_timeout_seconds
        if deadline is not None:
            duration = min(duration, deadline - asyncio.get_running_loop().time())
        error = CoreError()
        response_status = 0
        try:
            if duration <= 0:
                raise CoreError(409, "WORKER_LEASE_LOST")
            async with asyncio.timeout(duration):
                async with self.http.stream("GET" if body is None else "POST", base + path,
                    json=body, headers={"X-Request-Id": event.requestId},
                    timeout=httpx.Timeout(duration, connect=min(duration, self.settings.core_api_connect_timeout_seconds)),
                ) as response:
                    response_status = response.status_code
                    if response.status_code in (401, 403):
                        raise CoreError(response.status_code)
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(raw) + len(chunk) > maximum:
                            raise CoreError(response_status if response_status != 200 else 0, "WORKER_RESPONSE_INVALID")
                        raw.extend(chunk)
                    data = strict_json(bytes(raw), maximum)
                    if not isinstance(data, dict) or set(data) - {"success", "code", "message", "data", "meta", "errors"}:
                        raise CoreError(response_status if response_status != 200 else 0, "WORKER_RESPONSE_INVALID")
                    if response.status_code != 200:
                        retry_after = response.headers.get("retry-after", "0")
                        delay = 0
                        try:
                            delay = min(30, int(retry_after)) if retry_after.isdigit() else (
                                parsedate_to_datetime(retry_after) - datetime.now(UTC)).total_seconds()
                        except (ValueError, TypeError, OverflowError):
                            pass
                        raise CoreError(response.status_code, data.get("code"), delay)
                    if data.get("success") is not True or not isinstance(data.get("data"), dict):
                        raise CoreError(0, "WORKER_RESPONSE_INVALID")
                    if "no-store" not in {v.strip() for v in response.headers.get("cache-control", "").lower().split(",")}:
                        raise CoreError(0, "WORKER_RESPONSE_INVALID")
                    return self.decode_response(event, operation, data)
        except CoreError as caught:
            error = caught
        except (httpx.HTTPError, TimeoutError):
            error = CoreError()
        except (ValueError, TypeError, KeyError, RecursionError, ValidationError):
            error = CoreError(response_status if response_status != 200 else 0, "WORKER_RESPONSE_INVALID")
        raise CoreError(error.status, error.code, error.retry_after)

    def decode_response(self, event, operation, data):
        payload = data["data"]
        if payload.get("contractVersion") != "1.0":
            raise CoreError(422, "WORKER_CONTRACT_UNSUPPORTED")
        model = Claim if operation == "claim" and data.get("code") == "WORKER_CLAIMED" else (
            Lease if operation == "renew" else DeliveryStatus)
        result = model.model_validate(payload)
        if isinstance(result, (Claim, DeliveryStatus)) and (
            result.processingJobId != event.processingJobId or result.eventId != event.eventId
            or result.generation != event.generation
        ):
            raise CoreError(409, "WORKER_IDENTITY_CONFLICT")
        if isinstance(result, Claim) and (result.meetingId != event.meetingId
                or result.sourceMediaId != event.sourceMediaId):
            raise CoreError(409, "WORKER_IDENTITY_CONFLICT")
        if isinstance(result, DeliveryStatus):
            if operation.startswith("deliveries/") and "replay" in payload:
                raise CoreError(0, "WORKER_RESPONSE_INVALID")
            if operation in ("complete", "fail") and type(payload.get("replay")) is not bool:
                raise CoreError(0, "WORKER_RESPONSE_INVALID")
        return result

    async def lookup(self, event, **options):
        return await self.request(event, f"deliveries/{event.eventId}", **options)

    async def claim(self, event):
        from uuid import uuid4

        body = dict(contractVersion="1.0", eventId=event.eventId, eventType=event.event_type,
                    eventSchemaVersion=event.schemaVersion, meetingId=event.meetingId,
                    sourceMediaId=event.sourceMediaId, requestedByUserId=event.requestedByUserId,
                    generation=event.generation, claimRequestId=str(uuid4()))
        return await self.request(event, "claim", body)


class KnowledgeCoreApiClient(CoreApiClient):
    """Authenticated Core client for the Core-owned knowledge work boundary."""

    _MAX_JSON_BYTES = 65536
    _MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

    def _request_id(self, event) -> str:
        return event.request_id

    async def request_knowledge(
        self, event, operation: str, body: dict[str, Any] | None = None, *,
        budget: TransportBudget | None = None, once: bool = False, deadline: float | None = None,
    ):
        budget = budget or TransportBudget(self.settings.core_api_max_attempts)
        error = CoreError()
        while budget.remaining:
            budget.remaining -= 1
            budget.used += 1
            try:
                return await self._knowledge_once(event, operation, body, deadline)
            except CoreError as caught:
                error = caught
            if once or not error.retryable or not budget.remaining:
                break
            await self.backoff(budget, error, deadline)
        raise CoreError(error.status, error.code, error.retry_after)

    async def _knowledge_once(self, event, operation, body, deadline):
        base = self.settings.core_api_base_url or "https://core.invalid"
        path = f"/internal/v1/worker/knowledge-indexing/deliveries/{event.event_id}"
        if operation != "status":
            path += f"/{operation}"
        duration = self.settings.core_api_timeout_seconds
        if deadline is not None:
            duration = min(duration, deadline - asyncio.get_running_loop().time())
        if duration <= 0:
            raise CoreError(409, "WORKER_LEASE_LOST")
        response_status = 0
        try:
            async with asyncio.timeout(duration):
                async with self.http.stream(
                    "GET" if body is None else "POST",
                    base + path,
                    json=body,
                    headers={"X-Request-Id": self._request_id(event)},
                    timeout=httpx.Timeout(
                        duration,
                        connect=min(duration, self.settings.core_api_connect_timeout_seconds),
                    ),
                ) as response:
                    response_status = response.status_code
                    maximum = self._MAX_SNAPSHOT_BYTES if operation == "snapshot" and response_status == 200 else self._MAX_JSON_BYTES
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(raw) + len(chunk) > maximum:
                            raise CoreError(response_status or 0, "WORKER_RESPONSE_INVALID")
                        raw.extend(chunk)
                    if response.status_code != 200:
                        data = strict_json(bytes(raw), self._MAX_JSON_BYTES)
                        if not isinstance(data, dict) or set(data) - {
                            "success", "code", "message", "data", "meta", "errors",
                        }:
                            raise CoreError(response_status, "WORKER_RESPONSE_INVALID")
                        retry_after = self._retry_after(response.headers.get("retry-after", "0"))
                        raise CoreError(response_status, data.get("code"), retry_after)
                    if operation == "snapshot":
                        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                        if content_type != "application/json" or "content-encoding" in response.headers:
                            raise CoreError(0, "WORKER_RESPONSE_INVALID")
                        if "no-store" not in {
                            value.strip() for value in response.headers.get("cache-control", "").lower().split(",")
                        }:
                            raise CoreError(0, "WORKER_RESPONSE_INVALID")
                        snapshot_id = response.headers.get("x-snapshot-id")
                        snapshot_sha = response.headers.get("x-snapshot-sha256")
                        if snapshot_id is None or snapshot_sha is None:
                            raise CoreError(0, "WORKER_RESPONSE_INVALID")
                        return KnowledgeSnapshotResponse(
                            snapshot_id=snapshot_id,
                            sha256=snapshot_sha,
                            size_bytes=len(raw),
                            bytes=bytes(raw),
                        )
                    data = strict_json(bytes(raw), self._MAX_JSON_BYTES)
                    if not isinstance(data, dict) or set(data) - {
                        "success", "code", "message", "data", "meta", "errors",
                    } or data.get("success") is not True or not isinstance(data.get("data"), dict):
                        raise CoreError(response_status, "WORKER_RESPONSE_INVALID")
                    if "no-store" not in {
                        value.strip() for value in response.headers.get("cache-control", "").lower().split(",")
                    }:
                        raise CoreError(0, "WORKER_RESPONSE_INVALID")
                    return self.decode_knowledge_response(event, operation, data["data"])
        except CoreError:
            raise
        except (httpx.HTTPError, TimeoutError):
            raise CoreError()
        except (ValueError, TypeError, KeyError, RecursionError, ValidationError):
            raise CoreError(response_status if response_status != 200 else 0, "WORKER_RESPONSE_INVALID")

    @staticmethod
    def _retry_after(value: str) -> float:
        delay = 0.0
        try:
            delay = min(30, int(value)) if value.isdigit() else (
                parsedate_to_datetime(value) - datetime.now(UTC)
            ).total_seconds()
        except (ValueError, TypeError, OverflowError):
            pass
        return max(0.0, min(30.0, delay))

    @staticmethod
    def decode_knowledge_response(event, operation: str, payload: dict[str, Any]):
        if payload.get("contractVersion") != "1.0":
            raise CoreError(422, "WORKER_CONTRACT_UNSUPPORTED")
        if operation == "renew":
            result = KnowledgeLease.model_validate(payload)
            if result.eventId != event.event_id:
                raise CoreError(409, "WORKER_IDENTITY_CONFLICT")
            return result
        if operation == "claim" and "claimToken" in payload:
            result = KnowledgeClaim.model_validate(payload)
            if (
                result.eventId != event.event_id
                or result.meetingId != event.meeting_id
                or result.sourceIdentity.sourceType != event.source_identity.source_type
                or result.sourceIdentity.sourceId != event.source_identity.source_id
                or result.sourceIdentity.meetingId != event.meeting_id
                or result.sourceRevision.number != event.source_revision.number
                or result.operation != event.operation
                or result.reason != event.reason
                or result.indexGeneration.generationId != event.index_generation.generation_id
                or result.indexGeneration.configurationVersion != event.index_generation.configuration_version
                or result.indexGeneration.configurationSha256 != event.index_generation.configuration_sha256
                or result.indexGeneration.tokenizerId != event.index_generation.tokenizer_id
                or event.operation == "UPSERT" and (
                    result.snapshot is None
                    or result.snapshot.snapshotId != event.snapshot.snapshot_id
                    or result.snapshot.sha256 != event.snapshot.sha256
                    or result.snapshot.sizeBytes != event.snapshot.size_bytes
                )
                or event.operation != "UPSERT" and result.snapshot is not None
            ):
                raise CoreError(409, "WORKER_IDENTITY_CONFLICT")
            return result
        result = KnowledgeDeliveryStatus.model_validate(payload)
        if (
            result.eventId != event.event_id
            or result.meetingId != event.meeting_id
            or result.sourceId != event.source_identity.source_id
            or result.sourceType != event.source_identity.source_type
            or result.sourceRevision != event.source_revision.number
            or result.indexGenerationId != event.index_generation.generation_id
            or result.operation != event.operation
            or result.reason != event.reason
        ):
            raise CoreError(409, "WORKER_IDENTITY_CONFLICT")
        return result

    async def lookup(self, event, **options):
        return await self.request_knowledge(event, "status", **options)

    async def claim(self, event, claim_request_id=None):
        from uuid import uuid4

        request_id = claim_request_id or uuid4()
        body = {
            "contractVersion": "1.0",
            "eventId": event.event_id,
            "eventType": KNOWLEDGE_EVENT_TYPE,
            "eventSchemaVersion": event.schema_version,
            "meetingId": event.meeting_id,
            "sourceIdentity": event.source_identity.model_dump(mode="json", by_alias=True),
            "sourceRevision": event.source_revision.model_dump(
                mode="json", by_alias=True, exclude_none=True,
            ),
            "operation": event.operation,
            "indexGeneration": event.index_generation.model_dump(mode="json", by_alias=True),
            "claimRequestId": str(request_id),
        }
        if event.operation == "UPSERT":
            body["snapshot"] = event.snapshot.model_dump(mode="json", by_alias=True)
        else:
            body["reason"] = event.reason
        return await self.request_knowledge(event, "claim", body)

    async def renew(self, event, claim, **options):
        body = {
            "contractVersion": "1.0",
            "eventId": event.event_id,
            "claimToken": claim.claimToken.get_secret_value(),
        }
        return await self.request_knowledge(event, "renew", body, **options)

    async def snapshot(self, event, claim, **options):
        body = {
            "contractVersion": "1.0",
            "eventId": event.event_id,
            "claimToken": claim.claimToken.get_secret_value(),
        }
        return await self.request_knowledge(event, "snapshot", body, **options)

    async def result(
        self, event, claim, *, result_id: str, state: str, index_generation_id: str,
        chunk_count: int, receipt_sha256: str, error_code: str, **options,
    ):
        body = {
            "contractVersion": "1.0",
            "eventId": event.event_id,
            "claimToken": claim.claimToken.get_secret_value(),
            "resultId": result_id,
            "state": state,
            "indexGenerationId": index_generation_id,
            "chunkCount": chunk_count,
            "receiptSha256": receipt_sha256,
            "errorCode": error_code,
        }
        return await self.request_knowledge(event, "result", body, **options)


def claim_fields(claim):
    return dict(contractVersion="1.0", eventId=claim.eventId, generation=claim.generation,
                executionStageRunId=claim.executionStageRunId,
                claimToken=claim.claimToken.get_secret_value())
