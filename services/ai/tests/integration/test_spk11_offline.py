"""Offline integration gate: real worker/service/provider adapter; HTTP/S3 doubles.

Canonical persistence/atomicity are deliberately asserted in the PostgreSQL and
full-stack Java suites, never inferred from this fake Core's HTTP responses.
"""

import asyncio
import hashlib
import json
import wave

import pytest
from integration.spk11_fixtures import (
    FIXTURE,
    FakeInference,
    controlled_adapter,
    synthetic_wav,
)
from integration.test_diarization_worker import execute, harness

from sme_meeting_ai.diarization.service import DiarizationService


@pytest.fixture(autouse=True)
def no_paid_network(monkeypatch):
    import httpx

    async def forbidden(*args, **kwargs):
        pytest.fail("SPK-11 offline inference attempted a live HTTP transport")
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", forbidden)


def configure(h):
    _, s3, _, _, core, _ = h
    s3.audio = synthetic_wav()
    core.event["sourceRevision"] = hashlib.sha256(s3.audio).hexdigest()
    core.source_size = len(s3.audio)
    original = core.reply

    def reply(data, status=200, code="OK"):
        if data and "source" in data:
            data["source"]["durationMs"] = FIXTURE["durationMs"]
        if data and "segments" in data:
            data["durationMs"] = FIXTURE["durationMs"]
            data["segments"] = [{k: v for k, v in s.items() if k != "text"} for s in FIXTURE["segments"]]
        return original(data, status, code)
    core.reply = reply


@pytest.mark.parametrize("scenario", ["one", "two", "overlap", "zero"])
def test_real_service_adapter_and_worker_produce_expected_immutable_evidence(tmp_path, scenario):
    with harness(tmp_path, diarization_enabled=True, replicate_api_token="synthetic-only") as h:
        configure(h)
        fake = FakeInference(scenario)
        with controlled_adapter(h[0], fake) as adapter:
            h[3].service = DiarizationService(adapter)
            _, delivery = asyncio.run(execute(h))
            assert delivery.actions == ["ack"], "A successful result must obtain a durable terminal disposition"
            expected = FIXTURE["scenarios"][scenario]
            artifact = json.loads(h[1].objects[h[4].slot])
            assert artifact["speakerLabels"] == expected["labels"]
            assert [a["speakerLabel"] for a in artifact["assignments"]] == expected["assignments"]
            assert [a["ordinal"] for a in artifact["assignments"]] == [7, 11, 19]
            assert artifact["turns"] == [dict(startMs=a, endMs=b, speakerLabel=c) for a, b, c in expected["turns"]]
            assert artifact["diagnostics"]["unknownAssignmentCount"] == expected["assignments"].count(None)
            assert len(h[1].puts) == 1 and h[1].puts[0]["IfNoneMatch"] == "*"
            before = list(fake.calls)
            _, duplicate = asyncio.run(execute(h))
            assert duplicate.actions == ["ack"] and fake.calls == before
        assert not list(tmp_path.rglob("*.wav")), "Downloaded synthetic audio must be cleaned"


@pytest.mark.parametrize(("mode", "category", "predictions", "backoffs"), [
    ("auth", "AUTHENTICATION", 0, []),
    ("timeout", "TIMEOUT", 0, []),
    ("rate-transient", None, 2, [2]),
    ("rate-persistent", "RATE_LIMIT", 3, [2, 2]),
])
def test_provider_failures_and_bounded_backoff_through_worker(tmp_path, caplog, mode, category, predictions, backoffs):
    with harness(tmp_path, diarization_enabled=True, replicate_api_token="synthetic-only",
                 diarization_timeout_seconds=0.05 if mode == "timeout" else 10) as h:
        configure(h)
        fake = FakeInference(mode)
        with controlled_adapter(h[0], fake) as adapter:
            h[3].service = DiarizationService(adapter)
            worker, delivery = asyncio.run(execute(h))
        assert delivery.actions == ["ack"]
        assert sum(path == "/v1/predictions" for _, path in fake.calls) == predictions
        assert fake.backoffs == backoffs
        assert len(h[4].command_bodies) == 1, "Provider retries must not produce contradictory Core outcomes"
        if category:
            assert h[4].state == "FAILURE_RECORDED" and not h[1].objects
            assert h[4].command_bodies[0]["category"] == category
        else:
            assert h[4].state == "RESULT_ACCEPTED"
        assert worker.stop_intake.is_set() == (mode == "auth")
        assert "SECRET" not in caplog.text and "synthetic-only" not in caplog.text


def test_source_is_a_valid_synthetic_audio_container(tmp_path):
    source = tmp_path / "permitted.wav"
    source.write_bytes(synthetic_wav())
    with wave.open(str(source), "rb") as audio:
        assert audio.getnframes() * 1000 == audio.getframerate() * FIXTURE["durationMs"]
        assert audio.getnchannels() == 1 and audio.getsampwidth() == 2
