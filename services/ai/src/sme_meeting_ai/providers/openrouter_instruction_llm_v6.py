"""Strict-schema OpenRouter V6 adapter; one bounded, non-streaming completion.

HTTP is read incrementally only to enforce byte/deadline limits. Error bodies are
never consumed, and no provider output is repaired, logged or echoed into errors.
"""

import time
import traceback
from collections.abc import Mapping
from decimal import Decimal
from typing import Self

import httpx
from pydantic import SecretStr

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.transcription.correction import (
    CorrectionError,
    CorrectionErrorCategory,
    CorrectionProviderResponse,
    CorrectionUsage,
    _strict_json,
)
from sme_meeting_ai.transcription.correction_v6_generation import (
    V6CorrectionRequest,
    V6GenerationError,
    V6GenerationReason,
    _provider_failure,
    _require_v6,
    _v6_configuration,
    _v6_request_payload,
    _validate_v6_request,
    _validate_v6_response,
)

from .openrouter_instruction_llm import (
    _ENDPOINT,
    _STATUS_CATEGORIES,
    _reported_cost,
)


def _provider_json(body: bytearray) -> object:
    reason = V6GenerationReason.INVALID_PROVIDER_JSON
    try:
        return _strict_json(body.decode("utf-8"), parse_float=Decimal)
    except UnicodeError as error:
        reason = V6GenerationReason.INVALID_UNICODE
        traceback.clear_frames(error.__traceback__)
    except (ValueError, OverflowError) as error:
        traceback.clear_frames(error.__traceback__)
    raise V6GenerationError(CorrectionErrorCategory.MALFORMED_OUTPUT, reason) from None


def _usage(data: dict) -> CorrectionUsage:
    category, reason = CorrectionErrorCategory.MALFORMED_OUTPUT, V6GenerationReason.INVALID_USAGE
    usage = data.get("usage")
    if usage is None:
        usage = {}
    _require_v6(type(usage) is dict, category, reason)
    details = usage.get("completion_tokens_details")
    if details is None:
        details = {}
    _require_v6(type(details) is dict, category, reason)
    try:
        return CorrectionUsage(usage.get("prompt_tokens"), usage.get("completion_tokens"), usage.get("total_tokens"),
                               _reported_cost(usage.get("cost")), details.get("reasoning_tokens"))
    except (ValueError, TypeError, OverflowError) as error:
        traceback.clear_frames(error.__traceback__)
    raise V6GenerationError(category, reason) from None


def _assistant_content(data: object) -> str:
    category = CorrectionErrorCategory.MALFORMED_OUTPUT
    _require_v6(type(data) is dict and "error" not in data, category, V6GenerationReason.INVALID_PROVIDER_ENVELOPE)
    choices = data.get("choices")
    _require_v6(type(choices) is list and len(choices) == 1 and type(choices[0]) is dict,
                category, V6GenerationReason.INVALID_CHOICES)
    choice = choices[0]
    _require_v6(choice.get("finish_reason") == "stop", category, V6GenerationReason.UNEXPECTED_FINISH_REASON)
    message = choice.get("message")
    _require_v6(type(message) is dict and message.get("role") == "assistant"
                and (message.get("tool_calls") is None or message.get("tool_calls") == [])
                and message.get("function_call") is None and message.get("refusal") is None,
                category, V6GenerationReason.INVALID_ASSISTANT_MESSAGE)
    text = message.get("content")
    _require_v6(type(text) is str and bool(text.strip()), category, V6GenerationReason.EMPTY_ASSISTANT_CONTENT)
    return text


class OpenRouterInstructionLlmV6Adapter:
    """Own or borrow a client; generation exclusively owns retries."""

    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self._settings = settings
        self._owns_client = client is None
        self._client = client if client is not None else httpx.Client(
            timeout=settings.transcript_correction_timeout_seconds, trust_env=False, follow_redirects=False,
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def complete(self, request: V6CorrectionRequest) -> CorrectionProviderResponse:
        """Remove private exception chains and frames before publishing diagnostics."""
        status = None
        try:
            return self._complete(request)
        except CorrectionError as error:
            failure = _provider_failure(error, 0)
            category, reason, status = failure.category, failure.reason, failure.http_status
            traceback.clear_frames(error.__traceback__)
        except httpx.TimeoutException as error:
            category, reason = CorrectionErrorCategory.TIMEOUT, V6GenerationReason.DEADLINE_EXCEEDED
            traceback.clear_frames(error.__traceback__)
        except httpx.HTTPError as error:
            category, reason = CorrectionErrorCategory.TRANSPORT, V6GenerationReason.TRANSPORT_ERROR
            traceback.clear_frames(error.__traceback__)
        except (MemoryError, RecursionError) as error:
            category, reason = CorrectionErrorCategory.RESOURCE, V6GenerationReason.RESOURCE_EXHAUSTED
            traceback.clear_frames(error.__traceback__)
        except Exception as error:
            category, reason = CorrectionErrorCategory.PROVIDER, V6GenerationReason.PROVIDER_FAILURE
            traceback.clear_frames(error.__traceback__)
        finally:
            request = None
        # Outside all handlers: even hidden __context__ must not retain HTTP data.
        raise V6GenerationError(category, reason, http_status=status) from None

    def _complete(self, request: V6CorrectionRequest) -> CorrectionProviderResponse:
        config = _v6_configuration(self._settings)
        self._validate_request(request, config)
        secret = self._settings.openrouter_api_key
        key = secret.get_secret_value() if isinstance(secret, SecretStr) else ""
        _require_v6(bool(key) and all(33 <= ord(char) <= 126 for char in key),
                    CorrectionErrorCategory.AUTHENTICATION, V6GenerationReason.AUTHENTICATION_FAILED)
        deadline = time.monotonic() + config["timeout_seconds"]
        with self._client.stream(
            "POST", _ENDPOINT, headers={"Authorization": f"Bearer {key}"},
            json=_v6_request_payload(request), timeout=config["timeout_seconds"], follow_redirects=False,
        ) as response:
            self._check_deadline(deadline)
            if not response.is_success:
                # A 400 alone does not prove unsupported schema. Status is the
                # only retained evidence; never read the private error body.
                raise V6GenerationError(
                    _STATUS_CATEGORIES.get(response.status_code, CorrectionErrorCategory.PROVIDER),
                    V6GenerationReason.HTTP_REQUEST_REJECTED, http_status=response.status_code,
                )
            body = bytearray()
            for part in response.iter_bytes():
                self._check_deadline(deadline)
                _require_v6(len(body) + len(part) <= config["max_response_bytes"],
                            CorrectionErrorCategory.RESOURCE, V6GenerationReason.RESPONSE_SIZE_EXCEEDED)
                body.extend(part)
            self._check_deadline(deadline)
        self._check_deadline(deadline)
        data = _provider_json(body)
        text = _assistant_content(data)
        normalized = CorrectionProviderResponse(text, "openrouter", request.model, data.get("model"), _usage(data))
        _validate_v6_response(normalized, request, config)
        self._check_deadline(deadline)
        return normalized

    @staticmethod
    def _validate_request(request: V6CorrectionRequest, config: Mapping) -> int:
        """Pin V6 identity; versioned adapters must override this dispatch hook."""
        return _validate_v6_request(request, config)

    @staticmethod
    def _check_deadline(deadline: float) -> None:
        _require_v6(time.monotonic() <= deadline, CorrectionErrorCategory.TIMEOUT, V6GenerationReason.DEADLINE_EXCEEDED)
