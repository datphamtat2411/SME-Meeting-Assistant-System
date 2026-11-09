"""The two AI worker capabilities share deployment and lifecycle, not handlers."""

import asyncio
from contextlib import AsyncExitStack

from .diarization import DiarizationExecution
from .intelligence import IntelligenceExecution
from .transcription import TranscriptionExecution


class AiWorkerExecution:
    def __init__(self, settings):
        self.transcription = TranscriptionExecution(settings)
        self.diarization = DiarizationExecution(settings)
        self.intelligence = IntelligenceExecution(settings)
        self.resources = AsyncExitStack()

    async def __aenter__(self):
        try:
            await self.resources.enter_async_context(self.transcription)
            await self.resources.enter_async_context(self.diarization)
            await self.resources.enter_async_context(self.intelligence)
            return self
        except BaseException:
            await self.resources.aclose()
            raise

    async def __call__(self, shutdown_requested):
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(self.transcription(shutdown_requested))
            tasks.create_task(self.diarization(shutdown_requested))
            tasks.create_task(self.intelligence(shutdown_requested))

    async def __aexit__(self, *_):
        await self.resources.aclose()
