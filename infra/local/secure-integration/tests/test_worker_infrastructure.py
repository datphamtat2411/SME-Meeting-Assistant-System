"""Real isolated Worker V1 broker/storage acceptance; no shared resources.

Run with E2E01_DOCKER_FIXTURES=true from services/ai using uv run --locked pytest.
"""
import asyncio
import hashlib
import importlib.util
import json
import os
import ssl
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

import aio_pika
import boto3
import pytest
import test_transport_services as transport
from aiormq.exceptions import ChannelAccessRefused
from botocore.config import Config
from botocore.exceptions import ClientError

services = transport.services
smoke = transport.smoke

HERE = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("worker_broker", HERE / "broker.py")
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
spec = importlib.util.spec_from_file_location("worker_storage_admin", HERE / "storage_admin.py")
storage_admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage_admin)


@pytest.fixture(scope="module")
def storage_boundary(services):
    settings, pki, _ = services
    configuration = (HERE / "storage-boundary.conf").read_text()
    configuration = configuration.replace("proxy_ssl_name storage.internal;", "proxy_ssl_name localhost;")
    configuration = configuration.replace("server_name storage.internal;", "server_name localhost;")
    configuration = configuration.replace("$host != storage.internal", "$host != localhost")
    # Isolated synthetic requests only: retain protocol diagnostics for failures.
    configuration = configuration.replace("error_log /dev/stderr emerg;", "error_log /dev/stderr info;")
    config = pki / "boundary.conf"
    config.write_text(configuration)
    suffix = uuid.uuid4().hex[:10]
    name = "e2e03-storage-boundary-" + suffix
    backend = "e2e03-storage-backend-" + suffix
    private_network = "e2e03-private-" + suffix
    client_network = "e2e03-client-" + suffix
    networks = []
    try:
        for network, flags in ((private_network, ["--internal"]), (client_network, [])):
            transport.docker("network", "create", *flags, network)
            networks.append(network)
        env = dict(os.environ, RUSTFS_ACCESS_KEY="fixture", RUSTFS_SECRET_KEY=settings.s3_secret_access_key.get_secret_value())
        subprocess.run(["docker", "run", "--rm", "-d", "--name", backend,
            "--network", private_network, "--network-alias", "storage", "--tmpfs", "/data:uid=10001,gid=10001,mode=0700",
            "--mount", f"type=bind,src={pki / 'runtime'},dst=/run/secrets/storage,readonly",
            "-e", "RUSTFS_ACCESS_KEY", "-e", "RUSTFS_SECRET_KEY", "-e", "RUSTFS_CONSOLE_ENABLE=false",
            "-e", "RUSTFS_TLS_PATH=/run/secrets/storage", "rustfs/rustfs:1.0.3", "/data"],
            env=env, check=True, capture_output=True, timeout=120)
        options = ["--user", "10001:10001",
            "--read-only", "--tmpfs", "/tmp:mode=1777", "--cap-drop=ALL",
            "--mount", f"type=bind,src={config},dst=/etc/nginx/storage-boundary.conf,readonly",
            "--mount", f"type=bind,src={pki / 'runtime'},dst=/run/secrets/storage,readonly",
            "--entrypoint", "nginx", "nginx:1.28-alpine", "-c", "/etc/nginx/storage-boundary.conf"]
        validation = subprocess.run(["docker", "run", "--rm", "--network", private_network, *options, "-t"], capture_output=True, text=True, timeout=30)
        assert validation.returncode == 0, validation.stderr
        subprocess.run(["docker", "run", "--rm", "-d", "--name", name, "--network", client_network,
            "--network", private_network, "-p", "127.0.0.1::9000", *options, "-g", "daemon off;"],
            check=True, capture_output=True, timeout=120)
        port = int(transport.docker("port", name, "9000/tcp").rsplit(":", 1)[1])
        for _ in range(30):
            try:
                smoke.verified_socket(smoke.Endpoint("localhost", port), pki / "ca.crt")
                break
            except (OSError, ValueError):
                time.sleep(0.2)
        else:
            logs = subprocess.check_output(["docker", "logs", name], stderr=subprocess.STDOUT, text=True)
            pytest.fail("Isolated storage boundary did not start: " + logs)
        boundary_settings = settings.model_copy(update={"s3_endpoint_url": f"https://localhost:{port}"})
        client = storage_client(boundary_settings)
        try:
            for _ in range(90):
                try:
                    client.create_bucket(Bucket=settings.s3_bucket)
                    break
                except ClientError as error:
                    if error.response["ResponseMetadata"]["HTTPStatusCode"] not in (502, 503):
                        raise
                    time.sleep(1)
            else:
                pytest.fail("Private RustFS backend did not become available")
        finally:
            client.close()
        yield boundary_settings, pki, {"backend": backend, "private_network": private_network,
                                       "client_network": client_network}
    finally:
        print(subprocess.run(["docker", "logs", name], capture_output=True, text=True, timeout=10).stderr)
        for container in (name, backend):
            subprocess.run(["docker", "stop", "--time", "5", container], capture_output=True, timeout=20)
        for network in reversed(networks):
            subprocess.run(["docker", "network", "rm", network], capture_output=True, timeout=20)


