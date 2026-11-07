import asyncio
import io
import threading
import wave
from contextlib import asynccontextmanager
from unittest.mock import Mock

import httpx
import pytest
from starlette import formparsers

from sme_meeting_ai.api import create_app
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.demo.models import DemoDiarization, DemoResult, DemoSegment

PRIVATE = "private-provider-body-token"


@pytest.fixture(autouse=True)
def quiet_logging(monkeypatch):
    monkeypatch.setattr("sme_meeting_ai.api.app.configure_logging", lambda settings: None)


def audio():
    data = io.BytesIO()
    with wave.open(data, "wb") as stream:
        stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        stream.writeframes(b"\x00\x00" * 3200)
    return data.getvalue()


def config(tmp_path, **kwargs):
    return Settings(_env_file=None, service_name="test", service_identity="ai-core",
                    audio_temp_dir=tmp_path, **kwargs)


def result():
    return DemoResult(durationMs=200, language="vi", segments=(
        DemoSegment(ordinal=0, startMs=0, endMs=200, speakerLabel=None, text="Bản sửa tiếng Việt."),
    ), diarization=DemoDiarization(status="failed", errorCode="TIMEOUT"))


async def poll(http, job_id):
    async def wait():
        while True:
            response = await http.get(f"/demo/v1/jobs/{job_id}")
            if response.json()["status"] in ("completed", "failed"):
                return response
            await asyncio.sleep(0)
    return await asyncio.wait_for(wait(), timeout=5)


@asynccontextmanager
async def application(tmp_path, monkeypatch, runner=None, **kwargs):
    selected = config(tmp_path, demo_enabled=True, **kwargs)
    runner = runner if runner is not None else Mock()
    if isinstance(runner.run, Mock):
        runner.run.return_value = result()
    monkeypatch.setattr("sme_meeting_ai.demo.pipeline.build_demo_runner", lambda settings: runner)
    app = create_app(selected)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://127.0.0.1:8000") as http:
            yield app, http, runner


@pytest.mark.parametrize("options", [
    {}, {"demo_enabled": True, "environment": "staging"},
    {"demo_enabled": True, "environment": "production"},
    {"demo_enabled": True, "environment": "test"},
    {"demo_enabled": True, "http_host": "0.0.0.0"},
])
def test_routes_absent_unless_explicit_local_development(tmp_path, options):
    async def run():
        app = create_app(config(tmp_path, **options))
        assert not any(getattr(route, "path", "").startswith("/demo/") for route in app.routes)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000") as http:
            assert (await http.post("/demo/v1/jobs", files={"file": ("x.wav", audio())})).status_code == 404
            assert (await http.get("/demo/v1/jobs/unknown")).status_code == 404
    asyncio.run(run())


def test_upload_returns_202_while_inference_is_blocked_then_polls_result(tmp_path, monkeypatch):
    async def run():
        entered, release = threading.Event(), threading.Event()
        loop_thread = threading.get_ident()
        observed = []

        def execute(path, *, hints, on_stage, deadline):
            assert threading.get_ident() != loop_thread
            assert path.name == "audio.wav"
            observed.append((path, hints))
            on_stage("transcription")
            entered.set()
            assert release.wait(5)
            on_stage("diarization")
            return result()

        runner = Mock(run=execute)
        try:
            async with application(tmp_path, monkeypatch, runner) as (app, http, _):
                response = await http.post("/demo/v1/jobs", files={
                    "file": ("../../private/client-name.wav", audio(), "application/octet-stream"),
                }, data={"min_speakers": "1", "max_speakers": "3"})
                assert response.status_code == 202
                body = response.json()
                assert body == {"jobId": body["jobId"], "status": "queued", "stage": "queued"}
                assert response.headers["cache-control"] == "no-store"
                assert response.headers["location"] == f"/demo/v1/jobs/{body['jobId']}"
                processing = await http.get(response.headers["location"])
                assert processing.json()["status"] in ("queued", "processing")
                assert processing.json()["result"] is None
                assert (await http.get("/health/live")).status_code == 200
                release.set()
                complete = await poll(http, body["jobId"])
                assert complete.json()["status"] == "completed"
                assert complete.json()["result"] == result().model_dump(mode="json")
                assert complete.headers["cache-control"] == "no-store"
                assert not observed[0][0].exists()
                assert observed[0][1].max_speakers == 3
                assert "client-name" not in complete.text
                assert (await http.get("/demo/v1/jobs/unknown")).status_code == 404
        finally:
            release.set()
        runner.close.assert_called_once()
        assert list(tmp_path.iterdir()) == []
    asyncio.run(run())


