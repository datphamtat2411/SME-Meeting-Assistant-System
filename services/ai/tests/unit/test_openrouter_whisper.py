import json
import os
import traceback
from dataclasses import FrozenInstanceError
from email import policy
from email.parser import BytesParser
from fractions import Fraction

import httpx
import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
from sme_meeting_ai.transcription import (
    AsrAudioChunk,
    AsrCandidate,
    AsrError,
    AsrErrorCategory,
)

SECRET = "test-only-private-key"
AUDIO = b"test-only-private-audio"
TEXT = "Nội dung riêng tư"


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    monkeypatch.setattr(os, "environ", {})


def settings(**overrides):
    return Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        OPENROUTER_API_KEY=SECRET, **overrides,
    )


def chunk(**overrides):
    return AsrAudioChunk(**{"chunk_id": "chunk-1", "payload": AUDIO,
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
    for sensitive in (SECRET, AUDIO.decode(), TEXT, "private-provider-diagnostic"):
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
    for sensitive in (SECRET, AUDIO.decode(), TEXT):
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
        "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14,
                  "cost": 0.001, "audio_seconds": 2},
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
        for sensitive in (candidate.text, TEXT, AUDIO.decode(), SECRET):
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
    ("usage", {"prompt_tokens": -1}), ("usage", {"completion_tokens": True}),
    ("usage", {"cost": -1}), ("usage", {"audio_seconds": "2"}),
])
def test_invalid_optional_metadata(field, value):
    data = output()
    data[field] = value
    with pytest.raises(AsrError) as caught:
        invoke(data)
    assert_sanitized(caught.value, AsrErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("field,value", [
    ("avg_logprob", "bad"), ("avg_logprob", float("inf")),
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
    ({"payload": b"x" * 65}, AsrErrorCategory.RESOURCE),
])
def test_local_input_rejection_precedes_network(overrides, category):
    calls = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: calls.append(request))) as client:
        with pytest.raises(AsrError) as caught:
            OpenRouterWhisperAdapter(settings(audio_asr_max_payload_bytes=64), client).transcribe(chunk(**overrides))
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
