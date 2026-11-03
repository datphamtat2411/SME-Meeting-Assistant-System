"""Opt-in cross-service acceptance through Core-owned business admission.

The test uses real Core HTTP admission, outbox publication, RabbitMQ, mTLS
Worker V1 calls, HTTPS storage, preprocessing, and transcript persistence. VAD,
ASR and correction are controlled test boundaries, not live inference.
"""

import asyncio
import io
import json
import math
import os
import struct
import sys
import wave
from contextlib import ExitStack, contextmanager
from decimal import Decimal
from fractions import Fraction
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from sme_meeting_ai.audio import (
    AudioEvidenceDetector,
    AudioNormalizer,
    AudioSource,
    SpeechMapBuilder,
)
from sme_meeting_ai.core.config import Settings, load_settings
from sme_meeting_ai.pipeline import (
    AudioPreprocessingPipeline,
    OfflineTranscriptionPipeline,
)
from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
from sme_meeting_ai.transcription.chunk_planning import SpeechAwareAsrChunkPlanner
from sme_meeting_ai.transcription.correction import CorrectionProviderResponse
from sme_meeting_ai.workers.__main__ import run_worker
from sme_meeting_ai.workers.transcription import TranscriptionExecution

pytestmark = pytest.mark.live_infrastructure


class ControlledVadBackend:
    """Deterministic VAD boundary; preprocessing remains the real pipeline."""

    model_id = "e2e04-controlled-vad"
    model_version = "1"
    model_sha256 = "b" * 64
    backend = "e2e04-controlled"
    frame_samples = 512
    max_concurrent_recordings = 1
    inference_threads = 1

    @contextmanager
    def open_stream(self, *, deadline):
        yield SimpleNamespace(infer=lambda _samples: 0.95)

    def close(self):
        return None


class ControlledAsr:
    """Synthetic provider response normalized by the production adapter; no network call."""

    def __init__(self, settings, resources):
        self.client = resources.enter_context(httpx.Client(transport=httpx.MockTransport(
            lambda _: pytest.fail("controlled ASR must not use the network"))))
        self.adapter = OpenRouterWhisperAdapter(settings, client=self.client)

    def transcribe(self, audio):
        text = "Cuộc họp thống nhất kế hoạch triển khai"
        duration = Decimal(audio.duration.numerator) / Decimal(audio.duration.denominator)
        return self.adapter._normalize({"text": text, "language": "vi", "confidence": 1,
                                        "segments": [{"start": 0, "end": duration, "text": text}]}, audio)


class ControlledCorrection:
    def complete(self, request):
        transcript = json.loads(request.transcript_json)
        segments = [
            {"segment_id": item["segment_id"], "ordinal": item["ordinal"],
             "text": item["text"] + "."}
            for item in transcript["segments"]
        ]
        return CorrectionProviderResponse(
            json.dumps({"segments": segments}, separators=(",", ":")),
            "e2e04-controlled", request.model, "e2e04/correction",
        )


def controlled_pipeline(settings, resources):
    settings = settings.model_copy(update={"transcript_correction_model": "e2e04/correction"})
    vad = ControlledVadBackend()
    resources.callback(vad.close)
    return OfflineTranscriptionPipeline(
        AudioPreprocessingPipeline(
            AudioNormalizer(settings),
            AudioEvidenceDetector(settings, vad),
            SpeechMapBuilder(settings),
        ),
        SpeechAwareAsrChunkPlanner(settings),
        ControlledAsr(settings, resources),
        ControlledCorrection(),
        settings,
        pipeline_version="e2e04-controlled-1",
        asr_adapter_version="e2e04-controlled-openrouter-normalizer-v1",
    )


class ControlledExecution:
    """Expose runtime shutdown while retaining the production execution object."""

    def __init__(self, execution):
        self.execution = execution
        self.shutdown_event = None

    async def __aenter__(self):
        await self.execution.__aenter__()
        return self

    async def __aexit__(self, *args):
        return await self.execution.__aexit__(*args)

    async def __call__(self, shutdown_requested):
        self.shutdown_event = shutdown_requested
        await self.execution(shutdown_requested)

    def request_shutdown(self):
        if self.shutdown_event is not None:
            self.shutdown_event.set()


