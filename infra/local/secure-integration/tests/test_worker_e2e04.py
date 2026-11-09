"""Opt-in Level A Core-to-worker acceptance using only isolated test resources."""

import asyncio
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import secrets
import signal
import socket
import ssl
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import aio_pika
import boto3
import httpx
import pytest
import test_transport_services as transport
import test_worker_infrastructure as worker_infrastructure
from botocore.config import Config
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[4]
AI_ROOT = ROOT / "services" / "ai"
sys.path.insert(0, str(AI_ROOT / "tests/integration"))
import e2e04_worker_process as worker_diagnostics  # noqa: E402

_helper_spec = importlib.util.spec_from_file_location(
    "e2e04_acceptance_helpers", AI_ROOT / "tests/integration/test_worker_live_acceptance.py"
)
_helpers = importlib.util.module_from_spec(_helper_spec)
sys.modules[_helper_spec.name] = _helpers
_helper_spec.loader.exec_module(_helpers)
CoreAdmission = _helpers.CoreAdmission
synthetic_wav = _helpers.synthetic_wav


services = transport.services
storage_boundary = worker_infrastructure.storage_boundary
broker = worker_infrastructure.broker
storage_admin = worker_infrastructure.storage_admin

pytestmark = [pytest.mark.live_infrastructure, pytest.mark.skipif(
    os.environ.get("RUN_WORKER_REAL_ACCEPTANCE") != "1",
    reason="Explicit isolated Level A E2E-04 opt-in is required")]


