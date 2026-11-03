"""Focused, infrastructure-free tests of E2E-04 broker observation."""

import pytest
import test_worker_e2e04 as e2e


def queues(**changes):
    work = {"name": e2e.broker.WORK, "messages": 0, "messages_ready": 0,
            "messages_unacknowledged": 0, "consumers": 0, "retained_dead_letters": 0}
    work.update(changes)
    return [work, {"name": e2e.broker.DEAD, "messages": 0, "consumers": 1}]


@pytest.fixture
def observation(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(e2e.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(e2e.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    monkeypatch.setattr(e2e, "_consumer_metadata", lambda *args: "sanitized metadata")
    return clock


def test_already_settled_with_dead_queue_reconciler(monkeypatch, observation):
    monkeypatch.setattr(e2e.broker, "inspect", lambda *args: queues())
    e2e._assert_acknowledged("broker", timeout=2, interval=1)
    assert observation[0] == 0


def test_consumer_converges(monkeypatch, observation):
    snapshots = iter([queues(consumers=1), queues()])
    monkeypatch.setattr(e2e.broker, "inspect", lambda *args: next(snapshots))
    e2e._assert_acknowledged("broker", timeout=2, interval=1)
    assert observation[0] == 1


@pytest.mark.parametrize("work,dead", [
    ({"consumers": 1}, 0),
    ({"messages_unacknowledged": 1}, 0),
    ({}, 1),
    ({"retained_dead_letters": 1}, 0),
    ({"messages": 1}, 0),
    ({"messages_ready": 1}, 0),
])
def test_unsettled_fails_at_deadline(monkeypatch, observation, work, dead):
    snapshot = queues(**work)
    snapshot[1]["messages"] = dead
    monkeypatch.setattr(e2e.broker, "inspect", lambda *args: snapshot)
    with pytest.raises(AssertionError, match="broker settlement"):
        e2e._assert_acknowledged("broker", timeout=2, interval=1)
    assert observation[0] == 2


def test_inspection_failure_is_sanitized(monkeypatch, observation):
    def fail(*args):
        raise RuntimeError("secret payload credential")
    monkeypatch.setattr(e2e.broker, "inspect", fail)
    with pytest.raises(AssertionError, match="broker inspection failed") as error:
        e2e._assert_acknowledged("broker", timeout=2, interval=1)
    assert "secret" not in str(error.value)
