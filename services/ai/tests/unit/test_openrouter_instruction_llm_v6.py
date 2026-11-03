"""Strict OpenRouter V6 HTTP contracts using only in-memory transports."""

import importlib
import json
import traceback
from dataclasses import replace
from fractions import Fraction

import httpx
import pytest

from sme_meeting_ai.providers.openrouter_instruction_llm_v6 import (
    OpenRouterInstructionLlmV6Adapter,
)
from sme_meeting_ai.transcription.correction import (
    CorrectionErrorCategory,
    CorrectionUsage,
)
from sme_meeting_ai.transcription.correction_v6 import CORRECTION_V6_JSON_SCHEMA
from sme_meeting_ai.transcription.correction_v6_generation import (
    V6_SYSTEM_PROMPT,
    V6CorrectionRequest,
    V6GenerationError,
    V6GenerationReason,
    generate_v6_proposal,
    serialize_v6_meeting,
)

from .test_correction_v6 import PRIVATE, meeting, offline_environment
from .test_correction_v6_generation import MODEL, expected_payload, settings

__all__ = ["offline_environment"]

SECRET = "test-only-v6-private-key"
DIAGNOSTIC = "private-provider-diagnostic"


def configuration(**overrides):
    return settings(**{"OPENROUTER_API_KEY": SECRET, **overrides})


def request():
    return V6CorrectionRequest(V6_SYSTEM_PROMPT, serialize_v6_meeting(meeting((PRIVATE,))), MODEL, 32768, 0, None)


def output(**overrides):
    return {"model": "vendor/resolved", "choices": [{
        "message": {"role": "assistant", "content": '{"edits":[]}'}, "finish_reason": "stop",
    }], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}, **overrides}


def invoke(response, **overrides):
    with httpx.Client(transport=httpx.MockTransport(lambda r: response)) as client:
        return OpenRouterInstructionLlmV6Adapter(configuration(**overrides), client).complete(request())


def sanitized(error, category, reason):
    assert type(error) is V6GenerationError
    assert error.category is category and error.reason is reason
    assert error.__context__ is None and error.__cause__ is None
    rendered = repr(error) + str(error) + "".join(traceback.format_exception(error))
    for sensitive in (SECRET, PRIVATE, DIAGNOSTIC):
        assert sensitive not in rendered


@pytest.mark.parametrize("effort,temperature,effective", [
    (None, 0, 0), (None, None, None), ("none", 0.4, 0.4), ("none", None, None),
    ("low", 0.8, None), ("medium", 0, None), ("high", None, None),
])
def test_exact_schema_request_authentication_routing_and_reasoning(effort, temperature, effective, caplog):
    calls = []
    config = configuration(transcript_correction_reasoning_effort=effort,
                           transcript_correction_temperature=temperature,
                           transcript_correction_timeout_seconds=2.5)
    completion = replace(request(), temperature=effective, reasoning_effort=effort)

    def handle(r):
        calls.append(r)
        assert str(r.url) == "https://openrouter.ai/api/v1/chat/completions"
        assert r.headers["authorization"] == f"Bearer {SECRET}"
        assert r.extensions["timeout"] == dict.fromkeys(("connect", "read", "write", "pool"), 2.5)
        body = json.loads(r.content)
        assert body == expected_payload(completion)
        assert body["response_format"]["json_schema"]["schema"] == CORRECTION_V6_JSON_SCHEMA
        assert "plugins" not in body and "reasoning_effort" not in body
        assert SECRET not in r.content.decode()
        return httpx.Response(200, json=output())

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        response = OpenRouterInstructionLlmV6Adapter(config, client).complete(completion)
    assert len(calls) == 1
    assert response.provider == "openrouter" and response.requested_model == MODEL
    assert response.resolved_model == "vendor/resolved"
    assert response.usage == CorrectionUsage(10, 5, 15)
    assert response.text == '{"edits":[]}'
    assert PRIVATE not in repr(completion) + repr(response) + caplog.text and SECRET not in caplog.text


def test_request_uses_imported_schema_object_without_v53_payload(monkeypatch):
    module = importlib.import_module("sme_meeting_ai.transcription.correction_v6_generation")
    legacy = importlib.import_module("sme_meeting_ai.transcription.correction")
    monkeypatch.setattr(legacy, "_request_payload", lambda *a: pytest.fail("V5.3 payload must not be used"))
    assert module._v6_request_payload(request())["response_format"]["json_schema"]["schema"] is CORRECTION_V6_JSON_SCHEMA
    assert invoke(httpx.Response(200, json=output())).text == '{"edits":[]}'


