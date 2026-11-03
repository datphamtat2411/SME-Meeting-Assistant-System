"""Isolated script checks; no Development CA, credentials or Docker access."""
import importlib.util
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / "infra/local/secure-integration/pki.py"
spec = importlib.util.spec_from_file_location("integration_pki", SCRIPT)
pki = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pki)


@pytest.fixture(scope="module")
def certificates(tmp_path_factory):
    # Existing isolated AI PKI helper; never mounted as a shared deployment CA.
    spec = importlib.util.spec_from_file_location("tls_support", ROOT / "services/ai/tests/tls_support.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    directory = tmp_path_factory.mktemp("pki")
    return helper.create_test_pki(directory)


def test_valid_core_worker_and_server(certificates):
    for role, name, hostname in (("core-client", "core-api", None), ("worker-client", "ai-worker", None),
                                 ("core-server", "server", "localhost")):
        pki.validate(role, certificates / f"{name}.crt", certificates / f"{name}.key", certificates / "ca.crt", hostname, 60)


@pytest.mark.parametrize("role,name,ca,host", [
    ("worker-client", "core-api", "ca", None),
    ("core-client", "ambiguous", "ca", None),
    ("core-client", "cn-only", "ca", None),
    ("core-client", "expired", "ca", None),
    ("core-client", "rogue", "ca", None),
    ("core-server", "core-api", "ca", "localhost"),
    ("core-server", "server", "rogue-ca", "localhost"),
    ("core-server", "server", "ca", "wrong.internal"),
])
def test_wrong_identity_chain_eku_validity_and_hostname_fail(certificates, role, name, ca, host):
    with pytest.raises((ValueError, subprocess.CalledProcessError)):
        pki.validate(role, certificates / f"{name}.crt", certificates / f"{name}.key", certificates / f"{ca}.crt", host, 60)


def test_key_mismatch_fails(certificates):
    with pytest.raises(ValueError):
        pki.validate("core-client", certificates / "core-api.crt", certificates / "ai-worker.key", certificates / "ca.crt", margin=60)


def test_csr_creates_distinct_pkcs8_keys_and_never_overwrites(tmp_path):
    keys = []
    for role in ("core-client", "worker-client", "core-server"):
        target = tmp_path / role
        target.mkdir(mode=0o700)
        command = ["python3", str(SCRIPT), "csr", "--role", role, "--directory", str(target)]
        if role == "core-server":
            command += ["--hostname", "core-api.internal"]
        result = subprocess.run(command, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        key = target / "tls.key"
        assert key.stat().st_mode & 0o777 == 0o600
        assert b"BEGIN PRIVATE KEY" in key.read_bytes()
        keys.append(subprocess.check_output(["openssl", "pkey", "-in", str(key), "-pubout"]))
        assert subprocess.run(command, capture_output=True).returncode != 0
    assert len(set(keys)) == 3


def test_repo_paths_symlinks_and_world_readable_keys_rejected(tmp_path):
    with pytest.raises(ValueError):
        pki.external(SCRIPT)
    key = tmp_path / "key"
    key.write_text("not a key")
    key.chmod(0o644)
    with pytest.raises(ValueError):
        pki.external(key, secret=True)
    link = tmp_path / "link"
    link.symlink_to(key)
    with pytest.raises(ValueError):
        pki.external(link)