def _run(command, *, env=None, cwd=None, timeout=120):
    result = subprocess.run(command, env=env, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError("isolated E2E-04 fixture command failed")
    return result.stdout.strip()


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _docker_port(container, port):
    return int(_run(["docker", "port", container, port]).rsplit(":", 1)[1])


def _psql(database, password, sql):
    env = dict(os.environ, PGPASSWORD=password)
    return _run(["docker", "exec", database["name"], "psql", "-U", database["user"],
                 "-d", database["database"], "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], env=env)


@dataclass(frozen=True)
class OutboxWireEvent:
    """The exact wire source retained by Core's authoritative outbox row."""

    body: bytes = field(repr=False)
    message_id: str
    event_id: str
    processing_job_id: str
    event_type: str
    schema_version: int
    headers: tuple[tuple[str, str], ...]
    exchange: str
    routing_key: str
    content_type: str
    delivery_mode: int


def _delivery_mode_number(value):
    value = getattr(value, "value", value)
    if type(value) is not int:
        raise AssertionError("invalid delivery mode")
    return value


def _headers_sha256(headers):
    return worker_diagnostics.headers_sha256(headers)


def _wire_fingerprint(wire, *, message=None):
    body = wire.body if message is None else message.body
    message_id = wire.message_id if message is None else message.message_id
    headers = dict(wire.headers) if message is None else (message.headers or {})
    content_type = wire.content_type if message is None else message.content_type
    delivery_mode = wire.delivery_mode if message is None else _delivery_mode_number(message.delivery_mode)
    try:
        payload = json.loads(body.decode("utf-8"))
        event_id = payload["eventId"]
        processing_job_id = payload["processingJobId"]
        schema_version = payload["schemaVersion"]
    except (UnicodeDecodeError, TypeError, ValueError, KeyError):
        raise AssertionError("invalid durable event wire body") from None
    if (event_id != wire.event_id or message_id != wire.event_id or processing_job_id != wire.processing_job_id
            or schema_version != wire.schema_version
            or headers.get("eventId") != wire.event_id
            or headers.get("eventType") != wire.event_type):
        raise AssertionError("durable event identity is inconsistent")
    return {
        "eventId": event_id,
        "processingJobId": processing_job_id,
        "messageId": message_id,
        "bodySha256": hashlib.sha256(body).hexdigest(),
        "headerEventId": headers.get("eventId"),
        "headerEventType": headers.get("eventType"),
        "publisherListenerId": worker_diagnostics._header_event_id(
            headers.get("spring_listener_return_correlation")),
        "headersSha256": _headers_sha256(headers),
        "headerEvidence": worker_diagnostics.header_evidence(headers),
        "eventType": wire.event_type,
        "schemaVersion": schema_version,
        "exchange": wire.exchange,
        "routingKey": wire.routing_key,
        "contentType": content_type,
        "deliveryMode": delivery_mode,
    }


def _exact_duplicate_message(wire, original):
    source = _wire_fingerprint(wire)
    message = aio_pika.Message(
        wire.body,
        message_id=wire.message_id,
        headers=dict(wire.headers),
        content_type=wire.content_type,
        delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
    )
    duplicate = _wire_fingerprint(wire, message=message)
    _assert_wire_match(source, original, "original event")
    _assert_wire_match(duplicate, original, "duplicate")
    return message


def _header_differences(expected, observed):
    def index(items):
        return {("name", item["name"]) if "name" in item else ("nameSha256", item["nameSha256"]): item
                for item in items}

    left, right = index(expected), index(observed)
    details = []
    for identity in sorted(left.keys() | right.keys()):
        a, b = left.get(identity), right.get(identity)
        excluded = (a or b)["excluded"]
        differs = a != b
        details.append({identity[0]: identity[1], "excluded": excluded, "different": differs,
                        "expected": {"present": a is not None, **(
                            {"type": a["type"], **({"sha256": a["sha256"]} if differs else {})} if a else {})},
                        "observed": {"present": b is not None, **(
                            {"type": b["type"], **({"sha256": b["sha256"]} if differs else {})} if b else {})}})
    return details


def _assert_wire_match(expected, observed, label):
    # Delivery observations include broker/consumer state that is never republished.
    metadata = {"deliveryTag", "channel", "redelivered", "deliveryCount", "headerEvidence"}
    missing = sorted(expected.keys() - observed.keys())
    unexpected = sorted(observed.keys() - expected.keys() - metadata)
    different = sorted(key for key in expected.keys() & observed.keys()
                       if key != "headerEvidence"
                       if type(expected[key]) is not type(observed[key]) or expected[key] != observed[key])
    header_details = _header_differences(expected.get("headerEvidence", []), observed.get("headerEvidence", []))
    if (missing or unexpected or different
            or any(item["different"] and not item["excluded"] for item in header_details)):
        details = []
        for key in different:
            def safe(value):
                kind = type(value).__name__
                digest = hashlib.sha256(str(value).encode("utf-8", errors="backslashreplace")).hexdigest()
                return f"{kind}:sha256={digest}"
            details.append(f"{key}(expected={safe(expected[key])},observed={safe(observed[key])})")
        # Unexpected keys can themselves contain secrets; expose only their digests.
        unknown = [hashlib.sha256(str(key).encode()).hexdigest() for key in unexpected[:20]]
        raise AssertionError(f"{label} wire properties differ: missing={missing[:20]}, "
                             f"unexpected_sha256={unknown}, different={details[:20]}, "
                             f"headers={json.dumps(header_details, sort_keys=True, separators=(',', ':'))}")


def _outbox_wire_event(database, job_id):
    job_id = str(uuid.UUID(str(job_id)))
    raw = _psql(database, database["password"], f"""
        SELECT json_build_object(
            'eventId', id,
            'eventType', event_type,
            'payload', payload::text,
            'status', status
        )
        FROM outbox_events
        WHERE aggregate_id = '{job_id}'::uuid
          AND event_type = 'PROCESSING_JOB_QUEUED'
        ORDER BY occurred_at, id
        LIMIT 1
    """)
    if not raw:
        raise AssertionError("authoritative queued outbox event was not found")
    row = json.loads(raw)
    if row["status"] != "PUBLISHED":
        raise AssertionError("authoritative queued outbox event was not published")
    body = row["payload"].encode("utf-8")
    try:
        payload = json.loads(body.decode("utf-8"))
        event_id = str(uuid.UUID(str(row["eventId"])))
        if payload["eventId"] != event_id or payload["processingJobId"] != job_id:
            raise ValueError
        schema_version = payload["schemaVersion"]
        if type(schema_version) is not int:
            raise ValueError
    except (UnicodeDecodeError, TypeError, ValueError, KeyError):
        raise AssertionError("authoritative queued outbox event has invalid identity") from None
    event_type = row["eventType"]
    return OutboxWireEvent(
        body=body,
        message_id=event_id,
        event_id=event_id,
        processing_job_id=job_id,
        event_type=event_type,
        schema_version=schema_version,
        headers=(("eventId", event_id), ("eventType", event_type)),
        exchange=broker.EXCHANGE,
        routing_key=broker.ROUTE,
        content_type="application/json",
        delivery_mode=2,
    )


def _with_publisher_headers(wire, original):
    # RabbitTemplate uses a per-instance UUID for mandatory-return routing and
    # the CorrelationData event ID for returned-message correlation.
    listener = original.get("publisherListenerId")
    if (type(listener) is not str or listener == "invalid"
            or worker_diagnostics._header_event_id(listener) != listener):
        raise AssertionError("invalid publisher listener identity")
    reconstructed = replace(wire, headers=(*wire.headers,
        ("spring_listener_return_correlation", listener),
        ("spring_returned_message_correlation", wire.event_id)))
    _assert_wire_match(_wire_fingerprint(reconstructed), original, "original event")
    return reconstructed


async def _publish_exact_duplicate(transport_settings, credentials, pki, wire, original):
    message = _exact_duplicate_message(wire, original)
    endpoint = urlsplit(f"amqps://localhost:{transport_settings['broker_port']}/sme-integration")
    context = ssl.create_default_context(cafile=str(pki / "ca.crt"))
    connection = await aio_pika.connect(
        host=endpoint.hostname,
        port=endpoint.port,
        ssl=True,
        ssl_context=context,
        login=credentials.publisher_user,
        password=credentials.publisher_password,
        virtualhost=endpoint.path[1:],
    )
    try:
        channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
        exchange = await channel.get_exchange(wire.exchange, ensure=False)
        confirmation = await exchange.publish(message, wire.routing_key, mandatory=True)
        if confirmation is None:
            raise AssertionError("duplicate publication was not confirmed")
    finally:
        await connection.close()
    return _wire_fingerprint(wire, message=message)


def _log_records(log_path, prefix):
    if not log_path.exists():
        return []
    records = []
    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith(prefix):
            continue
        try:
            record = json.loads(line[len(prefix):])
        except (TypeError, ValueError):
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def _wait_for_log_record(log_path, prefix, predicate, *, timeout=15, interval=0.05):
    deadline = time.monotonic() + timeout
    while True:
        records = _log_records(log_path, prefix)
        for record in records:
            if predicate(record):
                return record
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(f"{prefix} observation timed out")
        time.sleep(min(interval, remaining))


def _wait_for_log_event(log, event, *, timeout=30):
    path = Path(log.name)
    deadline = time.monotonic() + timeout
    marker = '"event":"' + event + '"'
    while time.monotonic() < deadline:
        if marker in path.read_text(encoding="utf-8", errors="replace"):
            return
        time.sleep(0.1)
    raise AssertionError(f"worker log event timed out: {event}")


def _assert_r01_evidence(evidence):
    if any((evidence.get("claimCount") != 1,
            evidence.get("acceptedReceiptCount") != 1,
            evidence.get("failureReceiptCount") != 0,
            evidence.get("receiptCount") != 1,
            evidence.get("canonicalTranscriptCount") != 1,
            evidence.get("transcriptCount") != 1,
            evidence.get("receiptToTranscriptCount") != 1,
            evidence.get("resultCount") != 1,
            evidence.get("generation") != 0,
            evidence.get("contradictoryTerminalCount", 0) != 0)):
        raise AssertionError("R01 durable effect cardinality is inconsistent")
    if any(disposition not in ("TERMINAL", "SUPERSEDED")
           for disposition in evidence.get("reconciliationDispositions", [])):
        raise AssertionError("R01 duplicate reconciliation is not terminal")


@pytest.fixture
def postgres(tmp_path):
    password = secrets.token_urlsafe(24)
    name = "e2e04-postgres-" + uuid.uuid4().hex[:10]
    env = dict(os.environ, POSTGRES_USER="e2e04", POSTGRES_PASSWORD=password, POSTGRES_DB="e2e04")
    database = {"name": name, "user": "e2e04", "password": password, "database": "e2e04"}
    try:
        _run(["docker", "run", "--rm", "-d", "--name", name, "-p", "127.0.0.1::5432",
              "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=512m",
              "-e", "POSTGRES_USER", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB", "postgres:17"], env=env)
        database["port"] = _docker_port(name, "5432/tcp")
        for _ in range(90):
            result = subprocess.run(["docker", "exec", name, "pg_isready", "-U", "e2e04", "-d", "e2e04"],
                                    capture_output=True, timeout=10)
            if result.returncode == 0:
                yield database
                return
            time.sleep(1)
        raise RuntimeError("isolated PostgreSQL did not become ready")
    finally:
        subprocess.run(["docker", "stop", "--time", "5", name], capture_output=True, timeout=20)


def _application_credentials(settings, pki, *, intelligence=False):
    broker_roles = ("publisher", "worker", "reconciler", "intelligence") if intelligence else (
        "publisher", "worker", "reconciler")
    users = {role: "e2e04-" + role + "-" + uuid.uuid4().hex[:8] for role in broker_roles}
    passwords = {role: secrets.token_urlsafe(24) for role in users}
    definitions = broker.definitions("sme-integration", users, intelligence=intelligence)
    salt = secrets.token_bytes(4)
    definitions["users"] = []
    for role, user in users.items():
        digest = base64.b64encode(salt + hashlib.sha256(salt + passwords[role].encode()).digest()).decode()
        definitions["users"].append({"name": user, "password_hash": digest,
                                      "hashing_algorithm": "rabbit_password_hashing_sha256", "tags": []})
    encoded = base64.b64encode(json.dumps(definitions).encode()).decode()
    if broker.cli(settings["names"][0], "eval", f'rabbit_definitions:import_raw(base64:decode(<<"{encoded}">>)).').strip() != "ok":
        raise RuntimeError("isolated RabbitMQ application account provisioning failed")
    broker.verify(broker.inspect(settings["names"][0], "sme-integration"), intelligence=intelligence)

    storage_roles = ("core", "worker", "intelligence") if intelligence else ("core", "worker")
    storage_passwords = {role: secrets.token_urlsafe(24) for role in storage_roles}
    admin = storage_admin.Admin(settings["endpoint"], pki / "ca.crt", "fixture", settings["root_secret"])
    storage_users = {}
    for role in storage_roles:
        user = "e2e04-" + role + "-" + uuid.uuid4().hex[:8]
        admin.provision(settings["bucket"], role, user, storage_passwords[role])
        storage_users[role] = user
    return SimpleNamespace(
        publisher_user=users["publisher"], publisher_password=passwords["publisher"],
        worker_user=users["worker"], worker_password=passwords["worker"],
        reconciler_user=users["reconciler"], reconciler_password=passwords["reconciler"],
        storage_core_user=storage_users["core"], storage_core_password=storage_passwords["core"],
        storage_worker_user=storage_users["worker"], storage_worker_password=storage_passwords["worker"],
        intelligence_user=users.get("intelligence"), intelligence_password=passwords.get("intelligence"),
        storage_intelligence_user=storage_users.get("intelligence"),
        storage_intelligence_password=storage_passwords.get("intelligence"),
    )


def _make_jwt_keys(directory):
    private = directory / "jwt-private.pem"
    public = directory / "jwt-public.pem"
    _run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048",
          "-out", str(private)], timeout=60)
    _run(["openssl", "rsa", "-in", str(private), "-pubout", "-out", str(public)], timeout=60)
    private.chmod(0o600)
    public.chmod(0o644)
    return private, public


def _make_mi_certificate(pki):
    """Create only the fixture-owned mi-worker leaf; never touches an external CA."""
    key = pki / "mi-worker.key"
    csr = pki / "mi-worker.csr"
    cert = pki / "mi-worker.crt"
    extension = pki / "mi-worker.ext"
    extension.write_text(
        "basicConstraints=critical,CA:FALSE\n"
        "extendedKeyUsage=clientAuth\n"
        "subjectAltName=URI:urn:sme:service:mi-worker\n"
    )
    subprocess.run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
                    "-subj", "/CN=mi-worker", "-keyout", str(key), "-out", str(csr)],
                   check=True, capture_output=True, timeout=60)
    subprocess.run(["openssl", "x509", "-req", "-in", str(csr), "-CA", str(pki / "ca.crt"),
                    "-CAkey", str(pki / "ca.key"), "-CAcreateserial", "-days", "1",
                    "-extfile", str(extension), "-out", str(cert)],
                   check=True, capture_output=True, timeout=60)
    key.chmod(0o600)
    cert.chmod(0o644)
    return cert, key


def _clean_core_environment():
    env = dict(os.environ)
    prefixes = ("APP_", "DB_", "RABBITMQ_", "SERVER_", "SPRING_")
    for name in tuple(env):
        if name.startswith(prefixes) or name == "JAVA_TOOL_OPTIONS":
            env.pop(name)
    return env


def _tls_client(pki, *, certificate="core-api", ca="ca"):
    context = ssl.create_default_context(cafile=str(pki / f"{ca}.crt"))
    if certificate:
        context.load_cert_chain(pki / f"{certificate}.crt", pki / f"{certificate}.key")
    return httpx.Client(verify=context, trust_env=False, timeout=3)


@contextmanager
def _ai_process(tmp_path, pki):
    port = _free_port()
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("AI_") and key != "OPENROUTER_API_KEY"}
    env.update(AI_SERVICE_NAME="e2e04-ai-core", AI_SERVICE_IDENTITY="ai-core", AI_ENVIRONMENT="test",
               AI_INTERNAL_ALLOWED_CALLERS='["core-api"]', AI_HTTP_HOST="127.0.0.1", AI_HTTP_PORT=str(port),
               AI_TLS_CERT_FILE=str(pki / "ai-server.crt"), AI_TLS_KEY_FILE=str(pki / "ai-server.key"),
               AI_TLS_CLIENT_CA_FILE=str(pki / "ca.crt"))
    url = f"https://localhost:{port}"
    log_path = tmp_path / "ai-core.log"
    with log_path.open("w") as log:
        process = subprocess.Popen([sys.executable, "-m", "sme_meeting_ai.api"], cwd=tmp_path, env=env,
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            with _tls_client(pki) as client:
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError(f"AI Core startup failed: exit={process.returncode}; log={log_path}")
                    try:
                        response = client.get(url + "/health/ready")
                        if response.status_code == 200 and response.json() == {"status": "ready"}:
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(0.1)
                else:
                    raise RuntimeError(f"AI Core readiness timed out; log={log_path}")
            # Health requires a trusted client certificate, but intentionally no
            # application-operation grant. Do not invent one for this probe.
            for certificate, ca, target in ((None, "ca", url), ("rogue", "ca", url),
                                             ("core-api", "rogue-ca", url),
                                             ("core-api", "ca", url.replace("localhost", "127.0.0.1"))):
                with _tls_client(pki, certificate=certificate, ca=ca) as client:
                    with pytest.raises(httpx.TransportError):
                        client.get(target + "/health/ready")
            print("E2E04_BOOTSTRAP real_fastapi=ready mtls_negatives=passed")
            yield url
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


@contextmanager
def _core_process(tmp_path, database, transport_settings, credentials, pki, ai_url,
                  *, extra_environment=None):
    public_port = _free_port()
    private_port = _free_port()
    jwt_private, jwt_public = _make_jwt_keys(tmp_path)
    setup_key = base64.b64encode(secrets.token_bytes(32)).decode()
    csrf_key = base64.b64encode(secrets.token_bytes(32)).decode()
    abuse_key = base64.b64encode(secrets.token_bytes(32)).decode()
    env = _clean_core_environment()
    env.update({
        "SPRING_PROFILES_ACTIVE": "secure-integration",
        "SERVER_ADDRESS": "127.0.0.1",
        "SERVER_PORT": str(public_port),
        "APP_ENVIRONMENT": "test",
        "APP_HTTP_SECURITY_CORS_ALLOWED_ORIGINS": f"http://127.0.0.1:{public_port}",
        "DB_URL": f"jdbc:postgresql://127.0.0.1:{database['port']}/{database['database']}",
        "DB_USERNAME": database["user"],
        "DB_PASSWORD": database["password"],
        "RABBITMQ_HOST": "localhost",
        "RABBITMQ_PORT": str(transport_settings["broker_port"]),
        "RABBITMQ_VIRTUAL_HOST": "sme-integration",
        "RABBITMQ_USERNAME": credentials.publisher_user,
        "RABBITMQ_PASSWORD": credentials.publisher_password,
        "RABBITMQ_CA_FILE": str(pki / "ca.crt"),
        "RABBITMQ_RECONCILER_USERNAME": credentials.reconciler_user,
        "RABBITMQ_RECONCILER_PASSWORD": credentials.reconciler_password,
        "APP_MEDIA_STORAGE_ENDPOINT": transport_settings["endpoint"],
        "APP_MEDIA_STORAGE_REGION": "us-east-1",
        "APP_MEDIA_STORAGE_BUCKET": transport_settings["bucket"],
        "APP_MEDIA_STORAGE_ACCESS_KEY": credentials.storage_core_user,
        "APP_MEDIA_STORAGE_SECRET_KEY": credentials.storage_core_password,
        "APP_MEDIA_STORAGE_PATH_STYLE_ACCESS": "true",
        "APP_MEDIA_STORAGE_CREATE_BUCKET_IF_MISSING": "false",
        "APP_MEDIA_STORAGE_CA_FILE": str(pki / "ca.crt"),
        "APP_MEDIA_UPLOAD_ALLOWED_EXTENSIONS": "wav",
        "APP_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES": "audio/wav",
        "APP_MEDIA_UPLOAD_MAX_SIZE_BYTES": "8388608",
        "APP_MEDIA_UPLOAD_MAX_DURATION_MS": "60000",
        "APP_MEDIA_OUTBOX_ENABLED": "true",
        "APP_MEDIA_OUTBOX_POLL_DELAY_MS": "100",
        "APP_MEDIA_OUTBOX_LEASE_SECONDS": "60",
        "APP_MEDIA_OUTBOX_CONFIRM_TIMEOUT_SECONDS": "5",
        "APP_MEDIA_OUTBOX_MAX_ATTEMPTS": "5",
        "APP_MEDIA_PROCESSING_STAGE_LEASE_SECONDS": "120",
        "APP_MEDIA_PROCESSING_MAX_RETRIES": "0",
        "APP_MEDIA_MESSAGING_TOPOLOGY": "external-quorum",
        "APP_WORKER_TRANSCRIPTION_ENABLED": "true",
        "APP_WORKER_TRANSCRIPTION_STORAGE_ID": "private",
        "APP_WORKER_TRANSCRIPTION_INFRASTRUCTURE_VERIFIED": "true",
        "APP_WORKER_DEAD_LETTER_ENABLED": "true",
        "APP_TRANSPORT_PRIVATE_ENABLED": "true",
        "APP_TRANSPORT_PRIVATE_ADDRESS": "127.0.0.1",
        "APP_TRANSPORT_PRIVATE_PORT": str(private_port),
        "APP_TRANSPORT_PRIVATE_HOSTNAME": "localhost",
        "APP_TRANSPORT_PRIVATE_CERTIFICATE": str(pki / "server.crt"),
        "APP_TRANSPORT_PRIVATE_KEY": str(pki / "server.key"),
        "APP_TRANSPORT_PRIVATE_ISSUER_CA": str(pki / "ca.crt"),
        "APP_TRANSPORT_PRIVATE_CLIENT_CA": str(pki / "ca.crt"),
        "APP_TRANSPORT_AI_ENABLED": "true",
        "APP_TRANSPORT_AI_PROBE": "true",
        "APP_TRANSPORT_AI_BASE_URL": ai_url,
        "APP_TRANSPORT_AI_SERVER_CA": str(pki / "ca.crt"),
        "APP_TRANSPORT_AI_ISSUER_CA": str(pki / "ca.crt"),
        "APP_TRANSPORT_AI_CERTIFICATE": str(pki / "core-api.crt"),
        "APP_TRANSPORT_AI_KEY": str(pki / "core-api.key"),
        "APP_AUTH_TRANSPORT_ENABLED": "true",
        "APP_AUTH_JWT_PRIVATE_KEY_LOCATION": "file:" + str(jwt_private),
        "APP_AUTH_JWT_PUBLIC_KEY_LOCATION": "file:" + str(jwt_public),
        "APP_AUTH_JWT_KEY_ID": "e2e04",
        "APP_AUTH_JWT_ISSUER": "e2e04-core",
        "APP_AUTH_JWT_AUDIENCE": "e2e04-client",
        "APP_ACCOUNT_SETUP_SIGNING_KEY": setup_key,
        "APP_ACCOUNT_SETUP_WORKER_ENABLED": "false",
        "APP_ACCOUNT_SETUP_SENDER": "e2e04@example.invalid",
        "APP_EMAIL_DELIVERY_WORKER_ENABLED": "false",
        "APP_EMAIL_DELIVERY_SENDER": "e2e04@example.invalid",
        "APP_AUTH_CSRF_SIGNING_KEY": csrf_key,
        "APP_AUTH_ABUSE_HASHING_KEY": abuse_key,
        "SPRING_MAIL_HOST": "127.0.0.1",
    })
    if extra_environment:
        env.update(extra_environment)
    log_path = tmp_path / "core.log"
    process = None
    with log_path.open("w", encoding="utf-8") as log:
        try:
            process = subprocess.Popen(["mvn", "-q", "-DskipTests", "spring-boot:run"], cwd=ROOT / "services/api",
                                       env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            health_url = f"http://127.0.0.1:{public_port}/actuator/health/readiness"
            for _ in range(240):
                if process.poll() is not None:
                    raise RuntimeError(f"Core startup failed: exit={process.returncode}; log={log_path}")
                try:
                    response = httpx.get(health_url, trust_env=False, timeout=2)
                    if (response.status_code == 200
                            and "PASS core-api-to-ai readiness (Java mTLS)" in log_path.read_text()):
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(1)
            else:
                raise RuntimeError("isolated Core did not become ready")
            path = f"/internal/v1/worker/processing-jobs/{uuid.uuid4()}/transcription/deliveries/{uuid.uuid4()}"
            with _tls_client(pki, certificate="core-api") as client:
                assert client.get(f"https://localhost:{private_port}" + path).status_code == 403
            with _tls_client(pki, certificate="ai-worker") as client:
                assert client.get(f"https://localhost:{private_port}" + path,
                                  headers={"X-Request-Id": "e2e04-boundary"}).status_code == 404
            assert httpx.get(f"http://127.0.0.1:{public_port}" + path, trust_env=False).status_code == 403
            print("E2E04_BOOTSTRAP real_core=ready java_ai_mtls=passed private_boundary=passed")
            yield SimpleNamespace(public_url=f"http://127.0.0.1:{public_port}", private_port=private_port,
                                  setup_key=setup_key, process=process, environment=env)
        finally:
            if process is not None and process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=20)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


def _seed_user(database, core):
    user_id = uuid.uuid4()
    token_id = uuid.uuid4()
    email = f"e2e04-{user_id.hex}@example.invalid"
    password = "E2e04-isolated-password-2026!"
    key = base64.b64decode(core.setup_key)
    signature = hmac.new(key, f"sme-account-setup-v1:{token_id}".encode(), hashlib.sha256).digest()
    token = f"{token_id}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    sql = (
        "INSERT INTO users(id,email,email_normalized,display_name,global_role,account_status) "
        f"VALUES ('{user_id}','{email}','{email.lower()}','E2E-04 Fixture','EMPLOYEE','PENDING_SETUP'); "
        "INSERT INTO account_setup_tokens(id,user_id,token_hash,requested_at,expires_at) "
        f"VALUES ('{token_id}','{user_id}','{token_hash}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '24 hours');"
    )
    _psql(database, database["password"], sql)
    response = httpx.post(core.public_url + "/api/v1/auth/account-setup", trust_env=False, timeout=20,
                          json={"token": token, "password": password})
    if not response.is_success or response.json().get("success") is not True:
        raise RuntimeError("isolated Core account setup failed")
    return email, password


