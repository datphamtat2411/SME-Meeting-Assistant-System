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


def test_meeting_intelligence_activation_keys_are_run_owned_and_not_synthesized():
    baseline = module_env.build_core_environment(_api(), _postgres(), inherited={})
    assert "APP_MEDIA_INTELLIGENCE_STORAGE_ID" not in baseline
    assert "APP_MEDIA_INTELLIGENCE_ENABLED_STAGES" not in baseline
    assert "APP_MEDIA_PROCESSING_REQUIRED_DOWNSTREAM_STAGES" not in baseline

    activation = {
        "APP_MEDIA_INTELLIGENCE_ENABLED": "true",
        "APP_MEDIA_INTELLIGENCE_DISPATCH_ENABLED": "true",
        "APP_MEDIA_INTELLIGENCE_INFRASTRUCTURE_VERIFIED": "true",
        "APP_MEDIA_INTELLIGENCE_STORAGE_ID": "approved-existing-alias",
        "APP_MEDIA_INTELLIGENCE_ENABLED_STAGES": (
            "GENERATING_SUMMARY,EXTRACTING_DECISIONS,EXTRACTING_ACTION_ITEMS"
        ),
        "APP_MEDIA_PROCESSING_REQUIRED_DOWNSTREAM_STAGES": (
            "GENERATING_SUMMARY,EXTRACTING_DECISIONS,EXTRACTING_ACTION_ITEMS"
        ),
        "APP_MEDIA_PROCESSING_ACTION_ITEM_HANDOFF_ENABLED": "true",
        "APP_MI_INTERNAL_RESULT_ENABLED": "true",
    }
    result = module_env.build_core_environment(_api() | activation, _postgres(), inherited={})

    for name, value in activation.items():
        assert result[name] == value


def test_core_result_acceptance_token_uses_a_protected_file(tmp_path):
    token = tmp_path / "mi-core-result-acceptance-token"
    token.write_text("mi-acceptance-token\n", encoding="utf-8")
    token.chmod(0o600)

    result = module_env.build_core_environment(
        _api() | {
            "APP_MI_INTERNAL_RESULT_TOKEN": "",
            "APP_MI_INTERNAL_RESULT_TOKEN_FILE": str(token),
        },
        _postgres(),
        inherited={},
    )

    assert result["APP_MI_INTERNAL_RESULT_TOKEN"] == "mi-acceptance-token"
    assert "APP_MI_INTERNAL_RESULT_TOKEN_FILE" not in result


def test_missing_postgres_setting_is_rejected_without_value():
    values = _postgres()
    values["POSTGRES_PASSWORD"] = ""

    with pytest.raises(module_env.ModuleEnvironmentError, match="incomplete"):
        module_env.build_core_environment(_api(), values, inherited={})
