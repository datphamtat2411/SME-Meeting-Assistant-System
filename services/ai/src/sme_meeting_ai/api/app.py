"""Application construction with explicit, application-local lifecycle state."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException

from sme_meeting_ai.core.config import ConfigurationError, Environment, Settings, get_settings
from sme_meeting_ai.core.runtime import RuntimeState
from sme_meeting_ai.observability import configure_logging

from .errors import http_exception_handler, unexpected_exception_handler, validation_exception_handler
from .health import router
from .middleware import RequestMiddleware
from .security import (
    OperationPolicy,
    TrustedIdentitySource,
    identity_source_available,
    snapshot_policy,
)


def create_app(
    settings: Settings | None = None,
    *,
    identity_source: TrustedIdentitySource | None = None,
    operation_policy: OperationPolicy | None = None,
) -> FastAPI:
    """Construct the runtime without initializing logging or external services."""
    if settings is None:
        settings = get_settings()
    runtime = RuntimeState()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            if settings.environment in {Environment.STAGING, Environment.PRODUCTION}:
                if not identity_source_available(identity_source):
                    raise ConfigurationError("Internal service security unavailable")
            configure_logging(settings)
            runtime.initialized = True
            yield
        finally:
            runtime.initialized = False

    app = FastAPI(
        debug=False,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        exception_handlers={
            HTTPException: http_exception_handler,
            RequestValidationError: validation_exception_handler,
            Exception: unexpected_exception_handler,
        },
    )
    app.state.settings = settings
    app.state.runtime = runtime
    app.state.identity_source = identity_source
    app.state.operation_policy = snapshot_policy(operation_policy)
    app.add_middleware(RequestMiddleware)
    app.include_router(router)
    return app
