"""SPK-09 boundary/recovery checks: real service, fake provider, HTTP and S3."""

import asyncio
import hashlib
import io
import json
import logging
import threading
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from botocore.exceptions import ClientError, ReadTimeoutError

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.diarization.contract import MAX_RESULT_BYTES
from sme_meeting_ai.diarization.models import (
    DiarizationError,
    DiarizationErrorCategory,
    DiarizationResult,
    SpeakerTurn,
)
from sme_meeting_ai.diarization.service import DiarizationService
from sme_meeting_ai.integrations.diarization import DiarizationCoreClient
from sme_meeting_ai.integrations.object_storage import ObjectStorage
from sme_meeting_ai.workers.diarization import DiarizationWorker


class Provider:
    def __init__(self):
        self.calls = []
        self.failure = None

    def diarize(self, path, **hints):
        self.calls.append((path.read_bytes(), hints))
        assert path.stat().st_mode & 0o077 == 0
        if self.failure:
            raise DiarizationError(self.failure)
        return DiarizationResult((SpeakerTurn(100, 1000, "SPEAKER_01"),),
                                 ("SPEAKER_01",), "test/diarizer-v1")


class Runner:
    """Controlled blocking seam; production uses a killable spawned process."""
    def __init__(self, provider):
        self.service = DiarizationService(provider)
        self.entered = threading.Event()
        self.hold = False

    def run(self, request, fence, deadline):
        self.entered.set()
        while self.hold and not fence.wait(0.005):
            pass
        if fence.is_set():
            return None
        return self.service.run(request)

    def close(self):
        pass


class S3:
    def __init__(self):
        self.audio = b"synthetic retained audio"
        self.objects = {}
        self.puts = []
        self.uncertain = False
        self.conflict = None
        self.fail_put = False

    def get_object(self, **kw):
        key = kw["Key"]
        if key.startswith("meetings/"):
            data = self.audio
        elif key in self.objects:
            data = self.objects[key]
        else:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"ContentLength": len(data), "Body": io.BytesIO(data)}

    def put_object(self, **kw):
        assert kw["IfNoneMatch"] == "*"
        self.puts.append(kw)
        if self.fail_put:
            raise ReadTimeoutError(endpoint_url="https://private.invalid")
        if self.conflict is not None:
            self.objects[kw["Key"]] = self.conflict
            raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
        elif kw["Key"] not in self.objects:
            self.objects[kw["Key"]] = kw["Body"]
        else:
            raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
        if self.uncertain:
            raise ReadTimeoutError(endpoint_url="https://private.invalid")


class Delivery:
    def __init__(self, event):
        self.body = json.dumps(event).encode()
        self.headers = dict(eventId=event["eventId"], eventType="PROCESSING_DIARIZATION_REQUESTED",
                            eventSchemaVersion=event["schemaVersion"])
        self.message_id = event["eventId"]
        self.content_type = "application/json"
        self.delivery_mode = 2
        self.routing_key = "processing.diarization.requested"
        self.exchange = "meeting.processing"
        self.redelivered = False
        self.actions = []

    async def ack(self):
        self.actions.append("ack")

    async def reject(self, *, requeue):
        self.actions.append(("reject", requeue))

    async def nack(self, *, requeue):
        pytest.fail("unresolved diarization must pause, never hot-requeue")