async def connect(settings, username="fixture", password=None):
    from urllib.parse import urlsplit
    url = urlsplit(settings.rabbitmq_url)
    return await aio_pika.connect(host="localhost", port=url.port, ssl=True,
        ssl_context=ssl.create_default_context(cafile=str(settings.rabbitmq_ca_file)),
        login=username, password=password or settings.rabbitmq_password.get_secret_value(), virtualhost="sme-integration")


def test_real_quorum_delivery_limit_durable_handoff_and_classic_conflict(services):
    settings, _, names = services
    users = {role: "fixture-" + role for role in ("publisher", "worker", "reconciler")}
    definitions = broker.definitions("sme-integration", users)
    import base64
    password = uuid.uuid4().hex
    salt = b"test"
    password_hash = base64.b64encode(salt + hashlib.sha256(salt + password.encode()).digest()).decode()
    definitions["users"] = [{"name": user, "password_hash": password_hash,
                            "hashing_algorithm": "rabbit_password_hashing_sha256", "tags": []} for user in users.values()]
    encoded = base64.b64encode(json.dumps(definitions).encode()).decode()
    result = broker.cli(names[0], "eval", f'rabbit_definitions:import_raw(base64:decode(<<"{encoded}">>)).')
    assert "ok" in result
    broker.verify(broker.inspect(names[0], "sme-integration"))
    runtime = broker.runtime(names[0], "sme-integration")
    broker.verify_runtime(runtime)
    # RabbitMQ 4.1 defaults to 180s, not 30s. Leave production timing intact.
    retry_seconds = runtime["confirm_timeout_ms"] / 1000
    assert 0 < retry_seconds <= 180

    def snapshot(phase):
        print(phase, broker.inspect(names[0], "sme-integration"))
        print(broker.cli(names[0], "list_bindings", "-p", "sme-integration", "source_name", "destination_name", "routing_key", "--formatter=json"))
        state = broker.runtime(names[0], "sme-integration")
        print(state)
        return state

    async def exercise():
        connection = await connect(settings)
        try:
            channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
            await channel.set_qos(prefetch_count=1)
            work = await channel.get_queue(broker.WORK)
            dead = await channel.get_queue(broker.DEAD)
            exchange = await channel.get_exchange(broker.EXCHANGE)
            confirmation = await exchange.publish(aio_pika.Message(b"synthetic", message_id="stable-fixture",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT, content_type="application/json"), broker.ROUTE, mandatory=True)
            assert confirmation is not None
            with pytest.raises(aio_pika.exceptions.DeliveryError):
                await exchange.publish(aio_pika.Message(b"unroutable"), "missing", mandatory=True)
            counts = []
            for _ in range(8):
                try:
                    message = await work.get(timeout=5)
                except aio_pika.exceptions.QueueEmpty:
                    break
                counts.append(message.headers.get("x-delivery-count", 0))
                assert message.delivery_mode == aio_pika.DeliveryMode.PERSISTENT
                await message.nack(requeue=True)
                await asyncio.sleep(0.1)
            assert counts == list(range(6))
            for _ in range(30):
                try:
                    exhausted = await dead.get(timeout=5)
                    break
                except aio_pika.exceptions.QueueEmpty:
                    await asyncio.sleep(0.2)
            else:
                pytest.fail("No durable dead-letter handoff")
            assert exhausted.body == b"synthetic"
            assert exhausted.headers["x-death"][0]["reason"] == "delivery_limit"
            # Commit-before-ACK crash analogue: connection closes with DLQ delivery outstanding.
            await connection.close()
            connection = await connect(settings)
            recovered = await connection.channel()
            dead = await recovered.get_queue(broker.DEAD)
            replay = await dead.get(timeout=5)
            assert replay.body == b"synthetic"
            await replay.ack()
            # A missing DLQ binding must retain the transfer in the source quorum queue.
            admin = await connection.channel(publisher_confirms=True)
            work = await admin.get_queue(broker.WORK)
            dead = await admin.get_queue(broker.DEAD)
            dlx = await admin.get_exchange(broker.DLX)
            exchange = await admin.get_exchange(broker.EXCHANGE)
            await dead.unbind(dlx, routing_key=broker.DEAD)
            snapshot("route-removed")
            held_event = {field: str(uuid.uuid4()) for field in
                          ("eventId", "processingJobId", "meetingId", "sourceMediaId", "requestedByUserId")}
            held_event.update(schemaVersion=1, requestId="isolated-route-recovery", occurredAt="2026-11-03T00:00:00Z")
            held_bytes = json.dumps(held_event).encode()
            await exchange.publish(aio_pika.Message(held_bytes, message_id=held_event["eventId"],
                headers={"eventId": held_event["eventId"], "eventType": "PROCESSING_JOB_QUEUED"}, content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT), broker.ROUTE)
            held = await work.get(timeout=5)
            await held.reject(requeue=False)
            await asyncio.sleep(0.5)
            pending = snapshot("pending-without-route")
            assert pending["num_messages"] == 1
            assert pending["num_discarded"] + pending["num_discard_checked_out"] == 1
            with pytest.raises(broker.Blocked):
                broker.migration_ready(broker.inspect(names[0], "sme-integration"))
            with pytest.raises(aio_pika.exceptions.QueueEmpty):
                await dead.get(timeout=5)
            await dead.bind(dlx, routing_key=broker.DEAD)
            snapshot("route-restored")
            deadline = time.monotonic() + retry_seconds + 30
            while time.monotonic() < deadline:
                try:
                    transferred = await dead.get(timeout=5)
                    break
                except aio_pika.exceptions.QueueEmpty:
                    await asyncio.sleep(0.5)
            else:
                snapshot("recovery-timeout")
                logs = subprocess.run(["docker", "logs", names[0]], capture_output=True, text=True, timeout=10)
                print("\n".join(line for line in (logs.stdout + logs.stderr).splitlines() if "dead" in line.lower()))
                pytest.fail("At-least-once transfer did not recover after binding restoration")
            assert transferred.body == held_bytes
            assert transferred.message_id == transferred.headers["eventId"] == held_event["eventId"]
            assert transferred.headers["eventType"] == "PROCESSING_JOB_QUEUED"
            assert transferred.content_type == "application/json"
            assert transferred.delivery_mode == aio_pika.DeliveryMode.PERSISTENT
            await transferred.ack()
            # Removal from the source Raft discard set proves the target confirmed.
            for _ in range(10):
                settled = broker.runtime(names[0], "sme-integration")
                if settled["num_messages"] == 0:
                    break
                await asyncio.sleep(0.2)
            assert settled["num_messages"] == settled["num_discarded"] == settled["num_discard_checked_out"] == 0
            # Real broker negative confirms from reject-publish backpressure.
            broker.cli(names[0], "set_policy", "-p", "sme-integration", "--apply-to", "queues",
                       "fixture-capacity", "^meeting.processing.jobs$", '{"max-length":1}')
            await exchange.publish(aio_pika.Message(b"capacity", delivery_mode=aio_pika.DeliveryMode.PERSISTENT), broker.ROUTE)
            await asyncio.sleep(0.2)
            # Quorum reject-publish can overshoot by an in-flight publication.
            # Keep every confirmed event and bound attempts to obtain a real NACK.
            capacity_messages = [b"capacity"]
            for index in range(5):
                raw = f"capacity-{index}".encode()
                try:
                    await exchange.publish(aio_pika.Message(raw, delivery_mode=aio_pika.DeliveryMode.PERSISTENT), broker.ROUTE)
                    capacity_messages.append(raw)
                    await asyncio.sleep(0.2)
                except aio_pika.exceptions.DeliveryError:
                    break
            else:
                pytest.fail("No negative confirmation from reject-publish")
            broker.cli(names[0], "clear_policy", "-p", "sme-integration", "fixture-capacity")
            for raw in capacity_messages:
                queued = await work.get(timeout=5)
                assert queued.body == raw
                await queued.ack()
            # Crash before ACK on the work queue returns the persistent original.
            await exchange.publish(aio_pika.Message(b"worker-crash", delivery_mode=aio_pika.DeliveryMode.PERSISTENT), broker.ROUTE)
            assert (await work.get(timeout=5)).body == b"worker-crash"
            await admin.close()
            after_crash = await connection.channel()
            work = await after_crash.get_queue(broker.WORK)
            recovered_work = await work.get(timeout=5)
            assert recovered_work.body == b"worker-crash"
            await recovered_work.ack()
            worker_connection = await connect(settings, users["worker"], password)
            try:
                worker_channel = await worker_connection.channel()
                scoped_work = await worker_channel.get_queue(broker.WORK)
                publisher = await connect(settings, users["publisher"], password)
                try:
                    sender = await publisher.channel(publisher_confirms=True, on_return_raises=True)
                    await (await sender.get_exchange(broker.EXCHANGE, ensure=False)).publish(
                        aio_pika.Message(b"scoped-publisher", delivery_mode=aio_pika.DeliveryMode.PERSISTENT), broker.ROUTE)
                finally:
                    await publisher.close()
                scoped_message = await scoped_work.get(timeout=5)
                assert scoped_message.body == b"scoped-publisher"
                await scoped_message.ack()
                with pytest.raises(ChannelAccessRefused):
                    await worker_channel.declare_exchange("fixture.forbidden", durable=True)
            finally:
                await worker_connection.close()
            reconciler = await connect(settings, users["reconciler"], password)
            try:
                receiver = await reconciler.channel()
                await receiver.get_queue(broker.DEAD)
                with pytest.raises(ChannelAccessRefused):
                    await (await receiver.get_queue(broker.WORK, ensure=False)).get(timeout=5)
            finally:
                await reconciler.close()
            classic = await recovered.declare_queue("fixture.classic", durable=True, arguments={"x-queue-type": "classic"})
            await recovered.default_exchange.publish(aio_pika.Message(b"migration-must-block",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT), classic.name)
            outstanding = await classic.get(timeout=5)
            inspection = next(q for q in broker.inspect(names[0], "sme-integration") if q["name"] == classic.name)
            assert inspection["type"] == "classic"
            assert inspection["messages_unacknowledged"] == 1
            with pytest.raises(broker.Blocked):
                broker.migration_ready([inspection])
            assert outstanding.body == b"migration-must-block"
            await classic.channel.close()
            incompatible = await connection.channel()
            with pytest.raises(aio_pika.exceptions.ChannelPreconditionFailed):
                await incompatible.declare_queue("fixture.classic", durable=True, arguments={"x-queue-type": "quorum"})
            migration_channel = await connection.channel()
            still_classic = await migration_channel.get_queue("fixture.classic")
            preserved_classic = await still_classic.get(timeout=5)
            assert preserved_classic.body == b"migration-must-block"
            await preserved_classic.ack()
            pending_channel = await connection.channel(publisher_confirms=True)
            await (await pending_channel.get_exchange(broker.EXCHANGE)).publish(
                aio_pika.Message(b"broker-restart", delivery_mode=aio_pika.DeliveryMode.PERSISTENT), broker.ROUTE)
            await connection.close()
            broker.cli(names[0], "stop_app")
            broker.cli(names[0], "start_app")
            connection = await connect(settings)
            restarted = await connection.channel()
            preserved = await (await restarted.get_queue(broker.WORK)).get(timeout=5)
            assert preserved.body == b"broker-restart"
            await preserved.ack()
            with pytest.raises(aio_pika.exceptions.QueueEmpty):
                await (await restarted.get_queue(broker.WORK)).get(timeout=5)
            with pytest.raises(aio_pika.exceptions.QueueEmpty):
                await (await restarted.get_queue(broker.DEAD)).get(timeout=5)
            verified = subprocess.run([sys.executable, str(HERE / "broker.py"), "verify", "--container", names[0],
                "--vhost", "sme-integration"], capture_output=True, text=True, timeout=60)
            assert verified.returncode == 0, verified.stdout + verified.stderr
        finally:
            await connection.close()
    asyncio.run(exercise())


