"""Offline tests for run-owned, bounded fault adapters."""

from __future__ import annotations

import sys
from pathlib import Path
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from fault_adapters import (  # noqa: E402
    DockerFaultRunner,
    FaultAdapter,
    FaultAdapterError,
)
from fault_scope import FaultScope  # noqa: E402


def scope():
    return FaultScope(
        str(uuid4()),
        {"qdrant": "1" * 64, "worker": "2" * 64},
    )


def test_adapter_delegates_only_scope_generated_commands():
    calls = []
    adapter = FaultAdapter(scope(), calls.append)

    adapter.stop("qdrant")
    adapter.start("worker")
    adapter.restart("qdrant")

    assert calls == [
        ("docker", "stop", "1" * 64),
        ("docker", "start", "2" * 64),
        ("docker", "stop", "1" * 64),
        ("docker", "start", "1" * 64),
    ]


def test_adapter_does_not_start_after_a_failed_stop():
    calls = []

    def runner(command):
        calls.append(command)
        raise RuntimeError("unit-only failure")

    with pytest.raises(FaultAdapterError):
        FaultAdapter(scope(), runner).restart("qdrant")
    assert calls == [("docker", "stop", "1" * 64)]


def test_docker_runner_rejects_commands_outside_the_bounded_scope(monkeypatch):
    runner = DockerFaultRunner(binary="/usr/bin/docker")
    with pytest.raises(FaultAdapterError):
        runner(("docker", "rm", "1" * 64))
    with pytest.raises(FaultAdapterError):
        runner(("docker", "stop", "foreign"))


def test_docker_runner_uses_scrubbed_no_shell_execution(monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return type("Result", (), {"returncode": 0})()

    monkeypatch.setattr("fault_adapters.subprocess.run", run)
    DockerFaultRunner(binary="/usr/bin/docker")(("docker", "stop", "1" * 64))
    command, kwargs = calls[0]
    assert command == ["/usr/bin/docker", "stop", "1" * 64]
    assert kwargs["shell"] is False
    assert kwargs["capture_output"] is False
    assert kwargs["env"]["PATH"] == "/usr/local/bin:/usr/bin:/bin"
    assert "unit" not in kwargs["env"]
