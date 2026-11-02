import io
import json
import os
import traceback
import wave
from dataclasses import FrozenInstanceError, replace
from decimal import Decimal
from email import policy
from email.parser import BytesParser
from fractions import Fraction
from types import SimpleNamespace

import httpx
import pytest

from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
from sme_meeting_ai.transcription import (
    AsrAudioChunk,
    AsrCandidate,
    AsrChunk,
    AsrError,
    AsrErrorCategory,
    AsrTimestampMode,
    AsrTranscriptionRequest,
    AsrWord,
    ChunkBoundaryReason,
)
from sme_meeting_ai.transcription.chunk_execution import (
    _execute_chunk,
    _translate_candidate,
)

SECRET = "test-only-private-key"
PRIVATE_AUDIO = "test-only-private-audio"
TEXT = "Nội dung riêng tư"


def wav_payload(duration=Fraction(2), *, rate=16000, channels=1, sample_width=2):
    frame_count = duration * rate
    assert frame_count.denominator == 1
    pcm_size = frame_count.numerator * channels * sample_width
    with io.BytesIO() as buffer:
        with wave.open(buffer, "wb") as writer:
            writer.setparams((channels, sample_width, rate, 0, "NONE", "not compressed"))
            writer.writeframes(PRIVATE_AUDIO.encode().ljust(pcm_size, b"\0")[:pcm_size])
        return buffer.getvalue()


AUDIO = wav_payload()


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    monkeypatch.setattr(os, "environ", {})


def settings(**overrides):
    return Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        OPENROUTER_API_KEY=SECRET, **overrides,
    )


def chunk(**overrides):
    duration = overrides.get("duration", Fraction(2))
    payload = wav_payload(duration) if isinstance(duration, Fraction) and duration > 0 else AUDIO
    return AsrAudioChunk(**{"chunk_id": "chunk-1", "payload": payload,
                            "duration": Fraction(2), **overrides})


def output():
    return {"text": f"  {TEXT}  ", "segments": [
        {"start": 0.1, "end": 1.2, "text": f" {TEXT} "},
    ]}


def invoke(payload, **overrides):
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=payload),
    )) as client:
        with OpenRouterWhisperAdapter(settings(**overrides), client=client) as adapter:
            return adapter.transcribe(chunk())


def assert_sanitized(error, category):
    assert error.category is category
    assert str(error) == category.value
    assert error.args == (category.value,)
    assert error.__context__ is None
    assert error.__cause__ is None
    rendered = "".join(traceback.format_exception(error)) + repr(error)
    for sensitive in (SECRET, PRIVATE_AUDIO, TEXT, "private-provider-diagnostic"):
        assert sensitive not in rendered


def test_request_contract_and_client_reuse_without_retries(caplog):
    calls = []

    def handle(request):
        calls.append(request)
        assert request.method == "POST"
        assert str(request.url) == "https://openrouter.ai/api/v1/audio/transcriptions"
        assert request.headers["authorization"] == f"Bearer {SECRET}"
        assert request.extensions["timeout"] == dict.fromkeys(
            ("connect", "read", "write", "pool"), 2.5,
        )
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode()
            + request.read(),
        )
        parts = {part.get_param("name", header="content-disposition"): part
                 for part in message.iter_parts()}
        expected = {
            "model": "openai/whisper-large-v3", "language": "vi", "temperature": "0",
            "response_format": "verbose_json", "timestamp_granularities[]": "segment",
        }
        assert set(parts) == {*expected, "file"}
        for key, value in expected.items():
            assert parts[key].get_payload(decode=True).decode() == value
        assert parts["file"].get_payload(decode=True) == AUDIO
        assert parts["file"].get_filename() == "chunk.wav"
        assert parts["file"].get_content_type() == "audio/wav"
        return httpx.Response(200, json=output())

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        adapter = OpenRouterWhisperAdapter(settings(audio_asr_timeout_seconds=2.5), client)
        assert isinstance(adapter.transcribe(chunk()), AsrCandidate)
        assert len(calls) == 1
        adapter.transcribe(chunk())
        assert len(calls) == 2
        adapter.close()
        assert not client.is_closed
    for sensitive in (SECRET, PRIVATE_AUDIO, TEXT):
        assert sensitive not in caplog.text


def test_owned_client_is_bounded_ignores_environment_and_closes(monkeypatch):
    original = httpx.Client
    created = []

    def create(**kwargs):
        assert kwargs["trust_env"] is False
        assert kwargs["follow_redirects"] is False
        assert kwargs["timeout"] == 120
        client = original(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=output())), **kwargs)
        created.append(client)
        return client

    monkeypatch.setattr(httpx, "Client", create)
    with OpenRouterWhisperAdapter(settings()) as adapter:
        adapter.transcribe(chunk())
        adapter.transcribe(chunk())
    assert len(created) == 1
    assert created[0].is_closed