def storage_client(settings):
    return boto3.client("s3", endpoint_url=settings.s3_endpoint_url, verify=str(settings.s3_ca_file),
        aws_access_key_id="fixture", aws_secret_access_key=settings.s3_secret_access_key.get_secret_value(),
        region_name="us-east-1", config=Config(s3={"addressing_style": "path"}, retries={"total_max_attempts": 1}))


def test_real_https_storage_conditional_single_winner(storage_boundary):
    settings, _, _ = storage_boundary
    client = storage_client(settings)
    key = "processing/11111111-1111-4111-8111-111111111111/transcription/results/22222222-2222-4222-8222-222222222222.json"

    def put(raw):
        try:
            client.put_object(Bucket=settings.s3_bucket, Key=key, Body=raw, IfNoneMatch="*", ContentType="application/json")
            return raw
        except ClientError as error:
            assert error.response["ResponseMetadata"]["HTTPStatusCode"] in (409, 412)
            return None
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            winners = [raw for raw in pool.map(put, [b"one", b"two", b"three", b"four"]) if raw]
        assert len(winners) == 1
        assert put(b"replacement") is None
        assert client.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read() == winners[0]
    finally:
        client.close()


def test_real_storage_policy_denies_unconditional_result_writes(services, storage_boundary):
    settings, _, _ = services
    client = storage_client(settings)
    # Explicit Deny must apply even when an identity has an independent PutObject grant.
    # Missing condition support must fail this acceptance test, not be silently omitted.
    resource = f"arn:aws:s3:::{settings.s3_bucket}/processing/*/transcription/results/*.json"
    policy = {"Version": "2012-10-17", "Statement": [
        {"Effect": "Deny", "Principal": "*", "Action": "s3:PutObject", "Resource": resource,
         "Condition": {"StringNotEquals": {"s3:if-none-match": "*"}}},
        {"Effect": "Deny", "Principal": "*", "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion"], "Resource": resource},
    ]}
    try:
        with pytest.raises(ClientError) as unsupported:
            client.put_bucket_policy(Bucket=settings.s3_bucket, Policy=json.dumps(policy))
        assert unsupported.value.response["Error"]["Code"] == "InvalidArgument"
        assert "s3:if-none-match" in unsupported.value.response["Error"]["Message"]
        client.close()
        settings, _, _ = storage_boundary
        client = storage_client(settings)
        key = "processing/fixture/transcription/results/policy.json"
        with pytest.raises(ClientError) as denied:
            client.put_object(Bucket=settings.s3_bucket, Key=key, Body=b"unconditional")
        assert denied.value.response["ResponseMetadata"]["HTTPStatusCode"] == 403
        client.put_object(Bucket=settings.s3_bucket, Key=key, Body=b"immutable", IfNoneMatch="*")
        with pytest.raises(ClientError):
            client.delete_object(Bucket=settings.s3_bucket, Key=key)
        assert client.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read() == b"immutable"
    finally:
        client.close()


