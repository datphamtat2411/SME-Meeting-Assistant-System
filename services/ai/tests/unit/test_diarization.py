import json
import os
import traceback
from decimal import Decimal
from fractions import Fraction

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
from sme_meeting_ai.providers import replicate_diarization
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
    assert result.turns == (SpeakerTurn(0, 3000, "SPEAKER_01"),
                            SpeakerTurn(0, 1000, "SPEAKER_02"),
                            SpeakerTurn(2000, 5000, "SPEAKER_02"),
                            SpeakerTurn(5000, 6000, "SPEAKER_01"))
    assert result.speakers == ("SPEAKER_01", "SPEAKER_02")
    assert result.model_id == MODEL


def test_empty_and_more_than_ten_speakers():
    assert parse_output(payload(), MODEL).turns == ()
    labels = [f"P{i}" for i in range(12)]
    data = payload([segment(label, f"0:00:{i:02d}", f"0:00:{i + 1:02d}")
                    for i, label in enumerate(labels)], labels)
    result = parse_output(data, MODEL)
    expected = tuple(f"SPEAKER_{i:02d}" for i in range(1, 13))
    assert result.speakers == expected
    assert tuple(turn.speaker_label for turn in result.turns) == expected


def test_numbering_remains_valid_beyond_99_and_matches_turn_references():
    labels = [f"P{i}" for i in range(100)]
    segments = [
        segment(label, f"0:{i // 60:02d}:{i % 60:02d}",
                f"0:{(i + 1) // 60:02d}:{(i + 1) % 60:02d}")
        for i, label in reversed(list(enumerate(labels)))
    ]
    result = parse_output(payload(segments, list(reversed(labels))), MODEL)
    expected = tuple(f"SPEAKER_{i:02d}" for i in range(1, 101))
    assert result.speakers == expected
    assert tuple(turn.speaker_label for turn in result.turns) == expected
    assert result.turns[0].start_ms == 0 and result.turns[-1].start_ms == 99_000


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


def test_oversized_output_is_rejected():
    from sme_meeting_ai.diarization.parsing import MAX_OUTPUT_BYTES

    with pytest.raises(DiarizationError) as exc:
        parse_output(b" " * (MAX_OUTPUT_BYTES + 1), MODEL)
    assert exc.value.category == DiarizationErrorCategory.MALFORMED_OUTPUT


def test_alignment_cases_and_identity():
    turns = (SpeakerTurn(500, 3500, "SPEAKER_01"),
             SpeakerTurn(3500, 6000, "SPEAKER_02"),
             SpeakerTurn(10000, 11000, "SPEAKER_01"),
             SpeakerTurn(11000, 12000, "SPEAKER_01"),
             SpeakerTurn(10000, 12000, "SPEAKER_02"))
    segments = (TimedTranscriptSegment(9, 1000, 3000), TimedTranscriptSegment(2, 3000, 5000),
                TimedTranscriptSegment(7, 8000, 9000), TimedTranscriptSegment(3, 6000, 8000),
                TimedTranscriptSegment(5, 10000, 12000))
    result = align_speakers(segments, turns)
    assert [(x.ordinal, x.speaker_label) for x in result] == [
        (9, "SPEAKER_01"), (2, "SPEAKER_02"), (7, None), (3, None), (5, None)]
    assert align_speakers([], turns) == ()
    assert align_speakers(segments[:1], ())[0].speaker_label is None
    assert align_speakers([TimedTranscriptSegment(1, 0, 4000)], [
        SpeakerTurn(0, 1000, "SPEAKER_01"), SpeakerTurn(2000, 4000, "SPEAKER_01"),
        SpeakerTurn(1000, 3000, "SPEAKER_02")])[0].speaker_label == "SPEAKER_01"


