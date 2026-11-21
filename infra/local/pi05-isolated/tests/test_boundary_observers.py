"""Offline tests for read-only, source-backed service boundary observers."""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from boundary_observers import (
    AiObserver,
    CoreObserver,
    HttpEndpoint,
    JsonCheck,
    ObserverBlocked,
    RabbitEndpoint,
    RabbitMqObserver,
    StorageEndpoint,
    StorageObserver,
    _connect_rabbit,
    _new_storage_http_connection,
    _probe_tls,
    _tls_context,
)
from observation_receipts import Observation, ReceiptWriter


class FakeResponse:
    def __init__(self, status: int, body: bytes):
        self.status = status
        self.body = body

    def read(self, size: int) -> bytes:
        return self.body[:size]

    def getheader(self, name: str, default=None):
        if name.lower() == "content-type":
            return "application/json"
        return default


class FakeConnection:
    def __init__(self, response: FakeResponse):
        self.response = response
        self.connected = False
        self.closed = False
        self.request_args = None

    def connect(self):
        self.connected = True

    def request(self, method, path, body=None, headers=None):
        assert self.connected
        self.request_args = method, path, body, headers

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


def directories(tmp_path: Path) -> tuple[Path, Path]:
    proofs = tmp_path / "proofs"
    sources = tmp_path / "sources"
    proofs.mkdir(mode=0o700)
    sources.mkdir(mode=0o700)
    return proofs, sources


def observation(
    component: str,
    step: str = "meeting-record",
    result: str = "PERSISTED",
    run_id: str | None = None,
):
    return Observation(
        run_id=run_id or str(uuid4()),
        request_id=str(uuid4()),
        step=step,
        component=component,
        observed_result=result,
        observed_at=datetime.now(UTC),
    )


def endpoint(tmp_path: Path) -> HttpEndpoint:
    ca = tmp_path / "ca.crt"
    cert = tmp_path / "observer.crt"
    key = tmp_path / "observer.key"
    for path in (ca, cert):
        path.write_text("unit-only placeholder")
        path.chmod(0o644)
    key.write_text("unit-only placeholder")
    key.chmod(0o600)
    return HttpEndpoint(
        url="https://127.0.0.1:53124",
        ca_file=ca,
        client_cert=cert,
        client_key=key,
        leaf_sha256="a" * 64,
    )


def test_core_and_ai_observers_require_matching_sanitized_json_checks(
    tmp_path, monkeypatch
):
    proofs, sources = directories(tmp_path)
    connection = FakeConnection(
        FakeResponse(200, b'{"data":{"status":"READY"},"success":true}')
    )
    monkeypatch.setattr(
        "boundary_observers._new_http_connection",
        lambda *_: connection,
    )
    checks = (JsonCheck("ready", ("data", "status"), "READY"),)

    core_digest = CoreObserver(endpoint(tmp_path), ReceiptWriter(proofs, sources)).observe(
        observation("CORE"),
        operation="meeting-read",
        path="/internal/v1/observer/meeting",
        checks=checks,
        source_fields={"meetingId": str(uuid4())},
    )
    assert hashlib.sha256(
        (proofs / f"{core_digest}.json").read_bytes()
    ).hexdigest() == core_digest
    assert json.loads((sources / f"{core_digest}.json").read_bytes())["checks"] == ["ready"]
    assert connection.request_args[0:2] == ("GET", "/internal/v1/observer/meeting")
    assert connection.request_args[3]["X-Request-Id"]

    connection.response = FakeResponse(200, b'{"data":{"status":"READY"},"success":true}')
    with pytest.raises(ObserverBlocked):
        AiObserver(endpoint(tmp_path), ReceiptWriter(proofs, sources)).observe(
            observation("AI", step="media-worker-completed", result="COMPLETED"),
            operation="worker-read",
            path="/health/ready",
            checks=(JsonCheck("status", ("data", "status"), "NOT_READY"),),
        )


def test_http_observer_rejects_bad_response_without_receipt(tmp_path, monkeypatch):
    proofs, sources = directories(tmp_path)
    connection = FakeConnection(FakeResponse(200, b'{"data":{"status":"READY"}}'))
    monkeypatch.setattr(
        "boundary_observers._new_http_connection",
        lambda *_: connection,
    )
    with pytest.raises(ObserverBlocked):
        CoreObserver(endpoint(tmp_path), ReceiptWriter(proofs, sources)).observe(
            observation("CORE"),
            operation="meeting-read",
            path="/internal/v1/observer/meeting",
            checks=(JsonCheck("success", ("success",), True),),
        )
    assert list(proofs.iterdir()) == []
    assert list(sources.iterdir()) == []
    assert connection.closed