def _worker_environment(tmp_path, database, transport_settings, credentials, core, pki,
                        *, control_environment=None, worker_concurrency=1,
                        intelligence=None):
    worker_temp = tmp_path / ("worker-temp-" + uuid.uuid4().hex[:10])
    worker_temp.mkdir(mode=0o700)
    env = dict(os.environ)
    for name in tuple(env):
        if name.startswith("AI_") or name == "OPENROUTER_API_KEY":
            env.pop(name)
    env.update({
        "AI_SERVICE_NAME": "e2e04-ai-worker",
        "AI_SERVICE_IDENTITY": "ai-worker",
        "AI_ENVIRONMENT": "test",
        "AI_LOG_LEVEL": "INFO",
        "AI_WORKER_SHUTDOWN_TIMEOUT_SECONDS": "10",
        "AI_CORE_API_BASE_URL": f"https://localhost:{core.private_port}",
        "AI_CORE_API_SERVER_CA_FILE": str(pki / "ca.crt"),
        "AI_CORE_API_CLIENT_CERT_FILE": str(pki / "ai-worker.crt"),
        "AI_CORE_API_CLIENT_KEY_FILE": str(pki / "ai-worker.key"),
        "AI_RABBITMQ_URL": f"amqps://localhost:{transport_settings['broker_port']}/sme-integration",
        "AI_RABBITMQ_USERNAME": credentials.worker_user,
        "AI_RABBITMQ_PASSWORD": credentials.worker_password,
        "AI_RABBITMQ_CA_FILE": str(pki / "ca.crt"),
        "AI_S3_ENDPOINT_URL": transport_settings["endpoint"],
        "AI_S3_STORAGE_ID": "private",
        "AI_S3_BUCKET": transport_settings["bucket"],
        "AI_S3_ACCESS_KEY_ID": credentials.storage_worker_user,
        "AI_S3_SECRET_ACCESS_KEY": credentials.storage_worker_password,
        "AI_S3_CA_FILE": str(pki / "ca.crt"),
        "AI_AUDIO_TEMP_DIR": str(worker_temp),
    })
    if worker_concurrency != 1:
        env["AI_WORKER_CONCURRENCY"] = str(worker_concurrency)
    if control_environment:
        env.update(control_environment)
    if intelligence:
        env.update({
            "AI_MEETING_INTELLIGENCE_WORKER_ENABLED": "true",
            "AI_MEETING_INTELLIGENCE_WORKER_CONCURRENCY": "1",
            "AI_MEETING_INTELLIGENCE_WORKER_EXECUTION_TIMEOUT_SECONDS": "120",
            "AI_MEETING_INTELLIGENCE_ACCEPTANCE_TOKEN": intelligence["acceptance_token"],
            "AI_MEETING_INTELLIGENCE_S3_ACCESS_KEY_ID": credentials.storage_intelligence_user,
            "AI_MEETING_INTELLIGENCE_S3_SECRET_ACCESS_KEY": credentials.storage_intelligence_password,
            "AI_MEETING_INTELLIGENCE_RABBITMQ_USERNAME": credentials.intelligence_user,
            "AI_MEETING_INTELLIGENCE_RABBITMQ_PASSWORD": credentials.intelligence_password,
            "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_CERT_FILE": str(intelligence["certificate"]),
            "AI_MEETING_INTELLIGENCE_CORE_API_CLIENT_KEY_FILE": str(intelligence["key"]),
        })
    return env


