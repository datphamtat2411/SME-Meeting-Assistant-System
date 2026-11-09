import asyncio
import json
import os
import time
import traceback
from dataclasses import replace
from fractions import Fraction
from threading import Event, Thread

import httpx
import pytest
from intelligence_support import envelope, settings, stage, task, uid

from sme_meeting_ai.meeting_intelligence.composition import prepare_context
from sme_meeting_ai.meeting_intelligence.contracts import ResponseSchema
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
from sme_meeting_ai.providers.openrouter_intelligence import (
    OpenRouterIntelligenceAdapter,
)

KEY = "synthetic-t03-private-key"


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(os, "environ", {})


def config(**options):
    return settings(**{"meeting_intelligence_inference_enabled": True,
                       "OPENROUTER_API_KEY": KEY, **options})


def request(config_override=None):
    return prepare_context(stage(), task(), config_override or config()).request(0)


def invoke(body=None, status=200, **options):
    config_ = config(**options)
    transport = httpx.MockTransport(lambda r: httpx.Response(status, json=envelope() if body is None else body))
    with OpenRouterIntelligenceAdapter(config_, transport=transport) as adapter:
        return adapter.complete(request(config_))


def assert_safe(error, category):
    assert error.category == category and error.args == (f"INTELLIGENCE_{category}",)
    assert error.__context__ is None and error.__cause__ is None
    rendered = "".join(traceback.format_exception(error))
    assert KEY not in rendered and "Chúng ta" not in rendered and "private diagnostic" not in rendered


def test_strict_request_separation_provenance_usage_and_safe_reprs(caplog):
    calls = []
    def handle(r):
        calls.append(r)
        body = json.loads(r.content)
        assert str(r.url) == "https://openrouter.ai/api/v1/chat/completions"
        assert r.headers["authorization"] == f"Bearer {KEY}"
        assert body["model"] == "openai/gpt-6-luna" and body["stream"] is False
        assert body["reasoning"] == {"effort": "high"}
        assert body["response_format"]["type"] == "json_schema"
        assert body["response_format"]["json_schema"]["strict"] is True
        assert body["provider"] == {"require_parameters": True, "allow_fallbacks": False}
        assert "models" not in body and "tools" not in body and "plugins" not in body
        assert body["max_tokens"] == 32768
        system, user = body["messages"]
        assert system["role"] == "system" and "untrusted" in system["content"].lower()
        assert "Chúng ta" not in system["content"]
        assert user["role"] == "user"
        evidence = json.loads(user["content"])
        assert evidence["data_classification"] == "untrusted_transcript_evidence"
        assert [u["segment_id"] for u in evidence["evidence"]] == [uid(100), uid(101)]
        assert all(x not in r.content.decode() for x in (KEY, "claimToken", "objectKey", "processing_job_id", "userId"))
        return httpx.Response(200, json=envelope())
    with OpenRouterIntelligenceAdapter(config(), transport=httpx.MockTransport(handle)) as adapter:
        completion = adapter.complete(request())
    assert completion.output == {"segment_ids": [uid(100), uid(101)]}
    assert completion.requested_model == "openai/gpt-6-luna"
    assert completion.reported_model == "openai/gpt-6-luna"
    assert completion.reasoning_effort == "high"
    assert completion.provider == "openrouter" and completion.reported_provider == "OpenAI"
    assert completion.prompt_version == "probe-v1" and completion.schema_version == "probe-schema-v1"
    assert completion.schema_sha256 == task().schema.sha256
    assert completion.source == request().window.source
    assert completion.window_id == request().window.window_id
    assert completion.planning_version == request().window.planning_version
    assert completion.configuration_sha256 == request().window.configuration_sha256
    assert completion.task_sha256 == task().sha256
    assert completion.usage.input_tokens == 100 and completion.usage.reasoning_tokens == 10
    assert completion.usage.reported_cost == Fraction(1, 10000)
    assert completion.attempts == 1 and completion.duration_seconds >= 0
    assert not completion.failed_attempt_categories
    assert len(calls) == 1
    assert "Chúng ta" not in repr(request()) + repr(completion) + caplog.text


