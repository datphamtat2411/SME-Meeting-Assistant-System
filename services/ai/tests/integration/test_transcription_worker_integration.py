"""Contract V1 stateful Core/storage/broker tests; no deployed Core is assumed."""

import asyncio
import hashlib
import json
import threading
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from integration.test_offline_transcription_pipeline import pipeline
from integration.test_offline_transcription_pipeline import workflow as workflow
from unit.test_worker_integrations import (
    S3,
    decode,
    envelope,
    event_body,
    storage_settings,
)

from sme_meeting_ai.integrations.core_api import CoreApiClient
from sme_meeting_ai.integrations.object_storage import ObjectStorage
from sme_meeting_ai.pipeline import OfflineTranscriptionStage as Stage
from sme_meeting_ai.pipeline import OfflineTranscriptionStatus as Status
from sme_meeting_ai.pipeline.offline_transcription import OfflineTranscriptionFailure
from sme_meeting_ai.workers.transcription import TranscriptionWorker


class Delivery:
    def __init__(self, body, count=0):
        self.body = json.dumps(body).encode()
        self.headers = {"eventId": body["eventId"], "eventType": (
            "PROCESSING_JOB_QUEUED" if body["schemaVersion"] == 1 else "PROCESSING_JOB_RETRY_REQUESTED"
        ), "x-delivery-count": count}
        self.message_id = body["eventId"]
        self.content_type = "application/json"
        self.delivery_mode = 2
        self.actions = []

    async def ack(self):
        self.actions.append("ack")

    async def nack(self, *, requeue):
        self.actions.append("nack" if requeue else "dead")

    async def reject(self, *, requeue):
        self.actions.append("nack" if requeue else "dead")


