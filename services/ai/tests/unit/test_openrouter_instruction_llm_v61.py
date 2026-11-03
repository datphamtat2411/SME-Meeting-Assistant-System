"""V6.1 strict-schema transport contracts, exclusively using MockTransport."""

import importlib
import json
from dataclasses import replace
from fractions import Fraction

import httpx
import pytest

from sme_meeting_ai.providers.openrouter_instruction_llm_v6 import (
    OpenRouterInstructionLlmV6Adapter,
)
from sme_meeting_ai.providers.openrouter_instruction_llm_v61 import (
    OpenRouterInstructionLlmV61Adapter,
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
    _v6_request_payload,
    serialize_v6_meeting,
)
from sme_meeting_ai.transcription.correction_v61_generation import (
    V61_SYSTEM_PROMPT,
    generate_v61_proposal,
)

from .test_correction_v6 import PRIVATE, meeting, offline_environment
from .test_correction_v6_generation import MODEL, expected_payload
from .test_openrouter_instruction_llm_v6 import (
    DIAGNOSTIC,
    SECRET,
    configuration,
    output,
    sanitized,
)

__all__ = ["offline_environment"]


def request():
    return V6CorrectionRequest(V61_SYSTEM_PROMPT, serialize_v6_meeting(meeting((PRIVATE,))), MODEL, 32768, 0, None)


def invoke(response, **overrides):
    with httpx.Client(transport=httpx.MockTransport(lambda r: response)) as client:
        return OpenRouterInstructionLlmV61Adapter(configuration(**overrides), client).complete(request())


@pytest.mark.parametrize("effort,temperature,effective", [
    (None, 0, 0), (None, None, None), ("none", 0.4, 0.4), ("none", None, None),
    ("low", 0.8, None), ("medium", 0, None), ("high", None, None),
])
def test_actual_request_has_exact_v61_prompt_schema_configured_model_and_reasoning(effort, temperature, effective, caplog):
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
        assert body["messages"][0] == {"role": "system", "content": V61_SYSTEM_PROMPT}
        assert body["messages"][1]["content"] == completion.transcript_json
        assert body["stream"] is False and body["provider"] == {"require_parameters": True}
        assert body["response_format"] == {"type": "json_schema", "json_schema": {
            "name": "vi-span-edits-v1", "strict": True, "schema": CORRECTION_V6_JSON_SCHEMA,
        }}
        assert "tools" not in body and "plugins" not in body
        return httpx.Response(200, json=output())

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        response = OpenRouterInstructionLlmV61Adapter(config, client).complete(completion)
    assert len(calls) == 1 and response.requested_model == MODEL and response.provider == "openrouter"
    assert response.usage == CorrectionUsage(10, 5, 15)
    assert _v6_request_payload(completion)["response_format"]["json_schema"]["schema"] is CORRECTION_V6_JSON_SCHEMA
    assert PRIVATE not in repr(response) + repr(completion) + caplog.text and SECRET not in caplog.text


@pytest.mark.parametrize("adapter,prompt,allowed", [
    (OpenRouterInstructionLlmV6Adapter, V6_SYSTEM_PROMPT, True),
    (OpenRouterInstructionLlmV6Adapter, V61_SYSTEM_PROMPT, False),
    (OpenRouterInstructionLlmV61Adapter, V61_SYSTEM_PROMPT, True),
    (OpenRouterInstructionLlmV61Adapter, V6_SYSTEM_PROMPT, False),
    (OpenRouterInstructionLlmV61Adapter, "arbitrary", False),
    (OpenRouterInstructionLlmV6Adapter, "arbitrary", False),
])
def test_actual_adapter_dispatch_keeps_both_prompt_identities_sealed(adapter, prompt, allowed):
    calls = []

    def handle(r):
        calls.append(r)
        assert json.loads(r.content)["messages"][0]["content"] == prompt
        return httpx.Response(200, json=output())

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        instance = adapter(configuration(), client)
        if allowed:
            assert instance.complete(replace(request(), system_prompt=prompt)).text == '{"edits":[]}'
        else:
            with pytest.raises(V6GenerationError) as caught:
                instance.complete(replace(request(), system_prompt=prompt))
            sanitized(caught.value, CorrectionErrorCategory.VALIDATION, V6GenerationReason.INVALID_REQUEST)
    assert len(calls) == int(allowed)


