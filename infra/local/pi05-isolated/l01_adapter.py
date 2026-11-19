#!/usr/bin/env python3
"""Real-service PI-05 L01 orchestration and independent observations.

This module is intentionally limited to ``full-pipeline``.  It performs the
ordinary Core admission APIs, waits for the already deployed AI workers, and
asks read-only observer adapters to verify each resulting boundary.  It never
turns an action response into a receipt and never supplies a placeholder for a
later PI-05 scenario.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

import runtime_inspection
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
    _new_storage_http_connection,
    _probe_tls,
)
from observation_receipts import Observation, ReceiptWriter
from preflight import Blocked
from qdrant_observer import _query_qdrant, observe_indexed
from runtime_config import RunConfiguration, RuntimeConfigError
from scenario_handlers import ScenarioHandlerError, StepExecution, StepHandler
from scenario_orchestrator import (
    OrchestrationContext,
    OrchestratorExecutor,
    ScenarioOrchestrator,
)

SCENARIO = "full-pipeline"
STEPS = (
    "meeting-record",
    "source-media-verified",
    "broker-message-delivered",
    "media-worker-completed",
    "transcript-current",
    "intelligence-proposal",
    "human-decision-confirmed",
    "qdrant-points",
    "assistant-grounded",
)
_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z"
)
_DIGEST_RE = re.compile(r"[0-9a-f]{64}\Z")
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_SAFE_EMAIL = re.compile(r"[^@\s]{1,128}@[^@\s]{1,128}\Z")
_TERMINAL_JOBS = frozenset({"COMPLETED", "COMPLETED_WITH_WARNINGS"})
_TRANSCRIPT_READY = frozenset({"READY", "READY_WITH_WARNINGS"})


class L01Unavailable(RuntimeError):
    """L01 cannot be completed with the supplied real-service prerequisites."""


def _uuid(value: object, label: str) -> str:
    if not isinstance(value, str) or _UUID_RE.fullmatch(value) is None:
        raise L01Unavailable(f"{label} identity is invalid")
    try:
        if str(UUID(value)) != value:
            raise ValueError
    except (ValueError, TypeError, AttributeError) as error:
        raise L01Unavailable(f"{label} identity is invalid") from error
    return value


def _safe_string(value: object, label: str, *, maximum: int = 512) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or "\x00" in value
        or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
    ):
        raise L01Unavailable(f"{label} is invalid")
    return value


def _safe_headers(value: Mapping[str, str]) -> dict[str, str]:
    if not isinstance(value, Mapping):
        raise L01Unavailable("HTTP headers are invalid")
    result = {}
    for name, setting in value.items():
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,63}", name)
            or not isinstance(setting, str)
            or "\x00" in setting
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in setting)
        ):
            raise L01Unavailable("HTTP headers are invalid")
        result[name] = setting
    return result


def _unique_json(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _json_response(response: Any) -> dict[str, object]:
    try:
        payload = json.loads(response.content, object_pairs_hook=_unique_json)
    except (TypeError, UnicodeError, ValueError, RecursionError) as error:
        raise L01Unavailable("Core returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise L01Unavailable("Core returned an invalid response")
    return payload


class CoreClient:
    """Small, bounded authenticated Core client used only by L01 actions."""

    def __init__(
        self,
        base_url: str,
        *,
        ca_file: Path,
        client_cert: Path,
        client_key: Path,
        leaf_sha256: str,
        email: str,
        password: str,
        timeout_seconds: float,
        tls_server_name: str | None = None,
        connect_host: str = "127.0.0.1",
    ):
        if (
            not isinstance(base_url, str)
            or urlsplit(base_url).scheme != "https"
            or urlsplit(base_url).username
            or urlsplit(base_url).password
            or urlsplit(base_url).query
            or urlsplit(base_url).fragment
            or urlsplit(base_url).path not in ("", "/")
        ):
            raise L01Unavailable("Core API endpoint is invalid")
        if not _SAFE_EMAIL.fullmatch(email or "") or not password:
            raise L01Unavailable("Core login material is invalid")
        parts = urlsplit(base_url)
        if tls_server_name is not None and (
            tls_server_name != "core-api.internal"
            or connect_host != "127.0.0.1"
            or parts.hostname != "127.0.0.1"
            or parts.port is None
        ):
            raise L01Unavailable("Core API loopback route is invalid")
        try:
            import httpx

            if tls_server_name is None:
                self.client = httpx.Client(
                    base_url=base_url.rstrip("/"),
                    verify=str(ca_file),
                    cert=(str(client_cert), str(client_key)),
                    timeout=timeout_seconds,
                    trust_env=False,
                    follow_redirects=False,
                )
            else:
                from http_transport import LoopbackHTTPTransport

                logical_base = urlunsplit((
                    parts.scheme,
                    f"{tls_server_name}:{parts.port}",
                    parts.path,
                    "",
                    "",
                ))
                transport = LoopbackHTTPTransport(
                    connect_host=connect_host,
                    server_hostname=tls_server_name,
                    verify=str(ca_file),
                    cert=(str(client_cert), str(client_key)),
                    trust_env=False,
                )
                self.client = httpx.Client(
                    base_url=logical_base.rstrip("/"),
                    transport=transport,
                    timeout=timeout_seconds,
                    trust_env=False,
                    follow_redirects=False,
                )
        except Exception as error:
            raise L01Unavailable("Core HTTP client could not be configured") from error
        self.email = email
        self.password = password
        self.leaf_sha256 = leaf_sha256
        self.ca_file = ca_file
        self.client_cert = client_cert
        self.client_key = client_key
        self._probe_endpoint = base_url.rstrip("/")
        self._tls_server_name = tls_server_name
        self._connect_host = connect_host
        self._token: str | None = None

    def close(self) -> None:
        close = getattr(self.client, "close", None)
        if callable(close):
            close()

    def _login(self) -> None:
        _probe_tls(
            self._probe_endpoint,
            self.ca_file,
            self.leaf_sha256,
            self._tls_server_name,
            client_cert=self.client_cert,
            client_key=self.client_key,
        )
        request_id = str(uuid4())
        try:
            response = self.client.post(
                "/api/v1/auth/login",
                headers={
                    "X-Auth-Transport": "mobile",
                    "X-Request-Id": request_id,
                },
                json={"email": self.email, "password": self.password},
            )
        except Exception as error:
            raise L01Unavailable("Core login was unavailable") from error
        if not 200 <= response.status_code < 300:
            raise L01Unavailable("Core login was rejected")
        payload = _json_response(response)
        data = payload.get("data")
        token = data.get("accessToken") if isinstance(data, dict) else None
        if (
            payload.get("success") is not True
            or not isinstance(token, str)
            or not token
            or len(token) > 8192
        ):
            raise L01Unavailable("Core login response was invalid")
        self._token = token

    def request(
        self,
        method: str,
        path: str,
        *,
        request_id: str | None = None,
        body: object | None = None,
        idempotency_key: str | None = None,
        if_match: str | None = None,
    ) -> tuple[object, Mapping[str, str]]:
        if method not in {"GET", "POST", "PATCH", "DELETE"} or not isinstance(path, str) or not path.startswith("/"):
            raise L01Unavailable("Core operation is invalid")
        request_id = _uuid(request_id or str(uuid4()), "Core request")
        if self._token is None:
            self._login()
        headers = {
            "X-Auth-Transport": "mobile",
            "Authorization": f"Bearer {self._token}",
            "X-Request-Id": request_id,
        }
        if idempotency_key is not None:
            headers["Idempotency-Key"] = _safe_string(idempotency_key, "Idempotency key", maximum=128)
        if if_match is not None:
            headers["If-Match"] = _safe_string(if_match, "If-Match value", maximum=256)
        _probe_tls(
            self._probe_endpoint,
            self.ca_file,
            self.leaf_sha256,
            self._tls_server_name,
            client_cert=self.client_cert,
            client_key=self.client_key,
        )
        try:
            response = self.client.request(
                method, path, headers=_safe_headers(headers), json=body,
            )
        except Exception as error:
            raise L01Unavailable("Core operation was unavailable") from error
        if response.status_code == 401:
            self._login()
            headers["Authorization"] = f"Bearer {self._token}"
            try:
                response = self.client.request(
                    method, path, headers=_safe_headers(headers), json=body,
                )
            except Exception as error:
                raise L01Unavailable("Core operation was unavailable") from error
        if not 200 <= response.status_code < 300:
            raise L01Unavailable("Core operation was rejected")
        payload = _json_response(response)
        if payload.get("success") is not True or "data" not in payload:
            raise L01Unavailable("Core operation returned an unsuccessful response")
        return payload["data"], response.headers

    def request_status(
        self,
        method: str,
        path: str,
        *,
        request_id: str | None = None,
        body: object | None = None,
        idempotency_key: str | None = None,
        if_match: str | None = None,
    ) -> tuple[int, dict[str, object], Mapping[str, str]]:
        """Return a bounded Core envelope, including an expected error status.

        Scenario actions such as conflict admission and stale capability checks
        must observe the real rejected response rather than turn it into an
        exception whose status is lost.  The normal ``request`` method remains
        strict for L01 and raises on every non-2xx response.
        """
        if method not in {"GET", "POST", "PATCH", "DELETE"} or not isinstance(path, str) or not path.startswith("/"):
            raise L01Unavailable("Core operation is invalid")
        request_id = _uuid(request_id or str(uuid4()), "Core request")
        if self._token is None:
            self._login()
        headers = {
            "X-Auth-Transport": "mobile",
            "Authorization": f"Bearer {self._token}",
            "X-Request-Id": request_id,
        }
        if idempotency_key is not None:
            headers["Idempotency-Key"] = _safe_string(idempotency_key, "Idempotency key", maximum=128)
        if if_match is not None:
            headers["If-Match"] = _safe_string(if_match, "If-Match value", maximum=256)
        _probe_tls(
            self._probe_endpoint,
            self.ca_file,
            self.leaf_sha256,
            self._tls_server_name,
            client_cert=self.client_cert,
            client_key=self.client_key,
        )
        try:
            response = self.client.request(
                method, path, headers=_safe_headers(headers), json=body,
            )
        except Exception as error:
            raise L01Unavailable("Core operation was unavailable") from error
        if response.status_code == 401:
            self._login()
            headers["Authorization"] = f"Bearer {self._token}"
            try:
                response = self.client.request(
                    method, path, headers=_safe_headers(headers), json=body,
                )
            except Exception as error:
                raise L01Unavailable("Core operation was unavailable") from error
        payload = _json_response(response)
        if not isinstance(payload, dict):
            raise L01Unavailable("Core operation returned an invalid envelope")
        return response.status_code, payload, response.headers


@dataclass(frozen=True)
class L01RuntimeSettings:
    """Validated real endpoints and credentials for one L01 run."""

    root: Path
    action_core: CoreClient
    observer_core: CoreBusinessObserver
    ai_observer: AiObserver
    storage_observer: StorageObserver
    rabbit_observer: RabbitMqObserver
    storage: StorageEndpoint
    rabbit_minimum_message_count: int
    qdrant_api_key: str
    media_file: Path
    timeout_seconds: float = 14_400
    poll_interval_seconds: float = 1.0

    @classmethod
    def from_configuration(
        cls,
        configuration: RunConfiguration,
        *,
        writer: ReceiptWriter,
    ) -> L01RuntimeSettings:
        required = (
            "PI05_CORE_CA_FILE", "PI05_CORE_CERT_FILE", "PI05_CORE_KEY_FILE",
            "PI05_CORE_OBSERVER_CERT_FILE", "PI05_CORE_OBSERVER_KEY_FILE",
            "PI05_AI_CA_FILE", "PI05_AI_CERT_FILE", "PI05_AI_KEY_FILE",
            "PI05_STORAGE_LEAF_SHA256", "PI05_STORAGE_TLS_SERVER_NAME",
            "PI05_STORAGE_HOST_HEADER", "PI05_RABBIT_LEAF_SHA256",
            "PI05_RABBIT_TLS_SERVER_NAME", "PI05_CORE_CONNECT_HOST",
            "PI05_CORE_TLS_SERVER_NAME",
        )
        if any(name not in configuration.harness_env for name in required):
            raise RuntimeConfigError("L01 mTLS observer material is incomplete")
        h = configuration.harness
        root = configuration.root

        try:
            ports = runtime_inspection.inspect_topology(configuration.run_id, root)
        except Blocked as error:
            raise RuntimeConfigError(
                "Verified isolated Docker endpoint mapping is unavailable"
            ) from error

        def discovered_port(service: str) -> int:
            value = ports.get(service)
            if not isinstance(value, str) or not value.startswith("127.0.0.1:"):
                raise RuntimeConfigError("Verified isolated endpoint mapping is invalid")
            try:
                port = int(value.rsplit(":", 1)[1])
            except (TypeError, ValueError) as error:
                raise RuntimeConfigError("Verified isolated endpoint mapping is invalid") from error
            if not 1 <= port <= 65535:
                raise RuntimeConfigError("Verified isolated endpoint mapping is invalid")
            return port

        def require_discovered_port(name: str, service: str) -> None:
            value = h(name)
            configured = urlsplit(value)
            if configured.port != discovered_port(service):
                raise RuntimeConfigError(
                    f"{name} does not match the verified isolated {service} port"
                )

        def require_process_url_port(
            values: Mapping[str, str],
            name: str,
            service: str,
        ) -> None:
            value = values.get(name)
            try:
                configured_port = urlsplit(value).port if isinstance(value, str) else None
            except ValueError as error:
                raise RuntimeConfigError(f"{name} has an invalid port") from error
            if configured_port != discovered_port(service):
                raise RuntimeConfigError(
                    f"{name} does not match the verified isolated {service} port"
                )

        require_discovered_port("PI05_STORAGE_ENDPOINT_URL", "storage-boundary")
        require_discovered_port("PI05_RABBIT_URL", "rabbitmq")
        if configuration.core_env.get("RABBITMQ_PORT") != str(discovered_port("rabbitmq")):
            raise RuntimeConfigError("Core RabbitMQ port does not match the verified isolated port")
        require_process_url_port(configuration.core_env, "APP_MEDIA_STORAGE_ENDPOINT", "storage-boundary")
        require_process_url_port(configuration.ai_http_env, "AI_RABBITMQ_URL", "rabbitmq")
        require_process_url_port(configuration.ai_http_env, "AI_S3_ENDPOINT_URL", "storage-boundary")
        for worker_env in (
            configuration.transcription_worker_env,
            configuration.mi_worker_env,
            configuration.knowledge_worker_env,
        ):
            require_process_url_port(worker_env, "AI_RABBITMQ_URL", "rabbitmq")
            require_process_url_port(worker_env, "AI_S3_ENDPOINT_URL", "storage-boundary")
        try:
            qdrant = urlsplit(configuration.ai_http_env.get("AI_RAG_QDRANT_URL", ""))
            qdrant_port = qdrant.port
        except ValueError as error:
            raise RuntimeConfigError("AI Qdrant URL has an invalid port") from error
        qdrant_ca_value = configuration.ai_http_env.get("AI_RAG_QDRANT_CA_FILE")
        if (
            qdrant.scheme != "https"
            or qdrant.hostname != "127.0.0.1"
            or qdrant_port != discovered_port("qdrant")
            or not isinstance(qdrant_ca_value, str)
        ):
            raise RuntimeConfigError("AI Qdrant URL does not match the verified isolated port")
        qdrant_ca = Path(qdrant_ca_value).absolute()
        if (
            root not in qdrant_ca.parents
            or qdrant_ca.is_symlink()
            or not qdrant_ca.is_file()
        ):
            raise RuntimeConfigError("AI Qdrant CA file must be a run-owned regular file")
        database = configuration.core_env.get("DB_URL", "")
        if not database.startswith("jdbc:"):
            raise RuntimeConfigError("Core database URL is invalid")
        try:
            database = urlsplit(database[5:])
            database_port = database.port
        except ValueError as error:
            raise RuntimeConfigError("Core database URL has an invalid port") from error
        if database.hostname != "127.0.0.1" or database_port != discovered_port("postgres"):
            raise RuntimeConfigError("Core database URL does not match the verified isolated port")

        def run_path(name: str) -> Path:
            path = Path(h(name)).absolute()
            if root not in path.parents:
                raise RuntimeConfigError("L01 material must be inside the run root")
            return path

        core_endpoint = HttpEndpoint(
            h("PI05_CORE_BASE_URL"),
            run_path("PI05_CORE_CA_FILE"),
            run_path("PI05_CORE_OBSERVER_CERT_FILE"),
            run_path("PI05_CORE_OBSERVER_KEY_FILE"),
            h("PI05_CORE_LEAF_SHA256"),
            tls_server_name=h("PI05_CORE_TLS_SERVER_NAME"),
            http_host=h("PI05_CORE_TLS_SERVER_NAME"),
        )
        ai_endpoint = HttpEndpoint(
            h("PI05_AI_BASE_URL"),
            run_path("PI05_AI_CA_FILE"),
            run_path("PI05_AI_CERT_FILE"),
            run_path("PI05_AI_KEY_FILE"),
            h("PI05_AI_LEAF_SHA256"),
        )
        storage = StorageEndpoint(
            endpoint_url=h("PI05_STORAGE_ENDPOINT_URL"),
            bucket=h("PI05_STORAGE_BUCKET"),
            access_key=h("PI05_STORAGE_ACCESS_KEY"),
            secret_key=h("PI05_STORAGE_SECRET_KEY"),
            ca_file=run_path("PI05_STORAGE_CA_FILE"),
            leaf_sha256=h("PI05_STORAGE_LEAF_SHA256"),
            run_id=configuration.run_id,
            object_prefix=h("PI05_STORAGE_OBJECT_PREFIX"),
            tls_server_name=h("PI05_STORAGE_TLS_SERVER_NAME"),
            http_host=h("PI05_STORAGE_HOST_HEADER"),
        )
        rabbit = RabbitEndpoint(
            url=h("PI05_RABBIT_URL"),
            ca_file=run_path("PI05_RABBIT_CA_FILE"),
            username=h("PI05_RABBIT_USERNAME"),
            password=h("PI05_RABBIT_PASSWORD"),
            leaf_sha256=h("PI05_RABBIT_LEAF_SHA256"),
            queue_name=h("PI05_RABBIT_QUEUE"),
            run_id=configuration.run_id,
            tls_server_name=h("PI05_RABBIT_TLS_SERVER_NAME"),
        )
        action_core = CoreClient(
            h("PI05_CORE_BASE_URL"),
            ca_file=run_path("PI05_CORE_CA_FILE"),
            client_cert=run_path("PI05_CORE_CERT_FILE"),
            client_key=run_path("PI05_CORE_KEY_FILE"),
            leaf_sha256=h("PI05_CORE_LEAF_SHA256"),
            email=h("PI05_ACTION_EMAIL"),
            password=h("PI05_ACTION_PASSWORD"),
            timeout_seconds=15,
            tls_server_name=h("PI05_CORE_TLS_SERVER_NAME"),
            connect_host=h("PI05_CORE_CONNECT_HOST"),
        )
        observer_core = CoreBusinessObserver(
            core_endpoint,
            writer,
            email=h("PI05_OBSERVER_EMAIL"),
            password=h("PI05_OBSERVER_PASSWORD"),
            timeout_seconds=15,
            connect_host=h("PI05_CORE_CONNECT_HOST"),
        )
        media_file = run_path("PI05_MEDIA_FILE")
        if (
            any(item.is_symlink() for item in (media_file, *media_file.parents))
            or not media_file.is_file()
        ):
            raise RuntimeConfigError("L01 media fixture is unavailable")
        try:
            timeout = float(h.get("PI05_SCENARIO_TIMEOUT_SECONDS", "14400"))
            poll = float(h.get("PI05_POLL_INTERVAL_SECONDS", "1"))
            minimum = int(h.get("PI05_RABBIT_MINIMUM_MESSAGE_COUNT", "1"))
        except (TypeError, ValueError) as error:
            raise RuntimeConfigError("L01 timing configuration is invalid") from error
        if not 60 <= timeout <= 14_400 or not 0.05 <= poll <= 30 or not 1 <= minimum <= 100:
            raise RuntimeConfigError("L01 timing configuration is out of bounds")
        return cls(
            root=root,
            action_core=action_core,
            observer_core=observer_core,
            ai_observer=AiObserver(ai_endpoint, writer),
            storage_observer=StorageObserver(storage, writer),
            rabbit_observer=RabbitMqObserver(rabbit, writer),
            storage=storage,
            rabbit_minimum_message_count=minimum,
            qdrant_api_key=h("PI05_QDRANT_API_KEY"),
            media_file=media_file,
            timeout_seconds=timeout,
            poll_interval_seconds=poll,
        )


class CoreBusinessObserver:
    """Authenticated, pinned, GET-only Core business observation."""

    def __init__(
        self,
        endpoint: HttpEndpoint,
        writer: ReceiptWriter,
        *,
        email: str,
        password: str,
        timeout_seconds: float,
        connect_host: str = "127.0.0.1",
    ):
        _probe_tls(
            endpoint.url,
            endpoint.ca_file,
            endpoint.leaf_sha256,
            endpoint.tls_server_name,
            client_cert=endpoint.client_cert,
            client_key=endpoint.client_key,
        )
        try:
            self._session = CoreClient(
                endpoint.url,
                ca_file=endpoint.ca_file,
                client_cert=endpoint.client_cert,
                client_key=endpoint.client_key,
                leaf_sha256=endpoint.leaf_sha256,
                email=email,
                password=password,
                timeout_seconds=timeout_seconds,
                tls_server_name=endpoint.tls_server_name,
                connect_host=connect_host,
            )
            self._session._login()
        except L01Unavailable:
            raise
        except Exception as error:
            raise L01Unavailable("Core observer authentication was unavailable") from error
        self._observer = CoreObserver(
            endpoint,
            writer,
            request_headers={
                "X-Auth-Transport": "mobile",
                "Authorization": f"Bearer {self._session._token}",
            },
        )

    def _refresh_token(self) -> None:
        self._session._login()
        token = self._session._token
        if not isinstance(token, str) or not token:
            raise L01Unavailable("Core observer authentication was not renewed")
        self._observer.request_headers["Authorization"] = f"Bearer {token}"

    def close(self) -> None:
        self._session.close()

    def request_json(self, request_id: str, path: str) -> object:
        self._refresh_token()
        return self._observer.request_json(request_id, "GET", path)

    def observe(
        self,
        observation: Observation,
        *,
        operation: str,
        path: str,
        checks: tuple[JsonCheck, ...],
        source_fields: Mapping[str, object] | None = None,
    ) -> str:
        self._refresh_token()
        return self._observer.observe(
            observation,
            operation=operation,
            path=path,
            checks=checks,
            source_fields=source_fields,
        )

    def write_checked(
        self,
        observation: Observation,
        *,
        operation: str,
        path: str,
        predicate: Callable[[object], Mapping[str, object]],
    ) -> str:
        if observation.component != "CORE":
            raise ObserverBlocked("Core observation component does not match")
        payload = self.request_json(observation.request_id, path)
        try:
            fields = predicate(payload)
        except Exception as error:
            raise ObserverBlocked("Core business observation failed") from error
        if not isinstance(fields, Mapping):
            raise ObserverBlocked("Core business observation source is invalid")
        return self._observer.writer.write(
            observation,
            {
                "contractVersion": "pi05-observer-source-v1",
                "boundary": "CORE",
                "operation": operation,
                "endpointPath": path,
                **dict(fields),
            },
        )


@dataclass
class _L01State:
    meeting_id: str | None = None
    media_id: str | None = None
    media_key: str | None = None
    media_size: int | None = None
    media_sha256: str | None = None
    job_id: str | None = None
    transcript_id: str | None = None
    transcript_revision: int | None = None
    decision_id: str | None = None
    decision_version: int | None = None
    conversation_id: str | None = None
    qdrant_count: int | None = None
    expected_action: int = 0


@dataclass(frozen=True)
class L01Handle:
    step: str
    request_id: str
    values: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.step not in STEPS:
            raise ScenarioHandlerError("L01 step is invalid")
        _uuid(self.request_id, "L01 request")
        if not isinstance(self.values, Mapping):
            raise ScenarioHandlerError("L01 execution values are invalid")
        for key, value in self.values.items():
            if (
                not isinstance(key, str)
                or not _SAFE_ID.fullmatch(key)
                or value is not None
                and type(value) not in (bool, int, str)
            ):
                raise ScenarioHandlerError("L01 execution values are not sanitized")


class L01Operations(Protocol):
    def action(
        self,
        step: str,
        context: OrchestrationContext,
        state: _L01State,
        request_id: str,
    ) -> L01Handle:
        ...

    def observe(
        self,
        step: str,
        context: OrchestrationContext,
        state: _L01State,
        execution: StepExecution,
        requirement: tuple[str, str],
    ) -> str:
        ...


class L01Adapter:
    """Bind one concrete L01 action and one independent observer per step."""

    def __init__(
        self,
        context: OrchestrationContext,
        operations: L01Operations,
    ):
        if not isinstance(context, OrchestrationContext):
            raise TypeError("L01 orchestration context is required")
        if not callable(getattr(operations, "action", None)) or not callable(
            getattr(operations, "observe", None)
        ):
            raise TypeError("L01 real operations are required")
        self.context = context
        self.operations = operations
        self.state = _L01State()

    def _check_context(self, context: OrchestrationContext) -> None:
        if (
            not isinstance(context, OrchestrationContext)
            or context.run_id != self.context.run_id
            or context.commit != self.context.commit
            or context.generation != self.context.generation
            or context.collection != self.context.collection
            or context.proof_dir != self.context.proof_dir
            or context.source_dir != self.context.source_dir
        ):
            raise ScenarioHandlerError("L01 context does not match the configured run")

    def _action(self, step: str, context: OrchestrationContext) -> StepExecution:
        self._check_context(context)
        if self.state.expected_action != STEPS.index(step):
            raise ScenarioHandlerError("L01 actions were invoked out of order")
        request_id = str(uuid4())
        try:
            handle = self.operations.action(step, self.context, self.state, request_id)
        except (L01Unavailable, ObserverBlocked) as error:
            raise ScenarioHandlerError("L01 real action is unavailable") from error
        except Exception as error:
            raise ScenarioHandlerError("L01 real action failed") from error
        if not isinstance(handle, L01Handle) or handle.request_id != request_id:
            raise ScenarioHandlerError("L01 action returned an invalid execution handle")
        self.state.expected_action += 1
        return StepExecution(request_id, handle)

    def _observe(
        self,
        step: str,
        context: OrchestrationContext,
        execution: StepExecution,
        requirement: tuple[str, str],
    ) -> str:
        self._check_context(context)
        if not isinstance(execution.opaque_result, L01Handle):
            raise ScenarioHandlerError("L01 observer received an invalid action handle")
        if execution.opaque_result.step != step or execution.request_id != execution.opaque_result.request_id:
            raise ScenarioHandlerError("L01 action and observer identities do not match")
        try:
            digest = self.operations.observe(
                step, self.context, self.state, execution, requirement,
            )
        except (L01Unavailable, ObserverBlocked) as error:
            raise ScenarioHandlerError("L01 independent observation is unavailable") from error
        except Exception as error:
            raise ScenarioHandlerError("L01 independent observation failed") from error
        if not isinstance(digest, str) or _DIGEST_RE.fullmatch(digest) is None:
            raise ScenarioHandlerError("L01 observer did not return a receipt digest")
        return digest

    def step_handlers(self) -> dict[str, StepHandler]:
        return {
            step: StepHandler(
                action=lambda context, step=step: self._action(step, context),
                observer=lambda context, execution, requirement, step=step:
                    self._observe(step, context, execution, requirement),
            )
            for step in STEPS
        }


class _RealL01Operations:
    """The only production operation implementation for L01."""

    def __init__(self, context: OrchestrationContext, settings: L01RuntimeSettings):
        self.context = context
        self.settings = settings
        self.writer = settings.observer_core._observer.writer

    def close(self) -> None:
        self.settings.action_core.close()
        self.settings.observer_core.close()

    def readiness(self) -> None:
        try:
            ai = self.settings.ai_observer.request_json(str(uuid4()), "GET", "/health/ready")
            if not isinstance(ai, dict) or ai.get("status") != "ready":
                raise L01Unavailable("AI HTTP readiness is not ready")
            core = self.settings.observer_core.request_json(
                str(uuid4()), "/actuator/health/readiness",
            )
            if not isinstance(core, dict) or core.get("status") not in {"UP", "up"}:
                raise L01Unavailable("Core readiness is not ready")
        except (L01Unavailable, ObserverBlocked):
            raise
        except Exception as error:
            raise L01Unavailable("Application readiness could not be observed") from error

    def _core(
        self,
        method: str,
        path: str,
        *,
        request_id: str | None = None,
        body: object | None = None,
        idempotency_key: str | None = None,
        if_match: str | None = None,
    ) -> tuple[object, Mapping[str, str]]:
        return self.settings.action_core.request(
            method,
            path,
            request_id=request_id,
            body=body,
            idempotency_key=idempotency_key,
            if_match=if_match,
        )

    @staticmethod
    def _data_dict(data: object, label: str) -> dict[str, object]:
        if not isinstance(data, dict):
            raise L01Unavailable(f"Core {label} response is invalid")
        return data

    def _require_state(self, value: object, label: str) -> str:
        return _uuid(value, label)

    def _read_media(self) -> tuple[bytes, int, str]:
        path = self.settings.media_file
        try:
            info = path.stat()
        except OSError as error:
            raise L01Unavailable("L01 media fixture is unavailable") from error
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or info.st_mode & 0o077
            or info.st_size <= 44
            or info.st_size > 100 * 1024 * 1024
        ):
            raise L01Unavailable("L01 media fixture is not a private bounded file")
        try:
            raw = path.read_bytes()
        except OSError as error:
            raise L01Unavailable("L01 media fixture could not be read") from error
        if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
            raise L01Unavailable("L01 media fixture must be a WAV file")
        return raw, len(raw), hashlib.sha256(raw).hexdigest()

    def _upload(self, url: str, raw: bytes) -> None:
        parts = urlsplit(url)
        expected = urlsplit(self.settings.storage.endpoint_url)
        if (
            parts.scheme != "https"
            or parts.username
            or parts.password
            or parts.query == ""
            or parts.fragment
            or parts.hostname != self.settings.storage.http_host
            or parts.port != expected.port
            or any(part == ".." for part in parts.path.split("/"))
            or any(ord(char) < 0x20 or ord(char) == 0x7F for char in url)
        ):
            raise L01Unavailable("Core returned an unsafe media upload capability")
        _probe_tls(
            self.settings.storage.endpoint_url,
            self.settings.storage.ca_file,
            self.settings.storage.leaf_sha256,
            self.settings.storage.tls_server_name,
        )
        connection = _new_storage_http_connection(self.settings.storage)
        try:
            connection.connect()
            path = urlunsplit(("", "", parts.path or "/", parts.query, ""))
            connection.request(
                "PUT",
                path,
                body=raw,
                headers={
                    "Host": self.settings.storage.http_host,
                    "Content-Type": "audio/wav",
                    "Content-Length": str(len(raw)),
                },
            )
            response = connection.getresponse()
            response.read(64 * 1024)
        except Exception as error:
            raise L01Unavailable("Media upload was unavailable") from error
        finally:
            connection.close()
        if not 200 <= response.status < 300:
            raise L01Unavailable("Media upload was rejected")

    def _poll_job(self, job_id: str, request_id: str) -> dict[str, object]:
        deadline = time.monotonic() + self.settings.timeout_seconds
        while time.monotonic() < deadline:
            data, _ = self._core("GET", f"/api/v1/processing-jobs/{job_id}")
            job = self._data_dict(data, "processing job")
            status = job.get("status")
            if status in _TERMINAL_JOBS:
                return job
            if status == "FAILED":
                raise L01Unavailable("Core processing job failed")
            time.sleep(self.settings.poll_interval_seconds)
        raise L01Unavailable("Core processing job timed out")

    def _poll_decision(
        self,
        meeting_id: str,
        transcript_id: str,
        revision: int,
    ) -> dict[str, object]:
        deadline = time.monotonic() + self.settings.timeout_seconds
        while time.monotonic() < deadline:
            data, _ = self._core("GET", f"/api/v1/meetings/{meeting_id}/decisions")
            if not isinstance(data, list):
                raise L01Unavailable("Core decision list response is invalid")
            for candidate in data:
                if not isinstance(candidate, dict):
                    raise L01Unavailable("Core decision response contains invalid data")
                if (
                    candidate.get("meetingId") == meeting_id
                    and candidate.get("status") == "PROPOSED"
                    and candidate.get("sourceType") == "AI_EXTRACTED"
                    and candidate.get("transcriptId") == transcript_id
                    and candidate.get("contentRevision") == revision
                    and candidate.get("isStale") is False
                    and isinstance(candidate.get("evidenceSegmentIds"), list)
                    and candidate["evidenceSegmentIds"]
                ):
                    return candidate
            time.sleep(self.settings.poll_interval_seconds)
        raise L01Unavailable("Core did not produce a current intelligence proposal")

    def _poll_qdrant(self, meeting_id: str, transcript_id: str, revision: int) -> int:
        try:
            import runtime_inspection

            topology = runtime_inspection.inspect_topology(self.context.run_id, self.settings.root)
            endpoint = topology.get("qdrant") if isinstance(topology, dict) else None
            match = re.fullmatch(r"127\.0\.0\.1:([1-9][0-9]{0,4})", endpoint or "")
            if not match or int(match[1]) > 65535:
                raise L01Unavailable("Qdrant does not have a verified run endpoint")
            port = int(match[1])
        except L01Unavailable:
            raise
        except Exception as error:
            raise L01Unavailable("Qdrant topology could not be observed") from error
        deadline = time.monotonic() + self.settings.timeout_seconds
        while time.monotonic() < deadline:
            try:
                count, _ = _query_qdrant(
                    port=port,
                    root=self.settings.root,
                    api_key=self.settings.qdrant_api_key,
                    generation=self.context.generation,
                    collection=self.context.collection,
                    meeting_id=meeting_id,
                    source_id=transcript_id,
                    revision=revision,
                    request_id=str(uuid4()),
                )
                if type(count) is int and count > 0:
                    return count
            except Blocked:
                continue
            time.sleep(self.settings.poll_interval_seconds)
        raise L01Unavailable("Qdrant did not expose indexed transcript points")

    def action(
        self,
        step: str,
        context: OrchestrationContext,
        state: _L01State,
        request_id: str,
    ) -> L01Handle:
        if context is not self.context and context.run_id != self.context.run_id:
            raise L01Unavailable("L01 context does not match configured run")
        if step == "meeting-record":
            data, _ = self._core(
                "POST",
                "/api/v1/meetings",
                request_id=request_id,
                body={"title": f"PI-05 L01 {context.run_id}"},
                idempotency_key=request_id,
            )
            meeting = self._data_dict(data, "meeting")
            state.meeting_id = self._require_state(meeting.get("id"), "meeting")
            return L01Handle(step, request_id, {"meetingId": state.meeting_id})

        if step == "source-media-verified":
            meeting_id = self._require_state(state.meeting_id, "meeting")
            raw, size, digest = self._read_media()
            data, _ = self._core(
                "POST",
                f"/api/v1/meetings/{meeting_id}/media/uploads",
                request_id=request_id,
                idempotency_key=request_id,
                body={
                    "sourceType": "UPLOAD",
                    "originalFilename": "pi05-l01.wav",
                    "contentType": "audio/wav",
                    "expectedSizeBytes": size,
                },
            )
            upload = self._data_dict(data, "media upload")
            media_id = self._require_state(upload.get("mediaId"), "source media")
            upload_url = upload.get("uploadUrl")
            if not isinstance(upload_url, str):
                raise L01Unavailable("Core did not return a media capability")
            self._upload(upload_url, raw)
            finalized, _ = self._core(
                "POST",
                f"/api/v1/meetings/{meeting_id}/media/{media_id}/finalize",
                request_id=str(uuid4()),
            )
            media = self._data_dict(finalized, "finalized media")
            if (
                media.get("id") != media_id
                or media.get("meetingId") != meeting_id
                or media.get("status") != "AVAILABLE"
                or media.get("contentType") != "audio/wav"
                or media.get("sizeBytes") != size
                or media.get("sha256") != digest
            ):
                raise L01Unavailable("Core did not finalize the source media")
            state.media_id = media_id
            state.media_key = f"meetings/{meeting_id}/sources/{media_id}"
            state.media_size = size
            state.media_sha256 = digest
            return L01Handle(
                step, request_id,
                {"meetingId": meeting_id, "mediaId": media_id, "sizeBytes": size},
            )

        if step == "broker-message-delivered":
            meeting_id = self._require_state(state.meeting_id, "meeting")
            media_id = self._require_state(state.media_id, "source media")
            data, _ = self._core(
                "POST",
                f"/api/v1/meetings/{meeting_id}/processing-jobs",
                request_id=request_id,
                idempotency_key=request_id,
                body={"mediaId": media_id},
            )
            job = self._data_dict(data, "processing job admission")
            state.job_id = self._require_state(job.get("id"), "processing job")
            if job.get("meetingId") != meeting_id or job.get("sourceMediaId") != media_id:
                raise L01Unavailable("Core processing job identity does not match the run")
            return L01Handle(
                step, request_id,
                {"meetingId": meeting_id, "mediaId": media_id, "jobId": state.job_id},
            )

        if step == "media-worker-completed":
            meeting_id = self._require_state(state.meeting_id, "meeting")
            job_id = self._require_state(state.job_id, "processing job")
            job = self._poll_job(job_id, request_id)
            if job.get("meetingId") != meeting_id:
                raise L01Unavailable("Completed job is outside the meeting")
            data, _ = self._core("GET", f"/api/v1/meetings/{meeting_id}/transcript")
            transcript = self._data_dict(data, "transcript")
            if transcript.get("processingJobId") != job_id or transcript.get("status") not in _TRANSCRIPT_READY:
                raise L01Unavailable("Completed job did not produce a current transcript")
            state.transcript_id = self._require_state(transcript.get("id"), "transcript")
            revision = transcript.get("contentRevision")
            if type(revision) is not int or revision < 0:
                raise L01Unavailable("Transcript revision is invalid")
            state.transcript_revision = revision
            return L01Handle(
                step, request_id,
                {"jobId": job_id, "status": job["status"], "transcriptId": state.transcript_id},
            )

        if step == "transcript-current":
            meeting_id = self._require_state(state.meeting_id, "meeting")
            transcript_id = self._require_state(state.transcript_id, "transcript")
            data, _ = self._core("GET", f"/api/v1/meetings/{meeting_id}/transcript")
            transcript = self._data_dict(data, "current transcript")
            if (
                transcript.get("id") != transcript_id
                or transcript.get("meetingId") != meeting_id
                or transcript.get("status") not in _TRANSCRIPT_READY
                or transcript.get("isCurrent", True) is False
            ):
                raise L01Unavailable("Transcript is not current")
            revision = transcript.get("contentRevision")
            if type(revision) is not int or revision != state.transcript_revision:
                raise L01Unavailable("Transcript revision changed unexpectedly")
            return L01Handle(
                step, request_id,
                {"meetingId": meeting_id, "transcriptId": transcript_id, "revision": revision},
            )

        if step == "intelligence-proposal":
            meeting_id = self._require_state(state.meeting_id, "meeting")
            transcript_id = self._require_state(state.transcript_id, "transcript")
            revision = state.transcript_revision
            if type(revision) is not int:
                raise L01Unavailable("Transcript revision is unavailable")
            decision = self._poll_decision(meeting_id, transcript_id, revision)
            state.decision_id = self._require_state(decision.get("id"), "decision")
            version = decision.get("version")
            if type(version) is not int or version < 0:
                raise L01Unavailable("Decision version is invalid")
            state.decision_version = version
            return L01Handle(
                step, request_id,
                {"meetingId": meeting_id, "decisionId": state.decision_id, "version": version},
            )

        if step == "human-decision-confirmed":
            meeting_id = self._require_state(state.meeting_id, "meeting")
            decision_id = self._require_state(state.decision_id, "decision")
            version = state.decision_version
            if type(version) is not int:
                raise L01Unavailable("Decision version is unavailable")
            etag = f'"dec-{decision_id}-{version}"'
            data, _ = self._core(
                "POST",
                f"/api/v1/meetings/{meeting_id}/decisions/{decision_id}/confirm",
                request_id=request_id,
                if_match=etag,
            )
            decision = self._data_dict(data, "confirmed decision")
            if (
                decision.get("id") != decision_id
                or decision.get("meetingId") != meeting_id
                or decision.get("status") != "CONFIRMED"
            ):
                raise L01Unavailable("Core did not confirm the proposed decision")
            return L01Handle(
                step, request_id,
                {"meetingId": meeting_id, "decisionId": decision_id, "version": decision.get("version")},
            )

        if step == "qdrant-points":
            meeting_id = self._require_state(state.meeting_id, "meeting")
            transcript_id = self._require_state(state.transcript_id, "transcript")
            revision = state.transcript_revision
            if type(revision) is not int:
                raise L01Unavailable("Transcript revision is unavailable")
            state.qdrant_count = self._poll_qdrant(meeting_id, transcript_id, revision)
            return L01Handle(
                step, request_id,
                {"meetingId": meeting_id, "transcriptId": transcript_id, "revision": revision},
            )

        if step == "assistant-grounded":
            meeting_id = self._require_state(state.meeting_id, "meeting")
            data, _ = self._core(
                "POST",
                "/api/v1/assistant/conversations",
                request_id=request_id,
                body={"meetingId": meeting_id, "title": "PI-05 L01 Assistant"},
            )
            conversation = self._data_dict(data, "Assistant conversation")
            state.conversation_id = self._require_state(
                conversation.get("id"), "Assistant conversation",
            )
            turn, _ = self._core(
                "POST",
                f"/api/v1/assistant/conversations/{state.conversation_id}/messages",
                request_id=str(uuid4()),
                idempotency_key=request_id,
                body={"question": "What decision did this meeting confirm?"},
            )
            result = self._data_dict(turn, "Assistant turn")
            citations = result.get("citations")
            if (
                result.get("state") != "COMPLETED"
                or result.get("answerStatus") != "GROUNDED"
                or not isinstance(citations, list)
                or not citations
            ):
                raise L01Unavailable("Assistant did not return a grounded answer")
            if any(
                not isinstance(item, dict) or item.get("meetingId") != meeting_id
                for item in citations
            ):
                raise L01Unavailable("Assistant citations are outside the meeting")
            return L01Handle(
                step, request_id,
                {"meetingId": meeting_id, "conversationId": state.conversation_id, "state": "COMPLETED"},
            )

        raise L01Unavailable("Unknown L01 step")

    @staticmethod
    def _envelope_data(payload: object) -> object:
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise ObserverBlocked("Core observation envelope is invalid")
        return payload.get("data")

    def observe(
        self,
        step: str,
        context: OrchestrationContext,
        state: _L01State,
        execution: StepExecution,
        requirement: tuple[str, str],
    ) -> str:
        component, result = requirement
        if component in {"CORE", "STORAGE", "RABBITMQ", "AI"}:
            observation = Observation(
                run_id=context.run_id,
                request_id=execution.request_id,
                step=step,
                component=component,
                observed_result=result,
                observed_at=datetime.now(UTC),
            )
        elif component == "QDRANT":
            # qdrant_observer creates the receipt only after the exact filtered
            # count is read over its pinned, run-owned boundary.
            if (
                state.meeting_id is None
                or state.transcript_id is None
                or type(state.transcript_revision) is not int
            ):
                raise ObserverBlocked("Qdrant observation state is incomplete")
            if context.proof_dir != self.settings.root / "proofs" or (
                context.source_dir != self.settings.root / "observation-sources"
            ):
                raise ObserverBlocked("Qdrant evidence directories are not run scoped")
            return observe_indexed(
                run_id=context.run_id,
                root=self.settings.root,
                generation=context.generation,
                collection=context.collection,
                meeting_id=state.meeting_id,
                source_id=state.transcript_id,
                revision=state.transcript_revision,
                request_id=execution.request_id,
            )
        else:
            raise ObserverBlocked("L01 observer component is invalid")

        if step == "meeting-record":
            meeting_id = _uuid(state.meeting_id, "meeting")
            return self.settings.observer_core.observe(
                observation,
                operation="meeting-read",
                path=f"/api/v1/meetings/{meeting_id}",
                checks=(
                    JsonCheck("success", ("success",), True),
                    JsonCheck("meeting-id", ("data", "id"), meeting_id),
                    JsonCheck("meeting-status", ("data", "status"), "DRAFT"),
                ),
                source_fields={"meetingId": meeting_id},
            )

        if step == "source-media-verified":
            if state.media_key is None or type(state.media_size) is not int:
                raise ObserverBlocked("Source media observation state is incomplete")
            return self.settings.storage_observer.observe_object(
                observation,
                key=state.media_key,
                expected_size=state.media_size,
                expected_content_type="audio/wav",
            )

        if step == "broker-message-delivered":
            return self.settings.rabbit_observer.observe_queue_sync(
                observation,
                minimum_message_count=self.settings.rabbit_minimum_message_count,
            )

        if step == "media-worker-completed":
            if state.job_id is None:
                raise ObserverBlocked("Worker observation state is incomplete")
            ai_payload = self.settings.ai_observer.request_json(
                execution.request_id, "GET", "/health/ready",
            )
            if not isinstance(ai_payload, dict) or ai_payload.get("status") != "ready":
                raise ObserverBlocked("AI HTTP runtime is not ready")
            job_payload = self.settings.observer_core.request_json(
                execution.request_id,
                f"/api/v1/processing-jobs/{state.job_id}",
            )
            job_data = self._envelope_data(job_payload)
            if not isinstance(job_data, dict) or job_data.get("status") not in _TERMINAL_JOBS:
                raise ObserverBlocked("Core did not independently expose a completed AI job")
            return self.writer.write(
                observation,
                {
                    "contractVersion": "pi05-observer-source-v1",
                    "boundary": "AI",
                    "operation": "worker-completion-and-readiness",
                    "aiEndpointPath": "/health/ready",
                    "coreEndpointPath": f"/api/v1/processing-jobs/{state.job_id}",
                    "aiStatus": "ready",
                    "jobStatus": job_data["status"],
                },
            )

        if step == "transcript-current":
            meeting_id = _uuid(state.meeting_id, "meeting")
            transcript_id = _uuid(state.transcript_id, "transcript")
            revision = state.transcript_revision
            if type(revision) is not int:
                raise ObserverBlocked("Transcript revision is invalid")

            def transcript(payload: object) -> Mapping[str, object]:
                data = self._envelope_data(payload)
                if (
                    not isinstance(data, dict)
                    or data.get("id") != transcript_id
                    or data.get("meetingId") != meeting_id
                    or data.get("status") not in _TRANSCRIPT_READY
                    or data.get("contentRevision") != revision
                ):
                    raise ObserverBlocked("Current transcript observation failed")
                return {
                    "transcriptId": transcript_id,
                    "meetingId": meeting_id,
                    "contentRevision": revision,
                    "status": data["status"],
                }

            return self.settings.observer_core.write_checked(
                observation,
                operation="current-transcript-read",
                path=f"/api/v1/meetings/{meeting_id}/transcript",
                predicate=transcript,
            )

        if step == "intelligence-proposal":
            meeting_id = _uuid(state.meeting_id, "meeting")
            decision_id = _uuid(state.decision_id, "decision")
            transcript_id = _uuid(state.transcript_id, "transcript")
            revision = state.transcript_revision
            if type(revision) is not int:
                raise ObserverBlocked("Decision transcript revision is invalid")

            def proposal(payload: object) -> Mapping[str, object]:
                data = self._envelope_data(payload)
                if not isinstance(data, list):
                    raise ObserverBlocked("Decision list is invalid")
                matches = [
                    item for item in data
                    if isinstance(item, dict)
                    and item.get("id") == decision_id
                    and item.get("meetingId") == meeting_id
                    and item.get("status") == "PROPOSED"
                    and item.get("sourceType") == "AI_EXTRACTED"
                    and item.get("transcriptId") == transcript_id
                    and item.get("contentRevision") == revision
                    and item.get("isStale") is False
                ]
                if len(matches) != 1:
                    raise ObserverBlocked("Intelligence proposal was not independently observed")
                return {
                    "meetingId": meeting_id,
                    "decisionId": decision_id,
                    "status": "PROPOSED",
                    "sourceType": "AI_EXTRACTED",
                    "transcriptId": transcript_id,
                    "contentRevision": revision,
                }

            return self.settings.observer_core.write_checked(
                observation,
                operation="decision-proposal-read",
                path=f"/api/v1/meetings/{meeting_id}/decisions",
                predicate=proposal,
            )

        if step == "human-decision-confirmed":
            meeting_id = _uuid(state.meeting_id, "meeting")
            decision_id = _uuid(state.decision_id, "decision")

            def confirmed(payload: object) -> Mapping[str, object]:
                data = self._envelope_data(payload)
                if not isinstance(data, list):
                    raise ObserverBlocked("Decision list is invalid")
                matches = [
                    item for item in data
                    if isinstance(item, dict)
                    and item.get("id") == decision_id
                    and item.get("meetingId") == meeting_id
                    and item.get("status") == "CONFIRMED"
                    and item.get("confirmedAt")
                    and item.get("confirmedByUserId")
                ]
                if len(matches) != 1:
                    raise ObserverBlocked("Confirmed decision was not independently observed")
                return {
                    "meetingId": meeting_id,
                    "decisionId": decision_id,
                    "status": "CONFIRMED",
                    "humanConfirmed": True,
                }

            return self.settings.observer_core.write_checked(
                observation,
                operation="decision-confirmation-read",
                path=f"/api/v1/meetings/{meeting_id}/decisions",
                predicate=confirmed,
            )

        if step == "assistant-grounded":
            meeting_id = _uuid(state.meeting_id, "meeting")
            conversation_id = _uuid(state.conversation_id, "Assistant conversation")

            def assistant(payload: object) -> Mapping[str, object]:
                data = self._envelope_data(payload)
                if not isinstance(data, dict):
                    raise ObserverBlocked("Assistant conversation is invalid")
                conversation = data.get("conversation")
                messages = data.get("messages")
                if not isinstance(conversation, dict) or conversation.get("meetingId") != meeting_id:
                    raise ObserverBlocked("Assistant conversation scope is invalid")
                if not isinstance(messages, list):
                    raise ObserverBlocked("Assistant messages are invalid")
                answers = [
                    item for item in messages
                    if isinstance(item, dict)
                    and item.get("role") == "ASSISTANT"
                    and item.get("answerStatus") == "GROUNDED"
                    and isinstance(item.get("citations"), list)
                    and item["citations"]
                ]
                if not answers:
                    raise ObserverBlocked("Grounded Assistant answer was not observed")
                if any(
                    not isinstance(citation, dict) or citation.get("meetingId") != meeting_id
                    for citation in answers[-1]["citations"]
                ):
                    raise ObserverBlocked("Assistant citation scope is invalid")
                return {
                    "meetingId": meeting_id,
                    "conversationId": conversation_id,
                    "answerStatus": "GROUNDED",
                    "citationCount": len(answers[-1]["citations"]),
                }

            return self.settings.observer_core.write_checked(
                observation,
                operation="assistant-grounded-answer-read",
                path=f"/api/v1/assistant/conversations/{conversation_id}",
                predicate=assistant,
            )

        raise ObserverBlocked("Unknown L01 observation step")


def build_l01_executor(
    context: OrchestrationContext,
    configuration: RunConfiguration,
) -> tuple[OrchestratorExecutor, _RealL01Operations]:
    """Explicitly assemble only L01 after real application readiness checks."""
    if configuration.run_id != context.run_id or configuration.root != context.proof_dir.parent:
        raise L01Unavailable("L01 configuration is outside the orchestration run")
    writer = ReceiptWriter(context.proof_dir, context.source_dir)
    settings = L01RuntimeSettings.from_configuration(configuration, writer=writer)
    operations = _RealL01Operations(context, settings)
    try:
        operations.readiness()
    except Exception:
        operations.close()
        raise

    from scenario_handlers import ScenarioHandlerRegistry

    registry = ScenarioHandlerRegistry(
        {SCENARIO: L01Adapter(context, operations).step_handlers()},
        enabled_scenarios=(SCENARIO,),
    )
    orchestrator = ScenarioOrchestrator(context, handlers=registry.handlers())
    return OrchestratorExecutor(orchestrator), operations


__all__ = [
    "L01Adapter",
    "L01Handle",
    "L01Operations",
    "L01RuntimeSettings",
    "L01Unavailable",
    "build_l01_executor",
]