@pytest.mark.parametrize("status,category", [
    (401, CorrectionErrorCategory.AUTHENTICATION), (403, CorrectionErrorCategory.AUTHENTICATION),
    (408, CorrectionErrorCategory.TIMEOUT), (429, CorrectionErrorCategory.RATE_LIMIT),
    (504, CorrectionErrorCategory.TIMEOUT), (524, CorrectionErrorCategory.TIMEOUT),
    (413, CorrectionErrorCategory.CONTEXT_OVERFLOW), (400, CorrectionErrorCategory.PROVIDER),
    (422, CorrectionErrorCategory.PROVIDER), (500, CorrectionErrorCategory.PROVIDER),
    (302, CorrectionErrorCategory.PROVIDER),
])
def test_http_rejection_never_reads_private_body_retries_or_redirects(status, category):
    class Unread(httpx.SyncByteStream):
        def __iter__(self):
            pytest.fail("rejected provider body must never be read")
            yield b""

    calls = []

    def handle(r):
        calls.append(r)
        return httpx.Response(status, headers={"location": "https://example.com"}, stream=Unread())

    with httpx.Client(transport=httpx.MockTransport(handle), follow_redirects=True) as client:
        with pytest.raises(V6GenerationError) as caught:
            OpenRouterInstructionLlmV6Adapter(configuration(), client).complete(request())
    sanitized(caught.value, category, V6GenerationReason.HTTP_REQUEST_REJECTED)
    assert caught.value.http_status == status and len(calls) == 1


def test_schema_unsupported_400_is_explicit_failure_without_json_mode_fallback():
    calls = []

    def handle(r):
        calls.append(json.loads(r.content))
        return httpx.Response(400, json={"error": {"message": DIAGNOSTIC + " schema unsupported"}})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        outcome = generate_v6_proposal(meeting(), OpenRouterInstructionLlmV6Adapter(configuration(), client), configuration())
    assert outcome.failure.category is CorrectionErrorCategory.PROVIDER
    assert outcome.failure.reason is V6GenerationReason.HTTP_REQUEST_REJECTED
    assert outcome.failure.http_status == 400 and outcome.failure.attempts == len(calls) == 1
    assert calls[0]["response_format"]["type"] == "json_schema"
    assert calls[0]["response_format"]["json_schema"]["strict"] is True
    assert DIAGNOSTIC not in repr(outcome)


@pytest.mark.parametrize("body,reason", [
    ([], V6GenerationReason.INVALID_PROVIDER_ENVELOPE),
    (output(error={"message": DIAGNOSTIC}), V6GenerationReason.INVALID_PROVIDER_ENVELOPE),
    ({}, V6GenerationReason.INVALID_CHOICES),
    (output(choices=[]), V6GenerationReason.INVALID_CHOICES),
    (output(choices=[{}, {}]), V6GenerationReason.INVALID_CHOICES),
    (output(choices=[None]), V6GenerationReason.INVALID_CHOICES),
    (output(choices=[{"finish_reason": "length", "message": {"role": "assistant", "content": '{"edits":[]}'}}]),
     V6GenerationReason.UNEXPECTED_FINISH_REASON),
    (output(choices=[{"finish_reason": "stop", "message": None}]), V6GenerationReason.INVALID_ASSISTANT_MESSAGE),
    (output(choices=[{"finish_reason": "stop", "message": {"content": "{}"}}]), V6GenerationReason.INVALID_ASSISTANT_MESSAGE),
    (output(choices=[{"finish_reason": "stop", "message": {"role": "user", "content": "{}"}}]),
     V6GenerationReason.INVALID_ASSISTANT_MESSAGE),
    (output(choices=[{"finish_reason": "stop", "message": {"role": "assistant"}}]), V6GenerationReason.EMPTY_ASSISTANT_CONTENT),
    (output(choices=[{"finish_reason": "stop", "message": {"role": "assistant", "content": []}}]),
     V6GenerationReason.EMPTY_ASSISTANT_CONTENT),
    (output(choices=[{"finish_reason": "stop", "message": {"role": "assistant", "content": " \n "}}]),
     V6GenerationReason.EMPTY_ASSISTANT_CONTENT),
    (output(model=PRIVATE), V6GenerationReason.INVALID_MODEL_METADATA),
    (output(model=True), V6GenerationReason.INVALID_MODEL_METADATA),
    (output(usage=[]), V6GenerationReason.INVALID_USAGE),
    (output(usage={"prompt_tokens": True}), V6GenerationReason.INVALID_USAGE),
    (output(usage={"completion_tokens": -1}), V6GenerationReason.INVALID_USAGE),
    (output(usage={"total_tokens": 1.2}), V6GenerationReason.INVALID_USAGE),
    (output(usage={"prompt_tokens": 1000000001}), V6GenerationReason.INVALID_USAGE),
    (output(usage={"completion_tokens_details": []}), V6GenerationReason.INVALID_USAGE),
    (output(usage={"completion_tokens_details": {"reasoning_tokens": False}}), V6GenerationReason.INVALID_USAGE),
    (output(usage={"completion_tokens": 5, "completion_tokens_details": {"reasoning_tokens": 6}}),
     V6GenerationReason.INVALID_USAGE),
])
def test_envelope_failures_have_precise_sanitized_reasons(body, reason):
    with pytest.raises(V6GenerationError) as caught:
        invoke(httpx.Response(200, json=body))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT, reason)