class FakeCore:
    """Durable generation, lease fencing, claim replay and atomic receipt model."""

    def __init__(self, body, s3):
        self.body, self.s3 = body, s3
        self.generation = body.get("attemptNumber", 0)
        self.state = "AVAILABLE"
        self.claim = None
        self.receipt = None
        self.claim_request = None
        self.requests = []
        self.transcripts = []
        self.failures = []
        self.renewals = 0
        self.lost_complete = False
        self.lost_claim = False
        self.unavailable = False
        self.expired = False
        self.execution_stage = "TRANSCRIPTION"
        self.reusable = None
        self.rollback = False

    def status(self, replay=None):
        data = dict(contractVersion="1.0", processingJobId=self.body["processingJobId"],
                    eventId=self.body["eventId"], generation=self.generation,
                    state=self.state, receipt=self.receipt)
        if replay is not None:
            data["replay"] = replay
        return data

    def response(self, data=None, status=200, code="OK"):
        return httpx.Response(status, json=envelope(data, code, status == 200),
                              headers={"Cache-Control": "no-store"})

    async def __call__(self, request):
        operation = request.url.path.rsplit("/", 1)[-1]
        command = json.loads(request.content) if request.content else None
        self.requests.append((operation, command))
        if self.unavailable:
            return self.response(status=503, code="UNAVAILABLE")
        if request.method == "GET":
            return self.response(self.status())
        if operation == "claim":
            if self.state in ("RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED"):
                return self.response(self.status())
            if self.claim_request and self.claim_request != command["claimRequestId"]:
                return self.response(status=409, code="WORKER_ATTEMPT_BUSY")
            self.claim_request = command["claimRequestId"]
            now = datetime.now(UTC)
            self.claim = self.claim or dict(
                contractVersion="1.0", eventId=self.body["eventId"], generation=self.generation,
                processingJobId=self.body["processingJobId"], meetingId=self.body["meetingId"],
                sourceMediaId=self.body["sourceMediaId"], executionStageRunId=str(uuid4()),
                executionStageCode=self.execution_stage, claimToken=str(uuid4()),
                leaseExpiresAt=(now + timedelta(seconds=20)).isoformat(), serverTime=now.isoformat(),
                leaseSeconds=20, renewAfterSeconds=1,
                source=dict(sourceMediaId=self.body["sourceMediaId"], sourceRevision=hashlib.sha256(self.s3.data).hexdigest(),
                            storageId="private", objectKey="accepted/source", contentType="audio/wav",
                            sizeBytes=len(self.s3.data), sha256=hashlib.sha256(self.s3.data).hexdigest(), durationMs=1000),
                resultSlot=None, reusableResult=self.reusable,
            )
            self.claim["resultSlot"] = dict(storageId="private", maxBytes=8388608,
                objectKey=f"processing/{self.body['processingJobId']}/transcription/results/{self.claim['executionStageRunId']}.json")
            self.state = "RUNNING"
            if self.lost_claim:
                self.lost_claim = False
                raise httpx.ReadTimeout("private claim response lost", request=request)
            return self.response(self.claim, code="WORKER_CLAIMED")
        if self.expired:
            self.state = "AWAITING_RECONCILIATION"
            return self.response(status=409, code="WORKER_LEASE_LOST")
        assert command["claimToken"] == self.claim["claimToken"]
        assert command["executionStageRunId"] == self.claim["executionStageRunId"]
        assert command["generation"] == self.generation
        if operation == "renew":
            self.renewals += 1
            now = datetime.now(UTC)
            return self.response(dict(contractVersion="1.0", serverTime=now.isoformat(),
                                     leaseExpiresAt=(now + timedelta(seconds=20)).isoformat(), renewAfterSeconds=1))
        if operation == "complete":
            if self.state == "RESULT_ACCEPTED":
                if self.receipt["resultSha256"] != command["resultSha256"]:
                    return self.response(status=409, code="WORKER_RESULT_CONFLICT")
                return self.response(self.status(True))
            if self.rollback:
                return self.response(status=503, code="TRANSACTION_ROLLED_BACK")
            producer = command["resultProducerStageRunId"]
            key = f"processing/{self.body['processingJobId']}/transcription/results/{producer}.json"
            raw = self.s3.objects[key]
            assert hashlib.sha256(raw).hexdigest() == command["resultSha256"]
            result = json.loads(raw)
            self.transcripts.append(result)
            self.receipt = dict(receiptId=str(uuid4()), resultSha256=command["resultSha256"],
                correctionSha256=result["correctionProof"]["outputSha256"], transcriptId=str(uuid4()),
                transcriptStatus="READY_WITH_WARNINGS" if result["warnings"] else "READY",
                acceptedAt=datetime.now(UTC).isoformat())
            self.state = "RESULT_ACCEPTED"
            if self.lost_complete:
                self.lost_complete = False
                raise httpx.ReadTimeout("private response lost", request=request)
            return self.response(self.status(False))
        assert operation == "fail"
        if self.state == "RESULT_ACCEPTED":
            return self.response(self.status(True))
        self.failures.append(command)
        self.state = "FAILURE_RECORDED"
        self.receipt = dict(receiptId=str(uuid4()), errorCode="LLM_CORRECTION_FAILED", retryable=False,
                            retryExhausted=True, recordedAt=datetime.now(UTC).isoformat())
        return self.response(self.status(False))


async def setup(h, *, run=None):
    body = event_body()
    h.source = replace(h.source, source_id=body["sourceMediaId"])
    s3 = S3()
    core = FakeCore(body, s3)
    http = httpx.AsyncClient(transport=httpx.MockTransport(core))
    api = CoreApiClient(h.settings, client=http, sleep=lambda _: asyncio.sleep(0))
    storage = ObjectStorage(storage_settings(h.work), client=s3)
    storage.__enter__()
    calls = []
    original = pipeline(h)

    def execute(source):
        calls.append(source)
        assert source.path.read_bytes() == s3.data
        return run(source) if run else original.run(source)

    worker = TranscriptionWorker(h.settings, api, storage, SimpleNamespace(run=execute))
    return SimpleNamespace(worker=worker, core=core, storage=storage, s3=s3, http=http,
                           body=body, calls=calls)


