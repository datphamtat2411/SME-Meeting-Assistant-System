import asyncio
import json
import logging
import signal
from contextlib import asynccontextmanager

import pytest

from sme_meeting_ai.core.config import ConfigurationError, Settings
from sme_meeting_ai.observability.context import (
    correlation_scope,
    get_correlation_context,
    new_correlation_context,
)
from sme_meeting_ai.observability.logging import JsonFormatter
from sme_meeting_ai.workers import __main__ as entrypoint
from sme_meeting_ai.workers.runtime import WorkerLifecycleState, WorkerRuntime


def settings(**overrides):
    return Settings(
        service_name="test-ai", service_identity="ai-worker", _env_file=None,
        **overrides,
    )


def test_lifecycle_ordering_and_reverse_cleanup():
    async def scenario():
        events = []

        def resource(name):
            @asynccontextmanager
            async def factory():
                assert runtime.state is WorkerLifecycleState.STARTING
                events.append(f"open.{name}")
                try:
                    yield
                finally:
                    assert runtime.state is WorkerLifecycleState.STOPPING
                    events.append(f"close.{name}")
            return factory

        async def execute(stop):
            assert runtime.state is WorkerLifecycleState.RUNNING
            events.append("execute")

        runtime = WorkerRuntime(settings(), execute, [resource("one"), resource("two")])
        assert runtime.state is WorkerLifecycleState.CREATED
        assert await runtime.run() == 0
        assert runtime.state is WorkerLifecycleState.STOPPED
        await asyncio.gather(runtime.shutdown(), runtime.shutdown())
        assert events == ["open.one", "open.two", "execute", "close.two", "close.one"]

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["startup", "execution", "cleanup"])
def test_failures_unwind_resources_and_are_sanitized(failure, caplog):
    async def scenario():
        closed = []

        @asynccontextmanager
        async def first():
            try:
                yield
            finally:
                closed.append("first")

        @asynccontextmanager
        async def second():
            if failure == "startup":
                raise RuntimeError("private-startup")
            try:
                yield
            finally:
                closed.append("second")
                if failure == "cleanup":
                    raise RuntimeError("private-cleanup")

        async def execute(stop):
            if failure == "execution":
                raise RuntimeError("private-execution")

        runtime = WorkerRuntime(settings(), execute, [first, second])
        assert await runtime.run() == 1
        assert runtime.state is WorkerLifecycleState.FAILED
        assert closed == (["first"] if failure == "startup" else ["second", "first"])

    with caplog.at_level(logging.INFO, logger="sme_meeting_ai"):
        asyncio.run(scenario())
    assert "private-" not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_missing_execution_fails_before_resource_initialization():
    def forbidden():
        pytest.fail("resource initialized without execution")

    runtime = WorkerRuntime(settings(), resource_factories=[forbidden])
    assert asyncio.run(runtime.run()) == 1
    assert runtime.state is WorkerLifecycleState.FAILED


def test_explicit_start_execute_and_concurrent_shutdown():
    async def scenario():
        closed = []

        @asynccontextmanager
        async def resource():
            try:
                yield
            finally:
                await asyncio.sleep(0)
                closed.append(True)

        async def execute(stop):
            runtime.request_shutdown()

        runtime = WorkerRuntime(settings(), execute, [resource])
        await runtime.start()
        assert runtime.state is WorkerLifecycleState.RUNNING
        await runtime.execute()
        await asyncio.gather(runtime.shutdown(), runtime.shutdown())
        assert closed == [True]
        assert runtime.state is WorkerLifecycleState.STOPPED

    asyncio.run(scenario())


def test_shutdown_during_startup_unwinds_acquired_resources():
    async def scenario():
        acquiring = asyncio.Event()
        closed = []

        @asynccontextmanager
        async def first():
            try:
                yield
            finally:
                closed.append(True)

        @asynccontextmanager
        async def second():
            acquiring.set()
            await asyncio.Event().wait()
            yield

        async def execute(stop):
            pytest.fail("executed after interrupted startup")

        runtime = WorkerRuntime(
            settings(worker_shutdown_timeout_seconds=0.02), execute, [first, second],
        )
        task = asyncio.create_task(runtime.run())
        await acquiring.wait()
        runtime.request_shutdown()
        assert await asyncio.wait_for(task, 0.5) == 1
        assert closed == [True]
        assert runtime.state is WorkerLifecycleState.FAILED

    asyncio.run(scenario())


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_signals_request_shutdown_and_restore_handlers(monkeypatch, signum):
    handlers = {sig: object() for sig in (signal.SIGTERM, signal.SIGINT)}
    original = handlers.copy()
    monkeypatch.setattr(signal, "getsignal", handlers.__getitem__)
    monkeypatch.setattr(signal, "signal", lambda sig, handler: handlers.__setitem__(sig, handler))

    async def execute(stop):
        handlers[signum](signum, None)
        handlers[signum](signum, None)
        await stop.wait()

    assert asyncio.run(entrypoint.run_worker(settings(), execute)) == 0
    assert handlers == original