def _start_worker(tmp_path, database, transport_settings, credentials, core, pki,
                  *, control_environment=None, worker_concurrency=1):
    log_path = tmp_path / "worker.log"
    log = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen([sys.executable, "tests/integration/e2e04_worker_process.py"], cwd=AI_ROOT,
                               env=_worker_environment(
                                   tmp_path, database, transport_settings, credentials, core, pki,
                                   control_environment=control_environment,
                                   worker_concurrency=worker_concurrency),
                               stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        for _ in range(60):
            if process.poll() is not None:
                raise RuntimeError("isolated worker stopped before consuming")
            if "worker.transcription.consuming" in log_path.read_text(encoding="utf-8", errors="replace"):
                return process, log
            time.sleep(0.5)
        raise RuntimeError("isolated worker did not reach consuming state")
    except Exception:
        log.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=20)
        raise


def _start_intelligence_worker(tmp_path, database, transport_settings, credentials, core, pki,
                               intelligence, *, delay_seconds=0, control_environment=None):
    log_path = tmp_path / "intelligence-worker.log"
    log = log_path.open("w", encoding="utf-8")
    env = _worker_environment(tmp_path, database, transport_settings, credentials, core, pki,
                              intelligence=intelligence, control_environment=control_environment)
    env["AI_MI_TEST_PROCESSOR_DELAY_SECONDS"] = str(delay_seconds)
    process = subprocess.Popen([sys.executable, "tests/integration/intelligence_worker_process.py"],
                               cwd=AI_ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                               start_new_session=True)
    try:
        for _ in range(120):
            if process.poll() is not None:
                raise RuntimeError("isolated intelligence worker stopped before consuming")
            text = log_path.read_text(encoding="utf-8", errors="replace")
            if "worker.intelligence.consuming" in text and "worker.transcription.consuming" in text:
                return process, log
            time.sleep(0.5)
        raise RuntimeError("isolated intelligence worker did not reach consuming state")
    except Exception:
        log.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=20)
        raise


def _stop_worker(process, log):
    try:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=20)
        if process.returncode != 0:
            raise AssertionError("Worker process failed during isolated acceptance")
    finally:
        log.close()


def _kill_worker(process, log):
    try:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=20)
    finally:
        log.close()


def _request_worker_shutdown(process, log):
    try:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=20)
        return process.returncode
    finally:
        log.close()


def _intelligence_wire(database, job_id):
    raw = _psql(database, database["password"], f"""
        SELECT json_build_object('eventId',id,'eventType',event_type,'payload',payload::text,'status',status)
        FROM outbox_events
        WHERE aggregate_id='{job_id}'::uuid AND event_type='PROCESSING_INTELLIGENCE_STAGE_REQUESTED'
        ORDER BY occurred_at,id LIMIT 1
    """)
    if not raw:
        raise AssertionError("authoritative intelligence outbox event was not found")
    row = json.loads(raw)
    if row["status"] != "PUBLISHED":
        raise AssertionError("intelligence outbox event was not published")
    payload = json.loads(row["payload"])
    if payload.get("eventId") != row["eventId"] or payload.get("processingJobId") != str(job_id):
        raise AssertionError("intelligence outbox identity is inconsistent")
    return row["eventId"], row["eventType"], row["payload"].encode()


