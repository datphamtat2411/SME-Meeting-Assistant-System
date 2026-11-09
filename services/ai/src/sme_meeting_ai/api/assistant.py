"""Trusted Core API boundary for synchronous grounded Assistant answers."""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, Request
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from sme_meeting_ai.assistant import (
    AssistantAnswer,
    AssistantAnswerStatus,
    AssistantDiagnostics,
    AssistantFailure,
    AssistantFailureCategory,
    AssistantRequest,
)

from .errors import error_response
from .security import require_internal_operation

ASSISTANT_OPERATION = "assistant.answers"
ASSISTANT_PATH = "/internal/v1/assistant/answers"
router = APIRouter(prefix="/internal/v1/assistant")


_MESSAGES = {
    AssistantFailureCategory.FEATURE_UNAVAILABLE: "Assistant capability is unavailable",
    AssistantFailureCategory.DEPENDENCY_UNAVAILABLE: "Assistant dependencies are unavailable",
    AssistantFailureCategory.REQUEST_TIMEOUT: "Assistant request timed out",
    AssistantFailureCategory.PROVIDER_TIMEOUT: "Assistant generation timed out",
    AssistantFailureCategory.PROVIDER_UNAVAILABLE: "Assistant generation provider is unavailable",
}


def _failed(request_id: str, category: AssistantFailureCategory, *, retryable: bool = False) -> AssistantAnswer:
    return AssistantAnswer(
        requestId=request_id,
        status=AssistantAnswerStatus.FAILED,
        diagnostics=AssistantDiagnostics(),
        failures=(
            AssistantFailure(
                category=category,
                code=category.value,
                retryable=retryable,
                message=_MESSAGES.get(category, "Assistant operation failed"),
            ),
        ),
    )


def _http_status(result: AssistantAnswer) -> int:
    if result.status is not AssistantAnswerStatus.FAILED:
        return 200
    category = result.failures[0].category
    if category is AssistantFailureCategory.INVALID_AUTHORIZATION:
        return 403
    if category in {AssistantFailureCategory.REQUEST_TIMEOUT, AssistantFailureCategory.PROVIDER_TIMEOUT}:
        return 504
    if category is AssistantFailureCategory.INVALID_REQUEST:
        return 422
    return 503


class AssistantRequestSizeMiddleware:
    """Bound Assistant request bytes even when the client uses chunked transfer."""

    def __init__(self, app: ASGIApp, *, limit: int):
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != ASSISTANT_PATH:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        content_length = headers.get("content-length")
        if content_length is not None and (
            not content_length.isascii()
            or not content_length.isdecimal()
            or len(content_length) > 20
            or int(content_length) > self.limit
        ):
            await error_response(413, "payload_too_large", "Assistant request is too large.")(scope, receive, send)
            return

        received = 0

        async def bounded_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.limit:
                    raise HTTPException(413)
            return message

        await self.app(scope, bounded_receive, send)


@router.post(
    "/answers",
    response_model=AssistantAnswer,
    dependencies=[Depends(require_internal_operation(ASSISTANT_OPERATION))],
)
async def answer(request: Request, payload: AssistantRequest) -> JSONResponse:
    settings = request.app.state.settings
    service = getattr(request.app.state, "assistant_service", None)
    provider_configured = settings.openrouter_api_key is not None and bool(
        settings.openrouter_api_key.get_secret_value()
    )
    if (
        not settings.assistant_enabled
        or not settings.assistant_inference_enabled
        or not provider_configured
        or service is None
        or not getattr(service, "ready", False)
    ):
        result = _failed(payload.request_id, AssistantFailureCategory.FEATURE_UNAVAILABLE)
        return JSONResponse(result.model_dump(mode="json", by_alias=True), status_code=503)

    deadline = time.monotonic() + settings.assistant_request_timeout_seconds
    try:
        async with asyncio.timeout(settings.assistant_request_timeout_seconds):
            result = await service.answer(payload, deadline=deadline)
    except asyncio.TimeoutError:
        result = _failed(payload.request_id, AssistantFailureCategory.REQUEST_TIMEOUT, retryable=True)
    except asyncio.CancelledError:
        raise
    except Exception:
        result = _failed(payload.request_id, AssistantFailureCategory.DEPENDENCY_UNAVAILABLE, retryable=True)
    return JSONResponse(result.model_dump(mode="json", by_alias=True), status_code=_http_status(result))


__all__ = ["ASSISTANT_OPERATION", "AssistantRequestSizeMiddleware", "router"]