async def cleanup(r):
    await r.worker.aclose()
    r.storage.__exit__(None, None, None)
    await r.http.aclose()


@pytest.mark.parametrize("lost", [False, True])
def test_durable_acceptance_duplicate_restart_and_lost_response(workflow, lost):
    async def run():
        r = await setup(workflow())
        try:
            r.core.lost_complete = lost
            first = Delivery(r.body)
            await r.worker.handle(first)
            assert first.actions == ["ack"] and len(r.core.transcripts) == 1
            receipt = r.core.receipt.copy()
            # A new worker has no in-memory claim/receipt cache.
            other = TranscriptionWorker(r.worker.settings, r.worker.core, r.storage, r.worker.pipeline)
            duplicate = Delivery(r.body, 1)
            await other.handle(duplicate)
            await other.aclose()
            assert duplicate.actions == ["ack"]
            assert len(r.calls) == len(r.core.transcripts) == 1
            assert r.core.receipt == receipt and not r.core.failures
        finally:
            await cleanup(r)
    asyncio.run(run())


def test_correction_failure_preserves_text_free_prefix(workflow):
    async def run():
        h = workflow()
        base = pipeline(h)

        def fail(source):
            outcome = base.run(source)
            return replace(outcome, status=Status.FAILED, result=None,
                           completed_stages=tuple(Stage)[:-1],
                           failure=OfflineTranscriptionFailure(Stage.CORRECTION, "PROVIDER"))
        r = await setup(h, run=fail)
        try:
            delivery = Delivery(r.body)
            await r.worker.handle(delivery)
            assert delivery.actions == ["ack"]
            assert r.core.failures[0]["completedThrough"] == "RECONCILIATION"
            assert r.core.failures[0]["phase"] == "CORRECTION"
            assert not r.s3.objects and not r.core.transcripts
            assert "text" not in json.dumps(r.core.failures)
        finally:
            await cleanup(r)
    asyncio.run(run())


@pytest.mark.parametrize("count,action", [(0, "nack"), (5, "dead")])
def test_unavailable_core_bounded_delivery_budget(workflow, count, action):
    async def run():
        r = await setup(workflow())
        try:
            r.core.unavailable = True
            delivery = Delivery(r.body, count)
            await r.worker.handle(delivery)
            assert delivery.actions == [action]
            assert len(r.core.requests) == 3 and not r.calls
        finally:
            await cleanup(r)
    asyncio.run(run())


def test_publication_rollback_preserves_corrected_artifact_and_reuses_it(workflow):
    async def run():
        r = await setup(workflow())
        try:
            r.core.rollback = True
            delivery = Delivery(r.body)
            await r.worker.handle(delivery)
            assert delivery.actions == ["nack"]
            assert len(r.s3.objects) == 1 and not r.core.transcripts and not r.core.failures
            complete = [c for op, c in r.core.requests if op == "complete"]
            assert len({c["commandId"] for c in complete}) == 1
            r.core.rollback = False
            r.core.state = "AVAILABLE"
            r.core.claim_request = None
            producer = r.core.claim["executionStageRunId"]
            r.core.claim = None
            r.core.reusable = dict(storageId="private", producerStageRunId=producer,
                                  objectKey=next(iter(r.s3.objects)))
            duplicate = Delivery(r.body, 1)
            await r.worker.handle(duplicate)
            assert duplicate.actions == ["ack"]
            assert len(r.calls) == 1 and len(r.core.transcripts) == 1
        finally:
            await cleanup(r)
    asyncio.run(run())