async def _publish_intelligence_duplicate(settings, credentials, event_id, event_type, body):
    context = ssl.create_default_context(cafile=str(settings["pki"] / "ca.crt"))
    connection = await aio_pika.connect(host="localhost", port=settings["broker_port"], ssl=True,
        ssl_context=context, login=credentials.publisher_user, password=credentials.publisher_password,
        virtualhost="sme-integration")
    try:
        channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
        exchange = await channel.get_exchange(broker.EXCHANGE, ensure=False)
        message = aio_pika.Message(body, message_id=event_id,
            headers={"eventId": event_id, "eventType": event_type, "eventSchemaVersion": 1},
            content_type="application/json", delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
        confirmation = await exchange.publish(message, broker.INTELLIGENCE_ROUTE, mandatory=True)
        if confirmation is None:
            raise AssertionError("duplicate intelligence publication was not confirmed")
    finally:
        await connection.close()


def _assert_intelligence_settled(container, *, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        queues = broker.inspect(container, "sme-integration")
        work = next(q for q in queues if q["name"] == broker.INTELLIGENCE_WORK)
        dead = next(q for q in queues if q["name"] == broker.INTELLIGENCE_DEAD)
        if all(work[field] == 0 for field in ("messages", "messages_ready", "messages_unacknowledged")) \
                and dead["messages"] == 0:
            return
        time.sleep(0.25)
    raise AssertionError("intelligence broker delivery did not settle")


def _intelligence_evidence(database, job_id):
    raw = _psql(database, database["password"], f"""
        SELECT json_build_object(
            'dispatchCount',(SELECT count(*) FROM processing_intelligence_dispatches WHERE processing_job_id='{job_id}'::uuid),
            'claimCount',(SELECT count(*) FROM processing_intelligence_claims WHERE processing_job_id='{job_id}'::uuid),
            'receiptCount',(SELECT count(*) FROM meeting_intelligence_result_receipts WHERE processing_job_id='{job_id}'::uuid),
            'acceptedCount',(SELECT count(*) FROM meeting_intelligence_result_receipts WHERE processing_job_id='{job_id}'::uuid),
            'stageRunId',(SELECT id FROM processing_stage_runs WHERE processing_job_id='{job_id}'::uuid AND stage_code='GENERATING_SUMMARY' ORDER BY attempt_number DESC LIMIT 1),
            'resultSha256',(SELECT artifact_sha256 FROM meeting_intelligence_result_receipts WHERE processing_job_id='{job_id}'::uuid LIMIT 1),
            'sourceSha256',(SELECT sha256 FROM meeting_intelligence_source_snapshots WHERE processing_job_id='{job_id}'::uuid LIMIT 1),
            'sourceObjectKey',(SELECT object_key FROM meeting_intelligence_source_snapshots WHERE processing_job_id='{job_id}'::uuid LIMIT 1),
            'outboxStatus',(SELECT status FROM outbox_events WHERE aggregate_id='{job_id}'::uuid AND event_type='PROCESSING_INTELLIGENCE_STAGE_REQUESTED' LIMIT 1),
            'stageStatus',(SELECT status FROM processing_stage_runs WHERE processing_job_id='{job_id}'::uuid AND stage_code='GENERATING_SUMMARY' ORDER BY attempt_number DESC LIMIT 1)
        )
    """)
    if not raw:
        raise AssertionError("Core intelligence evidence was not found")
    return json.loads(raw)


def _wait_for_sql(database, sql, expected, *, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = _psql(database, database["password"], sql)
        if expected(value):
            return value
        time.sleep(0.25)
    raise AssertionError("isolated Core SQL condition timed out")


def _wait_for_intelligence_dispatch(database, job_id, *, timeout=90):
    raw = _wait_for_sql(database, f"""
        SELECT json_build_object('eventId',event_id,'stageRunId',stage_run_id)
        FROM processing_intelligence_dispatches
        WHERE processing_job_id='{job_id}'::uuid
        ORDER BY created_at, event_id LIMIT 1
    """, bool, timeout=timeout)
    return json.loads(raw)


def _wait_for_intelligence_broker(container, predicate, *, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        queues = broker.inspect(container, "sme-integration")
        work = next(q for q in queues if q["name"] == broker.INTELLIGENCE_WORK)
        dead = next(q for q in queues if q["name"] == broker.INTELLIGENCE_DEAD)
        last = {field: work[field] for field in
                ("messages", "messages_ready", "messages_unacknowledged", "consumers")}
        last["dead_messages"] = dead["messages"]
        if predicate(work, dead):
            return work, dead
        time.sleep(0.25)
    raise AssertionError(f"intelligence broker condition timed out: {last}")


def _admit_intelligence_job(core, pki, email, password):
    async def admit():
        admission = CoreAdmission(SimpleNamespace(s3_ca_file=pki / "ca.crt"),
                                  public_url=core.public_url, email=email, password=password)
        try:
            return await admission.admit(synthetic_wav())
        finally:
            await admission.close()

    return asyncio.run(admit())


def _workload_storage(settings, user, password):
    return boto3.client(
        "s3", endpoint_url=settings["endpoint"], verify=str(settings["pki"] / "ca.crt"),
        aws_access_key_id=user, aws_secret_access_key=password, region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}, retries={"total_max_attempts": 1}),
    )


def _assert_intelligence_artifact(settings, credentials, evidence, job_id):
    key = f"processing/{job_id}/intelligence/results/{evidence['stageRunId']}.json"
    client = _workload_storage(settings, credentials.storage_intelligence_user,
                               credentials.storage_intelligence_password)
    try:
        source = client.get_object(Bucket=settings["bucket"], Key=evidence["sourceObjectKey"])
        source_raw = source["Body"].read()
        assert hashlib.sha256(source_raw).hexdigest() == evidence["sourceSha256"]
        response = client.get_object(Bucket=settings["bucket"], Key=key)
        raw = response["Body"].read()
        assert hashlib.sha256(raw).hexdigest() == evidence["resultSha256"]
        payload = json.loads(raw)
        assert payload["processingJobId"] == str(job_id)
        assert payload["stageRunId"] == evidence["stageRunId"]
        assert payload["resultType"] == "SUMMARY"
        assert payload["source"]["sha256"] == evidence["sourceSha256"]
    finally:
        client.close()


def _assert_intelligence_result_missing(settings, credentials, job_id, stage_run_id):
    key = f"processing/{job_id}/intelligence/results/{stage_run_id}.json"
    client = _workload_storage(settings, credentials.storage_intelligence_user,
                               credentials.storage_intelligence_password)
    try:
        with pytest.raises(ClientError) as error:
            client.get_object(Bucket=settings["bucket"], Key=key)
        assert error.value.response["ResponseMetadata"]["HTTPStatusCode"] == 404
    finally:
        client.close()


@contextmanager
def _real_intelligence_context(services_fixture, storage_fixture, postgres, tmp_path, *, extra=None):
    service_settings, pki, names = services_fixture
    boundary_settings, boundary_pki, topology = storage_fixture
    assert pki == boundary_pki and topology["backend"]
    transport_settings = {
        "broker_port": _docker_port(names[0], "5671/tcp"),
        "endpoint": boundary_settings.s3_endpoint_url,
        "bucket": boundary_settings.s3_bucket,
        "names": names,
        "root_secret": service_settings.s3_secret_access_key.get_secret_value(),
        "pki": pki,
    }
    credentials = _application_credentials(transport_settings, pki, intelligence=True)
    mi_certificate, mi_key = _make_mi_certificate(pki)
    acceptance_token = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    intelligence = {"certificate": mi_certificate, "key": mi_key, "acceptance_token": acceptance_token}
    core_environment = {
        "APP_MEDIA_INTELLIGENCE_ENABLED": "true",
        "APP_MEDIA_INTELLIGENCE_DISPATCH_ENABLED": "true",
        "APP_MEDIA_INTELLIGENCE_INFRASTRUCTURE_VERIFIED": "true",
        "APP_MEDIA_INTELLIGENCE_STORAGE_ID": "private",
        "APP_MEDIA_INTELLIGENCE_ENABLED_STAGES": "GENERATING_SUMMARY",
        "APP_MEDIA_PROCESSING_REQUIRED_DOWNSTREAM_STAGES": "GENERATING_SUMMARY",
        "APP_MI_INTERNAL_RESULT_ENABLED": "true",
        "APP_MI_INTERNAL_RESULT_TOKEN": acceptance_token,
    }
    if extra:
        core_environment.update(extra)
    with _ai_process(tmp_path, pki) as ai_url, _core_process(
            tmp_path, postgres, transport_settings, credentials, pki, ai_url,
            extra_environment=core_environment) as core:
        yield SimpleNamespace(
            core=core, pki=pki, names=names, transport=transport_settings,
            credentials=credentials, intelligence=intelligence,
        )


def _evidence(database, job_id):
    sql = f"""
        SELECT json_build_object(
            'eventId', d.event_id,
            'claimStageRunId', c.execution_stage_run_id,
            'producerStageRunId', r.producer_stage_run_id,
            'resultSha256', v.result_sha256,
            'correctionSha256', v.correction_sha256,
            'sourceSha256', m.sha256,
            'sourceRevision', v.source_revision,
            'generation', d.generation,
            'receiptCount', (SELECT count(*) FROM transcription_worker_receipts WHERE processing_job_id=d.processing_job_id),
            'transcriptCount', (SELECT count(*) FROM transcripts WHERE processing_job_id=d.processing_job_id),
            'receiptId', r.receipt_id,
            'transcriptId', r.transcript_id,
            'outcome', r.outcome,
            'transcriptStatus', r.transcript_status,
            'outboxStatus', o.status,
            'stages', (SELECT json_agg(json_build_object('id', s.id, 'code', s.stage_code, 'status', s.status)
                         ORDER BY s.created_at, s.id)
                       FROM processing_stage_runs s WHERE s.processing_job_id = d.processing_job_id)
        )
        FROM transcription_worker_deliveries d
        JOIN transcription_worker_claims c ON c.event_id = d.event_id
        JOIN transcription_worker_receipts r ON r.event_id = d.event_id
        JOIN transcription_worker_results v ON v.producer_stage_run_id = r.producer_stage_run_id
        JOIN outbox_events o ON o.id = d.event_id
        JOIN meeting_media m ON m.id=d.source_media_id
        WHERE d.processing_job_id = '{job_id}'
    """
    raw = _psql(database, database["password"], sql)
    if not raw:
        raise AssertionError("Core durable Worker V1 evidence was not found")
    return json.loads(raw)


def _consumer_metadata(container, credentials):
    """Identify work consumers without printing connection addresses or credentials."""
    try:
        consumers = json.loads(broker.cli(container, "list_consumers", "-p", "sme-integration",
                                          "queue_name", "channel_pid", "--formatter=json"))
        channels = json.loads(broker.cli(container, "list_channels", "pid", "connection", "user",
                                         "--formatter=json"))
        by_pid = {str(channel["pid"]): channel for channel in channels}
        roles = {getattr(credentials, role + "_user"): role for role in
                 ("worker", "publisher", "reconciler")} if credentials else {}
        result = []
        for consumer in consumers:
            if consumer["queue_name"] != broker.WORK:
                continue
            channel = by_pid.get(str(consumer["channel_pid"]), {})
            connection = channel.get("connection")
            result.append({"channel": hashlib.sha256(str(consumer["channel_pid"]).encode()).hexdigest()[:12],
                           "connection": hashlib.sha256(str(connection).encode()).hexdigest()[:12]
                           if connection is not None else "unknown",
                           "workload": roles.get(channel.get("user"), "unknown")})
        return json.dumps(result)
    except Exception:
        return "consumer metadata unavailable"


def _assert_acknowledged(container, credentials=None, *, timeout=5, interval=0.5):
    deadline = time.monotonic() + timeout
    while True:
        try:
            queues = broker.inspect(container, "sme-integration")
            work = next(queue for queue in queues if queue["name"] == broker.WORK)
            dead = next(queue for queue in queues if queue["name"] == broker.DEAD)
            state = {field: work[field] for field in ("messages", "messages_ready", "messages_unacknowledged",
                                                       "consumers", "retained_dead_letters")}
            state["dead_messages"] = dead["messages"]
            if any(type(value) is not int or value < 0 for value in state.values()):
                raise ValueError("invalid broker counters")
        except Exception:
            raise AssertionError("broker inspection failed (details suppressed)") from None
        if all(value == 0 for value in state.values()):
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            metadata = _consumer_metadata(container, credentials) if state["consumers"] else "not applicable"
            raise AssertionError(f"broker settlement timed out: {state}; work consumers={metadata}")
        time.sleep(min(interval, remaining))


def _assert_original_ack(log_path, evidence):
    events = [json.loads(line.removeprefix("E2E04_ACK ")) for line in
              log_path.read_text(encoding="utf-8").splitlines() if line.startswith("E2E04_ACK ")]
    matching = [item for item in events if item["eventId"] == evidence["eventId"]]
    assert [item["operation"] for item in matching] == ["invoked", "client_completed"]
    for item in matching:
        assert item["terminal"] == {"state": "RESULT_ACCEPTED", "receiptId": evidence["receiptId"]}
        assert isinstance(item["deliveryTag"], int) and item["deliveryTag"] > 0
        assert item["redelivered"] is False
    assert matching[0]["deliveryTag"] == matching[1]["deliveryTag"]
    assert matching[0]["channel"] == matching[1]["channel"]
    return matching[0]


def _assert_result_storage(settings, job_id, evidence, credentials):
    # Administrative access is used only to provision a separate synthetic source.
    root = worker_infrastructure.storage_client(settings)
    def workload(user, password):
        return boto3.client("s3", endpoint_url=settings.s3_endpoint_url, verify=str(settings.s3_ca_file),
                            aws_access_key_id=user, aws_secret_access_key=password, region_name="us-east-1",
                            config=Config(s3={"addressing_style": "path"}, retries={"total_max_attempts": 1}))
    client = workload(credentials.storage_worker_user, credentials.storage_worker_password)
    core = workload(credentials.storage_core_user, credentials.storage_core_password)
    key = f"processing/{job_id}/transcription/results/{evidence['producerStageRunId']}.json"
    source = f"meetings/{uuid.uuid4()}/sources/e2e04-permission-fixture"
    created = f"processing/{job_id}/transcription/results/{uuid.uuid4()}.json"
    copy_target = f"processing/{job_id}/transcription/results/{uuid.uuid4()}.json"
    multipart = f"processing/{job_id}/transcription/results/{uuid.uuid4()}.json"
    try:
        root.put_object(Bucket=settings.s3_bucket, Key=source, Body=b"synthetic source")
        assert client.get_object(Bucket=settings.s3_bucket, Key=source)["Body"].read() == b"synthetic source"
        client.put_object(Bucket=settings.s3_bucket, Key=created, Body=b"synthetic result", IfNoneMatch="*")
        assert client.get_object(Bucket=settings.s3_bucket, Key=created)["Body"].read() == b"synthetic result"
        assert core.get_object(Bucket=settings.s3_bucket, Key=created)["Body"].read() == b"synthetic result"
        body = client.get_object(Bucket=settings.s3_bucket, Key=key)["Body"]
        try:
            raw = body.read()
        finally:
            body.close()
        if evidence.get("sourceObjectKey"):
            source_body = client.get_object(
                Bucket=settings.s3_bucket, Key=evidence["sourceObjectKey"])["Body"]
            try:
                source_raw = source_body.read()
            finally:
                source_body.close()
            assert hashlib.sha256(source_raw).hexdigest() == evidence["sourceSha256"]
        assert hashlib.sha256(raw).hexdigest() == evidence["resultSha256"]
        assert core.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read() == raw
        result = json.loads(raw)
        assert result["processingJobId"] == job_id
        assert result["producerStageRunId"] == evidence["producerStageRunId"]
        assert result["sourceRevision"] == evidence["sourceRevision"] == evidence["sourceSha256"]
        assert result["correctionProof"]["outputSha256"] == evidence["correctionSha256"]
        with pytest.raises(ClientError) as denied:
            client.put_object(Bucket=settings.s3_bucket, Key=key, Body=b"replacement")
        assert denied.value.response["ResponseMetadata"]["HTTPStatusCode"] == 403
        with pytest.raises(ClientError) as conflict:
            client.put_object(Bucket=settings.s3_bucket, Key=key, Body=b"replacement", IfNoneMatch="*")
        assert conflict.value.response["ResponseMetadata"]["HTTPStatusCode"] in (409, 412)
        client.meta.events.register("before-call.s3.CopyObject",
                                    lambda params, **_: params["headers"].update({"If-None-Match": "*"}))
        for action in (
            lambda: client.put_object(Bucket=settings.s3_bucket, Key=source, Body=b"replacement", IfNoneMatch="*"),
            lambda: client.delete_object(Bucket=settings.s3_bucket, Key=source),
            lambda: client.delete_object(Bucket=settings.s3_bucket, Key=key),
            lambda: client.copy_object(Bucket=settings.s3_bucket, Key=copy_target,
                                       CopySource={"Bucket": settings.s3_bucket, "Key": source}),
            lambda: client.create_multipart_upload(Bucket=settings.s3_bucket, Key=multipart),
            lambda: client.list_objects_v2(Bucket=settings.s3_bucket),
            lambda: client.put_bucket_policy(Bucket=settings.s3_bucket, Policy='{"Version":"2012-10-17","Statement":[]}'),
        ):
            with pytest.raises(ClientError) as denied:
                action()
            assert denied.value.response["ResponseMetadata"]["HTTPStatusCode"] == 403
        assert core.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read() == raw
        assert client.get_object(Bucket=settings.s3_bucket, Key=source)["Body"].read() == b"synthetic source"
    finally:
        client.close()
        core.close()
        root.close()


def test_real_core_to_worker_level_a_acceptance(services, storage_boundary, postgres, tmp_path):
    if os.environ.get("RUN_WORKER_REAL_ACCEPTANCE") != "1":
        pytest.skip("Explicit isolated Level A E2E-04 opt-in is required")

    service_settings, pki, names = services
    boundary_settings, boundary_pki, topology = storage_boundary
    assert pki == boundary_pki
    assert topology["backend"]
    transport_settings = {
        "broker_port": _docker_port(names[0], "5671/tcp"),
        "endpoint": boundary_settings.s3_endpoint_url,
        "bucket": boundary_settings.s3_bucket,
        "names": names,
        "root_secret": service_settings.s3_secret_access_key.get_secret_value(),
    }
    credentials = _application_credentials(transport_settings, pki)
    with _ai_process(tmp_path, pki) as ai_url, _core_process(
            tmp_path, postgres, transport_settings, credentials, pki, ai_url) as core:
        email, password = _seed_user(postgres, core)
        worker, worker_log = _start_worker(tmp_path, postgres, transport_settings, credentials, core, pki)
        admission = CoreAdmission(SimpleNamespace(s3_ca_file=pki / "ca.crt"), public_url=core.public_url,
                                   email=email, password=password)

        async def exercise():
            audio = synthetic_wav()
            try:
                meeting_id, media_id, job_id = await admission.admit(audio)
                job, transcript = await admission.wait_for_acceptance(
                    meeting_id, job_id, worker_alive=lambda: worker.poll() is None)
                assert job["status"] in ("COMPLETED", "COMPLETED_WITH_WARNINGS")
                assert transcript["processingJobId"] == job_id
                return meeting_id, media_id, job_id, transcript
            finally:
                await admission.close()

        try:
            meeting_id, media_id, job_id, transcript = asyncio.run(exercise())
            evidence = _evidence(postgres, job_id)
            _stop_worker(worker, worker_log)
            ack = _assert_original_ack(tmp_path / "worker.log", evidence)
            _assert_acknowledged(names[0], credentials)
            assert evidence["outcome"] == "RESULT_ACCEPTED"
            assert evidence["receiptCount"] == evidence["transcriptCount"] == 1
            assert evidence["generation"] == 0
            assert evidence["sourceSha256"] == hashlib.sha256(synthetic_wav()).hexdigest()
            _assert_result_storage(boundary_settings, job_id, evidence, credentials)
            assert evidence["outboxStatus"] == "PUBLISHED"
            assert evidence["transcriptStatus"] in ("READY", "READY_WITH_WARNINGS")
            assert evidence["transcriptId"] == transcript["id"]
            assert any(stage["code"] == "FINALIZING_TRANSCRIPT" and stage["status"] in ("SUCCEEDED", "SUCCEEDED_WITH_WARNING")
                       for stage in evidence["stages"])
            print("E2E04_EVIDENCE " + " ".join((
                f"meeting_id={meeting_id}", f"media_id={media_id}", f"job_id={job_id}",
                f"event_id={evidence['eventId']}", f"claim_stage_run_id={evidence['claimStageRunId']}",
                f"producer_stage_run_id={evidence['producerStageRunId']}",
                f"result_sha256={evidence['resultSha256']}", f"receipt_id={evidence['receiptId']}",
                f"transcript_id={evidence['transcriptId']}", f"delivery_state={evidence['outcome']}",
                f"correction_sha256={evidence['correctionSha256']}",
                f"ack_invoked=true ack_client_completed=true delivery_tag={ack['deliveryTag']}",
                f"channel={ack['channel']} redelivered={str(ack['redelivered']).lower()} "
                "broker_settled=true dlq_empty=true")))
        except Exception:
            # Read-only bounded metadata survives teardown, without tokens, keys,
            # source/result object names, provider output or transcript text.
            summary = _psql(postgres, postgres["password"], """
                SELECT json_build_object(
                    'jobs', (SELECT json_agg(json_build_object('id',id,'status',status,'error',error_code)) FROM processing_jobs),
                    'outbox', (SELECT json_agg(json_build_object('id',id,'status',status,'attempts',attempt_count,'error',last_error)) FROM outbox_events),
                    'receipts', (SELECT json_agg(json_build_object('id',receipt_id,'outcome',outcome,'error',error_code)) FROM transcription_worker_receipts))
            """)
            print("E2E04_DIAGNOSTIC " + summary)
            try:
                queues = broker.inspect(names[0], "sme-integration")
                print("E2E04_BROKER " + json.dumps([{field: q[field] for field in
                      ("name", "messages", "messages_ready", "messages_unacknowledged", "consumers")} for q in queues]))
            except Exception:
                print("E2E04_BROKER inspection unavailable")
            for line in (tmp_path / "worker.log").read_text().splitlines():
                if line.startswith(("E2E04_WORK_FAILURE ", "E2E04_COMMAND ")):
                    print(line)
            raise
        finally:
            if worker.poll() is None:
                _stop_worker(worker, worker_log)


def test_real_core_to_intelligence_acceptance_duplicate_and_restart(services, storage_boundary, postgres, tmp_path):
    """Real MI result acceptance, response-loss reconciliation, duplicate and restart recovery."""
    with _real_intelligence_context(services, storage_boundary, postgres, tmp_path) as fixture:
        core, pki, names = fixture.core, fixture.pki, fixture.names
        transport_settings = fixture.transport
        credentials = fixture.credentials
        intelligence = fixture.intelligence
        email, password = _seed_user(postgres, core)
        worker, worker_log = _start_intelligence_worker(
            tmp_path, postgres, transport_settings, credentials, core, pki, intelligence,
            control_environment={"AI_MI_TEST_LOSE_ACCEPTANCE_RESPONSE": "1"})
        duplicate_body = None
        event_id = None
        try:
            async def admit_and_wait():
                admission = CoreAdmission(SimpleNamespace(s3_ca_file=pki / "ca.crt"),
                    public_url=core.public_url, email=email, password=password)
                try:
                    meeting_id, media_id, job_id = await admission.admit(synthetic_wav())
                    job, transcript = await admission.wait_for_acceptance(
                        meeting_id, job_id, worker_alive=lambda: worker.poll() is None)
                    return meeting_id, media_id, job_id, job, transcript
                finally:
                    await admission.close()

            meeting_id, media_id, job_id, job, transcript = asyncio.run(admit_and_wait())
            assert job["status"] in ("COMPLETED", "COMPLETED_WITH_WARNINGS")
            evidence = _intelligence_evidence(postgres, job_id)
            assert evidence == {
                **evidence,
                "dispatchCount": 1,
                "claimCount": 1,
                "receiptCount": 1,
                "acceptedCount": 1,
                "outboxStatus": "PUBLISHED",
                "stageStatus": "SUCCEEDED",
            }
            _assert_intelligence_artifact(transport_settings, credentials, evidence, job_id)
            event_id, event_type, duplicate_body = _intelligence_wire(postgres, job_id)
            asyncio.run(_publish_intelligence_duplicate(transport_settings, credentials,
                                                        event_id, event_type, duplicate_body))
            _assert_intelligence_settled(names[0])
            evidence_after_duplicate = _intelligence_evidence(postgres, job_id)
            assert evidence_after_duplicate["receiptCount"] == 1
            _stop_worker(worker, worker_log)
            worker = None

            # A duplicate left on the durable queue survives process restart and
            # is acknowledged from Core's authoritative RESULT_ACCEPTED status.
            asyncio.run(_publish_intelligence_duplicate(transport_settings, credentials,
                                                        event_id, event_type, duplicate_body))
            restarted, restarted_log = _start_intelligence_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki, intelligence)
            try:
                _assert_intelligence_settled(names[0])
                assert _intelligence_evidence(postgres, job_id)["receiptCount"] == 1
            finally:
                _stop_worker(restarted, restarted_log)
                print("E2E04_MI_EVIDENCE " + " ".join((
                    f"job_id={job_id}", f"event_id={event_id}",
                    f"receipt_count={evidence_after_duplicate['receiptCount']}",
                    f"stage_status={evidence_after_duplicate['stageStatus']}",
                    "canonical_acceptance=true response_loss_reconciled=true duplicate_idempotent=true "
                    "restart_recovered=true broker_settled=true")))
        finally:
            if worker is not None and worker.poll() is None:
                _stop_worker(worker, worker_log)


def test_real_core_to_intelligence_artifact_conflict_is_durable_failure(
        services, storage_boundary, postgres, tmp_path):
    """A pre-existing conflicting result is never overwritten or accepted."""
    with _real_intelligence_context(services, storage_boundary, postgres, tmp_path) as fixture:
        core, pki, names = fixture.core, fixture.pki, fixture.names
        transport_settings = fixture.transport
        credentials = fixture.credentials
        intelligence = fixture.intelligence
        email, password = _seed_user(postgres, core)
        transcription = transcription_log = worker = worker_log = None
        try:
            transcription, transcription_log = _start_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki)
            _, _, job_id = _admit_intelligence_job(core, pki, email, password)
            dispatch = _wait_for_intelligence_dispatch(postgres, job_id)
            _stop_worker(transcription, transcription_log)
            transcription = transcription_log = None

            key = f"processing/{job_id}/intelligence/results/{dispatch['stageRunId']}.json"
            storage = _workload_storage(transport_settings, credentials.storage_intelligence_user,
                                        credentials.storage_intelligence_password)
            try:
                storage.put_object(Bucket=transport_settings["bucket"], Key=key,
                                   Body=b"{}", IfNoneMatch="*")
            finally:
                storage.close()

            worker, worker_log = _start_intelligence_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki, intelligence)
            _wait_for_sql(postgres, f"""
                SELECT error_code FROM processing_stage_runs
                WHERE id='{dispatch['stageRunId']}'::uuid
                  AND status='FAILED' AND error_code='INTELLIGENCE_INTEGRITY'
            """, bool)
            _assert_intelligence_settled(names[0])
            evidence = _intelligence_evidence(postgres, job_id)
            assert evidence["claimCount"] == 1
            assert evidence["receiptCount"] == 0
            assert evidence["stageStatus"] == "FAILED"
            storage = _workload_storage(transport_settings, credentials.storage_intelligence_user,
                                        credentials.storage_intelligence_password)
            try:
                assert storage.get_object(Bucket=transport_settings["bucket"], Key=key)["Body"].read() == b"{}"
            finally:
                storage.close()
            print("E2E04_MI_CONFLICT_EVIDENCE " + " ".join((
                f"job_id={job_id}", f"stage_run_id={dispatch['stageRunId']}",
                "artifact_conflict_rejected=true canonical_receipt_count=0 broker_settled=true")))
        finally:
            if worker is not None and worker.poll() is None:
                _stop_worker(worker, worker_log)
            if transcription is not None and transcription.poll() is None:
                _stop_worker(transcription, transcription_log)


