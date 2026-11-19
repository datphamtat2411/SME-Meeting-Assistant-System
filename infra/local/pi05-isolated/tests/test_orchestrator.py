"""Offline tests for PI-05 orchestration metadata handling."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from orchestrator import (
    OrchestrationError,
    read_orchestration_config,
    resolve_run,
)


def test_repository_config_selects_only_non_secret_orchestration_settings(tmp_path):
    path = tmp_path / ".env"
    path.write_text(
        "PI05_RUN_BASE_DIR=~/.local/share/sme-pi05/runs\n"
        "PI05_RUN_ID=5cf6be2a-0a06-46bb-a040-729db426b022\n"
        "PI05_ACTION_PASSWORD=secret-that-is-not-consumed\n"
        "PI05_REQUIRE_FRESH_PROJECT=true\n",
        encoding="utf-8",
    )
    path.chmod(0o600)

    values = read_orchestration_config(path)
    run_id, root, base, manifest = resolve_run(values)

    assert run_id == "5cf6be2a-0a06-46bb-a040-729db426b022"
    assert root == base / run_id
    assert manifest == root / "secrets/runtime-input.env"
    assert "PI05_ACTION_PASSWORD" not in values


def test_repository_config_rejects_shell_interpolation_in_paths(tmp_path):
    path = tmp_path / ".env"
    path.write_text("PI05_RUN_BASE_DIR=$HOME/private-runs\n", encoding="utf-8")
    path.chmod(0o600)

    with pytest.raises(OrchestrationError, match="shell interpolation"):
        resolve_run(read_orchestration_config(path))