class Core:
    def __init__(self, audio):
        self.event = {k: str(uuid4()) for k in (
            "eventId", "processingJobId", "meetingId", "sourceMediaId", "transcriptId", "stageRunId",
        )}
        self.event.update(sourceRevision=hashlib.sha256(audio).hexdigest(), transcriptRevision=4,
                          schemaVersion=1, occurredAt="2026-11-07T00:00:00Z")
        e = self.event
        self.token = str(uuid4())
        self.slot = f"processing/{e['processingJobId']}/diarization/results/{e['stageRunId']}.json"
        self.calls = []
        self.state = "AVAILABLE"
        self.digest = "a" * 64
        self.verify_only = False
        self.uncertain_complete = False
        self.uncertain_claim = False
        self.renew_failure = False
        self.stale = False
        self.invalid_receipt = False
        self.renew_after = 30
        self.command_bodies = []
        self.accept_uncertain = True
        self.busy = False
        self.source_size = len(audio)

    def lease(self):
        now = datetime.now(UTC)
        return dict(contractVersion="1.0", serverTime=now.isoformat(),
                    leaseExpiresAt=(now + timedelta(seconds=60)).isoformat(),
                    leaseSeconds=60, renewAfterSeconds=self.renew_after)

    def status(self):
        e = self.event
        data = dict(contractVersion="1.0", processingJobId=e["processingJobId"],
                    eventId=e["eventId"], executionStageRunId=e["stageRunId"], state=self.state,
                    acknowledge=self.state in ("RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED"))
        if self.state == "RESULT_ACCEPTED":
            data["receipt"] = dict(receiptId=str(uuid4()), recordedAt=datetime.now(UTC).isoformat(),
                                   verificationId=str(uuid4()), resultSha256=self.digest)
        elif self.state == "FAILURE_RECORDED":
            data["receipt"] = dict(receiptId=str(uuid4()), recordedAt=datetime.now(UTC).isoformat(),
                                   errorCode="DIARIZATION_FAILED", retryable=False)
        elif self.state == "SUPERSEDED":
            data["receipt"] = dict(supersedingAttemptNumber=2)
        elif self.state == "RESULT_VERIFIED":
            data["verification"] = dict(verificationId=str(uuid4()), resultSha256=self.digest,
                                        verifiedAt=datetime.now(UTC).isoformat())
        if self.invalid_receipt:
            data.pop("receipt", None)
        return data

    def reply(self, data, status=200, code="OK"):
        return httpx.Response(status, json=dict(success=status == 200, code=code, data=data,
                                               message="safe", meta={}), headers={"Cache-Control": "no-store"})

    async def __call__(self, request):
        operation = request.url.path.rsplit("/", 1)[-1]
        body = json.loads(request.content) if request.content else None
        self.calls.append((operation, body))
        assert "/diarization/" in request.url.path
        assert request.headers["x-request-id"] == self.event["eventId"]
        e = self.event
        if operation == e["eventId"]:
            return self.reply(self.status())
        if operation == "claim":
            assert body["eventSchemaVersion"] == e["schemaVersion"]
            assert "requestedByUserId" not in body and "generation" not in body
            if self.busy:
                return self.reply(None, 409, "WORKER_ATTEMPT_BUSY")
            if self.uncertain_claim:
                self.uncertain_claim = False
                raise httpx.ReadTimeout("private claim response")
            self.state = "RUNNING"
            return self.reply(dict(**self.lease(), eventId=e["eventId"], processingJobId=e["processingJobId"],
                eventType="PROCESSING_DIARIZATION_REQUESTED", eventSchemaVersion=e["schemaVersion"],
                meetingId=e["meetingId"], executionStageRunId=e["stageRunId"], executionStageCode="DIARIZING",
                claimToken=self.token, source=dict(sourceMediaId=e["sourceMediaId"], sourceRevision=e["sourceRevision"],
                    sha256=e["sourceRevision"], storageId="private", objectKey=f"meetings/{e['meetingId']}/sources/{e['sourceMediaId']}",
                    contentType="audio/wav", sizeBytes=self.source_size, durationMs=2000),
                transcript=dict(transcriptId=e["transcriptId"], transcriptRevision=e["transcriptRevision"]),
                resultSlot=dict(storageId="private", objectKey=self.slot, producerStageRunId=e["stageRunId"],
                                maxBytes=MAX_RESULT_BYTES, createOnly=True, requiredIfNoneMatch="*")))
        assert body["claimToken"] == self.token
        assert body["executionStageRunId"] == e["stageRunId"]
        if operation == "snapshot":
            return self.reply(dict(transcriptId=e["transcriptId"], transcriptRevision=3 if self.stale else 4,
                                   durationMs=2000, segments=[dict(ordinal=7, startMs=100, endMs=900),
                                                            dict(ordinal=12, startMs=1500, endMs=1800)]))
        if operation == "renew":
            if self.renew_failure:
                return self.reply(None, 409, "WORKER_LEASE_LOST")
            return self.reply(self.lease())
        self.command_bodies.append(body)
        if operation == "complete":
            assert set(body) == {"contractVersion", "eventId", "executionStageRunId", "claimToken",
                                 "commandId", "resultSha256", "resultProducerStageRunId"}
            self.digest = body["resultSha256"]
            self.state = "RESULT_VERIFIED" if self.verify_only else "RESULT_ACCEPTED"
            if self.uncertain_complete:
                self.uncertain_complete = False
                if not self.accept_uncertain:
                    self.state = "RUNNING"
                raise httpx.ReadTimeout("private complete response")
        elif operation == "fail":
            assert set(body) == {"contractVersion", "eventId", "executionStageRunId", "claimToken",
                                 "commandId", "phase", "category"}
            self.state = "FAILURE_RECORDED"
        return self.reply(self.status())


