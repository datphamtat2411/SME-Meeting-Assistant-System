"""R07 gates surround actual outage failure and a new stale Core request."""

import asyncio
from types import SimpleNamespace

import pytest
import test_worker_e2e04 as e2e
from e2e04_recovery_faults import CORE_RESTORED, PRE_COMPLETE, RecoveryFaults


def test_outage_gate_keeps_private_command_until_real_core_returns():
    calls, gates = [], []
    body = {"commandId": "same-private-command", "claimToken": "never-log"}

    class Control:
        async def checkpoint(self, name, **fields):
            gates.append(name)

    async def call(event, operation, command, deadline):
        calls.append((command, deadline))
        if len(calls) == 1:
            raise e2e.worker_diagnostics.CoreError()
        raise e2e.worker_diagnostics.CoreError(409, "WORKER_COMMAND_CONFLICT")

    async def exercise():
        faults = RecoveryFaults(Control(), "core_outage")
        event = SimpleNamespace(eventId="event-a", processingJobId="job-a", generation=0)
        with pytest.raises(e2e.worker_diagnostics.CoreError) as error:
            await faults.once(call, event, "complete", body, 123)
        assert error.value.status == 409
        assert gates == [PRE_COMPLETE, CORE_RESTORED]
        assert calls == [(body, 123), (body, None)]
        assert all(item[0] is body for item in calls)

    asyncio.run(exercise())