@pytest.mark.parametrize("mutation", [
    {"model": "other/model"}, {"max_output_tokens": True}, {"max_output_tokens": 32769},
    {"temperature": float("nan")}, {"temperature": True}, {"reasoning_effort": "medium"},
    {"system_prompt": V61_SYSTEM_PROMPT + " "}, {"transcript_json": None},
    {"transcript_json": "null"}, {"transcript_json": '{"sample_rate_hz":16000,"segments":[],"segments":[]}'},
    {"transcript_json": '{"sample_rate_hz":16000,"segments":[{"segment_id":"foreign"}]}'},
    {"transcript_json": '{"sample_rate_hz":16000,"segments":[{"segment_id":"segment-000000",'
                        '"ordinal":0,"start_sample":0,"end_sample":100,"text":"\\ud800"}]}'},
])
def test_new_prompt_has_no_request_preflight_bypass(mutation):
    with httpx.Client(transport=httpx.MockTransport(lambda r: pytest.fail("preflight must block HTTP"))) as client:
        with pytest.raises(V6GenerationError) as caught:
            OpenRouterInstructionLlmV61Adapter(configuration(), client).complete(replace(request(), **mutation))
    assert caught.value.category is CorrectionErrorCategory.VALIDATION
    assert caught.value.reason in (V6GenerationReason.INVALID_REQUEST, V6GenerationReason.INVALID_UNICODE)
    assert caught.value.__context__ is caught.value.__cause__ is None


@pytest.mark.parametrize("overrides,category,reason", [
    ({"transcript_correction_model": None}, CorrectionErrorCategory.CONFIGURATION, V6GenerationReason.INVALID_CONFIGURATION),
    ({"OPENROUTER_API_KEY": None}, CorrectionErrorCategory.AUTHENTICATION, V6GenerationReason.AUTHENTICATION_FAILED),
    ({"OPENROUTER_API_KEY": "bad key"}, CorrectionErrorCategory.AUTHENTICATION, V6GenerationReason.AUTHENTICATION_FAILED),
    ({"transcript_correction_max_input_tokens": 1}, CorrectionErrorCategory.CONTEXT_OVERFLOW,
     V6GenerationReason.CONTEXT_BUDGET_EXCEEDED),
])
def test_invalid_settings_credentials_and_budget_never_dispatch(overrides, category, reason):
    with httpx.Client(transport=httpx.MockTransport(lambda r: pytest.fail("must fail before HTTP"))) as client:
        with pytest.raises(V6GenerationError) as caught:
            OpenRouterInstructionLlmV61Adapter(configuration(**overrides), client).complete(request())
    sanitized(caught.value, category, reason)


@pytest.mark.parametrize("status,category", [
    (401, CorrectionErrorCategory.AUTHENTICATION), (403, CorrectionErrorCategory.AUTHENTICATION),
    (408, CorrectionErrorCategory.TIMEOUT), (429, CorrectionErrorCategory.RATE_LIMIT),
    (504, CorrectionErrorCategory.TIMEOUT), (524, CorrectionErrorCategory.TIMEOUT),
    (413, CorrectionErrorCategory.CONTEXT_OVERFLOW), (400, CorrectionErrorCategory.PROVIDER),
    (422, CorrectionErrorCategory.PROVIDER), (500, CorrectionErrorCategory.PROVIDER),
    (302, CorrectionErrorCategory.PROVIDER),
])
def test_http_adapter_never_reads_error_bodies_retries_or_follows_redirects(status, category):
    closed, calls = [], []

    class Unread(httpx.SyncByteStream):
        def __iter__(self):
            pytest.fail("private error body must remain unread")
            yield b""

        def close(self):
            closed.append(True)

    def handle(r):
        calls.append(r)
        return httpx.Response(status, headers={"location": "https://example.com"}, stream=Unread())

    with httpx.Client(transport=httpx.MockTransport(handle), follow_redirects=True) as client:
        with pytest.raises(V6GenerationError) as caught:
            OpenRouterInstructionLlmV61Adapter(configuration(), client).complete(request())
    sanitized(caught.value, category, V6GenerationReason.HTTP_REQUEST_REJECTED)
    assert caught.value.http_status == status and len(calls) == 1 and closed == [True]


