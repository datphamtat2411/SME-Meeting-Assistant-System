"""Independent worker entrypoint: python -m sme_meeting_ai.workers."""

import asyncio
import signal
import sys

from sme_meeting_ai.core.config import ConfigurationError, Settings, load_settings
from sme_meeting_ai.observability.logging import configure_logging

from .execution import AiWorkerExecution
from .intelligence import IntelligenceExecution
from .knowledge_indexing import KnowledgeIndexingExecution
from .runtime import ResourceFactory, WorkerExecution, WorkerRuntime
from .transcription import TranscriptionExecution

_ROLE_IDENTITIES = {
    "transcription": "ai-worker",
    "meeting-intelligence": "mi-worker",
    "knowledge-indexing": "knowledge-worker",
}


def build_execution(settings: Settings) -> WorkerExecution:
    """Select exactly one capability for an explicitly role-bound worker."""
    role = settings.worker_role
    if role is None:
        # Existing test and development callers may still exercise the
        # historical composition. Isolated run environments always provide a
        # role and are rejected below if its capability gates are ambiguous.
        if settings.diarization_worker_enabled or settings.meeting_intelligence_worker_enabled:
            return AiWorkerExecution(settings)
        if settings.knowledge_indexing_worker_enabled:
            return KnowledgeIndexingExecution(settings)
        return TranscriptionExecution(settings)

    if settings.service_identity != _ROLE_IDENTITIES[role]:
        raise RuntimeError("worker identity does not match worker role")
    if role == "transcription":
        if (
            settings.knowledge_indexing_worker_enabled
            or settings.meeting_intelligence_worker_enabled
            or settings.meeting_intelligence_inference_enabled
            or settings.meeting_intelligence_decision_enabled
        ):
            raise RuntimeError("worker capability gates are not isolated")
        # The deployed transcription role owns the optional diarization route
        # and its worker identity. It still uses separate S3 write credentials.
        return AiWorkerExecution(settings) if settings.diarization_worker_enabled else TranscriptionExecution(settings)
    if role == "meeting-intelligence":
        required_gates = {
            "worker": settings.meeting_intelligence_worker_enabled,
            "inference": settings.meeting_intelligence_inference_enabled,
            "summary": settings.meeting_intelligence_summary_enabled,
            "decisions": settings.meeting_intelligence_decision_enabled,
            "action_items": settings.meeting_intelligence_action_item_enabled,
        }
        if settings.knowledge_indexing_worker_enabled:
            raise RuntimeError("worker capability gates are not isolated")
        missing = [name for name, enabled in required_gates.items() if not enabled]
        if missing:
            raise RuntimeError(
                "meeting-intelligence capability gate is disabled: "
                + ",".join(missing)
            )
        return IntelligenceExecution(settings)
    if (
        not settings.knowledge_indexing_worker_enabled
        or settings.meeting_intelligence_worker_enabled
        or settings.meeting_intelligence_inference_enabled
        or settings.meeting_intelligence_decision_enabled
    ):
        raise RuntimeError("worker capability gates are not isolated")
    return KnowledgeIndexingExecution(settings)


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
        execution = build_execution(settings)
        return asyncio.run(run_worker(settings, execution, (lambda: execution,)))
    except KeyboardInterrupt:
        return 0
    except Exception:
        sys.stderr.write("worker.runtime.failed\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
