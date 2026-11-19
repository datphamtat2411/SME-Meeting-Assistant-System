"""Focused tests for Core/PostgreSQL launch-time mapping."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "module_env.py"
SPEC = importlib.util.spec_from_file_location("module_env", SCRIPT)
assert SPEC and SPEC.loader
module_env = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module_env)


def _api() -> dict[str, str]:
    return {
        "SPRING_PROFILES_ACTIVE": "secure-integration",
        "APP_MEDIA_OUTBOX_ENABLED": "true",
        "APP_WORKER_TRANSCRIPTION_ENABLED": "true",
        "APP_WORKER_TRANSCRIPTION_INFRASTRUCTURE_VERIFIED": "true",
        "APP_WORKER_DEAD_LETTER_ENABLED": "true",
        "APP_SECRET": "application-secret",
    }


def _postgres() -> dict[str, str]:
    return {
        "POSTGRES_DB": "meeting",
        "POSTGRES_USER": "core",
        "POSTGRES_PASSWORD": "database-secret",
        "POSTGRES_HOST": "127.0.0.1",
        "POSTGRES_PORT": "5433",
    }


def test_postgres_bootstrap_maps_to_core_without_forwarding_admin_names():
    result = module_env.build_core_environment(_api(), _postgres(), inherited={})

    assert result["DB_URL"] == "jdbc:postgresql://127.0.0.1:5433/meeting"
    assert result["DB_USERNAME"] == "core"
    assert result["DB_PASSWORD"] == "database-secret"
    assert "POSTGRES_PASSWORD" not in result
    assert json.loads(result["SPRING_APPLICATION_JSON"])["app"]["worker"]["transcription"] == {
        "enabled": True,
        "infrastructure-verified": True,
    }


def test_process_environment_overrides_canonical_values():
    result = module_env.build_core_environment(
        _api(),
        _postgres(),
        inherited={
            "APP_MEDIA_OUTBOX_ENABLED": "false",
            "POSTGRES_PASSWORD": "process-secret",
        },
    )

    assert result["DB_PASSWORD"] == "process-secret"
    assert json.loads(result["SPRING_APPLICATION_JSON"])["app"]["media"]["outbox"]["enabled"] is False


def test_missing_postgres_setting_is_rejected_without_value():
    values = _postgres()
    values["POSTGRES_PASSWORD"] = ""

    with pytest.raises(module_env.ModuleEnvironmentError, match="incomplete"):
        module_env.build_core_environment(_api(), values, inherited={})