class CoreAdmission:
    def __init__(self, settings, *, public_url=None, email=None, password=None, verify=None):
        ca_file = settings.s3_ca_file
        verify = verify if verify is not None else (str(ca_file) if ca_file is not None else True)
        self.client = httpx.AsyncClient(
            base_url=(public_url or os.environ.get("E2E04_CORE_PUBLIC_URL", "http://127.0.0.1:8080")).rstrip("/"),
            verify=verify,
            trust_env=False,
            follow_redirects=False,
            timeout=20,
        )
        self.email = email or os.environ["E2E04_CORE_EMAIL"]
        self.password = password or os.environ["E2E04_CORE_PASSWORD"]
        self.headers = {"X-Auth-Transport": "mobile"}

    async def close(self):
        await self.client.aclose()

    async def request(self, method, path, **kwargs):
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", {}))
        response = await self.client.request(method, path, headers=headers, **kwargs)
        if not response.is_success:
            raise AssertionError(f"Core public request failed: {method} {path} ({response.status_code})")
        try:
            payload = response.json()
        except (ValueError, TypeError) as error:
            raise AssertionError(f"Core public response was not JSON: {method} {path}") from error
        if payload.get("success") is not True or not isinstance(payload.get("data"), dict):
            raise AssertionError(f"Core public response was not successful: {method} {path}")
        return payload["data"]

    async def admit(self, audio):
        login = await self.client.post(
            "/api/v1/auth/login",
            headers={"X-Auth-Transport": "mobile"},
            json={"email": self.email, "password": self.password},
        )
        if not login.is_success:
            raise AssertionError(f"Core login failed ({login.status_code})")
        try:
            access = login.json()["data"]["accessToken"]
        except (KeyError, TypeError, ValueError) as error:
            raise AssertionError("Core login did not return a mobile access token") from error
        self.headers = {"X-Auth-Transport": "mobile", "Authorization": f"Bearer {access}"}

        meeting = await self.request(
            "POST", "/api/v1/meetings", headers={**self.headers, "Idempotency-Key": str(uuid4())},
            json={"title": "E2E-04 controlled worker fixture"},
        )
        meeting_id = meeting["id"]
        media = await self.request(
            "POST", f"/api/v1/meetings/{meeting_id}/media/uploads",
            headers={**self.headers, "Idempotency-Key": str(uuid4())},
            json={"sourceType": "UPLOAD", "originalFilename": "e2e04.wav",
                  "contentType": "audio/wav", "expectedSizeBytes": len(audio)},
        )
        upload = await self.client.put(
            media["uploadUrl"], content=audio,
            headers={"Content-Type": "audio/wav", "Content-Length": str(len(audio))},
        )
        if not upload.is_success:
            raise AssertionError(f"Presigned media upload failed ({upload.status_code})")
        finalized = await self.request(
            "POST", f"/api/v1/meetings/{meeting_id}/media/{media['mediaId']}/finalize",
        )
        if finalized.get("status") != "AVAILABLE":
            raise AssertionError("Core did not accept the synthetic media")
        job = await self.request(
            "POST", f"/api/v1/meetings/{meeting_id}/processing-jobs",
            headers={**self.headers, "Idempotency-Key": str(uuid4())},
            json={"mediaId": media["mediaId"]},
        )
        return meeting_id, media["mediaId"], job["id"]

    async def wait_for_acceptance(self, meeting_id, job_id, worker_task=None, worker_alive=None):
        deadline = asyncio.get_running_loop().time() + float(os.environ.get("E2E04_TIMEOUT_SECONDS", "180"))
        while asyncio.get_running_loop().time() < deadline:
            if worker_task is not None and worker_task.done():
                raise AssertionError("Worker stopped before Core reported a terminal job")
            if worker_alive is not None and not worker_alive():
                raise AssertionError("Worker process stopped before Core reported a terminal job")
            job = await self.request("GET", f"/api/v1/processing-jobs/{job_id}")
            if job.get("status") in ("FAILED", "COMPLETED", "COMPLETED_WITH_WARNINGS"):
                if job["status"] == "FAILED":
                    raise AssertionError(f"Core processing job failed: {job.get('errorCode')}")
                transcript = await self.request("GET", f"/api/v1/meetings/{meeting_id}/transcript")
                segments = transcript.get("segments") or []
                assert transcript.get("processingJobId") == job_id
                assert transcript.get("status") in ("READY", "READY_WITH_WARNINGS")
                assert segments and all(segment.get("text") == "Cuộc họp thống nhất kế hoạch triển khai."
                                        for segment in segments)
                return job, transcript
            await asyncio.sleep(0.2)
        raise AssertionError("Timed out waiting for Core durable transcription acceptance")


def synthetic_wav():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        frames = [struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / 16000)))
                  for i in range(16000)]
        audio.writeframes(b"".join(frames))
    return output.getvalue()


