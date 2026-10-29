import asyncio
import re
from dataclasses import FrozenInstanceError

import pytest

from sme_meeting_ai.observability import (
    CorrelationContext,
    correlation_scope,
    format_traceparent,
    get_correlation_context,
    new_correlation_context,
    parse_traceparent,
    reset_correlation_context,
    set_correlation_context,
)

TRACE = "1234567890abcdef1234567890abcdef"
SPAN = "1234567890abcdef"
TRACEPARENT = f"00-{TRACE}-{SPAN}-01"


def test_generated_context_is_nonzero_w3c_compatible_and_immutable():
    context = new_correlation_context()
    assert re.fullmatch(r"[0-9a-f]{32}", context.trace_id)
    assert re.fullmatch(r"[0-9a-f]{16}", context.span_id)
    assert int(context.trace_id, 16) and int(context.span_id, 16)
    assert context.trace_flags == "00"
    assert context.parent_span_id is None
    assert new_correlation_context() != context
    with pytest.raises(FrozenInstanceError):
        context.trace_id = TRACE


def test_parse_format_and_child_context_preserve_trace_and_flags():
    inbound = parse_traceparent(TRACEPARENT)
    assert inbound == CorrelationContext(TRACE, SPAN, "01")
    assert format_traceparent(inbound) == TRACEPARENT
    child = new_correlation_context(traceparent=TRACEPARENT)
    assert child.trace_id == TRACE
    assert child.parent_span_id == SPAN
    assert child.span_id != SPAN
    assert child.trace_flags == "01"
    assert format_traceparent(child) == f"00-{TRACE}-{child.span_id}-01"


@pytest.mark.parametrize("value", [
    None, "", 123, "secret\n" + TRACEPARENT, TRACEPARENT + "\n",
    TRACEPARENT.upper(), TRACEPARENT.replace("00-", "01-", 1),
    f"00-{'0' * 32}-{SPAN}-01", f"00-{TRACE}-{'0' * 16}-01",
    f"00-{TRACE[:-1]}-{SPAN}-01", f"00-{TRACE}-{SPAN}-gg",
    TRACEPARENT + "-extra", " " + TRACEPARENT,
])
def test_invalid_traceparent_is_rejected_and_generates_fresh_root(value):
    assert parse_traceparent(value) is None
    context = new_correlation_context(traceparent=value)
    assert context.trace_id != TRACE
    assert context.parent_span_id is None
    assert context.trace_flags == "00"


@pytest.mark.parametrize(("field", "value"), [
    ("trace_id", "0" * 32), ("trace_id", TRACE.upper()),
    ("span_id", "0" * 16), ("span_id", "secret\n"),
    ("trace_flags", "0"), ("trace_flags", "FF"),
])
def test_direct_context_rejects_invalid_required_fields_without_echo(field, value):
    values = dict(trace_id=TRACE, span_id=SPAN, trace_flags="01")
    values[field] = value
    with pytest.raises(ValueError) as caught:
        CorrelationContext(**values)
    assert value not in str(caught.value)


def test_valid_optional_identifiers_and_parent_are_preserved():
    context = CorrelationContext(
        TRACE, SPAN, "ff", parent_span_id=SPAN,
        request_id="req-01_abc.def", job_id="job-42",
    )
    assert context.request_id == "req-01_abc.def"
    assert context.job_id == "job-42"
    assert context.parent_span_id == SPAN
    generated = new_correlation_context(request_id="req-1", job_id="job-2")
    assert (generated.request_id, generated.job_id) == ("req-1", "job-2")


@pytest.mark.parametrize("value", [
    "", "x" * 129, "secret\nforged", "a b", "https://signed?token=secret",
    "person@example.com", "Tiếng Việt", 123,
])
def test_unsafe_optional_identifiers_are_omitted(value):
    context = CorrelationContext(
        TRACE, SPAN, request_id=value, job_id=value, parent_span_id=value,
    )
    assert context.request_id is None
    assert context.job_id is None
    assert context.parent_span_id is None


def test_set_reset_nested_scopes_and_exception_cleanup():
    assert get_correlation_context() is None
    outer, inner = new_correlation_context(), new_correlation_context()
    token = set_correlation_context(outer)
    try:
        assert get_correlation_context() is outer
        with pytest.raises(RuntimeError):
            with correlation_scope(inner) as active:
                assert active is inner
                assert get_correlation_context() is inner
                with correlation_scope(outer):
                    assert get_correlation_context() is outer
                assert get_correlation_context() is inner
                raise RuntimeError("scope failure")
        assert get_correlation_context() is outer
    finally:
        reset_correlation_context(token)
    assert get_correlation_context() is None


def test_concurrent_async_tasks_have_isolated_context_and_cleanup():
    async def run():
        ready = asyncio.Event()
        contexts = [new_correlation_context(job_id=f"job-{i}") for i in range(2)]

        async def operation(context):
            assert get_correlation_context() is None
            with correlation_scope(context):
                ready.set()
                await ready.wait()
                await asyncio.sleep(0)
                assert get_correlation_context() is context
            assert get_correlation_context() is None

        await asyncio.gather(*(operation(context) for context in contexts))
        assert get_correlation_context() is None

    asyncio.run(run())
