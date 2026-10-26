"""Development operations only: ephemeral PKI and fake CA/Docker/probe commands."""

import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

AI = Path(__file__).resolve().parents[2]
SCRIPT = AI / "scripts/dev-pki-renew.sh"
UNITS = AI / "ops/systemd"


def openssl(directory, *args):
    return subprocess.run(
        ["openssl", *args], cwd=directory, check=True, capture_output=True,
    ).stdout


@pytest.fixture(scope="module")
def operations_pki(tmp_path_factory):
    pki = tmp_path_factory.mktemp("operations-pki")
    for name in ("root", "client-root", "rogue"):
        openssl(
            pki, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
            "-nodes", "-days", "30", "-subj", f"/CN=Ephemeral {name}",
            "-keyout", f"{name}.key", "-out", f"{name}.crt",
            "-addext", "basicConstraints=critical,CA:TRUE",
        )
    for name in ("intermediate", "probe-intermediate", "server", "different", "probe"):
        openssl(
            pki, "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
            "-nodes", "-subj", "/CN=localhost", "-keyout", f"{name}.key",
            "-out", f"{name}.csr",
        )
    (pki / "ca.ext").write_text(
        "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n"
    )
    for name, ca in (("intermediate", "root"), ("probe-intermediate", "client-root")):
        openssl(
            pki, "x509", "-req", "-in", f"{name}.csr", "-CA", f"{ca}.crt",
            "-CAkey", f"{ca}.key", "-CAcreateserial", "-days", "20", "-extfile", "ca.ext",
            "-out", f"{name}.crt",
        )

    def issue(name, *, csr="server", ca="intermediate", san="DNS:localhost,IP:127.0.0.1",
              eku="serverAuth", days="7", dates=None):
        extensions = "basicConstraints=critical,CA:FALSE\n"
        if san:
            extensions += f"subjectAltName={san}\n"
        if eku:
            extensions += f"extendedKeyUsage={eku}\n"
        (pki / "leaf.ext").write_text(extensions)
        if dates:
            (pki / "index").write_text("")
            (pki / "signing.cnf").write_text(
                "[ca]\ndefault_ca=test\n[test]\ndatabase=index\nnew_certs_dir=.\n"
                "serial=serial\ndefault_md=sha256\npolicy=policy\n"
                "[policy]\ncommonName=supplied\n[leaf]\n" + extensions
            )
            openssl(
                pki, "ca", "-batch", "-config", "signing.cnf", "-create_serial",
                "-cert", f"{ca}.crt", "-keyfile", f"{ca}.key", "-extensions", "leaf",
                "-startdate", dates[0], "-enddate", dates[1], "-in", f"{csr}.csr",
                "-out", f"{name}.crt", "-notext",
            )
        else:
            openssl(
                pki, "x509", "-req", "-in", f"{csr}.csr", "-CA", f"{ca}.crt",
                "-CAkey", f"{ca}.key", "-CAcreateserial", "-days", days,
                "-extfile", "leaf.ext", "-out", f"{name}.crt",
            )

    issue("current", days="2")
    issue("renewed")
    issue("wrong-san", san="DNS:somewhere.invalid")
    issue("cn-only", san=None)
    issue("uri-only", san="URI:urn:test:DNS:localhost")
    issue("wrong-eku", eku="clientAuth")
    issue("no-eku", eku=None)
    issue("wrong-key", csr="different")
    issue("untrusted", ca="rogue")
    issue("short", days="1")
    issue("expired", dates=("20200101000000Z", "20200102000000Z"))
    issue("future", dates=("20400101000000Z", "20400102000000Z"))
    probe_defaults = {"csr": "probe", "ca": "probe-intermediate", "eku": "clientAuth",
                      "san": "URI:urn:sme:service:dev-pki-probe"}
    issue("probe", **(probe_defaults | {"days": "2"}))
    issue("probe-renewed", **probe_defaults)
    for name, overrides in {
        "wrong-uri": {"san": "URI:urn:sme:service:core-api"},
        "no-uri": {"san": "DNS:localhost"},
        "cn-only": {"san": None},
        "uri-in-dns": {"san": "DNS:urn:sme:service:dev-pki-probe"},
        "ambiguous": {"san": "URI:urn:sme:service:dev-pki-probe,URI:urn:sme:service:other"},
        "duplicate": {"san": "URI:urn:sme:service:dev-pki-probe,URI:urn:sme:service:dev-pki-probe"},
        "extra-uri": {"san": "URI:urn:sme:service:dev-pki-probe,URI:urn:test:other"},
        "wrong-eku": {"eku": "serverAuth"},
        "no-eku": {"eku": None},
        "wrong-key": {"csr": "different"},
        "untrusted": {"ca": "rogue"},
        "short": {"days": "1"},
        "expired": {"dates": ("20200101000000Z", "20200102000000Z")},
        "future": {"dates": ("20400101000000Z", "20400102000000Z")},
        "custom": {"san": "URI:urn:sme:service:local-probe"},
    }.items():
        issue(f"probe-{name}", **(probe_defaults | overrides))
    return pki