def test_normalization_quality_usage_provenance_and_transient_repr():
    data = output()
    data.update({
        "text": "  Tôi  họp\nngày mai  ", "confidence": 0.8,
        "language": "vi", "language_probability": 0.9,
        "model": "upstream/resolved", "provider": "upstream-provider",
        "usage": {"input_tokens": 10, "output_tokens": 4, "total_tokens": 14,
                  "cost": 0.001, "seconds": 2},
    })
    data["segments"][0].update({
        "avg_logprob": -0.2, "compression_ratio": 1.1,
        "no_speech_prob": 0.05, "temperature": 0, "confidence": 0.7,
    })
    candidate = invoke(data)
    assert candidate.text == "Tôi  họp\nngày mai"
    assert candidate.chunk_id == "chunk-1"
    assert isinstance(candidate.segments, tuple)
    segment = candidate.segments[0]
    assert segment.start == Fraction(1, 10)
    assert segment.end == Fraction(6, 5)
    assert segment.text == TEXT
    assert segment.quality.confidence == 0.7
    assert segment.quality.average_log_probability == -0.2
    assert segment.quality.compression_ratio == 1.1
    assert segment.quality.no_speech_probability == 0.05
    assert segment.quality.temperature == 0
    assert candidate.quality.confidence == 0.8
    assert candidate.quality.language == "vi"
    assert candidate.quality.language_confidence == 0.9
    assert candidate.usage.input_tokens == 10
    assert candidate.usage.output_tokens == 4
    assert candidate.usage.total_tokens == 14
    assert candidate.usage.cost == Fraction(1, 1000)
    assert candidate.usage.audio_seconds == Fraction(2)
    assert candidate.provenance.provider == "openrouter"
    assert candidate.provenance.requested_model == "openai/whisper-large-v3"
    assert candidate.provenance.resolved_model == "upstream/resolved"
    assert candidate.provenance.upstream_provider == "upstream-provider"
    assert dict(candidate.provenance.inference_config) == {
        "language": "vi", "temperature": 0, "response_format": "verbose_json",
        "timestamp_granularity": "segment",
    }
    for obj in (candidate, segment, chunk(), candidate.provenance):
        for sensitive in (candidate.text, TEXT, PRIVATE_AUDIO, SECRET):
            assert sensitive not in repr(obj)
    for obj, field, value in ((candidate, "text", "changed"), (segment, "start", Fraction(1)),
                              (chunk(), "payload", b"changed")):
        with pytest.raises(FrozenInstanceError):
            setattr(obj, field, value)


@pytest.mark.parametrize("text,segments", [("", []), (" \n ", []), ("", [{"start": 0, "end": 1, "text": ""}])])
def test_empty_output_is_valid_provisional_evidence(text, segments):
    candidate = invoke({"text": text, "segments": segments})
    assert candidate.text == ""
    assert candidate.quality.confidence is None
    assert candidate.usage.total_tokens is None
    assert candidate.provenance.resolved_model is None
    assert candidate.provenance.upstream_provider is None


@pytest.mark.parametrize("data", [
    {}, [], {"text": TEXT}, {"text": TEXT, "segments": []},
    {"text": None, "segments": []}, {"text": TEXT, "segments": None},
    *[{"text": TEXT, "segments": [segment]} for segment in [
        {}, {"start": 0, "text": TEXT}, {"end": 1, "text": TEXT},
        {"start": 0, "end": 1}, {"start": True, "end": 1, "text": TEXT},
        {"start": "0", "end": 1, "text": TEXT},
        {"start": -0.1, "end": 1, "text": TEXT},
        {"start": 1.1, "end": 1, "text": TEXT},
        {"start": 0, "end": 0, "text": TEXT},
        {"start": 0, "end": 2.01, "text": TEXT},
    ]],
    {"text": TEXT, "segments": [{"start": 0, "end": 1, "text": TEXT},
                                 {"start": 0.9, "end": 2, "text": TEXT}]},
    {"text": TEXT, "segments": [{"start": 1, "end": 2, "text": TEXT},
                                 {"start": 0, "end": 1, "text": TEXT}]},
])
def test_invalid_successful_output_is_sanitized(data):
    with pytest.raises(AsrError) as caught:
        invoke(data)
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("body", [b"private-provider-diagnostic", b'{"text":"private-provider-diagnostic","segments":[{"start":NaN,"end":1,"text":"x"}]}',
                                      b'{"text":"x","segments":[{"start":0,"end":Infinity,"text":"x"}]}'])