def test_http_observer_rejects_mutating_method_and_unscoped_path(tmp_path):
    proofs, sources = directories(tmp_path)
    observer = CoreObserver(endpoint(tmp_path), ReceiptWriter(proofs, sources))
    item = observation("CORE")

    with pytest.raises(ObserverBlocked):
        observer.request_json(item.request_id, "POST", "/internal/write")
    with pytest.raises(ObserverBlocked):
        observer.request_json(item.request_id, "GET", "/internal/../write")


@pytest.mark.parametrize(
    "url",
    [
        "https://localhost:53124",
        "https://rabbitmq.internal:53124",
        "https://0.0.0.0:53124",
        "https://127.0.0.1",
        "https://127.0.0.1:0",
    ],
)
def test_endpoints_accept_only_explicit_loopback_ports(tmp_path, url):
    ca = tmp_path / "ca.crt"
    cert = tmp_path / "observer.crt"
    key = tmp_path / "observer.key"
    ca.write_text("unit-only placeholder")
    cert.write_text("unit-only placeholder")
    key.write_text("unit-only placeholder")
    ca.chmod(0o644)
    cert.chmod(0o644)
    key.chmod(0o600)

    with pytest.raises(ObserverBlocked):
        HttpEndpoint(url, ca, cert, key, "a" * 64)


def test_dynamic_loopback_port_and_separate_tls_identity_are_retained(tmp_path):
    ca = tmp_path / "ca.crt"
    cert = tmp_path / "observer.crt"
    key = tmp_path / "observer.key"
    for path in (ca, cert):
        path.write_text("unit-only placeholder")
        path.chmod(0o644)
    key.write_text("unit-only placeholder")
    key.chmod(0o600)

    endpoint_value = HttpEndpoint(
        "https://127.0.0.1:53127",
        ca,
        cert,
        key,
        "a" * 64,
        tls_server_name="service.internal",
        http_host="service.internal",
    )
    assert endpoint_value.tls_server_name == "service.internal"
    assert endpoint_value.http_host == "service.internal"


def test_tls_probe_uses_loopback_destination_and_dns_identity(tmp_path, monkeypatch):
    ca = tmp_path / "ca.crt"
    ca.write_text("unit-only placeholder")
    ca.chmod(0o644)
    peer = b"run-owned-leaf"
    calls = []

    class Wrapped:
        def getpeercert(self, binary_form=False):
            assert binary_form
            return peer

        def close(self):
            calls.append(("tls-close",))

    class Context:
        def wrap_socket(self, raw, *, server_hostname):
            calls.append(("wrap", raw, server_hostname))
            return Wrapped()

    class Raw:
        def close(self):
            calls.append(("raw-close",))

    monkeypatch.setattr("boundary_observers._tls_context", lambda *_: Context())
    monkeypatch.setattr(
        "boundary_observers.socket.create_connection",
        lambda address, timeout: (calls.append(("connect", address, timeout)) or Raw()),
    )
    _probe_tls(
        "https://127.0.0.1:53128",
        ca,
        hashlib.sha256(peer).hexdigest(),
        "storage.internal",
    )
    assert calls[:2] == [
        ("connect", ("127.0.0.1", 53128), 10),
        ("wrap", calls[1][1], "storage.internal"),
    ]


def test_untrusted_ca_is_rejected_before_connection(tmp_path):
    ca = tmp_path / "untrusted-ca.crt"
    ca.write_text("not a certificate")
    ca.chmod(0o644)
    with pytest.raises(ObserverBlocked):
        _tls_context(ca)


def test_storage_boundary_preserves_http_host_and_sni_identity(tmp_path, monkeypatch):
    run_id = str(uuid4())
    endpoint_value = StorageEndpoint(
        endpoint_url="https://127.0.0.1:53129",
        bucket="pi05-" + run_id,
        access_key="observer",
        secret_key="unit-only-secret",
        ca_file=tmp_path / "ca.crt",
        leaf_sha256="c" * 64,
        run_id=run_id,
        object_prefix="pi05/" + run_id + "/",
    )
    endpoint_value.ca_file.write_text("unit-only placeholder")
    endpoint_value.ca_file.chmod(0o644)
    class Context:
        pass

    monkeypatch.setattr("boundary_observers._tls_context", lambda *_: Context())
    connection = _new_storage_http_connection(endpoint_value)
    assert connection.host == "storage.internal"
    assert connection._tls_server_name == "storage.internal"
    assert connection._connect_host == "127.0.0.1"


