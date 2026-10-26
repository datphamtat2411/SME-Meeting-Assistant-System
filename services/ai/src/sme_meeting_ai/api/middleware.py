"""Pure ASGI request correlation and allowlisted lifecycle logging."""

import logging

from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from sme_meeting_ai.observability import (
    correlation_scope,
    format_traceparent,
    log_event,
    new_correlation_context,
)

from .errors import unexpected_exception_handler

logger = logging.getLogger("sme_meeting_ai.http")


class RequestMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        context = new_correlation_context(
            traceparent=headers.get("traceparent"),
            request_id=headers.get("x-request-id"),
            job_id=headers.get("x-job-id"),
        )
        response_started = False
        status = 500

        async def send_response(message: Message) -> None:
            nonlocal response_started, status
            if message["type"] == "http.response.start":
                response_started = True
                status = message["status"]
                outgoing = MutableHeaders(scope=message)
                outgoing["traceparent"] = format_traceparent(context)
                # Never let an inner response bypass identifier validation.
                if "x-request-id" in outgoing:
                    del outgoing["x-request-id"]
                if context.request_id is not None:
                    outgoing["x-request-id"] = context.request_id
            await send(message)

        with correlation_scope(context):
            log_event(logger, logging.INFO, "http.request.started")
            try:
                await self.app(scope, receive, send_response)
            except Exception as exc:
                log_event(logger, logging.ERROR, "http.request.failed")
                if response_started:
                    raise
                # Handle failures inside the correlation scope so 500 responses
                # receive the same safe propagation headers and cleanup.
                response = await unexpected_exception_handler(Request(scope), exc)
                await response(scope, receive, send_response)
            else:
                if status >= 500:
                    log_event(logger, logging.ERROR, "http.request.failed")
                else:
                    log_event(logger, logging.INFO, "http.request.completed")
