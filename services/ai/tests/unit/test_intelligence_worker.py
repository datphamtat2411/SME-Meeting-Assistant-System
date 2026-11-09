import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest

from sme_meeting_ai.integrations.core_api import CoreError
from sme_meeting_ai.integrations.intelligence import (
    IntelligenceClaim,
    IntelligenceStatus,
)
from sme_meeting_ai.integrations.object_storage import StorageError
from sme_meeting_ai.meeting_intelligence.result import ResultError, serialize_result
from sme_meeting_ai.meeting_intelligence.source import (
    SourceIntegrityError,
    verify_snapshot,
)
from sme_meeting_ai.workers.intelligence import IntelligenceWorker, LeaseGuard


def snapshot():
    job, meeting, media, transcript = (str(uuid4()) for _ in range(4))
    data = {
        "schemaVersion": "1.0",
        "transcript": {
            "id": transcript,
            "meetingId": meeting,
            "sourceMediaId": media,
            "processingJobId": job,
            "contentRevision": 3,
            "segments": [{"id": str(uuid4())}],
        },
        "coverage": [],
        "speakers": [],
    }
    raw = json.dumps(data).encode()
    claim = SimpleNamespace(
        processingJobId=job,
        meetingId=meeting,
        sourceMediaId=media,
        source=SimpleNamespace(
            transcriptId=transcript,
            contentRevision=3,
            sizeBytes=len(raw),
            sha256=hashlib.sha256(raw).hexdigest(),
            schemaVersion=1,
        ),
    )
    return claim, data, raw


def test_snapshot_verified_against_authorized_descriptor():
    claim, data, raw = snapshot()
    assert verify_snapshot(raw, claim)["transcript"] == data["transcript"]


@pytest.mark.parametrize(
    "change",
    ["size", "digest", "transcript", "revision", "meeting", "schema", "duplicate"],
)
def test_snapshot_rejects_corruption_and_wrong_source(change):
    claim, data, raw = snapshot()
    if change == "size":
        claim.source.sizeBytes += 1
    elif change == "digest":
        claim.source.sha256 = "0" * 64
    else:
        if change == "transcript":
            data["transcript"]["id"] = str(uuid4())
        elif change == "revision":
            data["transcript"]["contentRevision"] = 4
        elif change == "meeting":
            data["transcript"]["meetingId"] = str(uuid4())
        elif change == "schema":
            data["schemaVersion"] = "2.0"
        raw = json.dumps(data).encode()
        if change == "duplicate":
            raw = raw[:-1] + b',"schemaVersion":"1.0"}'
        claim.source.sizeBytes = len(raw)
        claim.source.sha256 = hashlib.sha256(raw).hexdigest()
    with pytest.raises(SourceIntegrityError):
        verify_snapshot(raw, claim)


def test_result_serialization_binds_identity_and_is_deterministic():
    claim, data, _ = snapshot()
    claim.executionStageCode = "GENERATING_SUMMARY"
    claim.executionStageRunId = str(uuid4())
    claim.source.snapshotId = str(uuid4())
    candidate = {
        "producer": {"model": "test", "promptVersion": "1"},
        "result": {"content": "Tóm tắt", "warnings": []},
    }
    first = serialize_result(candidate, claim, data)
    assert first == serialize_result(candidate, claim, data)
    payload = json.loads(first)
    assert payload["source"]["sha256"] == claim.source.sha256
    assert payload["stageRunId"] == claim.executionStageRunId


def test_decision_evidence_must_belong_to_verified_snapshot():
    claim, data, _ = snapshot()
    claim.executionStageCode = "EXTRACTING_DECISIONS"
    claim.executionStageRunId = str(uuid4())
    claim.source.snapshotId = str(uuid4())
    candidate = {
        "producer": {"model": "test", "promptVersion": "1"},
        "result": {
            "warnings": [],
            "candidates": [
                {
                    "candidateKey": "one",
                    "content": "Quyết định",
                    "uncertainty": "NONE",
                    "evidenceSegmentIds": [str(uuid4())],
                }
            ],
        },
    }
    with pytest.raises(ResultError):
        serialize_result(candidate, claim, data)
    candidate["result"]["candidates"][0]["evidenceSegmentIds"] = [
        data["transcript"]["segments"][0]["id"]
    ]
    assert (
        json.loads(serialize_result(candidate, claim, data))["resultType"]
        == "DECISION_EXTRACTION"
    )


