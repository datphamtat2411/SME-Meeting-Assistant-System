import asyncio
import hashlib
import json

from intelligence_support import settings, snapshot
from unit.test_decision import ScriptedAdapter, _fixture, _fixture_callback
from unit.test_intelligence_worker import lifecycle

from sme_meeting_ai.integrations.intelligence import IntelligenceStatus
from sme_meeting_ai.meeting_intelligence.decision import DecisionProcessor
from sme_meeting_ai.workers.intelligence import IntelligenceWorker


def test_real_decision_processor_runs_through_t02_worker_boundary_and_serializer():
    async def run():
        worker_settings, core, storage, delivery, _ = lifecycle()
        owned = await core.claim(None)
        fixture = _fixture("explicit-agreement")
        data = snapshot(tuple(fixture["segments"]))
        transcript = data["transcript"]
        transcript.update(
            id=owned.source.transcriptId,
            meetingId=owned.meetingId,
            sourceMediaId=owned.sourceMediaId,
            processingJobId=owned.processingJobId,
            contentRevision=owned.source.contentRevision,
        )
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
        owned = owned.model_copy(update={
            "executionStageCode": "EXTRACTING_DECISIONS",
            "source": owned.source.model_copy(update={
                "sizeBytes": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
            }),
        })
        core.state = "AVAILABLE"

        async def claim(*args, **kwargs):
            core.state = "RUNNING"
            return owned

        async def lookup(event, **kwargs):
            return IntelligenceStatus.model_validate({
                "contractVersion": "1.0",
                "processingJobId": event.processingJobId,
                "eventId": event.eventId,
                "executionStageRunId": event.executionStageRunId,
                "executionStageCode": event.executionStageCode,
                "state": core.state,
                "acknowledge": core.state in ("RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED"),
                **(
                    {"errorCode": "INTELLIGENCE_VALIDATION", "retryable": False}
                    if core.state == "FAILURE_RECORDED" else {}
                ),
            })

        core.claim = claim
        core.lookup = lookup
        delivery_body = json.loads(delivery.body)
        delivery_body["executionStageCode"] = "EXTRACTING_DECISIONS"
        delivery.body = json.dumps(delivery_body).encode()
        storage.get_intelligence_snapshot = lambda *args: raw
        processor = DecisionProcessor(settings(), ScriptedAdapter(_fixture_callback(fixture)))
        worker = IntelligenceWorker(worker_settings, core, storage, {
            "EXTRACTING_DECISIONS": processor,
        })
        try:
            await worker.handle(delivery)
            assert delivery.acked and core.accepts == 1 and core.failures == 0
            payload = json.loads(storage.artifact)
            assert payload["resultType"] == "DECISION_EXTRACTION"
            assert payload["result"]["candidates"][0]["uncertainty"] == "NONE"
            assert payload["source"]["contentRevision"] == owned.source.contentRevision
            assert payload["result"]["candidates"][0]["evidenceSegmentIds"]
        finally:
            await worker.aclose()

    asyncio.run(run())
