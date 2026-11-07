"""Bootstrap regressions for the disposable SPK-11 process, without live services."""

import asyncio
import errno
import json
import logging
import os
import stat
import subprocess
import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from integration import spk11_worker_process as smoke

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.integrations.diarization import DiarizationCoreClient
from sme_meeting_ai.integrations.object_storage import ObjectStorage, StorageError


@pytest.fixture(autouse=True)
def restore_logging():
    previous = logging.root.manager.disable
    yield
    logging.disable(previous)


def configuration(root):
    return dict(settings=dict(service_name="spk11", service_identity="ai-worker", environment="test",
        REPLICATE_API_TOKEN="spk11-synthetic-only", audio_temp_dir=str(root),
        s3_endpoint_url="https://localhost:9000", s3_bucket="spk11-media",
        s3_access_key_id="spk11-test", s3_secret_access_key="spk11-synthetic-only-password"))


def test_missing_audio_parent_reproduces_storage_resource_failure(tmp_path, monkeypatch):
    root = tmp_path / "audio"
    settings = Settings(**configuration(root)["settings"], _env_file=None)
    mkdir = Path.mkdir
    failures = []

    def observed_mkdir(path, *args, **kwargs):
        try:
            return mkdir(path, *args, **kwargs)
        except OSError as error:
            failures.append(error.errno)
            raise

    monkeypatch.setattr(Path, "mkdir", observed_mkdir)
    with pytest.raises(StorageError) as caught:
        with ObjectStorage(settings, client=object(), namespace="sme-diarization-worker"):
            pytest.fail("The absent audio parent unexpectedly initialized")
    assert caught.value.category == "RESOURCE"
    assert failures == [errno.ENOENT]
    assert not root.exists(), "Production storage must not create arbitrary parents"

    root.mkdir(mode=0o700)
    with ObjectStorage(settings, client=object(), namespace="sme-diarization-worker") as storage:
        for path in (root, root / "sme-diarization-worker", storage._root):
            info = path.lstat()
            assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            assert stat.S_IMODE(info.st_mode) == 0o700
        private_run = storage._root
    assert not private_run.exists()


def test_synthetic_provider_token_constructor_aliases_override_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("REPLICATE_API_TOKEN", "other-synthetic-token")
    values = configuration(tmp_path)["settings"]
    token = values.pop("REPLICATE_API_TOKEN")
    lowercase = Settings(**values, replicate_api_token=token, _env_file=None)
    assert lowercase.replicate_api_token.get_secret_value() == token
    explicit = Settings(**values, REPLICATE_API_TOKEN=token, _env_file=None)
    assert explicit.replicate_api_token.get_secret_value() == token
    assert explicit.audio_temp_dir == tmp_path


@pytest.mark.parametrize("phase", [
    "CONFIGURATION", "PROVIDER_SETUP", "TEMP_STORAGE", "CORE_MTLS",
    "RABBITMQ", "WORKER_STARTUP", "RUNTIME",
])
def test_failure_phase_is_fixed_and_never_contains_exception_text(tmp_path, monkeypatch, phase):
    secret = "SECRET transcript claimToken provider-response /private/key"

    def stage(name, value):
        def construct(*args, **kwargs):
            if phase == name:
                raise RuntimeError(secret)
            return value
        return construct

    cores = []

    class Core:
        lookup = DiarizationCoreClient.lookup

        def __init__(self, *args):
            stage("CORE_MTLS", None)()
            cores.append(self)

        async def request(self, event, operation, body=None, **kwargs):
            raise RuntimeError(secret)

        async def aclose(self):
            pass

    class Storage:
        def __init__(self, *args, **kwargs):
            stage("TEMP_STORAGE", None)()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    async def handle(message):
        # Exercise the production lookup -> overridden request call shape.
        await cores[0].lookup(SimpleNamespace(eventId="synthetic"))

    worker = SimpleNamespace(aclose=AsyncMock(), handle=handle)
    broker = SimpleNamespace(stop=AsyncMock(), drain=AsyncMock())

    async def start(handler):
        asyncio.create_task(handler(object()))

    broker.start = AsyncMock(side_effect=RuntimeError(secret)) if phase == "WORKER_STARTUP" else start
    monkeypatch.setattr(smoke, "Settings", stage("CONFIGURATION", object()))
    monkeypatch.setattr(smoke, "controlled_adapter", stage("PROVIDER_SETUP", nullcontext(object())))
    monkeypatch.setattr(smoke, "ObjectStorage", Storage)
    monkeypatch.setattr(smoke, "DiarizationCoreClient", Core)
    monkeypatch.setattr(smoke, "RabbitConsumer", stage("RABBITMQ", nullcontext(broker)))
    monkeypatch.setattr(smoke, "DiarizationWorker", lambda *args: worker)
    diagnostic = smoke.Diagnostics()
    with pytest.raises(RuntimeError) as caught:
        asyncio.run(smoke.run(configuration(tmp_path), diagnostic))
    assert diagnostic.failure(caught.value) == dict(
        failure="SPK11_WORKER_PROCESS_FAILED", phase=phase, category="UNEXPECTED")
    assert secret not in json.dumps(diagnostic.failure(caught.value))


@pytest.mark.parametrize(("error", "category"), [
    (StorageError("CONFIGURATION"), "CONFIGURATION"),
    (StorageError("SECRET"), "UNEXPECTED"),
    (FileNotFoundError("SECRET path"), "FILESYSTEM"),
    (TimeoutError("SECRET response"), "TIMEOUT"),
    (KeyboardInterrupt("SECRET"), "INTERRUPTED"),
])
def test_failure_category_is_allowlisted(error, category):
    diagnostic = smoke.Diagnostics()
    diagnostic.phase = "SECRET"
    assert diagnostic.failure(error) == dict(
        failure="SPK11_WORKER_PROCESS_FAILED", phase="CONFIGURATION", category=category)


@pytest.mark.parametrize("payload,phase,category", [
    ("not-json", "CONFIGURATION", "VALIDATION"),
    ("missing-audio", "TEMP_STORAGE", "RESOURCE"),
])
def test_real_subprocess_emits_only_a_safe_failure_envelope(tmp_path, payload, phase, category):
    if payload == "missing-audio":
        payload = json.dumps(configuration(tmp_path / "audio"))
    ai = Path(__file__).resolve().parents[2]
    result = subprocess.run([sys.executable, "-m", "integration.spk11_worker_process"],
        input=payload + "\n", capture_output=True, text=True, timeout=15, cwd=ai,
        env=dict(PATH=os.defpath, LANG="C.UTF-8", PYTHONPATH=f"{ai / 'tests'}:{ai / 'src'}"))
    assert result.returncode == 1
    assert result.stderr == ""
    assert json.loads(result.stdout) == dict(
        failure="SPK11_WORKER_PROCESS_FAILED", phase=phase, category=category)