FAKE_COMMAND = '''#!{python}
import json, os, pathlib, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
base = pathlib.Path(os.environ["FAKE_HOME"])
with (base / "calls").open("a") as log:
    log.write(json.dumps([name, args]) + "\\n")
if name == "step":
    is_probe = args[2] == os.environ["DEV_PKI_PROBE_CERT_FILE"]
    if args[:2] == ["certificate", "needs-renewal"]:
        setting = "FAKE_PROBE_DUE" if is_probe else "FAKE_DUE"
        sys.exit(int(os.environ.get(setting, "1" if is_probe else "0")))
    assert args[:2] == ["ca", "renew"]
    assert "--mtls=false" in args and "--out" in args
    assert "--root" in args and "--ca-url" in args
    if os.environ.get("FAKE_WAIT"):
        (base / "entered").touch()
        while not (base / "release").exists():
            time.sleep(0.02)
    if os.environ.get("FAKE_PROBE_CA_FAIL" if is_probe else "FAKE_CA_FAIL"):
        print("PRIVATE_KEY_MATERIAL private-host-secret", file=sys.stderr)
        sys.exit(1)
    candidate = "probe-candidate" if is_probe else "candidate"
    pathlib.Path(args[args.index("--out") + 1]).write_bytes((base / candidate).read_bytes())
    change = os.environ.get("FAKE_CHANGE_MATERIAL")
    if change:
        target = pathlib.Path(args[3] if change == "key" else args[2])
        if change == "metadata":
            target.chmod(0o400)
        else:
            target.write_bytes(b"operator-change")
    sys.exit(0)
if name == "docker":
    assert args == ["restart", "--time", os.environ.get("DEV_PKI_DOCKER_STOP_GRACE_SECONDS", "40"),
                    "sme-ai-http"]
    with (base / "restarts").open("a") as log:
        log.write(pathlib.Path(os.environ["DEV_PKI_CERT_FILE"]).read_text() + "END_RESTART\\n")
    if os.environ.get("FAKE_INVALIDATE_BACKUP"):
        for backup in pathlib.Path(os.environ["DEV_PKI_BACKUP_DIR"]).glob("*.crt"):
            backup.write_text("not a certificate")
    sys.exit(1 if os.environ.get("FAKE_RESTART_FAIL") else 0)
if name == "curl":
    if os.environ.get("FAKE_INVALIDATE_PROBE_BACKUP"):
        (pathlib.Path(os.environ["DEV_PKI_BACKUP_DIR"]) / "previous-probe.crt").write_text("invalid")
    count_file = base / "probe-count"
    count = int(count_file.read_text()) if count_file.exists() else 0
    count_file.write_text(str(count + 1))
    if (count < int(os.environ.get("FAKE_PROBE_FAILURES", "0"))
            or count >= int(os.environ.get("FAKE_PROBE_FAIL_AFTER", "9999"))):
        print("PRIVATE_KEY_MATERIAL private-host-secret", file=sys.stderr)
        sys.exit(1)
    print(os.environ.get("FAKE_PROBE_BODY", '{{"status":"ready"}}'))
    print(os.environ.get("FAKE_PROBE_STATUS", "200"))
    sys.exit(0)
raise AssertionError("unexpected executable")
'''


@pytest.fixture
def host(tmp_path, operations_pki):
    pki = operations_pki
    live = tmp_path / "mounted"
    live.mkdir(mode=0o700)
    backup = tmp_path / "backup"
    backup.mkdir(mode=0o700)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("step", "docker", "curl"):
        executable = bin_dir / name
        executable.write_text(FAKE_COMMAND.format(python=sys.executable))
        executable.chmod(0o700)
    for source, target in (("server.key", live / "ai-server.key"),
                           ("root.crt", tmp_path / "root.crt"),
                           ("client-root.crt", live / "client-ca.crt"),
                           ("client-root.crt", tmp_path / "probe-issuer-root.crt"),
                           ("probe.key", tmp_path / "probe.key")):
        shutil.copyfile(pki / source, target)
        target.chmod(0o600)
    cert = live / "ai-server.crt"
    cert.write_bytes((pki / "current.crt").read_bytes() + (pki / "intermediate.crt").read_bytes())
    cert.chmod(0o640)
    candidate = tmp_path / "candidate"
    candidate.write_bytes((pki / "renewed.crt").read_bytes() + (pki / "intermediate.crt").read_bytes())
    probe = tmp_path / "probe.crt"
    probe.write_bytes((pki / "probe.crt").read_bytes() + (pki / "probe-intermediate.crt").read_bytes())
    probe.chmod(0o640)
    (tmp_path / "probe-candidate").write_bytes(
        (pki / "probe-renewed.crt").read_bytes() + (pki / "probe-intermediate.crt").read_bytes()
    )
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("DEV_PKI_", "AI_TLS_", "FAKE_"))}
    env.update({
        "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_HOME": str(tmp_path),
        "DEV_PKI_CA_URL": "https://ca.invalid:9000",
        "DEV_PKI_CA_ROOT_FILE": str(tmp_path / "root.crt"),
        "DEV_PKI_CERT_FILE": str(cert), "DEV_PKI_KEY_FILE": str(live / "ai-server.key"),
        "DEV_PKI_EXPECTED_HOSTNAME": "localhost", "DEV_PKI_RENEW_BEFORE": "24h",
        "DEV_PKI_MIN_VALIDITY_SECONDS": "86400", "DEV_PKI_BACKUP_DIR": str(backup),
        "DEV_PKI_CONTAINER": "sme-ai-http", "DEV_PKI_ALLOWED_CONTAINERS": "sme-ai-http",
        "DEV_PKI_PROBE_URL": "https://localhost:8000/health/ready",
        "DEV_PKI_PROBE_CA_FILE": str(tmp_path / "root.crt"),
        "DEV_PKI_PROBE_CERT_FILE": str(tmp_path / "probe.crt"),
        "DEV_PKI_PROBE_KEY_FILE": str(tmp_path / "probe.key"),
        "DEV_PKI_PROBE_ISSUER_ROOT_FILE": str(tmp_path / "probe-issuer-root.crt"),
        "DEV_PKI_PROBE_ATTEMPTS": "2", "DEV_PKI_PROBE_INTERVAL_SECONDS": "0",
        "DEV_PKI_PROBE_TIMEOUT_SECONDS": "1",
    })
    return {"dir": tmp_path, "pki": pki, "cert": cert, "env": env, "backup": backup,
            "original": cert.read_bytes(), "key": (live / "ai-server.key").read_bytes(),
            "probe": probe, "probe_original": probe.read_bytes(),
            "probe_key": (tmp_path / "probe.key").read_bytes()}


