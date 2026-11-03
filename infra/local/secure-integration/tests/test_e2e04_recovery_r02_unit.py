"""R02 fault ordering and fail-closed evidence, without Docker."""

import asyncio
from types import SimpleNamespace

import pytest
import test_worker_e2e04 as e2e
from e2e04_recovery_faults import POST_COMPLETE, RecoveryFaults
from e2e04_recovery_support import assert_ack_confirmations


def test_discards_one_actual_accepted_response_only_after_checkpoint():
    calls = []

    class Control:
        async def checkpoint(self, name, **fields):
            calls.append((name, fields))

    async def real_call(event, operation, body, deadline):
        calls.append(operation)
        return SimpleNamespace(state="RESULT_ACCEPTED", durable=True,
                               receipt={"receiptId": "receipt-a"})

    async def exercise():
        fault = RecoveryFaults(Control(), "lost_completion")
        event = SimpleNamespace(eventId="event-a", processingJobId="job-a", generation=0)
        with pytest.raises(e2e.worker_diagnostics.CoreError) as error:
            await fault.once(real_call, event, "complete", {}, None)
        assert error.value.status == 0 and error.value.retryable
        assert calls == ["complete", (POST_COMPLETE, {"event_id": "event-a"})]
        accepted = await fault.once(real_call, event, "complete", {}, None)
        assert accepted.state == "RESULT_ACCEPTED" and calls[-1] == "complete"
        assert fault.activated == 1

    asyncio.run(exercise())


def test_response_loss_never_manufactures_success_after_real_failure():
    async def real_call(*args):
        raise e2e.worker_diagnostics.CoreError(409, "WORKER_LEASE_LOST")

    async def exercise():
        fault = RecoveryFaults(SimpleNamespace(), "lost_completion")
        with pytest.raises(e2e.worker_diagnostics.CoreError) as error:
            await fault.once(real_call, SimpleNamespace(), "complete", {}, None)
        assert error.value.status == 409 and fault.activated == 0

    asyncio.run(exercise())


def test_loss_gate_is_not_activated_for_status_lookup():
    async def real_call(*args):
        return "actual-status"

    fault = RecoveryFaults(SimpleNamespace(), "lost_completion")
    assert asyncio.run(fault.once(real_call, SimpleNamespace(), "deliveries/event-a", None, None)) == "actual-status"
    assert fault.activated == 0


def test_ack_requires_preceding_bound_durable_confirmation():
    status = {"eventId": "event-a", "status": 200, "state": "RESULT_ACCEPTED",
              "receiptId": "receipt-a", "monotonicNs": 10}
    ack = {"eventId": "event-a", "monotonicNs": 11,
           "terminal": {"state": "RESULT_ACCEPTED", "receiptId": "receipt-a"}}
    assert_ack_confirmations([status], [ack])
    for change in ({"receiptId": "wrong"}, {"eventId": "wrong"},
                   {"state": "RUNNING"}, {"status": 0}, {"monotonicNs": 12}):
        with pytest.raises(AssertionError, match="durable confirmation"):
            assert_ack_confirmations([{**status, **change}], [ack])
