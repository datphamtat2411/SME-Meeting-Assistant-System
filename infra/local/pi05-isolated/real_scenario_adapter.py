#!/usr/bin/env python3
"""Real-service PI-05 adapters for live scenarios L02 through L10.

This module is deliberately boring at its boundary: fixtures identify already
provisioned, run-owned records, actions call the real Core/AI/worker
interfaces, and observers make a second bounded read before a receipt is
written.  It never creates a contract-valid fixture response and it never
converts an unavailable prerequisite into a PASS.

The operator still has to provision the disposable services, credentials,
worker controls, model assets, and scenario records.  Missing or ambiguous
provisioning raises ``ScenarioUnavailable`` through the scenario boundary.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import math
import os
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType
from typing import Any, Protocol
from uuid import UUID, uuid4

from boundary_observers import (
    HttpEndpoint,
    ObserverBlocked,
    _new_http_connection,
    _path,
)
from fault_adapters import DockerFaultRunner, FaultAdapter
from fault_scope import FaultScope
from l01_adapter import (
    CoreClient,
    L01RuntimeSettings,
    L01Unavailable,
)
from observation_receipts import Observation, ReceiptWriter
from runtime_config import RunConfiguration, RuntimeConfigError
from scenario_handlers import ScenarioHandlerError, StepExecution, StepHandler
from scenario_orchestrator import (
    OrchestrationContext,
    OrchestratorExecutor,
    ScenarioOrchestrator,
    ScenarioUnavailable,
)

L02_L10_SCENARIOS = (
    "revision-retrieval",
    "membership-revocation",
    "broker-redelivery",
    "worker-restart",
    "qdrant-outage",
    "inventory-coverage",
    "generation-rollback",
    "export-revocation",
    "room-notification",
)

_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z"
)
_DIGEST_RE = re.compile(r"[0-9a-f]{64}\Z")
_SAFE_KEY = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]{0,127}\Z")
_SAFE_VALUE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}\Z")
_GENERATION_VALUE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}\Z")
_UNSAFE_FIELD = re.compile(
    r"password|privatekey|clientkey|secret|accesstoken|refreshtoken|"
    r"authorization|presigned|signedurl|audio|transcripttext|prompt|rawcontent|"
    r"(^|[_.:-])(path|file|directory|socket|fifo)([_.:-]|$)",
    re.IGNORECASE,
)
_TERMINAL_JOB_STATUSES = frozenset({"COMPLETED", "COMPLETED_WITH_WARNINGS", "FAILED"})
_READY_TRANSCRIPT_STATUSES = frozenset({"READY", "READY_WITH_WARNINGS"})
_SAFE_ERROR = re.compile(r"[A-Z][A-Z0-9_.:-]{0,127}\Z")
_SCENARIO_TIMEOUT_DEFAULT = 14_400.0
_TRANSCRIPTION_WORKER_PROCESS = "transcription-worker"
_L08_GENERATION_FIELDS = (
    "incompleteCandidateGenerationId",
    "cleanCandidateGenerationId",
    "oldGenerationId",
)


class ScenarioFixtureError(RuntimeError):
    """Scenario fixture material is missing, overbroad, or outside the run."""


def _canonical_uuid(value: object, label: str) -> str:
    if not isinstance(value, str) or _UUID_RE.fullmatch(value) is None:
        raise ScenarioFixtureError(f"{label} must be a canonical UUID")
    try:
        canonical = str(UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise ScenarioFixtureError(f"{label} must be a canonical UUID") from error
    if canonical != value:
        raise ScenarioFixtureError(f"{label} must be a canonical UUID")
    return canonical


def _safe_tree(value: object, *, depth: int = 0, key: str | None = None) -> None:
    if depth > 5:
        raise ScenarioFixtureError("Scenario fixture is too deeply nested")
    if isinstance(value, dict):
        if len(value) > 64:
            raise ScenarioFixtureError("Scenario fixture has too many fields")
        for name, item in value.items():
            if (
                type(name) is not str
                or _SAFE_KEY.fullmatch(name) is None
                or _UNSAFE_FIELD.search(name) is not None
            ):
                raise ScenarioFixtureError("Scenario fixture contains a protected field")
            _safe_tree(item, depth=depth + 1, key=name)
        return
    if isinstance(value, list):
        if len(value) > 64:
            raise ScenarioFixtureError("Scenario fixture has too many values")
        for item in value:
            _safe_tree(item, depth=depth + 1, key=key)
        return
    if value is None or type(value) is bool or type(value) is int:
        if type(value) is int and abs(value) > 2**63 - 1:
            raise ScenarioFixtureError("Scenario fixture integer is out of bounds")
        return
    if isinstance(value, str):
        if len(value) > 512 or "\x00" in value or any(
            ord(char) < 0x20 or ord(char) == 0x7F for char in value
        ):
            raise ScenarioFixtureError("Scenario fixture string is unsafe")
        if key is not None and _UNSAFE_FIELD.search(key):
            raise ScenarioFixtureError("Scenario fixture contains a protected value")
        return
    raise ScenarioFixtureError("Scenario fixture contains an unsupported value")


def _unique_json(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _private_fixture_file(path: Path) -> Path:
    path = Path(path).absolute()
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ScenarioFixtureError("Scenario fixture path cannot be symbolic")
    try:
        info = path.stat()
    except OSError as error:
        raise ScenarioFixtureError("Scenario fixture file is unavailable") from error
    if (
        not path.is_file()
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
        or info.st_mode & 0o077
        or info.st_size > 64 * 1024
    ):
        raise ScenarioFixtureError("Scenario fixture file must be a private regular file")
    return path


@dataclass(frozen=True)
class ScenarioFixtureSet:
    """Immutable, exact L02-L10 fixture identities for one run."""

    path: Path
    run_id: str
    scenarios: Mapping[str, Mapping[str, object]]

    @classmethod
    def load(cls, path: Path, run_id: str) -> ScenarioFixtureSet:
        run_id = _canonical_uuid(run_id, "run ID")
        path = _private_fixture_file(Path(path))
        try:
            raw = json.loads(
                path.read_text(encoding="utf-8"),
                object_pairs_hook=_unique_json,
            )
        except (OSError, UnicodeError, ValueError, RecursionError) as error:
            raise ScenarioFixtureError("Scenario fixture JSON is invalid") from error
        if not isinstance(raw, dict) or set(raw) != {"runId", "fixtures"}:
            raise ScenarioFixtureError("Scenario fixture envelope is not exact")
        if raw["runId"] != run_id:
            raise ScenarioFixtureError("Scenario fixture run ID does not match")
        fixtures = raw["fixtures"]
        if not isinstance(fixtures, dict) or set(fixtures) != set(L02_L10_SCENARIOS):
            raise ScenarioFixtureError("Scenario fixture set is incomplete or overbroad")

        copied: dict[str, Mapping[str, object]] = {}
        for scenario in L02_L10_SCENARIOS:
            value = fixtures[scenario]
            if not isinstance(value, dict) or "meetingId" not in value or "sourceId" not in value:
                raise ScenarioFixtureError(f"{scenario} fixture identities are incomplete")
            _safe_tree(value)
            _canonical_uuid(value["meetingId"], f"{scenario} meeting ID")
            _canonical_uuid(value["sourceId"], f"{scenario} source ID")
            if scenario == "generation-rollback":
                generation_ids = []
                for field in _L08_GENERATION_FIELDS:
                    generation = value.get(field)
                    if (
                        not isinstance(generation, str)
                        or _GENERATION_VALUE.fullmatch(generation) is None
                        or not any(
                            token in generation.lower()
                            for token in (run_id, run_id.replace("-", ""))
                        )
                    ):
                        raise ScenarioFixtureError(
                            f"{scenario} {field} is not run scoped",
                        )
                    generation_ids.append(generation)
                if len(set(generation_ids)) != len(generation_ids):
                    raise ScenarioFixtureError(
                        f"{scenario} generation identities must be distinct",
                    )
            copied[scenario] = MappingProxyType(dict(value))
        return cls(path, run_id, MappingProxyType(copied))

    def for_scenario(self, scenario: str) -> Mapping[str, object]:
        if scenario not in self.scenarios:
            raise ScenarioFixtureError("Scenario fixture is not enabled")
        return self.scenarios[scenario]


@dataclass(frozen=True)
class ScenarioHandle:
    """Sanitized action result; raw service payloads never cross this boundary."""

    step: str
    request_id: str
    values: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.step not in {
            step for scenario in L02_L10_SCENARIOS for step in _required_steps(scenario)
        }:
            raise ScenarioFixtureError("Scenario handle step is invalid")
        _canonical_uuid(self.request_id, "scenario request ID")
        if not isinstance(self.values, Mapping):
            raise ScenarioFixtureError("Scenario handle values are invalid")
        copied: dict[str, object] = {}
        for key, value in self.values.items():
            if (
                type(key) is not str
                or _SAFE_KEY.fullmatch(key) is None
                or _UNSAFE_FIELD.search(key)
                or value is not None
                and type(value) not in (bool, int, str)
            ):
                raise ScenarioFixtureError("Scenario handle values are not sanitized")
            if isinstance(value, str) and (
                len(value) > 512
                or "\x00" in value
                or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)
            ):
                raise ScenarioFixtureError("Scenario handle value is unsafe")
            copied[key] = value
        object.__setattr__(self, "values", MappingProxyType(copied))


class ScenarioOperations(Protocol):
    def action(
        self, step: str, context: OrchestrationContext, request_id: str,
    ) -> ScenarioHandle:
        ...

    def observe(
        self,
        step: str,
        context: OrchestrationContext,
        execution: StepExecution,
        requirement: tuple[str, str],
    ) -> str:
        ...


def _required_steps(scenario: str) -> tuple[str, ...]:
    from scenario_orchestrator import SCENARIO_PLANS

    return tuple(SCENARIO_PLANS[scenario])


class RealScenarioAdapter:
    """Enforce one real action and one independent observation per step."""

    def __init__(
        self,
        context: OrchestrationContext,
        scenario: str,
        operations: ScenarioOperations,
    ):
        if not isinstance(context, OrchestrationContext):
            raise TypeError("PI-05 orchestration context is required")
        if scenario not in L02_L10_SCENARIOS:
            raise ScenarioFixtureError("Only L02-L10 scenarios use this adapter")
        if not callable(getattr(operations, "action", None)) or not callable(
            getattr(operations, "observe", None)
        ):
            raise TypeError("Real scenario operations are required")
        self.context = context
        self.scenario = scenario
        self.operations = operations
        self._expected_action = 0
        self._executions: dict[str, StepExecution] = {}
        self._observed: set[str] = set()

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
            raise ScenarioHandlerError("Scenario context does not match the configured run")

    def _action(self, step: str, context: OrchestrationContext) -> StepExecution:
        self._check_context(context)
        steps = _required_steps(self.scenario)
        if step not in steps or steps.index(step) != self._expected_action:
            raise ScenarioHandlerError("Scenario actions were invoked out of order")
        request_id = str(uuid4())
        try:
            handle = self.operations.action(step, self.context, request_id)
        except ScenarioHandlerError:
            raise
        except Exception as error:
            raise ScenarioHandlerError("Scenario real action failed") from error
        if not isinstance(handle, ScenarioHandle) or handle.request_id != request_id:
            raise ScenarioHandlerError("Scenario action returned an invalid execution handle")
        if handle.step != step:
            raise ScenarioHandlerError("Scenario action returned the wrong step")
        execution = StepExecution(request_id, handle)
        self._executions[step] = execution
        self._expected_action += 1
        return execution

    def _observe(
        self,
        step: str,
        context: OrchestrationContext,
        execution: StepExecution,
        requirement: tuple[str, str],
    ) -> str:
        self._check_context(context)
        steps = _required_steps(self.scenario)
        if step not in steps or steps.index(step) >= self._expected_action:
            raise ScenarioHandlerError("Scenario observation has no completed action")
        if step in self._observed or self._executions.get(step) != execution:
            raise ScenarioHandlerError("Scenario observation identity is invalid or repeated")
        if requirement != _requirements(self.scenario)[step]:
            raise ScenarioHandlerError("Scenario requirement was changed")
        if not isinstance(execution.opaque_result, ScenarioHandle):
            raise ScenarioHandlerError("Scenario observer received an invalid action handle")
        try:
            digest = self.operations.observe(
                step, self.context, execution, requirement,
            )
        except ScenarioHandlerError:
            raise
        except Exception as error:
            raise ScenarioHandlerError("Scenario independent observation failed") from error
        if not isinstance(digest, str) or _DIGEST_RE.fullmatch(digest) is None:
            raise ScenarioHandlerError("Scenario observer did not return a receipt digest")
        self._observed.add(step)
        return digest

    def step_handlers(self) -> dict[str, StepHandler]:
        return {
            step: StepHandler(
                action=lambda context, step=step: self._action(step, context),
                observer=lambda context, execution, requirement, step=step:
                    self._observe(step, context, execution, requirement),
            )
            for step in _required_steps(self.scenario)
        }


def _requirements(scenario: str) -> dict[str, tuple[str, str]]:
    from scenario_orchestrator import SCENARIO_PLANS

    return SCENARIO_PLANS[scenario]


def _safe_uuid(value: object, label: str) -> str:
    try:
        return _canonical_uuid(value, label)
    except ScenarioFixtureError as error:
        raise ScenarioUnavailable(str(error)) from error


def _safe_int(value: object, label: str, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ScenarioUnavailable(f"{label} is invalid")
    return value


def _safe_generation(value: object, run_id: str, label: str) -> str:
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}", value) is None
        or not any(token in value.lower() for token in (run_id, run_id.replace("-", "")))
    ):
        raise ScenarioUnavailable(f"{label} is not run scoped")
    return value


def _data(payload: object, label: str) -> object:
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise ScenarioUnavailable(f"{label} response is invalid")
    if "data" not in payload:
        raise ScenarioUnavailable(f"{label} response is incomplete")
    return payload["data"]


def _data_dict(payload: object, label: str) -> dict[str, object]:
    value = _data(payload, label)
    if not isinstance(value, dict):
        raise ScenarioUnavailable(f"{label} data is invalid")
    return value


class ScenarioAiClient:
    """Pinned JSON client for bounded, read-only AI reconciliation calls."""

    def __init__(self, endpoint: HttpEndpoint):
        self.endpoint = endpoint

    def request_status(
        self,
        method: str,
        path: str,
        *,
        request_id: str,
        body: object | None = None,
    ) -> tuple[int, dict[str, object]]:
        if method not in {"GET", "POST"}:
            raise ScenarioUnavailable("AI operation method is invalid")
        try:
            request_id = str(UUID(request_id))
        except (ValueError, TypeError, AttributeError) as error:
            raise ScenarioUnavailable("AI request identity is invalid") from error
        if request_id != str(UUID(request_id)) or _path(path) != path:
            raise ScenarioUnavailable("AI operation path is invalid")
        connection = _new_http_connection(self.endpoint)
        raw_body = None
        headers = {
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "X-Request-Id": request_id,
        }
        if body is not None:
            try:
                raw_body = json.dumps(
                    body, sort_keys=True, separators=(",", ":"), allow_nan=False,
                ).encode("utf-8")
            except (TypeError, ValueError) as error:
                raise ScenarioUnavailable("AI request body is invalid") from error
            if len(raw_body) > 256 * 1024:
                raise ScenarioUnavailable("AI request body exceeds the bound")
            headers["Content-Type"] = "application/json"
        try:
            connection.connect()
            connection.request(method, path, body=raw_body, headers=headers)
            response = connection.getresponse()
            raw = response.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                raise ScenarioUnavailable("AI response exceeds the bound")
            try:
                payload = json.loads(raw, object_pairs_hook=_unique_json)
            except (UnicodeError, ValueError, RecursionError) as error:
                raise ScenarioUnavailable("AI response is not valid JSON") from error
            if not isinstance(payload, dict):
                raise ScenarioUnavailable("AI response envelope is invalid")
            return response.status, payload
        except ScenarioUnavailable:
            raise
        except (OSError, ValueError) as error:
            raise ScenarioUnavailable("AI operation was unavailable") from error
        finally:
            connection.close()

    def get(self, path: str, request_id: str) -> dict[str, object]:
        status, payload = self.request_status("GET", path, request_id=request_id)
        if status != 200:
            raise ScenarioUnavailable("AI read operation was rejected")
        return payload


class WorkerBoundaryClient:
    """Pinned mTLS client for read-only worker delivery and bounded stale-owner probes."""

    def __init__(self, endpoint: HttpEndpoint):
        self.endpoint = endpoint

    def request_status(
        self,
        method: str,
        path: str,
        *,
        request_id: str,
        body: object | None = None,
    ) -> tuple[int, dict[str, object]]:
        if method not in {"GET", "POST"} or _path(path) != path:
            raise ScenarioUnavailable("Worker operation is invalid")
        try:
            if str(UUID(request_id)) != request_id:
                raise ValueError
        except (ValueError, TypeError, AttributeError) as error:
            raise ScenarioUnavailable("Worker request identity is invalid") from error
        raw_body = None
        headers = {
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "X-Request-Id": request_id,
        }
        if body is not None:
            try:
                raw_body = json.dumps(
                    body, sort_keys=True, separators=(",", ":"), allow_nan=False,
                ).encode("utf-8")
            except (TypeError, ValueError) as error:
                raise ScenarioUnavailable("Worker request body is invalid") from error
            if len(raw_body) > 16 * 1024:
                raise ScenarioUnavailable("Worker request body exceeds the bound")
            headers["Content-Type"] = "application/json"
        connection = _new_http_connection(self.endpoint)
        try:
            connection.connect()
            connection.request(method, path, body=raw_body, headers=headers)
            response = connection.getresponse()
            raw = response.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                raise ScenarioUnavailable("Worker response exceeds the bound")
            try:
                payload = json.loads(raw, object_pairs_hook=_unique_json)
            except (UnicodeError, ValueError, RecursionError) as error:
                raise ScenarioUnavailable("Worker response is not valid JSON") from error
            if not isinstance(payload, dict):
                raise ScenarioUnavailable("Worker response envelope is invalid")
            return response.status, payload
        except ScenarioUnavailable:
            raise
        except (OSError, ValueError) as error:
            raise ScenarioUnavailable("Worker operation was unavailable") from error
        finally:
            connection.close()


class CoreMetricsClient:
    """Read only the allowlisted private operational metric families."""

    _METRIC_RE = re.compile(
        r"^(product_integration_notification_(?:pending|failed))"
        r"(?:\{[^{}\n]*\})?\s+([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$"
    )

    def __init__(self, endpoint: HttpEndpoint):
        self.endpoint = endpoint

    def notification_counts(self, request_id: str) -> tuple[int, int]:
        try:
            if str(UUID(request_id)) != request_id:
                raise ValueError
        except (ValueError, TypeError, AttributeError) as error:
            raise ScenarioUnavailable("Metrics request identity is invalid") from error
        connection = _new_http_connection(self.endpoint)
        try:
            connection.connect()
            connection.request(
                "GET",
                "/internal/monitoring/prometheus",
                headers={
                    "Accept": "text/plain",
                    "Cache-Control": "no-cache",
                    "X-Request-Id": request_id,
                },
            )
            response = connection.getresponse()
            if response.status != 200:
                raise ScenarioUnavailable("Core metrics boundary was rejected")
            raw = response.read(128 * 1024 + 1)
            if len(raw) > 128 * 1024:
                raise ScenarioUnavailable("Core metrics response exceeds the bound")
            try:
                text = raw.decode("utf-8")
            except UnicodeError as error:
                raise ScenarioUnavailable("Core metrics response is not UTF-8") from error
            values: dict[str, float] = {}
            for line in text.splitlines():
                match = self._METRIC_RE.fullmatch(line.strip())
                if match:
                    try:
                        number = float(match[2])
                    except ValueError as error:
                        raise ScenarioUnavailable("Core notification metric is invalid") from error
                    if not math.isfinite(number) or number < 0:
                        raise ScenarioUnavailable("Core notification metric is invalid")
                    values[match[1]] = number
            if set(values) != {
                "product_integration_notification_pending",
                "product_integration_notification_failed",
            }:
                raise ScenarioUnavailable("Core notification metrics are incomplete")
            return int(values["product_integration_notification_pending"]), int(
                values["product_integration_notification_failed"]
            )
        except ScenarioUnavailable:
            raise
        except (OSError, ValueError) as error:
            raise ScenarioUnavailable("Core metrics boundary was unavailable") from error
        finally:
            connection.close()


@dataclass
class ScenarioRuntimeSettings:
    """All real endpoints and controls needed by one explicit L02-L10 run."""

    root: Path
    configuration: RunConfiguration
    fixtures: ScenarioFixtureSet
    writer: ReceiptWriter
    l01: L01RuntimeSettings
    revoked_member_core: CoreClient
    worker_endpoint: HttpEndpoint
    ai_endpoint: HttpEndpoint
    metrics_endpoint: HttpEndpoint
    runtime: Any
    timeout_seconds: float
    poll_interval_seconds: float

    @classmethod
    def from_configuration(
        cls,
        context: OrchestrationContext,
        configuration: RunConfiguration,
        *,
        writer: ReceiptWriter,
        runtime: Any,
    ) -> ScenarioRuntimeSettings:
        h = configuration.harness
        fixture_name = "PI05_SCENARIO_FIXTURES_FILE"
        if fixture_name not in configuration.harness_env:
            raise RuntimeConfigError("L02-L10 fixture configuration is missing")
        fixture_path = Path(h(fixture_name)).absolute()
        if configuration.root not in fixture_path.parents:
            raise RuntimeConfigError("L02-L10 fixtures must be inside the run root")
        fixtures = ScenarioFixtureSet.load(fixture_path, context.run_id)
        l01 = L01RuntimeSettings.from_configuration(configuration, writer=writer)
        member_required = (
            "PI05_REVOKED_MEMBER_EMAIL",
            "PI05_REVOKED_MEMBER_PASSWORD",
        )
        if any(name not in configuration.harness_env for name in member_required):
            raise RuntimeConfigError("L03/L09 revoked-member credentials are incomplete")

        def run_path(value: str, label: str) -> Path:
            path = Path(value).absolute()
            if configuration.root not in path.parents or path.is_symlink():
                raise RuntimeConfigError(f"{label} must be a run-owned file")
            return path

        worker_cert = configuration.transcription_worker_env.get("AI_CORE_API_CLIENT_CERT_FILE")
        worker_key = configuration.transcription_worker_env.get("AI_CORE_API_CLIENT_KEY_FILE")
        worker_ca = configuration.transcription_worker_env.get("AI_CORE_API_SERVER_CA_FILE")
        if not all(isinstance(value, str) and value for value in (worker_cert, worker_key, worker_ca)):
            raise RuntimeConfigError("AI worker Core mTLS material is incomplete")
        worker_endpoint = HttpEndpoint(
            h("PI05_CORE_BASE_URL"),
            run_path(worker_ca, "worker Core CA"),
            run_path(worker_cert, "worker Core certificate"),
            run_path(worker_key, "worker Core key"),
            h("PI05_CORE_LEAF_SHA256"),
            tls_server_name=h("PI05_CORE_TLS_SERVER_NAME"),
            http_host=h("PI05_CORE_TLS_SERVER_NAME"),
        )
        ai_endpoint = l01.ai_observer.endpoint
        metrics_endpoint = HttpEndpoint(
            h("PI05_CORE_BASE_URL"),
            run_path(h("PI05_CORE_CA_FILE"), "Core metrics CA"),
            run_path(h("PI05_CORE_OBSERVER_CERT_FILE"), "Core metrics certificate"),
            run_path(h("PI05_CORE_OBSERVER_KEY_FILE"), "Core metrics key"),
            h("PI05_CORE_LEAF_SHA256"),
            tls_server_name=h("PI05_CORE_TLS_SERVER_NAME"),
            http_host=h("PI05_CORE_TLS_SERVER_NAME"),
        )
        revoked_member_core = CoreClient(
            h("PI05_CORE_BASE_URL"),
            ca_file=run_path(h("PI05_CORE_CA_FILE"), "revoked-member Core CA"),
            client_cert=run_path(
                h("PI05_CORE_CERT_FILE"), "revoked-member Core certificate",
            ),
            client_key=run_path(
                h("PI05_CORE_KEY_FILE"), "revoked-member Core key",
            ),
            leaf_sha256=h("PI05_CORE_LEAF_SHA256"),
            email=h("PI05_REVOKED_MEMBER_EMAIL"),
            password=h("PI05_REVOKED_MEMBER_PASSWORD"),
            timeout_seconds=15,
            tls_server_name=h("PI05_CORE_TLS_SERVER_NAME"),
            connect_host=h("PI05_CORE_CONNECT_HOST"),
        )
        try:
            timeout = float(h.get("PI05_SCENARIO_TIMEOUT_SECONDS", _SCENARIO_TIMEOUT_DEFAULT))
            poll = float(h.get("PI05_POLL_INTERVAL_SECONDS", "1"))
        except (TypeError, ValueError) as error:
            raise RuntimeConfigError("L02-L10 timing configuration is invalid") from error
        if not 60 <= timeout <= _SCENARIO_TIMEOUT_DEFAULT or not 0.05 <= poll <= 30:
            raise RuntimeConfigError("L02-L10 timing configuration is out of bounds")
        return cls(
            root=configuration.root,
            configuration=configuration,
            fixtures=fixtures,
            writer=writer,
            l01=l01,
            revoked_member_core=revoked_member_core,
            worker_endpoint=worker_endpoint,
            ai_endpoint=ai_endpoint,
            metrics_endpoint=metrics_endpoint,
            runtime=runtime,
            timeout_seconds=timeout,
            poll_interval_seconds=poll,
        )


class RealScenarioOperations:
    """Concrete real-boundary action/observation implementation for one scenario."""

    def __init__(
        self,
        context: OrchestrationContext,
        scenario: str,
        settings: ScenarioRuntimeSettings,
    ):
        if scenario not in L02_L10_SCENARIOS:
            raise ScenarioUnavailable("Scenario is not enabled")
        self.context = context
        self.scenario = scenario
        self.settings = settings
        self.fixture = settings.fixtures.for_scenario(scenario)
        self.writer = settings.writer
        self.ai_action = ScenarioAiClient(settings.ai_endpoint)
        self.ai_observer = ScenarioAiClient(settings.ai_endpoint)
        self.worker_action = WorkerBoundaryClient(settings.worker_endpoint)
        self.worker_observer = WorkerBoundaryClient(settings.worker_endpoint)
        self.metrics = CoreMetricsClient(settings.metrics_endpoint)
        self._state: dict[str, object] = {}
        self._assistant_pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="pi05-l03-assistant",
        )
        self._assistant_future: concurrent.futures.Future | None = None

    def close(self) -> None:
        self._recover_faults()
        if self._assistant_future is not None:
            try:
                self._assistant_future.result(timeout=2)
            except Exception:  # noqa: BLE001
                self._assistant_future.cancel()
        self._assistant_pool.shutdown(wait=False, cancel_futures=True)
        self.settings.l01.action_core.close()
        self.settings.l01.observer_core.close()
        self.settings.revoked_member_core.close()

    def _recover_faults(self) -> None:
        """Return run-owned application/container faults to a usable state."""
        if self._state.get("workerStopped") is True:
            try:
                self._restart_worker()
            except Exception:
                pass
        if self._state.get("qdrantStopped") is True:
            try:
                self._fault("qdrant").start("qdrant")
                self._wait_for_container_state("qdrant", "running")
                self._state["qdrantStopped"] = False
            except Exception:
                pass

    def readiness(self) -> None:
        try:
            core = self.settings.l01.observer_core.request_json(
                str(uuid4()), "/actuator/health/readiness",
            )
            if not isinstance(core, dict) or core.get("status") not in {"UP", "up"}:
                raise ScenarioUnavailable("Core readiness is not ready")
            ai = self.settings.l01.ai_observer.request_json(
                str(uuid4()), "GET", "/health/ready",
            )
            if not isinstance(ai, dict) or ai.get("status") != "ready":
                raise ScenarioUnavailable("AI readiness is not ready")
            for process_name in (
                _TRANSCRIPTION_WORKER_PROCESS,
                "mi-worker",
                "knowledge-worker",
            ):
                status = self.settings.runtime.status(process_name)
                if status.get("running") is not True:
                    raise ScenarioUnavailable(f"{process_name} is not running")
            self.settings.l01.rabbit_observer.probe_queue()
        except (ScenarioUnavailable, ObserverBlocked):
            raise
        except Exception as error:
            raise ScenarioUnavailable("L02-L10 readiness could not be observed") from error

    def _check_context(self, context: OrchestrationContext) -> None:
        if (
            context.run_id != self.context.run_id
            or context.commit != self.context.commit
            or context.generation != self.context.generation
            or context.collection != self.context.collection
            or context.proof_dir != self.context.proof_dir
            or context.source_dir != self.context.source_dir
        ):
            raise ScenarioUnavailable("Scenario operation is outside the configured run")

    def _fixture_uuid(self, name: str, *, fallback: str | None = None) -> str:
        value = self.fixture.get(name, fallback)
        return _safe_uuid(value, name)

    def _fixture_generation(self, name: str) -> str:
        return _safe_generation(self.fixture.get(name), self.context.run_id, name)

    def _core_status(
        self,
        method: str,
        path: str,
        *,
        request_id: str,
        body: object | None = None,
        idempotency_key: str | None = None,
        if_match: str | None = None,
    ) -> tuple[int, dict[str, object], Mapping[str, str]]:
        try:
            return self.settings.l01.action_core.request_status(
                method,
                path,
                request_id=request_id,
                body=body,
                idempotency_key=idempotency_key,
                if_match=if_match,
            )
        except L01Unavailable as error:
            raise ScenarioUnavailable("Core scenario operation was unavailable") from error

    def _core_data(
        self,
        method: str,
        path: str,
        *,
        request_id: str,
        body: object | None = None,
        idempotency_key: str | None = None,
        if_match: str | None = None,
    ) -> tuple[object, Mapping[str, str]]:
        try:
            return self.settings.l01.action_core.request(
                method,
                path,
                request_id=request_id,
                body=body,
                idempotency_key=idempotency_key,
                if_match=if_match,
            )
        except L01Unavailable as error:
            raise ScenarioUnavailable("Core scenario operation was unavailable") from error

    def _member_data(
        self,
        method: str,
        path: str,
        *,
        request_id: str,
        body: object | None = None,
        idempotency_key: str | None = None,
        if_match: str | None = None,
    ) -> tuple[object, Mapping[str, str]]:
        try:
            return self.settings.revoked_member_core.request(
                method,
                path,
                request_id=request_id,
                body=body,
                idempotency_key=idempotency_key,
                if_match=if_match,
            )
        except L01Unavailable as error:
            raise ScenarioUnavailable(
                "Revoked-member Core operation was unavailable",
            ) from error

    def _member_status(
        self,
        method: str,
        path: str,
        *,
        request_id: str,
        body: object | None = None,
        idempotency_key: str | None = None,
        if_match: str | None = None,
    ) -> tuple[int, dict[str, object], Mapping[str, str]]:
        try:
            return self.settings.revoked_member_core.request_status(
                method,
                path,
                request_id=request_id,
                body=body,
                idempotency_key=idempotency_key,
                if_match=if_match,
            )
        except L01Unavailable as error:
            raise ScenarioUnavailable(
                "Revoked-member Core operation was unavailable",
            ) from error

    def _handle(self, step: str, request_id: str, **values: object) -> ScenarioHandle:
        return ScenarioHandle(step, request_id, values)

    def _poll_core(
        self,
        path: str,
        request_id: str,
        predicate,
    ) -> dict[str, object]:
        deadline = time.monotonic() + self.settings.timeout_seconds
        while time.monotonic() < deadline:
            data, _ = self._core_data("GET", path, request_id=request_id)
            if not isinstance(data, dict):
                raise ScenarioUnavailable("Core polling response is invalid")
            if predicate(data):
                return data
            time.sleep(self.settings.poll_interval_seconds)
        raise ScenarioUnavailable("Core scenario operation timed out")

    def _meeting(self) -> str:
        return self._fixture_uuid("meetingId")

    def _transcript(self, meeting_id: str) -> tuple[dict[str, object], Mapping[str, str]]:
        data, headers = self._core_data(
            "GET", f"/api/v1/meetings/{meeting_id}/transcript", request_id=str(uuid4()),
        )
        transcript = _require_dict(data, "current transcript")
        if transcript.get("meetingId") != meeting_id:
            raise ScenarioUnavailable("Transcript is outside the fixture meeting")
        return transcript, headers

    def _segment_id(self, transcript: Mapping[str, object]) -> str:
        segments = transcript.get("segments")
        if not isinstance(segments, list) or not segments:
            raise ScenarioUnavailable("Transcript has no editable segment")
        candidate = segments[0]
        if not isinstance(candidate, dict):
            raise ScenarioUnavailable("Transcript segment is invalid")
        return _safe_uuid(candidate.get("id"), "transcript segment")

    def _job_and_event(self) -> tuple[str, str]:
        job_id = self._fixture_uuid("jobId")
        event_id = self._fixture_uuid("eventId")
        return job_id, event_id

    def _worker_path(self, job_id: str, stage: str, suffix: str) -> str:
        if stage not in {"transcription", "intelligence", "diarization"}:
            raise ScenarioUnavailable("Worker stage is invalid")
        return f"/internal/v1/worker/processing-jobs/{job_id}/{stage}/{suffix}"

    def _worker_delivery(
        self,
        client: WorkerBoundaryClient,
        job_id: str,
        stage: str,
        event_id: str,
        request_id: str,
        *,
        observer: bool = False,
    ) -> dict[str, object]:
        try:
            status, payload = client.request_status(
                "GET",
                self._worker_path(job_id, stage, f"deliveries/{event_id}"),
                request_id=request_id,
            )
            if status != 200:
                raise ScenarioUnavailable("Worker delivery observation was rejected")
            data = _data_dict(payload, "worker delivery")
        except ScenarioUnavailable as error:
            if observer:
                raise ObserverBlocked("Worker delivery observation was invalid") from error
            raise
        if (
            data.get("processingJobId") != job_id
            or data.get("eventId") != event_id
        ):
            error = "Worker delivery identity does not match the fixture"
            if observer:
                raise ObserverBlocked(error)
            raise ScenarioUnavailable(error)
        return data

    def _restart_worker(self) -> None:
        restart = getattr(self.settings.runtime, "restart", None)
        if not callable(restart):
            raise ScenarioUnavailable("Run-owned worker restart control is unavailable")
        try:
            restart(
                _TRANSCRIPTION_WORKER_PROCESS,
                self.settings.configuration.application_environments(),
            )
        except Exception as error:
            raise ScenarioUnavailable("Run-owned worker restart failed") from error
        self._state["workerStopped"] = False

    def _qdrant_port(self) -> int:
        try:
            import runtime_inspection

            topology = runtime_inspection.inspect_topology(
                self.context.run_id, self.settings.root,
            )
        except Exception as error:
            raise ScenarioUnavailable("Run-owned Qdrant topology is unavailable") from error
        endpoint = topology.get("qdrant") if isinstance(topology, dict) else None
        match = re.fullmatch(r"127\.0\.0\.1:([1-9][0-9]{0,4})", endpoint or "")
        if not match or int(match[1]) > 65535:
            raise ScenarioUnavailable("Run-owned Qdrant endpoint is invalid")
        return int(match[1])

    def _fault(self, service: str) -> FaultAdapter:
        try:
            import runtime_inspection

            containers = self._state.get("containerIds")
            if not isinstance(containers, dict):
                containers = runtime_inspection.inspect_container_ids(
                    self.context.run_id, self.settings.root,
                )
                self._state["containerIds"] = dict(containers)
            else:
                runtime_inspection.inspect_container_state(
                    self.context.run_id,
                    self.settings.root,
                    service,
                    container_id=containers.get(service),
                )
            scope = FaultScope(self.context.run_id, containers)
            return FaultAdapter(scope, DockerFaultRunner())
        except Exception as error:
            raise ScenarioUnavailable(f"Run-owned {service} fault control is unavailable") from error

    def _container_state(self, service: str) -> Mapping[str, object]:
        container_ids = self._state.get("containerIds")
        if not isinstance(container_ids, dict):
            raise ScenarioUnavailable("Fault container identity was not captured")
        container_id = container_ids.get(service)
        if not isinstance(container_id, str):
            raise ScenarioUnavailable("Fault container identity is unavailable")
        try:
            import runtime_inspection

            return runtime_inspection.inspect_container_state(
                self.context.run_id,
                self.settings.root,
                service,
                container_id=container_id,
            )
        except Exception as error:
            raise ScenarioUnavailable("Fault container state was unavailable") from error

    def _wait_for_container_state(self, service: str, expected: str) -> Mapping[str, object]:
        deadline = time.monotonic() + min(self.settings.timeout_seconds, 60)
        while time.monotonic() < deadline:
            state = self._container_state(service)
            if state.get("status") == expected:
                return state
            time.sleep(self.settings.poll_interval_seconds)
        raise ScenarioUnavailable("Fault container did not reach the expected state")

    def action(
        self, step: str, context: OrchestrationContext, request_id: str,
    ) -> ScenarioHandle:
        self._check_context(context)
        dispatch = getattr(self, f"_action_{self.scenario.replace('-', '_')}", None)
        if not callable(dispatch):
            raise ScenarioUnavailable("Scenario action implementation is unavailable")
        return dispatch(step, request_id)

    def observe(
        self,
        step: str,
        context: OrchestrationContext,
        execution: StepExecution,
        requirement: tuple[str, str],
    ) -> str:
        self._check_context(context)
        component, outcome = requirement
        observation = Observation(
            run_id=context.run_id,
            request_id=execution.request_id,
            step=step,
            component=component,
            observed_result=outcome,
            observed_at=datetime.now(UTC),
        )
        dispatch = getattr(self, f"_observe_{self.scenario.replace('-', '_')}", None)
        if not callable(dispatch):
            raise ScenarioUnavailable("Scenario observer implementation is unavailable")
        return dispatch(step, observation)

    # ---- L02: transcript revision and current-source retrieval -----------------

    def _action_revision_retrieval(self, step: str, request_id: str) -> ScenarioHandle:
        meeting_id = self._meeting()
        transcript, headers = self._transcript(meeting_id)
        transcript_id = _safe_uuid(transcript.get("id"), "transcript")
        expected_source = self._fixture_uuid("sourceId")
        if transcript_id != expected_source:
            raise ScenarioUnavailable("Fixture transcript is not the current transcript")
        if step == "transcript-revised":
            revision = _safe_int(transcript.get("contentRevision"), "transcript revision")
            etag = headers.get("ETag") or f'"t-{transcript_id}-{revision}"'
            segment_id = self._segment_id(transcript)
            data, _ = self._core_data(
                "PATCH",
                f"/api/v1/meetings/{meeting_id}/transcript/segments/{segment_id}",
                request_id=request_id,
                if_match=etag,
                body={
                    "text": f"PI-05 L02 reviewed revision {contextual_run_suffix(self.context.run_id)}",
                    "reason": "PI-05 revision replacement",
                },
            )
            changed = _require_dict(data, "transcript correction")
            new_revision = _safe_int(changed.get("contentRevision"), "new transcript revision")
            if new_revision <= revision:
                raise ScenarioUnavailable("Core did not publish a new transcript revision")
            self._state.update({
                "meetingId": meeting_id,
                "transcriptId": transcript_id,
                "oldRevision": revision,
                "newRevision": new_revision,
            })
            return self._handle(
                step, request_id, meetingId=meeting_id, transcriptId=transcript_id,
                oldRevision=revision, newRevision=new_revision,
            )
        if step in {"old-revision-rejected", "new-revision-retrieved"}:
            old_revision = _safe_int(self._state.get("oldRevision"), "old revision")
            new_revision = _safe_int(self._state.get("newRevision"), "new revision")
            revision = old_revision if step == "old-revision-rejected" else new_revision
            request = _reconciliation_request(
                meeting_id, transcript_id, revision, self.context.generation,
            )
            status, payload = self.ai_action.request_status(
                "POST",
                "/internal/v1/knowledge-indexing/reconciliation",
                request_id=request_id,
                body=request,
            )
            if status != 200:
                raise ScenarioUnavailable("AI rejected the reconciliation read")
            records = payload.get("records")
            if not isinstance(records, list) or len(records) != 1:
                raise ScenarioUnavailable("AI reconciliation response is incomplete")
            record = records[0]
            identity = record.get("sourceIdentity") if isinstance(record, dict) else None
            source_revision = record.get("sourceRevision") if isinstance(record, dict) else None
            if (
                payload.get("generationId") != self.context.generation
                or not isinstance(identity, dict)
                or identity.get("sourceType") != "TRANSCRIPT"
                or identity.get("sourceId") != transcript_id
                or identity.get("meetingId") != meeting_id
                or not isinstance(source_revision, dict)
                or source_revision.get("number") != revision
            ):
                raise ScenarioUnavailable("AI reconciliation identity is invalid")
            count = _safe_int(record.get("pointCount"), "AI point count")
            if step == "old-revision-rejected" and count != 0:
                raise ScenarioUnavailable("AI still exposes the old transcript revision")
            if step == "new-revision-retrieved" and count <= 0:
                raise ScenarioUnavailable("AI did not expose the new transcript revision")
            self._state["revisionCount"] = count
            return self._handle(
                step, request_id, meetingId=meeting_id, transcriptId=transcript_id,
                revision=revision, pointCount=count,
            )
        raise ScenarioUnavailable("Unknown L02 step")

    def _observe_revision_retrieval(self, step: str, observation: Observation) -> str:
        meeting_id = _safe_uuid(self._state.get("meetingId"), "meeting")
        transcript_id = _safe_uuid(self._state.get("transcriptId"), "transcript")
        if step == "transcript-revised":
            expected = _safe_int(self._state.get("newRevision"), "new revision")

            def check(payload: object) -> Mapping[str, object]:
                data = _data_dict(payload, "current transcript")
                if (
                    data.get("id") != transcript_id
                    or data.get("meetingId") != meeting_id
                    or data.get("status") not in _READY_TRANSCRIPT_STATUSES
                    or data.get("contentRevision") != expected
                ):
                    raise ObserverBlocked("Current transcript revision was not observed")
                return {
                    "boundary": "CORE",
                    "operation": "current-transcript-after-revision",
                    "transcriptId": transcript_id,
                    "meetingId": meeting_id,
                    "contentRevision": expected,
                    "status": data["status"],
                }

            return self.settings.l01.observer_core.write_checked(
                observation,
                operation="current-transcript-after-revision",
                path=f"/api/v1/meetings/{meeting_id}/transcript",
                predicate=check,
            )
        revision = _safe_int(
            self._state.get("oldRevision" if step == "old-revision-rejected" else "newRevision"),
            "observed revision",
        )
        expected_count = 0 if step == "old-revision-rejected" else self._state.get("revisionCount")
        expected_count = _safe_int(expected_count, "observed point count")
        request = _reconciliation_request(
            meeting_id, transcript_id, revision, self.context.generation,
        )
        status, payload = self.ai_observer.request_status(
            "POST",
            "/internal/v1/knowledge-indexing/reconciliation",
            request_id=observation.request_id,
            body=request,
        )
        if status != 200:
            raise ObserverBlocked("AI reconciliation observation was rejected")
        records = payload.get("records")
        record = records[0] if isinstance(records, list) and len(records) == 1 else None
        identity = record.get("sourceIdentity") if isinstance(record, dict) else None
        source_revision = record.get("sourceRevision") if isinstance(record, dict) else None
        if (
            not isinstance(records, list)
            or len(records) != 1
            or payload.get("generationId") != self.context.generation
            or not isinstance(record, dict)
            or not isinstance(identity, dict)
            or identity.get("sourceType") != "TRANSCRIPT"
            or identity.get("sourceId") != transcript_id
            or identity.get("meetingId") != meeting_id
            or not isinstance(source_revision, dict)
            or source_revision.get("number") != revision
            or record.get("pointCount") != expected_count
        ):
            raise ObserverBlocked("AI revision retrieval observation failed")
        return self.writer.write(
            observation,
            {
                "contractVersion": "pi05-observer-source-v1",
                "boundary": "AI",
                "operation": "reconciliation-source-count",
                "generationId": self.context.generation,
                "meetingId": meeting_id,
                "sourceId": transcript_id,
                "sourceType": "TRANSCRIPT",
                "sourceRevision": revision,
                "pointCount": expected_count,
                "httpStatus": status,
            },
        )

    # ---- L03: membership revocation during Assistant generation -----------------

    def _select_revocable_member(self, meeting_id: str) -> str:
        participants, _ = self._core_data(
            "GET",
            f"/api/v1/meetings/{meeting_id}/participants",
            request_id=str(uuid4()),
        )
        if not isinstance(participants, list):
            raise ScenarioUnavailable("Meeting participants response is invalid")
        meeting, _ = self._core_data(
            "GET",
            f"/api/v1/meetings/{meeting_id}",
            request_id=str(uuid4()),
        )
        organizer = _safe_uuid(
            _require_dict(meeting, "meeting").get("organizerUserId"),
            "meeting organizer",
        )
        active_ids: list[str] = []
        for item in participants:
            if not isinstance(item, dict) or "userId" not in item:
                continue
            if item.get("removedAt") is not None:
                continue
            active_ids.append(_safe_uuid(item["userId"], "meeting participant"))
        active_members = [value for value in active_ids if value != organizer]
        fixture_member = self.fixture.get("memberId")
        if fixture_member is not None:
            member = _safe_uuid(fixture_member, "revocable member")
            if member == organizer or member not in active_members:
                raise ScenarioUnavailable("Configured revocable member is not active")
        else:
            if len(active_members) != 1:
                raise ScenarioUnavailable(
                    "L03 needs one unambiguous active revocable member",
                )
            member = active_members[0]

        identity, _ = self._member_data(
            "GET", "/api/v1/auth/me", request_id=str(uuid4()),
        )
        authenticated_member = _safe_uuid(
            _require_dict(identity, "revoked-member identity").get("userId"),
            "revoked-member identity",
        )
        if authenticated_member != member:
            raise ScenarioUnavailable(
                "Revoked-member credentials do not identify the selected participant",
            )
        return member

    def _action_membership_revocation(self, step: str, request_id: str) -> ScenarioHandle:
        meeting_id = self._meeting()
        if step == "authorized-before":
            member = self._select_revocable_member(meeting_id)
            conversation_data, _ = self._member_data(
                "POST",
                "/api/v1/assistant/conversations",
                request_id=request_id,
                body={"meetingId": meeting_id, "title": "PI-05 L03 revocation"},
                idempotency_key=request_id,
            )
            conversation = _require_dict(conversation_data, "Assistant conversation")
            conversation_id = _safe_uuid(conversation.get("id"), "Assistant conversation")
            question = "What current meeting evidence is available?"

            def submit() -> tuple[int, dict[str, object]]:
                client = self._new_member_core_client()
                try:
                    return client.request_status(
                        "POST",
                        f"/api/v1/assistant/conversations/{conversation_id}/messages",
                        request_id=request_id,
                        idempotency_key=request_id,
                        body={"question": question},
                    )[:2]
                finally:
                    client.close()

            self._assistant_future = self._assistant_pool.submit(submit)
            deadline = time.monotonic() + min(self.settings.timeout_seconds, 5)
            while not self._assistant_future.running() and not self._assistant_future.done():
                if time.monotonic() >= deadline:
                    raise ScenarioUnavailable("Assistant generation did not start")
                time.sleep(min(0.05, self.settings.poll_interval_seconds))
            if self._assistant_future.done():
                raise ScenarioUnavailable("Assistant generation completed before revocation")
            self._state.update({
                "meetingId": meeting_id,
                "memberId": member,
                "conversationId": conversation_id,
                "generationStarted": True,
            })
            return self._handle(
                step, request_id, meetingId=meeting_id, memberId=member,
                conversationId=conversation_id,
            )
        if step == "revoked-during-generation":
            meeting_id = _safe_uuid(self._state.get("meetingId"), "meeting")
            member = _safe_uuid(self._state.get("memberId"), "member")
            conversation_id = _safe_uuid(self._state.get("conversationId"), "conversation")
            if self._assistant_future is None:
                raise ScenarioUnavailable("L03 Assistant generation was not started")
            if self._assistant_future.done():
                raise ScenarioUnavailable("Assistant generation completed before revocation")
            meeting, headers = self._core_data(
                "GET", f"/api/v1/meetings/{meeting_id}", request_id=str(uuid4()),
            )
            _require_dict(meeting, "meeting")
            etag = headers.get("ETag")
            status, _payload, _ = self._core_status(
                "DELETE",
                f"/api/v1/meetings/{meeting_id}/participants/{member}",
                request_id=request_id,
                if_match=etag,
            )
            if status < 200 or status >= 300:
                raise ScenarioUnavailable("Core membership revocation was rejected")
            try:
                generation_status, generation_payload = self._assistant_future.result(
                    timeout=max(1.0, self.settings.timeout_seconds),
                )
            except concurrent.futures.TimeoutError as error:
                raise ScenarioUnavailable("Assistant generation did not settle") from error
            except Exception as error:  # noqa: BLE001
                raise ScenarioUnavailable("Assistant generation did not settle") from error
            if generation_status not in {401, 403, 404} or _contains_protected(
                generation_payload,
            ):
                raise ScenarioUnavailable("Assistant did not fail closed after revocation")
            code = _error_code(generation_payload)
            self._state["assistantFailureCode"] = code
            return self._handle(
                step, request_id, meetingId=meeting_id, memberId=member,
                conversationId=conversation_id, revoked=True, assistantStatus=generation_status,
            )
        if step == "assistant-citation-redacted":
            conversation_id = _safe_uuid(self._state.get("conversationId"), "conversation")
            self._state["redactionCheckRequested"] = True
            return self._handle(
                step, request_id, conversationId=conversation_id,
                revoked=True,
            )
        raise ScenarioUnavailable("Unknown L03 step")

    def _new_member_core_client(self) -> CoreClient:
        source = self.settings.revoked_member_core
        return CoreClient(
            source._probe_endpoint,
            ca_file=source.ca_file,
            client_cert=source.client_cert,
            client_key=source.client_key,
            leaf_sha256=source.leaf_sha256,
            email=source.email,
            password=source.password,
            timeout_seconds=15,
            tls_server_name=source._tls_server_name,
            connect_host=source._connect_host,
        )

    def _observe_membership_revocation(self, step: str, observation: Observation) -> str:
        meeting_id = _safe_uuid(self._state.get("meetingId"), "meeting")
        member = _safe_uuid(self._state.get("memberId"), "member")
        conversation_id = _safe_uuid(self._state.get("conversationId"), "conversation")
        if step == "authorized-before":
            participants_payload = self.settings.l01.observer_core.request_json(
                str(uuid4()),
                f"/api/v1/meetings/{meeting_id}/participants",
            )

            def authorized_conversation(payload: object) -> Mapping[str, object]:
                if not isinstance(participants_payload, dict) or (
                    participants_payload.get("success") is not True
                ):
                    raise ObserverBlocked("Participant observation is invalid")
                participants = participants_payload.get("data")
                if not isinstance(participants, list) or not any(
                    isinstance(item, dict)
                    and item.get("userId") == member
                    and "removedAt" in item
                    and item["removedAt"] is None
                    for item in participants
                ):
                    raise ObserverBlocked("Selected member was not active before generation")
                data = _data_dict(payload, "Assistant conversation")
                conversation = data.get("conversation")
                messages = data.get("messages")
                if (
                    not isinstance(conversation, dict)
                    or conversation.get("meetingId") != meeting_id
                    or not isinstance(messages, list)
                ):
                    raise ObserverBlocked("Authorized Assistant conversation was not observed")
                return {
                    "boundary": "CORE",
                    "operation": "assistant-authorized-before-revocation",
                    "meetingId": meeting_id,
                    "conversationId": conversation_id,
                    "messageCount": len(messages),
                    "memberId": member,
                    "memberActive": True,
                }

            return self.settings.l01.observer_core.write_checked(
                observation,
                operation="assistant-authorized-before-revocation",
                path=f"/api/v1/assistant/conversations/{conversation_id}",
                predicate=authorized_conversation,
            )
        if step == "revoked-during-generation":
            def revoked(payload: object) -> Mapping[str, object]:
                participants = _data(payload, "meeting participants")
                if not isinstance(participants, list):
                    raise ObserverBlocked("Participant observation is invalid")
                active = any(
                    isinstance(item, dict)
                    and item.get("userId") == member
                    and "removedAt" in item
                    and item["removedAt"] is None
                    for item in participants
                )
                removed = any(
                    isinstance(item, dict)
                    and item.get("userId") == member
                    and "removedAt" in item
                    and item["removedAt"] is not None
                    for item in participants
                )
                if active or not removed:
                    raise ObserverBlocked("Revoked member remains active")
                return {
                    "boundary": "CORE",
                    "operation": "membership-revocation-read",
                    "meetingId": meeting_id,
                    "memberId": member,
                    "memberActive": False,
                }

            return self.settings.l01.observer_core.write_checked(
                observation,
                operation="membership-revocation-read",
                path=f"/api/v1/meetings/{meeting_id}/participants",
                predicate=revoked,
            )

        def redacted(payload: object) -> Mapping[str, object]:
            data = _data_dict(payload, "Assistant conversation")
            messages = data.get("messages")
            if not isinstance(messages, list):
                raise ObserverBlocked("Assistant messages are invalid")
            candidates = [
                item for item in messages
                if isinstance(item, dict) and item.get("role") == "ASSISTANT"
            ]
            if not candidates:
                raise ObserverBlocked("No Assistant answer was independently observed")
            latest = candidates[-1]
            visibility = latest.get("visibility")
            citations = latest.get("citations")
            if visibility not in {"SOURCE_UNAVAILABLE", "REDACTED"} or citations not in ([], None):
                raise ObserverBlocked("Assistant citations were not redacted")
            return {
                "boundary": "CORE",
                "operation": "assistant-citation-redaction-read",
                "meetingId": meeting_id,
                "conversationId": conversation_id,
                "visibility": visibility,
                "citationCount": 0,
            }

        return self.settings.l01.observer_core.write_checked(
            observation,
            operation="assistant-citation-redaction-read",
            path=f"/api/v1/assistant/conversations/{conversation_id}",
            predicate=redacted,
        )

    # ---- L04/L05: real worker restart and broker redelivery ---------------------

    def _action_broker_redelivery(self, step: str, request_id: str) -> ScenarioHandle:
        job_id, event_id = self._job_and_event()
        stage = self.fixture.get("workerStage", "transcription")
        if not isinstance(stage, str):
            raise ScenarioUnavailable("Worker stage is invalid")
        if step == "broker-redelivered":
            delivery = self._worker_delivery(
                self.worker_action,
                job_id,
                stage,
                event_id,
                request_id,
            )
            if delivery.get("state") in {"RESULT_ACCEPTED", "FAILURE_RECORDED", "SUPERSEDED"}:
                raise ScenarioUnavailable("Broker fixture is already terminal")
            before = self.settings.l01.rabbit_observer.probe_queue()
            self._stop_worker()
            deadline = time.monotonic() + min(self.settings.timeout_seconds, 60)
            count = before
            while time.monotonic() < deadline:
                count = self.settings.l01.rabbit_observer.probe_queue()
                if count > before:
                    break
                time.sleep(self.settings.poll_interval_seconds)
            if count <= before:
                raise ScenarioUnavailable("RabbitMQ did not expose a requeued delivery")
            self._state.update({
                "jobId": job_id,
                "eventId": event_id,
                "meetingId": self._meeting(),
                "workerStage": stage,
                "initialDeliveryState": delivery.get("state"),
                "queueDepthBefore": before,
                "queueDepthAfter": count,
            })
            return self._handle(
                step, request_id, jobId=job_id, eventId=event_id,
                requeuedCount=count - before,
            )
        if step == "worker-idempotent":
            self._restart_worker()
            job = self._poll_core(
                f"/api/v1/processing-jobs/{job_id}",
                request_id,
                lambda item: item.get("status") in _TERMINAL_JOB_STATUSES,
            )
            if job.get("status") not in {"COMPLETED", "COMPLETED_WITH_WARNINGS"}:
                raise ScenarioUnavailable("Restarted worker did not complete the job")
            delivery = self._worker_delivery(
                self.worker_action,
                job_id,
                str(self._state.get("workerStage")),
                event_id,
                request_id,
            )
            if delivery.get("state") == "SUPERSEDED":
                raise ScenarioUnavailable("Redelivered worker delivery was superseded")
            self._state["jobStatus"] = job["status"]
            return self._handle(step, request_id, jobId=job_id, recovered=True)
        if step == "core-single-result":
            transcript, _ = self._transcript(self._meeting())
            if transcript.get("processingJobId") != job_id:
                raise ScenarioUnavailable("Core transcript is outside the redelivered job")
            self._state["transcriptId"] = _safe_uuid(transcript.get("id"), "transcript")
            return self._handle(
                step, request_id, jobId=job_id, transcriptId=self._state["transcriptId"],
                singleCanonicalResult=True,
            )
        raise ScenarioUnavailable("Unknown L04 step")

    def _stop_worker(self) -> None:
        stop = getattr(self.settings.runtime, "stop", None)
        if not callable(stop):
            raise ScenarioUnavailable("Run-owned worker stop control is unavailable")
        try:
            stop(_TRANSCRIPTION_WORKER_PROCESS)
        except Exception as error:
            raise ScenarioUnavailable("Run-owned worker stop failed") from error
        self._state["workerStopped"] = True
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.settings.runtime.status(_TRANSCRIPTION_WORKER_PROCESS).get("running") is not True:
                return
            time.sleep(0.05)
        raise ScenarioUnavailable("Worker did not stop before the bound")

    def _observe_broker_redelivery(self, step: str, observation: Observation) -> str:
        job_id = _safe_uuid(self._state.get("jobId"), "job")
        event_id = _safe_uuid(self._state.get("eventId"), "event")
        if step == "broker-redelivered":
            before = _safe_int(self._state.get("queueDepthBefore"), "queue depth before")
            count = self.settings.l01.rabbit_observer.observe_queue_sync(
                observation, minimum_message_count=before + 1,
            )
            return count
        if step == "worker-idempotent":
            data = self._worker_delivery(
                self.worker_observer,
                job_id,
                str(self._state.get("workerStage")),
                event_id,
                observation.request_id,
                observer=True,
            )
            if data.get("state") not in {
                "RUNNING",
                "AWAITING_RECONCILIATION",
                "AVAILABLE",
                "RESULT_ACCEPTED",
            }:
                raise ObserverBlocked("Worker did not expose an idempotent delivery state")
            return self.writer.write(
                observation,
                {
                    "contractVersion": "pi05-observer-source-v1",
                    "boundary": "AI",
                    "operation": "worker-delivery-after-redelivery",
                    "jobId": job_id,
                    "eventId": event_id,
                    "state": data["state"],
                    "httpStatus": 200,
                },
            )
        meeting_id = _safe_uuid(self._state.get("meetingId", self._meeting()), "meeting")

        def single(payload: object) -> Mapping[str, object]:
            data = _data_dict(payload, "transcript")
            if (
                data.get("meetingId") != meeting_id
                or data.get("processingJobId") != job_id
                or data.get("status") not in _READY_TRANSCRIPT_STATUSES
            ):
                raise ObserverBlocked("Core canonical transcript result is invalid")
            return {
                "boundary": "CORE",
                "operation": "single-canonical-transcript-read",
                "meetingId": meeting_id,
                "jobId": job_id,
                "transcriptId": _safe_uuid(data.get("id"), "transcript"),
                "status": data["status"],
            }

        return self.settings.l01.observer_core.write_checked(
            observation,
            operation="single-canonical-transcript-read",
            path=f"/api/v1/meetings/{meeting_id}/transcript",
            predicate=single,
        )

    def _action_worker_restart(self, step: str, request_id: str) -> ScenarioHandle:
        job_id, event_id = self._job_and_event()
        stage = self.fixture.get("workerStage", "transcription")
        if not isinstance(stage, str) or stage not in {"transcription", "intelligence"}:
            raise ScenarioUnavailable("Worker restart stage is invalid")
        if step == "original-lease-expired":
            claim = self.fixture.get("claimCommand")
            if not isinstance(claim, dict):
                raise ScenarioUnavailable("L05 requires an explicit original claim command")
            claim = dict(claim)
            claim.setdefault("eventId", event_id)
            claim.setdefault("contractVersion", "1.0")
            status, payload = self.worker_action.request_status(
                "POST",
                self._worker_path(job_id, stage, "claim"),
                request_id=request_id,
                body=claim,
            )
            if status != 200:
                raise ScenarioUnavailable("Original worker lease could not be established")
            data = _data_dict(payload, "worker claim")
            if (
                data.get("processingJobId") != job_id
                or data.get("eventId") != event_id
            ):
                raise ScenarioUnavailable("Worker claim identity does not match the fixture")
            expires = data.get("leaseExpiresAt")
            if not isinstance(expires, str):
                raise ScenarioUnavailable("Worker did not return a lease expiry")
            claim_token = _safe_uuid(data.get("claimToken"), "worker claim token")
            stage_run_id = _safe_uuid(
                data.get("executionStageRunId"), "worker stage run",
            )
            generation = _safe_int(claim.get("generation"), "worker generation")
            claim["claimToken"] = claim_token
            claim["executionStageRunId"] = stage_run_id
            self._state.update({
                "jobId": job_id, "eventId": event_id, "workerStage": stage,
                "claim": claim, "claimToken": claim_token,
                "executionStageRunId": stage_run_id, "generation": generation,
                "leaseExpiresAt": expires,
            })
            self._stop_worker()
            self._wait_until_expired(expires)
            return self._handle(step, request_id, jobId=job_id, eventId=event_id, expired=True)
        if step == "old-owner-fenced":
            claim = self._state.get("claim")
            if not isinstance(claim, dict):
                raise ScenarioUnavailable("Original worker claim is unavailable")
            owner = self._owner_command(claim)
            status, payload = self.worker_action.request_status(
                "POST",
                self._worker_path(job_id, str(self._state["workerStage"]), "renew"),
                request_id=request_id,
                body=owner,
            )
            if status != 409 or _error_code(payload) not in {"WORKER_LEASE_LOST", "WORKER_ATTEMPT_BUSY"}:
                raise ScenarioUnavailable("Expired worker owner was not fenced")
            self._state["fencedStatus"] = status
            return self._handle(step, request_id, jobId=job_id, fenced=True, status=status)
        if step == "restarted-worker-recovered":
            self._restart_worker()
            job = self._poll_core(
                f"/api/v1/processing-jobs/{job_id}",
                request_id,
                lambda item: item.get("status") in _TERMINAL_JOB_STATUSES,
            )
            if job.get("status") not in {"COMPLETED", "COMPLETED_WITH_WARNINGS"}:
                raise ScenarioUnavailable("Restarted worker did not recover the job")
            delivery = self._worker_delivery(
                self.worker_action,
                job_id,
                str(self._state.get("workerStage")),
                event_id,
                request_id,
            )
            if delivery.get("state") == "SUPERSEDED":
                raise ScenarioUnavailable("Recovered worker delivery was superseded")
            return self._handle(step, request_id, jobId=job_id, recovered=True)
        raise ScenarioUnavailable("Unknown L05 step")

    def _owner_command(self, claim: Mapping[str, object]) -> dict[str, object]:
        return {
            "contractVersion": claim.get("contractVersion"),
            "eventId": _safe_uuid(claim.get("eventId"), "worker event"),
            "generation": _safe_int(claim.get("generation"), "worker generation"),
            "executionStageRunId": _safe_uuid(
                claim.get("executionStageRunId"), "worker stage run",
            ),
            "claimToken": _safe_uuid(claim.get("claimToken"), "worker claim token"),
        }

    def _wait_until_expired(self, value: str) -> None:
        try:
            expires = datetime.fromisoformat(value)
        except ValueError as error:
            raise ScenarioUnavailable("Worker lease expiry is invalid") from error
        if expires.tzinfo is None:
            raise ScenarioUnavailable("Worker lease expiry is not timezone aware")
        wait = (expires - datetime.now(UTC)).total_seconds()
        if wait > self.settings.timeout_seconds:
            raise ScenarioUnavailable("Worker lease exceeds the scenario bound")
        if wait > 0:
            time.sleep(wait + max(0.1, self.settings.poll_interval_seconds))

    def _observe_worker_restart(self, step: str, observation: Observation) -> str:
        job_id = _safe_uuid(self._state.get("jobId"), "job")
        event_id = _safe_uuid(self._state.get("eventId"), "event")
        stage = str(self._state.get("workerStage"))
        if step == "original-lease-expired":
            data = self._worker_delivery(
                self.worker_observer,
                job_id,
                stage,
                event_id,
                observation.request_id,
                observer=True,
            )
            if data.get("state") not in {"AVAILABLE", "AWAITING_RECONCILIATION"}:
                raise ObserverBlocked("Worker lease is still live")
            return self.writer.write(
                observation,
                {
                    "contractVersion": "pi05-observer-source-v1",
                    "boundary": "CORE",
                    "operation": "expired-worker-lease-read",
                    "jobId": job_id,
                    "eventId": event_id,
                    "state": data.get("state"),
                    "httpStatus": 200,
                },
            )
        if step == "old-owner-fenced":
            claim = self._state.get("claim")
            if not isinstance(claim, dict):
                raise ObserverBlocked("Original worker claim is unavailable")
            owner = self._owner_command(claim)
            status, payload = self.worker_observer.request_status(
                "POST",
                self._worker_path(job_id, stage, "renew"),
                request_id=observation.request_id,
                body=owner,
            )
            if status != 409 or _error_code(payload) not in {
                "WORKER_LEASE_LOST",
                "WORKER_ATTEMPT_BUSY",
            }:
                raise ObserverBlocked("Expired worker owner was not independently fenced")
            return self.writer.write(
                observation,
                {
                    "contractVersion": "pi05-observer-source-v1",
                    "boundary": "CORE",
                    "operation": "expired-owner-fencing-probe",
                    "jobId": job_id,
                    "eventId": event_id,
                    "status": 409,
                    "errorCode": _error_code(payload),
                },
            )
        ai = self.settings.l01.ai_observer.request_json(
            observation.request_id, "GET", "/health/ready",
        )
        if not isinstance(ai, dict) or ai.get("status") != "ready":
            raise ObserverBlocked("AI worker recovery readiness was not observed")
        data = self._worker_delivery(
            self.worker_observer,
            job_id,
            stage,
            event_id,
            observation.request_id,
            observer=True,
        )
        if data.get("state") not in {
            "RUNNING",
            "AWAITING_RECONCILIATION",
            "AVAILABLE",
            "RESULT_ACCEPTED",
        }:
            raise ObserverBlocked("Recovered worker state is invalid")
        return self.writer.write(
            observation,
            {
                "contractVersion": "pi05-observer-source-v1",
                "boundary": "AI",
                "operation": "worker-recovery-and-readiness",
                "jobId": job_id,
                "eventId": event_id,
                "workerState": data["state"],
                "aiStatus": "ready",
            },
        )

    # ---- L06: Qdrant outage, failed reconciliation, resumed repair --------------

    def _action_qdrant_outage(self, step: str, request_id: str) -> ScenarioHandle:
        meeting_id = self._meeting()
        source_id = self._fixture_uuid("sourceId")
        if step == "qdrant-outage-observed":
            self._state.update({"meetingId": meeting_id, "sourceId": source_id})
            fault = self._fault("qdrant")
            fault.stop("qdrant")
            self._state["qdrantStopped"] = True
            container = self._wait_for_container_state("qdrant", "exited")
            return self._handle(
                step,
                request_id,
                qdrantStopped=True,
                containerState=str(container["status"]),
            )
        if step == "core-failed-closed":
            status, payload, _ = self._core_status(
                "POST",
                "/api/v1/admin/knowledge/reconciliation",
                request_id=request_id,
                body={
                    "generationId": self.context.generation,
                    "batchSize": 1,
                    "dryRun": False,
                    "certificationMode": "OPERATIONAL",
                },
                idempotency_key=request_id,
            )
            if status < 200 or status >= 300:
                raise ScenarioUnavailable("Core reconciliation admission was rejected")
            data = _data_dict(payload, "failed reconciliation")
            run_id = _safe_uuid(data.get("id") or data.get("runId"), "reconciliation run")
            if (
                data.get("generationId") != self.context.generation
                or data.get("state") != "FAILED"
                or data.get("lastErrorCode") not in {
                    "VECTOR_AUDIT_UNAVAILABLE",
                    "VECTOR_AUDIT_INVALID",
                }
            ):
                raise ScenarioUnavailable("Core did not fail closed during Qdrant outage")
            self._state.update({
                "reconciliationRunId": run_id,
                "coreOutageStatus": status,
                "coreOutageCode": data["lastErrorCode"],
            })
            return self._handle(
                step,
                request_id,
                failedClosed=True,
                reconciliationRunId=run_id,
            )
        if step == "reconciliation-resumed":
            fault = self._fault("qdrant")
            fault.start("qdrant")
            self._state["qdrantStopped"] = False
            self._wait_for_container_state("qdrant", "running")
            run_id = _safe_uuid(self._state.get("reconciliationRunId"), "reconciliation run")
            status, payload, _ = self._core_status(
                "POST",
                f"/api/v1/admin/knowledge/reconciliation/{run_id}/resume",
                request_id=request_id,
            )
            if status < 200 or status >= 300:
                raise ScenarioUnavailable("Core reconciliation resume was rejected")
            data = _data_dict(payload, "reconciliation resume")
            data = self._poll_reconciliation_until_terminal(run_id, data, request_id)
            if data.get("state") != "COMPLETED":
                raise ScenarioUnavailable("Core reconciliation did not complete after recovery")
            self._state["reconciliationState"] = data["state"]
            return self._handle(
                step,
                request_id,
                resumed=True,
                reconciliationRunId=run_id,
            )
        raise ScenarioUnavailable("Unknown L06 step")

    def _observe_qdrant_outage(self, step: str, observation: Observation) -> str:
        if step == "qdrant-outage-observed":
            state = self._container_state("qdrant")
            if state.get("status") == "running":
                raise ObserverBlocked("Qdrant endpoint unexpectedly remained available")
            return self.writer.write(
                observation,
                {
                    "contractVersion": "pi05-observer-source-v1",
                    "boundary": "QDRANT",
                    "operation": "qdrant-outage-read",
                    "availability": "UNAVAILABLE",
                    "containerState": state["status"],
                    "containerId": state["id"],
                },
            )
        if step == "core-failed-closed":
            run_id = _safe_uuid(self._state.get("reconciliationRunId"), "reconciliation run")
            payload = self.settings.l01.observer_core.request_json(
                observation.request_id,
                f"/api/v1/admin/knowledge/reconciliation/{run_id}",
            )
            data = _data_dict(payload, "failed reconciliation")
            if (
                data.get("generationId") != self.context.generation
                or data.get("state") != "FAILED"
                or data.get("lastErrorCode") not in {
                    "VECTOR_AUDIT_UNAVAILABLE",
                    "VECTOR_AUDIT_INVALID",
                }
            ):
                raise ObserverBlocked("Core outage rejection was not observed")
            return self.writer.write(
                observation,
                {
                    "contractVersion": "pi05-observer-source-v1",
                    "boundary": "CORE",
                    "operation": "reconciliation-failed-closed",
                    "status": 200,
                    "reconciliationRunId": run_id,
                    "errorCode": data["lastErrorCode"],
                },
            )
        run_id = _safe_uuid(self._state.get("reconciliationRunId"), "reconciliation run")
        payload = self.settings.l01.observer_core.request_json(
            observation.request_id,
            f"/api/v1/admin/knowledge/reconciliation/{run_id}",
        )
        data = _data_dict(payload, "reconciliation")
        if (
            data.get("generationId") != self.context.generation
            or data.get("state") != "COMPLETED"
            or data.get("inventoryComplete") is not True
        ):
            raise ObserverBlocked("Resumed reconciliation state is invalid")
        return self.writer.write(
            observation,
            {
                "contractVersion": "pi05-observer-source-v1",
                "boundary": "CORE",
                "operation": "reconciliation-resumed-read",
                "reconciliationRunId": run_id,
                "state": data["state"],
                "generationId": self.context.generation,
                "httpStatus": 200,
            },
        )

    # ---- L07: source/vector inventory coverage -----------------------------------

    def _start_reconciliation(
        self,
        request_id: str,
        *,
        dry_run: bool = True,
    ) -> tuple[str, dict[str, object]]:
        batch_size = _safe_int(
            self.fixture.get("reconciliationBatchSize", 100),
            "reconciliation batch size",
            minimum=1,
        )
        if batch_size > 500:
            raise ScenarioUnavailable("reconciliation batch size is invalid")
        status, payload, _ = self._core_status(
            "POST",
            "/api/v1/admin/knowledge/reconciliation",
            request_id=request_id,
            body={
                "generationId": self.context.generation,
                "batchSize": batch_size,
                "dryRun": dry_run,
                "certificationMode": "OPERATIONAL",
            },
            idempotency_key=request_id,
        )
        if status < 200 or status >= 300:
            raise ScenarioUnavailable("Core reconciliation admission was rejected")
        data = _data_dict(payload, "reconciliation admission")
        run_id = data.get("runId") or data.get("id")
        return _safe_uuid(run_id, "reconciliation run"), data

    def _reconciliation(self, run_id: str, request_id: str) -> dict[str, object]:
        status, payload, _ = self._core_status(
            "GET", f"/api/v1/admin/knowledge/reconciliation/{run_id}",
            request_id=request_id,
        )
        if status != 200:
            raise ScenarioUnavailable("Core reconciliation status was rejected")
        return _data_dict(payload, "reconciliation")

    def _resume_reconciliation(self, run_id: str, request_id: str) -> dict[str, object]:
        status, payload, _ = self._core_status(
            "POST",
            f"/api/v1/admin/knowledge/reconciliation/{run_id}/resume",
            request_id=request_id,
        )
        if status < 200 or status >= 300:
            raise ScenarioUnavailable("Core reconciliation resume was rejected")
        return _data_dict(payload, "reconciliation resume")

    def _action_inventory_coverage(self, step: str, request_id: str) -> ScenarioHandle:
        if step == "missing-work-reported":
            run_id, result = self._start_reconciliation(request_id)
            self._state["reconciliationRunId"] = run_id
            if (
                result.get("generationId") != self.context.generation
                or result.get("state") == "FAILED"
                or _safe_int(
                    result.get("findingCount"), "reconciliation finding count",
                ) < 1
            ):
                raise ScenarioUnavailable("Inventory did not report missing work")
            self._state["missingFindingCount"] = result["findingCount"]
            return self._handle(step, request_id, reconciliationRunId=run_id, missingWork=True)
        if step == "orphan-point-reported":
            run_id = _safe_uuid(self._state.get("reconciliationRunId"), "reconciliation run")
            result = self._reconciliation(run_id, request_id)
            if result.get("state") == "RUNNING":
                result = self._poll_reconciliation_until_terminal(run_id, result, request_id)
            vector_count = _safe_int(
                result.get("vectorScannedCount"), "vector inventory count",
            )
            finding_count = _safe_int(
                result.get("findingCount"), "reconciliation finding count",
            )
            if (
                result.get("generationId") != self.context.generation
                or result.get("state") == "FAILED"
                or vector_count < 1
                or finding_count < 1
            ):
                raise ScenarioUnavailable("Inventory did not report orphan points")
            self._state.update({
                "orphanReported": True,
                "orphanFindingCount": finding_count,
                "vectorScannedCount": vector_count,
            })
            return self._handle(step, request_id, reconciliationRunId=run_id, orphanedPoints=True)
        if step == "unsafe-auto-delete-prevented":
            run_id = _safe_uuid(self._state.get("reconciliationRunId"), "reconciliation run")
            result = self._reconciliation(run_id, request_id)
            finding_count = _safe_int(
                result.get("findingCount"), "reconciliation finding count",
            )
            repaired_count = _safe_int(
                result.get("repairedCount"), "reconciliation repaired count",
            )
            if (
                result.get("generationId") != self.context.generation
                or result.get("state") != "COMPLETED"
                or result.get("inventoryComplete") is not True
                or finding_count < 1
                or repaired_count != 0
            ):
                raise ScenarioUnavailable("Unsafe inventory finding was not held for manual review")
            return self._handle(
                step,
                request_id,
                reconciliationRunId=run_id,
                manualReview=True,
            )
        raise ScenarioUnavailable("Unknown L07 step")

    def _poll_reconciliation_until_terminal(
        self,
        run_id: str,
        result: dict[str, object],
        request_id: str,
    ) -> dict[str, object]:
        deadline = time.monotonic() + self.settings.timeout_seconds
        current = result
        while time.monotonic() < deadline:
            if current.get("state") in {"COMPLETED", "FAILED"}:
                return current
            if current.get("state") != "RUNNING":
                raise ScenarioUnavailable("Reconciliation state is invalid")
            current = self._resume_reconciliation(run_id, str(uuid4()))
            if current.get("state") in {"COMPLETED", "FAILED"}:
                return current
            time.sleep(self.settings.poll_interval_seconds)
        raise ScenarioUnavailable("Inventory reconciliation timed out")

    def _observe_inventory_coverage(self, step: str, observation: Observation) -> str:
        run_id = _safe_uuid(self._state.get("reconciliationRunId"), "reconciliation run")

        def check(payload: object) -> Mapping[str, object]:
            data = _data_dict(payload, "reconciliation")
            finding_count = _observed_count(data, "findingCount")
            vector_count = _observed_count(data, "vectorScannedCount")
            repaired_count = _observed_count(data, "repairedCount")
            if data.get("generationId") != self.context.generation:
                raise ObserverBlocked("Reconciliation generation is outside the run")
            if step == "missing-work-reported" and finding_count < 1:
                raise ObserverBlocked("Missing work was not independently observed")
            if step == "orphan-point-reported" and (vector_count < 1 or finding_count < 1):
                raise ObserverBlocked("Orphan points were not independently observed")
            if step == "unsafe-auto-delete-prevented" and (
                data.get("generationId") != self.context.generation
                or data.get("state") != "COMPLETED"
                or data.get("inventoryComplete") is not True
                or finding_count < 1
                or repaired_count != 0
            ):
                raise ObserverBlocked("Unsafe deletion was not held for manual review")
            return {
                "boundary": "CORE",
                "operation": "reconciliation-inventory-read",
                "reconciliationRunId": run_id,
                "generationId": self.context.generation,
                "state": data.get("state"),
                "findingCount": finding_count,
                "vectorScannedCount": vector_count,
                "repairedCount": repaired_count,
                "inventoryComplete": data.get("inventoryComplete"),
                "manualReviewProtected": step == "unsafe-auto-delete-prevented",
            }

        return self.settings.l01.observer_core.write_checked(
            observation,
            operation="reconciliation-inventory-read",
            path=f"/api/v1/admin/knowledge/reconciliation/{run_id}",
            predicate=check,
        )

    # ---- L08: generation candidate, activation and rollback ---------------------

    def _action_generation_rollback(self, step: str, request_id: str) -> ScenarioHandle:
        if step == "incomplete-candidate-rejected":
            incomplete = self._fixture_generation("incompleteCandidateGenerationId")
            status, payload, _ = self._core_status(
                "POST",
                f"/api/v1/admin/knowledge/generations/{incomplete}/activate",
                request_id=request_id,
            )
            if status != 409:
                raise ScenarioUnavailable("Incomplete generation candidate was accepted")
            self._state.update({
                "incompleteGenerationId": incomplete,
                "incompleteStatus": status,
            })
            return self._handle(
                step,
                request_id,
                generationId=incomplete,
                rejected=True,
                status=status,
            )
        if step == "clean-candidate-activated":
            clean = self._fixture_generation("cleanCandidateGenerationId")
            incomplete = _safe_generation(
                self.fixture.get("incompleteCandidateGenerationId"),
                self.context.run_id,
                "incomplete candidate generation",
            )
            if clean == incomplete:
                raise ScenarioUnavailable("L08 candidate generations must be distinct")
            status, payload, _ = self._core_status(
                "POST",
                f"/api/v1/admin/knowledge/generations/{clean}/activate",
                request_id=request_id,
            )
            if status < 200 or status >= 300:
                raise ScenarioUnavailable("Clean generation candidate was not activated")
            data = _data_dict(payload, "generation activation")
            if data.get("generationId") != clean or data.get("state") != "ACTIVE":
                raise ScenarioUnavailable("Activated generation did not report ACTIVE")
            self._state.update({
                "cleanGenerationId": clean,
                "candidateActive": True,
            })
            return self._handle(step, request_id, generationId=clean, active=True)
        if step == "old-generation-rollback":
            old = self._fixture_generation("oldGenerationId")
            clean = _safe_generation(
                self._state.get("cleanGenerationId"),
                self.context.run_id,
                "clean candidate generation",
            )
            if old == clean:
                raise ScenarioUnavailable("L08 rollback generation is not distinct")
            status, payload, _ = self._core_status(
                "POST",
                f"/api/v1/admin/knowledge/generations/{old}/activate",
                request_id=request_id,
            )
            if status < 200 or status >= 300:
                raise ScenarioUnavailable("Old generation rollback was rejected")
            data = _data_dict(payload, "generation rollback")
            if data.get("generationId") != old or data.get("state") != "ACTIVE":
                raise ScenarioUnavailable("Rolled-back generation did not report ACTIVE")
            self._state["rollbackActive"] = True
            return self._handle(step, request_id, generationId=old, active=True)
        raise ScenarioUnavailable("Unknown L08 step")

    def _observe_generation_rollback(self, step: str, observation: Observation) -> str:
        generation_key = {
            "incomplete-candidate-rejected": "incompleteGenerationId",
            "clean-candidate-activated": "cleanGenerationId",
            "old-generation-rollback": "oldGenerationId",
        }[step]
        generation = _safe_generation(
            self._state.get(generation_key) or self.fixture.get(generation_key),
            self.context.run_id,
            f"{step} generation",
        )

        def check(payload: object) -> Mapping[str, object]:
            data = _data_dict(payload, "generation")
            if step == "incomplete-candidate-rejected":
                if (
                    data.get("generationId") != generation
                    or data.get("state") == "ACTIVE"
                    or data.get("certificationUsable") is not False
                ):
                    raise ObserverBlocked("Incomplete generation is active")
                result = "REJECTED"
            else:
                if data.get("generationId") != generation or data.get("state") != "ACTIVE":
                    raise ObserverBlocked("Generation activation was not observed")
                result = "ACTIVE"
            return {
                "boundary": "CORE",
                "operation": "generation-state-read",
                "generationId": generation,
                "state": data.get("state"),
                "observedState": result,
            }

        return self.settings.l01.observer_core.write_checked(
            observation,
            operation="generation-state-read",
            path=f"/api/v1/admin/knowledge/generations/{generation}",
            predicate=check,
        )

    # ---- L09: stale export and revoked download capability ----------------------

    def _action_export_revocation(self, step: str, request_id: str) -> ScenarioHandle:
        meeting_id = self._meeting()
        if step == "historical-export-stale":
            status, payload, _ = self._core_status(
                "POST",
                f"/api/v1/meetings/{meeting_id}/exports",
                request_id=request_id,
                idempotency_key=request_id,
                body={"format": "MARKDOWN"},
            )
            if status < 200 or status >= 300:
                raise ScenarioUnavailable("Historical export admission was rejected")
            accepted = _data_dict(payload, "export admission")
            export_id = _safe_uuid(accepted.get("exportId"), "export")
            self._state.update({"meetingId": meeting_id, "exportId": export_id})
            self._poll_export(export_id, request_id)
            transcript, headers = self._transcript(meeting_id)
            segment_id = self._segment_id(transcript)
            revision = _safe_int(transcript.get("contentRevision"), "transcript revision")
            etag = headers.get("ETag") or f'"t-{_safe_uuid(transcript.get("id"), "transcript")}-{revision}"'
            self._core_data(
                "PATCH",
                f"/api/v1/meetings/{meeting_id}/transcript/segments/{segment_id}",
                request_id=request_id,
                if_match=etag,
                body={
                    "text": f"PI-05 L09 export revision {contextual_run_suffix(self.context.run_id)}",
                    "reason": "PI-05 export freshness",
                },
            )
            return self._handle(step, request_id, meetingId=meeting_id, exportId=export_id, stale=True)
        if step == "revoke-download-access":
            member = self._select_revocable_member(meeting_id)
            export_id = _safe_uuid(self._state.get("exportId"), "export")
            before_status, before_payload, _ = self._member_status(
                "POST",
                f"/api/v1/exports/{export_id}/access-url",
                request_id=str(uuid4()),
            )
            if (
                before_status < 200
                or before_status >= 300
                or _contains_protected(before_payload)
            ):
                raise ScenarioUnavailable(
                    "Revocable member could not obtain the export capability before removal",
                )
            meeting, headers = self._core_data(
                "GET", f"/api/v1/meetings/{meeting_id}", request_id=request_id,
            )
            _require_dict(meeting, "meeting")
            status, payload, _ = self._core_status(
                "DELETE",
                f"/api/v1/meetings/{meeting_id}/participants/{member}",
                request_id=request_id,
                if_match=headers.get("ETag"),
            )
            if status < 200 or status >= 300:
                raise ScenarioUnavailable("Export access member revocation was rejected")
            access_status, access_payload, _ = self._member_status(
                "POST",
                f"/api/v1/exports/{export_id}/access-url",
                request_id=request_id,
            )
            if access_status not in {401, 403, 404} or _contains_protected(access_payload):
                raise ScenarioUnavailable("Revoked client received an export capability")
            self._state.update({"accessStatus": access_status, "memberId": member})
            return self._handle(
                step,
                request_id,
                exportId=export_id,
                memberId=member,
                denied=True,
                status=access_status,
            )
        if step == "historical-record-preserved":
            export_id = _safe_uuid(self._state.get("exportId"), "export")
            status, payload, _ = self._core_status(
                "GET", f"/api/v1/exports/{export_id}", request_id=request_id,
            )
            if status != 200:
                raise ScenarioUnavailable("Historical export record was not preserved")
            data = _data_dict(payload, "export status")
            if (
                data.get("exportId") != export_id
                or data.get("meetingId") != meeting_id
                or data.get("freshness") not in {"STALE", "HISTORICAL_STALE"}
            ):
                raise ScenarioUnavailable("Historical export freshness was not stale")
            return self._handle(step, request_id, exportId=export_id, preserved=True)
        raise ScenarioUnavailable("Unknown L09 step")

    def _poll_export(self, export_id: str, request_id: str) -> dict[str, object]:
        deadline = time.monotonic() + self.settings.timeout_seconds
        while time.monotonic() < deadline:
            status, payload, _ = self._core_status(
                "GET", f"/api/v1/exports/{export_id}", request_id=request_id,
            )
            if status != 200:
                raise ScenarioUnavailable("Export status was rejected")
            data = _data_dict(payload, "export status")
            if data.get("status") in {"READY", "FAILED"}:
                if data.get("status") != "READY":
                    raise ScenarioUnavailable("Export did not become READY")
                return data
            time.sleep(self.settings.poll_interval_seconds)
        raise ScenarioUnavailable("Export generation timed out")

    def _observe_export_revocation(self, step: str, observation: Observation) -> str:
        meeting_id = _safe_uuid(self._state.get("meetingId", self._meeting()), "meeting")
        export_id = _safe_uuid(self._state.get("exportId"), "export")
        if step == "historical-export-stale":
            def stale(payload: object) -> Mapping[str, object]:
                data = _data_dict(payload, "export status")
                if (
                    data.get("exportId") != export_id
                    or data.get("meetingId") != meeting_id
                    or data.get("status") != "READY"
                    or data.get("freshness") not in {"STALE", "HISTORICAL_STALE"}
                ):
                    raise ObserverBlocked("Stale historical export was not observed")
                return {
                    "boundary": "CORE",
                    "operation": "historical-export-status-read",
                    "meetingId": meeting_id,
                    "exportId": export_id,
                    "freshness": data["freshness"],
                    "status": data.get("status"),
                }

            return self.settings.l01.observer_core.write_checked(
                observation,
                operation="historical-export-status-read",
                path=f"/api/v1/exports/{export_id}",
                predicate=stale,
            )
        if step == "revoke-download-access":
            member = _safe_uuid(self._state.get("memberId"), "revoked member")
            status, payload, _ = self._member_status(
                "POST",
                f"/api/v1/exports/{export_id}/access-url",
                request_id=observation.request_id,
            )
            if status not in {401, 403, 404} or _contains_protected(payload):
                raise ObserverBlocked("Revoked export access was not independently denied")
            return self.writer.write(
                observation,
                {
                    "contractVersion": "pi05-observer-source-v1",
                    "boundary": "CORE",
                    "operation": "revoked-export-access-probe",
                    "exportId": export_id,
                    "memberId": member,
                    "status": status,
                    "denied": True,
                },
            )
        def preserved(payload: object) -> Mapping[str, object]:
            data = _data_dict(payload, "export status")
            if (
                data.get("exportId") != export_id
                or data.get("meetingId") != meeting_id
                or data.get("freshness") not in {"STALE", "HISTORICAL_STALE"}
            ):
                raise ObserverBlocked("Historical export was not preserved as stale")
            return {
                "boundary": "CORE",
                "operation": "historical-export-preserved-read",
                "exportId": export_id,
                "freshness": data["freshness"],
                "status": data.get("status"),
            }

        return self.settings.l01.observer_core.write_checked(
            observation,
            operation="historical-export-preserved-read",
            path=f"/api/v1/exports/{export_id}",
            predicate=preserved,
        )

    # ---- L10: room conflict, cancellation release and notification recovery -----

    def _action_room_notification(self, step: str, request_id: str) -> ScenarioHandle:
        room_id = self._fixture_uuid("roomId")
        if step == "overlap-rejected":
            from datetime import timedelta

            start = datetime.now(UTC).replace(microsecond=0) + timedelta(minutes=20)
            end = start + timedelta(minutes=30)
            bodies = [
                {
                    "title": f"PI-05 L10 A {contextual_run_suffix(self.context.run_id)}",
                    "scheduledStartAt": start.isoformat(),
                    "scheduledEndAt": end.isoformat(),
                    "roomId": room_id,
                },
                {
                    "title": f"PI-05 L10 B {contextual_run_suffix(self.context.run_id)}",
                    "scheduledStartAt": start.isoformat(),
                    "scheduledEndAt": end.isoformat(),
                    "roomId": room_id,
                },
            ]
            created: list[tuple[str, Mapping[str, str]]] = []

            def create_draft(body: dict[str, object]) -> tuple[str, Mapping[str, str]]:
                status, payload, headers = self._core_status(
                    "POST",
                    "/api/v1/meetings",
                    request_id=str(uuid4()),
                    body=body,
                    idempotency_key=str(uuid4()),
                )
                if status < 200 or status >= 300:
                    raise ScenarioUnavailable("Room conflict meeting admission was rejected")
                data = _data_dict(payload, "meeting admission")
                return _safe_uuid(data.get("id"), "meeting"), headers

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(create_draft, body) for body in bodies]
                for future in futures:
                    created.append(future.result())

            def schedule(
                index: int,
            ) -> tuple[int, dict[str, object], Mapping[str, str]]:
                meeting_id, headers = created[index]
                return self._core_status(
                    "POST",
                    f"/api/v1/meetings/{meeting_id}/schedule",
                    request_id=str(uuid4()),
                    if_match=headers.get("ETag"),
                    body={
                        "scheduledStartAt": bodies[index]["scheduledStartAt"],
                        "scheduledEndAt": bodies[index]["scheduledEndAt"],
                    },
                )

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(schedule, index) for index in range(len(created))]
                results = [future.result() for future in futures]
            meeting_ids = [meeting_id for meeting_id, _headers in created]
            self._state.update({
                "roomId": room_id,
                "meetingIds": meeting_ids,
                "scheduledStartAt": bodies[0]["scheduledStartAt"],
                "scheduledEndAt": bodies[0]["scheduledEndAt"],
            })
            statuses = [status for status, _payload, _headers in results]
            if sum(200 <= status < 300 for status in statuses) != 1 or not any(
                status == 409 for status in statuses
            ):
                raise ScenarioUnavailable("Concurrent room conflict was not observed")
            accepted = next(
                index for index, status in enumerate(statuses) if 200 <= status < 300
            )
            self._state["acceptedMeetingId"] = meeting_ids[accepted]
            self._state["rejectedStatus"] = 409
            return self._handle(
                step, request_id, roomId=room_id,
                acceptedMeetingId=self._state["acceptedMeetingId"], conflict=True,
            )
        accepted = _safe_uuid(self._state.get("acceptedMeetingId"), "accepted meeting")
        if step == "cancellation-released-room":
            meeting, headers = self._core_data(
                "GET", f"/api/v1/meetings/{accepted}", request_id=str(uuid4()),
            )
            accepted_data = _require_dict(meeting, "accepted meeting")
            if accepted_data.get("status") != "SCHEDULED":
                raise ScenarioUnavailable("Accepted room meeting was not scheduled")
            status, payload, _ = self._core_status(
                "POST",
                f"/api/v1/meetings/{accepted}/cancel",
                request_id=request_id,
                if_match=headers.get("ETag"),
                body={"reason": "PI-05 room release"},
            )
            if status < 200 or status >= 300:
                raise ScenarioUnavailable("Meeting cancellation was rejected")
            cancelled = _data_dict(payload, "cancelled meeting")
            if cancelled.get("status") != "CANCELLED":
                raise ScenarioUnavailable("Meeting cancellation did not release the meeting")
            start = self._state.get("scheduledStartAt")
            end = self._state.get("scheduledEndAt")
            if not isinstance(start, str) or not isinstance(end, str):
                raise ScenarioUnavailable("Room schedule interval is unavailable")
            create_status, create_payload, create_headers = self._core_status(
                "POST",
                "/api/v1/meetings",
                request_id=str(uuid4()),
                body={
                    "title": f"PI-05 L10 released {contextual_run_suffix(self.context.run_id)}",
                    "scheduledStartAt": start,
                    "scheduledEndAt": end,
                    "roomId": room_id,
                },
                idempotency_key=str(uuid4()),
            )
            if create_status < 200 or create_status >= 300:
                raise ScenarioUnavailable("Released room meeting admission was rejected")
            released = _data_dict(create_payload, "released-room meeting")
            replacement = _safe_uuid(released.get("id"), "replacement meeting")
            schedule_status, schedule_payload, _ = self._core_status(
                "POST",
                f"/api/v1/meetings/{replacement}/schedule",
                request_id=str(uuid4()),
                if_match=create_headers.get("ETag"),
                body={"scheduledStartAt": start, "scheduledEndAt": end},
            )
            if schedule_status < 200 or schedule_status >= 300:
                raise ScenarioUnavailable("Released room could not be reserved")
            scheduled = _data_dict(schedule_payload, "released-room schedule")
            if scheduled.get("status") != "SCHEDULED":
                raise ScenarioUnavailable("Released room reservation was not scheduled")
            self._state["replacementMeetingId"] = replacement
            return self._handle(
                step,
                request_id,
                meetingId=accepted,
                replacementMeetingId=replacement,
                released=True,
            )
        if step == "notification-recovered":
            pending, failed = self._wait_for_notification_recovery(request_id)
            self._state["notificationPending"] = pending
            return self._handle(
                step, request_id, meetingId=accepted, notificationPending=pending,
                notificationFailed=failed,
            )
        raise ScenarioUnavailable("Unknown L10 step")

    def _wait_for_notification_recovery(self, request_id: str) -> tuple[int, int]:
        deadline = time.monotonic() + self.settings.timeout_seconds
        while time.monotonic() < deadline:
            pending, failed = self.metrics.notification_counts(request_id)
            if failed == 0 and pending == 0:
                return pending, failed
            time.sleep(self.settings.poll_interval_seconds)
        raise ScenarioUnavailable("Notification delivery did not recover")

    def _observe_room_notification(self, step: str, observation: Observation) -> str:
        room_id = _safe_uuid(self._state.get("roomId", self._fixture_uuid("roomId")), "room")
        if step == "overlap-rejected":
            meeting_ids = self._state.get("meetingIds")
            if not isinstance(meeting_ids, list) or len(meeting_ids) != 2:
                raise ObserverBlocked("Room conflict meeting identities are incomplete")
            active = 0
            for meeting_id in meeting_ids:
                data = self.settings.l01.observer_core.request_json(
                    str(uuid4()),
                    f"/api/v1/meetings/{_safe_uuid(meeting_id, 'meeting')}",
                )
                value = _data_dict(data, "meeting")
                if value.get("status") == "SCHEDULED":
                    active += 1
            if active != 1:
                raise ObserverBlocked("Room observer found an invalid overlap result")
            return self.writer.write(
                observation,
                {
                    "contractVersion": "pi05-observer-source-v1",
                    "boundary": "CORE",
                    "operation": "concurrent-room-conflict-read",
                    "roomId": room_id,
                    "scheduledMeetingCount": active,
                    "conflictStatus": self._state.get("rejectedStatus"),
                },
            )
        if step == "cancellation-released-room":
            accepted = _safe_uuid(self._state.get("acceptedMeetingId"), "accepted meeting")
            replacement = _safe_uuid(
                self._state.get("replacementMeetingId"), "replacement meeting",
            )
            cancelled_data = self.settings.l01.observer_core.request_json(
                observation.request_id, f"/api/v1/meetings/{accepted}",
            )
            data = self.settings.l01.observer_core.request_json(
                str(uuid4()), f"/api/v1/meetings/{replacement}",
            )
            cancelled = _data_dict(cancelled_data, "cancelled meeting")
            value = _data_dict(data, "replacement meeting")
            if (
                cancelled.get("status") != "CANCELLED"
                or value.get("status") != "SCHEDULED"
                or cancelled.get("roomId") != room_id
                or value.get("roomId") != room_id
            ):
                raise ObserverBlocked("Cancelled room was not independently released and reused")
            return self.writer.write(
                observation,
                {
                    "contractVersion": "pi05-observer-source-v1",
                    "boundary": "CORE",
                    "operation": "cancelled-room-reuse-read",
                    "roomId": room_id,
                    "cancelledMeetingId": accepted,
                    "replacementMeetingId": replacement,
                    "cancelledStatus": cancelled["status"],
                    "replacementStatus": value["status"],
                },
            )
        pending, failed = self.metrics.notification_counts(observation.request_id)
        if failed != 0 or pending != 0:
            raise ObserverBlocked("Notification delivery has not recovered")
        return self.writer.write(
            observation,
            {
                "contractVersion": "pi05-observer-source-v1",
                "boundary": "CORE",
                "operation": "notification-recovery-metrics-read",
                "pending": pending,
                "failed": failed,
                "deliveryRecovered": True,
            },
        )


def build_l02_l10_executor(
    context: OrchestrationContext,
    configuration: RunConfiguration,
    *,
    runtime: Any | None = None,
) -> tuple[OrchestratorExecutor, list[RealScenarioOperations]]:
    """Assemble every explicitly enabled L02-L10 real adapter.

    Readiness is checked before the executor is returned.  The returned
    operations are owned by the caller and must be closed when the server exits.
    """
    if configuration.run_id != context.run_id or configuration.root != context.proof_dir.parent:
        raise ScenarioUnavailable("L02-L10 configuration is outside the orchestration run")
    if runtime is None:
        from application_runtime import ApplicationRuntime

        runtime = ApplicationRuntime(
            context.run_id,
            configuration.root,
            source_root=Path(__file__).resolve().parents[3],
            runs_base=configuration.root.parent,
        )
    writer = ReceiptWriter(context.proof_dir, context.source_dir)
    settings = ScenarioRuntimeSettings.from_configuration(
        context, configuration, writer=writer, runtime=runtime,
    )
    operations: list[RealScenarioOperations] = []
    adapters: dict[str, dict[str, StepHandler]] = {}
    try:
        for scenario in L02_L10_SCENARIOS:
            operation = RealScenarioOperations(context, scenario, settings)
            operation.readiness()
            operations.append(operation)
            adapters[scenario] = RealScenarioAdapter(
                context, scenario, operation,
            ).step_handlers()
        from scenario_handlers import ScenarioHandlerRegistry

        registry = ScenarioHandlerRegistry(
            adapters, enabled_scenarios=L02_L10_SCENARIOS,
        )
        orchestrator = ScenarioOrchestrator(context, handlers=registry.handlers())
        return OrchestratorExecutor(orchestrator), operations
    except Exception:
        for operation in operations:
            operation.close()
        raise


def _require_dict(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ScenarioUnavailable(f"{label} response is invalid")
    return value


def _error_code(payload: object) -> str:
    if not isinstance(payload, dict):
        return "UNKNOWN"
    for key in ("code", "errorCode", "error"):
        value = payload.get(key)
        if isinstance(value, str) and _SAFE_ERROR.fullmatch(value):
            return value
    return "UNKNOWN"


def _contains_protected(value: object) -> bool:
    if isinstance(value, dict):
        return any(
            _UNSAFE_FIELD.search(str(key)) is not None or _contains_protected(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_protected(item) for item in value)
    return False


def _reconciliation_request(
    meeting_id: str,
    source_id: str,
    revision: int,
    generation: str,
) -> dict[str, object]:
    return {
        "contractVersion": "1.0",
        "generationId": generation,
        "requests": [{
            "sourceIdentity": {
                "sourceType": "TRANSCRIPT",
                "sourceId": source_id,
                "meetingId": meeting_id,
            },
            "sourceRevision": {"number": revision},
        }],
    }


def _observed_count(data: Mapping[str, object], key: str) -> int:
    value = data.get(key)
    if type(value) is not int or value < 0:
        raise ObserverBlocked(f"Reconciliation {key} is invalid")
    return value


def contextual_run_suffix(run_id: str) -> str:
    """Return a harmless deterministic label without retaining source content."""
    return hashlib.sha256(run_id.encode("ascii")).hexdigest()[:12]


__all__ = [
    "L02_L10_SCENARIOS",
    "RealScenarioAdapter",
    "RealScenarioOperations",
    "ScenarioFixtureError",
    "ScenarioFixtureSet",
    "ScenarioHandle",
    "ScenarioUnavailable",
    "build_l02_l10_executor",
]