def run(host, mode="renew", **env):
    return subprocess.run(
        ["bash", str(SCRIPT), mode], env=host["env"] | env,
        text=True, capture_output=True, timeout=15,
    )


def calls(host, command=None):
    log = host["dir"] / "calls"
    entries = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return [args for name, args in entries if command is None or name == command]


def assert_untouched(host):
    assert host["cert"].read_bytes() == host["original"]
    assert Path(host["env"]["DEV_PKI_KEY_FILE"]).read_bytes() == host["key"]
    assert host["probe"].read_bytes() == host["probe_original"]
    assert Path(host["env"]["DEV_PKI_PROBE_KEY_FILE"]).read_bytes() == host["probe_key"]
    assert not calls(host, "docker")
    assert not calls(host, "curl")
    assert sorted(path.name for path in host["cert"].parent.iterdir()) == [
        "ai-server.crt", "ai-server.key", "client-ca.crt",
    ]


@pytest.mark.parametrize("code,status,success", [(0, "due", True), (1, "not_due", True),
                                               (2, "invalid", False), (255, "invalid", False)])
def test_check_is_read_only_and_distinguishes_step_exits(host, code, status, success):
    before = {path: (path.read_bytes(), path.stat().st_mtime_ns)
              for path in (*host["cert"].parent.iterdir(), host["probe"],
                           Path(host["env"]["DEV_PKI_PROBE_KEY_FILE"]))}
    result = run(host, "check", FAKE_DUE=str(code))
    assert (result.returncode == 0) == success, result.stderr
    assert f"status={status}" in result.stdout
    assert len(calls(host, "step")) == (2 if success else 1)
    assert not list(host["backup"].iterdir())
    assert before == {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in before}
    assert_untouched(host)


def test_noop_does_not_stage_backup_restart_or_probe(host):
    result = run(host, FAKE_DUE="1", AI_TLS_CERT_FILE="/container-only/ignored.crt")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "status=not_due server=not_due probe=not_due"
    assert len(calls(host, "step")) == 2
    assert not list(host["backup"].iterdir())
    assert_untouched(host)


def test_identical_ca_output_is_no_replacement_and_no_restart(host):
    (host["dir"] / "candidate").write_bytes(host["original"])
    result = run(host)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "status=not_due server=not_due probe=not_due"
    assert not list(host["backup"].iterdir())
    assert_untouched(host)


@pytest.mark.parametrize("setting,value", [
    ("DEV_PKI_CA_URL", "http://ca.invalid"), ("DEV_PKI_CA_URL", "https://user:secret@ca.invalid"),
    ("DEV_PKI_CERT_FILE", "relative.crt"), ("DEV_PKI_EXPECTED_HOSTNAME", "$(touch bad)"),
    ("DEV_PKI_CONTAINER", "other-service"), ("DEV_PKI_CONTAINER", "--all"),
    ("DEV_PKI_RENEW_BEFORE", "24h; touch bad"), ("DEV_PKI_PROBE_ATTEMPTS", "9999"),
    ("DEV_PKI_PROBE_URL", "https://elsewhere.invalid/health/ready"),
    ("DEV_PKI_PROBE_URL", "https://localhost:8000/health/live"),
    ("DEV_PKI_PROBE_KEY_FILE", ""), ("DEV_PKI_CA_ROOT_FILE", ""),
    ("DEV_PKI_PROBE_ISSUER_ROOT_FILE", ""),
    ("DEV_PKI_PROBE_EXPECTED_URI", "urn:sme:service:core-api"),
    ("DEV_PKI_PROBE_EXPECTED_URI", "https://probe.invalid"),
    ("DEV_PKI_PROBE_EXPECTED_URI", "urn:sme:service:Bad Identity"),
    ("DEV_PKI_PROBE_CA_URL", "http://ca.invalid"),
    ("DEV_PKI_PROBE_RENEW_BEFORE", "0h"),
    ("DEV_PKI_PROBE_MIN_VALIDITY_SECONDS", "0"),
    ("DEV_PKI_DOCKER_STOP_GRACE_SECONDS", "0"),
    ("DEV_PKI_DOCKER_STOP_GRACE_SECONDS", "301"),
    ("DEV_PKI_DOCKER_STOP_GRACE_SECONDS", "40; touch bad"),
])
def test_invalid_configuration_fails_before_external_commands(host, setting, value):
    result = run(host, **{setting: value})
    assert result.returncode != 0
    assert "status=invalid" in result.stdout
    assert not calls(host)
    assert_untouched(host)


