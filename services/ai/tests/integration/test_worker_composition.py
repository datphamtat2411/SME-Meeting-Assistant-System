"""Production entrypoint/composition with fake SDK boundaries, never live services."""

import asyncio
import json
import os
import signal
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
from integration.test_transcription_worker_integration import Delivery, FakeCore
from tls_support import create_test_pki
from unit.test_worker_integrations import S3, event_body

from sme_meeting_ai.audio.vad import SileroVadBackend
from sme_meeting_ai.core.config import Environment, Settings
from sme_meeting_ai.integrations import core_api, messaging, object_storage
from sme_meeting_ai.observability.logging import configure_logging
from sme_meeting_ai.pipeline import OfflineTranscriptionPipeline
from sme_meeting_ai.providers.openrouter_instruction_llm import (
    OpenRouterInstructionLlmAdapter,
)
from sme_meeting_ai.workers import __main__ as entrypoint
from sme_meeting_ai.workers.transcription import TranscriptionExecution

SECRET = "test-only-worker-secret"


@pytest.fixture(scope="module")
def pki(tmp_path_factory):
    return create_test_pki(tmp_path_factory.mktemp("worker-pki"))


@pytest.fixture
def composition(tmp_path, monkeypatch, pki):
    monkeypatch.setattr(os, "environ", {})
    config = Settings(service_name="worker-test", service_identity="ai-core", environment="test", _env_file=None,
        OPENROUTER_API_KEY=SECRET, transcript_correction_model="test/corrector",
        core_api_base_url="https://localhost", core_api_server_ca_file=pki / "ca.crt",
        core_api_client_cert_file=pki / "ai-worker.crt", core_api_client_key_file=pki / "ai-worker.key",
        s3_endpoint_url="https://storage.internal", s3_bucket="media", s3_access_key_id=SECRET,
        s3_secret_access_key=SECRET, audio_temp_dir=tmp_path,
        rabbitmq_url="amqps://broker.internal", rabbitmq_username=SECRET,
        rabbitmq_password=SECRET, rabbitmq_ca_file=pki / "ca.crt", worker_shutdown_timeout_seconds=0.1)
    h = SimpleNamespace(settings=config, acquired=[], closed=[], consumed=False, stop=False,
                        fail=None, cancel=False, signal=True)
    real_core = core_api.CoreApiClient

    class Core(real_core):
        def __init__(self, settings):
            super().__init__(settings)
            h.acquired.append("core")

        async def aclose(self):
            await super().aclose()
            h.closed.append("core")

    class StorageClient(S3):
        def __init__(self):
            super().__init__()

        def close(self):
            h.closed.append("storage")

    class Backend:
        def close(self):
            h.closed.append("vad")

    def storage_client(*args, **kwargs):
        h.acquired.append("storage")
        h.s3 = StorageClient()
        return h.s3

    real_vad = SileroVadBackend.from_settings

    def vad(settings):
        if h.fail == "vad":
            return real_vad(settings)  # Missing model fails without any download.
        h.acquired.append("vad")
        return Backend()

    class Queue:
        async def consume(self, callback, *, no_ack):
            assert not no_ack
            h.consumed = True
            if getattr(h, "delivery", None):
                await callback(h.delivery)
            if h.signal:
                asyncio.get_running_loop().call_soon(os.kill, os.getpid(), signal.SIGTERM)
            return "consumer"

        async def cancel(self, tag):
            h.stop = True

    class Connection:
        async def channel(self):
            h.acquired.append("broker")
            if h.fail == "channel":
                raise RuntimeError(SECRET)
            if h.fail == "channel-timeout":
                await asyncio.Event().wait()
            if h.cancel:
                raise asyncio.CancelledError
            return self

        async def set_qos(self, *, prefetch_count):
            assert prefetch_count == config.worker_concurrency

        async def get_queue(self, name, *, ensure):
            return Queue()

        async def close(self):
            h.closed.append("broker")
            self.done.set_result(None)

        def closed(self):
            return self.done

        is_closed = False

    async def connect(*args, **kwargs):
        h.sdk_url = messaging.aio_pika.connection.make_url(
            *args, **{k: v for k, v in kwargs.items() if k not in ("ssl_context", "timeout")},
        )
        if h.fail == "broker":
            raise RuntimeError(SECRET)
        connection = Connection()
        connection.done = asyncio.get_running_loop().create_future()
        return connection

    real_http = httpx.AsyncClient

    def http_client(*args, **kwargs):
        if getattr(h, "transport", None):
            kwargs["transport"] = h.transport
        return real_http(*args, **kwargs)

    monkeypatch.setattr(core_api, "CoreApiClient", Core)
    monkeypatch.setattr(core_api.httpx, "AsyncClient", http_client)
    monkeypatch.setattr(object_storage.boto3, "client", storage_client)
    monkeypatch.setattr(SileroVadBackend, "from_settings", vad)
    monkeypatch.setattr(messaging.aio_pika, "connect", connect)
    monkeypatch.setattr(entrypoint, "load_settings", lambda: h.settings)
    yield h
    # configure_logging owns a stdout handler; do not retain pytest's closed capture.
    import logging
    logger = logging.getLogger("sme_meeting_ai")
    for handler in logger.handlers[:]:
        if getattr(handler, "_sme_meeting_ai_json_handler", False):
            logger.removeHandler(handler)
            handler.close()
    logger.propagate = True


