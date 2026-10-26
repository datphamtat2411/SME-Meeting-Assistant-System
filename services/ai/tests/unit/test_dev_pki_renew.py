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
    for name in ("root", "rogue"):
        openssl(
            pki, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
            "-nodes", "-days", "30", "-subj", f"/CN=Ephemeral {name}",
            "-keyout", f"{name}.key", "-out", f"{name}.crt",
            "-addext", "basicConstraints=critical,CA:TRUE",
        )
    for name in ("intermediate", "server", "different", "probe"):
        openssl(
            pki, "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
            "-nodes", "-subj", "/CN=localhost", "-keyout", f"{name}.key",
            "-out", f"{name}.csr",
        )
    (pki / "ca.ext").write_text(
        "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n"
    )
    openssl(
        pki, "x509", "-req", "-in", "intermediate.csr", "-CA", "root.crt",
        "-CAkey", "root.key", "-CAcreateserial", "-days", "20", "-extfile", "ca.ext",
        "-out", "intermediate.crt",
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
    issue("probe", csr="probe", ca="root", eku="clientAuth",
          san="URI:urn:sme:service:dev-pki-probe")
    return pki


FAKE_COMMAND = '''#!{python}
import json, os, pathlib, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
base = pathlib.Path(os.environ["FAKE_HOME"])
with (base / "calls").open("a") as log:
    log.write(json.dumps([name, args]) + "\\n")
if name == "step":
    if args[:2] == ["certificate", "needs-renewal"]:
        sys.exit(int(os.environ.get("FAKE_DUE", "0")))
    assert args[:2] == ["ca", "renew"]
    assert "--mtls=false" in args and "--out" in args
    assert "--root" in args and "--ca-url" in args
    if os.environ.get("FAKE_WAIT"):
        (base / "entered").touch()
        while not (base / "release").exists():
            time.sleep(0.02)
    if os.environ.get("FAKE_CA_FAIL"):
        print("PRIVATE_KEY_MATERIAL private-host-secret", file=sys.stderr)
        sys.exit(1)
    pathlib.Path(args[args.index("--out") + 1]).write_bytes((base / "candidate").read_bytes())
    sys.exit(0)
if name == "docker":
    assert args == ["restart", "--time", "10", "sme-ai-http"]
    with (base / "restarts").open("a") as log:
        log.write(pathlib.Path(os.environ["DEV_PKI_CERT_FILE"]).read_text() + "END_RESTART\\n")
    if os.environ.get("FAKE_INVALIDATE_BACKUP"):
        for backup in pathlib.Path(os.environ["DEV_PKI_BACKUP_DIR"]).glob("*.crt"):
            backup.write_text("not a certificate")
    sys.exit(1 if os.environ.get("FAKE_RESTART_FAIL") else 0)
if name == "curl":
    count_file = base / "probe-count"
    count = int(count_file.read_text()) if count_file.exists() else 0
    count_file.write_text(str(count + 1))
    if count < int(os.environ.get("FAKE_PROBE_FAILURES", "0")):
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
                           ("root.crt", live / "client-ca.crt"),
                           ("probe.crt", tmp_path / "probe.crt"),
                           ("probe.key", tmp_path / "probe.key")):
        shutil.copyfile(pki / source, target)
        target.chmod(0o600)
    cert = live / "ai-server.crt"
    cert.write_bytes((pki / "current.crt").read_bytes() + (pki / "intermediate.crt").read_bytes())
    cert.chmod(0o640)
    candidate = tmp_path / "candidate"
    candidate.write_bytes((pki / "renewed.crt").read_bytes() + (pki / "intermediate.crt").read_bytes())
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
        "DEV_PKI_PROBE_ATTEMPTS": "2", "DEV_PKI_PROBE_INTERVAL_SECONDS": "0",
        "DEV_PKI_PROBE_TIMEOUT_SECONDS": "1",
    })
    return {"dir": tmp_path, "pki": pki, "cert": cert, "env": env, "backup": backup,
            "original": cert.read_bytes(), "key": (live / "ai-server.key").read_bytes()}


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
    assert not calls(host, "docker")
    assert not calls(host, "curl")
    assert sorted(path.name for path in host["cert"].parent.iterdir()) == [
        "ai-server.crt", "ai-server.key", "client-ca.crt",
    ]


@pytest.mark.parametrize("code,status,success", [(0, "due", True), (1, "not_due", True),
                                               (2, "invalid", False), (255, "invalid", False)])
def test_check_is_read_only_and_distinguishes_step_exits(host, code, status, success):
    before = {path: (path.read_bytes(), path.stat().st_mtime_ns)
              for path in host["cert"].parent.iterdir()}
    result = run(host, "check", FAKE_DUE=str(code))
    assert (result.returncode == 0) == success, result.stderr
    assert f"status={status}" in result.stdout
    assert len(calls(host, "step")) == 1
    assert not list(host["backup"].iterdir())
    assert before == {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in before}
    assert_untouched(host)


def test_noop_does_not_stage_backup_restart_or_probe(host):
    result = run(host, FAKE_DUE="1", AI_TLS_CERT_FILE="/container-only/ignored.crt")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "status=not_due"
    assert len(calls(host, "step")) == 1
    assert not list(host["backup"].iterdir())
    assert_untouched(host)


def test_identical_ca_output_is_no_replacement_and_no_restart(host):
    (host["dir"] / "candidate").write_bytes(host["original"])
    result = run(host)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "status=not_due"
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
])
def test_invalid_configuration_fails_before_external_commands(host, setting, value):
    result = run(host, **{setting: value})
    assert result.returncode != 0
    assert "status=invalid" in result.stdout
    assert not calls(host)
    assert_untouched(host)


@pytest.mark.parametrize("unsafe", ["cert-symlink", "parent-symlink", "backup-inside",
                                    "backup-public", "cert-writable", "key-writable"])
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
    assert result.stdout.strip() == "status=renewed"
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
    renewal = calls(host, "step")[1]
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
        assert len(calls(host, "step")) == 2
    finally:
        (host["dir"] / "release").touch()
        out, err = process.communicate(timeout=15)
    assert process.returncode == 0, out + err


def test_user_systemd_templates_have_only_conditional_script_owned_restart():
    service = (UNITS / "sme-ai-dev-pki-renew.service.in").read_text()
    timer = (UNITS / "sme-ai-dev-pki-renew.timer.in").read_text()
    assert "Type=oneshot" in service
    assert "EnvironmentFile=%h/" in service
    assert service.count("ExecStart=") == 1
    assert "dev-pki-renew.sh renew" in service
    assert "ExecStartPost" not in service and "docker" not in service
    assert "OnCalendar=" in timer and "Persistent=true" in timer
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
