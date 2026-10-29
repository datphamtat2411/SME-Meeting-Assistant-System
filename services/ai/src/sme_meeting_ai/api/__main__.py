"""Independent HTTP process: sme-ai-http or python -m sme_meeting_ai.api."""

import signal
import sys

import uvicorn

from sme_meeting_ai.core.config import ConfigurationError, load_settings

from .app import create_app
from .tls import MTLSIdentitySource, MTLSProtocol, load_tls_context


def main() -> int:
    try:
        settings = load_settings()
    except ConfigurationError:
        sys.stderr.write("http.configuration.failed\n")
        return 1

    previous = {}
    try:
        tls_context = load_tls_context(settings)
        identity_source = MTLSIdentitySource() if tls_context is not None else None
        server = uvicorn.Server(uvicorn.Config(
            create_app(settings, identity_source=identity_source),
            host=settings.http_host,
            port=settings.http_port,
            workers=1,
            reload=False,
            access_log=False,
            proxy_headers=False,
            forwarded_allow_ips=[],
            lifespan="on",
            log_level="critical",
            timeout_graceful_shutdown=settings.http_shutdown_timeout_seconds,
            http=MTLSProtocol if tls_context is not None else "h11",
            ws="none",
            ssl_context_factory=(lambda config, default: tls_context) if tls_context is not None else None,
        ))
        # Uvicorn restores and replays signals after graceful shutdown. Keep the
        # replay graceful too, including when running as the container's PID 1.
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, server.handle_exit)
        server.run()
        if server.started:
            return 0
    except (Exception, SystemExit):
        pass
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)

    sys.stderr.write("http.runtime.failed\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
