"""Infrastructure-free mechanics for the E2E-04 R-A recovery harness."""

import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

ROOT = Path(__file__).resolve().parents[4]
AI_INTEGRATION = ROOT / "services" / "ai" / "tests" / "integration"
_control_spec = importlib.util.spec_from_file_location(
    "e2e04_recovery_control", AI_INTEGRATION / "e2e04_recovery_control.py"
)
_control = importlib.util.module_from_spec(_control_spec)
sys.modules[_control_spec.name] = _control
_control_spec.loader.exec_module(_control)

Environment = _control.Environment
POST_CLAIM = _control.POST_CLAIM
PRE_ACK = _control.PRE_ACK
ControlAborted = _control.ControlAborted
ControlClosed = _control.ControlClosed
ControlTimeout = _control.ControlTimeout
RecoveryControl = _control.RecoveryControl
sanitize_observation = _control.sanitize_observation


def run(coro):
    return asyncio.run(coro)


def test_disabled_control_is_transparent():
    control = RecoveryControl.child(Environment.DEVELOPMENT, {})

    async def exercise():
        await control.checkpoint(POST_CLAIM, event_id=str(uuid4()))
        await control.observe_delivery(
            event_id=str(uuid4()), delivery_tag=1, channel=2, redelivered=False,
            action="ack", phase="invoked",
        )

    run(exercise())
    assert not control.enabled


def test_armed_checkpoint_activates_once_and_parent_observes_it():
    async def exercise():
        with RecoveryControl.parent(Environment.TEST, timeout=0.5) as parent:
            child = RecoveryControl.child(Environment.TEST, parent.environment)
            parent.arm(POST_CLAIM)
            first = asyncio.create_task(child.checkpoint(POST_CLAIM, event_id=str(uuid4())))
            activation = await asyncio.to_thread(parent.wait_for_checkpoint, POST_CLAIM)
            assert activation["checkpoint"] == POST_CLAIM
            assert activation["status"] == "activated"
            parent.release(POST_CLAIM)
            await first
            await asyncio.wait_for(child.checkpoint(POST_CLAIM), timeout=0.2)
            assert [item["status"] for item in parent.observations()
                    if item.get("checkpoint") == POST_CLAIM] == ["activated", "released"]
            await child.close()

    run(exercise())


def test_blocked_child_resumes_only_after_parent_release():
    async def exercise():
        with RecoveryControl.parent(Environment.TEST, timeout=0.5) as parent:
            child = RecoveryControl.child(Environment.TEST, parent.environment)
            parent.arm(PRE_ACK)
            completed = asyncio.Event()

            async def blocked():
                await child.checkpoint(PRE_ACK)
                completed.set()

            task = asyncio.create_task(blocked())
            await asyncio.to_thread(parent.wait_for_checkpoint, PRE_ACK)
            await asyncio.sleep(0)
            assert not completed.is_set()
            parent.release(PRE_ACK)
            await asyncio.wait_for(task, timeout=0.5)
            assert completed.is_set()
            await child.close()

    run(exercise())


def test_unarmed_checkpoint_does_not_block():
    async def exercise():
        with RecoveryControl.parent(Environment.TEST, timeout=0.5) as parent:
            child = RecoveryControl.child(Environment.TEST, parent.environment)
            await asyncio.wait_for(child.checkpoint(POST_CLAIM), timeout=0.2)
            assert not parent.observations()
            await child.close()

    run(exercise())


def test_expired_checkpoint_fails_deterministically():
    async def exercise():
        with RecoveryControl.parent(Environment.TEST, timeout=0.1) as parent:
            child = RecoveryControl.child(Environment.TEST, parent.environment, timeout=0.05)
            parent.arm(POST_CLAIM)
            event_id = str(uuid4())
            task = asyncio.create_task(child.checkpoint(POST_CLAIM, event_id=event_id))
            await asyncio.to_thread(parent.wait_for_checkpoint, POST_CLAIM)
            with pytest.raises(ControlTimeout, match="checkpoint timed out"):
                await task
            timeout_observations = [
                item for item in parent.observations() if item.get("status") == "timeout"
            ]
            assert timeout_observations == [{
                "runId": parent.environment["AI_E2E04_CONTROL_RUN_ID"],
                "checkpoint": POST_CLAIM,
                "eventId": event_id,
                "status": "timeout",
            }]
            await child.close()

    run(exercise())


