import asyncio
import hashlib
import json

from intelligence_support import settings, snapshot
from unit.test_intelligence_worker import lifecycle
from unit.test_summary import ScriptedAdapter, _responsive_output

from sme_meeting_ai.meeting_intelligence.summary import SummaryProcessor
from sme_meeting_ai.workers.intelligence import IntelligenceWorker


def test_real_summary_processor_runs_through_t02_worker_boundary():
    async def run():
        worker_settings, core, storage, delivery, _ = lifecycle()
        owned = await core.claim(None)
        data = snapshot((
            "Mục tiêu là rà soát API trước khi triển khai.",
            "Nhóm thống nhất kiểm thử API trước triển khai.",
        ))
        transcript = data["transcript"]
        transcript.update(
            id=owned.source.transcriptId,
            meetingId=owned.meetingId,
            sourceMediaId=owned.sourceMediaId,
            processingJobId=owned.processingJobId,
            contentRevision=owned.source.contentRevision,
        )
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
        owned = owned.model_copy(update={"source": owned.source.model_copy(update={
            "sizeBytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
        })})
        core.state = "AVAILABLE"

        async def claim(*args, **kwargs):
            core.state = "RUNNING"
            return owned

        core.claim = claim
        storage.get_intelligence_snapshot = lambda *args: raw
        config = settings()
        adapter = ScriptedAdapter(_responsive_output)
        processor = SummaryProcessor(config, adapter)
        worker = IntelligenceWorker(worker_settings, core, storage, {
            "GENERATING_SUMMARY": processor,
        })
        try:
            await worker.handle(delivery)
            assert delivery.acked and core.accepts == 1 and core.failures == 0
            payload = json.loads(storage.artifact)
            assert payload["resultType"] == "SUMMARY"
            assert payload["source"]["contentRevision"] == owned.source.contentRevision
            assert "API" in payload["result"]["content"]
            assert len(adapter.requests) == 1
        finally:
            await worker.aclose()

    asyncio.run(run())
