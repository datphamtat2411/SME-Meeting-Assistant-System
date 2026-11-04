import json
import traceback

import httpx
import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.diarization import (
    DiarizationError,
    DiarizationErrorCategory,
    SpeakerTurn,
    TimedTranscriptSegment,
    align_speakers,
)
from sme_meeting_ai.diarization.parsing import parse_output, parse_timestamp
from sme_meeting_ai.providers.replicate_diarization import ReplicateDiarizationAdapter

MODEL = "konieshadow/speaker-diarization:c58b6b038f6de30f93eaccd6aecb59d1b9a48ac13b22be000bcffe853efb2c20"
SECRET = "test-secret-token"


def payload(segments=None, labels=None):
    labels = [] if labels is None else labels
    return json.dumps({"segments": segments or [], "speakers": {"count": len(labels), "labels": labels}}).encode()


def segment(speaker, start, stop):
    return {"speaker": speaker, "start": start, "stop": stop}


@pytest.mark.parametrize(("value", "expected"), [
    ("0:00:01.250000", 1250), ("0:01:13.500000", 73500),
    ("1:02:03.125000", 3723125), ("0:00:00.000499", 0),
    ("0:00:00.000500", 1), ("0:00:59.999500", 60000),
])
def test_timestamp(value, expected):
    assert parse_timestamp(value) == expected


@pytest.mark.parametrize("value", ["-1:00:00", "0:60:00", "0:00:60", "nan", "0:0:01", 1, None])
def test_invalid_timestamp(value):
    with pytest.raises(ValueError):
        parse_timestamp(value)


def test_normalization_stable_order_and_overlap():
    data = payload([
        segment("B", "0:00:02", "0:00:05"),
        segment("A", "0:00:00", "0:00:03"),
        segment("B", "0:00:00", "0:00:01"),
        segment("A", "0:00:05", "0:00:06"),
    ], ["B", "A"])
    result = parse_output(data, MODEL)
    assert result.turns == (SpeakerTurn(0, 3000, "SPEAKER_00"),
                            SpeakerTurn(0, 1000, "SPEAKER_01"),
                            SpeakerTurn(2000, 5000, "SPEAKER_01"),
                            SpeakerTurn(5000, 6000, "SPEAKER_00"))
    assert result.speakers == ("SPEAKER_00", "SPEAKER_01")
    assert result.model_id == MODEL


def test_empty_and_more_than_ten_speakers():
    assert parse_output(payload(), MODEL).turns == ()
    labels = [f"P{i}" for i in range(12)]
    data = payload([segment(label, f"0:00:{i:02d}", f"0:00:{i + 1:02d}")
                    for i, label in enumerate(labels)], labels)
    assert parse_output(data, MODEL).speakers[-1] == "SPEAKER_11"


@pytest.mark.parametrize("data", [
    b"not json", b'{}', b'[]', b'{"segments": NaN}',
    payload([segment("A", "0:00:01", "0:00:01")], ["A"]),
    payload([segment("A", "0:00:02", "0:00:01")], ["A"]),
    payload([segment("A", "0:00:00.0001", "0:00:00.0004")], ["A"]),
    payload([segment("", "0:00:00", "0:00:01")], [""]),
    payload([segment("A", "0:00:00", "0:00:01")], ["B"]),
    b'{"segments":[],"speakers":{"count":1,"labels":[]}}',
    b'{"segments":[],"segments":[],"speakers":{"count":0,"labels":[]}}',
    b'{"segments":[],"speakers":{"count":0,"labels":[]},"embedding":[1e999]}',
])
def test_bad_output(data):
    with pytest.raises(DiarizationError) as exc:
        parse_output(data, MODEL)
    assert exc.value.category == DiarizationErrorCategory.MALFORMED_OUTPUT


def test_alignment_cases_and_identity():
    turns = (SpeakerTurn(500, 3500, "SPEAKER_00"),
             SpeakerTurn(3500, 6000, "SPEAKER_01"),
             SpeakerTurn(10000, 11000, "SPEAKER_00"),
             SpeakerTurn(11000, 12000, "SPEAKER_00"),
             SpeakerTurn(10000, 12000, "SPEAKER_01"))
    segments = (TimedTranscriptSegment(9, 1000, 3000), TimedTranscriptSegment(2, 3000, 5000),
                TimedTranscriptSegment(7, 8000, 9000), TimedTranscriptSegment(3, 6000, 8000),
                TimedTranscriptSegment(5, 10000, 12000))
    result = align_speakers(segments, turns)
    assert [(x.ordinal, x.speaker_label) for x in result] == [
        (9, "SPEAKER_00"), (2, "SPEAKER_01"), (7, None), (3, None), (5, None)]
    assert align_speakers([], turns) == ()
    assert align_speakers(segments[:1], ())[0].speaker_label is None
    assert align_speakers([TimedTranscriptSegment(1, 0, 4000)], [
        SpeakerTurn(0, 1000, "SPEAKER_00"), SpeakerTurn(2000, 4000, "SPEAKER_00"),
        SpeakerTurn(1000, 3000, "SPEAKER_01")])[0].speaker_label == "SPEAKER_00"


