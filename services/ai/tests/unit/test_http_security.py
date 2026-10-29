import asyncio
import json
import logging
from dataclasses import FrozenInstanceError, replace
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import Depends

from sme_meeting_ai.api import create_app
from sme_meeting_ai.api.security import (
    VerifiedServiceIdentity,
    require_internal_operation,
)
from sme_meeting_ai.core.config import ConfigurationError, Settings

SECRET = "private-certificate-token"


@pytest.fixture(autouse=True)
def restore_logger():
    logger = logging.getLogger("sme_meeting_ai")
    handlers, level, propagate = logger.handlers[:], logger.level, logger.propagate
    yield
    for handler in logger.handlers:
        if handler not in handlers:
            handler.close()
    logger.handlers, logger.propagate = handlers, propagate
    logger.setLevel(level)


def settings(**kwargs):
    return Settings(_env_file=None, service_name="test-ai", service_identity="ai-core", **kwargs)


class Boundary:
    """Simulate a trusted ASGI/TLS adapter, never reading client identity fields."""

    def __init__(self, **changes):
        self.changes = changes

    async def identity_for(self, scope):
        return replace(VerifiedServiceIdentity(
            principal="core-api", certificate_verified=True, request_scope=scope,
            expires_at=datetime.now(UTC) + timedelta(minutes=1),
        ), **self.changes)


def protected_app(source=None, policy=None, **kwargs):
    app = create_app(settings(**kwargs), identity_source=source, operation_policy=policy)

    @app.post("/test-internal", dependencies=[Depends(require_internal_operation("test.execute"))])
    async def internal():
        return {"ok": True}

    return app


def request(app, **kwargs):
    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test",
        ) as http:
            return await http.post("/test-internal", **kwargs)
    return asyncio.run(run())


POLICY = {"test.execute": {"core-api"}}


def test_verified_identity_is_immutable_and_explicit_operation_is_allowed():
    identity = asyncio.run(Boundary().identity_for({}))
    with pytest.raises(FrozenInstanceError):
        identity.principal = "other"
    assert request(protected_app(Boundary(), POLICY)).json() == {"ok": True}


@pytest.mark.parametrize("changes", [
    {"principal": "Bearer " + SECRET}, {"principal": "Core-API"},
    {"principal": " core-api"}, {"principal": None},
    {"certificate_verified": False}, {"certificate_verified": "true"},
    {"request_scope": {}},
    {"expires_at": datetime.now(UTC) - timedelta(seconds=1)},
    {"expires_at": datetime.now()}, {"expires_at": None},
])
def test_invalid_unverified_stale_or_replayed_identity_is_rejected(changes):
    response = request(protected_app(Boundary(**changes), POLICY))
    assert response.status_code == 401
    assert response.json() == {"error": {
        "code": "service_authentication_required", "message": "Service authentication required",
    }}


@pytest.mark.parametrize("result", [None, {}, "core-api"])
def test_missing_or_malformed_boundary_result_is_rejected(result):
    class Source:
        async def identity_for(self, scope):
            return result
    assert request(protected_app(Source(), POLICY)).status_code == 401


@pytest.mark.parametrize(("source", "policy", "callers"), [
    (Boundary(principal="other-service"), POLICY, ("core-api",)),
    (Boundary(), POLICY, ()),
    (Boundary(), None, ("core-api",)),
    (Boundary(), {}, ("core-api",)),
    (Boundary(), {"other.operation": {"core-api"}}, ("core-api",)),
    (Boundary(), {"*": {"core-api"}}, ("core-api",)),
    (Boundary(), {"test.execute": {"*"}}, ("core-api",)),
    (Boundary(), {"test.execute": set()}, ("core-api",)),
])
def test_default_deny_authorization(source, policy, callers):
    response = request(protected_app(source, policy, internal_allowed_callers=callers))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "service_access_denied"


@pytest.mark.parametrize("source, expected", [(None, 503), (Boundary(certificate_verified=False), 401)])
def test_client_credentials_and_forwarded_headers_never_authenticate(source, expected):
    response = request(protected_app(source, POLICY), headers={
        "Authorization": "Bearer " + SECRET,
        "X-Service-Identity": "core-api", "X-Forwarded-Client-Cert": SECRET,
        "X-Forwarded-For": "127.0.0.1", "X-Client-Verified": "true",
        "X-User-Access-Token": SECRET, "X-Refresh-Token": SECRET,
    }, json={"principal": "core-api", "certificate_verified": True},
        params={"service_identity": "core-api"})
    assert response.status_code == expected
    assert SECRET not in response.text + str(response.headers)


def test_identity_source_failure_is_sanitized_and_logged(capsys):
    class FailedSource:
        async def identity_for(self, scope):
            raise RuntimeError(SECRET)

    async def run():
        app = protected_app(FailedSource(), POLICY)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
                return await http.post("/test-internal", headers={"Authorization": "Bearer " + SECRET})
    response = asyncio.run(run())
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_security_unavailable"
    output = capsys.readouterr().out
    assert all(value not in output + response.text for value in (SECRET, "core-api", "RuntimeError", "Authorization"))
    events = [json.loads(line) for line in output.splitlines()]
    assert "security.integration_unavailable" in [event["event"] for event in events]


@pytest.mark.parametrize("environment", ["staging", "production"])
@pytest.mark.parametrize("source", [None, object()])
def test_deployed_startup_requires_trusted_source(environment, source):
    async def run():
        app = protected_app(source, POLICY, environment=environment)
        with pytest.raises(ConfigurationError, match="Internal service security unavailable"):
            async with app.router.lifespan_context(app):
                pytest.fail("insecure startup")
        assert app.state.runtime.initialized is False
    asyncio.run(run())


def test_health_probes_remain_unauthenticated_and_production_accepts_trusted_source():
    async def run():
        for environment, source in [("test", None), ("production", Boundary())]:
            app = protected_app(source, POLICY, environment=environment)
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
                    assert (await http.get("/health/live")).status_code == 200
                    assert (await http.get("/health/ready")).status_code == 200
    asyncio.run(run())


def test_policy_is_snapshotted_and_application_local():
    policy = {"test.execute": {"core-api"}}
    app = protected_app(Boundary(), policy)
    policy["test.execute"].clear()
    assert request(app).status_code == 200
    assert request(protected_app(Boundary(), {})).status_code == 403


@pytest.mark.parametrize("source, policy, status, event", [
    (Boundary(principal="private-caller"), POLICY, 403, "security.authorization_denied"),
    (Boundary(principal="Bearer " + SECRET), POLICY, 401, "security.authentication_failed"),
    (Boundary(), POLICY, 200, "security.access_granted"),
    (None, POLICY, 503, "security.integration_unavailable"),
])
def test_security_events_have_only_safe_fields(source, policy, status, event, capsys):
    async def run():
        app = protected_app(source, policy)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
                return await http.post("/test-internal", headers={
                    "Authorization": "Bearer " + SECRET,
                    "X-Forwarded-Client-Cert": SECRET,
                })
    response = asyncio.run(run())
    assert response.status_code == status
    output = capsys.readouterr().out
    assert all(value not in output + response.text + str(response.headers) for value in (
        SECRET, "private-caller", "core-api", "certificate_verified", "Authorization",
    ))
    security_events = [json.loads(line) for line in output.splitlines()
                       if json.loads(line)["event"].startswith("security.")]
    assert [item["event"] for item in security_events] == [event]
    assert security_events[0].keys() == {
        "timestamp", "severity", "event", "service", "trace_id", "span_id", "trace_flags",
    }