def test_finalization_without_artifact_never_runs_inference(workflow):
    async def run():
        r = await setup(workflow())
        try:
            r.core.execution_stage = "FINALIZING_TRANSCRIPT"
            delivery = Delivery(r.body)
            await r.worker.handle(delivery)
            assert delivery.actions == ["ack"] and not r.calls
            assert r.core.failures[0]["phase"] == "PUBLICATION"
            assert r.core.failures[0]["category"] == "NOT_FOUND"
        finally:
            await cleanup(r)
    asyncio.run(run())


def test_lease_loss_fences_late_executor_and_preserves_source_until_reader_stops(workflow):
    async def run():
        entered, release = threading.Event(), threading.Event()
        paths = []
        h = workflow()
        base = pipeline(h)

        def blocked(source):
            paths.append(source.path)
            entered.set()
            release.wait(5)
            assert source.path.exists()
            return base.run(source)
        r = await setup(h, run=blocked)
        delivery = Delivery(r.body)
        task = asyncio.create_task(r.worker.handle(delivery))
        try:
            while not entered.is_set():
                await asyncio.sleep(0.01)
            r.core.expired = True
            await asyncio.sleep(1.1)
            assert paths[0].exists()
            release.set()
            await task
            assert delivery.actions != ["ack"] and not r.s3.objects
            await r.worker.aclose()
            assert not paths[0].exists()
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
            await cleanup(r)
    asyncio.run(run())


def test_cancellation_has_no_ack_or_premature_source_cleanup(workflow):
    async def run():
        entered, release = threading.Event(), threading.Event()
        paths = []
        h = workflow()
        base = pipeline(h)

        def blocked(source):
            paths.append(source.path)
            entered.set()
            release.wait(5)
            assert source.path.exists()
            return base.run(source)
        r = await setup(h, run=blocked)
        delivery = Delivery(r.body)
        task = asyncio.create_task(r.worker.handle(delivery))
        try:
            while not entered.is_set():
                await asyncio.sleep(0.01)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert not delivery.actions and paths[0].exists()
            release.set()
            await r.worker.aclose()
            assert not paths[0].exists() and not r.s3.objects
        finally:
            release.set()
            await cleanup(r)
    asyncio.run(run())


def test_renewal_runs_independently_while_inference_is_busy(workflow):
    async def run():
        entered, release = threading.Event(), threading.Event()
        h = workflow()
        base = pipeline(h)

        def blocked(source):
            entered.set()
            release.wait(5)
            return base.run(source)
        r = await setup(h, run=blocked)
        task = asyncio.create_task(r.worker.handle(Delivery(r.body)))
        try:
            while not entered.is_set():
                await asyncio.sleep(0.01)
            await asyncio.sleep(1.1)
            assert r.core.renewals >= 1
            release.set()
            await task
            assert len(r.core.transcripts) == 1
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
            await cleanup(r)
    asyncio.run(run())


def test_concurrent_duplicate_cannot_steal_live_claim(workflow):
    async def run():
        r = await setup(workflow())
        try:
            event = decode(r.body)
            owner = await r.worker.core.claim(event)
            duplicate = Delivery(r.body, 1)
            await r.worker.handle(duplicate)
            assert duplicate.actions == ["nack"] and not r.calls
            assert r.core.claim["claimToken"] == owner.claimToken.get_secret_value()
        finally:
            await cleanup(r)
    asyncio.run(run())


def test_shutdown_stops_intake_and_drains_before_returning(workflow):
    class Broker:
        def __init__(self):
            self.failure = asyncio.Event()
            self.stopped = False
            self.task = None
            self.closed = asyncio.get_running_loop().create_future()
            self.connection = SimpleNamespace(closed=lambda: self.closed)

        async def start(self, handler):
            self.task = asyncio.create_task(handler(self.delivery))

        async def stop(self):
            self.stopped = True

        async def drain(self):
            await self.task

    async def run():
        entered, release = threading.Event(), threading.Event()
        h = workflow()
        base = pipeline(h)

        def blocked(source):
            entered.set()
            release.wait(5)
            return base.run(source)
        r = await setup(h, run=blocked)
        broker = Broker()
        broker.delivery = Delivery(r.body)
        stop = asyncio.Event()
        task = asyncio.create_task(r.worker.run(broker, stop))
        try:
            while not entered.is_set():
                await asyncio.sleep(0.01)
            stop.set()
            await asyncio.sleep(0.01)
            assert broker.stopped and not task.done() and not broker.delivery.actions
            release.set()
            await task
            assert broker.delivery.actions == ["ack"]
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
            await cleanup(r)
    asyncio.run(run())