@contextmanager
def harness(tmp_path, **overrides):
    settings = Settings(service_name="test", service_identity="ai-worker", environment="test", _env_file=None,
                        audio_temp_dir=tmp_path, s3_bucket="media", **overrides)
    s3 = S3()
    provider = Provider()
    runner = Runner(provider)
    core = Core(s3.audio)
    with ObjectStorage(settings, client=s3, result_max_bytes=MAX_RESULT_BYTES,
                       namespace="sme-diarization-worker") as storage:
        yield settings, s3, provider, runner, core, storage


async def execute(h, *, mutate=None):
    settings, s3, provider, runner, api, storage = h
    async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as http:
        core = DiarizationCoreClient(settings, client=http, sleep=lambda _: asyncio.sleep(0))
        worker = DiarizationWorker(settings, core, storage, runner)
        delivery = Delivery(api.event)
        if mutate:
            mutate(delivery)
        try:
            await worker.handle(delivery)
        finally:
            await worker.aclose()
        return worker, delivery


def test_success_exact_contract_no_text_unknown_assignment_and_duplicate(tmp_path, monkeypatch):
    def forbidden(*a, **k):
        pytest.fail("diarization invoked transcription/correction")
    from sme_meeting_ai.pipeline import OfflineTranscriptionPipeline
    from sme_meeting_ai.providers.openrouter_instruction_llm import (
        OpenRouterInstructionLlmAdapter,
    )
    from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
    monkeypatch.setattr(OfflineTranscriptionPipeline, "run", forbidden)
    monkeypatch.setattr(OpenRouterInstructionLlmAdapter, "__init__", forbidden)
    monkeypatch.setattr(OpenRouterWhisperAdapter, "__init__", forbidden)
    with harness(tmp_path) as h:
        _, s3, provider, _, api, _ = h
        _, delivery = asyncio.run(execute(h))
        assert delivery.actions == ["ack"]
        data = json.loads(s3.objects[api.slot])
        assert data["resultType"] == "DIARIZATION_RESULT"
        assert data["transcriptRevision"] == 4
        assert data["assignments"] == [dict(ordinal=7, speakerLabel="SPEAKER_01"), dict(ordinal=12, speakerLabel=None)]
        assert data["diagnostics"] == dict(unknownAssignmentCount=1)
        assert provider.calls[0][1] == dict(num_speakers=None, min_speakers=None, max_speakers=None)
        _, duplicate = asyncio.run(execute(h))
        assert duplicate.actions == ["ack"] and len(provider.calls) == len(s3.puts) == 1


def test_lifecycle_logs_are_sanitized_and_distinguish_replay(tmp_path, caplog):
    from sme_meeting_ai.observability.logging import JsonFormatter

    with caplog.at_level(logging.INFO, logger="sme_meeting_ai.workers.diarization"):
        with harness(tmp_path) as h:
            asyncio.run(execute(h))
            asyncio.run(execute(h))
            token = h[4].token
    output = [JsonFormatter("test").format(record) for record in caplog.records]
    events = [json.loads(line)["event"] for line in output]
    assert events.count("worker.diarization.notification.valid") == 2
    assert events.count("worker.diarization.claimed") == 1
    assert events.count("worker.diarization.inference.started") == 1
    assert events.count("worker.diarization.inference.completed") == 1
    assert events.count("worker.diarization.artifact.validated") == 1
    assert events.count("worker.diarization.result_accepted") == 2
    assert token not in "".join(output)
    assert "synthetic retained audio" not in "".join(output)


