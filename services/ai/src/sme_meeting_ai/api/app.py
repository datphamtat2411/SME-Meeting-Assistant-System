"""Application construction with explicit, application-local lifecycle state."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException

from sme_meeting_ai.core.config import (
    ConfigurationError,
    Environment,
    Settings,
    get_settings,
)
from sme_meeting_ai.core.runtime import RuntimeState
from sme_meeting_ai.observability import configure_logging

from .assistant import AssistantRequestSizeMiddleware
from .assistant import router as assistant_router
from .errors import (
    http_exception_handler,
    unexpected_exception_handler,
    validation_exception_handler,
)
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
    assistant_service=None,
) -> FastAPI:
    """Construct the runtime without initializing logging or external services."""
    if settings is None:
        settings = get_settings()
    runtime = RuntimeState()
    effective_assistant_service = assistant_service
    if settings.environment in {Environment.STAGING, Environment.PRODUCTION} and not getattr(
        assistant_service, "production_ready", False
    ):
        effective_assistant_service = None
    demo_jobs = None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        nonlocal demo_jobs
        try:
            if settings.environment in {Environment.STAGING, Environment.PRODUCTION}:
                if not identity_source_available(identity_source):
                    raise ConfigurationError("Internal service security unavailable")
            configure_logging(settings)
            if settings.demo_available:
                from sme_meeting_ai.demo.jobs import DemoJobManager
                from sme_meeting_ai.demo.pipeline import build_demo_runner

                # Startup does real VAD/provider initialization, without running
                # inference or connecting to production worker infrastructure.
                initialization = asyncio.create_task(asyncio.to_thread(build_demo_runner, settings))
                try:
                    runner = await asyncio.shield(initialization)
                except asyncio.CancelledError:
                    def close_initialized(future):
                        if not future.cancelled() and future.exception() is None:
                            try:
                                future.result().close()
                            except Exception:
                                pass
                    initialization.add_done_callback(close_initialized)
                    raise
                try:
                    demo_jobs = DemoJobManager(settings, runner)
                except Exception:
                    try:
                        runner.close()
                    except Exception:
                        pass
                    raise ConfigurationError("Demo job initialization failed") from None
                app.state.demo_jobs = demo_jobs
                demo_jobs.start()
            runtime.initialized = True
            yield
        finally:
            runtime.initialized = False
            if demo_jobs is not None:
                await demo_jobs.aclose()
            if effective_assistant_service is not None:
                close = getattr(effective_assistant_service, "aclose", None)
                if callable(close):
                    result = close()
                    if asyncio.iscoroutine(result):
                        await result

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
    app.state.assistant_service = effective_assistant_service
    app.add_middleware(RequestMiddleware)
    app.include_router(router)
    app.include_router(assistant_router)
    app.add_middleware(AssistantRequestSizeMiddleware, limit=settings.assistant_max_request_bytes)
    if settings.demo_available:
        from .demo import DemoRequestMiddleware
        from .demo import router as demo_router

        app.add_middleware(DemoRequestMiddleware, settings=settings)
        app.include_router(demo_router)
    return app