@pytest.mark.parametrize("body,reason", [
    ([], V6GenerationReason.INVALID_PROVIDER_ENVELOPE),
    (output(error={"message": DIAGNOSTIC}), V6GenerationReason.INVALID_PROVIDER_ENVELOPE),
    (output(choices=[]), V6GenerationReason.INVALID_CHOICES),
    (output(choices=[{}, {}]), V6GenerationReason.INVALID_CHOICES),
    (output(choices=[{"finish_reason": "length", "message": {"role": "assistant", "content": "{}"}}]),
     V6GenerationReason.UNEXPECTED_FINISH_REASON),
    (output(choices=[{"finish_reason": "stop", "message": {"role": "user", "content": "{}"}}]),
     V6GenerationReason.INVALID_ASSISTANT_MESSAGE),
    (output(choices=[{"finish_reason": "stop", "message": {"role": "assistant", "content": []}}]),
     V6GenerationReason.EMPTY_ASSISTANT_CONTENT),
    (output(model=PRIVATE), V6GenerationReason.INVALID_MODEL_METADATA),
    (output(model=True), V6GenerationReason.INVALID_MODEL_METADATA),
    (output(usage=[]), V6GenerationReason.INVALID_USAGE),
    (output(usage={"prompt_tokens": True}), V6GenerationReason.INVALID_USAGE),
    (output(usage={"completion_tokens": -1}), V6GenerationReason.INVALID_USAGE),
    (output(usage={"total_tokens": 1.5}), V6GenerationReason.INVALID_USAGE),
    (output(usage={"completion_tokens_details": []}), V6GenerationReason.INVALID_USAGE),
    (output(usage={"completion_tokens": 5, "completion_tokens_details": {"reasoning_tokens": 6}}),
     V6GenerationReason.INVALID_USAGE),
    (output(usage={"cost": DIAGNOSTIC}), V6GenerationReason.INVALID_USAGE),
])
def test_provider_envelope_metadata_and_usage_remain_strict_and_sanitized(body, reason):
    with pytest.raises(V6GenerationError) as caught:
        invoke(httpx.Response(200, json=body))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT, reason)


@pytest.mark.parametrize("field,value", [
    ("tool_calls", [{}]), ("function_call", {"name": DIAGNOSTIC}), ("refusal", DIAGNOSTIC),
])
def test_no_tools_function_calls_or_refusal_fallback(field, value):
    body = output()
    body["choices"][0]["message"][field] = value
    with pytest.raises(V6GenerationError) as caught:
        invoke(httpx.Response(200, json=body))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT, V6GenerationReason.INVALID_ASSISTANT_MESSAGE)


@pytest.mark.parametrize("body,reason", [
    (b"private-provider-diagnostic", V6GenerationReason.INVALID_PROVIDER_JSON),
    (b'{"choices":NaN}', V6GenerationReason.INVALID_PROVIDER_JSON),
    (b'{"choices":[],"choices":[]}', V6GenerationReason.INVALID_PROVIDER_JSON),
    (b"\xff", V6GenerationReason.INVALID_UNICODE),
    (json.dumps(output(choices=[{"finish_reason": "stop", "message": {
        "role": "assistant", "content": "\ud800",
    }}])).encode(), V6GenerationReason.INVALID_UNICODE),
])
def test_invalid_json_and_unicode_are_not_repaired(body, reason):
    with pytest.raises(V6GenerationError) as caught:
        invoke(httpx.Response(200, content=body))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT, reason)


def test_optional_usage_and_exact_reasoning_cost_metadata_are_preserved():
    missing = invoke(httpx.Response(200, json=output(usage=None, model=None)))
    assert missing.usage == CorrectionUsage() and missing.resolved_model is None
    body = json.dumps(output(usage={"completion_tokens": 10, "completion_tokens_details": {"reasoning_tokens": 6}}))
    body = body.replace('"completion_tokens": 10', '"cost":0.12345678901234567890123456789,"completion_tokens":10')
    reported = invoke(httpx.Response(200, content=body)).usage
    assert reported.cost == Fraction(12345678901234567890123456789, 10**29)
    assert reported.output_tokens == 10 and reported.reasoning_tokens == 6