def events(capsys):
    logs = capsys.readouterr()
    assert SECRET not in logs.out + logs.err
    assert "Traceback" not in logs.out + logs.err
    return [json.loads(line)["event"] for line in logs.out.splitlines()]


def test_actual_main_constructs_consumes_and_sigterm_closes(composition, capsys, monkeypatch):
    h = composition
    original = TranscriptionExecution.__call__

    async def inspect(self, stop):
        assert isinstance(self.worker.pipeline, OfflineTranscriptionPipeline)
        assert self.worker.pipeline._correction_mode == "v5_full"
        assert type(self.worker.pipeline._correction_provider) is OpenRouterInstructionLlmAdapter
        assert not h.consumed
        await original(self, stop)

    monkeypatch.setattr(TranscriptionExecution, "__call__", inspect)
    assert entrypoint.main() == 0
    assert h.consumed and h.stop
    assert h.acquired == ["core", "storage", "vad", "broker"]
    assert sorted(h.closed) == ["broker", "core", "storage", "vad"]
    observed = events(capsys)
    assert observed.index("worker.started") < observed.index("worker.transcription.consuming")
    assert observed[-1] == "worker.stopped"


@pytest.mark.parametrize("phase", ["credentials", "correction", "tls", "storage", "storage-tls", "vad", "broker", "channel", "channel-timeout"])
def test_startup_rejection_is_specific_sanitized_and_unwinds(composition, capsys, phase):
    h = composition
    updates = {"credentials": {"openrouter_api_key": None},
               "correction": {"transcript_correction_model": None},
               "tls": {"core_api_server_ca_file": h.settings.audio_temp_dir / "missing-ca"},
               "storage": {"s3_bucket": None},
               "storage-tls": {"s3_ca_file": h.settings.audio_temp_dir / "missing-storage-ca"},
               "channel-timeout": {"rabbitmq_connect_timeout_seconds": 0.02}}
    h.settings = h.settings.model_copy(update=updates.get(phase, {}))
    h.fail = phase
    assert entrypoint.main() == 1
    assert not h.consumed
    assert sorted(h.closed) == sorted(h.acquired)
    observed = events(capsys)
    expected = {"credentials": "provider", "correction": "provider", "tls": "core",
                "channel": "broker", "channel-timeout": "broker", "storage-tls": "storage"}.get(phase, phase)
    assert f"worker.transcription.startup.{expected}.failed" in observed
    assert "worker.started" not in observed and "worker.transcription.consuming" not in observed
    assert observed[-1] == "worker.failed"


def test_cancelled_partial_broker_startup_releases_every_resource(composition):
    h = composition
    h.cancel = True

    async def run():
        configure_logging(h.settings)
        with pytest.raises(asyncio.CancelledError):
            await TranscriptionExecution(h.settings).__aenter__()
    asyncio.run(run())
    assert sorted(h.closed) == sorted(h.acquired)
    assert not h.consumed