@pytest.mark.parametrize("content,category", [
    ('{"segment_ids":[],"segment_ids":[]}', "MALFORMED_OUTPUT"),
    ('{"segment_ids": [', "MALFORMED_OUTPUT"),
    ('```json\n{}\n```', "MALFORMED_OUTPUT"),
    ('{"segment_ids": [], "extra": true}', "SCHEMA_MISMATCH"),
    ('{}', "SCHEMA_MISMATCH"), ('{"segment_ids": "x"}', "SCHEMA_MISMATCH"),
    ('{"segment_ids": [3]}', "SCHEMA_MISMATCH"),
    (json.dumps({"segment_ids": ["x" * 37]}), "SCHEMA_MISMATCH"),
    (json.dumps({"segment_ids": ["x"] * 101}), "SCHEMA_MISMATCH"),
    ('{"segment_ids":NaN}', "MALFORMED_OUTPUT"), ('[]', "SCHEMA_MISMATCH"),
])
def test_invalid_structured_outputs_never_repaired_or_retried(content, category):
    calls = []
    def handle(r):
        calls.append(r)
        return httpx.Response(200, json=envelope(content))
    with OpenRouterIntelligenceAdapter(config(), transport=httpx.MockTransport(handle)) as adapter:
        with pytest.raises(IntelligenceError) as caught:
            adapter.complete(request())
    assert_safe(caught.value, category)
    assert len(calls) == 1


@pytest.mark.parametrize("mutation,category", [
    ("length", "INCOMPLETE_OUTPUT"), ("content_filter", "INCOMPLETE_OUTPUT"),
    ("refusal", "REFUSAL"), ("tool_calls", "MALFORMED_OUTPUT"),
    ("function_call", "MALFORMED_OUTPUT"), ("choices", "MALFORMED_OUTPUT"),
    ("usage_bool", "MALFORMED_OUTPUT"), ("usage_negative", "MALFORMED_OUTPUT"),
    ("reasoning", "MALFORMED_OUTPUT"), ("model", "MALFORMED_OUTPUT"),
    ("content", "MALFORMED_OUTPUT"), ("error", "PROVIDER"),
])
def test_invalid_envelopes(mutation, category):
    body = envelope()
    choice = body["choices"][0]
    if mutation in ("length", "content_filter"):
        choice["finish_reason"] = mutation
    elif mutation in ("refusal", "tool_calls", "function_call"):
        choice["message"][mutation] = "private diagnostic"
    elif mutation == "choices":
        body["choices"] = []
    elif mutation == "usage_bool":
        body["usage"]["prompt_tokens"] = True
    elif mutation == "usage_negative":
        body["usage"]["cost"] = -1
    elif mutation == "reasoning":
        body["usage"]["completion_tokens_details"]["reasoning_tokens"] = 31
    elif mutation == "model":
        body["model"] = "private diagnostic"
    elif mutation == "content":
        choice["message"]["content"] = []
    elif mutation == "error":
        body["error"] = {"message": "private diagnostic"}
    with pytest.raises(IntelligenceError) as caught:
        invoke(body)
    assert_safe(caught.value, category)


@pytest.mark.parametrize("status,category,count", [(401,"AUTHENTICATION",1), (403,"AUTHENTICATION",1),
    (400,"UNSUPPORTED_PARAMETERS",1), (404,"UNSUPPORTED_PARAMETERS",1), (422,"UNSUPPORTED_PARAMETERS",1),
    (413,"CONTEXT_BUDGET",1), (429,"RATE_LIMIT",2), (500,"PROVIDER",2), (503,"PROVIDER",2),
    (408,"TIMEOUT",2), (302,"PROVIDER",1)])
def test_status_classification_and_finite_retry_policy(status, category, count):
    calls = []
    def handle(r):
        calls.append(r)
        return httpx.Response(status, content=b"private diagnostic", headers={"location": "https://private.invalid"})
    with OpenRouterIntelligenceAdapter(config(), transport=httpx.MockTransport(handle)) as adapter:
        with pytest.raises(IntelligenceError) as caught:
            adapter.complete(request())
    assert len(calls) == count
    assert_safe(caught.value, category)


def test_transient_attempt_is_visible_in_success_provenance():
    calls = []
    def handle(r):
        calls.append(r)
        return httpx.Response(503) if len(calls) == 1 else httpx.Response(200, json=envelope())
    with OpenRouterIntelligenceAdapter(config(), transport=httpx.MockTransport(handle)) as adapter:
        response = adapter.complete(request())
    assert response.attempts == 2 and response.failed_attempt_categories == ("PROVIDER",)