def test_malformed_json_and_nonfinite_timing(body):
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=body))) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe(chunk())
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("field,value", [
    ("confidence", -0.1), ("confidence", 1.1), ("confidence", True),
    ("language_probability", "0.9"), ("language_probability", 1.1),
    ("language", []), ("model", {}), ("provider", []),
    ("usage", []), ("usage", {"total_tokens": 1.5}),
    ("usage", {"input_tokens": -1}), ("usage", {"output_tokens": True}),
    ("usage", {"cost": -1}), ("usage", {"seconds": "2"}),
])
def test_invalid_optional_metadata(field, value):
    data = output()
    data[field] = value
    with pytest.raises(AsrError) as caught:
        invoke(data)
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("field,value", [
    ("avg_logprob", "bad"), ("avg_logprob", float("inf")), ("avg_logprob", 0.1),
    ("compression_ratio", -1), ("no_speech_prob", 1.1),
    ("temperature", -0.1), ("temperature", 1.1), ("confidence", False),
])
def test_invalid_segment_quality(field, value):
    data = output()
    data["segments"][0][field] = value
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, content=json.dumps(data).encode()),
    )) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe(chunk())
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("status,category", [
    (401, AsrErrorCategory.AUTHENTICATION), (403, AsrErrorCategory.AUTHENTICATION),
    (429, AsrErrorCategory.RATE_LIMIT), (408, AsrErrorCategory.TIMEOUT),
    (504, AsrErrorCategory.TIMEOUT), (524, AsrErrorCategory.TIMEOUT),
    (413, AsrErrorCategory.RESOURCE), (400, AsrErrorCategory.PROVIDER),
    (500, AsrErrorCategory.PROVIDER), (302, AsrErrorCategory.PROVIDER),
])
def test_http_failures_do_not_retry_redirect_or_leak(status, category, caplog):
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(status, text=f"private-provider-diagnostic {SECRET} {TEXT}",
                              headers={"Location": "https://untrusted.invalid", "Retry-After": "0"})

    with httpx.Client(transport=httpx.MockTransport(handle), follow_redirects=True) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe(chunk())
    assert len(calls) == 1
    assert_sanitized(caught.value, category)
    assert TEXT not in caplog.text
    assert SECRET not in caplog.text


@pytest.mark.parametrize("failure,category", [
    (httpx.ReadTimeout, AsrErrorCategory.TIMEOUT),
    (httpx.ConnectTimeout, AsrErrorCategory.TIMEOUT),
    (httpx.ConnectError, AsrErrorCategory.TRANSPORT),
    (httpx.RemoteProtocolError, AsrErrorCategory.TRANSPORT),
])
def test_transport_failures_discard_exception_context(failure, category):
    calls = []

    def handle(request):
        calls.append(request)
        raise failure(f"private-provider-diagnostic {SECRET} {TEXT}", request=request)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe(chunk())
    assert len(calls) == 1
    assert_sanitized(caught.value, category)


def test_oversized_response_is_bounded_and_closed():
    class OversizedStream(httpx.SyncByteStream):
        closed = False
        yielded = 0

        def __iter__(self):
            for _ in range(100):
                self.yielded += 1
                yield b"x" * (1024 * 1024)

        def close(self):
            self.closed = True

    stream = OversizedStream()
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, stream=stream),
    )) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe(chunk())
    assert stream.closed
    assert stream.yielded <= 5
    assert_sanitized(caught.value, AsrErrorCategory.RESOURCE)


@pytest.mark.parametrize("overrides,category", [
    ({"payload": b""}, AsrErrorCategory.VALIDATION),
    ({"payload": bytearray(AUDIO)}, AsrErrorCategory.VALIDATION),
    ({"chunk_id": ""}, AsrErrorCategory.VALIDATION),
    ({"duration": Fraction(0)}, AsrErrorCategory.VALIDATION),
    ({"duration": Fraction(-1)}, AsrErrorCategory.VALIDATION),
    ({"duration": 2.0}, AsrErrorCategory.VALIDATION),
    ({"payload": b"x" * (len(AUDIO) + 1)}, AsrErrorCategory.RESOURCE),
])
def test_local_input_rejection_precedes_network(overrides, category):
    calls = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: calls.append(request))) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(audio_asr_max_payload_bytes=len(AUDIO)), client).transcribe(chunk(**overrides))
    assert not calls
    assert_sanitized(caught.value, category)


@pytest.mark.parametrize("key", [None, "", "   ", "bad\nheader"])
def test_missing_or_invalid_credentials_fail_only_on_invocation(key):
    config = settings().model_copy(update={"openrouter_api_key": None})
    if key is not None:
        from pydantic import SecretStr
        config = config.model_copy(update={"openrouter_api_key": SecretStr(key)})
    calls = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: calls.append(request))) as client:
        adapter = OpenRouterWhisperAdapter(config, client)
        with pytest.raises(AsrError) as caught:
            adapter.transcribe(chunk())
    assert not calls
    assert_sanitized(caught.value, AsrErrorCategory.AUTHENTICATION)


