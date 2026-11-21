"""Offline-only tests for the PI-05 infrastructure preparation."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
REPO = HERE.parents[2]
RUN_ID = "5cf6be2a-0a06-46bb-a040-729db426b022"
PROJECT = f"pi05-{RUN_ID}"
PG_SECRET, BROKER_SECRET, STORAGE_SECRET, QDRANT_SECRET = (
    hashlib.sha256(f"unit-only-{name}".encode()).hexdigest()
    for name in ("postgres", "broker", "storage", "qdrant")
)

spec = importlib.util.spec_from_file_location("pi05_preflight", HERE / "preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)
sys.modules["preflight"] = preflight
secret_spec = importlib.util.spec_from_file_location("pi05_secrets", HERE / "prepare_secrets.py")
secret_tool = importlib.util.module_from_spec(secret_spec)
secret_spec.loader.exec_module(secret_tool)


def make_run(tmp_path):
    base = tmp_path / "runs"
    root = base / RUN_ID
    (root / "secrets").mkdir(parents=True, mode=0o700)
    root.chmod(0o700)
    (root / "secrets").chmod(0o700)
    (root / "pki").mkdir(mode=0o700)
    envs = {
        "postgres.env": {
            "POSTGRES_DB": "pi05db",
            "POSTGRES_USER": "pi05dbuser",
            "POSTGRES_PASSWORD": PG_SECRET,
        },
        "broker.env": {
            "RABBITMQ_DEFAULT_USER": "pi05admin",
            "RABBITMQ_DEFAULT_PASS": BROKER_SECRET,
            "RABBITMQ_DEFAULT_VHOST": "sme-integration",
        },
        "storage.env": {"RUSTFS_ACCESS_KEY": "pi05storage", "RUSTFS_SECRET_KEY": STORAGE_SECRET},
        "qdrant.env": {"QDRANT__SERVICE__API_KEY": QDRANT_SECRET},
    }
    for name, values in envs.items():
        path = root / "secrets" / name
        path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        path.chmod(0o600)
    for directory, names in {
        "broker-server": ("tls.crt", "tls.key", "issuer-ca.crt"),
        "storage-server": ("rustfs_cert.pem", "rustfs_key.pem", "issuer-ca.crt"),
        "qdrant-server": ("tls.crt", "tls.key", "issuer-ca.crt"),
    }.items():
        role = root / "pki" / directory
        role.mkdir(parents=True, mode=0o700)
        role.chmod(0o700)
        for name in names:
            path = role / name
            path.write_text("unit-only placeholder")
            path.chmod(0o600)
    return base, root


def compose_config(root, run_id=RUN_ID):
    env = {
        "HOME": str(Path.home()),
        "PATH": os.environ["PATH"],
        "PI05_RUN_ID": run_id,
        "PI05_RUN_ROOT": str(root),
    }
    result = subprocess.run(
        ["docker", "compose", "--env-file", "/dev/null", "-f", str(HERE / "compose.yaml"),
         "config", "--format", "json"],
        env=env, capture_output=True, text=True, timeout=30, check=True,
    )
    return json.loads(result.stdout)


def test_compose_uses_run_scoped_volumes_and_loopback_ephemeral_ports(tmp_path):
    _, root = make_run(tmp_path)
    config = compose_config(root)
    assert config["name"] == PROJECT
    assert set(config["services"]) == {
        "postgres", "rabbitmq", "storage-permissions", "storage", "storage-boundary",
        "qdrant-permissions", "qdrant",
    }
    for volume in config["volumes"].values():
        assert volume["name"].startswith(PROJECT + "_")
        assert not volume.get("external", False)
    expected_ports = {"postgres": 5432, "rabbitmq": 5671, "storage-boundary": 9000, "qdrant": 6333}
    for name, service in config["services"].items():
        ports = service.get("ports", [])
        if name in expected_ports:
            assert len(ports) == 1
            assert ports[0]["host_ip"] == "127.0.0.1"
            assert ports[0]["target"] == expected_ports[name]
            assert ports[0].get("published") in (None, 0, "0")
        else:
            assert not ports
    assert config["networks"]["integration"]["internal"] is True
    assert config["networks"]["storage-backend"]["internal"] is True
    assert set(config["services"]["storage"]["networks"]) == {"storage-backend"}
    for name in ("storage-permissions", "qdrant-permissions"):
        assert config["services"][name]["network_mode"] == "none"
    assert "default" not in config["networks"]


def test_compose_requires_qdrant_tls_key_and_scoped_read_only_mounts(tmp_path):
    _, root = make_run(tmp_path)
    config = compose_config(root)
    qdrant = config["services"]["qdrant"]
    assert qdrant["image"] == "qdrant/qdrant:v1.20.0"
    assert qdrant["user"] == "10001:10001"
    assert qdrant["environment"]["QDRANT__SERVICE__ENABLE_TLS"] == "true"
    assert qdrant["environment"]["QDRANT__SERVICE__API_KEY"] == QDRANT_SECRET
    assert "QDRANT__SERVICE__API_KEY" in " ".join(qdrant["command"])
    assert "exit 1" in " ".join(qdrant["command"])
    for service in config["services"].values():
        for mount in service.get("volumes", []):
            if mount["type"] == "bind":
                assert mount["read_only"] is True
                source = Path(mount["source"])
                assert source.is_relative_to(root) or source.is_relative_to(REPO / "infra/local/secure-integration")
                assert not mount.get("bind", {}).get("create_host_path", False)


def test_preflight_accepts_only_run_scoped_private_material(tmp_path):
    base, root = make_run(tmp_path)
    preflight.check_files(RUN_ID, root, runs_base=base)


def test_active_preflight_requires_generated_process_files_without_fresh_check(tmp_path):
    base, root = make_run(tmp_path)
    with pytest.raises(preflight.Blocked):
        preflight.check_active_run(RUN_ID, root, runs_base=base)

    for name in preflight.GENERATED_ENVIRONMENTS:
        path = root / "secrets" / name
        path.write_text("private-generated-placeholder\n", encoding="utf-8")
        path.chmod(0o600)

    preflight.check_active_run(RUN_ID, root, runs_base=base)


def test_preflight_requires_qdrant_issuer_ca(tmp_path):
    base, root = make_run(tmp_path)
    (root / "pki" / "qdrant-server" / "issuer-ca.crt").unlink()
    with pytest.raises(preflight.Blocked):
        preflight.check_files(RUN_ID, root, runs_base=base)


@pytest.mark.parametrize("run_id", ["production", RUN_ID.upper(), "../shared", ""])
def test_preflight_rejects_invalid_run_ids(tmp_path, run_id):
    base, root = make_run(tmp_path)
    with pytest.raises(preflight.Blocked):
        preflight.check_files(run_id, root, runs_base=base)


def test_preflight_rejects_foreign_root_and_symlinked_secret(tmp_path):
    base, root = make_run(tmp_path)
    with pytest.raises(preflight.Blocked):
        preflight.check_files(RUN_ID, tmp_path, runs_base=base)
    secret = root / "secrets" / "broker.env"
    secret.unlink()
    secret.symlink_to(root / "secrets" / "storage.env")
    with pytest.raises(preflight.Blocked):
        preflight.check_files(RUN_ID, root, runs_base=base)


def test_preflight_rejects_unsafe_permissions(tmp_path):
    base, root = make_run(tmp_path)
    (root / "secrets" / "postgres.env").chmod(0o644)
    with pytest.raises(preflight.Blocked):
        preflight.check_files(RUN_ID, root, runs_base=base)


@pytest.mark.parametrize(
    "filename,contents",
    [
        ("qdrant.env", "QDRANT__SERVICE__API_KEY=\n"),
        ("qdrant.env", "QDRANT__SERVICE__API_KEY=not-a-real-secret\n"),
        ("qdrant.env", "QDRANT__SERVICE__API_KEY=" + PG_SECRET + "\n"),
        ("broker.env", "RABBITMQ_DEFAULT_USER=x\nRABBITMQ_DEFAULT_PASS=" + BROKER_SECRET
         + "\nRABBITMQ_DEFAULT_VHOST=shared\n"),
        ("storage.env", "RUSTFS_ACCESS_KEY=x\nRUSTFS_SECRET_KEY=" + STORAGE_SECRET + "\nPATH=/unsafe\n"),
    ],
)
def test_preflight_rejects_missing_shared_duplicate_or_unsafe_configuration(tmp_path, filename, contents):
    base, root = make_run(tmp_path)
    (root / "secrets" / filename).write_text(contents)
    with pytest.raises(preflight.Blocked):
        preflight.check_files(RUN_ID, root, runs_base=base)


def test_preflight_rejects_existing_compose_resources(monkeypatch):
    monkeypatch.setattr(preflight.subprocess, "check_output", lambda *args, **kwargs: "existing-resource\n")
    with pytest.raises(preflight.Blocked, match="already exists"):
        preflight.check_fresh_project(RUN_ID)


def test_preflight_rejects_unlabelled_resources_with_colliding_names(monkeypatch):
    def inspect(command, **_kwargs):
        if command[1:3] == ["volume", "ls"] and "--format" in command:
            return PROJECT + "_postgres_data\n"
        return ""

    monkeypatch.setattr(preflight.subprocess, "check_output", inspect)
    with pytest.raises(preflight.Blocked, match="already exists"):
        preflight.check_fresh_project(RUN_ID)


def test_bootstrap_secrets_are_exclusive_and_private(tmp_path, monkeypatch, capsys):
    base = tmp_path / "runs"
    root = base / RUN_ID
    (root / "secrets").mkdir(parents=True, mode=0o700)
    root.chmod(0o700)
    (root / "secrets").chmod(0o700)
    values = iter((PG_SECRET, BROKER_SECRET, STORAGE_SECRET, QDRANT_SECRET))
    monkeypatch.setattr(secret_tool.secrets, "token_urlsafe", lambda _: next(values))
    monkeypatch.setattr(secret_tool, "check_fresh_project", lambda _: None)
    secret_tool.create_secrets(RUN_ID, root, runs_base=base)
    for name in preflight.ENV_KEYS:
        path = root / "secrets" / name
        assert path.stat().st_mode & 0o777 == 0o600
        assert preflight._read_env(path, preflight.ENV_KEYS[name])
    output = capsys.readouterr().out
    assert not any(value in output for value in (
        PG_SECRET, BROKER_SECRET, STORAGE_SECRET, QDRANT_SECRET,
    ))
    before = (root / "secrets" / "postgres.env").read_bytes()
    with pytest.raises(preflight.Blocked, match="already exist"):
        secret_tool.create_secrets(RUN_ID, root, runs_base=base)
    assert (root / "secrets" / "postgres.env").read_bytes() == before


def test_mi_template_is_fixed_to_one_client_identity():
    template = json.loads(
        (REPO / "infra/local/secure-integration/templates/mi-client.tpl").read_text()
    )
    assert template == {
        "subject": {"commonName": "urn:sme:service:mi-worker"},
        "sans": [{"type": "uri", "value": "urn:sme:service:mi-worker"}],
        "keyUsage": ["digitalSignature"],
        "extKeyUsage": ["clientAuth"],
    }
