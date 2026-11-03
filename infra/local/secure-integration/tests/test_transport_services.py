"""Opt-in real RabbitMQ/RustFS with EPHEMERAL PKI, RAM data and isolated ports.

This is not acceptance of the approved shared Development CA environment.
Only these test-owned --rm containers are stopped; no volumes/topology are removed.
"""
import asyncio
import importlib.util
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import boto3
import pytest
from botocore.config import Config
from pydantic import SecretStr

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("secure_smoke", HERE / "smoke.py")
smoke = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = smoke
spec.loader.exec_module(smoke)


def docker(*args):
    return subprocess.check_output(["docker", *args], stderr=subprocess.PIPE, text=True, timeout=120).strip()


@pytest.fixture(scope="module")
def services(tmp_path_factory):
    if os.environ.get("E2E01_DOCKER_FIXTURES") != "true":
        pytest.skip("BLOCKED: explicitly enable E2E01_DOCKER_FIXTURES for isolated real broker/storage")
    if not shutil.which("setfacl"):
        pytest.skip("BLOCKED: ACL utilities required for non-root certificate mounts")
    spec = importlib.util.spec_from_file_location("fixture_tls", ROOT / "services/ai/tests/tls_support.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    base = tmp_path_factory.mktemp("transport")
    pki = helper.create_test_pki(base)
    # SAN deliberately excludes the IP for real SDK hostname-mismatch negatives.
    (pki / "server.ext").write_text("basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n")
    subprocess.run(["openssl", "x509", "-req", "-in", str(pki / "server.csr"), "-CA", str(pki / "ca.crt"),
        "-CAkey", str(pki / "ca.key"), "-CAcreateserial", "-days", "1", "-extfile", str(pki / "server.ext"),
        "-out", str(pki / "server.crt")], check=True, capture_output=True)
    runtime = base / "runtime"
    runtime.mkdir(mode=0o700)
    for source, target in (("server.crt", "tls.crt"), ("server.key", "tls.key"), ("ca.crt", "issuer-ca.crt"),
                           ("server.crt", "rustfs_cert.pem"), ("server.key", "rustfs_key.pem")):
        shutil.copyfile(pki / source, runtime / target)
        (runtime / target).chmod(0o600)
        subprocess.run(["setfacl", "-m", "u:999:r,u:10001:r", str(runtime / target)], check=True)
    subprocess.run(["setfacl", "-m", "u:999:rx,u:10001:rx", str(runtime)], check=True)
    password = uuid.uuid4().hex
    suffix = uuid.uuid4().hex[:10]
    names = []
    # Environment passes via subprocess, never on the docker CLI or into Git.
    env = dict(os.environ, RABBITMQ_DEFAULT_USER="fixture", RABBITMQ_DEFAULT_PASS=password,
               RABBITMQ_DEFAULT_VHOST="sme-integration", RUSTFS_ACCESS_KEY="fixture", RUSTFS_SECRET_KEY=password)
    try:
        for name, image, port, options, command in (
            ("e2e01-broker-" + suffix, "rabbitmq:4.1-management", "5671", [
                "--tmpfs", "/var/lib/rabbitmq:uid=999,gid=999,mode=0700",
                "--mount", f"type=bind,src={HERE / 'rabbitmq.conf'},dst=/etc/rabbitmq/rabbitmq.conf,readonly",
                "--mount", f"type=bind,src={HERE / 'enabled_plugins'},dst=/etc/rabbitmq/enabled_plugins,readonly",
                "--mount", f"type=bind,src={runtime},dst=/run/secrets/broker,readonly",
                "-e", "RABBITMQ_DEFAULT_USER", "-e", "RABBITMQ_DEFAULT_PASS", "-e", "RABBITMQ_DEFAULT_VHOST"], []),
            ("e2e01-storage-" + suffix, "rustfs/rustfs:1.0.3", "9000", [
                "--tmpfs", "/data:uid=10001,gid=10001,mode=0700",
                "--mount", f"type=bind,src={runtime},dst=/run/secrets/storage,readonly",
                "-e", "RUSTFS_ACCESS_KEY", "-e", "RUSTFS_SECRET_KEY", "-e", "RUSTFS_CONSOLE_ENABLE=false",
                "-e", "RUSTFS_TLS_PATH=/run/secrets/storage"], ["/data"]),
        ):
            subprocess.run(["docker", "run", "--rm", "-d", "--name", name, "-p", f"127.0.0.1::{port}",
                            *options, image, *command], env=env, check=True, capture_output=True, timeout=120)
            names.append(name)
        broker_port = int(docker("port", names[0], "5671/tcp").rsplit(":", 1)[1])
        storage_port = int(docker("port", names[1], "9000/tcp").rsplit(":", 1)[1])
        settings = smoke.Settings(_env_file=None, rabbitmq_url=f"amqps://localhost:{broker_port}/sme-integration",
            rabbitmq_ca_file=pki / "ca.crt", rabbitmq_username=SecretStr("fixture"), rabbitmq_password=SecretStr(password),
            s3_endpoint_url=f"https://localhost:{storage_port}", s3_ca_file=pki / "ca.crt", s3_bucket="transport-fixture",
            s3_access_key_id=SecretStr("fixture"), s3_secret_access_key=SecretStr(password))
        for _ in range(90):
            try:
                smoke.verified_socket(smoke.Endpoint("localhost", broker_port), pki / "ca.crt")
                smoke.verified_socket(smoke.Endpoint("localhost", storage_port), pki / "ca.crt")
                break
            except (OSError, ValueError):
                time.sleep(1)
        else:
            pytest.fail("Isolated real RabbitMQ/RustFS TLS listeners did not start")
        # Synthetic setup only in RAM-backed isolated fixture; no live bucket is changed.
        client = boto3.client("s3", endpoint_url=settings.s3_endpoint_url, verify=str(pki / "ca.crt"),
            aws_access_key_id="fixture", aws_secret_access_key=password, region_name="us-east-1",
            config=Config(s3={"addressing_style": "path"}, retries={"total_max_attempts": 1}))
        client.create_bucket(Bucket=settings.s3_bucket)
        client.put_object(Bucket=settings.s3_bucket, Key="transport.txt", Body=b"synthetic TLS fixture")
        client.close()
        yield settings, pki
    finally:
        for name in reversed(names):
            # --rm may already have removed a failed fixture. Do not mask the
            # actual startup failure with a second cleanup exception.
            subprocess.run(["docker", "stop", "--time", "5", name], capture_output=True, timeout=20)


def test_actual_python_stacks_and_tls_negatives(services, monkeypatch):
    settings, pki = services
    monkeypatch.setenv("E2E01_STORAGE_PROBE_KEY", "transport.txt")
    for target, ca, protocol in ((asyncio.run(smoke.broker(settings)), settings.rabbitmq_ca_file, "amqp"),
                                (smoke.storage(settings), settings.s3_ca_file, "http")):
        smoke.negatives(target, ca, pki / "rogue-ca.crt")
        smoke.plaintext_rejected(target, protocol)


def test_actual_java_broker_and_aws_stacks(services):
    settings, pki = services
    env = dict(os.environ, E2E01_INFRA_FIXTURE="true", RABBITMQ_HOST="localhost",
        RABBITMQ_PORT=str(smoke.endpoint(settings.rabbitmq_url, "amqps", 5671).port), RABBITMQ_VIRTUAL_HOST="sme-integration",
        RABBITMQ_USERNAME="fixture", RABBITMQ_PASSWORD=settings.rabbitmq_password.get_secret_value(),
        RABBITMQ_CA_FILE=str(settings.rabbitmq_ca_file), APP_MEDIA_STORAGE_ENDPOINT=settings.s3_endpoint_url,
        APP_MEDIA_STORAGE_REGION="us-east-1", APP_MEDIA_STORAGE_BUCKET=settings.s3_bucket,
        APP_MEDIA_STORAGE_ACCESS_KEY="fixture", APP_MEDIA_STORAGE_SECRET_KEY=settings.s3_secret_access_key.get_secret_value(),
        APP_MEDIA_STORAGE_CA_FILE=str(settings.s3_ca_file), E2E01_STORAGE_PROBE_KEY="transport.txt",
        E2E01_WRONG_CA_FILE=str(pki / "rogue-ca.crt"), E2E01_WRONG_BROKER_HOST="127.0.0.1",
        E2E01_WRONG_STORAGE_URL=settings.s3_endpoint_url.replace("localhost", "127.0.0.1"))
    result = subprocess.run(["mvn", "-q", "-Dtest=LiveSecureTransportTests#javaAmqpsHandshakeAndLogin+javaAwsSdkVerifiedHttpsRead+javaBrokerAndStorageRejectWrongTrustAndHostname", "test"],
        cwd=ROOT / "services/api", env=env, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr
