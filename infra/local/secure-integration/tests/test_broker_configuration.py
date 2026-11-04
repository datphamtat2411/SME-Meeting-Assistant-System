import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("broker_configuration", Path(__file__).parents[1] / "broker.py")
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


def test_quorum_contract_and_non_administrative_permissions():
    definitions = broker.definitions("fixture", {"publisher": "core", "worker": "ai", "reconciler": "dlq"})
    queues = {q["name"]: q for q in definitions["queues"]}
    assert set(queues) == {broker.WORK, broker.DEAD}
    assert all(q["durable"] and q["arguments"]["x-queue-type"] == "quorum" for q in queues.values())
    args = queues[broker.WORK]["arguments"]
    assert args["x-delivery-limit"] == 5
    assert args["x-overflow"] == "reject-publish"
    assert args["x-dead-letter-strategy"] == "at-least-once"
    assert "x-dead-letter-exchange" not in queues[broker.DEAD]["arguments"]
    assert all(p["configure"] == "^$" for p in definitions["permissions"])


def test_migration_readiness_rejects_nonempty_or_active_queues():
    for field in ("messages", "messages_ready", "messages_unacknowledged", "consumers"):
        with pytest.raises(broker.Blocked):
            broker.migration_ready([{field: 1}])
    broker.migration_ready([{"messages": 0, "messages_ready": 0, "messages_unacknowledged": 0, "consumers": 0}])
    with pytest.raises(broker.Blocked):
        broker.migration_ready([{"messages": 1, "messages_ready": 0, "messages_unacknowledged": 0, "consumers": 0}])
    with pytest.raises(broker.Blocked):
        broker.migration_ready([{"name": broker.WORK, "type": "quorum", "messages": 0,
            "messages_ready": 0, "messages_unacknowledged": 0, "consumers": 0, "retained_dead_letters": 1}])
    with pytest.raises(broker.Blocked):
        broker.migration_ready([{}])
