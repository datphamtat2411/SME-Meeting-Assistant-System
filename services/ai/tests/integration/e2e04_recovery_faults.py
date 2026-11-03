"""Small test-process fault boundaries; never imported by production composition."""

import asyncio
import hashlib
import json
import os
import time
from contextlib import contextmanager
from contextvars import ContextVar

from test_worker_live_acceptance import controlled_pipeline

from sme_meeting_ai.integrations.core_api import CoreError
from sme_meeting_ai.transcription.correction import (
    CorrectionError,
    CorrectionErrorCategory,
)

POST_COMPLETE = "post_complete"
PRE_COMPLETE = "pre_complete"
CORE_RESTORED = "core_restored"
SOURCE_OPEN = "source_open"
execution_binding = ContextVar("e2e04_execution", default={})


def emit(prefix, **fields):
    print(prefix + " " + json.dumps({"monotonicNs": time.monotonic_ns(), **fields},
                                    separators=(",", ":")), flush=True)


class RecoveryFaults:
    def __init__(self, control, scenario):
        if scenario not in ("", "lost_completion", "lease_expiry", "provider_failure",
                            "core_outage", "crash_inflight", "concurrent_claims"):
            raise ValueError("unsupported recovery fault")
        self.control = control
        self.scenario = scenario
        self.activated = 0
        self.renewal_interrupted = False
        self.release_renewal = asyncio.Event()

    async def once(self, call, event, operation, body, deadline):
        if self.scenario == "core_outage" and operation == "complete" and not self.activated:
            self.activated += 1
            await self.control.checkpoint(PRE_COMPLETE, event_id=event.eventId)
            try:
                await call(event, operation, body, deadline)
            except CoreError as error:
                assert error.status == 0, "outage must cause a real transport failure"
                emit("E2E04_FAULT", eventId=event.eventId, generation=event.generation,
                     fault="core_unavailable", status=error.status, code=error.code)
            else:
                raise AssertionError("Core was available at the outage fault boundary")
            await self.control.checkpoint(CORE_RESTORED, event_id=event.eventId)
            return await self.stale_probe(call, event, body)
        if self.renewal_interrupted and operation == "renew":
            emit("E2E04_FAULT", eventId=event.eventId, generation=event.generation,
                 fault="renewal_interrupted")
            await asyncio.wait_for(self.release_renewal.wait(), timeout=240)
        if self.scenario == "lease_expiry" and operation == "complete" and not self.activated:
            self.activated += 1
            self.renewal_interrupted = True
            try:
                await self.control.checkpoint(PRE_COMPLETE, event_id=event.eventId)
                # Adversarial *new* stale HTTP command, not accepted-command replay.
                # Keep the original binding in this process only. Bypass solely the
                # client's expired local deadline so the real Core rejects it.
                return await self.stale_probe(call, event, body)
            finally:
                self.release_renewal.set()
        result = await call(event, operation, body, deadline)
        if self.scenario == "lost_completion" and operation == "complete" and not self.activated:
            assert result.state == "RESULT_ACCEPTED" and result.durable
            self.activated += 1
            # This discards a real response at the test client-adapter boundary.
            # It deliberately makes no claim about packet-level TCP loss.
            emit("E2E04_FAULT", eventId=event.eventId, processingJobId=event.processingJobId,
                 generation=event.generation, fault="discard_completion_response",
                 receiptId=result.receipt["receiptId"])
            await self.control.checkpoint(POST_COMPLETE, event_id=event.eventId)
            raise CoreError()
        if self.scenario == "provider_failure" and operation == "fail":
            replay = await call(event, operation, body, None)
            assert replay.replay is True and replay.receipt == result.receipt
            emit("E2E04_REPLAY", eventId=event.eventId, generation=event.generation,
                 operation="fail", receiptId=result.receipt["receiptId"],
                 replay=replay.replay, commandId=body["commandId"],
                 commandSha256=hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest())
        return result

    async def stale_probe(self, call, event, body):
        try:
            result = await call(event, "complete", body, None)
        except CoreError as error:
            emit("E2E04_FAULT", eventId=event.eventId, generation=event.generation,
                 fault="stale_completion_rejected", status=error.status, code=error.code,
                 commandId=body.get("commandId"))
            raise
        raise AssertionError("stale completion unexpectedly accepted: " + result.state)


class ControlledProviderFailure:
    def complete(self, request):
        emit("E2E04_PROVIDER_FAILURE", category="PROVIDER", **execution_binding.get())
        raise CorrectionError(CorrectionErrorCategory.PROVIDER)


def campaign_pipeline(settings, resources):
    pipeline = controlled_pipeline(settings, resources)
    if os.environ.get("AI_E2E04_FAULT") == "provider_failure":
        pipeline._correction_provider = ControlledProviderFailure()
    original = pipeline.run

    def observed_run(source):
        emit("E2E04_PIPELINE", phase="started", **execution_binding.get())
        outcome = original(source)
        emit("E2E04_PIPELINE_RESULT", status=outcome.status.value,
             completedStages=[stage.name for stage in outcome.completed_stages],
             failurePhase=outcome.failure.stage.name if outcome.failure else None,
             failureCategory=outcome.failure.category if outcome.failure else None,
             **execution_binding.get())
        return outcome

    pipeline.run = observed_run
    return pipeline


@contextmanager
def checkpoint_source(source_context, control, loop, *, event_id):
    with source_context as path:
        future = asyncio.run_coroutine_threadsafe(control.checkpoint(SOURCE_OPEN, event_id=event_id), loop)
        try:
            future.result(timeout=240)
        finally:
            if not future.done():
                future.cancel()
        yield path
