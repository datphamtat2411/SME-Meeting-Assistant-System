"""R04 test-only renewal interruption and stale HTTP probe preserve binding."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
import test_worker_e2e04 as e2e
from e2e04_recovery_faults import PRE_COMPLETE, RecoveryFaults
from e2e04_recovery_support import RecoveryRun


def test_new_stale_completion_uses_original_private_body_and_real_http_boundary():
    entered, release = None, None
    calls = []
    private = {"claimToken": "private-token", "commandId": "new-command"}

    class Control:
        async def checkpoint(self, name, **fields):
            assert name == PRE_COMPLETE
            entered.set()
            await asyncio.wait_for(release.wait(), 1)

    async def call(event, operation, body, deadline):
        calls.append((operation, body, deadline))
        raise e2e.worker_diagnostics.CoreError(409, "WORKER_COMMAND_CONFLICT")

    async def exercise():
        nonlocal entered, release
        entered, release = asyncio.Event(), asyncio.Event()
        fault = RecoveryFaults(Control(), "lease_expiry")
        event = SimpleNamespace(eventId="event-a", processingJobId="job-a", generation=0)
        completion = asyncio.create_task(fault.once(call, event, "complete", private, 1))
        await asyncio.wait_for(entered.wait(), 1)
        renewal = asyncio.create_task(fault.once(call, event, "renew", private, 1))
        await asyncio.sleep(0)
        assert not calls and not completion.done() and not renewal.done()
        release.set()
        results = await asyncio.wait_for(asyncio.gather(completion, renewal, return_exceptions=True), 1)
        assert all(isinstance(result, e2e.worker_diagnostics.CoreError) for result in results)
        assert calls[0] == ("complete", private, None)
        assert calls[0][1] is private
        assert calls[1] == ("renew", private, 1)
        assert fault.activated == 1

    asyncio.run(exercise())


def test_control_hold_limit_covers_real_lease_but_remains_bounded():
    from e2e04_recovery_control import _timeout

    assert _timeout(210) == 210
    with pytest.raises(ValueError):
        _timeout(241)


def test_s3_client_cleanup_does_not_assume_sdk_context_manager(monkeypatch):
    import e2e04_recovery_support as support

    closed = []
    client = SimpleNamespace(close=lambda: closed.append(True))
    monkeypatch.setattr(support.boto3, "client", lambda *args, **kwargs: client)
    run = object.__new__(RecoveryRun)
    run.boundary = SimpleNamespace(s3_endpoint_url="https://storage.invalid")
    run.pki = Path("/tmp")
    run.credentials = SimpleNamespace(storage_worker_user="isolated", storage_worker_password="private")
    with pytest.raises(RuntimeError):
        with run.storage_client() as actual:
            assert actual is client
            raise RuntimeError("fixture failure")
    assert closed == [True]
