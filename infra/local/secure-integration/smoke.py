#!/usr/bin/env python3
"""Read-only live transport checks. No transcription, topology changes or object writes.

Run using the AI locked virtualenv. SDK checks use aio-pika and the existing
ObjectStorage adapter; TLS negatives connect to the actual host with explicit SNI.
"""
import argparse
import asyncio
import socket
import ssl
import sys
from dataclasses import dataclass
from urllib.parse import unquote, urlsplit

import aio_pika
import httpx

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.integrations.object_storage import ObjectStorage


@dataclass(frozen=True)
class Endpoint:
    host: str
    port: int


def endpoint(url, scheme, port):
    value = urlsplit(url or "")
    if value.scheme != scheme or not value.hostname or value.username or value.password or value.query or value.fragment:
        raise ValueError("secure endpoint required")
    return Endpoint(value.hostname, value.port or port)


def context(ca):
    if ca is None:
        raise ValueError("explicit CA required")
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_verify_locations(cafile=str(ca))
    assert tls.check_hostname and tls.verify_mode == ssl.CERT_REQUIRED
    return tls


def verified_socket(target, ca, *, name=None, cert=None, key=None):
    tls = context(ca)
    if cert:
        tls.load_cert_chain(cert, key)
    with socket.create_connection((target.host, target.port), timeout=4) as raw:
        with tls.wrap_socket(raw, server_hostname=name or target.host) as secured:
            if secured.version() not in ("TLSv1.2", "TLSv1.3"):
                raise AssertionError("obsolete TLS negotiated")


def negatives(target, ca, wrong_ca, *, cert=None, key=None):
    for root, name in ((wrong_ca, target.host), (ca, "hostname-mismatch.invalid")):
        try:
            verified_socket(target, root, name=name, cert=cert, key=key)
        except ssl.SSLCertVerificationError:
            continue
        # DNS/connect errors are NOT evidence of certificate rejection.
        raise AssertionError("wrong CA or hostname accepted")


async def broker(settings):
    target = endpoint(settings.rabbitmq_url, "amqps", 5671)
    parsed = urlsplit(settings.rabbitmq_url)
    connection = await aio_pika.connect(host=target.host, port=target.port, ssl=True,
        ssl_context=context(settings.rabbitmq_ca_file),
        login=settings.rabbitmq_username.get_secret_value(),
        password=settings.rabbitmq_password.get_secret_value(),
        virtualhost=unquote(parsed.path[1:]) if parsed.path not in ("", "/") else "/", timeout=5)
    try:
        channel = await connection.channel()
        await channel.close()
    finally:
        await connection.close()
    print("PASS real RabbitMQ aio-pika AMQPS verified handshake/login (no topology mutation)")
    return target


def storage(settings):
    import os
    target = endpoint(settings.s3_endpoint_url, "https", 443)
    context(settings.s3_ca_file)
    key = os.environ["E2E01_STORAGE_PROBE_KEY"]
    with ObjectStorage(settings) as adapter:
        adapter.client.head_object(Bucket=settings.s3_bucket, Key=key)
    print("PASS real S3 boto3 HTTPS verified HEAD of operator-provisioned synthetic object")
    return target


