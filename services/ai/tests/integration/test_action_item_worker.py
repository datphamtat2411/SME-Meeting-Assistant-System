import asyncio
import hashlib
import json

import httpx
import pytest
from intelligence_support import settings, snapshot
from unit.test_action_items import FIXTURES, scripted
from unit.test_intelligence_worker import lifecycle

from sme_meeting_ai.integrations.core_api import CoreError
from sme_meeting_ai.integrations.intelligence import (
    IntelligenceCoreClient,
    IntelligenceStatus,
)
from sme_meeting_ai.meeting_intelligence.action_item_contract import (
    prepare_action_item_request,
)
from sme_meeting_ai.meeting_intelligence.action_items import ActionItemProcessor
from sme_meeting_ai.workers.intelligence import IntelligenceWorker


async def action_lifecycle(empty=False):
    conf, core, storage, delivery, _ = lifecycle()
    owned = await core.claim(None)
    fixture = next(f for f in FIXTURES if f["name"] == ("empty" if empty else "explicit-assignment"))
    data = snapshot(tuple(fixture["segments"]))
    data["transcript"].update(id=owned.source.transcriptId, meetingId=owned.meetingId,
        sourceMediaId=owned.sourceMediaId, processingJobId=owned.processingJobId)
    raw = json.dumps(data, ensure_ascii=False).encode()
    owned = owned.model_copy(update=dict(executionStageCode="EXTRACTING_ACTION_ITEMS", resultSlot=None,
        source=owned.source.model_copy(update=dict(sizeBytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))))
    core.state = "AVAILABLE"
    async def claim(*args, **kwargs):
        core.claims += 1
        core.state = "RUNNING"
        return owned
    async def lookup(event, **kwargs):
        return IntelligenceStatus.model_validate(dict(contractVersion="1.0", processingJobId=owned.processingJobId,
            eventId=owned.eventId, executionStageRunId=owned.executionStageRunId,
            executionStageCode=owned.executionStageCode, state=core.state,
            acknowledge=core.state in ("RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED"),
            **(dict(errorCode="INTELLIGENCE_VALIDATION", retryable=False) if core.state == "FAILURE_RECORDED" else {})))
    core.claim, core.lookup = claim, lookup
    event = json.loads(delivery.body)
    event["executionStageCode"] = owned.executionStageCode
    delivery.body = json.dumps(event).encode()
    storage.get_intelligence_snapshot = lambda *args: raw
    return conf, core, storage, delivery, owned, data, fixture


@pytest.mark.parametrize("mode", ["normal", "empty", "lost", "retry", "uncertain", "auth", "reject"])
def test_action_branch_reconciles_and_reuses_prepared_bytes(mode):
    async def run():
        conf, core, storage, delivery, _, _, fixture = await action_lifecycle(mode == "empty")
        batches = []
        adapter = scripted(fixture)
        async def accept(event, claim, prepared, **kwargs):
            core.accepts += 1
            batches.append(prepared)
            if mode in {"uncertain", "auth", "reject"} or mode == "retry" and core.accepts == 1:
                raise CoreError(401 if mode == "auth" else 422 if mode == "reject" else 0)
            core.state = "RESULT_ACCEPTED"
            if mode == "lost":
                raise CoreError()
        core.accept_action_items = accept
        worker = IntelligenceWorker(conf, core, storage, {"EXTRACTING_ACTION_ITEMS": ActionItemProcessor(settings(), adapter)})
        try:
            await worker.handle(delivery)
            assert storage.artifact is None and len(adapter.requests) == 1
            if mode in {"uncertain", "auth", "reject"}:
                assert not delivery.acked and worker.stop_intake.is_set()
            else:
                assert delivery.acked
                duplicate = type(delivery)()
                duplicate.body = delivery.body
                await worker.handle(duplicate)
                assert duplicate.acked and len(adapter.requests) == 1
            assert core.failures == 0
            if mode == "retry":
                assert len(batches) == 2 and batches[0] is batches[1]
            if mode in {"auth", "reject"}:
                assert core.accepts == 1
            body = json.loads(batches[0])
            assert set(body) == {"contractVersion", "eventId", "stageRunId", "claimToken", "source", "candidates"}
            assert len(body["candidates"]) == (0 if mode == "empty" else 1)
        finally:
            await worker.aclose()
    asyncio.run(run())


def test_typed_client_validates_bound_receipt_and_separate_bearer():
    async def run():
        _, core, _, delivery, claim, data, _ = await action_lifecycle()
        candidate = dict(producer=dict(model="test", promptVersion="v1"), result=dict(candidates=[]))
        prepared = prepare_action_item_request(candidate, claim, data)
        event = __import__("sme_meeting_ai.integrations.intelligence", fromlist=["decode_notification"]).decode_notification(delivery)
        seen = []
        async def serve(request):
            seen.append(request)
            assert request.headers["authorization"] == "Bearer " + "A" * 43
            assert request.url.path.endswith("/action-items/accept")
            body = json.loads(request.content)
            return httpx.Response(200, headers={"cache-control": "no-store"}, json=dict(success=True,
                data=dict(contractVersion="1.0", eventId=body["eventId"], stageRunId=body["stageRunId"],
                    sourceSnapshotId=body["source"]["snapshotId"], replay=False, newProposals=0)))
        client = httpx.AsyncClient(transport=httpx.MockTransport(serve))
        api = IntelligenceCoreClient(settings(core_api_base_url="https://core.invalid"), acceptance_token="A" * 43, client=client)
        try:
            receipt = await api.accept_action_items(event, claim, prepared)
            assert receipt.newProposals == 0 and len(seen) == 1
        finally:
            await api.aclose()
    asyncio.run(run())
