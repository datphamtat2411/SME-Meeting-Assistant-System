"""R09: actual overlapping claims from two processes and distinct AMQP connections."""

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

import e2e04_recovery_support as support
import test_e2e04_recovery_r01 as r01
import test_worker_e2e04 as e2e
from e2e04_recovery_control import POST_CLAIM, PRE_CLAIM

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def test_real_r09_two_process_concurrent_claims(recovery):
    run = recovery
    controls = [run.control(), run.control()]
    for control in controls:
        control.arm(PRE_CLAIM)
        control.arm(POST_CLAIM)
    workers = [run.start(f"worker-{index}", control=control, fault="concurrent_claims")
               for index, control in enumerate(controls)]

    async def exercise():
        await run.admit()
        first = await asyncio.to_thread(support.poll,
            lambda: [(worker, item) for worker in workers for item in run.records(worker, "E2E04_MESSAGE")],
            bool, timeout=20, label="original delivery")
        original_worker, original = first[0]
        await asyncio.to_thread(original_worker.control.wait_for_checkpoint, PRE_CLAIM, timeout=20)
        wire = e2e._with_publisher_headers(e2e._outbox_wire_event(run.database, run.job_id), original)
        await e2e._publish_exact_duplicate(run.transport, run.credentials, run.pki, wire, original)
        for worker in workers:
            activation = await asyncio.to_thread(worker.control.wait_for_checkpoint, PRE_CLAIM, timeout=20)
            assert activation["eventId"] == run.event_id
        deliveries = [run.records(worker, "E2E04_MESSAGE")[0] for worker in workers]
        for delivery in deliveries:
            e2e._assert_wire_match(e2e._wire_fingerprint(wire), delivery, "concurrent delivery")
            assert delivery["redelivered"] is False
        connections = json.loads(e2e._consumer_metadata(run.names[0], run.credentials))
        assert len(connections) == 2 and len({item["connection"] for item in connections}) == 2
        assert all(item["workload"] == "worker" for item in connections)
        with support.JobLock(run) as lock:
            with ThreadPoolExecutor(max_workers=2) as executor:
                releases = [executor.submit(control.release, PRE_CLAIM) for control in controls]
                for release in releases:
                    release.result(timeout=3)
            waiters = await asyncio.to_thread(support.poll, lock.waiters, lambda items: len(items) == 2,
                                               timeout=8, interval=0.05, label="overlapping real Core claims")
            support.assert_claim_overlap(waiters, lock.pid)
            assert all(any(item["phase"] == "attempt" for item in run.records(worker, "E2E04_CLAIM"))
                       for worker in workers)
            assert not any(run.records(worker, "E2E04_INFERENCE") for worker in workers)
        winner = await asyncio.to_thread(support.poll,
            lambda: [worker for worker in workers if any(item.get("outcome") == "claimed"
                      for item in run.records(worker, "E2E04_CLAIM"))], bool, timeout=15, label="winning claim")
        assert len(winner) == 1
        owner = winner[0]
        loser = next(worker for worker in workers if worker is not owner)
        await asyncio.to_thread(owner.control.wait_for_checkpoint, POST_CLAIM, timeout=15)
        busy = await asyncio.to_thread(run.wait_record, loser, "E2E04_CLAIM",
                                        lambda item: item.get("code") == "WORKER_ATTEMPT_BUSY")
        assert busy["status"] == 409 and "stageRunId" not in busy
        assert not any(item.get("outcome") == "claimed" for item in run.records(loser, "E2E04_CLAIM"))
        claimed = run.owner()
        assert claimed["live"] and run.evidence()["claimCount"] == 1
        assert not any(run.records(worker, "E2E04_PIPELINE") for worker in workers)
        owner.control.release(POST_CLAIM)
        await run.accepted(owner)
        await asyncio.to_thread(run.wait_record, owner, "E2E04_ACK",
                                lambda item: item["operation"] == "client_completed")
        settlement = await asyncio.to_thread(support.poll, loser.control.observations,
            lambda items: any(item.get("action") in ("ack", "reject") and item.get("phase") == "client_completed"
                              for item in items), timeout=45, label="losing delivery final settlement")
        rejected = any(item.get("action") == "reject" for item in settlement)
        reconciliation, transitions = await asyncio.to_thread(
            r01._wait_for_reconciliation, run.database, run.job_id, run.event_id, required=rejected)
        return waiters, connections, owner, loser, claimed, busy, settlement, reconciliation, transitions

    (waiters, connections, owner, loser, claimed, busy,
     settlement, reconciliation, transitions) = asyncio.run(run.exercise(exercise))
    for worker in workers:
        run.stop(worker)
    final = run.settled_success()
    assert len(run.records(owner, "E2E04_PIPELINE")) == 1
    assert not run.records(loser, "E2E04_PIPELINE") and not run.records(loser, "E2E04_STORAGE")
    assert final["producerStageRunId"] == claimed["stageRunId"]
    run.report("R09", fault="simultaneous_pre_claim_release_with_two_real_DB_waiters",
               overlappingPostgresWaiters=waiters, distinctBrokerConnections=connections,
               owner=owner.path.name, claimed=claimed, losingClaim=busy,
               losingSettlement=[item for item in settlement if "action" in item],
               reconciliation=reconciliation, reconciliationObservations=transitions,
               pipelineExecutions=1, receiptId=final["receiptId"], resultSha256=final["resultSha256"],
               transcriptId=final["transcriptId"], receiptCount=1, transcriptCount=1, finalBroker=run.broker())