@pytest.mark.parametrize("location", ["body", "header"])
@pytest.mark.parametrize("version", [None, "1", True, 1.0, 2, {}, []])
def test_untrusted_versions_never_reach_core(tmp_path, location, version):
    with harness(tmp_path) as h:
        def mutate(d):
            if location == "header":
                d.headers["eventSchemaVersion"] = version
            else:
                body = json.loads(d.body)
                body["schemaVersion"] = version
                d.body = json.dumps(body).encode()
        _, delivery = asyncio.run(execute(h, mutate=mutate))
        assert delivery.actions == [("reject", False)]
        assert not h[4].calls and not h[2].calls


@pytest.mark.parametrize("mutation", ["missing-version", "missing-header", "route", "identity", "extra", "duplicate-key", "delivery-count"])
def test_bad_message_metadata_and_structure_are_quarantined(tmp_path, mutation):
    with harness(tmp_path) as h:
        def mutate(d):
            body = json.loads(d.body)
            if mutation == "missing-version":
                body.pop("schemaVersion")
            elif mutation == "missing-header":
                d.headers.pop("eventSchemaVersion")
            elif mutation == "route":
                d.routing_key = "processing.job.queued"
            elif mutation == "identity":
                d.message_id = str(uuid4())
            elif mutation == "extra":
                body["text"] = "private transcript"
            elif mutation == "delivery-count":
                d.headers["x-delivery-count"] = True
            d.body = json.dumps(body).encode()
            if mutation == "duplicate-key":
                d.body = d.body[:-1] + b',"schemaVersion":1}'
        _, delivery = asyncio.run(execute(h, mutate=mutate))
        assert delivery.actions == [("reject", False)] and not h[4].calls


def test_valid_artifact_reused_after_delivery_recovery_without_inference(tmp_path):
    with harness(tmp_path) as h:
        _, s3, provider, _, api, _ = h
        asyncio.run(execute(h))
        api.state = "AVAILABLE"  # Explicit fake Core reauthorization of this exact slot.
        _, recovered = asyncio.run(execute(h))
        assert recovered.actions == ["ack"]
        assert len(provider.calls) == len(s3.puts) == 1


@pytest.mark.parametrize("corruption", ["invalid", "producer", "revision", "transcript"])
def test_conflicting_artifact_never_reruns_provider(tmp_path, corruption):
    with harness(tmp_path) as h:
        _, s3, provider, _, api, _ = h
        asyncio.run(execute(h))
        data = json.loads(s3.objects[api.slot])
        if corruption == "invalid":
            data["text"] = "private"
        elif corruption == "producer":
            data["producerStageRunId"] = str(uuid4())
        elif corruption == "revision":
            data["transcriptRevision"] = 5
        else:
            data["transcriptId"] = str(uuid4())
        s3.objects[api.slot] = json.dumps(data).encode()
        api.state = "AVAILABLE"
        _, d = asyncio.run(execute(h))
        assert d.actions == ["ack"] and api.state == "FAILURE_RECORDED"
        assert api.command_bodies[-1]["category"] == "INTEGRITY"
        assert len(provider.calls) == 1


def test_provider_failure_is_sanitized_and_terminal(tmp_path):
    with harness(tmp_path) as h:
        h[2].failure = DiarizationErrorCategory.PROVIDER
        _, d = asyncio.run(execute(h))
        assert d.actions == ["ack"] and not h[1].puts
        assert h[4].command_bodies[-1]["category"] == "PROVIDER"


def test_provider_upload_limit_rejected_before_inference(tmp_path):
    with harness(tmp_path) as h:
        h[4].source_size = 100_000_001
        _, d = asyncio.run(execute(h))
        assert d.actions == ["ack"] and not h[2].calls and not h[1].puts
        assert h[4].command_bodies[-1]["phase"] == "PREPROCESSING"
        assert h[4].command_bodies[-1]["category"] == "VALIDATION"


@pytest.mark.parametrize("kind", ["source-integrity", "stale-snapshot"])
def test_authoritative_input_failure_prevents_inference(tmp_path, kind):
    with harness(tmp_path) as h:
        if kind == "source-integrity":
            h[1].audio = b"x" * len(h[1].audio)
        else:
            h[4].stale = True
        _, d = asyncio.run(execute(h))
        assert not h[2].calls and not h[1].puts
        assert d.actions == ["ack"]


