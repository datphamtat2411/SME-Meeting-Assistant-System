"""Focused image checks: uv run python tests/container_smoke.py [image]."""

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from tls_support import create_test_pki

COMMON = [
    "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=160m",
    "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--cpus=1", "--memory=256m", "--pids-limit=64",
    "-e", "AI_SERVICE_NAME=smoke-ai", "-e", "AI_SERVICE_IDENTITY=ai-core",
    "-e", "AI_HTTP_HOST=0.0.0.0", "-e", "AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS=5",
]
PROBE = (
    "import json,urllib.request; "
    "r=urllib.request.urlopen('http://127.0.0.1:8000/health/{}',timeout=1); "
    "assert r.status==200; assert json.load(r)=={{'status':'{}'}}"
)
TLS_PROBE = """
import json, ssl, urllib.request
context = ssl.create_default_context(cafile='/run/test-tls/ca.crt')
{certificate}
request = urllib.request.Request('https://127.0.0.1:8000/health/ready', headers={{
    'X-Service-Identity': 'core-api', 'X-Client-Verified': 'true',
}})
response = urllib.request.urlopen(request, context=context, timeout=1)
assert response.status == 200
assert json.load(response) == {{'status': 'ready'}}
"""
SAFE_EVENTS = frozenset({
    "http.runtime.failed", "http.configuration.failed", "worker.configuration.failed",
    "worker.runtime.failed", "worker.starting", "worker.started", "worker.stopped", "worker.failed",
    "worker.startup.failed", "worker.execution.missing", "worker.execution.failed",
    "worker.execution.timeout", "worker.cleanup.failed", "worker.cleanup.timeout",
    "worker.shutdown.requested", "worker.transcription.consuming",
    *(f"worker.transcription.startup.{phase}.failed" for phase in
      ("provider", "core", "storage", "vad", "pipeline", "broker")),
})
TEST_SECRET = "smoke-only-provider-key"


def lifecycle_events(logs):
    observed = []
    for line in logs.splitlines():
        try:
            data = json.loads(line)
            event = data.get("event") if isinstance(data, dict) else None
        except ValueError:
            event = line
        if isinstance(event, str) and event in SAFE_EVENTS:
            observed.append(event)
    return observed


def diagnostics(logs):
    # Redaction by projection, not fragile regex replacement of arbitrary output.
    observed = lifecycle_events(logs)
    return (f"events={observed[-24:]!r} traceback={'Traceback' in logs} "
            f"suppressed_lines={max(0, len(logs.splitlines()) - len(observed))}")


def assert_exit(cid, role, phase, expected_exit, expected_events):
    actual = docker("wait", cid)
    logs = docker("logs", cid)
    observed = set(lifecycle_events(logs))
    detail = (f"role={role} phase={phase} expected_exit={expected_exit} actual_exit={actual} "
              f"expected_events={sorted(expected_events)} {diagnostics(logs)}")
    assert actual == expected_exit, detail
    assert expected_events <= observed, detail
    assert "Traceback" not in logs and TEST_SECRET not in logs, detail
    if expected_exit != "0":
        assert not observed & {"worker.started", "worker.transcription.consuming", "worker.stopped"}, detail


