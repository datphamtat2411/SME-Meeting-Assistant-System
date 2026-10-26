"""Independent worker entrypoint: python -m sme_meeting_ai.workers."""

import asyncio
import signal
import sys

from sme_meeting_ai.core.config import ConfigurationError, Settings, load_settings
from sme_meeting_ai.observability.logging import configure_logging

from .runtime import ResourceFactory, WorkerExecution, WorkerRuntime


async def run_worker(
    settings: Settings,
    execution: WorkerExecution | None = None,
    resource_factories: tuple[ResourceFactory, ...] = (),
) -> int:
    runtime = WorkerRuntime(settings, execution, resource_factories)
    loop = asyncio.get_running_loop()
    previous = {}

    def request_shutdown(signum, frame):
        loop.call_soon_threadsafe(runtime.request_shutdown)

    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, request_shutdown)
        return await runtime.run()
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def main() -> int:
    try:
        settings = load_settings()
    except ConfigurationError:
        sys.stderr.write("worker.configuration.failed\n")
        return 1
    configure_logging(settings)
    try:
        # Intentionally unregistered until a real worker execution is supplied.
        return asyncio.run(run_worker(settings))
    except KeyboardInterrupt:
        return 0
    except Exception:
        sys.stderr.write("worker.runtime.failed\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
