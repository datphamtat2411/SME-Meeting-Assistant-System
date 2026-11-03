"""Test-only real worker process for the isolated E2E-04 acceptance."""

import asyncio
import sys

from test_worker_live_acceptance import ControlledExecution, controlled_pipeline

from sme_meeting_ai.core.config import ConfigurationError, load_settings
from sme_meeting_ai.integrations.core_api import CoreApiClient, CoreError
from sme_meeting_ai.observability.logging import configure_logging
from sme_meeting_ai.workers.__main__ import run_worker
from sme_meeting_ai.workers.transcription import TranscriptionExecution, TranscriptionWorker, WorkFailure


def install_diagnostics():
    """Emit only bounded classifications and identifiers in this test process."""
    prepare = TranscriptionWorker._prepare
    request = CoreApiClient.request

    def observed_prepare(self, claim, fence):
        try:
            return prepare(self, claim, fence)
        except WorkFailure as failure:
            print(f"E2E04_WORK_FAILURE job={claim.processingJobId} event={claim.eventId} "
                  f"stage={claim.executionStageRunId} phase={failure.phase} category={failure.category} "
                  f"completed_through={failure.completed_through}", flush=True)
            raise

    async def observed_request(self, event, operation, body=None, **options):
        try:
            result = await request(self, event, operation, body, **options)
            if operation in ("fail", "complete"):
                print(f"E2E04_COMMAND operation={operation} status=200 state={result.state}", flush=True)
            return result
        except CoreError as error:
            if operation in ("fail", "complete"):
                print(f"E2E04_COMMAND operation={operation} status={error.status} code={error.code}", flush=True)
            raise

    TranscriptionWorker._prepare = observed_prepare
    CoreApiClient.request = observed_request


def main() -> int:
    try:
        settings = load_settings(env_file=None)
        install_diagnostics()
        configure_logging(settings)
        execution = TranscriptionExecution(settings, pipeline_factory=controlled_pipeline)
        return asyncio.run(run_worker(settings, ControlledExecution(execution), (lambda: execution,)))
    except ConfigurationError:
        sys.stderr.write("e2e04.worker.configuration.failed\n")
        return 1
    except KeyboardInterrupt:
        return 0
    except Exception:
        sys.stderr.write("e2e04.worker.runtime.failed\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
