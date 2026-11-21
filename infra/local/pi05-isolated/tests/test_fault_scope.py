"""Offline tests for strict project-owned fault targeting."""

from __future__ import annotations

from pathlib import Path
import sys

import pytest


HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from fault_scope import FaultScope, FaultScopeError  # noqa: E402


RUN_ID = "5cf6be2a-0a06-46bb-a040-729db426b022"


def scope():
    return FaultScope(
        RUN_ID,
        {
            "qdrant": "1" * 64,
            "rabbitmq": "2" * 64,
            "worker": "3" * 64,
        },
    )


def test_fault_commands_target_only_verified_run_container_ids():
    value = scope()

    assert value.command("stop", "qdrant") == ("docker", "stop", "1" * 64)
    assert value.command("start", "worker") == ("docker", "start", "3" * 64)


@pytest.mark.parametrize(
    ("action", "service"),
    [
        ("rm", "qdrant"),
        ("stop", "database"),
        ("disconnect", "rabbitmq"),
        ("stop;docker", "qdrant"),
    ],
)
def test_fault_scope_rejects_destructive_or_unowned_targets(action, service):
    with pytest.raises(FaultScopeError):
        scope().command(action, service)


@pytest.mark.parametrize(
    "containers",
    [
        {"qdrant": "foreign"},
        {"qdrant": "1" * 63},
        {"qdrant": "1" * 64, "rabbitmq": "1" * 64, "worker": "3" * 64},
    ],
)
def test_fault_scope_rejects_invalid_or_ambiguous_container_identity(containers):
    with pytest.raises(FaultScopeError):
        FaultScope(RUN_ID, containers)
