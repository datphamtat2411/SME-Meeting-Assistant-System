"""Test-only real-transport worker. Configuration/checkpoints use private pipes.

Started by Spk11FullStackSmokeTests, never by a deployed worker entry point.
Only inference HTTP and fault/checkpoint controls are injected.
"""

import asyncio
import json
import logging
import sys
import threading
from contextlib import AsyncExitStack, ExitStack
from unittest.mock import patch

from integration.spk11_fixtures import FakeInference, controlled_adapter
from pydantic import ValidationError

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.diarization.contract import MAX_RESULT_BYTES
from sme_meeting_ai.diarization.service import DiarizationService
from sme_meeting_ai.integrations.core_api import CoreError
from sme_meeting_ai.integrations.diarization import QUEUE, DiarizationCoreClient
from sme_meeting_ai.integrations.messaging import RabbitConsumer
from sme_meeting_ai.integrations.object_storage import ObjectStorage, StorageError
from sme_meeting_ai.workers.diarization import DiarizationWorker

PHASES = frozenset({"CONFIGURATION", "PROVIDER_SETUP", "TEMP_STORAGE", "CORE_MTLS",
                    "RABBITMQ", "WORKER_STARTUP", "RUNTIME"})
CATEGORIES = frozenset({"VALIDATION", "CONFIGURATION", "AUTHENTICATION", "FILESYSTEM",
                        "TIMEOUT", "TRANSPORT", "RESOURCE", "INTERRUPTED", "UNEXPECTED"})


class Diagnostics:
    """Fixed test-only identifiers; never serialize exception text or attributes."""

    def __init__(self):
        self.phase = "CONFIGURATION"

    def failure(self, error):
        category = "UNEXPECTED"
        if isinstance(error, StorageError):
            category = error.category if error.category in CATEGORIES else "UNEXPECTED"
        elif isinstance(error, CoreError):
            category = "AUTHENTICATION" if error.status in (401, 403) else "TRANSPORT"
        elif isinstance(error, (ValidationError, ValueError, KeyError, TypeError)):
            category = "VALIDATION"
        elif isinstance(error, TimeoutError):
            category = "TIMEOUT"
        elif isinstance(error, ConnectionError):
            category = "TRANSPORT"
        elif isinstance(error, OSError):
            category = "FILESYSTEM"
        elif isinstance(error, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
            category = "INTERRUPTED"
        return dict(failure="SPK11_WORKER_PROCESS_FAILED",
                    phase=self.phase if self.phase in PHASES else "CONFIGURATION", category=category)


async def run(config, diagnostic):
    logging.disable(logging.CRITICAL)
    settings = Settings(**config["settings"], _env_file=None)
    diagnostic.phase = "PROVIDER_SETUP"
    lock = threading.Lock()

    def checkpoint(name):
        if config.get("pause") == name:
            with lock:
                print(json.dumps({"checkpoint": name}), flush=True)
                if sys.stdin.readline().strip() != "continue":
                    raise RuntimeError("SPK11_CONTROL_CLOSED")

    # Forbid upstream execution explicitly, including during retry/recovery.
    from sme_meeting_ai.pipeline import OfflineTranscriptionPipeline

    def forbidden(*args, **kwargs):
        raise AssertionError("SPK11_UPSTREAM_EXECUTION_FORBIDDEN")

    fake = FakeInference(config.get("mode", "two"), checkpoint)
    counts = dict(claims=0, completes=0, failures=0, acks=0, lookups=0, core_errors=0, core_status=0, rejects=0)

    class Core(DiarizationCoreClient):
        async def claim(self, *args, **kwargs):
            checkpoint("before-claim")
            counts["claims"] += 1
            claim = await super().claim(*args, **kwargs)
            checkpoint("claimed")
            return claim

        async def request(self, event, operation, body=None, **kwargs):
            if operation.startswith("deliveries/"):
                counts["lookups"] += 1
            if operation in ("complete", "fail"):
                counts["completes" if operation == "complete" else "failures"] += 1
            try:
                status = await super().request(event, operation, body, **kwargs)
            except CoreError as error:
                counts["core_errors"] += 1
                counts["core_status"] = error.status
                raise
            if operation == "complete" and status.state == "RESULT_ACCEPTED":
                checkpoint("accepted")
                if config.get("replay"):
                    replay = await super().request(event, operation, body)
                    assert replay.receipt == status.receipt, "Completion replay changed the durable receipt"
                if config.get("lose_response"):
                    config["lose_response"] = False
                    raise CoreError()  # Actual HTTP committed; simulate lost response to orchestration.
            return status

    class Storage(ObjectStorage):
        def put_result(self, *args, **kwargs):
            result = super().put_result(*args, **kwargs)
            checkpoint("uploaded")
            return result

    class Runner:
        def __init__(self, adapter):
            self.service = DiarizationService(adapter)

        def run(self, request, fence, deadline):
            return self.service.run(request)

        def close(self):
            pass

    class Delivery:
        def __init__(self, actual):
            self.actual = actual

        def __getattr__(self, name):
            return getattr(self.actual, name)

        async def ack(self):
            if config.get("lose_ack"):
                raise ConnectionError("SPK11_ACK_INTERRUPTED")
            await self.actual.ack()
            counts["acks"] += 1

        async def reject(self, **kwargs):
            counts["rejects"] += 1
            await self.actual.reject(**kwargs)

    with ExitStack() as resources:
        resources.enter_context(patch.object(OfflineTranscriptionPipeline, "run", forbidden))
        adapter = resources.enter_context(controlled_adapter(settings, fake))
        diagnostic.phase = "TEMP_STORAGE"
        storage = resources.enter_context(Storage(
            settings, result_max_bytes=MAX_RESULT_BYTES, namespace="sme-diarization-worker"))
        async with AsyncExitStack() as transports:
            diagnostic.phase = "CORE_MTLS"
            core = Core(settings)
            transports.push_async_callback(core.aclose)
            diagnostic.phase = "RABBITMQ"
            broker = await transports.enter_async_context(RabbitConsumer(settings, queue_name=QUEUE, prefetch=1))
            diagnostic.phase = "WORKER_STARTUP"
            worker = DiarizationWorker(settings, core, storage, Runner(adapter))
            finished = asyncio.Event()
            runtime_errors = []

            async def handle(message):
                try:
                    await worker.handle(Delivery(message))
                except Exception as error:
                    # RabbitConsumer can remove completed tasks before drain().
                    # Retain errors privately so an unexpected failure cannot look successful.
                    runtime_errors.append(error)
                finally:
                    finished.set()

            try:
                await broker.start(handle)
                diagnostic.phase = "RUNTIME"
                async with asyncio.timeout(60):
                    await finished.wait()
                await broker.stop()
                await broker.drain()
                if runtime_errors:
                    raise runtime_errors[0]
            finally:
                await worker.aclose()
    counts["uploads"] = sum(path == "/v1/files" for _, path in fake.calls)
    counts["predictions"] = sum(path == "/v1/predictions" for _, path in fake.calls)
    print(json.dumps({"checkpoint": "finished", **counts, "backoffs": fake.backoffs}), flush=True)


if __name__ == "__main__":
    diagnostic = Diagnostics()
    try:
        asyncio.run(run(json.loads(sys.stdin.readline()), diagnostic))
    except BaseException as error:
        # Tracebacks can contain requests, tokens or private local paths.
        print(json.dumps(diagnostic.failure(error)), flush=True)
        sys.exit(1)
