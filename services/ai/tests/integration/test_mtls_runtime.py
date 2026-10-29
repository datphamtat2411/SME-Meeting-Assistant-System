import os
import socket
import ssl
import subprocess
import sys
import time

import httpx
import pytest

# Test-only protected route: production exposes only the existing health routes.
SERVER = """
from fastapi import Depends
from sme_meeting_ai.api import __main__ as entrypoint
from sme_meeting_ai.api.app import create_app
from sme_meeting_ai.api.security import require_internal_operation

def test_app(settings, **kwargs):
    app = create_app(settings, operation_policy={"test.execute": {"core-api"}}, **kwargs)
    @app.post("/test-internal", dependencies=[Depends(require_internal_operation("test.execute"))])
    async def protected():
        return {"ok": True}
    return app

entrypoint.create_app = test_app
raise SystemExit(entrypoint.main())
"""


def client(test_pki, name="core-api"):
    context = ssl.create_default_context(cafile=test_pki / "ca.crt")
    if name:
        context.load_cert_chain(test_pki / f"{name}.crt", test_pki / f"{name}.key")
    return httpx.Client(verify=context, trust_env=False, timeout=2)


@pytest.fixture(scope="module")
def mtls_server(test_pki):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = {key: value for key, value in os.environ.items() if not key.startswith("AI_")}
    env.update({
        "AI_SERVICE_NAME": "tls-test", "AI_SERVICE_IDENTITY": "ai-core",
        "AI_ENVIRONMENT": "production", "AI_HTTP_HOST": "127.0.0.1",
        "AI_HTTP_PORT": str(port), "AI_HTTP_SHUTDOWN_TIMEOUT_SECONDS": "2",
        "AI_TLS_CERT_FILE": str(test_pki / "server.crt"),
        "AI_TLS_KEY_FILE": str(test_pki / "server.key"),
        "AI_TLS_CLIENT_CA_FILE": str(test_pki / "ca.crt"),
    })
    process = subprocess.Popen(
        [sys.executable, "-c", SERVER], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True,
    )
    url = f"https://127.0.0.1:{port}"
    try:
        with client(test_pki) as http:
            for _ in range(50):
                if process.poll() is not None:
                    out, err = process.communicate()
                    pytest.fail(f"TLS server startup failed: {out} {err}")
                try:
                    if http.get(url + "/health/ready").status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.1)
            else:
                pytest.fail("TLS server did not become ready")
        yield url
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            out, err = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            pytest.fail("TLS shutdown exceeded its deadline")
        assert process.returncode == 0, out + err
        assert "Traceback" not in out + err


def test_verified_certificate_authorizes_each_keepalive_request(mtls_server, test_pki):
    with client(test_pki) as http:
        for _ in range(2):
            response = http.post(mtls_server + "/test-internal")
            assert response.status_code == 200
            assert response.json() == {"ok": True}
        assert http.get(mtls_server + "/health/live").json() == {"status": "ok"}


@pytest.mark.parametrize("name", [None, "rogue", "expired"])
def test_missing_untrusted_and_expired_certificates_fail_handshake(mtls_server, test_pki, name):
    with client(test_pki, name) as http, pytest.raises(httpx.TransportError):
        http.get(mtls_server + "/health/ready", headers={
            "X-Service-Identity": "core-api", "X-Client-Verified": "true",
        })


@pytest.mark.parametrize("name,status", [("other", 403), ("cn-only", 401), ("ambiguous", 401)])
def test_certificate_identity_never_comes_from_cn_or_headers(mtls_server, test_pki, name, status):
    with client(test_pki, name) as http:
        response = http.post(mtls_server + "/test-internal", headers={
            "Authorization": "Bearer forged", "X-Service-Identity": "core-api",
            "X-Forwarded-Client-Cert": "urn:sme:service:core-api",
        })
        assert response.status_code == status


def test_mtls_listener_has_no_plaintext_bypass(mtls_server):
    with httpx.Client(trust_env=False, timeout=2) as http, pytest.raises(httpx.TransportError):
        http.get(mtls_server.replace("https://", "http://") + "/health/ready")
