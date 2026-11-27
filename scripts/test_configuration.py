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


def test_render_secure_environment_resolves_protected_qdrant_key(tmp_path):
    secret = tmp_path / "qdrant-api-key"
    secret.write_text("qdrant-key\n", encoding="utf-8")
    secret.chmod(0o600)
    source = tmp_path / "secure.env"
    source.write_text(
        f"QDRANT_API_KEY=\nQDRANT_API_KEY_FILE={secret}\nBROKER_DNS=rabbitmq.internal\n",
        encoding="utf-8",
    )
    source.chmod(0o600)
    destination = tmp_path / "runtime" / "secure.env"

    configuration.render_secure_environment(source, destination)

    assert destination.stat().st_mode & 0o077 == 0
    rendered = destination.read_text(encoding="utf-8")
    assert "QDRANT_API_KEY=qdrant-key\n" in rendered
    assert "QDRANT_API_KEY_FILE" not in rendered
    assert "BROKER_DNS=rabbitmq.internal\n" in rendered


def test_render_secure_environment_rejects_unprotected_qdrant_key_source(tmp_path):
    secret = tmp_path / "qdrant-api-key"
    secret.write_text("qdrant-key\n", encoding="utf-8")
    secret.chmod(0o644)
    source = tmp_path / "secure.env"
    source.write_text(f"QDRANT_API_KEY_FILE={secret}\n", encoding="utf-8")
    source.chmod(0o600)

    try:
        configuration.render_secure_environment(source, tmp_path / "runtime.env")
    except configuration.ConfigurationCheckError as error:
        assert "protected secret" in str(error)
    else:
        raise AssertionError("unsafe protected source was accepted")


def test_migration_rejects_symlink_without_following_it(tmp_path):
    target = tmp_path / "target"
    target.write_text("SECRET=value\n", encoding="utf-8")
    target.chmod(0o600)
    legacy = tmp_path / "services/ai/.env.knowledge"
    legacy.parent.mkdir(parents=True)
    legacy.symlink_to(target)

    assert configuration.migration_check(tmp_path) == 1


def _acl(*, named_uid: int, named_permissions: int, mask: int):
    return {
        (configuration._ACL_USER_OBJ, 0): 0o7,
        (configuration._ACL_USER, named_uid): named_permissions,
        (configuration._ACL_GROUP_OBJ, 0): 0,
        (configuration._ACL_MASK, 0): mask,
        (configuration._ACL_OTHER, 0): 0,
    }


def test_acl_backed_private_key_allows_declared_workload_uid(tmp_path, monkeypatch):
    directory = tmp_path / "tls"
    directory.mkdir()
    directory.chmod(0o750)
    key = directory / "tls.key"
    key.write_text("not-a-real-key\n", encoding="utf-8")
    key.chmod(0o640)
    environment = tmp_path / ".env"
    environment.write_text(f"BROKER_TLS_DIR={directory}\n", encoding="utf-8")
    environment.chmod(0o600)

    directory_acl = _acl(named_uid=999, named_permissions=0o5, mask=0o5)
    key_acl = _acl(named_uid=999, named_permissions=0o4, mask=0o4)
    monkeypatch.setattr(
        configuration,
        "_read_posix_acl",
        lambda path: directory_acl if path == directory else key_acl,
    )

    assert configuration.check_directory_setting(
        environment,
        "BROKER_TLS_DIR",
        ("tls.key",),
        allowed_acl_uids=frozenset({999}),
    ) == 0


def test_acl_backed_private_key_rejects_undeclared_workload_uid(tmp_path, monkeypatch):
    directory = tmp_path / "tls"
    directory.mkdir()
    key = directory / "tls.key"
    key.write_text("not-a-real-key\n", encoding="utf-8")
    key.chmod(0o640)
    environment = tmp_path / ".env"
    environment.write_text(f"BROKER_TLS_DIR={directory}\n", encoding="utf-8")
    environment.chmod(0o600)
    acl = _acl(named_uid=999, named_permissions=0o4, mask=0o4)
    monkeypatch.setattr(configuration, "_read_posix_acl", lambda _path: acl)

    assert configuration.check_directory_setting(
        environment,
        "BROKER_TLS_DIR",
        ("tls.key",),
        allowed_acl_uids=frozenset({10001}),
    ) == 1


def test_public_certificate_may_be_other_readable_without_write_access(tmp_path):
    directory = tmp_path / "tls"
    directory.mkdir(mode=0o700)
    certificate = directory / "issuer-ca.crt"
    certificate.write_text("public certificate\n", encoding="utf-8")
    certificate.chmod(0o644)
    environment = tmp_path / ".env"
    environment.write_text(f"BROKER_TLS_DIR={directory}\n", encoding="utf-8")
    environment.chmod(0o600)

    assert configuration.check_directory_setting(
        environment,
        "BROKER_TLS_DIR",
        ("issuer-ca.crt",),
    ) == 0


def test_web_environment_requires_fixed_local_core_proxy(tmp_path):
    environment = tmp_path / ".env"
    environment.write_text(
        "VITE_CORE_API_BASE_URL=/api/v1\n"
        "VITE_CORE_API_PROXY_TARGET=http://127.0.0.1:8080\n",
        encoding="utf-8",
    )
    environment.chmod(0o600)

    assert configuration.check_web_environment(environment) == 0
