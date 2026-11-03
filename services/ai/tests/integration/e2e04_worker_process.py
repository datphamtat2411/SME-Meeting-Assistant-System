"""Test-only real worker process for the isolated E2E-04 acceptance."""

import asyncio
import base64
import hashlib
import json
import math
import os
import sys
from contextvars import ContextVar
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from e2e04_recovery_control import POST_CLAIM, PRE_ACK, RecoveryControl
from test_worker_live_acceptance import ControlledExecution, controlled_pipeline

from sme_meeting_ai.core.config import ConfigurationError, Environment, load_settings
from sme_meeting_ai.integrations.core_api import CoreApiClient, CoreError
from sme_meeting_ai.observability.logging import configure_logging
from sme_meeting_ai.workers.__main__ import run_worker
from sme_meeting_ai.workers.transcription import (
    TranscriptionExecution,
    TranscriptionWorker,
    WorkFailure,
)

_HEADER_NAMES = frozenset(("eventId", "eventType", "schemaVersion", "x-delivery-count"))
_BROKER_HEADERS = frozenset(("x-delivery-count",))
_delivery_context = ContextVar("e2e04_delivery", default={})


def _typed_header_value(value):
    kind = type(value)
    if kind in (str, int, bool) or value is None:
        return [kind.__name__, value]
    if kind is float:
        if not math.isfinite(value):
            raise AssertionError("unsupported AMQP header value")
        return ["float", value.hex()]
    if kind is bytes:
        return ["bytes", base64.b64encode(value).decode("ascii")]
    if kind in (list, tuple):
        return [kind.__name__, [_typed_header_value(item) for item in value]]
    if kind is dict:
        if any(type(key) is not str for key in value):
            raise AssertionError("unsupported AMQP header mapping")
        return ["dict", [[key, _typed_header_value(value[key])] for key in sorted(value)]]
    if kind is datetime:
        return ["datetime", value.isoformat()]
    if kind is Decimal:
        return ["Decimal", str(value)]
    raise AssertionError("unsupported AMQP header value")


def _canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("utf-8")


def headers_sha256(headers):
    retained = {key: value for key, value in headers.items() if key not in _BROKER_HEADERS}
    try:
        encoded = _canonical_json(retained)
    except (TypeError, ValueError):
        # Preserve the existing JSON fingerprint for JSON values, but remain
        # diagnostic for AMQP byte arrays and other non-JSON field types.
        encoded = _canonical_json(_typed_header_value(retained))
    return hashlib.sha256(encoded).hexdigest()


def header_evidence(headers):
    """Bounded, value-free evidence of all delivered AMQP headers."""
    if len(headers) > 64:
        raise AssertionError("AMQP header evidence limit exceeded")
    result = []
    for name, value in headers.items():
        if type(name) is not str:
            raise AssertionError("unsupported AMQP header name")
        identity = ({"name": name} if name in _HEADER_NAMES else
                    {"nameSha256": hashlib.sha256(name.encode("utf-8")).hexdigest()})
        typed = _typed_header_value(value)
        result.append({**identity, "excluded": name in _BROKER_HEADERS,
                       "type": typed[0], "sha256": hashlib.sha256(_canonical_json(typed)).hexdigest()})
    return sorted(result, key=lambda item: (item.get("name", ""), item.get("nameSha256", "")))


def _safe_diagnostic_text(value, *, default="invalid"):
    value = str(value) if value is not None else ""
    if (not value or len(value) > 128
            or any(not (character.isascii() and (character.isalnum() or character in "._:-/"))
                   for character in value)):
        return default
    return value


def _header_event_id(value):
    try:
        return str(UUID(value)) if type(value) is str else "invalid"
    except ValueError:
        return "invalid"


