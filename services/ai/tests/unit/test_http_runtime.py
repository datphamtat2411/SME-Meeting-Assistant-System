import asyncio
import importlib
import json
import logging

import httpx
import pytest
from fastapi import HTTPException

from sme_meeting_ai.api import create_app
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.observability import (
    correlation_scope,
    get_correlation_context,
    new_correlation_context,
    parse_traceparent,
)


TRACE = "1234567890abcdef1234567890abcdef"
SPAN = "1234567890abcdef"
TRACEPARENT = f"00-{TRACE}-{SPAN}-01"
SECRET = "private-provider-token"


@pytest.fixture(autouse=True)
def restore_logger():
    logger = logging.getLogger("sme_meeting_ai")
    handlers, level, propagate = logger.handlers[:], logger.level, logger.propagate
    yield
    for handler in logger.handlers:
        if handler not in handlers:
            handler.close()
    logger.handlers = handlers
    logger.setLevel(level)
    logger.propagate = propagate


def settings(**kwargs):
    return Settings(_env_file=None, service_name="test-ai", **kwargs)


def client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


def test_construction_is_isolated_and_logging_only_configured_in_lifespan(monkeypatch):
    module = importlib.import_module("sme_meeting_ai.api.app")
    configured = []
    monkeypatch.setattr(module, "configure_logging", configured.append)
    selected = settings(debug=True)
    monkeypatch.setattr(module, "get_settings", lambda: selected)
    first = create_app()
    second = create_app(settings())
    assert first.state.settings is selected
    assert first.state.runtime is not second.state.runtime
    assert first.debug is False
    assert configured == []

    async def run():
        async with first.router.lifespan_context(first):
            assert configured == [selected]
            assert first.state.runtime.initialized is True
            assert second.state.runtime.initialized is False
        assert first.state.runtime.initialized is False

    asyncio.run(run())


def test_health_tracks_lifespan_and_stays_local_to_each_app():
    async def run():
        app, other = create_app(settings()), create_app(settings())
        async with client(app) as http, client(other) as other_http:
            for initialized in (False, True, False):
                if initialized:
                    async with app.router.lifespan_context(app):
                        response = await http.get("/health/ready")
                        assert response.status_code == 200
                        assert response.json() == {"status": "ready"}
                        assert (await other_http.get("/health/ready")).status_code == 503
                else:
                    response = await http.get("/health/ready")
                    assert response.status_code == 503
                    assert response.json() == {"status": "not_ready"}
                live = await http.get("/health/live")
                assert live.status_code == 200
                assert live.json() == {"status": "ok"}

    asyncio.run(run())


def test_only_health_routes_are_exposed_without_cors_or_docs():
    async def run():
        app = create_app(settings())
        assert app.docs_url is None
        assert app.redoc_url is None
        assert app.openapi_url is None
        async with client(app) as http:
            for path in ("/", "/docs", "/redoc", "/openapi.json", "/ai", "/health"):
                assert (await http.get(path)).status_code == 404
            response = await http.options("/health/live", headers={
                "Origin": "https://public.example",
                "Access-Control-Request-Method": "GET",
            })
            assert response.status_code == 405
            assert "GET" in response.headers["allow"]
            live = await http.get("/health/live", headers={"Origin": "https://public.example"})
            for item in (response, live):
                assert not any(key.startswith("access-control-") for key in item.headers)

    asyncio.run(run())


def test_valid_correlation_propagation_and_safe_lifecycle_logs(capsys):
    async def run():
        app = create_app(settings())
        observed = []

        @app.get("/test-context")
        async def context():
            observed.append(get_correlation_context())
            return {"ok": True}

        async with app.router.lifespan_context(app), client(app) as http:
            response = await http.get("/test-context?token=" + SECRET, headers={
                "traceparent": TRACEPARENT, "x-request-id": "request-1",
                "x-job-id": "job-2", "Authorization": "Bearer " + SECRET,
            })
            assert get_correlation_context() is None
        current = observed[0]
        assert current.trace_id == TRACE
        assert current.parent_span_id == SPAN
        assert current.span_id != SPAN
        assert current.request_id == "request-1"
        assert current.job_id == "job-2"
        outbound = parse_traceparent(response.headers["traceparent"])
        assert outbound.trace_id == current.trace_id
        assert outbound.span_id == current.span_id
        assert outbound.trace_flags == "01"
        assert response.headers["x-request-id"] == "request-1"

    asyncio.run(run())
    output = capsys.readouterr().out
    assert SECRET not in output
    events = [json.loads(line) for line in output.splitlines()]
    assert [event["event"] for event in events] == [
        "http.request.started", "http.request.completed",
    ]
    assert all(event["trace_id"] == TRACE for event in events)
    assert all(event["request_id"] == "request-1" for event in events)
    assert all(event["job_id"] == "job-2" for event in events)


