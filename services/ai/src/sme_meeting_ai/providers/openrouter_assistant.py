"""Cancellable, structured OpenRouter Chat Completions for the Assistant only."""

from __future__ import annotations

import asyncio
import json
import re
import time
from decimal import Decimal

import httpx
from pydantic import ValidationError

from sme_meeting_ai.assistant.context import (
    CONTEXTUALIZATION_SYSTEM_INSTRUCTIONS,
    GROUNDING_SYSTEM_INSTRUCTIONS,
    AssistantSettings,
    estimate_prompt_tokens,
    grounding_user_payload,
)
from sme_meeting_ai.assistant.contracts import (
    ContextualizedQuestion,
    GeneratedAnswer,
    GenerationResult,
    GroundingContext,
    ModelProvenance,
)
from sme_meeting_ai.assistant.errors import AssistantProviderError
from sme_meeting_ai.core.config import Settings

_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
_MODEL_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$"
_TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504, 524}


def _strict_json(raw: bytes, maximum: int) -> object:
    if len(raw) > maximum or raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError
            result[key] = value
        return result

    return json.loads(
        raw.decode("utf-8"),
        object_pairs_hook=pairs,
        parse_float=Decimal,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
    )


def _usage(value: object, output_budget: int) -> tuple[int | None, int | None, int | None]:
    if value is None:
        return None, None, None
    if not isinstance(value, dict):
        raise ValueError
    details = value.get("completion_tokens_details") or {}
    if not isinstance(details, dict):
        raise ValueError
    counts = (value.get("prompt_tokens"), value.get("completion_tokens"), value.get("total_tokens"))
    if any(count is not None and (type(count) is not int or not 0 <= count <= 2**63 - 1) for count in counts):
        raise ValueError
    incoming, outgoing, total = counts
    reasoning = details.get("reasoning_tokens")
    if reasoning is not None and (type(reasoning) is not int or not 0 <= reasoning <= 2**63 - 1):
        raise ValueError
    if outgoing is not None and outgoing > output_budget:
        raise ValueError
    if reasoning is not None and outgoing is not None and reasoning > outgoing:
        raise ValueError
    if total is not None and incoming is not None and outgoing is not None and total != incoming + outgoing:
        raise ValueError
    return incoming, outgoing, total


def _status_category(status: int) -> tuple[str, bool]:
    if status in {401, 403}:
        return "AUTHENTICATION", False
    if status == 413:
        return "CONTEXT_BUDGET", False
    if status in {408, 504, 524}:
        return "TIMEOUT", True
    if status == 429:
        return "RATE_LIMIT", True
    return "PROVIDER", status in _TRANSIENT_STATUS