def test_real_core_to_intelligence_lease_expiry_fences_without_publication(
        services, storage_boundary, postgres, tmp_path):
    """Lease expiry fences the active worker and durable failure settles without a result."""
    with _real_intelligence_context(
            services, storage_boundary, postgres, tmp_path,
            extra={"APP_MEDIA_PROCESSING_STAGE_LEASE_SECONDS": "30",
                   "APP_MEDIA_PROCESSING_STAGE_LEASE_SWEEP_MS": "1000"}) as fixture:
        core, pki, names = fixture.core, fixture.pki, fixture.names
        transport_settings = fixture.transport
        credentials = fixture.credentials
        intelligence = fixture.intelligence
        email, password = _seed_user(postgres, core)
        transcription = transcription_log = worker = worker_log = restarted = restarted_log = None
        try:
            transcription, transcription_log = _start_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki)
            _, _, job_id = _admit_intelligence_job(core, pki, email, password)
            dispatch = _wait_for_intelligence_dispatch(postgres, job_id)
            _stop_worker(transcription, transcription_log)
            transcription = transcription_log = None
            worker, worker_log = _start_intelligence_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki, intelligence,
                delay_seconds=45)
            _wait_for_sql(postgres, f"""
                SELECT stage_run_id FROM processing_intelligence_claims
                WHERE processing_job_id='{job_id}'::uuid
            """, bool)
            _psql(postgres, postgres["password"], f"""
                UPDATE processing_stage_runs
                SET lease_expires_at=clock_timestamp()-INTERVAL '1 second'
                WHERE id='{dispatch['stageRunId']}'::uuid AND status='RUNNING'
            """)
            _wait_for_sql(postgres, f"""
                SELECT error_code FROM processing_stage_runs
                WHERE id='{dispatch['stageRunId']}'::uuid
                  AND status='FAILED' AND error_code='STAGE_LEASE_EXPIRED'
            """, bool, timeout=45)
            _wait_for_intelligence_broker(
                names[0], lambda work, dead: work["messages"] == 0
                    and dead["messages"] == 0, timeout=30)
            _stop_worker(worker, worker_log)
            worker = worker_log = None
            _assert_intelligence_result_missing(transport_settings, credentials, job_id,
                                                dispatch["stageRunId"])
            restarted, restarted_log = _start_intelligence_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki, intelligence)
            _assert_intelligence_settled(names[0])
            evidence = _intelligence_evidence(postgres, job_id)
            assert evidence["claimCount"] == 1
            assert evidence["receiptCount"] == 0
            assert evidence["stageStatus"] == "FAILED"
            print("E2E04_MI_LEASE_EVIDENCE " + " ".join((
                f"job_id={job_id}", f"stage_run_id={dispatch['stageRunId']}",
                "lease_expired=true stale_publication_blocked=true durable_failure_acknowledged=true "
                "result_receipt_count=0 broker_settled=true")))
        finally:
            if restarted is not None and restarted.poll() is None:
                _stop_worker(restarted, restarted_log)
            if worker is not None and worker.poll() is None:
                _stop_worker(worker, worker_log)
            if transcription is not None and transcription.poll() is None:
                _stop_worker(transcription, transcription_log)