def message_observation(delivery):
    """Return wire metadata and a body digest without copying the body."""
    try:
        payload = json.loads(bytes(delivery.body).decode("utf-8"))
    except (UnicodeDecodeError, TypeError, ValueError):
        payload = {}
    headers = delivery.headers or {}
    channel = getattr(delivery.channel, "number", None)
    if type(channel) is not int or channel <= 0:
        channel = "unknown"
    mode = getattr(delivery.delivery_mode, "value", delivery.delivery_mode)
    if type(mode) is not int:
        mode = -1
    return {
        "eventId": _safe_diagnostic_text(payload.get("eventId")),
        "processingJobId": _safe_diagnostic_text(payload.get("processingJobId")),
        "deliveryTag": delivery.delivery_tag if type(delivery.delivery_tag) is int else 0,
        "channel": channel,
        "redelivered": delivery.redelivered if type(delivery.redelivered) is bool else False,
        "deliveryCount": (headers.get("x-delivery-count") if type(headers.get("x-delivery-count")) is int
                          and 0 <= headers["x-delivery-count"] <= 100 else None),
        "messageId": _safe_diagnostic_text(delivery.message_id),
        "bodySha256": hashlib.sha256(bytes(delivery.body)).hexdigest(),
        "headerEventId": _header_event_id(headers.get("eventId")),
        "headerEventType": ("PROCESSING_JOB_QUEUED"
                            if headers.get("eventType") == "PROCESSING_JOB_QUEUED" else "invalid"),
        # Spring creates this non-secret template UUID at runtime. Only a
        # canonical UUID is exposed for the test harness to clone the message.
        "publisherListenerId": _header_event_id(headers.get("spring_listener_return_correlation")),
        "headersSha256": headers_sha256(headers),
        "headerEvidence": header_evidence(headers),
        "eventType": ("PROCESSING_JOB_QUEUED"
                      if headers.get("eventType") == "PROCESSING_JOB_QUEUED" else "invalid"),
        "schemaVersion": payload.get("schemaVersion") if type(payload.get("schemaVersion")) is int else -1,
        "exchange": _safe_diagnostic_text(getattr(delivery, "exchange", None)),
        "routingKey": _safe_diagnostic_text(getattr(delivery, "routing_key", None)),
        "contentType": _safe_diagnostic_text(delivery.content_type),
        "deliveryMode": mode,
    }


def claim_observation(event, attempt, *, result=None, error=None):
    """Classify the actual Core claim return without manufacturing a response."""
    if (result is None) == (error is None) or type(attempt) is not int or attempt < 1:
        raise ValueError("claim response must be actual result or error")
    record = {
        "eventId": event.eventId,
        "processingJobId": event.processingJobId,
        "attempt": attempt,
        **_delivery_context.get(),
    }
    if error is not None:
        if not isinstance(error, CoreError):
            raise ValueError("claim response must be actual Core error")
        record.update(outcome="error", status=error.status, code=error.code)
        return record
    if hasattr(result, "executionStageRunId"):
        record.update(outcome="claimed", status=200, stageRunId=result.executionStageRunId)
        return record
    state = getattr(result, "state", None)
    if state not in ("RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED", "AVAILABLE",
                     "RUNNING", "AWAITING_RECONCILIATION"):
        raise ValueError("claim response has invalid status")
    record.update(outcome="status", status=200, state=state)
    return record


