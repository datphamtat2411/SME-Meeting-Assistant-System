"""Bounded synchronous OpenRouter instruction completion; exactly one HTTP call."""

import time
from typing import Self

import httpx

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.transcription.correction import (
    CorrectionError,
    CorrectionErrorCategory,
    CorrectionProviderResponse,
    CorrectionRequest,
    CorrectionUsage,
    _configuration,
    _request_payload,
    _require,
    _safe_response,
    _strict_json,
    _validate_request,
)

_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
_STATUS_CATEGORIES = {
    401: CorrectionErrorCategory.AUTHENTICATION,
    403: CorrectionErrorCategory.AUTHENTICATION,
    429: CorrectionErrorCategory.RATE_LIMIT,
    408: CorrectionErrorCategory.TIMEOUT,
    504: CorrectionErrorCategory.TIMEOUT,
    524: CorrectionErrorCategory.TIMEOUT,
    413: CorrectionErrorCategory.CONTEXT_OVERFLOW,
}


class OpenRouterInstructionLlmAdapter:
    """Own a bounded client or borrow one from the caller; never retry or log data."""

    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self._settings = settings
        self._owns_client = client is None
        self._client = client if client is not None else httpx.Client(
            timeout=settings.transcript_correction_timeout_seconds,
            trust_env=False,
            follow_redirects=False,
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def complete(self, request: CorrectionRequest) -> CorrectionProviderResponse:
        """Discard request-bearing HTTP errors and input-bearing parser exceptions."""
        try:
            return self._complete(request)
        except CorrectionError as error:
            category = error.category
        except httpx.TimeoutException:
            category = CorrectionErrorCategory.TIMEOUT
        except httpx.HTTPError:
            category = CorrectionErrorCategory.TRANSPORT
        except MemoryError:
            category = CorrectionErrorCategory.RESOURCE
        except (AttributeError, ValueError, TypeError, KeyError, OverflowError, RecursionError):
            category = CorrectionErrorCategory.MALFORMED_OUTPUT
        # Outside handlers: even formatted exception chains contain no diagnostics.
        raise CorrectionError(category)

    def _complete(self, request: CorrectionRequest) -> CorrectionProviderResponse:
        config = _configuration(self._settings)
        _validate_request(request, config)
        secret = self._settings.openrouter_api_key
        key = secret.get_secret_value() if secret is not None else ""
        _require(bool(key) and all(33 <= ord(char) <= 126 for char in key),
                 CorrectionErrorCategory.AUTHENTICATION)
        deadline = time.monotonic() + config["timeout_seconds"]
        with self._client.stream(
            "POST", _ENDPOINT, headers={"Authorization": f"Bearer {key}"},
            json=_request_payload(request), timeout=config["timeout_seconds"], follow_redirects=False,
        ) as response:
            if not response.is_success:
                # Error bodies can contain transcripts and provider internals.
                # Status alone is sufficient; never read or retain diagnostics.
                raise CorrectionError(_STATUS_CATEGORIES.get(response.status_code, CorrectionErrorCategory.PROVIDER))
            body = bytearray()
            for part in response.iter_bytes():
                _require(time.monotonic() <= deadline, CorrectionErrorCategory.TIMEOUT)
                _require(len(body) + len(part) <= config["max_response_bytes"], CorrectionErrorCategory.RESOURCE)
                body.extend(part)
        data = _strict_json(body)
        malformed = CorrectionErrorCategory.MALFORMED_OUTPUT
        _require(isinstance(data, dict) and "error" not in data, malformed)
        choices = data.get("choices")
        _require(isinstance(choices, list) and len(choices) == 1, malformed)
        choice = choices[0]
        _require(isinstance(choice, dict) and choice.get("finish_reason") == "stop", malformed)
        message = choice.get("message")
        _require(isinstance(message, dict) and message.get("role", "assistant") == "assistant"
                 and not message.get("tool_calls") and not message.get("function_call")
                 and not message.get("refusal"), malformed)
        text = message.get("content")
        _require(isinstance(text, str) and bool(text.strip()), malformed)
        usage = data.get("usage")
        if usage is None:
            usage = {}
        _require(isinstance(usage, dict), malformed)
        normalized = CorrectionProviderResponse(
            text, "openrouter", request.model, data.get("model"),
            CorrectionUsage(usage.get("prompt_tokens"), usage.get("completion_tokens"), usage.get("total_tokens")),
        )
        _safe_response(normalized, request, config)
        return normalized