def worker(settings, public_url, wrong_cert=None, wrong_key=None):
    target = endpoint(settings.core_api_base_url, "https", 443)
    tls = context(settings.core_api_server_ca_file)
    tls.load_cert_chain(settings.core_api_client_cert_file, settings.core_api_client_key_file)
    # Nonmutating V1 lookup of synthetic IDs: E2E-01 has no business controller.
    path = ("/internal/v1/worker/processing-jobs/11111111-1111-4111-8111-111111111111"
            "/transcription/deliveries/22222222-2222-4222-8222-222222222222")
    spoof = {"X-Service-Identity": "urn:sme:service:ai-worker", "X-Forwarded-Proto": "https",
             "X-Forwarded-Client-Cert": "URI=urn:sme:service:ai-worker", "Authorization": "Bearer forged"}
    with httpx.Client(verify=tls, trust_env=False, timeout=5) as client:
        result = client.get(settings.core_api_base_url + path, headers=spoof)
        if result.status_code != 404:
            raise AssertionError("expected E2E-01 authenticated lookup to reach missing controller (404)")
        if client.post(settings.core_api_base_url + "/internal/admin", headers=spoof).status_code != 403:
            raise AssertionError("unauthorized operation accepted")
    with httpx.Client(trust_env=False, timeout=5) as client:
        # Public URL may be loopback HTTP, or verified HTTPS ingress with explicit CA.
        if urlsplit(public_url).scheme != "http" or urlsplit(public_url).hostname not in ("localhost", "127.0.0.1"):
            raise ValueError("public smoke URL must be the loopback public connector")
        for private_path in (path, "/internal/api/v1/meeting-intelligence/results/accept"):
            if client.get(public_url.rstrip("/") + private_path, headers=spoof).status_code != 403:
                raise AssertionError("public connector exposes internal route")
    no_certificate = context(settings.core_api_server_ca_file)
    try:
        with httpx.Client(verify=no_certificate, trust_env=False, timeout=5) as client:
            client.get(settings.core_api_base_url + path, headers=spoof)
    except httpx.TransportError:
        pass
    else:
        raise AssertionError("missing client certificate accepted")
    if wrong_cert:
        wrong = context(settings.core_api_server_ca_file)
        wrong.load_cert_chain(wrong_cert, wrong_key)
        with httpx.Client(verify=wrong, trust_env=False, timeout=5) as client:
            if client.get(settings.core_api_base_url + path, headers=spoof).status_code not in (401, 403):
                raise AssertionError("incorrect service identity accepted")
        print("PASS real Core incorrect identity/header spoof rejection")
    else:
        print("BLOCKED real Core wrong-identity check: supply approved non-worker --wrong-client-cert/key")
    print("PASS real Core worker mTLS, missing-certificate rejection, operation denial and public isolation")
    return target


def plaintext_rejected(target, protocol):
    with socket.create_connection((target.host, target.port), timeout=4) as raw:
        raw.settimeout(4)
        raw.sendall(b"AMQP\x00\x00\x09\x01" if protocol == "amqp" else b"GET /health HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n")
        try:
            response = raw.recv(1024)
        except (ConnectionResetError, TimeoutError):
            response = b""
        if response.startswith(b"AMQP") or response.startswith(b"HTTP/1.1 200") or response.startswith(b"HTTP/1.0 200"):
            raise AssertionError("plaintext accepted on TLS endpoint")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--infrastructure", action="store_true")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--public-url", default="http://127.0.0.1:8080")
    parser.add_argument("--wrong-ca", help="external unrelated CA for live negative checks")
    parser.add_argument("--wrong-client-cert")
    parser.add_argument("--wrong-client-key")
    args = parser.parse_args()
    if not args.infrastructure and not args.worker:
        parser.error("select --infrastructure and/or --worker")
    settings = Settings(_env_file=None)
    targets = []
    if args.infrastructure:
        targets += [(asyncio.run(broker(settings)), settings.rabbitmq_ca_file, "amqp", None, None),
                    (storage(settings), settings.s3_ca_file, "http", None, None)]
    if args.worker:
        targets += [(worker(settings, args.public_url, args.wrong_client_cert, args.wrong_client_key),
                     settings.core_api_server_ca_file, "http", settings.core_api_client_cert_file,
                     settings.core_api_client_key_file)]
    for target, ca, protocol, cert, key in targets:
        verified_socket(target, ca, cert=cert, key=key)
        plaintext_rejected(target, protocol)
        if args.wrong_ca:
            negatives(target, ca, args.wrong_ca, cert=cert, key=key)
        else:
            print("BLOCKED live wrong-CA/hostname negatives: supply --wrong-ca")
    print("PASS requested live positive and plaintext-rejection checks")
    # Partial checks are never reported as a complete live acceptance run.
    return 0 if args.wrong_ca and (not args.worker or args.wrong_client_cert) else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        print("FAIL live transport check; inspect local configuration/service logs without sharing secrets", file=sys.stderr)
        raise SystemExit(1) from None
