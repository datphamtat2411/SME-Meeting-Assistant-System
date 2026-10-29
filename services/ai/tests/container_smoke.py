"""Focused image checks: uv run python tests/container_smoke.py [image]."""

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from tls_support import create_test_pki

COMMON = [
    "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
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


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT).strip()


def probe(cid, code):
    return subprocess.run(
        ["docker", "exec", cid, "python", "-c", code], capture_output=True,
    ).returncode


def wait_ready(cid, code):
    for _ in range(50):
        if probe(cid, code) == 0:
            return
        assert json.loads(docker("inspect", cid))[0]["State"]["Running"], docker("logs", cid)
        time.sleep(0.2)
    raise AssertionError("HTTP never became ready")


def stop(cid):
    docker("stop", "--time=10", cid)
    assert docker("wait", cid) == "0", docker("logs", cid)


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
            state = json.loads(docker("inspect", http))[0]
            host = state["HostConfig"]
            assert state["Config"]["User"] == "10001:10001"
            assert host["ReadonlyRootfs"] and host["PidsLimit"] == 64
            assert host["Memory"] == 256 * 1024 * 1024 and host["NanoCpus"] == 10**9
            assert "ALL" in host["CapDrop"]
            assert "no-new-privileges:true" in host["SecurityOpt"]
            assert "/tmp" in host["Tmpfs"]
            stop(http)

            for role, environment, event in [
                ("sme-ai-http", "production", "http.runtime.failed"),
                ("sme-ai-worker", "test", "worker.execution.missing"),
            ]:
                cid = docker("run", "-d", *COMMON, "-e", f"AI_ENVIRONMENT={environment}", image, role)
                ids.append(cid)
                deadline = time.monotonic() + 10
                while json.loads(docker("inspect", cid))[0]["State"]["Running"]:
                    if role == "sme-ai-http":
                        assert probe(cid, PROBE.format("ready", "ready")) != 0
                    assert time.monotonic() < deadline, "runtime did not fail promptly"
                    time.sleep(0.1)
                assert docker("wait", cid) == "1"
                logs = docker("logs", cid)
                assert event in logs and "Traceback" not in logs

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
    print("Container smoke passed: restricted HTTP, worker failure, production fail-closed, verified mTLS and SIGTERM")


if __name__ == "__main__":
    main()
