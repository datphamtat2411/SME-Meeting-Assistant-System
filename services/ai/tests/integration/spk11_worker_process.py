"""Test-only real-transport worker. Configuration/checkpoints use private pipes.

Started by Spk11FullStackSmokeTests, never by a deployed worker entry point.
Only inference HTTP and fault/checkpoint controls are injected.
"""

import asyncio
import json
import logging
import sys
import threading
from contextlib import aclosing

from integration.spk11_fixtures import FakeInference, controlled_adapter

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.diarization.contract import MAX_RESULT_BYTES
from sme_meeting_ai.diarization.service import DiarizationService
from sme_meeting_ai.integrations.core_api import CoreError
from sme_meeting_ai.integrations.diarization import QUEUE, DiarizationCoreClient
from sme_meeting_ai.integrations.messaging import RabbitConsumer
from sme_meeting_ai.integrations.object_storage import ObjectStorage
from sme_meeting_ai.workers.diarization import DiarizationWorker


async def run(config):
    logging.disable(logging.CRITICAL)
    settings = Settings(**config["settings"], _env_file=None)
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
    OfflineTranscriptionPipeline.run = forbidden

    fake = FakeInference(config.get("mode", "two"), checkpoint)
    counts = dict(claims=0, completes=0, failures=0, acks=0)

    class Core(DiarizationCoreClient):
        async def claim(self, *args, **kwargs):
            checkpoint("before-claim")
            counts["claims"] += 1
            claim = await super().claim(*args, **kwargs)
            checkpoint("claimed")
            return claim

        async def request(self, event, operation, body, **kwargs):
            if operation in ("complete", "fail"):
                counts["completes" if operation == "complete" else "failures"] += 1
            status = await super().request(event, operation, body, **kwargs)
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

    with controlled_adapter(settings, fake) as adapter, Storage(
        settings, result_max_bytes=MAX_RESULT_BYTES, namespace="sme-diarization-worker",
    ) as storage:
        async with aclosing(Core(settings)) as core, RabbitConsumer(settings, queue_name=QUEUE, prefetch=1) as broker:
            worker = DiarizationWorker(settings, core, storage, Runner(adapter))
            finished = asyncio.Event()

            async def handle(message):
                try:
                    await worker.handle(Delivery(message))
                finally:
                    finished.set()

            try:
                await broker.start(handle)
                async with asyncio.timeout(60):
                    await finished.wait()
                await broker.stop()
                await broker.drain()
            finally:
                await worker.aclose()
    counts["uploads"] = sum(path == "/v1/files" for _, path in fake.calls)
    counts["predictions"] = sum(path == "/v1/predictions" for _, path in fake.calls)
    print(json.dumps({"checkpoint": "finished", **counts, "backoffs": fake.backoffs}), flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(run(json.loads(sys.stdin.readline())))
    except BaseException:
        # Tracebacks can contain requests, tokens or private local paths.
        print('{"failure":"SPK11_WORKER_PROCESS_FAILED"}', flush=True)
        sys.exit(1)