@pytest.mark.parametrize("usage", [None, {}, {"seconds": 0, "cost": 0},
    {"seconds": 9.2, "total_tokens": 113, "input_tokens": 83, "output_tokens": 30, "cost": 0.000508},
    {"seconds": 6.4, "cost": 0.000178}, {"input_tokens": 83, "output_tokens": 30},
])
def test_documented_optional_usage_never_infers_billing(usage):
    # STT guide examples: usage need not agree with this short invented fixture.
    data = output()
    data["duration"] = 2
    if usage is not None:
        data["usage"] = usage
    candidate = invoke(data)
    assert candidate.quality.duration_seconds == 2
    assert candidate.usage.reported is (usage is not None)
    for source, target in (("seconds", "audio_seconds"), ("cost", "cost"),
                           ("input_tokens", "input_tokens"), ("output_tokens", "output_tokens"),
                           ("total_tokens", "total_tokens")):
        expected = (usage or {}).get(source)
        assert getattr(candidate.usage, target) == (None if expected is None else Fraction(str(expected)))


@pytest.mark.parametrize("usage", [
    {"seconds": True}, {"seconds": -1}, {"input_tokens": "83"}, {"output_tokens": 1.0},
    {"cost": "0.1"}, {"cost": float("inf")}, {"seconds": float("nan")},
    {"input_tokens": 83, "output_tokens": 30, "total_tokens": 112},
    {"input_tokens": 83, "total_tokens": 82},
    {"output_tokens": 30, "total_tokens": 29},
])
def test_malformed_or_contradictory_documented_usage(usage):
    with pytest.raises(AsrError) as caught:
        invoke({**output(), "usage": usage})
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("extra", [
    {"task": "translate"}, {"error": {"message": TEXT}}, {"duration": True},
    {"duration": -1}, {"text": ""}, {"text": "bad\x00text"}, {"text": "bad\ud800"},
    {"segments": [{"start": 0, "end": 1, "text": ""}]},
])
def test_unusable_provider_results_fail_closed(extra):
    with pytest.raises(AsrError) as caught:
        invoke({**output(), **extra})
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


def test_duplicate_response_properties_are_rejected():
    raw = b'{"text":"x","segments":[],"segments":[{"start":0,"end":1,"text":"x"}]}'
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=raw))) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe(chunk())
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


def test_documented_verbose_response_preserves_real_segments():
    # STT guide verbose example, with speaker fields intentionally outside this module.
    data = {"task": "transcribe", "language": "en", "duration": 6.4,
            "text": "Hello there. Hi, how are you?", "segments": [
                {"id": 0, "start": 0.0, "end": 1.2, "text": "Hello there.", "speaker": 0},
                {"id": 1, "start": 1.5, "end": 3.1, "text": "Hi, how are you?", "speaker": 1},
            ], "usage": {"seconds": 6.4, "cost": 0.000178}}
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=data))) as client:
        result = OpenRouterWhisperAdapter(settings(), client).transcribe(chunk(duration=Fraction(32, 5)))
    assert [(s.start, s.end) for s in result.segments] == [(0, Fraction(6, 5)), (Fraction(3, 2), Fraction(31, 10))]
    assert result.usage.audio_seconds == result.quality.duration_seconds == Fraction(32, 5)
    assert result.provenance.resolved_model is None  # No invented upstream identity.


def test_extreme_numeric_exponents_reject_before_rational_expansion():
    raw = b'{"text":"","segments":[],"usage":{"cost":1e1000}}'
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=raw))) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe(chunk())
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("end", [2, 2.001, 2.0040615, 2.005])
def test_final_end_rounding_tolerance_clamps_exactly_to_request_duration(end):
    data = output()
    data["segments"].append({"start": 1.3, "end": end, "text": TEXT})
    result = invoke(data)
    assert result.segments[0].end == Fraction(6, 5)
    assert result.segments[1].start == Fraction(13, 10)
    assert result.segments[1].end == chunk().duration
    assert [segment.text for segment in result.segments] == [TEXT, TEXT]


@pytest.mark.parametrize("bounds", [
    [(0, 2.0050001)],  # Just above the exact 5 ms limit.
    [(-0.000001, 2.001)],
    [(2.002, 2.001)],
    [(0, 1.5), (1.49999, 2.001)],
    [(0, 2.001), (2.001, 2.004)],  # Non-final overrun, even if both are small.
    [(0, 2.001), (1, 1.5)],  # Non-final overrun with reversed sequence.
    [(2, 2.001)],  # Clamping would collapse the interval.
    [(2.0001, 2.001)],  # Clamping would reverse the interval.
])
def test_end_tolerance_preserves_fail_closed_original_and_effective_bounds(bounds):
    data = {"text": TEXT, "segments": [
        {"start": start, "end": end, "text": TEXT} for start, end in bounds
    ]}
    with pytest.raises(AsrError) as caught:
        invoke(data)
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


