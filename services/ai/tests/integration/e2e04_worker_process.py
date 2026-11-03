"""Test-only real worker process for the isolated E2E-04 acceptance."""

import asyncio
import json
import sys

from test_worker_live_acceptance import ControlledExecution, controlled_pipeline

from sme_meeting_ai.core.config import ConfigurationError, Environment, load_settings
from sme_meeting_ai.integrations.core_api import CoreApiClient, CoreError
from sme_meeting_ai.observability.logging import configure_logging
from sme_meeting_ai.workers.__main__ import run_worker
from sme_meeting_ai.workers.transcription import (
    TranscriptionExecution,
    TranscriptionWorker,
    WorkFailure,
)


def install_diagnostics():
    """Emit only bounded classifications and identifiers in this test process."""
    prepare = TranscriptionWorker._prepare
    handle = TranscriptionWorker.handle
    request = CoreApiClient.request
    terminal = {}

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
            if getattr(result, "durable", False):
                terminal[event.eventId] = {"state": result.state,
                                           "receiptId": (result.receipt or {}).get("receiptId")}
            if operation in ("fail", "complete"):
                print(f"E2E04_COMMAND operation={operation} status=200 state={result.state}", flush=True)
            return result
        except CoreError as error:
            if operation in ("fail", "complete"):
                print(f"E2E04_COMMAND operation={operation} status={error.status} code={error.code}", flush=True)
            raise

    async def observed_handle(self, delivery):
        class DeliveryObserver:
            def __getattr__(self, name):
                return getattr(delivery, name)

            async def ack(self):
                event_id = delivery.message_id
                observed = terminal.get(event_id)
                channel = delivery.channel
                identity = {"eventId": event_id, "deliveryTag": delivery.delivery_tag,
                            "channel": getattr(channel, "number", None),
                            "redelivered": delivery.redelivered, "terminal": observed}
                print("E2E04_ACK " + json.dumps({**identity, "operation": "invoked"}), flush=True)
                await delivery.ack()
                print("E2E04_ACK " + json.dumps({**identity, "operation": "client_completed"}), flush=True)

        await handle(self, DeliveryObserver())

    TranscriptionWorker._prepare = observed_prepare
    TranscriptionWorker.handle = observed_handle
    CoreApiClient.request = observed_request


def main() -> int:
    try:
        settings = load_settings(env_file=None)
        if settings.environment is not Environment.TEST:
            raise ConfigurationError("controlled E2E-04 requires test environment")
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