def test_storage_head_signs_the_preserved_http_host(tmp_path, monkeypatch):
    run_id = str(uuid4())
    endpoint_value = StorageEndpoint(
        endpoint_url="https://127.0.0.1:53132",
        bucket="pi05-" + run_id,
        access_key="observer",
        secret_key="unit-only-secret",
        ca_file=tmp_path / "ca.crt",
        leaf_sha256="c" * 64,
        run_id=run_id,
        object_prefix="pi05/" + run_id + "/",
    )

    class Response:
        status = 200

        def read(self, _size):
            return b""

        def getheader(self, name, default=None):
            return {"Content-Length": "12", "ETag": '"etag"'}.get(name, default)

        def getheaders(self):
            return [("x-amz-meta-source-media-id", "fixture")]

    class Connection:
        def __init__(self):
            self.headers = None
            self.path = None

        def connect(self):
            pass

        def request(self, method, path, headers):
            assert method == "HEAD"
            self.path = path
            self.headers = headers

        def getresponse(self):
            return Response()

        def close(self):
            pass

    connection = Connection()
    monkeypatch.setattr(
        "boundary_observers._new_storage_http_connection",
        lambda *_: connection,
    )
    result = StorageObserver(endpoint_value, ReceiptWriter(*directories(tmp_path)))._head_object(
        "pi05/" + run_id + "/source.wav"
    )
    assert result["ContentLength"] == 12
    assert connection.headers["Host"] == "storage.internal"
    assert connection.headers["Authorization"].startswith("AWS4-HMAC-SHA256")
    assert connection.path.endswith("/pi05/" + run_id + "/source.wav")


@pytest.mark.parametrize(
    "tls_name,http_host",
    [
        ("localhost", "storage.internal"),
        ("storage.internal", "localhost"),
        ("shared.example", "shared.example"),
    ],
)
def test_storage_rejects_unexpected_tls_or_host_identity(tmp_path, tls_name, http_host):
    run_id = str(uuid4())
    with pytest.raises(ObserverBlocked):
        StorageEndpoint(
            endpoint_url="https://127.0.0.1:53130",
            bucket="pi05-" + run_id,
            access_key="observer",
            secret_key="unit-only-secret",
            ca_file=tmp_path / "ca.crt",
            leaf_sha256="c" * 64,
            run_id=run_id,
            object_prefix="pi05/" + run_id + "/",
            tls_server_name=tls_name,
            http_host=http_host,
        )


def test_rabbit_observer_uses_passive_queue_declaration(tmp_path, monkeypatch):
    proofs, sources = directories(tmp_path)
    endpoint_value = RabbitEndpoint(
        url="amqps://127.0.0.1:53126/sme-integration",
        ca_file=tmp_path / "ca.crt",
        username="observer",
        password="unit-only-secret",
        leaf_sha256="b" * 64,
        queue_name="pi05-" + (run_id := str(uuid4())),
        run_id=run_id,
    )
    endpoint_value.ca_file.write_text("unit-only placeholder")
    endpoint_value.ca_file.chmod(0o644)
    calls = []

    class Queue:
        declaration_result = type("Result", (), {"message_count": 2, "consumer_count": 1})()

    class Channel:
        async def declare_queue(self, name, passive):
            calls.append((name, passive))
            return Queue()

        async def close(self):
            calls.append(("channel-close",))

    class Connection:
        async def channel(self):
            return Channel()

        async def close(self):
            calls.append(("connection-close",))

    monkeypatch.setattr("boundary_observers._probe_tls", lambda *_, **__: None)
    monkeypatch.setattr(
        "boundary_observers._connect_rabbit",
        lambda *_: _async_value(Connection()),
    )
    observer = RabbitMqObserver(endpoint_value, ReceiptWriter(proofs, sources))
    assert observer.probe_queue() == 2
    digest = asyncio.run(
        observer.observe_queue(
            observation(
                "RABBITMQ",
                step="broker-message-delivered",
                result="DELIVERED",
                run_id=run_id,
            )
        )
    )
    source = json.loads((sources / f"{digest}.json").read_bytes())
    assert source["messageCount"] == 2
    assert source["consumerCount"] == 1
    assert calls == [
        (endpoint_value.queue_name, True), ("channel-close",), ("connection-close",),
        (endpoint_value.queue_name, True), ("channel-close",), ("connection-close",),
    ]
    assert endpoint_value.password.encode() not in (sources / f"{digest}.json").read_bytes()