def settings(**kwargs):
    return Settings(service_name="test", service_identity="ai-core", _env_file=None, **kwargs)


def test_provider_request(tmp_path):
    audio = tmp_path / "meeting.wav"
    audio.write_bytes(b"audio-bytes")
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path == "/v1/files":
            assert b"audio-bytes" in request.read()
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/abc"}})
        if request.url.path == "/v1/predictions":
            body = json.loads(request.content)
            assert body == {"version": MODEL.split(":")[1], "input": {
                "audio": "https://api.replicate.com/v1/files/abc", "min_speakers": 1, "max_speakers": 3}}
            return httpx.Response(201, json={"id": "abc123", "status": "succeeded",
                                             "output": "https://replicate.delivery/output"})
        assert request.url.host == "replicate.delivery"
        assert request.headers["authorization"] == f"Bearer {SECRET}"
        return httpx.Response(200, content=payload([segment("A", "0:00:00", "0:00:01")], ["A"]))

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    result = adapter.diarize(audio, min_speakers=1, max_speakers=3)
    assert result.turns == (SpeakerTurn(0, 1000, "SPEAKER_00"),)
    assert len(requests) == 3


@pytest.mark.parametrize("status,category", [(401, "authentication"), (429, "rate_limit"), (500, "provider")])
def test_provider_error_is_sanitized(tmp_path, status, category):
    path = tmp_path / "private.wav"
    path.write_bytes(b"audio")
    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(
        lambda _: httpx.Response(status, text="private-provider-diagnostic")))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category.value == category
    assert exc.value.__context__ is None
    assert SECRET not in "".join(traceback.format_exception(exc.value))
    assert "private-provider-diagnostic" not in "".join(traceback.format_exception(exc.value))


def test_validation_before_network(tmp_path):
    path = tmp_path / "sound.wav"
    path.write_bytes(b"sound")
    adapter = ReplicateDiarizationAdapter(settings())
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == DiarizationErrorCategory.CONFIGURATION
    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET))
    for hints in ({"num_speakers": 0}, {"min_speakers": 3, "max_speakers": 2},
                  {"num_speakers": 1, "min_speakers": 2}, {"num_speakers": True}):
        with pytest.raises(DiarizationError) as exc:
            adapter.diarize(path, **hints)
        assert exc.value.category == DiarizationErrorCategory.VALIDATION
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(tmp_path)
    assert exc.value.category == DiarizationErrorCategory.VALIDATION


def test_polling_and_optional_exact_count(tmp_path):
    path = tmp_path / "audio.wav"
    path.write_bytes(b"audio")
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/files":
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/abc"}})
        if request.method == "POST":
            assert json.loads(request.content)["input"]["num_speakers"] == 2
            return httpx.Response(201, json={"id": "prediction1", "status": "processing"})
        if request.url.host == "api.replicate.com":
            return httpx.Response(200, json={"status": "succeeded", "output": "https://replicate.delivery/output"})
        return httpx.Response(200, content=payload())

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    assert adapter.diarize(path, num_speakers=2).turns == ()
    assert calls == ["/v1/files", "/v1/predictions", "/v1/predictions/prediction1", "/output"]


def test_deadline_and_untrusted_output_url(tmp_path):
    path = tmp_path / "audio.wav"
    path.write_bytes(b"audio")

    def handler(request):
        if request.url.path == "/v1/files":
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/abc"}})
        return httpx.Response(201, json={"status": "succeeded", "output": "https://localhost/private"})

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == DiarizationErrorCategory.MALFORMED_OUTPUT

    async def slow(_request):
        import asyncio
        await asyncio.sleep(1)
        return httpx.Response(500)

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET, diarization_timeout_seconds=0.01),
                                           transport=httpx.MockTransport(slow))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == DiarizationErrorCategory.TIMEOUT


def test_environment_token_alias(monkeypatch):
    monkeypatch.setenv("REPLICATE_API_TOKEN", SECRET)
    assert settings().replicate_api_token.get_secret_value() == SECRET
    assert SECRET not in repr(settings())