@pytest.mark.parametrize("mutation", ["stage", "source", "transcript", "revision", "slot", "stageCode"])
def test_claim_bindings_are_verified_against_notification_before_snapshot_or_inference(tmp_path, mutation):
    with harness(tmp_path) as h:
        api = h[4]
        original_reply = api.reply

        def reply(data, status=200, code="OK"):
            if data and "claimToken" in data:
                if mutation == "stage":
                    data["executionStageRunId"] = str(uuid4())
                elif mutation == "source":
                    data["source"]["sourceMediaId"] = str(uuid4())
                elif mutation == "transcript":
                    data["transcript"]["transcriptId"] = str(uuid4())
                elif mutation == "revision":
                    data["transcript"]["transcriptRevision"] += 1
                elif mutation == "slot":
                    data["resultSlot"]["objectKey"] = "processing/private/other.json"
                else:
                    data["executionStageCode"] = "TRANSCRIPTION"
            return original_reply(data, status, code)
        api.reply = reply
        _, d = asyncio.run(execute(h))
        assert not d.actions and not h[2].calls and not h[1].puts
        assert not any(op in ("snapshot", "complete", "fail") for op, _ in api.calls)


def test_uncertain_put_and_completion_reconcile_without_rerun(tmp_path):
    with harness(tmp_path) as h:
        h[1].uncertain = h[4].uncertain_complete = h[4].uncertain_claim = True
        _, d = asyncio.run(execute(h))
        assert d.actions == ["ack"] and len(h[2].calls) == len(h[1].puts) == 1
        claims = [body for op, body in h[4].calls if op == "claim"]
        assert len(claims) == 2 and claims[0] == claims[1]
        assert len([body for body in h[4].command_bodies if "resultSha256" in body]) == 1


def test_completion_resend_has_identical_command_identity(tmp_path):
    with harness(tmp_path) as h:
        h[4].uncertain_complete = True
        h[4].accept_uncertain = False
        _, d = asyncio.run(execute(h))
        commands = h[4].command_bodies
        assert d.actions == ["ack"] and len(commands) == 2 and commands[0] == commands[1]
        assert len(h[2].calls) == 1


@pytest.mark.parametrize("state", ["SUPERSEDED", "FAILURE_RECORDED"])
def test_terminal_recovery_acknowledges_without_claim_or_inference(tmp_path, state):
    with harness(tmp_path) as h:
        h[4].state = state
        _, d = asyncio.run(execute(h))
        assert d.actions == ["ack"] and not h[2].calls
        assert not any(op == "claim" for op, _ in h[4].calls)


def test_competing_owner_is_preserved_without_inference_or_failure(tmp_path):
    with harness(tmp_path) as h:
        h[4].busy = True
        worker, d = asyncio.run(execute(h))
        assert worker.stop_intake.is_set() and not d.actions and not h[2].calls
        assert not h[4].command_bodies


def test_diarization_artifacts_use_full_spk06_size_limit(tmp_path):
    with harness(tmp_path) as h:
        asyncio.run(execute(h))
        h[1].objects[h[4].slot] += b" " * 8388608
        h[4].state = "AVAILABLE"
        _, d = asyncio.run(execute(h))
        assert d.actions == ["ack"] and len(h[2].calls) == 1


def test_uncertain_storage_without_readback_remains_recoverable(tmp_path):
    with harness(tmp_path) as h:
        h[1].fail_put = True
        worker, d = asyncio.run(execute(h))
        assert worker.stop_intake.is_set() and not d.actions
        assert not h[4].command_bodies and len(h[2].calls) == 1


def test_create_only_conflict_never_overwrites_or_submits_conflicting_bytes(tmp_path):
    with harness(tmp_path) as h:
        h[1].conflict = b"corrupt existing artifact"
        _, d = asyncio.run(execute(h))
        assert d.actions == ["ack"]
        assert h[1].objects[h[4].slot] == b"corrupt existing artifact"
        assert h[4].command_bodies[-1]["category"] == "INTEGRITY"
        assert not any(op == "complete" for op, _ in h[4].calls)


