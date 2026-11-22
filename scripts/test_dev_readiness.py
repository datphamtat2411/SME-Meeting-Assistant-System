"""Focused tests for external AI HTTP readiness validation."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "dev_readiness.py"
SPEC = importlib.util.spec_from_file_location("dev_readiness", SCRIPT)
assert SPEC and SPEC.loader
dev_readiness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev_readiness)


def test_ready_response_requires_http_status_and_application_json():
    response = (
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: application/json\r\n"
        b"Content-Length: 18\r\n\r\n"
        b'{"status":"ready"}'
    )

    assert dev_readiness._validate_ready_response(response) is None


@pytest.mark.parametrize(
    "response",
    (
        b"hello",
        b"HTTP/1.1 200 OK\r\n\r\nnot-json",
        (
            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
            b"Content-Length: 18\r\n\r\n{\"status\":\"ready\"}"
        ),
        b"HTTP/1.1 503 Service Unavailable\r\n\r\n{\"status\":\"not_ready\"}",
    ),
)
def test_ready_response_rejects_non_application_or_unready_listener(response):
    with pytest.raises(dev_readiness.ReadinessError):
        dev_readiness._validate_ready_response(response)


def test_external_endpoint_requires_localhost_identity():
    assert dev_readiness._external_ai_endpoint("https://localhost:8000") == (
        "localhost",
        "127.0.0.1",
        8000,
    )

    with pytest.raises(dev_readiness.ReadinessError):
        dev_readiness._external_ai_endpoint("http://localhost:8000")
    with pytest.raises(dev_readiness.ReadinessError):
        dev_readiness._external_ai_endpoint("https://127.0.0.1:8000")
    with pytest.raises(dev_readiness.ReadinessError):
        dev_readiness._external_ai_endpoint("https://remote.invalid:8000")
