"""Worker lifecycle and resource ownership, independent of HTTP and job transport."""

import asyncio
import logging
from collections.abc import Iterable
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from enum import StrEnum
from typing import Protocol

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.observability.context import (
    correlation_scope,
    new_correlation_context,
)
from sme_meeting_ai.observability.logging import log_event

logger = logging.getLogger(__name__)


class WorkerLifecycleState(StrEnum):
    CREATED = "created"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


class WorkerExecution(Protocol):
    """Execution returns normally or cooperates with shutdown and cancellation."""

    async def __call__(self, shutdown_requested: asyncio.Event) -> None: ...


class ResourceFactory(Protocol):
    """Create a runtime-owned asynchronous resource with cancellable cleanup."""

    def __call__(self) -> AbstractAsyncContextManager[object]: ...


class WorkerRuntime:
    def __init__(
        self,
        settings: Settings,
        execution: WorkerExecution | None = None,
        resource_factories: Iterable[ResourceFactory] = (),
    ) -> None:
        self.settings = settings
        self.state = WorkerLifecycleState.CREATED
        self._execution = execution
        self._factories = tuple(resource_factories)
        self._resources = AsyncExitStack()
        self._stop = asyncio.Event()
        self._work: asyncio.Task[None] | None = None
        self._shutdown_task: asyncio.Task[None] | None = None
        self._failed = False
        self._cleanup_deadline = 0.0

    def _failure(self, event: str) -> None:
        self._failed = True
        log_event(logger, logging.ERROR, event)

    async def start(self) -> None:
        """Initialize in order; retain ownership of every successful acquisition."""
        if self.state is not WorkerLifecycleState.CREATED:
            raise RuntimeError("Worker cannot start in its current state")
        self.state = WorkerLifecycleState.STARTING
        log_event(logger, logging.INFO, "worker.starting")
        if self._execution is None:
            self._failure("worker.execution.missing")
        else:
            try:
                for factory in self._factories:
                    if self._stop.is_set():
                        return
                    resource = factory()
                    await resource.__aenter__()
                    self._resources.push_async_exit(self._resource_exit(resource))
                if self._stop.is_set():
                    return
                self.state = WorkerLifecycleState.RUNNING
                log_event(logger, logging.INFO, "worker.started")
                return
            except Exception:
                self._failure("worker.startup.failed")
        # No infrastructure exception or input-bearing context crosses the boundary.
        raise RuntimeError("Worker startup failed")

    def _resource_exit(self, resource: AbstractAsyncContextManager[object]):
        async def close(exc_type, exc, traceback):
            try:
                # All exits share one cleanup deadline. Even after expiry, enter
                # each exit so synchronous/finally cleanup can still run.
                async with asyncio.timeout_at(self._cleanup_deadline):
                    await resource.__aexit__(exc_type, exc, traceback)
            except TimeoutError:
                self._failure("worker.cleanup.timeout")
            except asyncio.CancelledError:
                self._failure("worker.cleanup.cancelled")
            except Exception:
                self._failure("worker.cleanup.failed")
            return False

        return close

    async def execute(self) -> None:
        """Invoke only the registered execution hook, after successful startup."""
        if self.state is not WorkerLifecycleState.RUNNING or self._execution is None:
            raise RuntimeError("Worker is not running")
        try:
            await self._execution(self._stop)
        except Exception:
            self._failure("worker.execution.failed")

    async def _start_and_execute(self) -> None:
        try:
            await self.start()
            if self.state is WorkerLifecycleState.RUNNING and not self._stop.is_set():
                await self.execute()
        except RuntimeError:
            # start() has already recorded a sanitized failure.
            if not self._failed:
                self._failure("worker.startup.failed")

    def request_shutdown(self) -> None:
        """Idempotent event-loop-local notification; performs no cleanup."""
        if not self._stop.is_set():
            self._stop.set()
            log_event(logger, logging.INFO, "worker.shutdown.requested")

    async def _shutdown(self) -> None:
        self.request_shutdown()
        self.state = WorkerLifecycleState.STOPPING
        try:
            if self._work is not None:
                try:
                    await asyncio.wait_for(
                        asyncio.shield(self._work),
                        self.settings.worker_shutdown_timeout_seconds,
                    )
                except TimeoutError:
                    self._failure("worker.execution.timeout")
                    self._work.cancel()
                    # Cancellation acknowledgement must also be bounded; a
                    # misbehaving hook must not prevent resource shutdown.
                    done, pending = await asyncio.wait(
                        (self._work,),
                        timeout=self.settings.worker_shutdown_timeout_seconds,
                    )
                    if pending:
                        self._failure("worker.execution.cancellation.timeout")
                    if done:
                        await asyncio.gather(*done, return_exceptions=True)
                except asyncio.CancelledError:
                    pass
        finally:
            self._cleanup_deadline = (
                asyncio.get_running_loop().time()
                + self.settings.worker_shutdown_timeout_seconds
            )
            await self._resources.aclose()
            self.state = (
                WorkerLifecycleState.FAILED if self._failed else WorkerLifecycleState.STOPPED
            )
            log_event(
                logger, logging.ERROR if self._failed else logging.INFO,
                "worker.failed" if self._failed else "worker.stopped",
            )

    async def shutdown(self) -> None:
        """Share one cleanup operation across repeated or concurrent callers."""
        if self._shutdown_task is None:
            self._shutdown_task = asyncio.create_task(self._shutdown())
        await asyncio.shield(self._shutdown_task)

    async def run(self) -> int:
        """Run to completion or shutdown, restoring the caller's correlation scope."""
        if self.state is not WorkerLifecycleState.CREATED or self._work is not None:
            raise RuntimeError("Worker runtime can only run once")
        with correlation_scope(new_correlation_context()):
            self._work = asyncio.create_task(self._start_and_execute())
            requested = asyncio.create_task(self._stop.wait())
            try:
                await asyncio.wait(
                    (self._work, requested), return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                requested.cancel()
                await asyncio.gather(requested, return_exceptions=True)
                await self.shutdown()
            return int(self._failed)