@pytest.mark.parametrize("data", [
    {"num_speakers": "0"}, {"num_speakers": "1001"}, {"num_speakers": "2.5"},
    {"num_speakers": "true"}, {"min_speakers": "3", "max_speakers": "2"},
    {"num_speakers": "1", "min_speakers": "2"},
    {"num_speakers": "3", "max_speakers": "2"}, {"unexpected": PRIVATE},
])
def test_multipart_hints_follow_task01_validation(tmp_path, monkeypatch, data):
    async def run():
        async with application(tmp_path, monkeypatch) as (app, http, runner):
            response = await http.post("/demo/v1/jobs", files={"file": ("a.wav", audio())}, data=data)
            assert response.status_code == 422
            assert PRIVATE not in response.text
            runner.run.assert_not_called()
            assert list(app.state.demo_jobs.root.iterdir()) == []
    asyncio.run(run())


def test_invalid_empty_missing_multiple_and_non_audio_uploads(tmp_path, monkeypatch):
    async def run():
        async with application(tmp_path, monkeypatch) as (app, http, runner):
            for kwargs, status in [
                ({"json": {"file": PRIVATE}}, 415),
                ({"data": {"file": PRIVATE}}, 415),
                ({"files": {"file": ("empty.wav", b"")}}, 422),
                ({"files": {"file": ("fake.wav", b"not-audio")}}, 422),
                ({"files": {"other": ("x.wav", audio())}}, 422),
                ({"files": [("file", ("x.wav", audio())), ("file", ("y.wav", audio()))]}, 422),
            ]:
                response = await http.post("/demo/v1/jobs", **kwargs)
                assert response.status_code == status
                assert PRIVATE not in response.text
                assert response.headers["cache-control"] == "no-store"
                assert list(app.state.demo_jobs.root.iterdir()) == []
            for headers, content in [
                ({"Content-Type": "multipart/form-data"}, b"malformed"),
                ({"Content-Type": "multipart/form-data; boundary=b"}, b"not-a-boundary"),
            ]:
                response = await http.post("/demo/v1/jobs", headers=headers, content=content)
                assert response.status_code == 422
                assert PRIVATE not in response.text
            runner.run.assert_not_called()
    asyncio.run(run())


def test_file_and_streamed_request_size_limits(tmp_path, monkeypatch):
    async def run():
        async with application(tmp_path, monkeypatch, demo_max_upload_bytes=100) as (app, http, runner):
            response = await http.post("/demo/v1/jobs", files={"file": ("large.wav", audio())})
            assert response.status_code == 413

            async def chunks():
                yield b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\n'
                for _ in range(5):
                    yield b"x" * 65536
                yield b"\r\n--boundary--\r\n"

            response = await http.post("/demo/v1/jobs", content=chunks(), headers={
                "Content-Type": "multipart/form-data; boundary=boundary",
            })
            assert response.status_code == 413
            runner.run.assert_not_called()
            assert list(app.state.demo_jobs.root.iterdir()) == []
            assert not app.state.demo_jobs._reservations
    asyncio.run(run())


def test_capacity_rejects_before_receiving_body_and_releases_rejected_resources(tmp_path, monkeypatch):
    async def run():
        release, entered = threading.Event(), threading.Event()

        def execute(path, **kwargs):
            entered.set()
            assert release.wait(5)
            return result()

        runner = Mock(run=execute)
        try:
            async with application(tmp_path, monkeypatch, runner, demo_max_queued_jobs=1) as (app, http, _):
                first = await http.post("/demo/v1/jobs", files={"file": ("a.wav", audio())})
                second = await http.post("/demo/v1/jobs", files={"file": ("b.wav", audio())})
                assert first.status_code == second.status_code == 202
                assert (await http.get(second.headers["location"])).json()["status"] == "queued"
                response = await http.post("/demo/v1/jobs", files={"file": ("c.wav", audio())})
                assert response.status_code == 429 and response.headers["retry-after"] == "2"
                assert len(list(app.state.demo_jobs.root.iterdir())) == 2
                release.set()
                await poll(http, second.json()["jobId"])
                assert list(app.state.demo_jobs.root.iterdir()) == []
        finally:
            release.set()
    asyncio.run(run())