class OpenRouterAssistantAdapter:
    """One managed async client, bounded retries, and no detached provider tasks."""

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.config = AssistantSettings.from_settings(settings)
        self._transport = transport
        self._closed = False
        self._slots = asyncio.BoundedSemaphore(self.config.max_concurrent_requests)
        self._client = httpx.AsyncClient(
            timeout=self.config.provider_timeout_seconds,
            trust_env=False,
            follow_redirects=False,
            transport=transport,
            limits=httpx.Limits(
                max_connections=self.config.max_concurrent_requests,
                max_keepalive_connections=self.config.max_concurrent_requests,
            ),
        )

    async def __aenter__(self) -> "OpenRouterAssistantAdapter":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    def close(self) -> None:
        """Synchronous close marker; the HTTP resource is closed by ``aclose``."""

        self._closed = True

    async def aclose(self) -> None:
        self._closed = True
        await self._client.aclose()

    def _key(self) -> str:
        secret = self.settings.openrouter_api_key
        key = "" if secret is None else secret.get_secret_value()
        if not key or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise AssistantProviderError("AUTHENTICATION")
        return key

    def _preflight(self, context_payload: dict[str, object], output_budget: int) -> str:
        if self._closed:
            raise AssistantProviderError("CONFIGURATION")
        if not self.settings.assistant_inference_enabled:
            raise AssistantProviderError("INFERENCE_DISABLED")
        if not re.fullmatch(_MODEL_PATTERN, self.config.model):
            raise AssistantProviderError("CONFIGURATION")
        if not 0 < output_budget <= self.config.max_output_tokens:
            raise AssistantProviderError("CONFIGURATION")
        if estimate_prompt_tokens(context_payload) + self.config.provider_overhead_tokens > self.config.max_input_tokens:
            raise AssistantProviderError("CONTEXT_BUDGET")
        return self._key()

    @staticmethod
    def _payload(
        *,
        system: str,
        user: object,
        schema_name: str,
        schema: dict[str, object],
        model: str,
        output_budget: int,
        reasoning_effort: str,
    ) -> dict[str, object]:
        return {
            "model": model,
            "stream": False,
            "max_tokens": output_budget,
            "reasoning": {"effort": reasoning_effort},
            "provider": {"require_parameters": True, "allow_fallbacks": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "strict": True, "schema": schema},
            },
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user, ensure_ascii=False, sort_keys=True)},
            ],
        }

    async def _attempt(
        self,
        payload: dict[str, object],
        key: str,
        deadline: float,
        output_budget: int,
    ) -> dict[str, object]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssistantProviderError("TIMEOUT", retryable=True)
        timeout = min(self.config.provider_timeout_seconds, remaining)
        try:
            async with self._client.stream(
                "POST",
                _ENDPOINT,
                headers={"Authorization": f"Bearer {key}", "Accept-Encoding": "identity"},
                json=payload,
                timeout=timeout,
            ) as response:
                if not response.is_success:
                    category, retryable = _status_category(response.status_code)
                    raise AssistantProviderError(category, retryable=retryable)
                if response.headers.get("content-encoding", "identity").lower() not in {"identity", ""}:
                    raise AssistantProviderError("RESOURCE")
                content_length = response.headers.get("content-length")
                if content_length is not None and (
                    not content_length.isascii()
                    or not content_length.isdigit()
                    or int(content_length) > self.config.max_response_bytes
                ):
                    raise AssistantProviderError("RESOURCE")
                body = bytearray()
                async for part in response.aiter_bytes(chunk_size=min(65_536, self.config.max_response_bytes + 1)):
                    if len(body) + len(part) > self.config.max_response_bytes:
                        raise AssistantProviderError("RESOURCE")
                    body.extend(part)
            parsed = _strict_json(bytes(body), self.config.max_response_bytes)
            if not isinstance(parsed, dict) or "error" in parsed:
                raise AssistantProviderError("MALFORMED_OUTPUT")
            choices = parsed.get("choices")
            if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
                raise AssistantProviderError("MALFORMED_OUTPUT")
            choice = choices[0]
            if choice.get("finish_reason") not in {"stop", "completed"}:
                raise AssistantProviderError("INCOMPLETE_OUTPUT")
            message = choice.get("message")
            if not isinstance(message, dict) or message.get("role", "assistant") != "assistant":
                raise AssistantProviderError("MALFORMED_OUTPUT")
            if message.get("refusal") or message.get("tool_calls") or message.get("function_call"):
                raise AssistantProviderError("MALFORMED_OUTPUT")
            content = message.get("content")
            if not isinstance(content, str) or not content.strip():
                raise AssistantProviderError("MALFORMED_OUTPUT")
            incoming, outgoing, total = _usage(parsed.get("usage"), output_budget)
            reported_model = parsed.get("model")
            if reported_model is not None and (
                not isinstance(reported_model, str) or re.fullmatch(_MODEL_PATTERN, reported_model) is None
            ):
                raise AssistantProviderError("MALFORMED_OUTPUT")
            return {
                "content": content,
                "input_tokens": incoming,
                "output_tokens": outgoing,
                "total_tokens": total,
                "reported_model": reported_model,
            }
        except AssistantProviderError:
            raise
        except (httpx.TimeoutException, TimeoutError):
            raise AssistantProviderError("TIMEOUT", retryable=True) from None
        except httpx.HTTPError:
            raise AssistantProviderError("TRANSPORT", retryable=True) from None
        except (ValueError, TypeError, KeyError, ValidationError):
            raise AssistantProviderError("MALFORMED_OUTPUT") from None

    async def _complete(
        self,
        payload: dict[str, object],
        key: str,
        *,
        output_budget: int,
        deadline: float,
    ) -> tuple[dict[str, object], int]:
        acquired = False
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssistantProviderError("TIMEOUT", retryable=True)
            try:
                await asyncio.wait_for(self._slots.acquire(), timeout=remaining)
                acquired = True
            except asyncio.TimeoutError:
                raise AssistantProviderError("TIMEOUT", retryable=True) from None
            failed: list[str] = []
            for attempt in range(1, self.config.max_attempts + 1):
                try:
                    return await self._attempt(payload, key, deadline, output_budget), attempt
                except AssistantProviderError as error:
                    if not error.retryable or attempt == self.config.max_attempts:
                        raise
                    failed.append(error.category)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise AssistantProviderError("TIMEOUT", retryable=True) from None
                    await asyncio.sleep(min(0.05, remaining))
            raise AssistantProviderError("PROVIDER", retryable=True)
        finally:
            if acquired:
                self._slots.release()

    @staticmethod
    def _provenance(data: dict[str, object], config: AssistantSettings, attempts: int) -> ModelProvenance:
        return ModelProvenance(
            provider="openrouter",
            configuredModel=config.model,
            reportedModel=data.get("reported_model"),
            reasoningEffort=config.reasoning_effort,
            inputTokens=data.get("input_tokens"),
            outputTokens=data.get("output_tokens"),
            totalTokens=data.get("total_tokens"),
            attempts=attempts,
        )

    async def generate(self, context: GroundingContext, *, deadline: float) -> GenerationResult:
        user = grounding_user_payload(context)
        payload = self._payload(
            system=GROUNDING_SYSTEM_INSTRUCTIONS,
            user=user,
            schema_name="sme_assistant_grounded_answer_v1",
            schema=GeneratedAnswer.model_json_schema(by_alias=True),
            model=self.config.model,
            output_budget=self.config.max_output_tokens,
            reasoning_effort=self.config.reasoning_effort,
        )
        key = self._preflight(payload, self.config.max_output_tokens)
        data, attempts = await self._complete(
            payload, key, output_budget=self.config.max_output_tokens, deadline=deadline
        )
        try:
            answer = GeneratedAnswer.model_validate(_strict_json(data["content"].encode("utf-8"), 256_000))
            return GenerationResult(answer=answer, provenance=self._provenance(data, self.config, attempts))
        except (ValueError, TypeError, KeyError, ValidationError):
            raise AssistantProviderError("MALFORMED_OUTPUT") from None

    async def contextualize(
        self,
        question: str,
        conversation,
        *,
        deadline: float,
    ) -> ContextualizedQuestion:
        user = {
            "current_question": question,
            "dialogue_context": [
                {"role": message.role.value, "content": message.content} for message in conversation
            ],
        }
        payload = self._payload(
            system=CONTEXTUALIZATION_SYSTEM_INSTRUCTIONS,
            user=user,
            schema_name="sme_assistant_standalone_question_v1",
            schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "standaloneQuestion": {"type": "string", "minLength": 1, "maxLength": 4096},
                },
                "required": ["standaloneQuestion"],
            },
            model=self.config.model,
            output_budget=min(256, self.config.max_output_tokens),
            reasoning_effort=self.config.reasoning_effort,
        )
        contextualization_budget = min(256, self.config.max_output_tokens)
        key = self._preflight(payload, contextualization_budget)
        data, attempts = await self._complete(
            payload, key, output_budget=contextualization_budget, deadline=deadline
        )
        try:
            parsed = _strict_json(data["content"].encode("utf-8"), 64_000)
            if not isinstance(parsed, dict):
                raise ValueError
            question_result = ContextualizedQuestion(
                standaloneQuestion=parsed["standaloneQuestion"],
                provenance=self._provenance(data, self.config, attempts),
            )
            return question_result
        except (ValueError, TypeError, KeyError, ValidationError):
            raise AssistantProviderError("MALFORMED_OUTPUT") from None


__all__ = ["OpenRouterAssistantAdapter"]