def lifecycle():
    claim, _, raw = snapshot()
    event, stage, snap = (str(uuid4()) for _ in range(3))
    now = datetime.now(UTC)
    source = dict(
        snapshotId=snap,
        storageId="private",
        objectKey=f"processing/{claim.processingJobId}/intelligence/source/{snap}.json",
        sha256=claim.source.sha256,
        sizeBytes=len(raw),
        transcriptId=claim.source.transcriptId,
        contentRevision=3,
        schemaVersion=1,
    )
    identity = dict(
        contractVersion="1.0",
        processingJobId=claim.processingJobId,
        eventId=event,
        executionStageRunId=stage,
        executionStageCode="GENERATING_SUMMARY",
    )
    owned = IntelligenceClaim.model_validate(
        dict(
            **identity,
            eventType="PROCESSING_INTELLIGENCE_STAGE_REQUESTED",
            eventSchemaVersion=1,
            meetingId=claim.meetingId,
            sourceMediaId=claim.sourceMediaId,
            claimToken=str(uuid4()),
            leaseExpiresAt=(now + timedelta(seconds=60)).isoformat(),
            serverTime=now.isoformat(),
            leaseSeconds=60,
            renewAfterSeconds=15,
            source=source,
            resultSlot=dict(
                storageId="private",
                objectKey=f"processing/{claim.processingJobId}/intelligence/results/{stage}.json",
                producerStageRunId=stage,
                maxBytes=4194304,
                createOnly=True,
                requiredIfNoneMatch="*",
            ),
        )
    )
    body = dict(
        eventId=event,
        schemaVersion=1,
        processingJobId=claim.processingJobId,
        executionStageRunId=stage,
        executionStageCode="GENERATING_SUMMARY",
        occurredAt=now.isoformat(),
        requestId=None,
    )

    class Delivery:
        content_type = "application/json"
        delivery_mode = 2
        routing_key = "processing.intelligence.requested"
        exchange = "meeting.processing"
        headers = dict(
            eventId=event,
            eventType="PROCESSING_INTELLIGENCE_STAGE_REQUESTED",
            eventSchemaVersion=1,
        )
        message_id = event
        redelivered = False
        acked = rejected = False

        def __init__(self):
            self.body = json.dumps(body).encode()

        async def ack(self):
            self.acked = True

        async def reject(self, *, requeue):
            self.rejected = not requeue

    class Core:
        state = "AVAILABLE"
        accepts = claims = failures = 0
        lose_response = False

        async def lookup(self, event, **kwargs):
            return IntelligenceStatus.model_validate(
                dict(
                    **identity,
                    state=self.state,
                    acknowledge=self.state
                    in ("RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED"),
                    **(
                        dict(errorCode="INTELLIGENCE_VALIDATION", retryable=False)
                        if self.state == "FAILURE_RECORDED"
                        else {}
                    ),
                )
            )

        async def claim(self, event, **kwargs):
            self.claims += 1
            self.state = "RUNNING"
            return owned

        async def request(self, event, operation, body, **kwargs):
            assert operation == "fail"
            self.failures += 1
            self.state = "FAILURE_RECORDED"
            return await self.lookup(event)

        async def accept(self, event, token, digest, **kwargs):
            self.accepts += 1
            self.state = "RESULT_ACCEPTED"
            if self.lose_response:
                raise CoreError()
            return SimpleNamespace(replay=False, writtenRows=1)

    class Storage:
        artifact = None

        def get_intelligence_snapshot(self, source, fence):
            return raw

        def get_result(self, storage_id, key, fence):
            if self.artifact is None:
                raise StorageError("NOT_FOUND")
            return self.artifact

        def put_result(self, storage_id, key, raw, fence):
            if self.artifact is None:
                self.artifact = raw
            return self.artifact

    settings = SimpleNamespace(
        meeting_intelligence_worker_concurrency=1,
        meeting_intelligence_worker_execution_timeout_seconds=60,
        core_api_max_attempts=3,
    )
    candidate = {
        "producer": {"model": "test", "promptVersion": "1"},
        "result": {"content": "Tóm tắt", "warnings": []},
    }
    return settings, Core(), Storage(), Delivery(), candidate


def test_coordinator_acceptance_and_duplicate_delivery():
    async def run():
        settings, core, storage, delivery, candidate = lifecycle()
        calls = []

        def processor(context):
            calls.append(context)
            return candidate

        worker = IntelligenceWorker(
            settings, core, storage, {"GENERATING_SUMMARY": processor}
        )
        try:
            await worker.handle(delivery)
            assert delivery.acked and core.accepts == 1 and len(calls) == 1
            duplicate = type(delivery)()
            await worker.handle(duplicate)
            assert duplicate.acked and core.accepts == 1 and core.claims == 1
        finally:
            await worker.aclose()

    asyncio.run(run())


