import asyncio
import json
import multiprocessing
import threading
import time

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.diarization.models import (
    DiarizationResult,
    SpeakerTurn,
    TimedTranscriptSegment,
)
from sme_meeting_ai.diarization.service import DiarizationRequest, DiarizationService
from sme_meeting_ai.workers.diarization import (
    DiarizationExecution,
    IsolatedService,
    WorkFailure,
)
from sme_meeting_ai.workers.execution import AiWorkerExecution


def settings(**overrides):
    return Settings(service_name="test", service_identity="ai-worker", _env_file=None, **overrides)


class SlowProvider:
    def diarize(self, path, **hints):
        time.sleep(30)
        return DiarizationResult((SpeakerTurn(0, 100, "SPEAKER_01"),), ("SPEAKER_01",), "test/model")


class FastProvider:
    def diarize(self, path, **hints):
        return DiarizationResult((SpeakerTurn(0, 100, "SPEAKER_01"),), ("SPEAKER_01",), "test/model")


@pytest.mark.parametrize("provider,stop", [(FastProvider, "success"), (SlowProvider, "deadline"), (SlowProvider, "cancel")])
def test_service_child_is_joined_on_success_deadline_and_cancellation(tmp_path, provider, stop):
    path = tmp_path / "synthetic.wav"
    path.write_bytes(b"synthetic")
    request = DiarizationRequest(path, 1000, (TimedTranscriptSegment(7, 0, 100),))
    runner = IsolatedService(DiarizationService(provider()))
    fence = threading.Event()
    before = {p.pid for p in multiprocessing.active_children()}
    timer = threading.Timer(0.2, fence.set) if stop == "cancel" else None
    if timer:
        timer.start()
    try:
        if stop == "success":
            assert runner.run(request, fence, time.monotonic() + 10).diagnostic_status == "completed"
        else:
            with pytest.raises(WorkFailure):
                runner.run(request, fence, time.monotonic() + (0.2 if stop == "deadline" else 10))
        assert {p.pid for p in multiprocessing.active_children()} == before
    finally:
        runner.close()
        if timer:
            timer.join()


def test_disabled_execution_initializes_nothing_and_camel_enablement_alias():
    async def run():
        execution = DiarizationExecution(settings())
        async with execution:
            assert execution.worker is execution.broker is None
        assert not settings().diarization_worker_enabled
        assert settings(diarizationWorkerEnabled=True).diarization_worker_enabled
        assert settings().diarization_worker_concurrency == 1
    asyncio.run(run())


def test_spawned_service_configures_structured_logging(monkeypatch):
    from sme_meeting_ai.workers import diarization as module

    observed = []
    monkeypatch.setattr(module, "configure_logging", lambda config: observed.append(config))

    class Sender:
        def send(self, result):
            observed.append(result)

        def close(self):
            observed.append("closed")

    class Service:
        def run(self, request):
            return "completed"

    config = settings()
    module._service_child(Sender(), Service(), None, config)
    assert observed == [config, "completed", "closed"]


@pytest.mark.parametrize("options", [
    {}, {"diarization_worker_provider_approved": True},
    {"diarization_worker_provider_approved": True, "environment": "production"},
])
def test_enabled_execution_fails_closed_without_approved_complete_resources(options):
    async def run():
        with pytest.raises(RuntimeError, match="worker.diarization.startup.failed"):
            async with DiarizationExecution(settings(diarization_worker_enabled=True, **options)):
                pytest.fail("unapproved/missing credentials started consumer")
    asyncio.run(run())


def test_enabled_composition_owns_dedicated_queue_storage_and_existing_service(monkeypatch):
    from sme_meeting_ai.workers import diarization as module
    acquired = []
    closed = []

    class Core:
        def __init__(self, config):
            acquired.append(("core", config.worker_concurrency))

        async def aclose(self):
            closed.append("core")

    class Storage:
        def __init__(self, config, **kw):
            assert config.s3_access_key_id.get_secret_value() == "diarization-only"
            assert kw == dict(result_max_bytes=16777216, namespace="sme-diarization-worker")
            acquired.append(("storage", config.worker_concurrency))

        def __enter__(self):
            return self

        def __exit__(self, *a):
            closed.append("storage")

    class Broker:
        def __init__(self, config, **kw):
            assert kw == dict(queue_name="meeting.processing.diarization", prefetch=2)
            acquired.append(("broker", config.worker_concurrency))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            closed.append("broker")

    monkeypatch.setattr(module, "DiarizationCoreClient", Core)
    monkeypatch.setattr(module, "ObjectStorage", Storage)
    monkeypatch.setattr(module, "RabbitConsumer", Broker)

    async def run():
        config = settings(diarization_worker_enabled=True, diarization_worker_provider_approved=True,
                          diarization_worker_concurrency=2, worker_concurrency=3,
                          diarization_worker_s3_access_key_id="diarization-only",
                          diarization_worker_s3_secret_access_key="diarization-secret", REPLICATE_API_TOKEN="approved-token")
        async with DiarizationExecution(config) as execution:
            assert isinstance(execution.worker.runner.service, DiarizationService)
            assert execution.worker._executor._max_workers == 2
        assert acquired == [("core", 2), ("storage", 2), ("broker", 3)]
        assert closed == ["broker", "core", "storage"]
    asyncio.run(run())


def test_enablement_environment_defaults_and_explicit_override(monkeypatch):
    monkeypatch.setenv("AI_DIARIZATION_WORKER_ENABLED", "true")
    assert settings().diarization_worker_enabled
    assert not settings(diarization_worker_enabled=False).diarization_worker_enabled


def test_two_capabilities_start_and_shutdown_independently(monkeypatch):
    from sme_meeting_ai.workers import execution as module
    events = []

    class Capability:
        def __init__(self, config):
            self.name = "transcription" if not events else "diarization"
            events.append(("create", self.name))

        async def __aenter__(self):
            events.append(("open", self.name))
            return self

        async def __call__(self, stop):
            events.append(("run", self.name))
            await stop.wait()

        async def __aexit__(self, *a):
            events.append(("close", self.name))

    monkeypatch.setattr(module, "TranscriptionExecution", Capability)
    monkeypatch.setattr(module, "DiarizationExecution", Capability)

    async def run():
        stop = asyncio.Event()
        async with AiWorkerExecution(settings(diarization_worker_enabled=True)) as execution:
            task = asyncio.create_task(execution(stop))
            while len([e for e in events if e[0] == "run"]) < 2:
                await asyncio.sleep(0)
            stop.set()
            await task
        assert events[-2:] == [("close", "diarization"), ("close", "transcription")]
    asyncio.run(run())


def test_diarization_duration_logging_is_sanitized():
    import logging

    from sme_meeting_ai.observability.logging import JsonFormatter, log_event
    records = []
    logger = logging.getLogger("test.diarization")
    logger.setLevel(logging.INFO)
    handler = logging.Handler()
    handler.emit = lambda r: records.append(json.loads(JsonFormatter("test").format(r)))
    logger.addHandler(handler)
    try:
        log_event(logger, logging.INFO, "worker.diarization.finished", duration_ms=12)
        assert records[0]["duration_ms"] == 12
        assert "claimToken" not in records[0]
    finally:
        logger.removeHandler(handler)
