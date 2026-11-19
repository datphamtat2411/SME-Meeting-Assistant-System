#!/usr/bin/env python3
"""Read-only Core, AI, RabbitMQ and object-storage observations.

These adapters perform a bounded operation against one already provisioned
isolated endpoint and write only a sanitized source record plus a contract
receipt.  They never create queues, upload/download objects, consume business
messages, mutate application state, or retain response payloads.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import http.client
import json
import math
import os
import re
import socket
import ssl
import stat
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlsplit, urlunsplit
from uuid import UUID

from observation_receipts import Observation, ReceiptWriter
from preflight import Blocked

MAX_JSON_BYTES = 64 * 1024
_COMPONENTS = frozenset({"CORE", "AI"})
_SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
_SAFE_PATH = re.compile(r"/[A-Za-z0-9_./:{}-]{0,511}\Z")
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_LOOPBACK_DESTINATION = "127.0.0.1"
_RABBIT_TLS_NAME = "rabbitmq.internal"
_STORAGE_TLS_NAME = "storage.internal"
_DNS_NAME = re.compile(
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\Z"
)
_UNSAFE_FIELD = re.compile(
    r"password|privatekey|clientkey|secret|accesstoken|refreshtoken|"
    r"authorization|presigned|signedurl|audio|transcripttext|prompt|rawcontent",
    re.IGNORECASE,
)


class ObserverBlocked(Blocked):
    """A boundary could not be observed safely."""


def _no_symlink(path: Path) -> None:
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ObserverBlocked("Observer material cannot be symbolic")


def _file(path: Path, *, private: bool = False) -> Path:
    path = Path(path)
    _no_symlink(path)
    try:
        info = path.stat()
    except OSError as error:
        raise ObserverBlocked("Observer material is unavailable") from error
    prohibited = 0o077 if private else 0o022
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
        or info.st_mode & prohibited
        or not 0 < info.st_size <= 1_048_576
    ):
        raise ObserverBlocked("Observer material is not owner-controlled")
    return path


def _endpoint(
    value: str,
    scheme: str,
    *,
    allow_path: bool = False,
    tls_server_name: str | None = None,
) -> tuple[str, int, str]:
    if not isinstance(value, str) or len(value) > 256:
        raise ObserverBlocked("Observer endpoint is invalid")
    parts = urlsplit(value)
    try:
        port = parts.port
    except ValueError as error:
        raise ObserverBlocked("Observer endpoint port is invalid") from error
    if (
        parts.scheme != scheme
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or (not allow_path and parts.path not in ("", "/"))
        or parts.hostname != _LOOPBACK_DESTINATION
        or port is None
    ):
        raise ObserverBlocked("Observer endpoint must be a private TLS loopback endpoint")
    if not 1 <= port <= 65535:
        raise ObserverBlocked("Observer endpoint port is invalid")
    server_name = tls_server_name or parts.hostname
    if (
        not isinstance(server_name, str)
        or len(server_name) > 253
        or _DNS_NAME.fullmatch(server_name) is None
    ):
        raise ObserverBlocked("Observer TLS server identity is invalid")
    return parts.hostname, port, server_name


def _path(value: str) -> str:
    if (
        not isinstance(value, str)
        or _SAFE_PATH.fullmatch(value) is None
        or "?" in value
        or "#" in value
        or any(part == ".." for part in value.split("/"))
    ):
        raise ObserverBlocked("Observer operation path is invalid")
    return value


def _request_id(value: object) -> str:
    if not isinstance(value, str):
        raise ObserverBlocked("Observer request ID is invalid")
    try:
        canonical = str(UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise ObserverBlocked("Observer request ID is invalid") from error
    if canonical != value:
        raise ObserverBlocked("Observer request ID is invalid")
    return canonical


def _run_id(value: object) -> str:
    if not isinstance(value, str):
        raise ObserverBlocked("Observer run ID is invalid")
    try:
        canonical = str(UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise ObserverBlocked("Observer run ID is invalid") from error
    if canonical != value:
        raise ObserverBlocked("Observer run ID is invalid")
    return canonical


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _tls_context(
    ca_file: Path,
    client_cert: Path | None = None,
    client_key: Path | None = None,
) -> ssl.SSLContext:
    if (client_cert is None) != (client_key is None):
        raise ObserverBlocked("Observer client certificate and key are both required")
    _file(ca_file)
    if client_cert is not None:
        _file(client_cert)
    if client_key is not None:
        _file(client_key, private=True)
    try:
        context = ssl.create_default_context(cafile=str(ca_file))
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        if client_cert is not None and client_key is not None:
            context.load_cert_chain(str(client_cert), str(client_key))
    except (OSError, ValueError, ssl.SSLError) as error:
        raise ObserverBlocked("Observer TLS material is invalid") from error
    return context


def _probe_tls(
    endpoint: str,
    ca_file: Path,
    leaf_sha256: str,
    tls_server_name: str | None = None,
    *,
    client_cert: Path | None = None,
    client_key: Path | None = None,
    allow_path: bool = False,
) -> None:
    connect_host, port, server_name = _endpoint(
        endpoint,
        "https",
        allow_path=allow_path,
        tls_server_name=tls_server_name,
    )
    if _DIGEST.fullmatch(leaf_sha256 or "") is None:
        raise ObserverBlocked("A run-owned TLS leaf digest is required")
    context = _tls_context(ca_file, client_cert, client_key)
    raw = None
    wrapped = None
    try:
        raw = socket.create_connection((connect_host, port), timeout=10)
        wrapped = context.wrap_socket(raw, server_hostname=server_name)
        raw = None
        peer = wrapped.getpeercert(binary_form=True)
        if not isinstance(peer, bytes) or not hmac.compare_digest(
            hashlib.sha256(peer).hexdigest(), leaf_sha256
        ):
            raise ObserverBlocked("Observer TLS leaf is not owned by this run")
    except ObserverBlocked:
        raise
    except (OSError, ssl.SSLError) as error:
        raise ObserverBlocked("Observer TLS probe failed") from error
    finally:
        if wrapped is not None:
            wrapped.close()
        if raw is not None:
            raw.close()


@dataclass(frozen=True)
class HttpEndpoint:
    url: str
    ca_file: Path
    client_cert: Path
    client_key: Path
    leaf_sha256: str
    tls_server_name: str | None = None
    http_host: str | None = None

    def __post_init__(self) -> None:
        _connect_host, _port, server_name = _endpoint(
            self.url,
            "https",
            tls_server_name=self.tls_server_name,
        )
        http_host = self.http_host or server_name
        if _DNS_NAME.fullmatch(http_host or "") is None:
            raise ObserverBlocked("Observer HTTP host identity is invalid")
        if _DIGEST.fullmatch(self.leaf_sha256 or "") is None:
            raise ObserverBlocked("A run-owned HTTPS leaf digest is required")


class _PinnedHttpConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        *,
        connect_host: str,
        tls_server_name: str,
        http_host: str,
        port: int,
        context: ssl.SSLContext,
        leaf_sha256: str,
    ):
        super().__init__(http_host, port=port, timeout=10, context=context)
        self._connect_host = connect_host
        self._tls_server_name = tls_server_name
        self._expected_leaf = leaf_sha256

    def connect(self) -> None:
        raw = socket.create_connection((self._connect_host, self.port), self.timeout)
        try:
            wrapped = self._context.wrap_socket(
                raw,
                server_hostname=self._tls_server_name,
            )
        except Exception:
            raw.close()
            raise
        try:
            peer = wrapped.getpeercert(binary_form=True)
            digest = hashlib.sha256(peer).hexdigest() if isinstance(peer, bytes) else ""
            if not hmac.compare_digest(digest, self._expected_leaf):
                raise ObserverBlocked("Observer TLS leaf is not owned by this run")
        except Exception:
            wrapped.close()
            raise
        self.sock = wrapped


def _new_http_connection(endpoint: HttpEndpoint) -> _PinnedHttpConnection:
    connect_host, port, server_name = _endpoint(
        endpoint.url,
        "https",
        tls_server_name=endpoint.tls_server_name,
    )
    context = _tls_context(endpoint.ca_file, endpoint.client_cert, endpoint.client_key)
    return _PinnedHttpConnection(
        connect_host=connect_host,
        tls_server_name=server_name,
        http_host=endpoint.http_host or server_name,
        port=port,
        context=context,
        leaf_sha256=endpoint.leaf_sha256,
    )


@dataclass(frozen=True)
class JsonCheck:
    name: str
    path: tuple[str, ...]
    expected: object

    def __post_init__(self) -> None:
        if _SAFE_NAME.fullmatch(self.name or "") is None:
            raise ObserverBlocked("Observer response check name is invalid")
        if (
            not isinstance(self.path, tuple)
            or not self.path
            or any(
                type(item) is not str
                or _SAFE_NAME.fullmatch(item) is None
                or _UNSAFE_FIELD.search(item)
                for item in self.path
            )
        ):
            raise ObserverBlocked("Observer response check path is invalid")
        if not (
            self.expected is None
            or type(self.expected) in (bool, int, str)
            or (
                type(self.expected) is float
                and math.isfinite(self.expected)
            )
        ):
            raise ObserverBlocked("Observer response check value is invalid")


def _lookup(document: object, path: tuple[str, ...]) -> object:
    current = document
    for name in path:
        if not isinstance(current, dict) or name not in current:
            raise ObserverBlocked("Observer response is missing a required field")
        current = current[name]
    return current


def _safe_source_fields(fields: Mapping[str, object]) -> dict[str, object]:
    if not isinstance(fields, Mapping):
        raise ObserverBlocked("Observer source fields are invalid")
    result = {}
    for key, value in fields.items():
        if (
            type(key) is not str
            or _SAFE_NAME.fullmatch(key) is None
            or _UNSAFE_FIELD.search(key)
            or not (
                value is None
                or type(value) in (bool, int, str)
                or (type(value) is float and math.isfinite(value))
            )
        ):
            raise ObserverBlocked("Observer source fields are not sanitized")
        if type(value) is str and len(value) > 512:
            raise ObserverBlocked("Observer source field is oversized")
        result[key] = value
    return result


class HttpBoundaryObserver:
    """Observe one read-only JSON response over pinned client-authenticated TLS."""

    def __init__(
        self,
        endpoint: HttpEndpoint,
        writer: ReceiptWriter,
        component: str,
        *,
        request_headers: Mapping[str, str] | None = None,
    ):
        if component not in _COMPONENTS:
            raise ObserverBlocked("HTTP observer component is invalid")
        if request_headers is not None and (
            not isinstance(request_headers, Mapping)
            or any(
                type(name) is not str
                or re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,63}", name) is None
                or type(value) is not str
                or "\x00" in value
                or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
                or name.lower() in {"accept", "cache-control", "x-request-id"}
                for name, value in request_headers.items()
            )
        ):
            raise ObserverBlocked("HTTP observer headers are invalid")
        self.endpoint = endpoint
        self.writer = writer
        self.component = component
        self.request_headers = dict(request_headers or {})

    def request_json(self, request_id: str, method: str, path: str) -> object:
        request_id = _request_id(request_id)
        if method != "GET":
            raise ObserverBlocked("HTTP observer permits GET only")
        path = _path(path)
        connection = _new_http_connection(self.endpoint)
        try:
            # Explicit connect pins the peer before any request headers are sent.
            connection.connect()
            connection.request(
                method,
                path,
                headers={
                    "Accept": "application/json",
                    "Cache-Control": "no-cache",
                    "X-Request-Id": request_id,
                    **self.request_headers,
                },
            )
            response = connection.getresponse()
            if response.status != 200:
                raise ObserverBlocked("Observed HTTP boundary did not return success")
            content_type = response.getheader("Content-Type", "")
            if content_type.split(";", 1)[0].strip().lower() != "application/json":
                raise ObserverBlocked("Observed HTTP response is not JSON")
            raw = response.read(MAX_JSON_BYTES + 1)
            if len(raw) > MAX_JSON_BYTES:
                raise ObserverBlocked("Observed HTTP response exceeds the bound")
            try:
                return json.loads(raw, object_pairs_hook=_unique_object)
            except (UnicodeDecodeError, ValueError, RecursionError) as error:
                raise ObserverBlocked("Observed HTTP response is not valid JSON") from error
        except ObserverBlocked:
            raise
        except (OSError, http.client.HTTPException, ValueError, TypeError) as error:
            raise ObserverBlocked("Observed HTTP boundary is unavailable") from error
        finally:
            connection.close()

    def observe(
        self,
        observation: Observation,
        *,
        operation: str,
        path: str,
        checks: tuple[JsonCheck, ...],
        source_fields: Mapping[str, object] | None = None,
    ) -> str:
        if not isinstance(observation, Observation) or observation.component != self.component:
            raise ObserverBlocked("Observation does not match the HTTP boundary")
        if _SAFE_NAME.fullmatch(operation or "") is None:
            raise ObserverBlocked("Observer operation is invalid")
        if not isinstance(checks, tuple) or not checks:
            raise ObserverBlocked("At least one response check is required")
        if (
            len({check.name for check in checks if isinstance(check, JsonCheck)}) != len(checks)
            or any(not isinstance(check, JsonCheck) for check in checks)
        ):
            raise ObserverBlocked("Observer response checks are repeated or invalid")
        path = _path(path)
        payload = self.request_json(observation.request_id, "GET", path)
        for check in checks:
            actual = _lookup(payload, check.path)
            if type(actual) is not type(check.expected) or actual != check.expected:
                raise ObserverBlocked("Observed HTTP response failed an acceptance check")
        source = {
            "contractVersion": "pi05-observer-source-v1",
            "boundary": self.component,
            "operation": operation,
            "endpointPath": path,
            "httpStatus": 200,
            "checks": [check.name for check in checks],
        }
        source.update(_safe_source_fields(source_fields or {}))
        return self.writer.write(observation, source)


class CoreObserver(HttpBoundaryObserver):
    def __init__(
        self,
        endpoint: HttpEndpoint,
        writer: ReceiptWriter,
        *,
        request_headers: Mapping[str, str] | None = None,
    ):
        super().__init__(
            endpoint, writer, "CORE", request_headers=request_headers,
        )


class AiObserver(HttpBoundaryObserver):
    def __init__(
        self,
        endpoint: HttpEndpoint,
        writer: ReceiptWriter,
        *,
        request_headers: Mapping[str, str] | None = None,
    ):
        super().__init__(
            endpoint, writer, "AI", request_headers=request_headers,
        )


@dataclass(frozen=True)
class StorageEndpoint:
    endpoint_url: str
    bucket: str
    access_key: str
    secret_key: str
    ca_file: Path
    leaf_sha256: str
    run_id: str
    object_prefix: str
    tls_server_name: str = _STORAGE_TLS_NAME
    http_host: str = _STORAGE_TLS_NAME

    def __post_init__(self) -> None:
        _endpoint(
            self.endpoint_url,
            "https",
            tls_server_name=self.tls_server_name,
        )
        run_id = _run_id(self.run_id)
        if (
            self.tls_server_name != _STORAGE_TLS_NAME
            or self.http_host != _STORAGE_TLS_NAME
            or not isinstance(self.bucket, str)
            or re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", self.bucket) is None
            or not any(
                token in self.bucket
                for token in (run_id, run_id.replace("-", ""))
            )
            or _DIGEST.fullmatch(self.leaf_sha256 or "") is None
            or not isinstance(self.object_prefix, str)
            or not self.object_prefix
            or len(self.object_prefix) > 256
            or "\x00" in self.object_prefix
            or self.object_prefix.startswith("/")
            or not re.fullmatch(r"[A-Za-z0-9._/-]+", self.object_prefix)
            or any(part == ".." for part in self.object_prefix.split("/"))
            or not isinstance(self.access_key, str)
            or not self.access_key.strip()
            or not isinstance(self.secret_key, str)
            or not self.secret_key.strip()
        ):
            raise ObserverBlocked("Storage observer endpoint is invalid")

    @property
    def tls_endpoint_url(self) -> str:
        """Return the boundary origin without changing the physical destination."""
        parts = urlsplit(self.endpoint_url)
        authority = self.http_host
        if parts.port is not None:
            authority += f":{parts.port}"
        return urlunsplit((
            parts.scheme,
            authority,
            parts.path,
            parts.query,
            parts.fragment,
        ))


def _new_storage_http_connection(
    endpoint: StorageEndpoint,
    *,
    leaf_sha256: str | None = None,
) -> _PinnedHttpConnection:
    connect_host, port, server_name = _endpoint(
        endpoint.endpoint_url,
        "https",
        tls_server_name=endpoint.tls_server_name,
    )
    context = _tls_context(endpoint.ca_file)
    return _PinnedHttpConnection(
        connect_host=connect_host,
        tls_server_name=server_name,
        http_host=endpoint.http_host,
        port=port,
        context=context,
        leaf_sha256=leaf_sha256 or endpoint.leaf_sha256,
    )


class StorageObserver:
    """Read object metadata only; no object body, list or mutation operation."""

    def __init__(
        self,
        endpoint: StorageEndpoint,
        writer: ReceiptWriter,
        *,
        client: Any | None = None,
    ):
        self.endpoint = endpoint
        self.writer = writer
        self.client = client

    def _head_object(self, key: str) -> dict[str, object]:
        try:
            from botocore.auth import SigV4Auth
            from botocore.awsrequest import AWSRequest
            from botocore.credentials import Credentials

            origin = urlsplit(self.endpoint.tls_endpoint_url)
            path = (
                "/"
                + quote(self.endpoint.bucket, safe="")
                + "/"
                + quote(key, safe="/-_.~")
            )
            url = urlunsplit((origin.scheme, origin.netloc, path, "", ""))
            headers = {"Host": self.endpoint.http_host}
            request = AWSRequest(method="HEAD", url=url, headers=headers)
            SigV4Auth(
                Credentials(self.endpoint.access_key, self.endpoint.secret_key),
                "s3",
                "us-east-1",
            ).add_auth(request)
            connection = _new_storage_http_connection(self.endpoint)
            try:
                connection.connect()
                connection.request(
                    "HEAD",
                    path,
                    headers={str(name): str(value) for name, value in request.headers.items()},
                )
                response = connection.getresponse()
                response.read(64 * 1024)
                if response.status != 200:
                    raise ObserverBlocked("Storage metadata observation was rejected")
                content_length = response.getheader("Content-Length")
                metadata = {
                    name[len("x-amz-meta-"):]: value
                    for name, value in response.getheaders()
                    if name.lower().startswith("x-amz-meta-")
                }
                result: dict[str, object] = {
                    "ContentLength": int(content_length) if content_length is not None else -1,
                    "Metadata": metadata,
                }
                content_type = response.getheader("Content-Type")
                if content_type is not None:
                    result["ContentType"] = content_type
                etag = response.getheader("ETag")
                if etag is not None:
                    result["ETag"] = etag
                return result
            finally:
                connection.close()
        except Exception as error:
            if isinstance(error, ObserverBlocked):
                raise
            raise ObserverBlocked("Storage observer client is unavailable") from error

    def observe_object(
        self,
        observation: Observation,
        *,
        key: str,
        expected_metadata: Mapping[str, str] | None = None,
        expected_size: int | None = None,
        expected_content_type: str | None = None,
    ) -> str:
        if not isinstance(observation, Observation) or observation.component != "STORAGE":
            raise ObserverBlocked("Observation does not match storage")
        if observation.run_id != self.endpoint.run_id:
            raise ObserverBlocked("Storage observation is outside the run")
        if (
            not isinstance(key, str)
            or not key.startswith(self.endpoint.object_prefix)
            or not key
            or len(key) > 1024
            or "\x00" in key
            or any(part == ".." for part in key.split("/"))
        ):
            raise ObserverBlocked("Storage object is outside the run prefix")
        expected = expected_metadata or {}
        if (
            not isinstance(expected, Mapping)
            or any(
                type(name) is not str
                or re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", name) is None
                or _UNSAFE_FIELD.search(name)
                or type(value) is not str
                or len(value) > 256
                for name, value in expected.items()
            )
        ):
            raise ObserverBlocked("Storage metadata expectation is invalid")
        if expected_size is not None and (type(expected_size) is not int or expected_size <= 0):
            raise ObserverBlocked("Storage size expectation is invalid")
        if expected_content_type is not None and (
            type(expected_content_type) is not str
            or not expected_content_type
            or len(expected_content_type) > 160
            or "\x00" in expected_content_type
        ):
            raise ObserverBlocked("Storage content type expectation is invalid")

        # Verify the peer before constructing a client with the access key.
        _probe_tls(
            self.endpoint.endpoint_url,
            self.endpoint.ca_file,
            self.endpoint.leaf_sha256,
            self.endpoint.tls_server_name,
        )
        try:
            try:
                if self.client is None:
                    response = self._head_object(key)
                else:
                    response = self.client.head_object(
                        Bucket=self.endpoint.bucket,
                        Key=key,
                    )
            except Exception as error:
                raise ObserverBlocked("Storage metadata observation failed") from error
            if not isinstance(response, Mapping):
                raise ObserverBlocked("Storage metadata response is invalid")
            content_length = response.get("ContentLength")
            if type(content_length) is not int or content_length < 0:
                raise ObserverBlocked("Storage metadata size is invalid")
            if expected_size is not None and content_length != expected_size:
                raise ObserverBlocked("Storage object size does not match")
            content_type = response.get("ContentType")
            if content_type is not None and (
                not isinstance(content_type, str) or len(content_type) > 160 or "\x00" in content_type
            ):
                raise ObserverBlocked("Storage content type is invalid")
            if expected_content_type is not None and content_type != expected_content_type:
                raise ObserverBlocked("Storage object content type does not match")
            metadata = response.get("Metadata", {})
            if not isinstance(metadata, Mapping):
                raise ObserverBlocked("Storage metadata map is invalid")
            if any(
                type(name) is not str
                or _UNSAFE_FIELD.search(name)
                or re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", name) is None
                or type(value) is not str
                or len(value) > 512
                for name, value in metadata.items()
            ):
                raise ObserverBlocked("Storage metadata contains a protected field")
            normalized = {name.lower(): value for name, value in metadata.items()}
            for name, value in expected.items():
                if normalized.get(name.lower()) != value:
                    raise ObserverBlocked("Storage object metadata does not match")
            etag = response.get("ETag")
            if etag is not None and (
                not isinstance(etag, str) or len(etag) > 256 or "\x00" in etag
            ):
                raise ObserverBlocked("Storage ETag is invalid")
            source = {
                "contractVersion": "pi05-observer-source-v1",
                "boundary": "STORAGE",
                "operation": "head-object",
                "endpoint": self.endpoint.endpoint_url,
                "bucket": self.endpoint.bucket,
                "objectKey": key,
                "contentLength": content_length,
                "metadataKeys": sorted(normalized),
                "matchedMetadataKeys": sorted(name.lower() for name in expected),
            }
            if content_type is not None:
                source["contentType"] = content_type
            if etag is not None:
                source["etagSha256"] = hashlib.sha256(etag.encode()).hexdigest()
            return self.writer.write(observation, source)
        except ObserverBlocked:
            raise
        except Exception as error:
            raise ObserverBlocked("Storage metadata observation failed") from error


@dataclass(frozen=True)
class RabbitEndpoint:
    url: str
    ca_file: Path
    username: str
    password: str
    leaf_sha256: str
    queue_name: str
    run_id: str
    tls_server_name: str = _RABBIT_TLS_NAME

    def __post_init__(self) -> None:
        host, _port, _server = _endpoint(
            self.url,
            "amqps",
            allow_path=True,
            tls_server_name=self.tls_server_name,
        )
        parts = urlsplit(self.url)
        run_id = _run_id(self.run_id)
        virtualhost = unquote(parts.path[1:])
        if (
            host != _LOOPBACK_DESTINATION
            or self.tls_server_name != _RABBIT_TLS_NAME
            or parts.path in ("", "/")
            or len(virtualhost) > 256
            or "\x00" in virtualhost
            or any(part == ".." for part in virtualhost.split("/"))
            or _DIGEST.fullmatch(self.leaf_sha256 or "") is None
            or not isinstance(self.username, str)
            or not self.username.strip()
            or not isinstance(self.password, str)
            or not self.password.strip()
            or not isinstance(self.queue_name, str)
            or _SAFE_NAME.fullmatch(self.queue_name) is None
            or not any(
                token in self.queue_name
                for token in (run_id, run_id.replace("-", ""))
            )
        ):
            raise ObserverBlocked("RabbitMQ observer endpoint is invalid")


async def _connect_rabbit(endpoint: RabbitEndpoint):
    try:
        import aio_pika
        from aio_pika.abc import UnderlayConnection
        from aio_pika.connection import Connection as AioPikaConnection

        host, port, server_name = _endpoint(
            endpoint.url,
            "amqps",
            allow_path=True,
            tls_server_name=endpoint.tls_server_name,
        )
        context = _tls_context(endpoint.ca_file)
        virtualhost = unquote(urlsplit(endpoint.url).path[1:])

        class ObserverTransport:
            async def create(self, url, **kwargs):
                provider = kwargs.pop("ssl_context_provider", None)
                if provider is None or url.scheme != "amqps" or url.port is None:
                    raise ObserverBlocked("Verified RabbitMQ TLS is required")
                tls_context = await provider.get_context()
                return await asyncio.open_connection(
                    host=host,
                    port=url.port,
                    ssl=tls_context,
                    server_hostname=server_name,
                    **kwargs,
                )

        class ObserverConnection(AioPikaConnection):
            def __init__(self, url, **kwargs):
                super().__init__(url, **kwargs)

            async def connect(self, timeout=None):
                self.transport = await UnderlayConnection.connect(
                    self.url,
                    self._on_connection_close,
                    timeout=timeout,
                    transport_factory=ObserverTransport(),
                    **self.kwargs,
                )
                await self._on_connected()

        return await aio_pika.connect(
            host=host,
            port=port,
            ssl=True,
            virtualhost=virtualhost,
            login=endpoint.username,
            password=endpoint.password,
            ssl_context=context,
            connection_class=ObserverConnection,
            timeout=10,
        )
    except ObserverBlocked:
        raise
    except Exception as error:
        raise ObserverBlocked("RabbitMQ observer connection failed") from error


class RabbitMqObserver:
    """Passively inspect one run-owned queue without consuming or declaring it."""

    def __init__(self, endpoint: RabbitEndpoint, writer: ReceiptWriter):
        self.endpoint = endpoint
        self.writer = writer

    async def _queue_counts(self, *, minimum_message_count: int = 0) -> tuple[int, int]:
        if type(minimum_message_count) is not int or minimum_message_count < 0:
            raise ObserverBlocked("RabbitMQ message-count expectation is invalid")
        _probe_tls(
            self.endpoint.url.replace("amqps://", "https://", 1),
            self.endpoint.ca_file,
            self.endpoint.leaf_sha256,
            self.endpoint.tls_server_name,
            allow_path=True,
        )
        connection = await _connect_rabbit(self.endpoint)
        channel = None
        try:
            channel = await connection.channel()
            queue = await channel.declare_queue(self.endpoint.queue_name, passive=True)
            result = getattr(queue, "declaration_result", None)
            message_count = getattr(result, "message_count", None)
            consumer_count = getattr(result, "consumer_count", None)
            if (
                type(message_count) is not int
                or message_count < 0
                or type(consumer_count) is not int
                or consumer_count < 0
            ):
                raise ObserverBlocked("RabbitMQ passive declaration is invalid")
            if message_count < minimum_message_count:
                raise ObserverBlocked("RabbitMQ delivery marker was not observed")
            return message_count, consumer_count
        except ObserverBlocked:
            raise
        except Exception as error:
            raise ObserverBlocked("RabbitMQ queue observation failed") from error
        finally:
            if channel is not None:
                close = getattr(channel, "close", None)
                if callable(close):
                    await close()
            close = getattr(connection, "close", None)
            if callable(close):
                await close()

    async def observe_queue(
        self,
        observation: Observation,
        *,
        minimum_message_count: int = 0,
    ) -> str:
        if not isinstance(observation, Observation) or observation.component != "RABBITMQ":
            raise ObserverBlocked("Observation does not match RabbitMQ")
        if observation.run_id != self.endpoint.run_id:
            raise ObserverBlocked("RabbitMQ observation is outside the run")
        message_count, consumer_count = await self._queue_counts(
            minimum_message_count=minimum_message_count,
        )
        return self.writer.write(
            observation,
            {
                "contractVersion": "pi05-observer-source-v1",
                "boundary": "RABBITMQ",
                "operation": "passive-queue-declare",
                "queue": self.endpoint.queue_name,
                "messageCount": message_count,
                "consumerCount": consumer_count,
            },
        )

    def probe_queue(self, *, minimum_message_count: int = 0) -> int:
        """Read queue depth without creating an evidence receipt."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            message_count, _consumer_count = asyncio.run(
                self._queue_counts(minimum_message_count=minimum_message_count)
            )
            return message_count
        raise ObserverBlocked("Synchronous RabbitMQ probing is not allowed in an event loop")

    def observe_queue_sync(
        self,
        observation: Observation,
        *,
        minimum_message_count: int = 0,
    ) -> str:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(
                self.observe_queue(
                    observation, minimum_message_count=minimum_message_count,
                )
            )
        raise ObserverBlocked("Synchronous RabbitMQ observation is not allowed in an event loop")