def test_claim_transport_replay_recovers_the_same_live_owner(workflow):
    async def run():
        r = await setup(workflow())
        try:
            r.core.lost_claim = True
            delivery = Delivery(r.body)
            await r.worker.handle(delivery)
            assert delivery.actions == ["ack"]
            claims = [command for op, command in r.core.requests if op == "claim"]
            assert len(claims) == 2 and claims[0] == claims[1]
            assert len(r.calls) == 1
        finally:
            await cleanup(r)
    asyncio.run(run())


def test_invalid_reusable_artifact_is_preserved_and_reported(workflow):
    async def run():
        r = await setup(workflow())
        try:
            producer = str(uuid4())
            key = f"processing/{r.body['processingJobId']}/transcription/results/{producer}.json"
            r.core.reusable = dict(storageId="private", objectKey=key, producerStageRunId=producer)
            r.s3.objects[key] = b'{"rawCandidate":"private ASR"}'
            delivery = Delivery(r.body)
            await r.worker.handle(delivery)
            assert delivery.actions == ["ack"] and not r.calls
            assert r.core.failures[0]["phase"] == "RESULT_VALIDATION"
            assert r.s3.objects[key] == b'{"rawCandidate":"private ASR"}'
            assert not r.core.transcripts
        finally:
            await cleanup(r)
    asyncio.run(run())


def test_ack_interruption_never_contradicts_accepted_result(workflow):
    class InterruptedAck(Delivery):
        async def ack(self):
            raise ConnectionError("private broker connection")

    async def run():
        r = await setup(workflow())
        try:
            first = InterruptedAck(r.body)
            await r.worker.handle(first)
            assert not first.actions and len(r.core.transcripts) == 1
            assert not r.core.failures and len(r.s3.objects) == 1
            restarted = TranscriptionWorker(r.worker.settings, r.worker.core, r.storage, r.worker.pipeline)
            duplicate = Delivery(r.body, 1)
            await restarted.handle(duplicate)
            await restarted.aclose()
            assert duplicate.actions == ["ack"] and len(r.calls) == 1
        finally:
            await cleanup(r)
    asyncio.run(run())


@pytest.mark.parametrize("lookup_valid", [False, True])
def test_http_200_without_a_durable_receipt_never_acknowledges(workflow, lookup_valid):
    async def run():
        r = await setup(workflow())
        real = r.core.__call__

        async def invalid_response(request):
            response = await real(request)
            if request.url.path.endswith("/complete") or (
                not lookup_valid and request.method == "GET" and r.core.state == "RESULT_ACCEPTED"
            ):
                data = r.core.status(False if request.method == "POST" else None)
                data["receipt"] = None
                return r.core.response(data)
            return response

        await r.http.aclose()
        r.http = httpx.AsyncClient(transport=httpx.MockTransport(invalid_response))
        r.worker.core.http = r.http
        try:
            delivery = Delivery(r.body)
            await r.worker.handle(delivery)
            # A malformed completion response cannot authorize ACK or a
            # contradictory failure. Only a valid covering lookup receipt can.
            assert len(r.core.transcripts) == 1 and not r.core.failures
            assert delivery.actions == (["ack"] if lookup_valid else ["nack"])
        finally:
            await cleanup(r)
    asyncio.run(run())
