import json
import os
import traceback
from dataclasses import replace
from fractions import Fraction

import httpx
import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.providers.openrouter_instruction_llm import (
    OpenRouterInstructionLlmAdapter,
)
from sme_meeting_ai.transcription import (
    CorrectionError,
    CorrectionErrorCategory,
    CorrectionRequest,
    CorrectionUsage,
)

SECRET = "test-only-private-key"
TEXT = "Nội dung riêng tư"


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    monkeypatch.setattr(os, "environ", {})


def settings(**overrides):
    return Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                    **{"OPENROUTER_API_KEY": SECRET,
                       "transcript_correction_model": "vendor/approved", **overrides})


def request():
    return CorrectionRequest("Versioned untrusted data instructions", json.dumps({"segments": [
        {"segment_id": "segment-000000", "ordinal": 0, "text": TEXT},
    ]}), "vendor/approved", 32768, 0)


def output(**overrides):
    return {"choices": [{"message": {"role": "assistant", "content": '{"segments":[]}'},
                         "finish_reason": "stop"}], "model": "vendor/resolved",
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            **overrides}


def invoke_response(response, **overrides):
    with httpx.Client(transport=httpx.MockTransport(lambda r: response)) as client:
        return OpenRouterInstructionLlmAdapter(settings(**overrides), client).complete(request())


def sanitized(error, category):
    assert error.category is category
    assert error.args == (category.value,)
    assert error.__context__ is None and error.__cause__ is None
    rendered = "".join(traceback.format_exception(error)) + repr(error)
    for sensitive in (SECRET, TEXT, "private-provider-diagnostic"):
        assert sensitive not in rendered


def test_chat_json_contract_finite_timeout_no_adapter_retries_or_sensitive_logs(caplog):
    calls = []

    def handle(http_request):
        calls.append(http_request)
        assert str(http_request.url) == "https://openrouter.ai/api/v1/chat/completions"
        assert http_request.headers["authorization"] == f"Bearer {SECRET}"
        assert http_request.extensions["timeout"] == dict.fromkeys(("connect", "read", "write", "pool"), 2.5)
        body = json.loads(http_request.content)
        assert body == {"model": "vendor/approved", "temperature": 0, "max_tokens": 32768,
                        "response_format": {"type": "json_object"}, "stream": False,
                        "messages": [{"role": "system", "content": request().system_prompt},
                                     {"role": "user", "content": request().transcript_json}]}
        assert SECRET not in str(body)
        return httpx.Response(200, json=output())

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        adapter = OpenRouterInstructionLlmAdapter(settings(transcript_correction_timeout_seconds=2.5), client)
        response = adapter.complete(request())
        assert response.text == '{"segments":[]}'
        assert response.provider == "openrouter"
        assert response.requested_model == "vendor/approved"
        assert response.resolved_model == "vendor/resolved"
        assert response.usage == CorrectionUsage(10, 5, 15)
        adapter.complete(request())
        assert len(calls) == 2
        adapter.close()
        assert not client.is_closed
    assert TEXT not in repr(request()) + repr(response) + caplog.text
    assert SECRET not in caplog.text


def test_owned_client_is_bounded_and_ignores_environment(monkeypatch):
    original = httpx.Client
    clients = []

    def create(**kwargs):
        assert kwargs == {"timeout": 120, "trust_env": False, "follow_redirects": False}
        client = original(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=output())), **kwargs)
        clients.append(client)
        return client
    monkeypatch.setattr(httpx, "Client", create)
    with OpenRouterInstructionLlmAdapter(settings()) as adapter:
        adapter.complete(request())
    assert len(clients) == 1 and clients[0].is_closed


@pytest.mark.parametrize("status,category", [
    (401, CorrectionErrorCategory.AUTHENTICATION), (403, CorrectionErrorCategory.AUTHENTICATION),
    (429, CorrectionErrorCategory.RATE_LIMIT), (408, CorrectionErrorCategory.TIMEOUT),
    (504, CorrectionErrorCategory.TIMEOUT), (524, CorrectionErrorCategory.TIMEOUT),
    (413, CorrectionErrorCategory.CONTEXT_OVERFLOW), (400, CorrectionErrorCategory.PROVIDER),
    (500, CorrectionErrorCategory.PROVIDER), (302, CorrectionErrorCategory.PROVIDER),
])
def test_http_failures_are_category_only_without_redirects_or_retries(status, category):
    calls = []

    def handle(r):
        calls.append(r)
        return httpx.Response(status, headers={"location": "https://example.com"},
                              content=b"private-provider-diagnostic")
    with httpx.Client(transport=httpx.MockTransport(handle), follow_redirects=True) as client:
        with pytest.raises(CorrectionError) as caught:
            OpenRouterInstructionLlmAdapter(settings(), client).complete(request())
    assert len(calls) == 1
    sanitized(caught.value, category)


@pytest.mark.parametrize("exception,category", [
    (httpx.ReadTimeout, CorrectionErrorCategory.TIMEOUT),
    (httpx.ConnectError, CorrectionErrorCategory.TRANSPORT),
])
def test_transport_failures_discard_sensitive_exception_context(exception, category):
    calls = []

    def handle(r):
        calls.append(r)
        raise exception("private-provider-diagnostic", request=r)
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(CorrectionError) as caught:
            OpenRouterInstructionLlmAdapter(settings(), client).complete(request())
    assert len(calls) == 1
    sanitized(caught.value, category)