def test_bounded_response_buffer_stops_reading_and_closes_stream():
    closed = []

    class Body(httpx.SyncByteStream):
        def __iter__(self):
            yield b"x" * 32
            yield b"y" * 32
            pytest.fail("response limit must stop buffering")

        def close(self):
            closed.append(True)

    with pytest.raises(V6GenerationError) as caught:
        invoke(httpx.Response(200, stream=Body()), transcript_correction_max_response_bytes=40)
    sanitized(caught.value, CorrectionErrorCategory.RESOURCE, V6GenerationReason.RESPONSE_SIZE_EXCEEDED)
    assert closed == [True]


@pytest.mark.parametrize("slow_point", ["headers", "chunk", "end"])
def test_inherited_total_deadline_covers_the_entire_invocation(monkeypatch, slow_point):
    transport = importlib.import_module("sme_meeting_ai.providers.openrouter_instruction_llm_v6")
    clock = [0.0]
    monkeypatch.setattr(transport.time, "monotonic", lambda: clock[0])

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
            OpenRouterInstructionLlmV61Adapter(configuration(), client).complete(request())
    sanitized(caught.value, CorrectionErrorCategory.TIMEOUT, V6GenerationReason.DEADLINE_EXCEEDED)


@pytest.mark.parametrize("exception,category,reason", [
    (httpx.ReadTimeout, CorrectionErrorCategory.TIMEOUT, V6GenerationReason.DEADLINE_EXCEEDED),
    (httpx.ConnectError, CorrectionErrorCategory.TRANSPORT, V6GenerationReason.TRANSPORT_ERROR),
])
def test_transport_failures_have_no_private_exception_chain_or_http_retry(exception, category, reason, caplog):
    calls = []

    def handle(r):
        calls.append(r)
        raise exception(PRIVATE + SECRET + DIAGNOSTIC, request=r)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(V6GenerationError) as caught:
            OpenRouterInstructionLlmV61Adapter(configuration(), client).complete(request())
    sanitized(caught.value, category, reason)
    assert len(calls) == 1 and PRIVATE not in caplog.text and DIAGNOSTIC not in caplog.text


@pytest.mark.parametrize("status", [200, 400])
def test_owned_client_is_environment_isolated_bounded_and_closed_on_success_or_failure(monkeypatch, status):
    original = httpx.Client
    clients = []

    def create(**kwargs):
        assert kwargs == {"timeout": 120, "trust_env": False, "follow_redirects": False}
        client = original(transport=httpx.MockTransport(lambda r: httpx.Response(status, json=output())), **kwargs)
        clients.append(client)
        return client

    monkeypatch.setattr(httpx, "Client", create)
    with OpenRouterInstructionLlmV61Adapter(configuration()) as adapter:
        if status == 200:
            adapter.complete(request())
        else:
            with pytest.raises(V6GenerationError):
                adapter.complete(request())
    assert len(clients) == 1 and clients[0].is_closed


def test_borrowed_client_remains_open_on_success_and_failure():
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=output()))) as client:
        with OpenRouterInstructionLlmV61Adapter(configuration(), client) as adapter:
            adapter.complete(request())
        assert not client.is_closed
        with OpenRouterInstructionLlmV61Adapter(configuration(OPENROUTER_API_KEY=None), client) as adapter:
            with pytest.raises(V6GenerationError):
                adapter.complete(request())
        assert not client.is_closed


def test_schema_rejection_is_one_call_without_text_mode_fallback():
    calls = []

    def handle(r):
        calls.append(json.loads(r.content))
        return httpx.Response(400, json={"error": {"message": DIAGNOSTIC + " schema unsupported"}})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        outcome = generate_v61_proposal(meeting(), OpenRouterInstructionLlmV61Adapter(configuration(), client), configuration())
    assert outcome.failure.http_status == 400 and outcome.failure.attempts == len(calls) == 1
    assert calls[0]["response_format"]["json_schema"]["strict"] is True
    assert DIAGNOSTIC not in repr(outcome)
