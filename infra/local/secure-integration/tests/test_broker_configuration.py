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


def test_diarization_opt_in_has_dedicated_durable_route_and_bounded_recovery():
    definitions = broker.definitions("fixture", {"publisher": "core", "worker": "ai", "reconciler": "dlq"}, diarization=True)
    queues = {q["name"]: q for q in definitions["queues"]}
    assert set(queues) == {broker.WORK, broker.DEAD, broker.DIARIZATION_WORK, broker.DIARIZATION_DEAD}
    args = queues[broker.DIARIZATION_WORK]["arguments"]
    assert queues[broker.DIARIZATION_WORK]["durable"] and args["x-queue-type"] == "quorum"
    assert args["x-delivery-limit"] == 5 and args["x-dead-letter-strategy"] == "at-least-once"
    assert any(b["destination"] == broker.DIARIZATION_WORK and b["routing_key"] == "processing.diarization.requested"
               for b in definitions["bindings"])
    import re
    worker = next(p for p in definitions["permissions"] if p["user"] == "ai")
    assert re.fullmatch(worker["read"], broker.WORK)
    assert re.fullmatch(worker["read"], broker.DIARIZATION_WORK)
    assert worker["configure"] == worker["write"] == "^$"


def test_intelligence_opt_in_has_dedicated_route_and_identity_without_dlq_replay():
    definitions = broker.definitions("fixture", {
        "publisher": "core", "worker": "ai", "reconciler": "dlq", "intelligence": "mi",
    }, intelligence=True)
    queues = {q["name"]: q for q in definitions["queues"]}
    assert set(queues) == {broker.WORK, broker.DEAD, broker.INTELLIGENCE_WORK, broker.INTELLIGENCE_DEAD}
    work = queues[broker.INTELLIGENCE_WORK]["arguments"]
    dead = queues[broker.INTELLIGENCE_DEAD]["arguments"]
    assert work["x-queue-type"] == "quorum"
    assert work["x-delivery-limit"] == 5
    assert work["x-dead-letter-routing-key"] == broker.INTELLIGENCE_DEAD
    assert dead["x-queue-type"] == "quorum"
    assert "x-dead-letter-exchange" not in dead
    assert any(binding["destination"] == broker.INTELLIGENCE_WORK
               and binding["routing_key"] == broker.INTELLIGENCE_ROUTE
               for binding in definitions["bindings"])
    permissions = {permission["user"]: permission for permission in definitions["permissions"]}
    assert permissions["mi"]["read"] == r"^meeting\.processing\.intelligence$"
    assert permissions["mi"]["write"] == permissions["mi"]["configure"] == "^$"
    assert permissions["ai"]["read"] == r"^meeting\.processing\.jobs$"
    assert permissions["dlq"]["read"] == r"^(?:meeting\.processing\.jobs\.dead|meeting\.processing\.intelligence\.dead)$"


def test_knowledge_opt_in_has_dedicated_route_and_consumer_identity():
    definitions = broker.definitions("fixture", {
        "publisher": "core", "worker": "ai", "reconciler": "dlq", "knowledge": "rag",
    }, knowledge=True)
    queues = {q["name"]: q for q in definitions["queues"]}
    assert set(queues) == {broker.WORK, broker.DEAD, broker.KNOWLEDGE_WORK, broker.KNOWLEDGE_DEAD}
    work = queues[broker.KNOWLEDGE_WORK]["arguments"]
    dead = queues[broker.KNOWLEDGE_DEAD]["arguments"]
    assert work["x-queue-type"] == "quorum"
    assert work["x-delivery-limit"] == 5
    assert work["x-dead-letter-routing-key"] == broker.KNOWLEDGE_DEAD
    assert dead["x-queue-type"] == "quorum"
    assert any(binding["destination"] == broker.KNOWLEDGE_WORK
               and binding["routing_key"] == broker.KNOWLEDGE_ROUTE
               for binding in definitions["bindings"])
    permissions = {permission["user"]: permission for permission in definitions["permissions"]}
    assert permissions["rag"]["read"] == r"^meeting\.knowledge\.indexing$"
    assert permissions["rag"]["write"] == permissions["rag"]["configure"] == "^$"