def docker(*args):
    result = subprocess.run(["docker", *args], text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, f"Docker operation={args[0]} exit={result.returncode}; output suppressed"
    # Docker forwards a container's stderr to the CLI's stderr even on success.
    # Preserve it for projection/assertions, never dump it as raw diagnostics.
    return (result.stdout + (result.stderr if args[0] == "logs" else "")).strip()


def probe(cid, code):
    return subprocess.run(
        ["docker", "exec", cid, "python", "-c", code], capture_output=True,
    ).returncode


def wait_ready(cid, code):
    for _ in range(50):
        if probe(cid, code) == 0:
            return
        assert json.loads(docker("inspect", cid))[0]["State"]["Running"], (
            f"role=sme-ai-http phase=readiness {diagnostics(docker('logs', cid))}"
        )
        time.sleep(0.2)
    raise AssertionError(f"role=sme-ai-http phase=readiness timeout {diagnostics(docker('logs', cid))}")


def stop(cid):
    docker("stop", "--time=10", cid)
    assert_exit(cid, "sme-ai-http", "shutdown", "0", set())


def main():
    image = sys.argv[1] if len(sys.argv) > 1 else "sme-ai:smoke"
    ids = []
    with tempfile.TemporaryDirectory(prefix="ai-smoke-") as temporary:
        try:
            http = docker("run", "-d", *COMMON, "-e", "AI_ENVIRONMENT=test", image)
            ids.append(http)
            wait_ready(http, PROBE.format("ready", "ready"))
            assert probe(http, PROBE.format("live", "ok")) == 0
            assert probe(http, "import os; assert os.getuid()==10001") == 0
            assert probe(http, (
                "import shutil,subprocess; "
                "assert shutil.which('ffmpeg') and shutil.which('ffprobe'); "
                "[subprocess.run([tool,'-version'],check=True,capture_output=True,timeout=5) "
                "for tool in ('ffmpeg','ffprobe')]"
            )) == 0
            state = json.loads(docker("inspect", http))[0]
            host = state["HostConfig"]
            assert state["Config"]["User"] == "10001:10001"
            assert host["ReadonlyRootfs"] and host["PidsLimit"] == 64
            assert host["Memory"] == 256 * 1024 * 1024 and host["NanoCpus"] == 10**9
            assert "ALL" in host["CapDrop"]
            assert "no-new-privileges:true" in host["SecurityOpt"]
            assert "/tmp" in host["Tmpfs"]
            stop(http)

            for role, environment, phase, extra, expected in [
                ("sme-ai-http", "production", "tls", [], {"http.runtime.failed"}),
                ("sme-ai-worker", "test", "missing-credentials", [], {
                    "worker.transcription.startup.provider.failed", "worker.startup.failed", "worker.failed"}),
                ("sme-ai-worker", "test", "missing-correction", ["-e", f"OPENROUTER_API_KEY={TEST_SECRET}"], {
                    "worker.transcription.startup.provider.failed", "worker.startup.failed", "worker.failed"}),
                ("sme-ai-worker", "test", "invalid-core-tls", [
                    "-e", f"OPENROUTER_API_KEY={TEST_SECRET}", "-e", "AI_TRANSCRIPT_CORRECTION_MODEL=test/corrector",
                    "-e", "AI_CORE_API_BASE_URL=https://core.invalid",
                    "-e", "AI_CORE_API_SERVER_CA_FILE=/missing/ca",
                    "-e", "AI_CORE_API_CLIENT_CERT_FILE=/missing/cert",
                    "-e", "AI_CORE_API_CLIENT_KEY_FILE=/missing/key",
                ], {"worker.transcription.startup.core.failed", "worker.startup.failed", "worker.failed"}),
            ]:
                cid = docker("run", "-d", *COMMON, "-e", f"AI_ENVIRONMENT={environment}", *extra, image, role)
                ids.append(cid)
                deadline = time.monotonic() + 10
                while json.loads(docker("inspect", cid))[0]["State"]["Running"]:
                    if role == "sme-ai-http":
                        assert probe(cid, PROBE.format("ready", "ready")) != 0
                    assert time.monotonic() < deadline, (
                        f"role={role} phase={phase} expected_exit=1 actual_exit=running "
                        f"{diagnostics(docker('logs', cid))}"
                    )
                    time.sleep(0.1)
                assert_exit(cid, role, phase, "1", expected)

            pki = create_test_pki(Path(temporary))
            mounts = []
            # Mount only ephemeral leaf keys/certs and the public CA, never CA keys.
            for name in ("server.crt", "server.key", "ca.crt", "core-api.crt", "core-api.key", "rogue.crt", "rogue.key"):
                path = pki / name
                path.chmod(0o444)  # Test-only keys readable by the container UID.
                mounts += ["--mount", f"type=bind,src={path},dst=/run/test-tls/{name},readonly"]
            tls = docker(
                "run", "-d", *COMMON, *mounts, "-e", "AI_ENVIRONMENT=production",
                "-e", "AI_TLS_CERT_FILE=/run/test-tls/server.crt",
                "-e", "AI_TLS_KEY_FILE=/run/test-tls/server.key",
                "-e", "AI_TLS_CLIENT_CA_FILE=/run/test-tls/ca.crt", image,
            )
            ids.append(tls)
            valid = TLS_PROBE.format(certificate=(
                "context.load_cert_chain('/run/test-tls/core-api.crt','/run/test-tls/core-api.key')"
            ))
            wait_ready(tls, valid)
            assert probe(tls, TLS_PROBE.format(certificate="")) != 0, "missing client certificate accepted"
            assert probe(tls, TLS_PROBE.format(certificate=(
                "context.load_cert_chain('/run/test-tls/rogue.crt','/run/test-tls/rogue.key')"
            ))) != 0, "untrusted client certificate accepted"
            assert probe(tls, PROBE.format("ready", "ready")) != 0, "plaintext bypass"
            stop(tls)
        finally:
            if ids:
                docker("rm", "-f", *ids)
    print("Container smoke passed: restricted HTTP, worker startup rejection, production fail-closed, verified mTLS and SIGTERM")


if __name__ == "__main__":
    main()