@pytest.mark.parametrize(("turns", "expected"), [
    ([(0, 1000, "01")], "SPEAKER_01"),
    ([(1000, 1100, "01")], None),
    ([(0, 1, "01")], None),
    ([(0, 499, "01")], None),
    ([(0, 500, "01")], "SPEAKER_01"),
    ([(0, 600, "01"), (400, 1000, "02")], None),
    ([(0, 700, "01"), (0, 551, "02")], None),
    ([(0, 700, "01"), (0, 550, "02")], "SPEAKER_01"),
    ([(0, 800, "01"), (300, 500, "02")], "SPEAKER_01"),
    ([(0, 700, "01"), (300, 1000, "02")], None),
    ([(0, 400, "01"), (0, 400, "01")], None),
    ([(0, 600, "01"), (100, 600, "01"), (0, 700, "02")], None),
    ([(0, 500, "01"), (500, 1000, "02")], None),
])
def test_conservative_alignment(turns, expected):
    evidence = [SpeakerTurn(start, end, f"SPEAKER_{label}") for start, end, label in turns]
    segment = TimedTranscriptSegment(42, 0, 1000)
    assert align_speakers([segment], evidence)[0].speaker_label == expected
    assert align_speakers([segment], reversed(evidence))[0].speaker_label == expected


def test_alignment_preserves_inputs_and_long_mixed_segments():
    segments = [TimedTranscriptSegment(9, 0, 100_000), TimedTranscriptSegment(2, 100_000, 101_000)]
    turns = [SpeakerTurn(100_000, 101_000, "SPEAKER_02"),
             SpeakerTurn(49_000, 100_000, "SPEAKER_02"),
             SpeakerTurn(0, 51_000, "SPEAKER_01")]
    original_segments, original_turns = segments[:], turns[:]
    result = align_speakers(segments, turns)
    assert [(item.ordinal, item.speaker_label) for item in result] == [(9, None), (2, "SPEAKER_02")]
    assert segments == original_segments and turns == original_turns


def test_configurable_thresholds_and_exact_boundaries():
    segment = [TimedTranscriptSegment(1, 0, 1000)]
    turns = [SpeakerTurn(0, 500, "SPEAKER_01"), SpeakerTurn(0, 350, "SPEAKER_02")]
    assert align_speakers(segment, turns)[0].speaker_label == "SPEAKER_01"
    assert align_speakers(segment, turns, min_coverage_ratio=Decimal("0.5"),
                          min_dominance_margin_ratio=Fraction(3, 20))[0].speaker_label == "SPEAKER_01"
    assert align_speakers(segment, turns, min_coverage_ratio=0.501)[0].speaker_label is None
    assert align_speakers(segment, turns, min_dominance_margin_ratio=0.151)[0].speaker_label is None
    assert align_speakers(segment, [SpeakerTurn(0, 1, "SPEAKER_01")],
                          min_coverage_ratio=0, min_dominance_margin_ratio=0)[0].speaker_label == "SPEAKER_01"
    assert align_speakers(segment, [SpeakerTurn(0, 1000, "SPEAKER_01")],
                          min_coverage_ratio=1, min_dominance_margin_ratio=1)[0].speaker_label == "SPEAKER_01"
    assert align_speakers(segment, [SpeakerTurn(0, 500, "SPEAKER_01"), SpeakerTurn(0, 500, "SPEAKER_02")],
                          min_coverage_ratio=0, min_dominance_margin_ratio=0)[0].speaker_label is None


@pytest.mark.parametrize("name", ["min_coverage_ratio", "min_dominance_margin_ratio"])
@pytest.mark.parametrize("value", [True, False, None, "0.5", 1j, float("nan"), float("inf"),
                                    -float("inf"), -0.01, 1.01])
def test_invalid_alignment_thresholds_fail_even_for_empty_input(name, value):
    with pytest.raises((TypeError, ValueError)):
        align_speakers([], [], **{name: value})


def settings(**kwargs):
    return Settings(service_name="test", service_identity="ai-core", _env_file=None, **kwargs)


def test_upload_url_accepts_opaque_file_path():
    url = "https://api.replicate.com/v1/files/abc.def:ghi"
    assert replicate_diarization._upload_url(url) == url