def test_decimal_timestamps_normalize_without_float_conversion():
    data = {"text": TEXT, "segments": [
        {"start": Decimal("0.00003125"), "end": Decimal("1.23456789"), "text": TEXT},
    ]}
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("unexpected request"))) as client:
        result = OpenRouterWhisperAdapter(settings(), client)._normalize(data, chunk())
    assert result.segments[0].start == Fraction(1, 32000)
    assert result.segments[0].end == Fraction(123456789, 100000000)


@pytest.mark.parametrize("duration,end", [("19.154", "19.16"), ("2.001", "2.02"), ("2.013", "2.02")])
def test_final_whisper_timestamp_tick_preserves_all_segments_and_exact_source_end(duration, end):
    audio = chunk(duration=Fraction(duration))
    data = {"text": TEXT, "segments": [
        {"start": 0, "end": 1, "text": TEXT},
        {"start": 1, "end": Decimal(end), "text": TEXT},
    ]}
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("unexpected network"))) as client:
        result = OpenRouterWhisperAdapter(settings(), client)._normalize(data, audio)
    assert len(result.segments) == 2
    assert result.segments[0].end == 1
    assert result.segments[-1].end == Fraction(duration)
    assert [s.text for s in result.segments] == [TEXT, TEXT]


@pytest.mark.parametrize("end", ["19.17", "19.18", "19.160001"])
def test_final_tick_repair_does_not_accept_non_quantized_or_extra_ticks(end):
    data = {"text": TEXT, "segments": [{"start": 0, "end": Decimal(end), "text": TEXT}]}
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("unexpected network"))) as client:
        with pytest.raises(ValueError):
            OpenRouterWhisperAdapter(settings(), client)._normalize(data, chunk(duration=Fraction("19.154")))


def test_mocked_whisper_off_grid_and_final_overrun_translate_without_losing_repetition(caplog):
    texts = ["Hello anh Hiếu nha!", "Hello anh Hiếu nha!", "Ờ, mình bắt đầu nhé."]
    data = {
        "task": "transcribe", "text": " ".join(texts), "language": "vi",
        "model": "openai/whisper-large-v3", "provider": "synthetic-provider",
        "duration": 2.0040615,
        "usage": {"seconds": 2.0040615, "cost": 0.000178},
        "segments": [
            {"start": 0.00003125, "end": 0.500023, "text": texts[0]},
            {"start": 0.500024, "end": 1.00009, "text": texts[1]},
            {"start": 1.0001, "end": 2.0040615, "text": texts[2]},
        ],
    }
    result = invoke(data)
    planned = AsrChunk(
        "chunk-1", 1, SampleInterval(18000, 46000), SampleInterval(16000, 48000),
        ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH,
        ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH,
    )
    translated = _translate_candidate(result, planned)
    assert [item.interval for item in translated] == [
        SampleInterval(16000, 24000), SampleInterval(24000, 32001), SampleInterval(32002, 48000),
    ]
    assert [item.segment.text for item in translated] == texts
    assert all(item.segment is segment for item, segment in zip(translated, result.segments, strict=True))
    assert result.text == data["text"]
    assert result.segments[-1].end == Fraction(2)
    assert result.quality.duration_seconds == result.usage.audio_seconds == Fraction("2.0040615")
    assert result.usage.cost == Fraction("0.000178")
    assert result.quality.language == "vi"
    assert result.provenance.requested_model == result.provenance.resolved_model == "openai/whisper-large-v3"
    assert result.provenance.upstream_provider == "synthetic-provider"
    assert not caplog.records


def invoke_v2(data, *, mode=AsrTimestampMode.SEGMENT_AND_WORD):
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=data))) as client:
        return OpenRouterWhisperAdapter(settings(), client).transcribe_request(
            AsrTranscriptionRequest(chunk(), mode),
        )


def word_output():
    return {"text": "Ừ, ừ, mình họp.", "segments": [
        {"start": 0.00003125, "end": 1.23456789, "text": "Ừ, ừ, mình họp."},
    ], "words": [
        {"start": 0.00003125, "end": 0.1, "word": "Ừ,"},
        {"start": 0.1, "end": 0.2, "word": "ừ,"},
        {"start": 0.200001, "end": 0.5, "word": "mình"},
        {"start": 0.5, "end": 1.23456789, "word": "họp."},
    ]}


