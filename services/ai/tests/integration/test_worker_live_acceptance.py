"""Opt-in cross-service acceptance against an externally admitted synthetic job.

Provision an isolated V1 Core/broker/store environment and publish exactly the
synthetic fixture event before opting in. This test creates no business admission,
receiver, topology or authentication bypass. See README remediation acceptance.
"""

import asyncio
import os
import signal
from pathlib import Path

import pytest

from sme_meeting_ai.core.config import load_settings
from sme_meeting_ai.integrations.core_api import CoreApiClient, CoreError, strict_json
from sme_meeting_ai.integrations.messaging import decode_event
from sme_meeting_ai.workers.__main__ import run_worker
from sme_meeting_ai.workers.transcription import TranscriptionExecution

pytestmark = pytest.mark.live_infrastructure


def test_real_worker_reaches_durable_corrected_acceptance_and_stops():
    if os.environ.get("RUN_WORKER_LIVE_ACCEPTANCE") != "1":
        pytest.skip("Explicit isolated cross-service acceptance opt-in is required")
    fixture = os.environ.get("AI_WORKER_ACCEPTANCE_EVENT_FILE")
    if not fixture:
        pytest.fail("An externally admitted synthetic event fixture is required")
    with Path(fixture).open("rb") as source:
        raw = source.read(16385)
    body = strict_json(raw, 16384)
    event = decode_event(raw, headers={"eventId": body["eventId"], "eventType": (
        "PROCESSING_JOB_QUEUED" if body["schemaVersion"] == 1 else "PROCESSING_JOB_RETRY_REQUESTED"
    )}, message_id=body["eventId"], content_type="application/json", delivery_mode=2)
    settings = load_settings(env_file=None)

    async def run():
        execution = TranscriptionExecution(settings)
        core = CoreApiClient(settings)
        runtime = None
        try:
            before = await core.lookup(event)
            assert before.state == "AVAILABLE", "Acceptance fixture must be newly admitted, unclaimed work"
            runtime = asyncio.create_task(run_worker(settings, execution, (lambda: execution,)))
            # Short synthetic audio, real TLS/broker/storage/ASR/correction/Core.
            async with asyncio.timeout(180):
                while True:
                    if runtime.done():
                        pytest.fail("Worker terminated before durable fixture acceptance")
                    try:
                        status = await core.lookup(event)
                    except CoreError:
                        pytest.fail("Core acceptance lookup failed (details suppressed)")
                    if status.durable:
                        assert status.state == "RESULT_ACCEPTED", "Fixture was not accepted as corrected output"
                        assert execution.broker.tag is not None, "Worker did not start intake"
                        break
                    await asyncio.sleep(0.2)
            os.kill(os.getpid(), signal.SIGTERM)
            assert await runtime == 0
            assert execution.broker.tag is None and execution.worker._closed
        finally:
            if runtime is not None:
                if not runtime.done():
                    runtime.cancel()
                await asyncio.gather(runtime, return_exceptions=True)
            await core.aclose()
    asyncio.run(run())