@pytest.mark.parametrize("unsafe", ["cert-symlink", "parent-symlink", "backup-inside",
                                    "backup-public", "cert-writable", "key-writable",
                                    "probe-inside", "probe-key-inside", "probe-symlink",
                                    "probe-writable", "probe-key-as-cert", "probe-root-as-cert",
                                    "probe-in-backup"])
def test_unsafe_paths_are_rejected(host, unsafe):
    env = {}
    if unsafe == "cert-symlink":
        saved = host["dir"] / "saved.crt"
        host["cert"].rename(saved)
        host["cert"].symlink_to(saved)
    elif unsafe == "parent-symlink":
        alias = host["dir"] / "alias"
        alias.symlink_to(host["cert"].parent, target_is_directory=True)
        env["DEV_PKI_CERT_FILE"] = str(alias / "ai-server.crt")
    elif unsafe == "backup-inside":
        env["DEV_PKI_BACKUP_DIR"] = str(host["cert"].parent)
    elif unsafe == "backup-public":
        host["backup"].chmod(0o755)
    elif unsafe in ("probe-inside", "probe-key-inside", "probe-in-backup"):
        setting = "DEV_PKI_PROBE_KEY_FILE" if unsafe == "probe-key-inside" else "DEV_PKI_PROBE_CERT_FILE"
        directory = host["backup"] if unsafe == "probe-in-backup" else host["cert"].parent
        target = directory / "probe-material"
        shutil.copyfile(host["env"][setting], target)
        env[setting] = str(target)
    elif unsafe == "probe-symlink":
        saved = host["dir"] / "saved-probe.crt"
        host["probe"].rename(saved)
        host["probe"].symlink_to(saved)
    elif unsafe == "probe-writable":
        host["probe"].chmod(0o666)
    elif unsafe == "probe-key-as-cert":
        env["DEV_PKI_PROBE_KEY_FILE"] = str(host["probe"])
    elif unsafe == "probe-root-as-cert":
        env["DEV_PKI_PROBE_CERT_FILE"] = host["env"]["DEV_PKI_PROBE_ISSUER_ROOT_FILE"]
    else:
        target = host["cert"] if unsafe == "cert-writable" else Path(host["env"]["DEV_PKI_KEY_FILE"])
        target.chmod(0o666)
    result = run(host, **env)
    assert result.returncode != 0
    assert not calls(host)


@pytest.mark.parametrize("variant", ["wrong-san", "cn-only", "uri-only", "wrong-eku", "no-eku",
                                     "wrong-key", "untrusted", "expired", "future", "short",
                                     "malformed", "incomplete", "junk"])
def test_staged_validation_rejects_bad_material_without_restart(host, variant):
    if variant == "malformed":
        candidate = b"-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n"
    elif variant == "incomplete":
        candidate = (host["pki"] / "renewed.crt").read_bytes()
    else:
        name = "renewed" if variant == "junk" else variant
        candidate = (host["pki"] / f"{name}.crt").read_bytes()
        candidate += (host["pki"] / "intermediate.crt").read_bytes()
        if variant == "junk":
            candidate += b"PRIVATE_KEY_MATERIAL"
    (host["dir"] / "candidate").write_bytes(candidate)
    result = run(host)
    assert result.returncode != 0
    assert "staged_validation" in result.stdout
    assert "PRIVATE_KEY_MATERIAL" not in result.stdout + result.stderr
    assert_untouched(host)


def test_invalid_current_certificate_fails_without_renewal(host):
    host["cert"].write_bytes((host["pki"] / "wrong-san.crt").read_bytes())
    result = run(host, "check")
    assert result.returncode != 0
    assert "status=invalid" in result.stdout
    assert not calls(host)


@pytest.mark.parametrize("code", ["2", "255"])
def test_renewal_detection_errors_are_not_treated_as_noop(host, code):
    result = run(host, FAKE_DUE=code)
    assert result.returncode != 0
    assert len(calls(host, "step")) == 1
    assert_untouched(host)


def test_ca_failure_is_sanitized_and_cleans_staging(host):
    result = run(host, FAKE_CA_FAIL="1")
    assert result.returncode != 0
    assert "ca_renewal" in result.stdout
    assert "PRIVATE_KEY_MATERIAL" not in result.stdout + result.stderr
    assert "private-host-secret" not in result.stdout + result.stderr
    assert_untouched(host)


def test_unsafe_backup_prevents_activation_and_restart(host):
    (host["backup"] / "previous.crt").symlink_to(host["cert"])
    result = run(host)
    assert result.returncode != 0
    assert "recovery=not_needed" in result.stdout
    assert_untouched(host)


def test_invalid_probe_material_prevents_renewal(host):
    Path(host["env"]["DEV_PKI_PROBE_KEY_FILE"]).write_bytes(host["key"])
    host["probe_key"] = host["key"]
    result = run(host)
    assert result.returncode != 0
    assert not calls(host)
    assert_untouched(host)