def test_legacy_method_delegates_to_v2_segment_request_once(monkeypatch):
    calls, delegated = [], []
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(200, json=output()),
    )) as client:
        adapter = OpenRouterWhisperAdapter(settings(), client)
        original = adapter.transcribe_request

        def record(request):
            delegated.append(request)
            return original(request)

        monkeypatch.setattr(adapter, "transcribe_request", record)
        audio = chunk()
        result = adapter.transcribe(audio)
    assert len(calls) == len(delegated) == 1
    assert delegated[0].audio is audio
    assert delegated[0].timestamp_mode is AsrTimestampMode.SEGMENT
    assert result.words is None


def test_word_request_uses_repeated_fields_no_routing_controls_or_direct_groq(caplog):
    calls = []

    def handle(request):
        calls.append(request)
        assert request.method == "POST"
        assert str(request.url) == "https://openrouter.ai/api/v1/audio/transcriptions"
        assert not request.url.query
        assert set(request.headers) <= {
            "host", "accept", "accept-encoding", "connection", "user-agent",
            "authorization", "content-length", "content-type",
        }
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode() + request.read(),
        )
        parts = list(message.iter_parts())
        names = [part.get_param("name", header="content-disposition") for part in parts]
        assert sorted(names) == sorted([
            "file", "model", "language", "temperature", "response_format",
            "timestamp_granularities[]", "timestamp_granularities[]",
        ])
        granularities = [part.get_payload(decode=True).decode() for part, name in zip(parts, names)
                         if name == "timestamp_granularities[]"]
        assert granularities == ["segment", "word"]
        # Dynamic upstream selection needs no provider options, chat routing
        # controls, custom headers or alternate endpoints.
        return httpx.Response(200, json=word_output())

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = OpenRouterWhisperAdapter(settings(), client).transcribe_request(
            AsrTranscriptionRequest(chunk(), AsrTimestampMode.SEGMENT_AND_WORD),
        )
    assert len(calls) == 1
    assert result.text == "Ừ, ừ, mình họp."
    assert result.words[0] == AsrWord(Fraction(1, 32000), Fraction(1, 10), "Ừ,")
    assert result.words[-1].end == Fraction(123456789, 100000000)
    assert [word.text for word in result.words] == ["Ừ,", "ừ,", "mình", "họp."]
    assert result.provenance.upstream_provider is None
    assert dict(result.provenance.inference_config)["timestamp_granularity"] == "segment-and-word"
    assert not caplog.records


@pytest.mark.parametrize("words", [
    None, {}, "words", [], [None], [{}],
    [{"start": 0, "end": 1, "word": ""}],
    [{"start": 0, "end": 1, "word": " \n "}],
    [{"start": 0, "end": 1, "word": None}],
    [{"start": 0, "end": 1, "word": "bad\ud800"}],
    [{"start": 0, "end": 1, "word": "bad\x00word"}],
    *[[{"start": start, "end": end, "word": TEXT}] for start, end in [
        (-0.1, 1), (1, 1), (1.1, 1), (0, 2.00001), (0, float("inf")),
        (float("nan"), 1), (True, 1), ("0", 1), (0, 1e200),
    ]],
    [{"start": 0, "end": 1, "word": TEXT}, {"start": 0.9, "end": 1.5, "word": TEXT}],
    [{"start": 1, "end": 2, "word": TEXT}, {"start": 0, "end": 1, "word": TEXT}],
])
def test_requested_word_evidence_fails_closed(words):
    data = {**output(), "words": words}
    # json.dumps deliberately allows nonfinite constants to test the JSON guard.
    with httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, content=json.dumps(data).encode()),
    )) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe_request(
                AsrTranscriptionRequest(chunk(), AsrTimestampMode.SEGMENT_AND_WORD),
            )
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


def test_missing_word_key_cannot_downgrade_requested_evidence():
    with pytest.raises(AsrError) as caught:
        invoke_v2(output())
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


def test_empty_word_array_is_valid_empty_evidence_not_silence_verification():
    result = invoke_v2({"text": "", "segments": [], "words": []})
    assert result.words == ()
    assert result.quality.confidence is None
    with pytest.raises(AsrError) as caught:
        invoke_v2({"text": "", "segments": [], "words": [{"start": 0, "end": 1, "word": TEXT}]})
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


def test_unrequested_word_evidence_is_not_promoted_or_used_to_infer_upstream():
    result = invoke_v2(word_output(), mode=AsrTimestampMode.SEGMENT)
    assert result.words is None
    assert result.provenance.upstream_provider is None