def test_failed_job_sanitized_and_expired_job_unknown(tmp_path, monkeypatch, caplog):
    async def run():
        def fail(path, **kwargs):
            raise RuntimeError(PRIVATE + str(path))

        async with application(tmp_path, monkeypatch, Mock(run=fail), demo_result_ttl_seconds=1) as (app, http, _):
            clock = Mock(return_value=0.0)
            app.state.demo_jobs._clock = clock
            response = await http.post("/demo/v1/jobs", files={"file": ("a.wav", audio())})
            complete = await poll(http, response.json()["jobId"])
            assert complete.json() == {
                "jobId": response.json()["jobId"], "status": "failed", "stage": "transcription",
                "result": None, "error": {"code": "PROCESSING_FAILED", "message": "Audio transcription could not be completed."},
            }
            assert PRIVATE not in complete.text + caplog.text
            assert str(tmp_path) not in complete.text + caplog.text
            clock.return_value = 2.0
            assert (await http.get(response.headers["location"])).status_code == 404
            assert list(app.state.demo_jobs.root.iterdir()) == []
    asyncio.run(run())


@pytest.mark.parametrize("headers", [
    {"Host": "public.example:8000"}, {"Origin": "https://evil.example"},
    {"Origin": "null"}, {"Host": "localhost:9000"},
])
def test_demo_rejects_nonlocal_hosts_and_origins(tmp_path, monkeypatch, headers):
    async def run():
        async with application(tmp_path, monkeypatch) as (_, http, runner):
            response = await http.post("/demo/v1/jobs", headers=headers, files={"file": ("a.wav", audio())})
            assert response.status_code == 403
            assert not any(name.startswith("access-control-") for name in response.headers)
            runner.run.assert_not_called()
    asyncio.run(run())


def test_demo_rejects_nonloopback_peer_even_with_forwarded_headers(tmp_path, monkeypatch):
    async def run():
        async with application(tmp_path, monkeypatch) as (app, _, runner):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("192.0.2.2", 80)),
                                         base_url="http://127.0.0.1:8000") as http:
                response = await http.get("/demo/v1/jobs/unknown", headers={"X-Forwarded-For": "127.0.0.1"})
                assert response.status_code == 403
                assert response.headers["cache-control"] == "no-store"
            runner.run.assert_not_called()
    asyncio.run(run())


def test_explicit_local_vite_origin_is_accepted_without_global_cors(tmp_path, monkeypatch):
    async def run():
        async with application(tmp_path, monkeypatch, demo_web_origin="http://localhost:5173") as (_, http, _):
            response = await http.post("/demo/v1/jobs", headers={"Origin": "http://localhost:5173"},
                                       files={"file": ("a.wav", audio())})
            assert response.status_code == 202
            assert not any(name.startswith("access-control-") for name in response.headers)
    asyncio.run(run())


def test_multipart_spool_is_closed_before_inference_starts(tmp_path, monkeypatch):
    async def run():
        spools = []
        original = formparsers.SpooledTemporaryFile

        def spool(*args, **kwargs):
            file = original(*args, **kwargs)
            spools.append(file)
            return file

        def execute(path, **kwargs):
            assert spools and all(file.closed for file in spools)
            return result()

        monkeypatch.setattr(formparsers, "SpooledTemporaryFile", spool)
        async with application(tmp_path, monkeypatch, Mock(run=execute)) as (_, http, _):
            accepted = await http.post("/demo/v1/jobs", files={"file": ("a.wav", audio())})
            assert accepted.status_code == 202
            complete = await poll(http, accepted.json()["jobId"])
            assert complete.json()["status"] == "completed"
    asyncio.run(run())


def test_cancelled_upload_waits_for_its_io_thread_before_cleanup(tmp_path, monkeypatch):
    async def run():
        from sme_meeting_ai.api import demo

        entered, release = threading.Event(), threading.Event()
        original = demo._prepare_upload
        observed = []

        def prepare(file, directory, settings):
            entered.set()
            assert release.wait(5)
            assert not file.closed
            path = original(file, directory, settings)
            observed.append(path)
            return path

        monkeypatch.setattr(demo, "_prepare_upload", prepare)
        async with application(tmp_path, monkeypatch) as (app, http, runner):
            request = asyncio.create_task(http.post("/demo/v1/jobs", files={"file": ("a.wav", audio())}))
            try:
                assert await asyncio.to_thread(entered.wait, 5)
                request.cancel()
                await asyncio.sleep(0)
                assert not request.done()
            finally:
                release.set()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert observed and not observed[0].exists()
            assert not app.state.demo_jobs._reservations
            runner.run.assert_not_called()
    asyncio.run(run())
