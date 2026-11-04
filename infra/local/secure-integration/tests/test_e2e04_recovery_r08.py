"""R08: SIGKILL with source open, real redelivery/DLQ/expiry and admitted retry."""

import asyncio

import e2e04_recovery_support as support
import test_e2e04_recovery_r01 as r01
import test_worker_e2e04 as e2e
from e2e04_recovery_control import SOURCE_OPEN

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def test_real_r08_sigkill_claim_fencing_and_authorized_retry(recovery):
    run = recovery
    control = run.control()
    control.arm(SOURCE_OPEN)
    original = run.start("original", control=control, fault="crash_inflight",
                         extra={"AI_E2E04_CONTROL_TIMEOUT": "210"})

    async def exercise():
        await run.admit()
        await asyncio.to_thread(control.wait_for_checkpoint, SOURCE_OPEN, timeout=25)
        old_event, old_slot = run.event_id, run.slot()
        claimed = run.owner()
        assert claimed["live"] and not run.receipts()
        base = original.path / "worker-temp" / "sme-transcription-worker"
        old_roots = list(base.glob("run-*"))
        assert len(old_roots) == 1
        source_paths = list(old_roots[0].glob("source-*/source.media"))
        assert len(source_paths) == 1 and source_paths[0].read_bytes() == e2e.synthetic_wav()
        assert original.process.poll() is None and old_roots[0].exists()
        assert not run.records(original, "E2E04_PIPELINE") and not run.records(original, "E2E04_ACK")
        held = run.wait_broker(lambda state: state["work"]["messages_unacknowledged"] == 1)
        run.kill(original)
        assert old_roots[0].exists(), "no fixture cleanup may precede the new owning process"
        returned = run.wait_broker(lambda state: state["work"]["messages_ready"] == 1
                                  and state["work"]["messages_unacknowledged"] == 0
                                  and state["work"]["consumers"] == 0)
        restarted = run.start("restarted", extra={"AI_AUDIO_TEMP_DIR": str(original.path / "worker-temp")})
        assert not old_roots[0].exists(), "new process must reclaim dead-owner orphan directory"
        redelivery = await asyncio.to_thread(run.wait_record, restarted, "E2E04_MESSAGE")
        assert redelivery["eventId"] == old_event and redelivery["redelivered"] is True
        assert redelivery["deliveryCount"] >= 1
        busy = await asyncio.to_thread(run.wait_record, restarted, "E2E04_CLAIM",
                                        lambda item: item.get("code") == "WORKER_ATTEMPT_BUSY")
        assert busy["status"] == 409 and "stageRunId" not in busy
        assert run.owner()["stageRunId"] == claimed["stageRunId"] and run.owner()["live"]
        deferred = await asyncio.to_thread(support.poll,
            lambda: r01._reconciliation(run.database, run.job_id, old_event),
            lambda item: item is not None and item["disposition"] == "DEFERRED",
            timeout=45, label="crash DLQ durable deferral")
        assert not run.records(restarted, "E2E04_PIPELINE") and not run.records(restarted, "E2E04_ACK")
        await asyncio.to_thread(run.wait_failure, "STAGE_LEASE_EXPIRED")
        terminal, transitions = await asyncio.to_thread(
            r01._wait_for_reconciliation, run.database, run.job_id, old_event, required=True)
        assert terminal["disposition"] == "TERMINAL" and terminal["errorCode"] == "STAGE_LEASE_EXPIRED"
        assert not run.records(restarted, "E2E04_INFERENCE")
        run.assert_missing(old_slot)
        await run.retry(1)
        assert run.event_id != old_event
        await run.accepted(restarted)
        await asyncio.to_thread(run.wait_record, restarted, "E2E04_ACK", lambda item:
                                item["eventId"] == run.event_id and item["operation"] == "client_completed")
        return restarted, claimed, held, returned, redelivery, busy, deferred, terminal, transitions, base

    (restarted, claimed, held, returned, redelivery, busy, deferred,
     terminal, transitions, base) = asyncio.run(run.exercise(exercise))
    run.stop(restarted)
    final, receipts = run.settled_retry()
    assert not list(base.glob("run-*"))
    assert not run.records(original, "E2E04_PIPELINE")
    pipeline, = run.records(restarted, "E2E04_PIPELINE")
    assert pipeline["generation"] == 1 and pipeline["eventId"] == run.event_id
    assert not run.records(restarted, "E2E04_FAILURE")
    run.report("R08", fault="SIGKILL_with_source_open", originalExit=original.process.returncode,
               claimed=claimed, heldBroker=held, connectionClosedBroker=returned, redelivery=redelivery,
               liveOwnerBusy=busy, reconciliation=[deferred, *transitions], terminal=terminal,
               orphanReclaimedOnlyAfterOwnerDeath=True, privateRunDirectoriesRemaining=0,
               receipts=receipts, pipelineGenerations=[1], resultSha256=final["resultSha256"],
               transcriptCount=final["transcriptCount"], finalBroker=run.broker())