def test_real_separate_storage_identities_and_permission_negatives(storage_boundary):
    settings, pki, topology = storage_boundary
    password = uuid.uuid4().hex
    admin = storage_admin.Admin(settings.s3_endpoint_url, pki / "ca.crt", "fixture", settings.s3_secret_access_key.get_secret_value())
    root = storage_client(settings)
    source = "meetings/fixture/sources/audio"
    result = "processing/fixture/transcription/results/identity.json"
    root.put_object(Bucket=settings.s3_bucket, Key=source, Body=b"accepted audio")
    clients = []
    try:
        for role in ("worker", "core"):
            user = "e2e03-" + role
            admin.provision(settings.s3_bucket, role, user, password)
            clients.append(boto3.client("s3", endpoint_url=settings.s3_endpoint_url, verify=str(pki / "ca.crt"),
                aws_access_key_id=user, aws_secret_access_key=password, region_name="us-east-1",
                config=Config(s3={"addressing_style": "path"}, retries={"total_max_attempts": 1})))
        worker, core = clients
        assert worker.get_object(Bucket=settings.s3_bucket, Key=source)["Body"].read() == b"accepted audio"
        worker.put_object(Bucket=settings.s3_bucket, Key=result, Body=b"immutable", IfNoneMatch="*")
        assert core.get_object(Bucket=settings.s3_bucket, Key=result)["Body"].read() == b"immutable"
        copy_target = "processing/fixture/transcription/results/copy.json"
        multipart_target = "processing/fixture/transcription/results/multipart.json"
        worker.meta.events.register("before-call.s3.CopyObject",
            lambda params, **_: params["headers"].update({"If-None-Match": "*"}))
        for operation, action in (
            ("unconditional-overwrite", lambda: worker.put_object(Bucket=settings.s3_bucket, Key=result, Body=b"overwrite")),
            ("source-overwrite", lambda: worker.put_object(Bucket=settings.s3_bucket, Key=source, Body=b"overwrite", IfNoneMatch="*")),
            ("source-delete", lambda: worker.delete_object(Bucket=settings.s3_bucket, Key=source)),
            ("result-delete", lambda: worker.delete_object(Bucket=settings.s3_bucket, Key=result)),
            ("unrestricted-list", lambda: worker.list_objects_v2(Bucket=settings.s3_bucket)),
            ("bucket-administration", lambda: worker.put_bucket_policy(Bucket=settings.s3_bucket, Policy='{"Version":"2012-10-17","Statement":[]}')),
            ("multipart-create", lambda: worker.create_multipart_upload(Bucket=settings.s3_bucket, Key=multipart_target)),
            ("conditional-copy", lambda: worker.copy_object(Bucket=settings.s3_bucket, Key=copy_target,
                CopySource={"Bucket": settings.s3_bucket, "Key": source})),
            ("core-result-write", lambda: core.put_object(Bucket=settings.s3_bucket, Key=result, Body=b"core overwrite", IfNoneMatch="*")),
        ):
            with pytest.raises(ClientError) as denied:
                action()
            assert denied.value.response["ResponseMetadata"]["HTTPStatusCode"] == 403, operation
            assert denied.value.response["Error"]["Code"] == "AccessDenied", operation
            assert core.get_object(Bucket=settings.s3_bucket, Key=result)["Body"].read() == b"immutable", operation
            assert core.get_object(Bucket=settings.s3_bucket, Key=source)["Body"].read() == b"accepted audio", operation
            for absent in (copy_target, multipart_target):
                with pytest.raises(ClientError) as missing:
                    root.head_object(Bucket=settings.s3_bucket, Key=absent)
                assert missing.value.response["ResponseMetadata"]["HTTPStatusCode"] == 404, operation
        assert core.get_object(Bucket=settings.s3_bucket, Key=result)["Body"].read() == b"immutable"
        # Preserve Core's existing upload/intelligence capabilities without broad grants.
        pending = "meetings/fixture/pending/upload"
        intelligence = "processing/fixture/intelligence/source/synthetic.json"
        core.put_object(Bucket=settings.s3_bucket, Key=pending, Body=b"pending upload")
        core.put_object(Bucket=settings.s3_bucket, Key=intelligence, Body=b"synthetic derived evidence")
        assert core.list_objects_v2(Bucket=settings.s3_bucket, Prefix="processing/fixture/intelligence/")["KeyCount"] == 1
        core.delete_object(Bucket=settings.s3_bucket, Key=intelligence)
        with pytest.raises(ClientError):
            worker.get_object(Bucket=settings.s3_bucket, Key=pending)
        smoke.negatives(smoke.endpoint(settings.s3_endpoint_url, "https", 443), pki / "ca.crt", pki / "rogue-ca.crt")
        smoke.plaintext_rejected(smoke.endpoint(settings.s3_endpoint_url, "https", 443), "http")
        # Exercise Docker's actual network boundary, not merely Compose rendering.
        network = json.loads(transport.docker("inspect", "--format", "{{json .NetworkSettings}}", topology["backend"]))
        assert set(network["Networks"]) == {topology["private_network"]}
        assert not any((network.get("Ports") or {}).values())
        address = network["Networks"][topology["private_network"]]["IPAddress"]
        blocked = subprocess.run(["docker", "run", "--rm", "--network", topology["client_network"],
            "--mount", f"type=bind,src={pki / 'ca.crt'},dst=/test-ca.crt,readonly",
            "--entrypoint", "curl", "nginx:1.28-alpine", "--silent", "--show-error", "--connect-timeout", "2", "--max-time", "4",
            "--cacert", "/test-ca.crt", "--connect-to", f"localhost:9000:{address}:9000", "https://localhost:9000/health"],
            capture_output=True, text=True, timeout=15)
        assert blocked.returncode in (7, 28), blocked.stderr  # network denial, not a TLS/hostname failure
        assert core.get_object(Bucket=settings.s3_bucket, Key=result)["Body"].read() == b"immutable"
        java = subprocess.run(["mvn", "-q", "-Dtest=WorkerStorageBoundaryIntegrationTests", "test"],
            cwd=transport.ROOT / "services/api", capture_output=True, text=True, timeout=180,
            env=dict(os.environ, E2E03_STORAGE_FIXTURE="true", E2E03_STORAGE_ENDPOINT=settings.s3_endpoint_url,
                E2E03_STORAGE_CA=str(pki / "ca.crt"), E2E03_STORAGE_BUCKET=settings.s3_bucket,
                E2E03_WORKER_KEY="e2e03-worker", E2E03_CORE_KEY="e2e03-core", E2E03_STORAGE_SECRET=password))
        assert java.returncode == 0, java.stdout + java.stderr
    finally:
        root.close()
        for client in clients:
            client.close()


