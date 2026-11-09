"""Test-only combined transcription and deterministic Meeting Intelligence worker."""

import asyncio
import os
import time
from contextlib import AsyncExitStack

from test_worker_live_acceptance import controlled_pipeline

from sme_meeting_ai.core.config import ConfigurationError, Environment, load_settings
from sme_meeting_ai.observability.logging import configure_logging
from sme_meeting_ai.workers.__main__ import run_worker
from sme_meeting_ai.workers.intelligence import IntelligenceExecution
from sme_meeting_ai.workers.transcription import TranscriptionExecution


def install_acceptance_response_loss():
    if os.environ.get("AI_MI_TEST_LOSE_ACCEPTANCE_RESPONSE") != "1":
        return
    from sme_meeting_ai.integrations.core_api import CoreError
    from sme_meeting_ai.integrations.intelligence import IntelligenceCoreClient

    original = IntelligenceCoreClient.accept
    state = {"lost": False}

    async def accept(self, event, claim_token, digest, **kwargs):
        result = await original(self, event, claim_token, digest, **kwargs)
        if not state["lost"]:
            state["lost"] = True
            raise CoreError()
        return result

    IntelligenceCoreClient.accept = accept


def deterministic_summary(context):
    delay = float(os.environ.get("AI_MI_TEST_PROCESSOR_DELAY_SECONDS", "0"))
    deadline = time.monotonic() + max(0, delay)
    while time.monotonic() < deadline:
        if context.cancelled.is_set():
            return {"producer": {"model": "e2e04-deterministic", "promptVersion": "1"},
                    "result": {"content": "Fenced execution", "warnings": ["SOURCE_QUALITY_WARNING"]}}
        time.sleep(min(0.05, deadline - time.monotonic()))
    return {"producer": {"model": "e2e04-deterministic", "promptVersion": "1"},
            "result": {"content": "Cuộc họp đã thống nhất kế hoạch triển khai.", "warnings": []}}


class IntegratedExecution:
    def __init__(self, settings):
        self.transcription = TranscriptionExecution(settings, pipeline_factory=controlled_pipeline)
        self.intelligence = IntelligenceExecution(settings, {
            "GENERATING_SUMMARY": deterministic_summary,
        })
        self.resources = AsyncExitStack()

    async def __aenter__(self):
        try:
            await self.resources.enter_async_context(self.transcription)
            await self.resources.enter_async_context(self.intelligence)
            return self
        except BaseException:
            await self.resources.aclose()
            raise

    async def __call__(self, shutdown_requested):
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(self.transcription(shutdown_requested))
            tasks.create_task(self.intelligence(shutdown_requested))

    async def __aexit__(self, *_):
        await self.resources.aclose()


def main():
    try:
        settings = load_settings(env_file=None)
        if settings.environment is not Environment.TEST:
            raise ConfigurationError("isolated intelligence acceptance requires test environment")
        install_acceptance_response_loss()
        configure_logging(settings)
        execution = IntegratedExecution(settings)
        return asyncio.run(run_worker(settings, execution, (lambda: execution,)))
    except ConfigurationError:
        return 1
    except KeyboardInterrupt:
        return 0
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