def test_controlled_pipeline_processes_synthetic_media(tmp_path):
    """Exercise real decoding and pipeline separately from infrastructure."""
    source = tmp_path / "source.wav"
    source.write_bytes(synthetic_wav())
    settings = Settings(service_name="e2e04", service_identity="ai-worker", environment="test",
                        audio_temp_dir=tmp_path, _env_file=None)
    failures = []

    def trace(frame, event, arg):
        if event == "exception" and arg[0].__name__ == "AudioProcessingError":
            filename = frame.f_code.co_filename
            if "/transcription/" in filename:
                failures.append((filename.rsplit("/", 1)[-1], frame.f_lineno))
        return trace

    sys.settrace(trace)
    try:
        with ExitStack() as resources:
            outcome = controlled_pipeline(settings, resources).run(AudioSource(str(uuid4()), source))
    finally:
        sys.settrace(None)
    assert outcome.failure is None, (
        f"pipeline failure: {outcome.failure.stage.name} / {outcome.failure.category}; locations={failures}"
        if outcome.failure else "unexpected failure")
    from sme_meeting_ai.workers.transcription import map_result

    p = outcome.provenance
    assert p.asr.asr
    for _, model in p.asr.asr:
        assert model.provider == "openrouter"
        assert model.requested_model == settings.audio_asr_model == "openai/whisper-large-v3"
        config = dict(model.inference_config)
        assert config["language"] == settings.audio_asr_language == "vi"
        assert config["temperature"] == settings.audio_asr_temperature
        assert model.resolved_model is None and model.upstream_provider is None
    with ExitStack() as resources:
        candidate = controlled_pipeline(settings, resources)._transcriber.transcribe(
            SimpleNamespace(duration=Fraction(1), chunk_id="fixture"))
    config = dict(candidate.provenance.inference_config)
    assert config["response_format"] == "verbose_json"
    assert config["timestamp_granularity"] == "segment"
    binding = dict(job_id=str(uuid4()), media_id=p.source_id, source_revision="a" * 64,
                   producer_id=str(uuid4()))
    with ExitStack() as resources:
        pipeline = controlled_pipeline(settings, resources)
        effective = pipeline.effective_settings
        first = json.loads(map_result(outcome, effective, asr_adapter_version=pipeline.asr_adapter_version, **binding))
        second = json.loads(map_result(outcome, effective.model_copy(deep=True),
                                       asr_adapter_version=pipeline.asr_adapter_version, **binding))
        changed = effective.model_copy(update={"transcript_correction_model": "other/model"})
        third = json.loads(map_result(outcome, changed, asr_adapter_version=pipeline.asr_adapter_version, **binding))
    assert effective.transcript_correction_model == "e2e04/correction"
    assert first["provenance"]["configurationSha256"] == second["provenance"]["configurationSha256"]
    assert first["provenance"]["configurationSha256"] != third["provenance"]["configurationSha256"]
    assert {c["name"]: c["version"] for c in first["provenance"]["components"]}["asr-adapter"] == "e2e04-controlled-openrouter-normalizer-v1"


def require_opt_in():
    if os.environ.get("RUN_WORKER_LIVE_ACCEPTANCE") != "1":
        pytest.skip("Explicit isolated E2E-04 acceptance opt-in is required")
    required = (
        "E2E04_CORE_EMAIL", "E2E04_CORE_PASSWORD", "AI_SERVICE_NAME", "AI_SERVICE_IDENTITY",
        "AI_ENVIRONMENT",
        "AI_CORE_API_BASE_URL", "AI_CORE_API_SERVER_CA_FILE", "AI_CORE_API_CLIENT_CERT_FILE",
        "AI_CORE_API_CLIENT_KEY_FILE", "AI_RABBITMQ_URL", "AI_RABBITMQ_USERNAME",
        "AI_RABBITMQ_PASSWORD", "AI_RABBITMQ_CA_FILE", "AI_S3_ENDPOINT_URL", "AI_S3_BUCKET",
        "AI_S3_ACCESS_KEY_ID", "AI_S3_SECRET_ACCESS_KEY", "AI_S3_CA_FILE",
    )
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        pytest.fail("Missing secure E2E-04 settings: " + ",".join(missing))
    if os.environ["AI_ENVIRONMENT"] != "test":
        pytest.fail("Controlled E2E-04 acceptance requires AI_ENVIRONMENT=test")


def test_real_worker_reaches_durable_corrected_acceptance_and_stops():
    require_opt_in()
    settings = load_settings(env_file=None)
    audio = synthetic_wav()

    async def run():
        admission = CoreAdmission(settings)
        execution = TranscriptionExecution(settings, pipeline_factory=controlled_pipeline)
        controlled = ControlledExecution(execution)
        worker_task = asyncio.create_task(run_worker(settings, controlled, (lambda: controlled,)))
        try:
            meeting_id, media_id, job_id = await admission.admit(audio)
            job, transcript = await admission.wait_for_acceptance(meeting_id, job_id, worker_task)
            controlled.request_shutdown()
            assert await asyncio.wait_for(worker_task, settings.worker_shutdown_timeout_seconds + 5) == 0
            assert execution.broker.tag is None and execution.worker._closed
            print(
                "E2E04_EVIDENCE "
                f"meeting_id={meeting_id} media_id={media_id} job_id={job_id} "
                f"job_status={job['status']} transcript_status={transcript['status']}"
            )
        finally:
            if not worker_task.done():
                controlled.request_shutdown()
                worker_task.cancel()
                await asyncio.gather(worker_task, return_exceptions=True)
            await admission.close()

    asyncio.run(run())
