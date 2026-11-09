"""Scoped cancellable OpenRouter Chat Completions for Meeting Intelligence only."""

import asyncio
import logging
import time
from dataclasses import asdict, replace
from decimal import Decimal
from fractions import Fraction
from threading import BoundedSemaphore, Event

import httpx

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.meeting_intelligence.context import PLANNING_VERSION, ContextLimits
from sme_meeting_ai.meeting_intelligence.contracts import (
    MODEL_PATTERN,
    ModelRequest,
    ModelResult,
    ModelUsage,
    digest,
    estimate_input_tokens,
    identifier,
    request_payload,
    strict_json,
)
from sme_meeting_ai.meeting_intelligence.errors import (
    IntelligenceError,
    check_authority,
    require,
)
from sme_meeting_ai.observability.logging import log_event

_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
_POLL_SECONDS = 0.02
_TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504, 524}
logger = logging.getLogger(__name__)


class _AttemptError(IntelligenceError):
    def __init__(self, category, retryable=False):
        super().__init__(category)
        self.retryable = retryable


def _status_category(status):
    if status in {401, 403}:
        return "AUTHENTICATION"
    if status in {400, 404, 405, 415, 422}:
        return "UNSUPPORTED_PARAMETERS"
    if status == 413:
        return "CONTEXT_BUDGET"
    if status == 429:
        return "RATE_LIMIT"
    if status in {408, 504, 524}:
        return "TIMEOUT"
    return "PROVIDER"


def _usage(data, output_budget):
    if data is None:
        data = {}
    require(isinstance(data, dict), "MALFORMED_OUTPUT")
    details = data.get("completion_tokens_details")
    if details is None:
        details = {}
    require(isinstance(details, dict), "MALFORMED_OUTPUT")
    counts = [data.get("prompt_tokens"), data.get("completion_tokens"),
              data.get("total_tokens"), details.get("reasoning_tokens")]
    for count in counts:
        require(count is None or (type(count) is int and 0 <= count <= 2**63 - 1), "MALFORMED_OUTPUT")
    incoming, outgoing, total, reasoning = counts
    require(outgoing is None or outgoing <= output_budget, "MALFORMED_OUTPUT")
    require(reasoning is None or outgoing is None or reasoning <= outgoing, "MALFORMED_OUTPUT")
    require(total is None or incoming is None or outgoing is None or total == incoming + outgoing, "MALFORMED_OUTPUT")
    cost = data.get("cost")
    if cost is not None:
        require(type(cost) in (int, Decimal)
                and (type(cost) is int or (cost.is_finite() and -18 <= cost.adjusted() <= 12
                                          and len(cost.as_tuple().digits) <= 64))
                and 0 <= cost <= 10**12, "MALFORMED_OUTPUT")
        cost = Fraction(cost)
    return ModelUsage(incoming, outgoing, total, reasoning, cost)


def _normalize(raw, request):
    data = strict_json(raw, parse_float=Decimal)
    require(isinstance(data, dict), "MALFORMED_OUTPUT")
    require("error" not in data, "PROVIDER")
    choices = data.get("choices")
    require(isinstance(choices, list) and len(choices) == 1 and isinstance(choices[0], dict), "MALFORMED_OUTPUT")
    choice = choices[0]
    require(choice.get("finish_reason") == "stop"
            and choice.get("native_finish_reason") in {None, "stop", "completed"}, "INCOMPLETE_OUTPUT")
    message = choice.get("message")
    require(isinstance(message, dict) and message.get("role", "assistant") == "assistant", "MALFORMED_OUTPUT")
    require(not message.get("refusal"), "REFUSAL")
    require(not message.get("tool_calls") and not message.get("function_call"), "MALFORMED_OUTPUT")
    content = message.get("content")
    require(isinstance(content, str) and bool(content.strip()), "MALFORMED_OUTPUT")
    output = request.task.schema.parse(content)
    reported_model, reported_provider = data.get("model"), data.get("provider")
    require(reported_model is None or identifier(reported_model, MODEL_PATTERN), "MALFORMED_OUTPUT")
    require(reported_provider is None or identifier(reported_provider, MODEL_PATTERN), "MALFORMED_OUTPUT")
    return ModelResult(output, request.model, request.reasoning_effort, reported_model, "openrouter", reported_provider,
        request.task.prompt_version, request.task.schema.version, request.task.schema.sha256,
        request.window.source, request.window.window_id, request.window.planning_version,
        request.window.configuration_sha256, request.task.sha256,
        request.window.estimated_input_tokens, _usage(data.get("usage"), request.output_budget), 0, 0, ())