def test_cancellation_releases_resources():
    async def scenario():
        running = asyncio.Event()
        closed = []

        @asynccontextmanager
        async def resource():
            try:
                yield
            finally:
                closed.append(True)

        async def execute(stop):
            running.set()
            await stop.wait()

        runtime = WorkerRuntime(settings(), execute, [resource])
        task = asyncio.create_task(runtime.run())
        await running.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed == [True]
        assert runtime.state is WorkerLifecycleState.STOPPED

    asyncio.run(scenario())


@pytest.mark.parametrize("hang", ["execution", "cleanup"])
def test_shutdown_timeout_is_bounded_and_tasks_are_reaped(hang):
    async def scenario():
        running = asyncio.Event()
        released = []

        @asynccontextmanager
        async def resource():
            try:
                yield
            finally:
                try:
                    if hang == "cleanup":
                        await asyncio.Event().wait()
                finally:
                    released.append(True)

        async def execute(stop):
            running.set()
            if hang == "execution":
                await asyncio.Event().wait()
            else:
                await stop.wait()

        runtime = WorkerRuntime(
            settings(worker_shutdown_timeout_seconds=0.02), execute, [resource],
        )
        task = asyncio.create_task(runtime.run())
        await running.wait()
        runtime.request_shutdown()
        runtime.request_shutdown()
        assert await asyncio.wait_for(task, 0.5) == 1
        assert released == [True]
        assert runtime.state is WorkerLifecycleState.FAILED
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]

    asyncio.run(scenario())


def test_cleanup_timeout_still_closes_earlier_resources():
    async def scenario():
        closed = []

        @asynccontextmanager
        async def first():
            try:
                yield
            finally:
                closed.append("first")

        @asynccontextmanager
        async def second():
            try:
                yield
            finally:
                await asyncio.Event().wait()

        async def execute(stop):
            pass

        runtime = WorkerRuntime(
            settings(worker_shutdown_timeout_seconds=0.02), execute, [first, second],
        )
        assert await asyncio.wait_for(runtime.run(), 0.5) == 1
        assert closed == ["first"]

    asyncio.run(scenario())


def test_lifecycle_logs_use_safe_schema_and_restore_context():
    records = []
    formatter = JsonFormatter("test-ai")

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(json.loads(formatter.format(record)))

    logger = logging.getLogger("sme_meeting_ai.workers.runtime")
    handler = Capture()
    old_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    async def execute(stop):
        assert get_correlation_context() is not None

    parent = new_correlation_context()
    try:
        with correlation_scope(parent):
            assert asyncio.run(WorkerRuntime(settings(), execute).run()) == 0
            assert get_correlation_context() is parent
    finally:
        logger.removeHandler(handler)
        logger.setLevel(old_level)
    assert [r["event"] for r in records] == [
        "worker.starting", "worker.started", "worker.shutdown.requested", "worker.stopped",
    ]
    assert len({r["trace_id"] for r in records}) == 1
    assert records[0]["trace_id"] != parent.trace_id
    assert all(set(r) == {
        "timestamp", "severity", "event", "service", "trace_id", "span_id", "trace_flags",
    } for r in records)


def test_entrypoint_validates_before_logging(monkeypatch, capsys):
    def invalid():
        raise ConfigurationError("Invalid configuration: service_identity: missing")

    monkeypatch.setattr(entrypoint, "load_settings", invalid)
    monkeypatch.setattr(entrypoint, "configure_logging", lambda _: pytest.fail("logging before validation"))
    assert entrypoint.main() == 1
    assert capsys.readouterr().err == "worker.configuration.failed\n"


def test_entrypoint_missing_registration_returns_nonzero(monkeypatch):
    monkeypatch.setattr(entrypoint, "load_settings", settings)
    monkeypatch.setattr(entrypoint, "configure_logging", lambda _: None)
    assert entrypoint.main() == 1