def test_rabbit_client_separates_loopback_destination_from_sni(tmp_path, monkeypatch):
    run_id = str(uuid4())
    endpoint_value = RabbitEndpoint(
        url="amqps://127.0.0.1:53131/sme-integration",
        ca_file=tmp_path / "ca.crt",
        username="observer",
        password="unit-only-secret",
        leaf_sha256="b" * 64,
        queue_name="pi05-" + run_id,
        run_id=run_id,
    )
    endpoint_value.ca_file.write_text("unit-only placeholder")
    endpoint_value.ca_file.chmod(0o644)
    calls = []

    class Connection:
        pass

    async def connect(**kwargs):
        calls.append(kwargs)
        return Connection()

    monkeypatch.setattr("boundary_observers._tls_context", lambda *_: object())
    monkeypatch.setattr("aio_pika.connect", connect)
    result = asyncio.run(_connect_rabbit(endpoint_value))
    assert isinstance(result, Connection)
    assert calls[0]["host"] == "127.0.0.1"
    assert calls[0]["connection_class"].__name__ == "ObserverConnection"


async def _async_value(value):
    return value


def test_storage_observer_heads_only_a_run_scoped_object(tmp_path, monkeypatch):
    proofs, sources = directories(tmp_path)
    run_id = str(uuid4())
    endpoint_value = StorageEndpoint(
        endpoint_url="https://127.0.0.1:53125",
        bucket="pi05-" + run_id,
        access_key="observer",
        secret_key="unit-only-secret",
        ca_file=tmp_path / "ca.crt",
        leaf_sha256="c" * 64,
        run_id=run_id,
        object_prefix="pi05/" + run_id + "/",
    )
    endpoint_value.ca_file.write_text("unit-only placeholder")
    endpoint_value.ca_file.chmod(0o644)
    calls = []

    class Client:
        def head_object(self, **kwargs):
            calls.append(kwargs)
            return {
                "ContentLength": 12,
                "ETag": '"etag"',
                "Metadata": {"source-media-id": "fixture"},
            }

        def close(self):
            calls.append({"closed": True})

    monkeypatch.setattr("boundary_observers._probe_tls", lambda *_: None)
    digest = StorageObserver(
        endpoint_value, ReceiptWriter(proofs, sources), client=Client()
    ).observe_object(
        observation(
            "STORAGE",
            step="source-media-verified",
            result="VERIFIED",
            run_id=run_id,
        ),
        key=endpoint_value.object_prefix + "source.wav",
        expected_metadata={"source-media-id": "fixture"},
    )
    source = json.loads((sources / f"{digest}.json").read_bytes())
    assert calls[0]["Bucket"] == endpoint_value.bucket
    assert calls[0]["Key"].startswith(endpoint_value.object_prefix)
    assert source["contentLength"] == 12
    assert "unit-only-secret" not in (sources / f"{digest}.json").read_text()


def test_storage_observer_rejects_foreign_object_before_client_call(tmp_path):
    proofs, sources = directories(tmp_path)
    run_id = str(uuid4())
    endpoint_value = StorageEndpoint(
        endpoint_url="https://127.0.0.1:53125",
        bucket="pi05-" + run_id,
        access_key="observer",
        secret_key="unit-only-secret",
        ca_file=tmp_path / "ca.crt",
        leaf_sha256="c" * 64,
        run_id=run_id,
        object_prefix="pi05/" + run_id + "/",
    )
    endpoint_value.ca_file.write_text("unit-only placeholder")
    endpoint_value.ca_file.chmod(0o644)
    with pytest.raises(ObserverBlocked):
        StorageObserver(
            endpoint_value, ReceiptWriter(proofs, sources), client=object()
        ).observe_object(
            observation("STORAGE", step="source-media-verified", result="VERIFIED"),
            key="foreign/source.wav",
        )