def test_real_core_to_intelligence_crash_requeues_unresolved_delivery(
        services, storage_boundary, postgres, tmp_path):
    """A killed in-flight worker leaves delivery unresolved until durable failure is observable."""
    with _real_intelligence_context(
            services, storage_boundary, postgres, tmp_path,
            extra={"APP_MEDIA_PROCESSING_STAGE_LEASE_SECONDS": "60",
                   "APP_MEDIA_PROCESSING_STAGE_LEASE_SWEEP_MS": "1000"}) as fixture:
        core, pki, names = fixture.core, fixture.pki, fixture.names
        transport_settings = fixture.transport
        credentials = fixture.credentials
        intelligence = fixture.intelligence
        email, password = _seed_user(postgres, core)
        transcription = transcription_log = original = original_log = None
        unresolved = unresolved_log = final = final_log = None
        try:
            transcription, transcription_log = _start_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki)
            _, _, job_id = _admit_intelligence_job(core, pki, email, password)
            dispatch = _wait_for_intelligence_dispatch(postgres, job_id)
            _stop_worker(transcription, transcription_log)
            transcription = transcription_log = None

            original, original_log = _start_intelligence_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki, intelligence,
                delay_seconds=45)
            _wait_for_sql(postgres, f"""
                SELECT stage_run_id FROM processing_intelligence_claims
                WHERE processing_job_id='{job_id}'::uuid
            """, bool)
            _kill_worker(original, original_log)
            original = original_log = None
            _wait_for_intelligence_broker(
                names[0], lambda work, dead: work["messages_ready"] == 1
                    and work["messages_unacknowledged"] == 0 and dead["messages"] == 0, timeout=30)
            _assert_intelligence_result_missing(transport_settings, credentials, job_id,
                                                dispatch["stageRunId"])

            unresolved, unresolved_log = _start_intelligence_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki, intelligence)
            _wait_for_log_event(unresolved_log, "worker.intelligence.delivery.unresolved")
            _wait_for_intelligence_broker(
                names[0], lambda work, dead: work["messages_ready"] == 1
                    and work["messages_unacknowledged"] == 0 and work["consumers"] == 0
                    and dead["messages"] == 0, timeout=30)
            _wait_for_sql(postgres, f"""
                SELECT error_code FROM processing_stage_runs
                WHERE id='{dispatch['stageRunId']}'::uuid
                  AND status='FAILED' AND error_code='STAGE_LEASE_EXPIRED'
            """, bool, timeout=90)
            _stop_worker(unresolved, unresolved_log)
            unresolved = unresolved_log = None
            _wait_for_intelligence_broker(
                names[0], lambda work, dead: work["messages_ready"] == 1
                    and work["messages_unacknowledged"] == 0 and dead["messages"] == 0, timeout=30)

            final, final_log = _start_intelligence_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki, intelligence)
            _assert_intelligence_settled(names[0])
            evidence = _intelligence_evidence(postgres, job_id)
            assert evidence["claimCount"] == 1
            assert evidence["receiptCount"] == 0
            assert evidence["stageStatus"] == "FAILED"
            _assert_intelligence_result_missing(transport_settings, credentials, job_id,
                                                dispatch["stageRunId"])
            print("E2E04_MI_CRASH_EVIDENCE " + " ".join((
                f"job_id={job_id}", f"stage_run_id={dispatch['stageRunId']}",
                "shutdown_unresolved=true redelivery_observed=true stale_owner_not_reexecuted=true "
                "durable_failure_acknowledged=true result_receipt_count=0 broker_settled=true")))
        finally:
            if final is not None and final.poll() is None:
                _stop_worker(final, final_log)
            if unresolved is not None and unresolved.poll() is None:
                _stop_worker(unresolved, unresolved_log)
            if original is not None and original.poll() is None:
                _kill_worker(original, original_log)
            if transcription is not None and transcription.poll() is None:
                _stop_worker(transcription, transcription_log)


