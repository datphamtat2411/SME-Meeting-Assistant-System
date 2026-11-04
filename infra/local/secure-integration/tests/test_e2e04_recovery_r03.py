"""R03: deterministic pre-ACK SIGKILL, actual RabbitMQ redelivery, fresh Worker."""

import asyncio

import e2e04_recovery_support as support
import test_worker_e2e04 as e2e
from e2e04_recovery_control import PRE_ACK

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def test_real_r03_pre_ack_termination_and_redelivery(recovery):
    run = recovery
    control = run.control()
    control.arm(PRE_ACK)
    original = run.start("original", control=control)

    async def exercise():
        await run.admit()
        activation = await asyncio.to_thread(control.wait_for_checkpoint, PRE_ACK, timeout=25)
        assert activation["eventId"] == run.event_id
        committed = run.evidence()
        e2e._assert_r01_evidence(committed)
        held = run.wait_broker(lambda state: state["work"]["messages_unacknowledged"] == 1)
        assert [item["operation"] for item in run.records(original, "E2E04_ACK")] == ["invoked"]
        run.kill(original)
        returned = run.wait_broker(lambda state: state["work"]["messages_ready"] == 1
                                  and state["work"]["messages_unacknowledged"] == 0
                                  and state["work"]["consumers"] == 0)
        restarted = run.start("restarted")
        await run.accepted(restarted)
        await asyncio.to_thread(run.wait_record, restarted, "E2E04_ACK",
                                lambda item: item["operation"] == "client_completed")
        return committed, held, returned, restarted

    committed, held, returned, restarted = asyncio.run(run.exercise(exercise))
    run.stop(restarted)
    final = run.settled_success()
    assert committed["receiptId"] == final["receiptId"]
    assert committed["resultSha256"] == final["resultSha256"]
    support.assert_redelivery_ack(run.records(original, "E2E04_ACK"), run.records(restarted, "E2E04_ACK"),
                                 run.event_id, final["receiptId"])
    redelivery, = run.records(restarted, "E2E04_MESSAGE")
    assert redelivery["redelivered"] is True and redelivery["deliveryCount"] >= 1
    assert not run.records(restarted, "E2E04_INFERENCE")
    claim, = [item for item in run.records(restarted, "E2E04_CLAIM") if item["phase"] == "result"]
    assert claim["outcome"] == "status" and claim["state"] == "RESULT_ACCEPTED"
    run.report("R03", fault="SIGKILL_before_actual_ACK", originalExit=original.process.returncode,
               heldBroker=held, connectionClosedBroker=returned, redelivery=redelivery,
               recoveredClaim=claim, receiptId=final["receiptId"], transcriptId=final["transcriptId"],
               resultSha256=final["resultSha256"], receiptCount=final["receiptCount"],
               transcriptCount=final["transcriptCount"], finalBroker=run.broker())