@pytest.mark.parametrize("field,value", [
    ("tool_calls", [{}]), ("function_call", {"name": DIAGNOSTIC}), ("refusal", DIAGNOSTIC),
])
def test_refusals_and_tool_or_function_calls_are_rejected(field, value):
    body = output()
    body["choices"][0]["message"][field] = value
    with pytest.raises(V6GenerationError) as caught:
        invoke(httpx.Response(200, json=body))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT, V6GenerationReason.INVALID_ASSISTANT_MESSAGE)


@pytest.mark.parametrize("body", [
    b"private-provider-diagnostic", b'{"choices":NaN}', b'{"choices":Infinity}',
    b'{"choices":[],"choices":[]}',
    b'{"choices":[{"finish_reason":"stop","finish_reason":"stop"}]}',
])
def test_invalid_provider_json_and_duplicate_keys_are_sanitized(body):
    with pytest.raises(V6GenerationError) as caught:
        invoke(httpx.Response(200, content=body))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT, V6GenerationReason.INVALID_PROVIDER_JSON)


@pytest.mark.parametrize("body", [b"\xff", json.dumps(output(choices=[{
    "finish_reason": "stop", "message": {"role": "assistant", "content": "\ud800"},
}])).encode()])
def test_invalid_unicode_is_distinguished_without_leaking_body(body):
    with pytest.raises(V6GenerationError) as caught:
        invoke(httpx.Response(200, content=body))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT, V6GenerationReason.INVALID_UNICODE)


@pytest.mark.parametrize("usage", [None, {}, {"completion_tokens_details": None}])
def test_missing_optional_usage_preserves_none_instead_of_fabricating_cost(usage):
    response = invoke(httpx.Response(200, json=output(usage=usage, model=None)))
    assert response.usage == CorrectionUsage() and response.resolved_model is None


@pytest.mark.parametrize("value,expected", [(0, Fraction(0)), (2, Fraction(2)), (0.00012345, Fraction(12345, 100000000))])
def test_reported_cost_normalization_is_exact(value, expected):
    response = invoke(httpx.Response(200, json=output(usage={"cost": value})))
    assert response.usage.cost == expected


def test_decimal_cost_precision_is_not_rounded_through_binary_float():
    raw = json.dumps(output(usage={})).replace('"usage": {}', '"usage":{"cost":0.12345678901234567890123456789}')
    response = invoke(httpx.Response(200, content=raw))
    assert response.usage.cost == Fraction(12345678901234567890123456789, 10**29)


@pytest.mark.parametrize("cost", [True, -1, "0.01", DIAGNOSTIC, {}, []])
def test_bad_cost_is_invalid_usage_without_private_diagnostics(cost):
    with pytest.raises(V6GenerationError) as caught:
        invoke(httpx.Response(200, json=output(usage={"cost": cost})))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT, V6GenerationReason.INVALID_USAGE)


def test_reasoning_usage_is_preserved_separately():
    response = invoke(httpx.Response(200, json=output(usage={
        "completion_tokens": 100, "completion_tokens_details": {"reasoning_tokens": 60},
    })))
    assert response.usage.output_tokens == 100 and response.usage.reasoning_tokens == 60


def test_streaming_body_limit_stops_reading_and_closes_response():
    closed = []

    class Body(httpx.SyncByteStream):
        def __iter__(self):
            yield b"x" * 32
            yield b"y" * 32
            pytest.fail("must stop at the byte limit")

        def close(self):
            closed.append(True)

    with pytest.raises(V6GenerationError) as caught:
        invoke(httpx.Response(200, stream=Body()), transcript_correction_max_response_bytes=40)
    sanitized(caught.value, CorrectionErrorCategory.RESOURCE, V6GenerationReason.RESPONSE_SIZE_EXCEEDED)
    assert closed == [True]