@pytest.mark.parametrize("unsafe", [SECRET + "\nforged", "x" * 129, "user@example.com"])
def test_malformed_headers_are_discarded(unsafe, capsys):
    async def run():
        app = create_app(settings())
        async with app.router.lifespan_context(app), client(app) as http:
            response = await http.get("/health/live", headers={
                "traceparent": TRACEPARENT + "-" + unsafe,
                "x-request-id": unsafe, "x-job-id": unsafe,
            })
        context = parse_traceparent(response.headers["traceparent"])
        assert context is not None
        assert context.trace_id != TRACE
        assert context.trace_flags == "00"
        assert "x-request-id" not in response.headers
        assert unsafe not in str(response.headers)
        assert unsafe not in response.text
        assert get_correlation_context() is None

    asyncio.run(run())
    output = capsys.readouterr().out
    assert unsafe not in output
    assert SECRET not in output
    for line in output.splitlines():
        assert not {"request_id", "job_id", "parent_span_id"} & json.loads(line).keys()


def test_concurrent_requests_are_isolated_and_restore_outer_context():
    async def run():
        app = create_app(settings())
        arrived = 0
        ready = asyncio.Event()

        @app.get("/test-context")
        async def context():
            nonlocal arrived
            before = get_correlation_context()
            arrived += 1
            if arrived == 2:
                ready.set()
            await ready.wait()
            assert get_correlation_context() is before
            return {"request_id": before.request_id, "trace_id": before.trace_id}

        outer = new_correlation_context(request_id="outer")
        async with client(app) as http:
            async def request(identifier):
                with correlation_scope(outer):
                    response = await http.get("/test-context", headers={"x-request-id": identifier})
                    assert get_correlation_context() is outer
                assert get_correlation_context() is None
                return response.json()

            first, second = await asyncio.wait_for(
                asyncio.gather(request("first"), request("second")), timeout=5
            )
            assert first["request_id"] == "first"
            assert second["request_id"] == "second"
            assert first["trace_id"] != second["trace_id"]
        assert get_correlation_context() is None

    asyncio.run(run())


def test_sanitized_errors_preserve_status_headers_and_cleanup(capsys):
    async def run():
        app = create_app(settings(debug=True))

        @app.get("/test-http")
        async def http_error():
            raise HTTPException(409, detail={"token": SECRET}, headers={"X-Secret": SECRET})

        @app.get("/test-validation")
        async def validation(count: int):
            return count

        @app.get("/test-failure")
        async def failure():
            assert get_correlation_context().request_id == "failed-request"
            raise RuntimeError(SECRET)

        async with app.router.lifespan_context(app), client(app) as http:
            for method, path, status, code in [
                ("GET", "/missing?token=" + SECRET, 404, "not_found"),
                ("POST", "/health/live", 405, "method_not_allowed"),
                ("GET", "/test-validation?count=" + SECRET, 422, "validation_error"),
                ("GET", "/test-http", 409, "http_error"),
                ("GET", "/test-failure", 500, "internal_error"),
            ]:
                response = await http.request(method, path, headers={"x-request-id": "failed-request"})
                assert response.status_code == status
                error = response.json()["error"]
                assert set(error) == {"code", "message"}
                assert error["code"] == code
                assert isinstance(error["message"], str) and error["message"]
                assert SECRET not in response.text + str(response.headers)
                assert "Traceback" not in response.text
                assert parse_traceparent(response.headers["traceparent"]) is not None
                assert response.headers["x-request-id"] == "failed-request"
                if status == 405:
                    assert "GET" in response.headers["allow"]
                assert get_correlation_context() is None
            assert (await http.get("/health/live")).status_code == 200

    asyncio.run(run())
    output = capsys.readouterr().out
    assert SECRET not in output
    events = [json.loads(line) for line in output.splitlines()]
    failed = [event for event in events if event["event"] == "http.request.failed"]
    assert len(failed) == 1
    assert failed[0]["request_id"] == "failed-request"
    assert "request_id" not in events[-1]