def test_parent_abort_releases_child_without_an_indefinite_wait():
    async def exercise():
        with RecoveryControl.parent(Environment.TEST, timeout=0.5) as parent:
            child = RecoveryControl.child(Environment.TEST, parent.environment)
            parent.arm(POST_CLAIM)
            task = asyncio.create_task(child.checkpoint(POST_CLAIM))
            await asyncio.to_thread(parent.wait_for_checkpoint, POST_CLAIM)
            parent.abort()
            with pytest.raises(ControlAborted, match="control channel aborted"):
                await asyncio.wait_for(task, timeout=0.5)
            await child.close()

    run(exercise())


def test_child_close_is_observed_as_control_channel_closure():
    async def exercise():
        with RecoveryControl.parent(Environment.TEST, timeout=0.1) as parent:
            child = RecoveryControl.child(Environment.TEST, parent.environment)
            parent.arm(POST_CLAIM)
            task = asyncio.create_task(child.checkpoint(POST_CLAIM))
            await asyncio.to_thread(parent.wait_for_checkpoint, POST_CLAIM)
            await child.close()
            with pytest.raises(ControlClosed, match="control channel closed"):
                await asyncio.wait_for(task, timeout=0.5)

    run(exercise())


def test_independent_runs_cannot_consume_each_others_control_messages():
    async def exercise():
        with (RecoveryControl.parent(Environment.TEST, timeout=0.1) as first,
              RecoveryControl.parent(Environment.TEST, timeout=0.1) as second):
            child = RecoveryControl.child(Environment.TEST, second.environment)
            first.arm(POST_CLAIM)
            await child.checkpoint(POST_CLAIM)
            assert not first.observations()
            with pytest.raises(ControlTimeout):
                await asyncio.to_thread(first.wait_for_checkpoint, POST_CLAIM)
            await child.close()

    run(exercise())


def test_diagnostic_output_is_sanitized():
    secret = "claim-token-secret"
    raw = {
        "eventId": str(uuid4()),
        "deliveryTag": 7,
        "channel": 3,
        "redelivered": False,
        "action": "ack",
        "phase": "invoked",
        "claimToken": secret,
        "body": "raw transcript",
        "providerPayload": "provider response",
    }
    sanitized = sanitize_observation(raw)
    assert secret not in json.dumps(sanitized)
    assert "raw transcript" not in json.dumps(sanitized)
    assert "provider response" not in json.dumps(sanitized)
    assert set(sanitized) == {"eventId", "deliveryTag", "channel", "redelivered", "action", "phase"}


def test_delivery_observations_cover_ack_nack_and_reject_without_control_leakage():
    async def exercise():
        event_id = str(uuid4())
        with RecoveryControl.parent(Environment.TEST, timeout=0.5) as parent:
            child = RecoveryControl.child(Environment.TEST, parent.environment)
            for action in ("ack", "nack", "reject"):
                await child.observe_delivery(
                    event_id=event_id, delivery_tag=9, channel=4, redelivered=True,
                    action=action, phase="invoked",
                )
                await child.observe_delivery(
                    event_id=event_id, delivery_tag=9, channel=4, redelivered=True,
                    action=action, phase="client_completed",
                )
            observations = parent.observations()
            assert {(item["action"], item["phase"]) for item in observations} == {
                (action, phase) for action in ("ack", "nack", "reject")
                for phase in ("invoked", "client_completed")
            }
            await child.close()

    run(exercise())


def test_existing_ack_observer_semantics_are_unchanged_without_fault_injection(monkeypatch, capsys):
    ai = Path(__file__).resolve().parents[4] / "services" / "ai"
    monkeypatch.syspath_prepend(str(ai / "tests" / "integration"))
    import e2e04_worker_process as observer

    async def handle(self, delivery):
        await delivery.ack()

    monkeypatch.setattr(observer.TranscriptionWorker, "handle", handle)
    observer.install_diagnostics(RecoveryControl.child(Environment.DEVELOPMENT, {}))

    class Delivery:
        message_id = str(uuid4())
        delivery_tag = 42
        channel = SimpleNamespace(number=7)
        redelivered = False

        async def ack(self):
            return None

    run(observer.TranscriptionWorker.handle(None, Delivery()))
    records = [
        json.loads(line.removeprefix("E2E04_ACK "))
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("E2E04_ACK ")
    ]
    assert [record["operation"] for record in records] == ["invoked", "client_completed"]
