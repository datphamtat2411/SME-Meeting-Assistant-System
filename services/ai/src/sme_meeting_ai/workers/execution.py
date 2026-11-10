"""The two AI worker capabilities share deployment and lifecycle, not handlers."""

import asyncio
from contextlib import AsyncExitStack

from .diarization import DiarizationExecution
from .intelligence import IntelligenceExecution
from .knowledge_indexing import KnowledgeIndexingExecution
from .transcription import TranscriptionExecution


class AiWorkerExecution:
    def __init__(self, settings):
        self.transcription = TranscriptionExecution(settings)
        self.diarization = DiarizationExecution(settings)
        self.intelligence = IntelligenceExecution(settings)
        self.knowledge = KnowledgeIndexingExecution(settings) if settings.knowledge_indexing_worker_enabled else None
        self.resources = AsyncExitStack()

    async def __aenter__(self):
        try:
            await self.resources.enter_async_context(self.transcription)
            await self.resources.enter_async_context(self.diarization)
            await self.resources.enter_async_context(self.intelligence)
            if self.knowledge is not None:
                await self.resources.enter_async_context(self.knowledge)
            return self
        except BaseException:
            await self.resources.aclose()
            raise

    async def __call__(self, shutdown_requested):
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(self.transcription(shutdown_requested))
            tasks.create_task(self.diarization(shutdown_requested))
            tasks.create_task(self.intelligence(shutdown_requested))
            if self.knowledge is not None:
                tasks.create_task(self.knowledge(shutdown_requested))

    async def __aexit__(self, *_):
        await self.resources.aclose()
