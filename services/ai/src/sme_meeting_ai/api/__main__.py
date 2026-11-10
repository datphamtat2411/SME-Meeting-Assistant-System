"""Independent HTTP process: sme-ai-http or python -m sme_meeting_ai.api."""

import signal
import sys

import uvicorn

from sme_meeting_ai.assistant.runtime import build_assistant_service
from sme_meeting_ai.core.config import ConfigurationError, load_settings
from sme_meeting_ai.rag.runtime import (
    RetrievalRuntime,
    build_qdrant_audit_store,
    build_retrieval_runtime,
)

from .app import create_app
from .tls import MTLSIdentitySource, MTLSProtocol, load_tls_context


def main() -> int:
    try:
        settings = load_settings()
    except ConfigurationError:
        sys.stderr.write("http.configuration.failed\n")
        return 1

    previous = {}
    retrieval_runtime: RetrievalRuntime | None = None
    audit_store = None
    try:
        tls_context = load_tls_context(settings)
        identity_source = MTLSIdentitySource() if tls_context is not None else None
        assistant_service = None
        if settings.assistant_enabled:
            retrieval_runtime = build_retrieval_runtime(settings)
            assistant_service = build_assistant_service(
                settings,
                retrieval_engine=retrieval_runtime.engine,
                trusted_runtime=True,
            )
        if settings.knowledge_indexing_reconciliation_enabled:
            audit_store = retrieval_runtime.store if retrieval_runtime is not None else build_qdrant_audit_store(settings)
        server = uvicorn.Server(uvicorn.Config(
            create_app(
                settings,
                identity_source=identity_source,
                operation_policy={
                    "assistant.answers": {"core-api"},
                    "knowledge.reconciliation": {"core-api"},
                },
                assistant_service=assistant_service,
                knowledge_vector_store=audit_store,
            ),
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
        if retrieval_runtime is not None:
            retrieval_runtime.close()
        elif audit_store is not None:
            audit_store.close()
        for signum, handler in previous.items():
            signal.signal(signum, handler)

    sys.stderr.write("http.runtime.failed\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