def test_real_sigterm_deadline_fences_active_sync_reader_and_defers_cleanup(composition, monkeypatch):
    h = composition
    h.signal = False
    body = event_body()
    h.delivery = Delivery(body)
    # FakeCore and the SDK fake share object state after the composition creates it.
    async def transport(request):
        return await fake_core(request)
    h.transport = httpx.MockTransport(transport)
    fake_core = FakeCore(body, S3())
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    paths = []

    def inference(self, source):
        paths.append(source.path)
        entered.set()
        os.kill(os.getpid(), signal.SIGTERM)
        try:
            assert release.wait(5)
            assert source.path.exists()
            raise RuntimeError("test-only late inference failure")
        finally:
            finished.set()
    monkeypatch.setattr(OfflineTranscriptionPipeline, "run", inference)
    try:
        start = time.monotonic()
        assert entrypoint.main() == 1  # deadline interruption is not clean success
        assert time.monotonic() - start < 1
        assert entered.is_set() and paths[0].exists()
        assert h.stop and "broker" in h.closed and "core" in h.closed
        assert "vad" not in h.closed and "storage" not in h.closed
        assert not h.delivery.actions and not fake_core.transcripts and not fake_core.failures
        assert fake_core.state == "RUNNING" and fake_core.receipt is None
    finally:
        release.set()
        assert finished.wait(5)
        deadline = time.monotonic() + 3
        while "storage" not in h.closed and time.monotonic() < deadline:
            time.sleep(0.001)
    assert not paths[0].exists() and not h.s3.objects
    assert sorted(h.closed) == ["broker", "core", "storage", "vad"]


def test_broker_connection_closes_even_when_stop_fails(composition, monkeypatch):
    h = composition

    async def run():
        execution = await TranscriptionExecution(h.settings).__aenter__()

        async def broken_stop():
            raise RuntimeError(SECRET)
        monkeypatch.setattr(execution.broker, "stop", broken_stop)
        with pytest.raises(RuntimeError):
            await execution.__aexit__(None, None, None)
        await execution.__aexit__(None, None, None)  # idempotent ownership release
    asyncio.run(run())
    assert sorted(h.closed) == sorted(h.acquired)


def test_explicit_pipeline_factory_skips_production_provider_bootstrap(composition):
    h = composition
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": "v62_edits", "openrouter_api_key": None})
    calls = []

    def factory(settings, resources):
        calls.append((settings, resources))
        return SimpleNamespace(run=lambda source: None)

    async def run():
        execution = TranscriptionExecution(h.settings, pipeline_factory=factory)
        await execution.__aenter__()
        assert len(calls) == 1
        assert h.acquired == ["core", "storage", "broker"]
        await execution.__aexit__(None, None, None)

    asyncio.run(run())
    assert sorted(h.closed) == ["broker", "core", "storage"]


def test_unvalidated_mode_fails_before_any_resources(composition):
    h = composition
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": "invalid"})

    async def run():
        with pytest.raises(RuntimeError, match="startup.failed"):
            await TranscriptionExecution(h.settings).__aenter__()
    asyncio.run(run())
    assert not h.acquired and not h.consumed


def test_mismatched_adapter_fails_and_closes_resources(composition, monkeypatch):
    from sme_meeting_ai.providers import openrouter_instruction_llm_v62
    h = composition
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": "v62_edits"})
    monkeypatch.setattr(openrouter_instruction_llm_v62, "OpenRouterInstructionLlmV62Adapter", OpenRouterInstructionLlmAdapter)

    async def run():
        with pytest.raises(RuntimeError, match="startup.failed"):
            await TranscriptionExecution(h.settings).__aenter__()
    asyncio.run(run())
    assert sorted(h.closed) == sorted(h.acquired)
    assert not h.consumed


@pytest.mark.parametrize("environment", [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION])
def test_explicit_pipeline_factory_is_test_environment_only(composition, environment):
    settings = composition.settings.model_copy(update={"environment": environment})

    with pytest.raises(ValueError, match="requires test environment"):
        TranscriptionExecution(settings, pipeline_factory=lambda *_: None)


@pytest.mark.parametrize("suffix,port,vhost", [("", 5671, "/"), ("/", 5671, "/"),
    ("/%2F", 5671, "/"), (":5672/team%2Fone", 5672, "team/one")])
def test_broker_sdk_receives_external_credentials(composition, suffix, port, vhost):
    h = composition
    h.settings = h.settings.model_copy(update={"rabbitmq_url": f"amqps://broker.internal{suffix}"})

    async def run():
        async with TranscriptionExecution(h.settings):
            # aio-pika ignores login/password keyword arguments when a URL is
            # supplied. Check its actual URL construction, not just call kwargs.
            assert h.sdk_url.user == SECRET and h.sdk_url.password == SECRET
            assert h.sdk_url.scheme == "amqps" and h.sdk_url.host == "broker.internal"
            assert h.sdk_url.port == port and h.sdk_url.path == "/" + vhost
    asyncio.run(run())
