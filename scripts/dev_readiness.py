#!/usr/bin/env python3
"""Small readiness probes for dev.sh.

The probes return only status.  They do not print environment values or
application responses.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import socket
import ssl
import stat
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit


class ReadinessError(RuntimeError):
    """A bounded readiness probe could not complete."""


_KEY = re.compile(r"[A-Z][A-Z0-9_]*\Z")
_MAX_ENVIRONMENT_BYTES = 1_048_576
_MAX_RESPONSE_BYTES = 64 * 1024
_EXTERNAL_AI_CLIENT_IDENTITY = "urn:sme:service:core-api"


def _decode_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        if value[0] == "'":
            return value[1:-1]
        try:
            decoded = ast.literal_eval(value)
        except (SyntaxError, ValueError) as error:
            raise ReadinessError("AI API environment contains an invalid value") from error
        if not isinstance(decoded, str):
            raise ReadinessError("AI API environment contains an invalid value")
        return decoded
    return value


def _read_environment(path: Path) -> dict[str, str]:
    try:
        info = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_size > _MAX_ENVIRONMENT_BYTES
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
        ):
            raise ReadinessError("AI API environment is not a private regular file")
        lines = path.read_text(encoding="utf-8").splitlines()
    except ReadinessError:
        raise
    except (OSError, UnicodeError) as error:
        raise ReadinessError("AI API environment is unavailable") from error

    values: dict[str, str] = {}
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            raise ReadinessError("AI API environment contains an invalid line")
        name, raw = line.split("=", 1)
        if _KEY.fullmatch(name) is None or name in values or "\x00" in raw:
            raise ReadinessError("AI API environment contains an unsafe setting")
        values[name] = _decode_value(raw)
    return values


def _external_ai_endpoint(value: str) -> tuple[str, str, int]:
    try:
        parts = urlsplit(value)
        hostname = parts.hostname
        port = parts.port or 443
    except ValueError as error:
        raise ReadinessError("external AI endpoint is invalid") from error
    if (
        parts.scheme != "https"
        or hostname != "localhost"
        or parts.username
        or parts.password
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise ReadinessError("external AI endpoint must be https://localhost:<port>")
    if not 1 <= port <= 65535:
        raise ReadinessError("external AI endpoint port is invalid")
    return hostname, "127.0.0.1", port


def _private_file(path: Path, *, private: bool) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise ReadinessError("external AI TLS material is unavailable") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_size > _MAX_ENVIRONMENT_BYTES
        or info.st_mode & 0o022
    ):
        raise ReadinessError("external AI TLS material is unsafe")
    if private and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise ReadinessError("external AI client key is not private")


def _certificate_identity(path: Path, expected: str) -> None:
    try:
        certificate = ssl._ssl._test_decode_cert(str(path))
    except (OSError, ssl.SSLError, ValueError) as error:
        raise ReadinessError("external AI client certificate is unavailable") from error
    identities = [
        value for kind, value in certificate.get("subjectAltName", ()) if kind == "URI"
    ]
    if identities != [expected]:
        raise ReadinessError("external AI client certificate identity is invalid")


def _validate_ready_response(response: bytes) -> None:
    if len(response) > _MAX_RESPONSE_BYTES:
        raise ReadinessError("external AI readiness response is too large")
    header_end = response.find(b"\r\n\r\n")
    if header_end < 0:
        raise ReadinessError("external AI did not return an HTTP response")
    header_lines = response[:header_end].split(b"\r\n")
    if not header_lines:
        raise ReadinessError("external AI did not return an HTTP response")
    status = header_lines[0].decode("ascii", errors="replace").split(" ", 2)
    if len(status) < 2 or status[0] not in {"HTTP/1.0", "HTTP/1.1"} or status[1] != "200":
        raise ReadinessError("external AI readiness endpoint is not ready")

    headers: dict[str, str] = {}
    try:
        for raw_header in header_lines[1:]:
            name, value = raw_header.decode("ascii").split(":", 1)
            name = name.lower().strip()
            if not name or name in headers:
                raise ValueError
            headers[name] = value.strip()
    except (UnicodeDecodeError, ValueError) as error:
        raise ReadinessError("external AI returned malformed HTTP headers") from error
    content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        raise ReadinessError("external AI readiness response is not application JSON")
    if "content-length" in headers:
        try:
            content_length = int(headers["content-length"], 10)
        except ValueError as error:
            raise ReadinessError("external AI returned an invalid content length") from error
        if content_length < 0 or content_length != len(response) - header_end - 4:
            raise ReadinessError("external AI returned an incomplete response")

    try:
        payload = json.loads(response[header_end + 4 :].decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise ReadinessError("external AI readiness response is not valid JSON") from error
    if not isinstance(payload, dict) or payload.get("status") != "ready":
        raise ReadinessError("external AI readiness endpoint is not ready")


def _probe_https_ready(
    *,
    host: str,
    connect_host: str,
    port: int,
    ca_file: Path,
    client_cert: Path,
    client_key: Path,
    timeout: float,
) -> None:
    try:
        context = ssl.create_default_context(cafile=str(ca_file))
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.check_hostname = True
        context.load_cert_chain(certfile=str(client_cert), keyfile=str(client_key))
        with (
            socket.create_connection((connect_host, port), timeout=timeout) as raw,
            context.wrap_socket(raw, server_hostname=host) as secured,
        ):
            peer = secured.getpeercert()
            if not peer:
                raise ReadinessError("external AI server certificate is unavailable")
            server_identities = [
                value for kind, value in peer.get("subjectAltName", ()) if kind == "DNS"
            ]
            if server_identities != ["localhost"]:
                raise ReadinessError("external AI server certificate identity is invalid")
            secured.settimeout(timeout)
            secured.sendall(
                f"GET /health/ready HTTP/1.1\r\nHost: {host}:{port}\r\n"
                "Accept: application/json\r\nConnection: close\r\n\r\n".encode("ascii")
            )
            response = bytearray()
            while len(response) <= _MAX_RESPONSE_BYTES:
                chunk = secured.recv(min(4096, _MAX_RESPONSE_BYTES + 1 - len(response)))
                if not chunk:
                    break
                response.extend(chunk)
    except ReadinessError:
        raise
    except (OSError, ssl.SSLError, ValueError) as error:
        raise ReadinessError("external AI HTTPS/mTLS readiness probe failed") from error
    _validate_ready_response(bytes(response))


def probe_external_ai(api_file: Path, timeout: float = 5.0) -> None:
    if timeout <= 0:
        raise ReadinessError("external AI readiness timeout is invalid")
    values = _read_environment(api_file)
    if values.get("APP_TRANSPORT_AI_ENABLED", "").lower() != "true":
        raise ReadinessError("external AI transport is disabled")
    if values.get("APP_TRANSPORT_AI_PROBE", "").lower() != "true":
        raise ReadinessError("external AI application probe is disabled")
    host, connect_host, port = _external_ai_endpoint(
        values.get("APP_TRANSPORT_AI_BASE_URL", "")
    )
    ca_value = values.get("APP_TRANSPORT_AI_SERVER_CA", "")
    issuer_value = values.get("APP_TRANSPORT_AI_ISSUER_CA", "")
    certificate_value = values.get("APP_TRANSPORT_AI_CERTIFICATE", "")
    key_value = values.get("APP_TRANSPORT_AI_KEY", "")
    if not ca_value or not issuer_value or not certificate_value or not key_value:
        raise ReadinessError("external AI TLS settings are incomplete")
    ca_file = Path(ca_value)
    issuer_ca = Path(issuer_value)
    client_cert = Path(certificate_value)
    client_key = Path(key_value)
    _private_file(ca_file, private=False)
    _private_file(issuer_ca, private=False)
    try:
        ssl.create_default_context(cafile=str(issuer_ca))
    except (OSError, ssl.SSLError, ValueError) as error:
        raise ReadinessError("external AI client issuer CA is invalid") from error
    _private_file(client_cert, private=False)
    _private_file(client_key, private=True)
    _certificate_identity(client_cert, _EXTERNAL_AI_CLIENT_IDENTITY)
    _probe_https_ready(
        host=host,
        connect_host=connect_host,
        port=port,
        ca_file=ca_file,
        client_cert=client_cert,
        client_key=client_key,
        timeout=timeout,
    )


def _environment_port(path: Path, name: str) -> int:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise ReadinessError("generated readiness environment is unavailable") from error
    found: str | None = None
    for line in lines:
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if separator and key == name:
            if found is not None:
                raise ReadinessError("generated readiness environment is duplicated")
            found = value
    if found is None or re.fullmatch(r"[1-9][0-9]{0,4}", found) is None:
        raise ReadinessError("generated readiness port is invalid")
    port = int(found)
    if port > 65535:
        raise ReadinessError("generated readiness port is invalid")
    return port


def wait_listener(host: str, port: int, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=min(2.0, max(0.1, deadline - time.monotonic()))):
                return
        except OSError:
            time.sleep(0.25)
    raise ReadinessError("development listener did not become ready")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)

    port = subparsers.add_parser("port")
    port.add_argument("--file", required=True, type=Path)
    port.add_argument("--name", required=True)

    listener = subparsers.add_parser("wait-listener")
    listener.add_argument("--host", required=True)
    listener.add_argument("--port", required=True, type=int)
    listener.add_argument("--timeout", type=float, default=60)

    probe_ai = subparsers.add_parser("probe-ai")
    probe_ai.add_argument("--api-file", required=True, type=Path)
    probe_ai.add_argument("--timeout", type=float, default=5)

    args = parser.parse_args()
    try:
        if args.action == "port":
            print(_environment_port(args.file, args.name))
        elif args.action == "wait-listener":
            if not 1 <= args.port <= 65535 or args.timeout <= 0:
                raise ReadinessError("readiness probe arguments are invalid")
            wait_listener(args.host, args.port, args.timeout)
        else:
            probe_external_ai(args.api_file, args.timeout)
            print("PASS: externally managed AI HTTP HTTPS/mTLS readiness verified")
    except ReadinessError as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
