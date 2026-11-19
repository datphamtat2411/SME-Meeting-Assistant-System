"""Focused tests for development Compose ownership state."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "dev_infra.py"
SPEC = importlib.util.spec_from_file_location("dev_infra", SCRIPT)
assert SPEC and SPEC.loader
dev_infra = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev_infra)


def test_verify_rejects_a_foreign_compose_project(monkeypatch):
    monkeypatch.setattr(
        dev_infra,
        "container_snapshot",
        lambda _project: [{
            "project": "other-project",
            "service": "postgres",
            "status": "running",
            "health": "healthy",
        }],
    )
    with pytest.raises(dev_infra.InfrastructureError, match="another Compose"):
        dev_infra._validate_project(
            "expected-project",
            ("postgres",),
            ("postgres_data",),
            frozenset({"postgres"}),
            frozenset(),
        )


def test_record_and_clear_only_dev_sh_owned_services(tmp_path, monkeypatch):
    state = tmp_path / "state" / "dependencies.json"
    before = tmp_path / "before"
    before.write_text("postgres\trunning\n", encoding="utf-8")
    monkeypatch.setattr(
        dev_infra,
        "container_snapshot",
        lambda _project: [
            {"service": "postgres", "status": "running"},
            {"service": "rabbitmq", "status": "running"},
        ],
    )
    dev_infra.record_owned(
        state,
        "project",
        ("postgres", "rabbitmq"),
        before,
    )

    assert dev_infra.owned_services(state, "project") == ["rabbitmq"]
    value = json.loads(state.read_text(encoding="utf-8"))
    assert value["projects"]["project"]["services"] == ["rabbitmq"]

    dev_infra.clear_project(state, "project")
    assert not state.exists()


def test_missing_project_in_shared_ownership_state_is_not_malformed(tmp_path):
    state = tmp_path / "state" / "dependencies.json"
    state.parent.mkdir(mode=0o700)
    state.write_text(
        '{"projects":{"other":{"services":["postgres"]}}}\n',
        encoding="utf-8",
    )
    state.chmod(0o600)

    assert dev_infra.owned_services(state, "project") == []