def test_atomic_activation_preserves_metadata_key_and_restricted_backup(host):
    before = host["cert"].stat()
    # Holding the old inode open demonstrates rename activation rather than truncation.
    with host["cert"].open("rb") as old_inode:
        result = run(host)
        assert result.returncode == 0, result.stdout + result.stderr
        assert old_inode.read() == host["original"]
    assert result.stdout.strip() == "status=renewed server=renewed probe=not_due"
    after = host["cert"].stat()
    assert after.st_ino != before.st_ino
    assert (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode), after.st_dev) == (
        before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_dev,
    )
    assert host["cert"].read_bytes() == (host["dir"] / "candidate").read_bytes()
    assert Path(host["env"]["DEV_PKI_KEY_FILE"]).read_bytes() == host["key"]
    backups = list(host["backup"].glob("*.crt"))
    assert len(backups) == 1 and backups[0].read_bytes() == host["original"]
    assert stat.S_IMODE(backups[0].stat().st_mode) == 0o600
    renewal = [args for args in calls(host, "step") if args[:2] == ["ca", "renew"]][0]
    stage = Path(renewal[renewal.index("--out") + 1])
    assert stage.parent == host["cert"].parent and not stage.exists()
    assert len(calls(host, "docker")) == 1
    assert (host["dir"] / "restarts").read_text().startswith(host["cert"].read_text())
    probe = calls(host, "curl")[0]
    for flag in ("--cacert", "--cert", "--key", "--max-time", "--noproxy"):
        assert flag in probe
    assert "--insecure" not in probe and "-k" not in probe


def test_explicit_intermediate_is_included_in_activated_chain(host):
    (host["dir"] / "candidate").write_bytes((host["pki"] / "renewed.crt").read_bytes())
    result = run(host, DEV_PKI_INTERMEDIATE_FILE=str(host["pki"] / "intermediate.crt"))
    assert result.returncode == 0, result.stdout + result.stderr
    assert host["cert"].read_bytes().count(b"BEGIN CERTIFICATE") == 2


def test_ip_san_is_verified_as_ip_not_dns(host):
    result = run(host, DEV_PKI_EXPECTED_HOSTNAME="127.0.0.1",
                 DEV_PKI_PROBE_URL="https://127.0.0.1:8000/health/ready")
    assert result.returncode == 0, result.stdout + result.stderr


def test_named_uid_acl_survives_activation(host):
    assert shutil.which("getfacl") and shutil.which("setfacl"), "host acl tools required"
    subprocess.run(["setfacl", "-m", "u:10001:r", str(host["cert"])], check=True)
    before = subprocess.check_output(["getfacl", "-cpn", str(host["cert"])])
    result = run(host)
    assert result.returncode == 0, result.stdout + result.stderr
    assert subprocess.check_output(["getfacl", "-cpn", str(host["cert"])]) == before


@pytest.mark.parametrize("failure", ["probe", "restart", "body", "http-status"])
def test_activation_failure_restores_valid_previous_cert_and_attempts_recovery(host, failure):
    settings = {
        "probe": {"FAKE_PROBE_FAILURES": "2"}, "restart": {"FAKE_RESTART_FAIL": "1"},
        "body": {"FAKE_PROBE_BODY": '{"status":"not_ready"}'},
        "http-status": {"FAKE_PROBE_STATUS": "503"},
    }[failure]
    result = run(host, **settings)
    assert result.returncode != 0
    assert "recovery=" in result.stdout
    assert host["cert"].read_bytes() == host["original"]
    assert len(calls(host, "docker")) == 2
    assert "PRIVATE_KEY_MATERIAL" not in result.stdout + result.stderr
    if failure == "probe":
        assert "recovery=restored" in result.stdout
    assert sorted(path.name for path in host["cert"].parent.iterdir()) == [
        "ai-server.crt", "ai-server.key", "client-ca.crt",
    ]


def test_unsafe_rollback_is_not_installed(host):
    result = run(host, FAKE_INVALIDATE_BACKUP="1", FAKE_PROBE_FAILURES="99")
    assert result.returncode != 0
    assert "recovery=manual" in result.stdout
    assert host["cert"].read_bytes() == (host["dir"] / "candidate").read_bytes()
    assert len(calls(host, "docker")) == 1


