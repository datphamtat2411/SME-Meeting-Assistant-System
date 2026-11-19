"""Offline tests for the run-owned PI-05 process supervisor."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import time

import pytest


HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from process_supervisor import (  # noqa: E402
    ProcessSpec,
    RunSupervisor,
    SupervisorError,
)


RUN_ID = "5cf6be2a-0a06-46bb-a040-729db426b022"


@pytest.fixture
def supervisor(tmp_path):
    base = tmp_path / "runs"
    root = base / RUN_ID
    root.mkdir(parents=True, mode=0o700)
    root.chmod(0o700)
    source = tmp_path / "source"
    source.mkdir(mode=0o700)
    return RunSupervisor(RUN_ID, root, runs_base=base, source_root=source)


def test_start_scrubs_inherited_environment_and_stop_is_bounded(supervisor):
    script = (
        "import os,time; "
        "print(os.environ.get('PI05_RUN_ID','missing')); "
        "print(os.environ.get('SUPERVISOR_TEST_VALUE','missing')); "
        "print('INHERITED=' + os.environ.get('SUPERVISOR_FORBIDDEN','missing'), flush=True); "
        "time.sleep(30)"
    )
    spec = ProcessSpec(
        name="worker",
        command=(sys.executable, "-c", script),
        cwd=supervisor.root,
        env={"SUPERVISOR_TEST_VALUE": "present"},
    )
    try:
        record = supervisor.start(spec)
        assert record["name"] == "worker"
        assert supervisor.status("worker")["running"] is True
        time.sleep(0.05)
        supervisor.stop("worker", timeout=2)
        result = supervisor.status("worker")
        assert result["running"] is False
        log = Path(record["log"])
        assert log.stat().st_mode & 0o777 == 0o600
        text = log.read_text()
        assert RUN_ID in text
        assert "present" in text
        assert "INHERITED=missing" in text
    finally:
        if supervisor.status("worker")["running"]:
            supervisor.stop("worker", timeout=2)


def test_restart_uses_a_new_exclusive_log(supervisor):
    spec = ProcessSpec(
        name="short",
        command=(sys.executable, "-c", "print('one')"),
        cwd=supervisor.root,
        env={},
    )
    first = supervisor.start(spec)
    supervisor.wait("short", timeout=2)
    second = supervisor.start(spec)
    supervisor.wait("short", timeout=2)

    assert first["log"] != second["log"]
    assert Path(first["log"]).read_text().strip() == "one"
    assert Path(second["log"]).read_text().strip() == "one"


def test_cannot_start_same_name_while_owned_process_is_running(supervisor):
    spec = ProcessSpec(
        name="duplicate",
        command=(sys.executable, "-c", "import time; time.sleep(30)"),
        cwd=supervisor.root,
        env={},
    )
    try:
        supervisor.start(spec)
        with pytest.raises(SupervisorError, match="already running"):
            supervisor.start(spec)
    finally:
        if supervisor.status("duplicate")["running"]:
            supervisor.stop("duplicate", timeout=2)


def test_rejects_unsafe_working_directory_and_loader_environment(supervisor, tmp_path):
    with pytest.raises(SupervisorError):
        supervisor.start(ProcessSpec(
            name="outside",
            command=(sys.executable, "-c", "pass"),
            cwd=tmp_path,
            env={},
        ))
    with pytest.raises(SupervisorError):
        supervisor.start(ProcessSpec(
            name="loader",
            command=(sys.executable, "-c", "pass"),
            cwd=supervisor.root,
            env={"LD_PRELOAD": "unexpected"},
        ))


def test_foreign_pid_state_is_never_signalled(supervisor, monkeypatch):
    state = supervisor.state_dir / "foreign.json"
    state.write_text(
        '{"name":"foreign","pid":99999999,"starttime":"0","pgid":99999999,'
        '"command":["/bin/false"],"log":"foreign.log"}'
    )
    state.chmod(0o600)
    calls = []
    monkeypatch.setattr(os, "killpg", lambda *args: calls.append(args))

    result = supervisor.stop("foreign", timeout=0.1)

    assert result["running"] is False
    assert calls == []


def test_reopened_supervisor_can_inspect_existing_run_state(supervisor):
    reopened = RunSupervisor(
        RUN_ID,
        supervisor.root,
        runs_base=supervisor.root.parent,
        source_root=supervisor.source_root,
    )

    assert reopened.status("missing")["running"] is False