@pytest.mark.parametrize("url", [
    "https://other.example/v1/files/abc.def:ghi",
    "https://api.replicate.com.evil.example/v1/files/abc",
    "http://api.replicate.com/v1/files/abc",
    "https://api.replicate.com/v1/files/",
    "https://api.replicate.com/v1/files/abc?token=value",
    "https://api.replicate.com/v1/files/abc#fragment",
    "https://api.replicate.com/v1/files/../abc",
    "https://api.replicate.com/v1/files/./abc",
    "https://api.replicate.com/v1/files/a\nb",
    "https://api.replicate.com/v1/files/" + "a" * 8192,
])
def test_upload_url_rejects_untrusted_urls(url):
    with pytest.raises(DiarizationError) as exc:
        replicate_diarization._upload_url(url)
    assert exc.value.category == DiarizationErrorCategory.MALFORMED_OUTPUT


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
        assert "authorization" not in request.headers
        return httpx.Response(200, content=payload([segment("A", "0:00:00", "0:00:01")], ["A"]))

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    result = adapter.diarize(audio, min_speakers=1, max_speakers=3)
    assert result.turns == (SpeakerTurn(0, 1000, "SPEAKER_01"),)
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


@pytest.mark.parametrize("initial_status", ["starting", "processing"])
def test_polling_and_optional_exact_count(tmp_path, monkeypatch, initial_status):
    path = tmp_path / "audio.wav"
    path.write_bytes(b"audio")
    calls = []
    waits = []

    async def wait(seconds):
        waits.append(seconds)

    monkeypatch.setattr(replicate_diarization.asyncio, "sleep", wait)

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/files":
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/abc"}})
        if request.method == "POST":
            assert json.loads(request.content)["input"]["num_speakers"] == 2
            return httpx.Response(201, json={"id": "prediction1", "status": initial_status})
        if request.url.host == "api.replicate.com":
            if calls.count("/v1/predictions/prediction1") == 1:
                return httpx.Response(200, json={"id": "prediction1", "status": "processing"})
            return httpx.Response(200, json={"status": "succeeded", "output": "https://replicate.delivery/output"})
        return httpx.Response(200, content=payload())

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    assert adapter.diarize(path, num_speakers=2).turns == ()
    assert calls == ["/v1/files", "/v1/predictions", "/v1/predictions/prediction1",
                     "/v1/predictions/prediction1", "/output"]
    assert waits == [15, 15]


@pytest.mark.parametrize("kind", ["directory", "missing", "empty", "oversized", "fifo"])
def test_invalid_audio_sources_are_validation_errors_and_close_descriptors(tmp_path, monkeypatch, kind):
    path = tmp_path / kind
    if kind == "directory":
        path.mkdir()
    elif kind == "empty":
        path.touch()
    elif kind == "oversized":
        with path.open("wb") as audio:
            audio.truncate(100_000_001)
    elif kind == "fifo":
        os.mkfifo(path)

    real_open = os.open
    opened = []

    def tracked_open(*args, **kwargs):
        fd = real_open(*args, **kwargs)
        opened.append(fd)
        return fd

    monkeypatch.setattr(replicate_diarization.os, "open", tracked_open)
    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == (DiarizationErrorCategory.INPUT_TOO_LARGE if kind == "oversized"
                                  else DiarizationErrorCategory.VALIDATION)
    assert str(path) not in "".join(traceback.format_exception(exc.value))
    assert len(opened) == (0 if kind == "missing" else 1)
    for fd in opened:
        with pytest.raises(OSError):
            os.fstat(fd)


