"""Transport-independent, operation-local W3C correlation context."""

import re
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass


_TRACE_ID = re.compile(r"[0-9a-f]{32}")
_SPAN_ID = re.compile(r"[0-9a-f]{16}")
_FLAGS = re.compile(r"[0-9a-f]{2}")
_IDENTIFIER = re.compile(r"[A-Za-z0-9_.-]{1,128}")
_TRACEPARENT = re.compile(r"00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})")


def _matches(value: object, pattern: re.Pattern[str]) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _valid_id(value: object, pattern: re.Pattern[str]) -> bool:
    return _matches(value, pattern) and int(value, 16) != 0


@dataclass(frozen=True, slots=True)
class CorrelationContext:
    """Validated immutable IDs; unsafe optional identifiers are discarded."""

    trace_id: str
    span_id: str
    trace_flags: str = "00"
    parent_span_id: str | None = None
    request_id: str | None = None
    job_id: str | None = None

    def __post_init__(self) -> None:
        if not (
            _valid_id(self.trace_id, _TRACE_ID)
            and _valid_id(self.span_id, _SPAN_ID)
            and _matches(self.trace_flags, _FLAGS)
        ):
            raise ValueError("Invalid correlation context")
        if not _valid_id(self.parent_span_id, _SPAN_ID):
            object.__setattr__(self, "parent_span_id", None)
        for field in ("request_id", "job_id"):
            if not _matches(getattr(self, field), _IDENTIFIER):
                object.__setattr__(self, field, None)


_context: ContextVar[CorrelationContext | None] = ContextVar(
    "sme_meeting_ai_correlation", default=None
)


def parse_traceparent(value: object) -> CorrelationContext | None:
    """Parse only W3C version 00; reject without retaining unsafe input."""
    if not isinstance(value, str):
        return None
    match = _TRACEPARENT.fullmatch(value)
    if match is None:
        return None
    trace_id, span_id, flags = match.groups()
    if not _valid_id(trace_id, _TRACE_ID) or not _valid_id(span_id, _SPAN_ID):
        return None
    return CorrelationContext(trace_id, span_id, flags)


def format_traceparent(context: CorrelationContext) -> str:
    """Represent the current span for a future transport adapter."""
    return f"00-{context.trace_id}-{context.span_id}-{context.trace_flags}"


def _new_id(byte_count: int) -> str:
    while True:
        value = secrets.token_hex(byte_count)
        if int(value, 16):
            return value


def new_correlation_context(
    *,
    traceparent: str | None = None,
    request_id: str | None = None,
    job_id: str | None = None,
) -> CorrelationContext:
    """Create a child of valid inbound context, or a fresh unsampled root."""
    parent = parse_traceparent(traceparent)
    return CorrelationContext(
        trace_id=parent.trace_id if parent else _new_id(16),
        span_id=_new_id(8),
        trace_flags=parent.trace_flags if parent else "00",
        parent_span_id=parent.span_id if parent else None,
        request_id=request_id,
        job_id=job_id,
    )


def set_correlation_context(context: CorrelationContext) -> Token:
    """Set task-local context and return the token needed to restore it."""
    if not isinstance(context, CorrelationContext):
        raise TypeError("Expected CorrelationContext")
    return _context.set(context)


def get_correlation_context() -> CorrelationContext | None:
    return _context.get()


def reset_correlation_context(token: Token) -> None:
    _context.reset(token)


@contextmanager
def correlation_scope(context: CorrelationContext) -> Iterator[CorrelationContext]:
    """Restore the previous context even when the operation raises."""
    token = set_correlation_context(context)
    try:
        yield context
    finally:
        reset_correlation_context(token)