@pytest.mark.parametrize("body", [
    {}, [], output(choices=[]), output(choices=[{}, {}]),
    output(choices=[{"message": {"content": None}, "finish_reason": "stop"}]),
    output(choices=[{"message": {"content": []}, "finish_reason": "stop"}]),
    output(choices=[{"message": {"content": "{}"}, "finish_reason": "length"}]),
    output(choices=[{"message": {"content": "{}", "tool_calls": [{}]}, "finish_reason": "stop"}]),
    output(choices=[{"message": {"content": "{}", "refusal": "private-provider-diagnostic"}, "finish_reason": "stop"}]),
    output(usage={"prompt_tokens": True}), output(usage={"completion_tokens": -1}),
    output(model="private provider diagnostic"), output(error={"message": "private-provider-diagnostic"}),
])
def test_malformed_envelopes_and_incomplete_generations_fail_closed(body):
    with pytest.raises(CorrectionError) as caught:
        invoke_response(httpx.Response(200, json=body))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("body", [b"private-provider-diagnostic", b'{"choices":NaN}', b'{"choices":[],"choices":[]}'])
def test_invalid_json_is_sanitized(body):
    with pytest.raises(CorrectionError) as caught:
        invoke_response(httpx.Response(200, content=body))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


def test_streaming_response_size_is_bounded():
    class Body(httpx.SyncByteStream):
        def __iter__(self):
            yield b"x" * 32
            yield b"y" * 32
            pytest.fail("must stop reading at response limit")
    with pytest.raises(CorrectionError) as caught:
        invoke_response(httpx.Response(200, stream=Body()), transcript_correction_max_response_bytes=40)
    sanitized(caught.value, CorrectionErrorCategory.RESOURCE)


def test_total_response_deadline_bounds_slow_stream(monkeypatch):
    import sme_meeting_ai.providers.openrouter_instruction_llm as module
    ticks = iter((0, 121))
    monkeypatch.setattr(module.time, "monotonic", lambda: next(ticks))
    with pytest.raises(CorrectionError) as caught:
        invoke_response(httpx.Response(200, json=output()))
    sanitized(caught.value, CorrectionErrorCategory.TIMEOUT)


@pytest.mark.parametrize("overrides,category", [
    ({"transcript_correction_model": None}, CorrectionErrorCategory.CONFIGURATION),
    ({"OPENROUTER_API_KEY": None}, CorrectionErrorCategory.AUTHENTICATION),
    ({"OPENROUTER_API_KEY": "bad key"}, CorrectionErrorCategory.AUTHENTICATION),
    ({"transcript_correction_max_input_tokens": 1}, CorrectionErrorCategory.CONTEXT_OVERFLOW),
])
def test_local_configuration_and_context_failures_make_no_network_request(overrides, category):
    def unexpected(r):
        pytest.fail("local rejection must not call provider")
    with httpx.Client(transport=httpx.MockTransport(unexpected)) as client:
        with pytest.raises(CorrectionError) as caught:
            OpenRouterInstructionLlmAdapter(settings(**overrides), client).complete(request())
    sanitized(caught.value, category)


@pytest.mark.parametrize("mutation", [
    {"model": "vendor/other"}, {"max_output_tokens": True},
    {"max_output_tokens": 32769}, {"temperature": float("nan")},
    {"transcript_json": None}, {"system_prompt": ""},
])
def test_invalid_normalized_request_is_rejected_before_network(mutation):
    with httpx.Client(transport=httpx.MockTransport(lambda r: pytest.fail("invalid request"))) as client:
        with pytest.raises(CorrectionError) as caught:
            OpenRouterInstructionLlmAdapter(settings(), client).complete(replace(request(), **mutation))
    sanitized(caught.value, CorrectionErrorCategory.VALIDATION)


@pytest.mark.parametrize("cost,expected", [(None, None), (0, Fraction(0)), (0.00012345, Fraction(12345, 100000000)), (2, Fraction(2))])
def test_optional_reported_cost_is_exact_not_estimated_from_tokens(cost, expected):
    body = output()
    if cost is not None:
        body["usage"]["cost"] = cost
    response = invoke_response(httpx.Response(200, json=body))
    assert response.usage.cost == expected


@pytest.mark.parametrize("cost", [True, -1, "0.01", "private-cost-diagnostic", {}, []])
def test_invalid_reported_cost_fails_with_sanitized_category(cost):
    with pytest.raises(CorrectionError) as caught:
        invoke_response(httpx.Response(200, json=output(usage={"cost": cost})))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("cost", ["NaN", "Infinity", "-Infinity"])
def test_nonfinite_cost_is_rejected_without_provider_body(cost):
    raw = json.dumps(output()).replace('"prompt_tokens": 10', '"cost": ' + cost + ', "prompt_tokens": 10')
    with pytest.raises(CorrectionError) as caught:
        invoke_response(httpx.Response(200, content=raw))
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)