@pytest.mark.parametrize("failure", ["fstat", "fdopen"])
def test_descriptor_closed_when_local_setup_fails(tmp_path, monkeypatch, failure):
    path = tmp_path / "audio.wav"
    path.write_bytes(b"audio")
    real_open = os.open
    real_fstat = os.fstat
    opened = []

    def tracked_open(*args, **kwargs):
        fd = real_open(*args, **kwargs)
        opened.append(fd)
        return fd

    def fail(*args, **kwargs):
        raise OSError("sensitive filesystem details")

    monkeypatch.setattr(replicate_diarization.os, "open", tracked_open)
    monkeypatch.setattr(replicate_diarization.os, failure, fail)
    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == DiarizationErrorCategory.VALIDATION
    assert "sensitive" not in "".join(traceback.format_exception(exc.value))
    assert len(opened) == 1
    with pytest.raises(OSError):
        real_fstat(opened[0])


@pytest.mark.parametrize(("status", "category"), [
    ("failed", DiarizationErrorCategory.PROVIDER),
    ("canceled", DiarizationErrorCategory.PROVIDER),
    ("unexpected", DiarizationErrorCategory.MALFORMED_OUTPUT),
    (None, DiarizationErrorCategory.MALFORMED_OUTPUT),
])
def test_terminal_and_malformed_prediction_states(tmp_path, status, category):
    path = tmp_path / "audio.wav"
    path.write_bytes(b"audio")
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/files":
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/abc"}})
        return httpx.Response(201, json={"status": status})

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == category
    assert calls == ["/v1/files", "/v1/predictions"]


def test_polling_rate_limit_retries_bounded(tmp_path, monkeypatch):
    path = tmp_path / "audio.wav"
    path.write_bytes(b"audio")
    calls = []
    waits = []

    async def wait(seconds):
        waits.append(seconds)

    monkeypatch.setattr(replicate_diarization.asyncio, "sleep", wait)

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/files":
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/abc"}})
        if request.method == "POST":
            return httpx.Response(201, json={"id": "abc", "status": "starting"})
        return httpx.Response(429, headers={"Retry-After": "3"}, text="private-provider-diagnostic")

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == DiarizationErrorCategory.RATE_LIMIT
    assert "private-provider-diagnostic" not in "".join(traceback.format_exception(exc.value))
    assert calls == ["/v1/files", "/v1/predictions"] + ["/v1/predictions/abc"] * 3
    assert waits == [15, 3, 3]


@pytest.mark.parametrize("status,category", [(400, "validation"), (422, "validation"),
                                             (403, "authentication"), (413, "input_too_large"),
                                             (408, "timeout"), (504, "timeout")])
def test_http_classification_without_upload_retry(tmp_path, status, category):
    path = tmp_path / "audio"
    path.write_bytes(b"audio")
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, text="private")
    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category.value == category
    assert len(calls) == 1
    assert path.read_bytes() == b"audio"


@pytest.mark.parametrize("failure,expected_calls", [(500, 1), (429, 3), ("transport", 1)])
def test_prediction_creation_retry_safety(tmp_path, monkeypatch, failure, expected_calls):
    path = tmp_path / "audio"
    path.write_bytes(b"audio")
    calls, waits = [], []
    async def wait(seconds):
        waits.append(seconds)
    monkeypatch.setattr(replicate_diarization.asyncio, "sleep", wait)
    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/files":
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/a"}})
        if failure == "transport":
            raise httpx.ConnectError("secret")
        return httpx.Response(failure)
    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    with pytest.raises(DiarizationError):
        adapter.diarize(path)
    assert calls.count("/v1/predictions") == expected_calls
    assert waits == ([1, 2] if failure == 429 else [])


def test_disabled_provider_and_upload_boundary(tmp_path, monkeypatch):
    path = tmp_path / "audio"
    path.write_bytes(b"audio")
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(401)
    disabled = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET, diarization_enabled=False),
                                            transport=httpx.MockTransport(handler))
    with pytest.raises(DiarizationError) as exc:
        disabled.diarize(path)
    assert exc.value.category == DiarizationErrorCategory.CONFIGURATION and not calls
    monkeypatch.setattr(replicate_diarization, "_MAX_UPLOAD_BYTES", 5)
    enabled = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    with pytest.raises(DiarizationError) as exc:
        enabled.diarize(path)
    assert exc.value.category == DiarizationErrorCategory.AUTHENTICATION and len(calls) == 1
    path.write_bytes(b"audio!")
    with pytest.raises(DiarizationError) as exc:
        enabled.diarize(path)
    assert exc.value.category == DiarizationErrorCategory.INPUT_TOO_LARGE and len(calls) == 1