@pytest.mark.parametrize("exception,category", [(httpx.ReadTimeout,"TIMEOUT"), (httpx.ConnectError,"TRANSPORT")])
def test_transport_exceptions_are_sanitized_and_attempts_bounded(exception, category):
    calls = []
    def handle(r):
        calls.append(r)
        raise exception("private diagnostic", request=r)
    with OpenRouterIntelligenceAdapter(config(), transport=httpx.MockTransport(handle)) as adapter:
        with pytest.raises(IntelligenceError) as caught:
            adapter.complete(request())
    assert len(calls) == 2
    assert_safe(caught.value, category)


@pytest.mark.parametrize("mode,category", [("disabled","INFERENCE_DISABLED"), ("credential","AUTHENTICATION"),
    ("cancelled","CANCELLED"), ("deadline","DEADLINE"), ("model","CONFIGURATION"),
    ("budget","CONTEXT_BUDGET"), ("closed","CONFIGURATION")])
def test_preflight_failures_make_no_network_call(mode, category):
    conf = config()
    req = request()
    if mode == "disabled":
        conf = config(meeting_intelligence_inference_enabled=False, OPENROUTER_API_KEY=None)
    elif mode == "credential":
        conf = config(OPENROUTER_API_KEY=None)
    elif mode == "cancelled":
        req.cancelled.set()
    elif mode == "deadline":
        req = replace(req, deadline=time.monotonic()-1)
    elif mode == "model":
        req = replace(req, model="vendor/other")
    elif mode == "budget":
        req = replace(req, input_budget=1)
    def handle(r): pytest.fail("Preflight must not issue HTTP")
    with OpenRouterIntelligenceAdapter(conf, transport=httpx.MockTransport(handle)) as adapter:
        if mode == "closed":
            adapter.close()
        with pytest.raises(IntelligenceError) as caught:
            adapter.complete(req)
    assert_safe(caught.value, category)


def test_max_response_bytes_is_enforced_and_stream_is_closed():
    closed = []
    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b" " * 200
            yield b" " * 200
        async def aclose(self): closed.append(True)
    with OpenRouterIntelligenceAdapter(config(meeting_intelligence_max_response_bytes=300),
            transport=httpx.MockTransport(lambda r: httpx.Response(200, stream=Body()))) as adapter:
        with pytest.raises(IntelligenceError, match="RESOURCE"):
            adapter.complete(request())
    assert closed


@pytest.mark.parametrize("authority", ["cancel", "deadline", "timeout"])
def test_inflight_io_is_cancelled_and_closed_without_background_provider_work(authority):
    started, cleaned, cancelled = Event(), Event(), Event()
    async def handle(r):
        started.set()
        try:
            await asyncio.sleep(30)
        finally:
            cleaned.set()
    req = replace(request(), cancelled=cancelled,
                  deadline=time.monotonic() + (0.08 if authority == "deadline" else 10))
    def revoke():
        assert started.wait(2)
        if authority == "cancel":
            cancelled.set()
    thread = Thread(target=revoke)
    thread.start()
    conf = config(meeting_intelligence_provider_timeout_seconds=0.08,
                  meeting_intelligence_max_attempts=1) if authority == "timeout" else config()
    before = time.monotonic()
    with OpenRouterIntelligenceAdapter(conf, transport=httpx.MockTransport(handle)) as adapter:
        with pytest.raises(IntelligenceError) as caught:
            adapter.complete(req)
    thread.join(2)
    assert cleaned.is_set() and time.monotonic() - before < 2
    assert_safe(caught.value, {"cancel":"CANCELLED", "deadline":"DEADLINE", "timeout":"TIMEOUT"}[authority])


def test_cancellation_after_first_attempt_blocks_retry():
    req = request()
    calls = []
    def handle(r):
        calls.append(r)
        req.cancelled.set()
        return httpx.Response(503)
    with OpenRouterIntelligenceAdapter(config(), transport=httpx.MockTransport(handle)) as adapter:
        with pytest.raises(IntelligenceError, match="CANCELLED"):
            adapter.complete(req)
    assert len(calls) == 1


@pytest.mark.parametrize("schema", [
    {"type":"object", "properties":{}, "required":[], "additionalProperties":True},
    {"type":"object", "properties":{"x":{"type":"string"}}, "required":["x"], "additionalProperties":False},
    {"type":"object", "properties":{"x":{"type":"array", "items":{"type":"boolean"}}},
     "required":["x"], "additionalProperties":False},
    {"type":"object", "properties":{"x":{"$ref":"https://private.invalid"}}, "required":["x"], "additionalProperties":False},
    {"type":"array", "maxItems":1, "items":{"type":"boolean"}},
])
def test_unsupported_or_unbounded_schema_fails_before_provider(schema):
    with pytest.raises(IntelligenceError, match="UNSUPPORTED_SCHEMA"):
        ResponseSchema("test", "1", schema)


