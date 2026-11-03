"""R02: discard a real completion response after independent durable commit proof."""

import asyncio

import e2e04_recovery_support as support
import test_worker_e2e04 as e2e
from e2e04_recovery_control import POST_COMPLETE

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def test_real_r02_lost_completion_response(recovery):
    run = recovery
    control = run.control()
    control.arm(POST_COMPLETE)
    worker = run.start("original", control=control, fault="lost_completion")

    async def exercise():
        await run.admit()
        activation = await asyncio.to_thread(control.wait_for_checkpoint, POST_COMPLETE, timeout=25)
        assert activation["eventId"] == run.event_id
        committed = run.evidence()
        e2e._assert_r01_evidence(committed)
        assert not run.records(worker, "E2E04_ACK")
        assert not [record for record in run.records(worker, "E2E04_HTTP")
                    if record["operation"] == "complete" and record["status"] == 200]
        held = run.wait_broker(lambda state: state["work"]["messages_unacknowledged"] == 1)
        control.release(POST_COMPLETE)
        await run.accepted(worker)
        await asyncio.to_thread(run.wait_record, worker, "E2E04_ACK",
                                lambda record: record["operation"] == "client_completed")
        return committed, held

    committed, held = asyncio.run(run.exercise(exercise))
    run.stop(worker)
    final = run.settled_success()
    for field in ("receiptId", "transcriptId", "resultSha256", "correctionSha256", "claimStageRunId"):
        assert committed[field] == final[field]
    fault, = run.records(worker, "E2E04_FAULT")
    assert fault["fault"] == "discard_completion_response" and fault["receiptId"] == final["receiptId"]
    http = run.records(worker, "E2E04_HTTP")
    ambiguous, = [record for record in http if record["operation"] == "complete"]
    recovered, = [record for record in http if record["operation"].startswith("deliveries/")]
    assert ambiguous["status"] == 0 and ambiguous["budgetUsed"] == 1
    assert recovered["state"] == "RESULT_ACCEPTED" and recovered["budgetUsed"] == 2
    assert recovered["receiptId"] == final["receiptId"]
    assert fault["monotonicNs"] < ambiguous["monotonicNs"] < recovered["monotonicNs"]
    ack = e2e._assert_original_ack(worker.path / "worker.log", final)
    run.report("R02", fault=fault, requests=[ambiguous, recovered], ack=ack,
               receiptId=final["receiptId"], transcriptId=final["transcriptId"],
               resultSha256=final["resultSha256"], correctionSha256=final["correctionSha256"],
               receiptCount=final["receiptCount"], transcriptCount=final["transcriptCount"],
               generation=final["generation"], heldBroker=held, finalBroker=run.broker())