@pytest.mark.parametrize("size,category,calls_expected", [
    (99_999_999, DiarizationErrorCategory.AUTHENTICATION, 1),
    (100_000_000, DiarizationErrorCategory.AUTHENTICATION, 1),
    (100_000_001, DiarizationErrorCategory.INPUT_TOO_LARGE, 0),
])
def test_sparse_real_upload_limit(tmp_path, monkeypatch, size, category, calls_expected):
    path = tmp_path / "audio.wav"
    with path.open("wb") as audio:
        audio.truncate(size)
    calls = []

    async def reject_upload(audio, filename, token, hints):
        calls.append(filename)
        raise DiarizationError(DiarizationErrorCategory.AUTHENTICATION)

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET))
    monkeypatch.setattr(adapter, "_request", reject_upload)
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == category
    assert len(calls) == calls_expected
    assert path.stat().st_size == size


def test_output_fetch_retries_transport_without_recreating_prediction(tmp_path, monkeypatch):
    path = tmp_path / "audio"
    path.write_bytes(b"audio")
    calls, waits = [], []
    async def wait(seconds):
        waits.append(seconds)
    monkeypatch.setattr(replicate_diarization.asyncio, "sleep", wait)
    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/files":
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/a"}})
        if request.url.path == "/v1/predictions":
            return httpx.Response(201, json={"status": "succeeded", "output": "https://replicate.delivery/output"})
        assert "authorization" not in request.headers
        if calls.count("/output") < 3:
            raise httpx.ConnectError("private")
        return httpx.Response(200, content=payload())
    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    assert adapter.diarize(path).turns == ()
    assert calls == ["/v1/files", "/v1/predictions", "/output", "/output", "/output"]
    assert waits == [1, 2] and path.read_bytes() == b"audio"


def test_retry_after_exceeding_deadline_stops_requests(tmp_path):
    path = tmp_path / "audio"
    path.write_bytes(b"audio")
    calls = []
    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/files":
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/a"}})
        return httpx.Response(429, headers={"Retry-After": "9999"})
    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET, diarization_timeout_seconds=1),
                                         transport=httpx.MockTransport(handler))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == DiarizationErrorCategory.TIMEOUT
    assert calls == ["/v1/files", "/v1/predictions"]


def test_polling_deadline_cancels_wait_without_extra_requests(tmp_path):
    path = tmp_path / "audio.wav"
    path.write_bytes(b"audio")
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/files":
            return httpx.Response(201, json={"urls": {"get": "https://api.replicate.com/v1/files/abc"}})
        return httpx.Response(201, json={"id": "abc", "status": "processing"})

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET, diarization_timeout_seconds=0.02),
                                           transport=httpx.MockTransport(handler))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == DiarizationErrorCategory.TIMEOUT
    assert calls == ["/v1/files", "/v1/predictions"]


@pytest.mark.parametrize(("error", "category"), [
    (httpx.ConnectError("private network detail"), DiarizationErrorCategory.TRANSPORT),
    (httpx.ReadTimeout("private network detail"), DiarizationErrorCategory.TIMEOUT),
    (OSError("private network detail"), DiarizationErrorCategory.TRANSPORT),
])
def test_network_failures_remain_separate_from_validation(tmp_path, error, category):
    path = tmp_path / "audio.wav"
    path.write_bytes(b"audio")

    def handler(_request):
        raise error

    adapter = ReplicateDiarizationAdapter(settings(REPLICATE_API_TOKEN=SECRET), transport=httpx.MockTransport(handler))
    with pytest.raises(DiarizationError) as exc:
        adapter.diarize(path)
    assert exc.value.category == category
    assert "private network detail" not in "".join(traceback.format_exception(exc.value))


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
