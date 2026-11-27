"""Focused lifecycle tests for dev.sh-owned host processes."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "dev_process.py"
SPEC = importlib.util.spec_from_file_location("dev_process", SCRIPT)
assert SPEC and SPEC.loader
dev_process = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev_process)


def test_lifecycle_owns_only_the_started_process(tmp_path):
    state_dir = tmp_path / "state"
    log = tmp_path / "logs" / "worker.log"
    result = dev_process.start(
        state_dir,
        "worker",
        tmp_path,
        log,
        [sys.executable, "-c", "import time; time.sleep(30)"],
    )
    try:
        assert result["running"] is True
        assert dev_process.status(state_dir, "worker")["running"] is True
    finally:
        stopped = dev_process.stop(state_dir, "worker")

    assert stopped == {"name": "worker", "running": False}
    assert dev_process.status(state_dir, "worker")["running"] is False


def test_running_process_rejects_a_changed_configuration_fingerprint(tmp_path):
    state_dir = tmp_path / "state"
    log = tmp_path / "logs" / "worker.log"
    command = [sys.executable, "-c", "import time; time.sleep(30)"]
    fingerprint = "a" * 64
    dev_process.start(state_dir, "worker", tmp_path, log, command, fingerprint)
    try:
        with pytest.raises(dev_process.ProcessError, match="configuration"):
            dev_process.start(state_dir, "worker", tmp_path, log, command, "b" * 64)
    finally:
        dev_process.stop(state_dir, "worker")