def test_result_survives_broker_publication_failure_and_client_restart(storage_boundary, services):
    settings, _, _ = storage_boundary
    broker_settings, _, _ = services
    key = f"processing/{uuid.uuid4()}/transcription/results/{uuid.uuid4()}.json"
    raw = b"synthetic corrected-result persistence evidence"
    with closing(storage_client(settings)) as client:
        client.put_object(Bucket=settings.s3_bucket, Key=key, Body=raw, IfNoneMatch="*")

    async def failed_publication():
        connection = await connect(broker_settings)
        try:
            channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
            with pytest.raises(aio_pika.exceptions.DeliveryError):
                await channel.default_exchange.publish(aio_pika.Message(b"synthetic event reference",
                    message_id=str(uuid.uuid4()), delivery_mode=aio_pika.DeliveryMode.PERSISTENT),
                    "fixture.missing", mandatory=True)
        finally:
            await connection.close()
    asyncio.run(failed_publication())
    # A fresh client/process view recovers the original durable bytes after failure.
    with closing(storage_client(settings)) as client:
        assert client.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read() == raw
        with pytest.raises(ClientError) as conflict:
            client.put_object(Bucket=settings.s3_bucket, Key=key, Body=b"replacement", IfNoneMatch="*")
        assert conflict.value.response["ResponseMetadata"]["HTTPStatusCode"] == 412
        assert client.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read() == raw