def test_supported_schema_subset_validates_types_enums_and_nullable_values():
    schema = ResponseSchema("typed", "1", {"type":"object", "properties":{
        "status":{"type":"string", "enum":["OK","UNKNOWN"], "maxLength":7},
        "count":{"type":"integer", "minimum":0, "maximum":5},
        "maybe":{"type":["string","null"], "maxLength":10},
        "flag":{"type":"boolean"}}, "required":["status","count","maybe","flag"],
        "additionalProperties":False})
    valid = {"status":"OK", "count":1, "maybe":None, "flag":False}
    assert schema.parse(json.dumps(valid)) == valid
    for change in ({"status":"WRONG"}, {"count":True}, {"count":1.0}, {"count":6}, {"flag":1}):
        with pytest.raises(IntelligenceError, match="SCHEMA_MISMATCH"):
            schema.parse(json.dumps({**valid, **change}))


def test_absent_usage_is_not_replaced_with_estimates():
    body = envelope()
    body.pop("usage")
    body.pop("model")
    body.pop("provider")
    result = invoke(body)
    assert result.usage.input_tokens is None and result.usage.reported_cost is None
    assert result.reported_model is None and result.reported_provider is None
    assert result.estimated_input_tokens > 0


@pytest.mark.parametrize("body", [b'{"choices":[],"choices":[]}', b'not json', b'{"choices":NaN}'])
def test_malformed_provider_envelope_json_is_sanitized(body):
    with OpenRouterIntelligenceAdapter(config(), transport=httpx.MockTransport(
            lambda r: httpx.Response(200, content=body))) as adapter:
        with pytest.raises(IntelligenceError) as caught:
            adapter.complete(request())
    assert_safe(caught.value, "MALFORMED_OUTPUT")


def test_changed_task_requires_new_plan():
    req = replace(request(), task=replace(task(), instructions="Different approved task"))
    with OpenRouterIntelligenceAdapter(config(), transport=httpx.MockTransport(
            lambda r: pytest.fail("Changed task must not issue HTTP"))) as adapter:
        with pytest.raises(IntelligenceError, match="CONFIGURATION"):
            adapter.complete(req)


def test_reasoning_mismatch_is_rejected_before_provider_call():
    req = replace(request(), reasoning_effort="low")
    with OpenRouterIntelligenceAdapter(config(), transport=httpx.MockTransport(
            lambda r: pytest.fail("Reasoning mismatch must not issue HTTP"))) as adapter:
        with pytest.raises(IntelligenceError, match="CONFIGURATION"):
            adapter.complete(req)


def test_single_attempt_setting_is_obeyed():
    calls = []
    def provider(r):
        calls.append(r)
        return httpx.Response(503)
    conf = config(meeting_intelligence_max_attempts=1)
    with OpenRouterIntelligenceAdapter(conf, transport=httpx.MockTransport(provider)) as adapter:
        with pytest.raises(IntelligenceError, match="PROVIDER"):
            adapter.complete(request(conf))
    assert len(calls) == 1


def test_shared_adapter_bounds_concurrency_and_close_cancels_active_and_queued_calls():
    started, finished = Event(), Event()
    errors, active = [], []
    async def provider(r):
        active.append(1)
        started.set()
        try:
            await asyncio.sleep(30)
        finally:
            finished.set()
    adapter = OpenRouterIntelligenceAdapter(config(), transport=httpx.MockTransport(provider))
    def run():
        try:
            adapter.complete(request())
        except IntelligenceError as error:
            errors.append(error.category)
    first, second = Thread(target=run), Thread(target=run)
    first.start()
    assert started.wait(2)
    second.start()
    time.sleep(0.04)
    adapter.close()
    first.join(2)
    second.join(2)
    assert not first.is_alive() and not second.is_alive() and finished.is_set()
    assert active == [1] and errors == ["CONFIGURATION", "CONFIGURATION"]


def test_owned_http_client_disables_redirects_environment_and_bounds_connections(monkeypatch):
    original, seen = httpx.AsyncClient, []
    def create(**kwargs):
        assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
        assert kwargs["limits"].max_connections == 1
        client = original(**kwargs)
        seen.append(client)
        return client
    monkeypatch.setattr(httpx, "AsyncClient", create)
    invoke()
    assert len(seen) == 1 and seen[0].is_closed