def test_word_additional_metadata_is_not_retained_in_evidence_or_provenance(caplog):
    data = word_output()
    data["provider_options"] = {"groq": {"prompt": "private-provider-diagnostic"}}
    data["words"][0].update(speaker="private-provider-diagnostic", confidence=0.9,
                            diagnostic=f"{TEXT} {SECRET} {PRIVATE_AUDIO}")
    result = invoke_v2(data)
    assert result.words[0].text == "Ừ,"
    assert result.provenance.upstream_provider is None
    assert "private-provider-diagnostic" not in repr(result)
    assert "private-provider-diagnostic" not in repr(result.provenance)
    assert not caplog.records


@pytest.mark.parametrize("provider_metadata", [
    {}, {"provider": None}, {"provider": "DeepInfra"}, {"provider": "Groq"},
    {"provider": "Together"},
], ids=["missing", "null", "DeepInfra", "Groq", "Together"])
@pytest.mark.parametrize("legacy", [False, True], ids=["v2", "legacy"])
def test_dynamic_routing_accepts_valid_evidence_and_preserves_actual_upstream(provider_metadata, legacy):
    data = {**word_output(), **provider_metadata}
    calls = []
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(200, json=data),
    )) as client:
        adapter = OpenRouterWhisperAdapter(settings(), client)
        result = (adapter.transcribe(chunk()) if legacy else adapter.transcribe_request(
            AsrTranscriptionRequest(chunk(), AsrTimestampMode.SEGMENT_AND_WORD),
        ))
    assert len(calls) == 1
    assert result.text == data["text"]
    assert result.segments[0].text == data["segments"][0]["text"]
    assert result.provenance.upstream_provider == provider_metadata.get("provider")
    assert (result.words is None) is legacy


@pytest.mark.parametrize("transcription_request", [
    None, {}, chunk(), AsrTranscriptionRequest(None),
    AsrTranscriptionRequest(chunk(), "segment"),
    AsrTranscriptionRequest(chunk(), "word"),
])
def test_invalid_v2_request_is_local_validation_failure(transcription_request):
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("network I/O"))) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe_request(transcription_request)
    assert_sanitized(caught.value, AsrErrorCategory.VALIDATION)


@pytest.mark.parametrize("capability_changes", [
    {"response_format": "json"}, {"timestamp_modes": (AsrTimestampMode.SEGMENT,)},
])
def test_unsupported_response_or_timestamp_capability_rejected_locally(capability_changes):
    class RestrictedAdapter(OpenRouterWhisperAdapter):
        @property
        def capabilities(self):
            return replace(super().capabilities, **capability_changes)

    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("network I/O"))) as client:
        with pytest.raises(AsrError) as caught:
            RestrictedAdapter(settings(), client).transcribe_request(
                AsrTranscriptionRequest(chunk(), AsrTimestampMode.SEGMENT_AND_WORD),
            )
    assert_sanitized(caught.value, AsrErrorCategory.VALIDATION)


@pytest.mark.parametrize("overrides", [
    {"audio_asr_model": "openai/whisper-large-v3-turbo"},
    {"audio_asr_model": "other/model"}, {"audio_asr_language": "en"},
])
def test_locked_model_and_language_fail_before_inference(overrides):
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("network I/O"))) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(**overrides), client).transcribe(chunk())
    assert_sanitized(caught.value, AsrErrorCategory.VALIDATION)


@pytest.mark.parametrize("payload,duration", [
    (PRIVATE_AUDIO.encode(), Fraction(2)), (AUDIO[:-1], Fraction(2)),
    (AUDIO + b"undeclared", Fraction(2)), (AUDIO, Fraction(2) + Fraction(1, 16000)),
    (AUDIO[:40] + (64_001).to_bytes(4, "little") + AUDIO[44:] + b"x", Fraction(2)),
    (AUDIO[:4] + (len(AUDIO) - 7).to_bytes(4, "little") + AUDIO[8:40]
     + (64_001).to_bytes(4, "little") + AUDIO[44:] + b"x", Fraction(2)),
])
def test_strict_wav_and_exact_duration_rejection(payload, duration):
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("network I/O"))) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe(chunk(payload=payload, duration=duration))
    assert_sanitized(caught.value, AsrErrorCategory.VALIDATION)