@pytest.mark.parametrize("slow_point", ["headers", "chunk", "end"])
def test_total_deadline_covers_headers_chunks_and_empty_or_finished_stream(monkeypatch, slow_point):
    module = importlib.import_module("sme_meeting_ai.providers.openrouter_instruction_llm_v6")
    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])

    class Body(httpx.SyncByteStream):
        def __iter__(self):
            if slow_point == "chunk":
                clock[0] = 121
            yield json.dumps(output()).encode()
            if slow_point == "end":
                clock[0] = 121

    def handle(r):
        if slow_point == "headers":
            clock[0] = 121
        return httpx.Response(200, stream=Body())

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(V6GenerationError) as caught:
            OpenRouterInstructionLlmV6Adapter(configuration(), client).complete(request())
    sanitized(caught.value, CorrectionErrorCategory.TIMEOUT, V6GenerationReason.DEADLINE_EXCEEDED)


@pytest.mark.parametrize("exception,category,reason", [
    (httpx.ReadTimeout, CorrectionErrorCategory.TIMEOUT, V6GenerationReason.DEADLINE_EXCEEDED),
    (httpx.ConnectError, CorrectionErrorCategory.TRANSPORT, V6GenerationReason.TRANSPORT_ERROR),
])
def test_transport_failures_are_unchained_and_do_not_retry(exception, category, reason):
    calls = []

    def handle(r):
        calls.append(r)
        raise exception(DIAGNOSTIC + SECRET + PRIVATE, request=r)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(V6GenerationError) as caught:
            OpenRouterInstructionLlmV6Adapter(configuration(), client).complete(request())
    sanitized(caught.value, category, reason)
    assert len(calls) == 1


@pytest.mark.parametrize("overrides,category,reason", [
    ({"transcript_correction_model": None}, CorrectionErrorCategory.CONFIGURATION, V6GenerationReason.INVALID_CONFIGURATION),
    ({"OPENROUTER_API_KEY": None}, CorrectionErrorCategory.AUTHENTICATION, V6GenerationReason.AUTHENTICATION_FAILED),
    ({"OPENROUTER_API_KEY": "bad key"}, CorrectionErrorCategory.AUTHENTICATION, V6GenerationReason.AUTHENTICATION_FAILED),
    ({"transcript_correction_max_input_tokens": 1}, CorrectionErrorCategory.CONTEXT_OVERFLOW,
     V6GenerationReason.CONTEXT_BUDGET_EXCEEDED),
])
def test_local_rejection_never_makes_http_request(overrides, category, reason):
    with httpx.Client(transport=httpx.MockTransport(lambda r: pytest.fail("must reject locally"))) as client:
        with pytest.raises(V6GenerationError) as caught:
            OpenRouterInstructionLlmV6Adapter(configuration(**overrides), client).complete(request())
    sanitized(caught.value, category, reason)


@pytest.mark.parametrize("mutation", [
    {"model": "other/model"}, {"max_output_tokens": True}, {"max_output_tokens": 32769},
    {"temperature": float("nan")}, {"temperature": True}, {"reasoning_effort": "low"},
    {"system_prompt": ""}, {"transcript_json": None}, {"transcript_json": "null"},
    {"transcript_json": '{"sample_rate_hz":16000,"segments":[],"segments":[]}'},
])
def test_invalid_requests_fail_before_dispatch(mutation):
    with httpx.Client(transport=httpx.MockTransport(lambda r: pytest.fail("invalid request"))) as client:
        with pytest.raises(V6GenerationError) as caught:
            OpenRouterInstructionLlmV6Adapter(configuration(), client).complete(replace(request(), **mutation))
    sanitized(caught.value, CorrectionErrorCategory.VALIDATION, V6GenerationReason.INVALID_REQUEST)


def test_owned_client_is_bounded_environment_isolated_and_closed(monkeypatch):
    original = httpx.Client
    clients = []

    def create(**kwargs):
        assert kwargs == {"timeout": 120, "trust_env": False, "follow_redirects": False}
        client = original(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=output())), **kwargs)
        clients.append(client)
        return client

    monkeypatch.setattr(httpx, "Client", create)
    with OpenRouterInstructionLlmV6Adapter(configuration()) as adapter:
        adapter.complete(request())
    assert len(clients) == 1 and clients[0].is_closed


def test_borrowed_client_remains_open_on_success_and_failure():
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=output()))) as client:
        with OpenRouterInstructionLlmV6Adapter(configuration(), client) as adapter:
            adapter.complete(request())
        assert not client.is_closed
        with OpenRouterInstructionLlmV6Adapter(configuration(OPENROUTER_API_KEY=None), client) as adapter:
            with pytest.raises(V6GenerationError):
                adapter.complete(request())
        assert not client.is_closed