def test_concurrent_renewal_is_locked_before_ca_access(host):
    process = subprocess.Popen(
        ["bash", str(SCRIPT), "renew"], env=host["env"] | {"FAKE_WAIT": "1"},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        for _ in range(150):
            if (host["dir"] / "entered").exists():
                break
            assert process.poll() is None, process.communicate()
            time.sleep(0.02)
        else:
            pytest.fail("fake CA was not reached")
        result = run(host)
        assert result.returncode != 0 and "busy" in result.stdout
        assert len(calls(host, "step")) == 3
    finally:
        (host["dir"] / "release").touch()
        out, err = process.communicate(timeout=15)
    assert process.returncode == 0, out + err


@pytest.mark.parametrize("server_due,probe_due", [("1", "0"), ("0", "0"), ("1", "1")])
def test_check_reports_independent_due_state_without_writing(host, server_due, probe_due):
    before = {path: (path.read_bytes(), path.stat().st_mtime_ns)
              for path in (host["cert"], host["probe"])}
    result = run(host, "check", FAKE_DUE=server_due, FAKE_PROBE_DUE=probe_due,
                 DEV_PKI_PROBE_RENEW_BEFORE="12h")
    assert result.returncode == 0, result.stdout + result.stderr
    server = "due" if server_due == "0" else "not_due"
    probe = "due" if probe_due == "0" else "not_due"
    status = "due" if "due" in (server, probe) else "not_due"
    assert result.stdout.strip() == f"status={status} server={server} probe={probe}"
    assert calls(host, "step") == [
        ["certificate", "needs-renewal", str(host["cert"]), "--expires-in", "24h"],
        ["certificate", "needs-renewal", str(host["probe"]), "--expires-in", "12h"],
    ]
    assert not list(host["backup"].iterdir())
    assert before == {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in before}
    assert_untouched(host)


@pytest.mark.parametrize("mode", ["check", "renew"])
@pytest.mark.parametrize("code", ["2", "255"])
def test_probe_detection_error_cannot_trigger_server_renewal(host, mode, code):
    result = run(host, mode, FAKE_PROBE_DUE=code)
    assert result.returncode != 0 and "renewal_detection" in result.stdout
    assert len(calls(host, "step")) == 2
    assert not list(host["backup"].iterdir())
    assert_untouched(host)


PROBE_INVALID = [
    "wrong-uri", "no-uri", "cn-only", "uri-in-dns", "ambiguous", "duplicate", "extra-uri",
    "wrong-eku", "no-eku", "wrong-key", "untrusted", "expired", "future", "malformed",
    "incomplete", "junk",
]


def probe_chain(host, variant):
    if variant == "malformed":
        return b"-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n"
    name = "renewed" if variant in ("incomplete", "junk") else variant
    data = (host["pki"] / f"probe-{name}.crt").read_bytes()
    if variant != "incomplete":
        data += (host["pki"] / "probe-intermediate.crt").read_bytes()
    return data + b"PRIVATE_KEY_MATERIAL" if variant == "junk" else data


@pytest.mark.parametrize("variant", PROBE_INVALID)
def test_invalid_current_probe_fails_before_renewal(host, variant):
    host["probe"].write_bytes(probe_chain(host, variant))
    result = run(host)
    assert result.returncode != 0 and "status=invalid" in result.stdout
    assert not calls(host)
    assert host["cert"].read_bytes() == host["original"]
    assert not list(host["backup"].iterdir())


@pytest.mark.parametrize("variant", [*PROBE_INVALID, "short"])
def test_invalid_probe_candidate_never_replaces_or_restarts(host, variant):
    (host["dir"] / "probe-candidate").write_bytes(probe_chain(host, variant))
    result = run(host, FAKE_DUE="1", FAKE_PROBE_DUE="0")
    assert result.returncode != 0 and "staged_validation" in result.stdout
    assert "probe=failed" in result.stdout and "recovery=not_needed" in result.stdout
    assert "PRIVATE_KEY_MATERIAL" not in result.stdout + result.stderr
    assert not list(host["backup"].iterdir())
    assert_untouched(host)
    assert not list(host["dir"].glob(".dev-pki-*"))


def test_probe_issuer_trust_is_distinct_from_server_verification_trust(host):
    result = run(host, "check", DEV_PKI_PROBE_ISSUER_ROOT_FILE=host["env"]["DEV_PKI_PROBE_CA_FILE"])
    assert result.returncode != 0 and "status=invalid" in result.stdout
    assert not calls(host)
    assert_untouched(host)


def test_probe_only_renewal_is_atomic_preserves_metadata_and_never_restarts(host):
    subprocess.run(["setfacl", "-m", "u:10002:r", str(host["probe"])], check=True)
    before = host["probe"].stat()
    acl_before = subprocess.check_output(["getfacl", "-cpn", str(host["probe"])])
    server_before = host["cert"].stat()
    with host["probe"].open("rb") as old_inode:
        result = run(host, FAKE_DUE="1", FAKE_PROBE_DUE="0")
        assert result.returncode == 0, result.stdout + result.stderr
        assert old_inode.read() == host["probe_original"]
    assert result.stdout.strip() == "status=renewed server=not_due probe=renewed"
    after = host["probe"].stat()
    assert after.st_ino != before.st_ino
    assert (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode), after.st_dev) == (
        before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_dev,
    )
    assert subprocess.check_output(["getfacl", "-cpn", str(host["probe"])]) == acl_before
    assert host["probe"].read_bytes() == (host["dir"] / "probe-candidate").read_bytes()
    assert Path(host["env"]["DEV_PKI_PROBE_KEY_FILE"]).read_bytes() == host["probe_key"]
    assert host["cert"].read_bytes() == host["original"]
    server_after = host["cert"].stat()
    assert (server_after.st_ino, server_after.st_mtime_ns) == (
        server_before.st_ino, server_before.st_mtime_ns,
    )
    assert Path(host["env"]["DEV_PKI_KEY_FILE"]).read_bytes() == host["key"]
    backup = host["backup"] / "previous-probe.crt"
    assert sorted(path.name for path in host["backup"].iterdir()) == ["previous-probe.crt"]
    assert backup.read_bytes() == host["probe_original"]
    assert stat.S_IMODE(backup.stat().st_mode) == 0o600
    renewal = [args for args in calls(host, "step") if args[:2] == ["ca", "renew"]][0]
    assert renewal[2:4] == [str(host["probe"]), host["env"]["DEV_PKI_PROBE_KEY_FILE"]]
    assert renewal[renewal.index("--root") + 1] == host["env"]["DEV_PKI_PROBE_ISSUER_ROOT_FILE"]
    assert renewal[renewal.index("--ca-url") + 1] == host["env"]["DEV_PKI_CA_URL"]
    stage = Path(renewal[renewal.index("--out") + 1])
    assert stage.parent == host["probe"].parent and not stage.exists()
    assert not calls(host, "docker") and len(calls(host, "curl")) == 1
    assert calls(host, "curl")[0][calls(host, "curl")[0].index("--cert") + 1] == str(host["probe"])