def test_lost_acceptance_response_reconciles_before_ack():
    async def run():
        settings, core, storage, delivery, candidate = lifecycle()
        core.lose_response = True
        worker = IntelligenceWorker(
            settings, core, storage, {"GENERATING_SUMMARY": lambda context: candidate}
        )
        try:
            await worker.handle(delivery)
            assert delivery.acked and core.accepts == 1 and core.failures == 0
        finally:
            await worker.aclose()

    asyncio.run(run())


def test_conflicting_immutable_result_is_not_accepted():
    async def run():
        settings, core, storage, delivery, candidate = lifecycle()
        storage.artifact = b"{}"
        worker = IntelligenceWorker(
            settings, core, storage, {"GENERATING_SUMMARY": lambda context: candidate}
        )
        try:
            await worker.handle(delivery)
            assert core.accepts == 0 and core.failures == 1 and delivery.acked
        finally:
            await worker.aclose()

    asyncio.run(run())


def test_poison_delivery_rejected_and_unavailable_processor_fails_closed():
    async def run():
        settings, core, storage, delivery, _ = lifecycle()
        worker = IntelligenceWorker(settings, core, storage, {})
        try:
            invalid = type(delivery)()
            invalid.body = b"bad"
            await worker.handle(invalid)
            assert invalid.rejected and not invalid.acked
            await worker.handle(delivery)
            assert delivery.acked and core.failures == 1 and core.accepts == 0
        finally:
            await worker.aclose()

    asyncio.run(run())


def test_expired_lease_fences_late_processor_before_publication():
    async def run():
        settings, core, storage, delivery, candidate = lifecycle()

        def processor(context):
            context.cancelled.wait(2)
            return candidate

        settings.meeting_intelligence_worker_execution_timeout_seconds = 0.05
        worker = IntelligenceWorker(
            settings, core, storage, {"GENERATING_SUMMARY": processor}
        )
        try:
            await worker.handle(delivery)
            await asyncio.sleep(0.05)
            assert storage.artifact is None and core.accepts == 0 and not delivery.acked
        finally:
            await worker.aclose()

    asyncio.run(run())


def test_lease_renewal_cannot_restore_expired_authority():
    async def run():
        settings, core, storage, delivery, candidate = lifecycle()
        claim = await core.claim(None)

        async def renew(*args, **kwargs):
            await asyncio.sleep(0.08)
            return claim

        core.request = renew
        claim = claim.model_copy(update={"renewAfterSeconds": 0.01})
        guard = LeaseGuard(
            core, None, claim, 0, asyncio.get_running_loop().time() + 0.04
        )
        try:
            await asyncio.sleep(0.12)
            assert guard.fence.is_set() and not guard.live()
        finally:
            await guard.close()

    asyncio.run(run())


def test_lease_renews_independently_while_work_is_running():
    async def run():
        _, core, _, _, _ = lifecycle()
        claim = (await core.claim(None)).model_copy(update={"renewAfterSeconds": 0.01})
        calls = []

        async def renew(event, operation, body, **kwargs):
            calls.append(body)
            return claim

        core.request = renew
        guard = LeaseGuard(core, None, claim, 0, asyncio.get_running_loop().time() + 1)
        try:
            await asyncio.sleep(0.05)
            assert calls and guard.live()
            assert calls[0]["claimToken"] == claim.claimToken.get_secret_value()
        finally:
            await guard.close()

    asyncio.run(run())


def test_unresolved_acceptance_is_not_acknowledged_or_failed():
    async def run():
        settings, core, storage, delivery, candidate = lifecycle()

        async def accept(*args, **kwargs):
            raise CoreError()

        core.accept = accept
        worker = IntelligenceWorker(
            settings, core, storage, {"GENERATING_SUMMARY": lambda context: candidate}
        )
        try:
            await worker.handle(delivery)
            assert (
                not delivery.acked
                and core.failures == 0
                and worker.stop_intake.is_set()
            )
        finally:
            await worker.aclose()

    asyncio.run(run())


def test_valid_existing_result_recovered_without_processor_reexecution():
    async def run():
        settings, core, storage, delivery, candidate = lifecycle()
        worker = IntelligenceWorker(
            settings, core, storage, {"GENERATING_SUMMARY": lambda context: candidate}
        )
        try:
            await worker.handle(delivery)
            core.state = "AVAILABLE"
            replay = type(delivery)()
            worker.processors.clear()
            await worker.handle(replay)
            assert replay.acked and core.accepts == 2 and core.failures == 0
        finally:
            await worker.aclose()

    asyncio.run(run())