def test_real_core_to_intelligence_graceful_shutdown_requeues_unresolved_delivery(
        services, storage_boundary, postgres, tmp_path):
    """Bounded graceful shutdown fences in-flight work and preserves the delivery for recovery."""
    with _real_intelligence_context(
            services, storage_boundary, postgres, tmp_path,
            extra={"APP_MEDIA_PROCESSING_STAGE_LEASE_SECONDS": "60",
                   "APP_MEDIA_PROCESSING_STAGE_LEASE_SWEEP_MS": "1000"}) as fixture:
        core, pki, names = fixture.core, fixture.pki, fixture.names
        transport_settings = fixture.transport
        credentials = fixture.credentials
        intelligence = fixture.intelligence
        email, password = _seed_user(postgres, core)
        transcription = transcription_log = worker = worker_log = final = final_log = None
        try:
            transcription, transcription_log = _start_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki)
            _, _, job_id = _admit_intelligence_job(core, pki, email, password)
            dispatch = _wait_for_intelligence_dispatch(postgres, job_id)
            _stop_worker(transcription, transcription_log)
            transcription = transcription_log = None

            worker, worker_log = _start_intelligence_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki, intelligence,
                delay_seconds=45)
            _wait_for_sql(postgres, f"""
                SELECT stage_run_id FROM processing_intelligence_claims
                WHERE processing_job_id='{job_id}'::uuid
            """, bool)
            exit_code = _request_worker_shutdown(worker, worker_log)
            worker = worker_log = None
            _wait_for_intelligence_broker(
                names[0], lambda work, dead: work["messages_ready"] == 1
                    and work["messages_unacknowledged"] == 0 and work["consumers"] == 0
                    and dead["messages"] == 0, timeout=30)
            _wait_for_sql(postgres, f"""
                SELECT error_code FROM processing_stage_runs
                WHERE id='{dispatch['stageRunId']}'::uuid
                  AND status='FAILED' AND error_code='STAGE_LEASE_EXPIRED'
            """, bool, timeout=90)
            _assert_intelligence_result_missing(transport_settings, credentials, job_id,
                                                dispatch["stageRunId"])
            final, final_log = _start_intelligence_worker(
                tmp_path, postgres, transport_settings, credentials, core, pki, intelligence)
            _assert_intelligence_settled(names[0])
            evidence = _intelligence_evidence(postgres, job_id)
            assert evidence["claimCount"] == 1
            assert evidence["receiptCount"] == 0
            assert evidence["stageStatus"] == "FAILED"
            print("E2E04_MI_SHUTDOWN_EVIDENCE " + " ".join((
                f"job_id={job_id}", f"stage_run_id={dispatch['stageRunId']}",
                f"graceful_shutdown_requested=true exit_code={exit_code}",
                "unresolved_delivery_requeued=true stale_publication_blocked=true "
                "durable_failure_acknowledged=true result_receipt_count=0 broker_settled=true")))
        finally:
            if final is not None and final.poll() is None:
                _stop_worker(final, final_log)
            if worker is not None and worker.poll() is None:
                _request_worker_shutdown(worker, worker_log)
            if transcription is not None and transcription.poll() is None:
                _stop_worker(transcription, transcription_log)