def test_identical_probe_candidate_is_a_noop(host):
    (host["dir"] / "probe-candidate").write_bytes(host["probe_original"])
    before = host["probe"].stat()
    result = run(host, FAKE_DUE="1", FAKE_PROBE_DUE="0")
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "status=not_due server=not_due probe=not_due"
    after = host["probe"].stat()
    assert (after.st_ino, after.st_mtime_ns) == (before.st_ino, before.st_mtime_ns)
    assert not list(host["backup"].iterdir())
    assert_untouched(host)


def test_probe_specific_ca_intermediate_identity_and_validity_settings(host):
    host["probe"].write_bytes(probe_chain(host, "custom"))
    (host["dir"] / "probe-candidate").write_bytes((host["pki"] / "probe-custom.crt").read_bytes())
    result = run(host, FAKE_DUE="1", FAKE_PROBE_DUE="0",
                 DEV_PKI_PROBE_EXPECTED_URI="urn:sme:service:local-probe",
                 DEV_PKI_PROBE_CA_URL="https://client-ca.invalid:9000",
                 DEV_PKI_PROBE_INTERMEDIATE_FILE=str(host["pki"] / "probe-intermediate.crt"),
                 DEV_PKI_PROBE_MIN_VALIDITY_SECONDS="172800")
    assert result.returncode == 0, result.stdout + result.stderr
    renewal = [args for args in calls(host, "step") if args[:2] == ["ca", "renew"]][0]
    assert renewal[renewal.index("--ca-url") + 1] == "https://client-ca.invalid:9000"
    assert host["probe"].read_bytes().count(b"BEGIN CERTIFICATE") == 2
    assert not calls(host, "docker")


def test_probe_minimum_validity_is_enforced_independently(host):
    result = run(host, FAKE_DUE="1", FAKE_PROBE_DUE="0",
                 DEV_PKI_PROBE_MIN_VALIDITY_SECONDS="604800")
    assert result.returncode != 0 and "staged_validation" in result.stdout
    assert_untouched(host)


def test_both_due_renew_probe_before_server_and_keep_separate_backups(host):
    result = run(host, FAKE_PROBE_DUE="0", DEV_PKI_DOCKER_STOP_GRACE_SECONDS="75")
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "status=renewed server=renewed probe=renewed"
    renewals = [args for args in calls(host, "step") if args[:2] == ["ca", "renew"]]
    assert [args[2] for args in renewals] == [str(host["probe"]), str(host["cert"])]
    assert (host["backup"] / "previous.crt").read_bytes() == host["original"]
    assert (host["backup"] / "previous-probe.crt").read_bytes() == host["probe_original"]
    assert host["cert"].read_bytes() == (host["dir"] / "candidate").read_bytes()
    assert host["probe"].read_bytes() == (host["dir"] / "probe-candidate").read_bytes()
    assert calls(host, "docker") == [["restart", "--time", "75", "sme-ai-http"]]
    assert len(calls(host, "curl")) == 2


def test_probe_failure_blocks_due_server_and_sanitizes_diagnostics(host):
    result = run(host, FAKE_PROBE_DUE="0", FAKE_PROBE_CA_FAIL="1")
    assert result.returncode != 0
    assert "status=failed server=blocked probe=failed" in result.stdout
    assert "ca_renewal" in result.stdout
    assert "PRIVATE_KEY_MATERIAL" not in result.stdout + result.stderr
    assert "private-host-secret" not in result.stdout + result.stderr
    renewals = [args for args in calls(host, "step") if args[:2] == ["ca", "renew"]]
    assert [args[2] for args in renewals] == [str(host["probe"])]
    assert_untouched(host)


@pytest.mark.parametrize("failure", ["ca", "validation", "restart", "readiness"])
def test_server_failure_preserves_successful_probe_and_reports_partial_success(host, failure):
    settings = {
        "ca": {"FAKE_CA_FAIL": "1"},
        "validation": {},
        "restart": {"FAKE_RESTART_FAIL": "1"},
        "readiness": {"FAKE_PROBE_FAILURES": "0", "FAKE_PROBE_FAIL_AFTER": "1"},
    }[failure]
    if failure == "validation":
        (host["dir"] / "candidate").write_bytes(b"not a certificate")
    result = run(host, FAKE_PROBE_DUE="0", **settings)
    assert result.returncode != 0
    assert "status=partial server=failed probe=renewed" in result.stdout
    assert host["probe"].read_bytes() == (host["dir"] / "probe-candidate").read_bytes()
    assert host["cert"].read_bytes() == host["original"]
    assert (host["backup"] / "previous-probe.crt").read_bytes() == host["probe_original"]
    assert len(calls(host, "docker")) == (2 if failure in ("restart", "readiness") else 0)


@pytest.mark.parametrize("failure,recovery", [("temporary", "restored"),
                                             ("persistent", "restored_unready"),
                                             ("unsafe-backup", "manual")])
def test_probe_activation_failure_recovers_without_any_restart(host, failure, recovery):
    settings = {"FAKE_PROBE_FAILURES": "2" if failure == "temporary" else "99"}
    if failure == "unsafe-backup":
        settings["FAKE_INVALIDATE_PROBE_BACKUP"] = "1"
    before = host["probe"].stat()
    acl_before = subprocess.check_output(["getfacl", "-cpn", str(host["probe"])])
    result = run(host, FAKE_DUE="1", FAKE_PROBE_DUE="0", **settings)
    assert result.returncode != 0 and f"recovery={recovery}" in result.stdout
    expected = "probe-candidate" if recovery == "manual" else None
    assert host["probe"].read_bytes() == (
        (host["dir"] / expected).read_bytes() if expected else host["probe_original"]
    )
    after = host["probe"].stat()
    assert (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) == (
        before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode),
    )
    assert subprocess.check_output(["getfacl", "-cpn", str(host["probe"])]) == acl_before
    assert host["cert"].read_bytes() == host["original"]
    assert not calls(host, "docker")
    assert not list(host["dir"].glob(".dev-pki-*"))


