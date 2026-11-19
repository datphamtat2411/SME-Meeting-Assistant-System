"""Focused tests for non-destructive configuration migration checks."""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "configuration.py"
SPEC = importlib.util.spec_from_file_location("configuration", SCRIPT)
assert SPEC and SPEC.loader
configuration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(configuration)


def test_migration_inventory_does_not_change_legacy_file_or_print_values(tmp_path, capsys):
    root = tmp_path
    legacy = root / "services/ai/.env.knowledge"
    legacy.parent.mkdir(parents=True)
    legacy.write_text("AI_RAG_QDRANT_API_KEY=secret-that-must-not-print\n", encoding="utf-8")
    legacy.chmod(0o600)
    canonical = root / "services/ai/.env"
    canonical.write_text("AI_SERVICE_NAME=canonical\n", encoding="utf-8")
    canonical.chmod(0o600)

    assert configuration.migration_check(root) == 0
    output = capsys.readouterr().out

    assert "services/ai/.env.knowledge" in output
    assert "secret-that-must-not-print" not in output
    assert legacy.read_text(encoding="utf-8") == (
        "AI_RAG_QDRANT_API_KEY=secret-that-must-not-print\n"
    )


def test_require_settings_reports_only_missing_key_names(tmp_path, capsys):
    path = tmp_path / ".env"
    path.write_text("QDRANT_API_KEY=secret\n", encoding="utf-8")
    path.chmod(0o600)

    assert configuration.require_settings(path, ("QDRANT_API_KEY", "QDRANT_TLS_DIR")) == 1
    assert capsys.readouterr().err.strip().endswith("QDRANT_TLS_DIR")
    assert "secret" not in capsys.readouterr().out


def test_migration_rejects_symlink_without_following_it(tmp_path):
    target = tmp_path / "target"
    target.write_text("SECRET=value\n", encoding="utf-8")
    target.chmod(0o600)
    legacy = tmp_path / "services/ai/.env.knowledge"
    legacy.parent.mkdir(parents=True)
    legacy.symlink_to(target)

    assert configuration.migration_check(tmp_path) == 1