def test_independent_concurrency_retains_slot_through_active_inference(tmp_path):
    async def run(h):
        settings, _, provider, runner, api, storage = h
        runner.hold = True
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as http:
            worker = DiarizationWorker(settings, DiarizationCoreClient(settings, client=http), storage, runner)
            first, second = Delivery(api.event), Delivery(api.event)
            one = asyncio.create_task(worker.handle(first))
            while not runner.entered.is_set():
                await asyncio.sleep(0.005)
            two = asyncio.create_task(worker.handle(second))
            await asyncio.sleep(0.025)
            assert not two.done() and len([op for op, _ in api.calls if op == "claim"]) == 1
            runner.hold = False
            await asyncio.gather(one, two)
            await worker.aclose()
            assert first.actions == second.actions == ["ack"] and len(provider.calls) == 1
    with harness(tmp_path) as h:
        asyncio.run(run(h))


def test_verified_only_stops_intake_without_ack_nack_or_failure(tmp_path):
    with harness(tmp_path) as h:
        h[4].verify_only = True
        worker, d = asyncio.run(execute(h))
        assert not d.actions and worker.stop_intake.is_set()
        assert h[4].state == "RESULT_VERIFIED" and len(h[1].objects) == 1
        assert not any(op == "fail" for op, _ in h[4].calls)
        _, recovered = asyncio.run(execute(h))
        assert not recovered.actions and len(h[2].calls) == 1


def test_http_200_without_durable_receipt_never_acknowledges(tmp_path):
    with harness(tmp_path) as h:
        h[4].invalid_receipt = True
        worker, d = asyncio.run(execute(h))
        assert not d.actions and worker.stop_intake.is_set()


@pytest.mark.parametrize("kind", ["deadline", "lease", "shutdown"])
def test_blocking_execution_is_fenced_from_storage_and_success(tmp_path, kind):
    async def run(h):
        settings, s3, _, runner, api, storage = h
        runner.hold = True
        api.renew_after = 1
        api.renew_failure = kind == "lease"
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as http:
            core = DiarizationCoreClient(settings, client=http)
            worker = DiarizationWorker(settings, core, storage, runner)
            d = Delivery(api.event)
            task = asyncio.create_task(worker.handle(d))
            while not runner.entered.is_set():
                await asyncio.sleep(0.005)
            if kind == "shutdown":
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await worker.aclose()
            assert not d.actions and not s3.puts
            assert not any(op in ("complete", "fail") for op, _ in api.calls)
            if kind == "lease":
                assert any(op == "renew" for op, _ in api.calls)
    with harness(tmp_path, diarization_worker_execution_timeout_seconds=0.2 if kind == "deadline" else 5) as h:
        asyncio.run(run(h))


@pytest.mark.parametrize("forced", [False, True])
def test_runtime_graceful_and_forced_shutdown_preserve_delivery(tmp_path, forced):
    from sme_meeting_ai.workers.runtime import WorkerRuntime

    async def run(h):
        settings, _, _, runner, api, storage = h
        runner.hold = True
        delivery = Delivery(api.event)

        class Broker:
            def __init__(self):
                self.failure = asyncio.Event()
                self.closed_event = asyncio.Event()
                self.connection = self
                self.stopped = False

            async def start(self, handler):
                self.task = asyncio.create_task(handler(delivery))

            async def closed(self):
                await self.closed_event.wait()

            async def stop(self):
                self.stopped = True

            async def drain(self):
                await asyncio.shield(self.task)

            async def __aexit__(self, *a):
                if not self.task.done():
                    self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
                self.closed_event.set()

        # connection.closed() follows aio-pika's existing lifecycle seam.
        broker = Broker()
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as http:
            worker = DiarizationWorker(settings, DiarizationCoreClient(settings, client=http), storage, runner)
            runtime = WorkerRuntime(settings, lambda stop: worker.run(broker, stop))
            task = asyncio.create_task(runtime.run())
            while not runner.entered.is_set():
                await asyncio.sleep(0.005)
            runtime.request_shutdown()
            if not forced:
                runner.hold = False
            result = await task
            await worker.aclose()
            assert broker.stopped and broker.closed_event.is_set()
            assert result == int(forced)
            assert delivery.actions == ([] if forced else ["ack"])
    with harness(tmp_path, worker_shutdown_timeout_seconds=0.3) as h:
        asyncio.run(run(h))