def test_unsafe_probe_backup_prevents_replacement_without_affecting_server_backup(host):
    (host["backup"] / "previous-probe.crt").symlink_to(host["probe"])
    server_backup = host["backup"] / "previous.crt"
    server_backup.write_bytes(host["original"])
    server_backup.chmod(0o600)
    result = run(host, FAKE_DUE="1", FAKE_PROBE_DUE="0")
    assert result.returncode != 0 and "recovery=not_needed" in result.stdout
    assert server_backup.read_bytes() == host["original"]
    assert_untouched(host)


@pytest.mark.parametrize("change", ["cert", "key", "metadata"])
def test_probe_activation_does_not_overwrite_concurrent_operator_changes(host, change):
    result = run(host, FAKE_DUE="1", FAKE_PROBE_DUE="0", FAKE_CHANGE_MATERIAL=change)
    assert result.returncode != 0 and "concurrent_material_change" in result.stdout
    if change == "metadata":
        assert stat.S_IMODE(host["probe"].stat().st_mode) == 0o400
    else:
        path = Path(host["env"]["DEV_PKI_PROBE_KEY_FILE"]) if change == "key" else host["probe"]
        assert path.read_bytes() == b"operator-change"
    assert host["cert"].read_bytes() == host["original"]
    assert not calls(host, "docker") and not calls(host, "curl")
    assert not list(host["backup"].iterdir())


def test_probe_only_renewal_shares_the_existing_directory_lock(host):
    process = subprocess.Popen(
        ["bash", str(SCRIPT), "renew"],
        env=host["env"] | {"FAKE_WAIT": "1", "FAKE_DUE": "1", "FAKE_PROBE_DUE": "0"},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        for _ in range(150):
            if (host["dir"] / "entered").exists():
                break
            assert process.poll() is None, process.communicate()
            time.sleep(0.02)
        else:
            pytest.fail("fake probe CA was not reached")
        result = run(host, "check")
        assert result.returncode != 0 and "busy" in result.stdout
        assert len(calls(host, "step")) == 3
    finally:
        (host["dir"] / "release").touch()
        out, err = process.communicate(timeout=15)
    assert process.returncode == 0, out + err
    assert not calls(host, "docker")


@pytest.fixture
def renew_runtime():
    # Load the CLI's embedded Python without executing its entrypoint or any host command.
    source = SCRIPT.read_text().split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    namespace = {"__name__": "dev_pki_renew"}
    exec(compile(source, str(SCRIPT), "exec"), namespace)
    return namespace


@pytest.mark.parametrize("grace", [None, "75", "300"])
def test_restart_command_deadline_allows_stop_grace_and_bounded_overhead(
    host, monkeypatch, renew_runtime, grace,
):
    env = host["env"] | ({"DEV_PKI_DOCKER_STOP_GRACE_SECONDS": grace} if grace else {})
    monkeypatch.setattr(os, "environ", env)
    config = renew_runtime["Config"]()
    recorded = []

    def external(args, *, timeout):
        recorded.append((args, timeout))
        return subprocess.CompletedProcess(args, 0, b"", b"")

    monkeypatch.setitem(renew_runtime, "command", external)
    renew_runtime["restart"](config)
    seconds = int(grace or "40")
    assert recorded == [(["docker", "restart", "--time", str(seconds), "sme-ai-http"], seconds + 30)]


def test_user_systemd_templates_have_only_conditional_script_owned_restart():
    service = (UNITS / "sme-ai-dev-pki-renew.service.in").read_text()
    timer = (UNITS / "sme-ai-dev-pki-renew.timer.in").read_text()
    assert "Type=oneshot" in service
    assert "EnvironmentFile=%h/" in service
    assert service.count("ExecStart=") == 1
    assert "dev-pki-renew.sh renew" in service
    assert "ExecStartPost" not in service and "docker" not in service
    assert "OnCalendar=hourly" in timer and "Persistent=true" in timer
    assert "RandomizedDelaySec=" in timer and "Unit=sme-ai-dev-pki-renew.service" in timer
    assert "/home/" not in service + timer and "PRIVATE KEY" not in service + timer


def test_systemd_template_syntax_offline(tmp_path):
    assert shutil.which("systemd-analyze"), "systemd-analyze required for offline unit validation"
    script = tmp_path / "dev-pki-renew.sh"
    script.write_text("#!/bin/sh\nexit 0\n")
    script.chmod(0o700)
    units = []
    for kind in ("service", "timer"):
        source = UNITS / f"sme-ai-dev-pki-renew.{kind}.in"
        unit = tmp_path / source.stem
        text = source.read_text().replace("%h/.local/libexec/sme-ai/dev-pki-renew.sh", str(script))
        text = text.replace("%h/", str(tmp_path) + "/")
        unit.write_text(text)
        units.append(str(unit))
    result = subprocess.run(
        ["systemd-analyze", "verify", *units], capture_output=True, text=True,
        env=os.environ | {"SYSTEMD_UNIT_PATH": f"{tmp_path}:/usr/lib/systemd/system"},
        timeout=10,
    )
    assert result.returncode == 0, result.stdout + result.stderr
