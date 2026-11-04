"""R04: real lease expiry/sweeper and a new, original-binding stale completion."""

import asyncio
import hashlib
from datetime import datetime

import e2e04_recovery_support as support
import test_worker_e2e04 as e2e
from e2e04_recovery_control import PRE_COMPLETE

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def test_real_r04_expired_lease_rejects_stale_completion(recovery):
    run = recovery
    control = run.control()
    control.arm(PRE_COMPLETE)
    worker = run.start("owner", control=control, fault="lease_expiry",
                       extra={"AI_E2E04_CONTROL_TIMEOUT": "210"})

    async def exercise():
        await run.admit()
        activated = await asyncio.to_thread(control.wait_for_checkpoint, PRE_COMPLETE, timeout=25)
        assert activated["eventId"] == run.event_id
        claimed = run.owner()
        assert claimed["live"] and claimed["generation"] == 0
        lease_duration = (datetime.fromisoformat(claimed["leaseExpiresAt"])
                          - datetime.fromisoformat(claimed["claimedAt"])).total_seconds()
        assert 119 <= lease_duration <= 121
        key = run.slot()
        before = run.object_bytes(key)
        assert not run.records(worker, "E2E04_ACK") and not run.receipts()
        interrupted = await asyncio.to_thread(run.wait_record, worker, "E2E04_FAULT",
                                               lambda item: item["fault"] == "renewal_interrupted", timeout=45)
        receipts = await asyncio.to_thread(run.wait_failure, "STAGE_LEASE_EXPIRED")
        expired = run.owner()
        assert expired["stageStatus"] == "FAILED" and expired["remainingSeconds"] <= 0
        assert expired["leaseExpiresAt"] == claimed["leaseExpiresAt"]
        assert not run.records(worker, "E2E04_ACK")
        assert run.evidence()["canonicalTranscriptCount"] == 0
        control.release(PRE_COMPLETE)
        rejection = await asyncio.to_thread(run.wait_record, worker, "E2E04_FAULT",
                                             lambda item: item["fault"] == "stale_completion_rejected")
        assert rejection["status"] == 409 and rejection["generation"] == 0
        assert rejection["commandId"] and receipts[0]["commandId"] is None
        ack = await asyncio.to_thread(run.wait_record, worker, "E2E04_ACK",
                                      lambda item: item["operation"] == "client_completed")
        assert ack["terminal"] == {"state": "FAILURE_RECORDED", "receiptId": receipts[0]["receiptId"]}
        assert ack["redelivered"] is False
        return claimed, expired, interrupted, rejection, before, key

    claimed, expired, interrupted, rejection, before, key = asyncio.run(run.exercise(exercise))
    run.stop(worker)
    final, receipts = run.settled_failure(code="STAGE_LEASE_EXPIRED")
    assert final["claimCount"] == 1 and final["generation"] == 0
    assert receipts[0]["retryable"] is True and receipts[0]["retryExhausted"] is False
    assert len(run.records(worker, "E2E04_PIPELINE")) == 1
    assert not run.records(worker, "E2E04_FAILURE")
    run.assert_immutable(key, before)
    run.report("R04", claimed=claimed, expired=expired, renewalGate=interrupted,
               staleCompletion=rejection, receipts=receipts, acceptedCount=0, transcriptCount=0,
               immutableUnacceptedResultSha256=hashlib.sha256(before).hexdigest(), finalBroker=run.broker())