@pytest.mark.parametrize("payload,duration", [
    pytest.param(wav_payload(rate=8000), Fraction(2), id="WAV-02-8kHz"),
    pytest.param(wav_payload(rate=48000), Fraction(2), id="WAV-03-48kHz"),
    pytest.param(wav_payload(channels=2), Fraction(2), id="WAV-04-stereo"),
    pytest.param(wav_payload(sample_width=1), Fraction(2), id="WAV-05-8bit"),
    pytest.param(wav_payload(sample_width=3), Fraction(2), id="WAV-06-24bit"),
    pytest.param(wav_payload(sample_width=4), Fraction(2), id="WAV-07-32bit"),
    pytest.param(AUDIO[:20] + b"\x03\x00" + AUDIO[22:], Fraction(2), id="WAV-08-float-encoding"),
    pytest.param(AUDIO[:20] + b"\x06\x00" + AUDIO[22:], Fraction(2), id="WAV-08-alaw-encoding"),
    pytest.param(AUDIO, Fraction(2) + Fraction(1, 16000), id="WAV-09-duration-mismatch"),
    # Keep RIFF size accurate so rejection must detect physically missing PCM,
    # rather than merely an inconsistent outer container length.
    pytest.param(AUDIO[:4] + (len(AUDIO) - 10).to_bytes(4, "little") + AUDIO[8:-2],
                 Fraction(2), id="WAV-10-truncated-PCM"),
    pytest.param(b"RIFX" + AUDIO[4:], Fraction(2), id="WAV-11-invalid-RIFF"),
    pytest.param(AUDIO[:8] + b"FAIL" + AUDIO[12:], Fraction(2), id="WAV-11-invalid-WAVE"),
    pytest.param(wav_payload(Fraction(0)), Fraction(2), id="WAV-12-zero-frames"),
])
def test_non_normalized_or_invalid_wav_is_rejected_before_http(payload, duration):
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=output())

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(), client).transcribe(chunk(payload=payload, duration=duration))
    assert len(calls) == 0
    assert_sanitized(caught.value, AsrErrorCategory.VALIDATION)


def test_normalized_wav_retains_multipart_evidence_provenance_and_usage():
    calls = []
    data = {**output(), "model": "openai/whisper-large-v3", "provider": "DeepInfra",
            "usage": {"seconds": 2, "cost": 0.001}}

    def handle(request):
        calls.append(request)
        assert str(request.url) == "https://openrouter.ai/api/v1/audio/transcriptions"
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode() + request.read(),
        )
        parts = list(message.iter_parts())
        names = [part.get_param("name", header="content-disposition") for part in parts]
        assert names == ["file", "model", "language", "temperature", "response_format",
                         "timestamp_granularities[]"]
        assert parts[0].get_filename() == "chunk.wav"
        assert parts[0].get_content_type() == "audio/wav"
        assert parts[0].get_payload(decode=True) == AUDIO
        with wave.open(io.BytesIO(parts[0].get_payload(decode=True)), "rb") as reader:
            assert reader.getparams() == (1, 2, 16000, 32000, "NONE", "not compressed")
        assert [part.get_payload(decode=True).decode() for part in parts[1:]] == [
            "openai/whisper-large-v3", "vi", "0", "verbose_json", "segment",
        ]
        return httpx.Response(200, json=data)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = OpenRouterWhisperAdapter(settings(), client).transcribe(chunk())
    assert len(calls) == 1
    assert result.text == result.segments[0].text == TEXT
    assert result.segments[0].start == Fraction(1, 10)
    assert result.segments[0].end == Fraction(6, 5)
    assert result.provenance.provider == "openrouter"
    assert result.provenance.requested_model == result.provenance.resolved_model == "openai/whisper-large-v3"
    assert result.provenance.upstream_provider == "DeepInfra"
    assert result.usage.reported is True
    assert result.usage.audio_seconds == Fraction(2)
    assert result.usage.cost == Fraction(1, 1000)


def test_documented_decimal_upload_limit_precedes_network_and_audio_parsing():
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("network I/O"))) as client:
        adapter = OpenRouterWhisperAdapter(settings(), client)
        assert adapter.capabilities.effective_payload_limit == 25_000_000
        with pytest.raises(AsrError) as caught:
            adapter.transcribe(chunk(payload=b"x" * 25_000_001))
    assert_sanitized(caught.value, AsrErrorCategory.RESOURCE)


def test_exact_configured_payload_bound_is_eligible():
    result = invoke(output(), audio_asr_max_payload_bytes=len(AUDIO))
    assert result.text == TEXT


def test_existing_chunk_execution_calls_legacy_adapter_with_real_wav(tmp_path):
    path = tmp_path / "synthetic.wav"
    path.write_bytes(AUDIO)
    planned = AsrChunk(
        "chunk-1", 1, SampleInterval(0, 32000), SampleInterval(0, 32000),
        ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH, ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH,
    )
    calls = []
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: calls.append(request) or httpx.Response(200, json=output()),
    )) as client:
        result = _execute_chunk(planned, SimpleNamespace(path=path, sample_count=32000),
                                OpenRouterWhisperAdapter(settings(), client), len(AUDIO))
    assert len(calls) == 1
    assert result.failure is None
    assert result.candidate.chunk_id == "chunk-1"
    assert result.candidate.words is None
    assert result.timeline_segments[0].interval == SampleInterval(1600, 19200)
