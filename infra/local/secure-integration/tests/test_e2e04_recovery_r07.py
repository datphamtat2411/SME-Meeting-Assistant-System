"""R07: genuine Core process outage, unchanged infrastructure, expiry fencing/retry."""

import asyncio
import hashlib

import e2e04_recovery_support as support
import test_worker_e2e04 as e2e
from e2e04_recovery_control import CORE_RESTORED, PRE_COMPLETE

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def test_real_r07_core_outage_same_state_recovery(recovery):
    run = recovery
    control = run.control()
    control.arm(PRE_COMPLETE)
    control.arm(CORE_RESTORED)
    worker = run.start("worker", control=control, fault="core_outage",
                       extra={"AI_E2E04_CONTROL_TIMEOUT": "210"})

    async def exercise():
        await run.admit()
        await asyncio.to_thread(control.wait_for_checkpoint, PRE_COMPLETE, timeout=25)
        claimed = run.owner()
        old_event, old_slot = run.event_id, run.slot()
        raw = run.object_bytes(old_slot)
        assert claimed["live"] and not run.receipts()
        database_started = e2e._psql(run.database, run.database["password"], "SELECT pg_postmaster_start_time()")
        run.stop_core()
        assert run.core.process.poll() is not None
        assert not run.records(worker, "E2E04_ACK")
        control.release(PRE_COMPLETE)
        unavailable = await asyncio.to_thread(run.wait_record, worker, "E2E04_FAULT",
                                               lambda item: item["fault"] == "core_unavailable")
        await asyncio.to_thread(control.wait_for_checkpoint, CORE_RESTORED, timeout=25)
        assert unavailable["status"] == 0 and not run.receipts()
        held = run.wait_broker(lambda state: state["work"]["messages_unacknowledged"] == 1)
        await asyncio.to_thread(support.poll, run.owner, lambda owner: owner["remainingSeconds"] <= 0,
                                timeout=135, interval=0.5, label="real lease while Core is offline")
        assert run.owner()["stageStatus"] == "RUNNING" and not run.receipts()
        assert not run.records(worker, "E2E04_ACK")
        renewal = [item for item in run.records(worker, "E2E04_HTTP") if item["operation"] == "renew"]
        assert renewal and all(item["status"] == 0 for item in renewal)
        restart_status = run.restart_core()
        assert restart_status["eventId"] == old_event
        receipts = await asyncio.to_thread(run.wait_failure, "STAGE_LEASE_EXPIRED", timeout=90)
        assert e2e._psql(run.database, run.database["password"], "SELECT pg_postmaster_start_time()") == database_started
        assert run.owner()["leaseExpiresAt"] == claimed["leaseExpiresAt"]
        assert not run.records(worker, "E2E04_ACK")
        control.release(CORE_RESTORED)
        stale = await asyncio.to_thread(run.wait_record, worker, "E2E04_FAULT",
                                         lambda item: item["fault"] == "stale_completion_rejected")
        assert stale["status"] == 409 and stale["generation"] == 0
        old_ack = await asyncio.to_thread(run.wait_record, worker, "E2E04_ACK", lambda item:
                                          item["eventId"] == old_event and item["operation"] == "client_completed")
        assert old_ack["terminal"] == {"state": "FAILURE_RECORDED", "receiptId": receipts[0]["receiptId"]}
        assert len(run.records(worker, "E2E04_PIPELINE")) == 1
        await run.retry(1)
        assert run.event_id != old_event
        await run.accepted(worker)
        await asyncio.to_thread(run.wait_record, worker, "E2E04_ACK", lambda item:
                                item["eventId"] == run.event_id and item["operation"] == "client_completed")
        return claimed, unavailable, renewal, held, stale, raw, old_slot

    claimed, unavailable, renewal, held, stale, raw, old_slot = asyncio.run(run.exercise(exercise))
    run.stop(worker)
    final, receipts = run.settled_retry()
    assert [item["generation"] for item in run.records(worker, "E2E04_PIPELINE")] == [0, 1]
    assert not run.records(worker, "E2E04_FAILURE")
    run.assert_immutable(old_slot, raw)
    run.report("R07", fault="Core_process_group_stopped", claimed=claimed, actualConnectionFailure=unavailable,
               renewalFailures=renewal, heldBroker=held, samePostgresProcess=True,
               staleCompletion=stale, receipts=receipts, transcriptCount=final["transcriptCount"],
               resultSha256=final["resultSha256"], previousUnacceptedResultSha256=hashlib.sha256(raw).hexdigest(),
               finalBroker=run.broker())