class OpenRouterIntelligenceAdapter:
    """Worker-thread synchronous interface; no detached threads or persistent loops.

    Every call owns an async client and cancels/awaits its in-flight HTTP task on
    deadline, lease loss, shutdown or close. The adapter bounds concurrent calls;
    clients/connections are scoped to a call and shared only across its retries.
    `transport` is an explicitly injected test transport, owned by scoped clients.
    """

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None):
        self._settings = settings
        self._transport = transport
        self._closed = Event()
        self._slots = BoundedSemaphore(settings.meeting_intelligence_max_concurrent_requests)

    def __enter__(self):
        require(not self._closed.is_set(), "CONFIGURATION")
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        self._closed.set()

    def _check(self, request):
        check_authority(request.deadline, request.cancelled)
        require(not self._closed.is_set(), "CONFIGURATION")

    def _preflight(self, request):
        s = self._settings
        self._check(request)
        require(s.meeting_intelligence_inference_enabled, "INFERENCE_DISABLED")
        require(request.model == s.meeting_intelligence_model
                and request.reasoning_effort == s.meeting_intelligence_reasoning_effort, "CONFIGURATION")
        require(type(request.input_budget) is int and 0 < request.input_budget <= s.meeting_intelligence_max_input_tokens
                and type(request.output_budget) is int and 0 < request.output_budget <= s.meeting_intelligence_max_output_tokens
                and request.input_budget + request.output_budget <= s.meeting_intelligence_context_window_tokens,
                "CONTEXT_BUDGET")
        require(request.task.sha256 == request.window.task_sha256, "CONFIGURATION")
        expected_configuration = digest({"limits": asdict(ContextLimits.from_settings(s)),
            "model": request.model, "reasoning_effort": request.reasoning_effort,
            "planning_version": PLANNING_VERSION})
        require(request.window.planning_version == PLANNING_VERSION
                and request.window.configuration_sha256 == expected_configuration, "CONFIGURATION")
        payload = request_payload(request)
        estimate = estimate_input_tokens(payload)
        require(estimate <= request.input_budget and estimate == request.window.estimated_input_tokens, "CONTEXT_BUDGET")
        secret = s.openrouter_api_key
        key = "" if secret is None else secret.get_secret_value()
        require(bool(key) and all(33 <= ord(char) <= 126 for char in key), "AUTHENTICATION")
        return payload, key

    def complete(self, request: ModelRequest) -> ModelResult:
        """Only sanitized errors escape; never retain HTTP/parser exception chains."""
        category, acquired = "CONFIGURATION", False
        result = None
        try:
            payload, key = self._preflight(request)
            # Called by the established synchronous T02 processor, never its event loop.
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                pass
            else:
                raise IntelligenceError("CONFIGURATION")
            while not acquired:
                self._check(request)
                acquired = self._slots.acquire(timeout=min(_POLL_SECONDS, max(0, request.deadline - time.monotonic())))
            self._check(request)
            result = asyncio.run(self._run(request, payload, key))
            usage = result.usage
            duration_ms = int(max(0, min(86400000, result.duration_seconds * 1000)))
            log_event(logger, logging.INFO, "worker.intelligence.provider.completed",
                      duration_ms=duration_ms, input_tokens=usage.input_tokens,
                      output_tokens=usage.output_tokens, total_tokens=usage.total_tokens,
                      reasoning_tokens=usage.reasoning_tokens,
                      reserved_tokens=request.window.estimated_input_tokens + request.output_budget,
                      attempts=result.attempts)
            return result
        except IntelligenceError as error:
            category = error.category
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError, OverflowError):
            category = "MALFORMED_OUTPUT"
        except MemoryError:
            category = "RESOURCE"
        except Exception:
            category = "PROVIDER"
        finally:
            if acquired:
                self._slots.release()
            if result is None:
                log_event(logger, logging.WARNING, "worker.intelligence.provider.failed",
                          reserved_tokens=(request.window.estimated_input_tokens + request.output_budget
                                           if hasattr(request, "window") and hasattr(request, "output_budget")
                                           else None))
        raise IntelligenceError(category)

    async def _run(self, request, payload, key):
        started, failed = time.monotonic(), []
        s = self._settings
        async with httpx.AsyncClient(timeout=s.meeting_intelligence_provider_timeout_seconds,
                trust_env=False, follow_redirects=False, transport=self._transport,
                limits=httpx.Limits(max_connections=1, max_keepalive_connections=1)) as client:
            for attempt in range(1, s.meeting_intelligence_max_attempts + 1):
                self._check(request)
                try:
                    result = await self._controlled_attempt(client, request, payload, key)
                except _AttemptError as error:
                    category, retryable = error.category, error.retryable
                else:
                    self._check(request)
                    return replace(result, duration_seconds=time.monotonic() - started, attempts=attempt,
                                   failed_attempt_categories=tuple(failed))
                self._check(request)
                failed.append(category)
                if not retryable or attempt == s.meeting_intelligence_max_attempts:
                    raise IntelligenceError(category)
                # Small finite backoff, governed by the same authority/deadline.
                until = time.monotonic() + 0.05
                while time.monotonic() < until:
                    self._check(request)
                    await asyncio.sleep(min(_POLL_SECONDS, until - time.monotonic()))
        raise IntelligenceError("PROVIDER")

    async def _controlled_attempt(self, client, request, payload, key):
        timeout = min(self._settings.meeting_intelligence_provider_timeout_seconds,
                      request.deadline - time.monotonic())
        self._check(request)
        attempt_deadline = time.monotonic() + timeout
        task = asyncio.create_task(self._attempt(client, request, payload, key, timeout))
        try:
            while True:
                self._check(request)
                remaining = attempt_deadline - time.monotonic()
                if remaining <= 0:
                    raise _AttemptError("TIMEOUT", True)
                done, _ = await asyncio.wait({task}, timeout=min(_POLL_SECONDS, remaining))
                self._check(request)
                if done:
                    return task.result()
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _attempt(self, client, request, payload, key, timeout):
        try:
            async with client.stream("POST", _ENDPOINT,
                    headers={"Authorization": f"Bearer {key}", "Accept-Encoding": "identity"},
                    json=payload, timeout=timeout, follow_redirects=False) as response:
                if not response.is_success:
                    # Do not read provider error bodies: they may echo sensitive inputs.
                    raise _AttemptError(_status_category(response.status_code), response.status_code in _TRANSIENT_STATUS)
                require(response.headers.get("content-encoding", "identity").lower() in {"identity", ""}, "RESOURCE")
                size = response.headers.get("content-length")
                maximum = self._settings.meeting_intelligence_max_response_bytes
                if size is not None:
                    require(size.isascii() and size.isdigit() and int(size) <= maximum, "RESOURCE")
                body = bytearray()
                async for part in response.aiter_bytes(chunk_size=min(65536, maximum + 1)):
                    self._check(request)
                    require(len(body) + len(part) <= maximum, "RESOURCE")
                    body.extend(part)
            self._check(request)
            return _normalize(body, request)
        except httpx.TimeoutException:
            category = "TIMEOUT"
        except httpx.HTTPError:
            category = "TRANSPORT"
        else:
            raise IntelligenceError("PROVIDER")
        raise _AttemptError(category, True)
