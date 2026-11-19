"""Offline tests for explicit run-owned application process wiring."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from application_runtime import (  # noqa: E402
    ApplicationRuntime,
    RuntimeWiringError,
)
from process_supervisor import ProcessSpec  # noqa: E402


def runtime(tmp_path, monkeypatch):
    run_id = str(uuid4())
    base = tmp_path / "runs"
    root = base / run_id
    root.mkdir(mode=0o700, parents=True)
    source = tmp_path / "checkout"
    (source / "services" / "api").mkdir(mode=0o700, parents=True)
    (source / "services" / "ai").mkdir(mode=0o700, parents=True)
    return ApplicationRuntime(
        run_id,
        root,
        source_root=source,
        runs_base=base,
        commands={
            "core": (sys.executable, "-c", "import time; time.sleep(60)"),
            "ai-http": (sys.executable, "-c", "import time; time.sleep(60)"),
            "transcription-worker": (sys.executable, "-c", "import time; time.sleep(60)"),
            "mi-worker": (sys.executable, "-c", "import time; time.sleep(60)"),
            "knowledge-worker": (sys.executable, "-c", "import time; time.sleep(60)"),
        },
    )


def environments():
    return {
        "core": {"SPRING_PROFILES_ACTIVE": "secure-integration"},
        "ai-http": {"AI_ENVIRONMENT": "test"},
        "transcription-worker": {
            "AI_ENVIRONMENT": "test",
            "AI_WORKER_ROLE": "transcription",
            "AI_SERVICE_IDENTITY": "ai-worker",
        },
        "mi-worker": {
            "AI_ENVIRONMENT": "test",
            "AI_WORKER_ROLE": "meeting-intelligence",
            "AI_SERVICE_IDENTITY": "mi-worker",
        },
        "knowledge-worker": {
            "AI_ENVIRONMENT": "test",
            "AI_WORKER_ROLE": "knowledge-indexing",
            "AI_SERVICE_IDENTITY": "knowledge-worker",
        },
    }


def test_runtime_builds_fixed_process_specs_without_inheriting_environment(tmp_path):
    value = runtime(tmp_path, None)
    specs = value.specs(environments())

    assert [spec.name for spec in specs] == [
        "ai-http", "core", "transcription-worker", "mi-worker", "knowledge-worker",
    ]
    assert all(isinstance(spec, ProcessSpec) for spec in specs)
    assert all(spec.cwd == value.source_root / "services" / ("api" if spec.name == "core" else "ai")
               for spec in specs)
    assert specs[0].env == environments()["ai-http"]
    assert [
        specs[index].env["AI_SERVICE_IDENTITY"]
        for index in (2, 3, 4)
    ] == ["ai-worker", "mi-worker", "knowledge-worker"]


def test_runtime_starts_and_stops_only_its_five_owned_processes(tmp_path):
    value = runtime(tmp_path, None)
    started = value.start_all(environments())
    try:
        assert {item["name"] for item in started} == {
            "core", "ai-http", "transcription-worker", "mi-worker", "knowledge-worker",
        }
        names = ("core", "ai-http", "transcription-worker", "mi-worker", "knowledge-worker")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not all(
            value.status(name)["running"] for name in names
        ):
            time.sleep(0.01)
        assert all(value.status(name)["running"] for name in names)
    finally:
        value.stop_all()
    assert all(not value.status(name)["running"] for name in (
        "core", "ai-http", "transcription-worker", "mi-worker", "knowledge-worker",
    ))


def test_runtime_can_stop_and_restart_one_owned_process(tmp_path):
    value = runtime(tmp_path, None)
    value.start_all(environments())
    try:
        original = value.status("transcription-worker")
        assert original["running"] is True

        value.stop("transcription-worker")
        assert value.status("transcription-worker")["running"] is False

        restarted = value.restart("transcription-worker", environments())
        assert restarted["name"] == "transcription-worker"
        assert restarted["pid"] != original["pid"]
        assert value.status("transcription-worker")["running"] is True
    finally:
        value.stop_all()


def test_runtime_requires_exact_process_environment_set(tmp_path):
    value = runtime(tmp_path, None)

    with pytest.raises(RuntimeWiringError):
        value.specs({"core": {}, "ai-http": {}})
    with pytest.raises(RuntimeWiringError):
        value.specs({**environments(), "unexpected": {}})


def test_runtime_rejects_shell_or_secret_arguments(tmp_path):
    run_id = str(uuid4())
    base = tmp_path / "runs"
    root = base / run_id
    root.mkdir(mode=0o700, parents=True)
    source = tmp_path / "checkout"
    (source / "services" / "api").mkdir(mode=0o700, parents=True)
    (source / "services" / "ai").mkdir(mode=0o700, parents=True)

    with pytest.raises(RuntimeWiringError):
        ApplicationRuntime(
            run_id,
            root,
            source_root=source,
            runs_base=base,
            commands={"core": ("sh", "-c", "echo unsafe")},
        )