def install_diagnostics(control=None):
    """Emit only bounded classifications and identifiers in this test process."""
    prepare = TranscriptionWorker._prepare
    handle = TranscriptionWorker.handle
    request = CoreApiClient.request
    claim = CoreApiClient.claim
    terminal = {}
    claim_attempts = {}
    control = control or RecoveryControl.child(Environment.DEVELOPMENT, {})

    async def observed_claim(self, event):
        attempt = claim_attempts.get(event.eventId, 0) + 1
        claim_attempts[event.eventId] = attempt
        print("E2E04_CLAIM " + json.dumps({
            "eventId": event.eventId, "processingJobId": event.processingJobId,
            "attempt": attempt, "phase": "attempt", **_delivery_context.get(),
        }, separators=(",", ":")), flush=True)
        try:
            result = await claim(self, event)
        except CoreError as error:
            print("E2E04_CLAIM " + json.dumps(
                {**claim_observation(event, attempt, error=error), "phase": "result"},
                separators=(",", ":")), flush=True)
            raise
        print("E2E04_CLAIM " + json.dumps(
            {**claim_observation(event, attempt, result=result), "phase": "result"},
            separators=(",", ":")), flush=True)
        if hasattr(result, "executionStageRunId"):
            await control.checkpoint(POST_CLAIM, event_id=event.eventId)
        return result

    def observed_prepare(self, claim, fence):
        print("E2E04_INFERENCE " + json.dumps({
            "eventId": claim.eventId, "processingJobId": claim.processingJobId,
            "stageRunId": claim.executionStageRunId,
            **_delivery_context.get(),
        }, separators=(",", ":")), flush=True)
        try:
            return prepare(self, claim, fence)
        except WorkFailure as failure:
            print(f"E2E04_WORK_FAILURE job={claim.processingJobId} event={claim.eventId} "
                  f"stage={claim.executionStageRunId} phase={failure.phase} category={failure.category} "
                  f"completed_through={failure.completed_through}", flush=True)
            raise

    async def observed_request(self, event, operation, body=None, **options):
        try:
            result = await request(self, event, operation, body, **options)
            if getattr(result, "durable", False):
                terminal[event.eventId] = {"state": result.state,
                                           "receiptId": (result.receipt or {}).get("receiptId")}
            if operation in ("fail", "complete"):
                print(f"E2E04_COMMAND operation={operation} status=200 state={result.state}", flush=True)
                print("E2E04_COMMAND_JSON " + json.dumps({"eventId": event.eventId, "operation": operation,
                      "status": 200, "state": result.state, **_delivery_context.get()}), flush=True)
            return result
        except CoreError as error:
            if operation in ("fail", "complete"):
                print(f"E2E04_COMMAND operation={operation} status={error.status} code={error.code}", flush=True)
                print("E2E04_COMMAND_JSON " + json.dumps({"eventId": event.eventId, "operation": operation,
                      "status": error.status, "code": error.code, **_delivery_context.get()}), flush=True)
            raise

    async def observed_handle(self, delivery):
        class DeliveryObserver:
            def __getattr__(self, name):
                return getattr(delivery, name)

            async def ack(self):
                event_id = delivery.message_id
                observed = terminal.get(event_id)
                channel = delivery.channel
                identity = {"eventId": event_id, "deliveryTag": delivery.delivery_tag,
                            "channel": getattr(channel, "number", None),
                            "redelivered": delivery.redelivered, "terminal": observed}
                await control.observe_delivery(
                    event_id=event_id, delivery_tag=delivery.delivery_tag,
                    channel=identity["channel"], redelivered=delivery.redelivered,
                    action="ack", phase="invoked",
                )
                print("E2E04_ACK " + json.dumps({**identity, "operation": "invoked"}), flush=True)
                await control.checkpoint(PRE_ACK, event_id=event_id)
                await delivery.ack()
                await control.observe_delivery(
                    event_id=event_id, delivery_tag=delivery.delivery_tag,
                    channel=identity["channel"], redelivered=delivery.redelivered,
                    action="ack", phase="client_completed",
                )
                print("E2E04_ACK " + json.dumps({**identity, "operation": "client_completed"}), flush=True)

            async def nack(self, *args, **kwargs):
                await control.observe_delivery(
                    event_id=delivery.message_id, delivery_tag=delivery.delivery_tag,
                    channel=getattr(delivery.channel, "number", None),
                    redelivered=delivery.redelivered, action="nack", phase="invoked",
                )
                result = await delivery.nack(*args, **kwargs)
                await control.observe_delivery(
                    event_id=delivery.message_id, delivery_tag=delivery.delivery_tag,
                    channel=getattr(delivery.channel, "number", None),
                    redelivered=delivery.redelivered, action="nack", phase="client_completed",
                )
                return result

            async def reject(self, *args, **kwargs):
                await control.observe_delivery(
                    event_id=delivery.message_id, delivery_tag=delivery.delivery_tag,
                    channel=getattr(delivery.channel, "number", None),
                    redelivered=delivery.redelivered, action="reject", phase="invoked",
                )
                result = await delivery.reject(*args, **kwargs)
                await control.observe_delivery(
                    event_id=delivery.message_id, delivery_tag=delivery.delivery_tag,
                    channel=getattr(delivery.channel, "number", None),
                    redelivered=delivery.redelivered, action="reject", phase="client_completed",
                )
                return result

        observation = message_observation(delivery)
        print("E2E04_MESSAGE " + json.dumps(observation, separators=(",", ":")), flush=True)
        token = _delivery_context.set({field: observation[field] for field in
                                       ("channel", "deliveryTag", "redelivered", "deliveryCount")})
        try:
            await handle(self, DeliveryObserver())
        finally:
            _delivery_context.reset(token)

    TranscriptionWorker._prepare = observed_prepare
    TranscriptionWorker.handle = observed_handle
    CoreApiClient.request = observed_request
    CoreApiClient.claim = observed_claim


def main() -> int:
    try:
        settings = load_settings(env_file=None)
        if settings.environment is not Environment.TEST:
            raise ConfigurationError("controlled E2E-04 requires test environment")
        control = RecoveryControl.child(settings.environment, os.environ)

        async def run():
            try:
                install_diagnostics(control)
                configure_logging(settings)
                execution = TranscriptionExecution(settings, pipeline_factory=controlled_pipeline)
                return await run_worker(settings, ControlledExecution(execution), (lambda: execution,))
            finally:
                await control.close()

        return asyncio.run(run())
    except ConfigurationError:
        sys.stderr.write("e2e04.worker.configuration.failed\n")
        return 1
    except KeyboardInterrupt:
        return 0
    except Exception:
        sys.stderr.write("e2e04.worker.runtime.failed\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
