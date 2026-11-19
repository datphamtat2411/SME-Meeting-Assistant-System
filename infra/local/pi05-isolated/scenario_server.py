#!/usr/bin/env python3
"""Fail-closed PI-05 scenario HTTP boundary.

The default executor is unavailable.  The only built-in activation is the
explicit ``--enable-l01`` path, which loads one private run configuration,
checks the real application boundaries, and binds only the real-service L01
executor.  L02-L10 have a separate explicit ``--enable-l02-l10`` activation
and are mutually exclusive with L01.  The server never invents scenario
observations or writes proof receipts.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import unquote, urlsplit
from uuid import UUID

ROOT = Path(__file__).resolve().parents[3]
AI_TESTS = ROOT / "services" / "ai" / "tests"
if str(AI_TESTS) not in sys.path:
    sys.path.insert(0, str(AI_TESTS))

from pi05_live_contract import (  # noqa: E402
    REQUIRED,
    validate_live_evidence,
    verify_proof_files,
)

from scenario_orchestrator import ScenarioUnavailable  # noqa: E402

MAX_REQUEST_BYTES = 16 * 1024
_COMMIT = re.compile(r"[0-9a-f]{40}")
_SCOPED_NAME = re.compile(r"[A-Za-z0-9_-]{1,128}")
_SAFE_ENVIRONMENT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{2,127}")
_PATH_PREFIX = "/v1/pi05/scenarios/"


def _cleanup_once(callback: Callable[[], None]) -> Callable[[], None]:
    called = False

    def cleanup() -> None:
        nonlocal called
        if not called:
            called = True
            callback()

    return cleanup


class ScenarioExecutor(Protocol):
    def execute(
        self, scenario: str, request: ScenarioRequest, context: ScenarioContext,
    ) -> dict[str, Any]:
        """Run one real scenario and return its evidence payload."""


class UnimplementedExecutor:
    """Safe default: an unimplemented harness can never return a PASS."""

    def execute(self, scenario, request, context):
        raise ScenarioUnavailable


def _canonical_run_id(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("run ID must be a string")
    try:
        canonical = str(UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("run ID must be a UUID") from error
    if canonical != value:
        raise ValueError("run ID must be canonical")
    return canonical


def _scoped_name(value: object, run_id: str, label: str) -> str:
    if (
        not isinstance(value, str)
        or _SCOPED_NAME.fullmatch(value) is None
        or not any(token in value.lower() for token in (run_id, run_id.replace("-", "")))
    ):
        raise ValueError(f"{label} is not scoped to the run")
    return value


def _private_directory(path: Path) -> Path:
    path = Path(path)
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError("symbolic path is not allowed")
    info = path.stat()
    if (
        not info
        or not path.is_dir()
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise ValueError("private proof directory is required")
    return path


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


@dataclass(frozen=True)
class ScenarioContext:
    """Immutable run identity and independently prepared evidence boundary."""

    run_id: str
    commit: str
    generation: str
    collection: str
    environment: dict[str, Any]
    proof_dir: Path

    def __post_init__(self) -> None:
        run_id = _canonical_run_id(self.run_id)
        if not isinstance(self.commit, str) or _COMMIT.fullmatch(self.commit) is None:
            raise ValueError("source commit must be a lowercase 40-hex SHA")
        generation = _scoped_name(self.generation, run_id, "generation")
        collection = _scoped_name(self.collection, run_id, "collection")
        environment = dict(self.environment)
        if set(environment) != {
            "disposable", "environmentId", "coreBuild", "aiBuild",
            "flywayVersion", "tlsMode", "generationId", "collectionName",
        }:
            raise ValueError("environment metadata is incomplete or overbroad")
        if (
            environment["disposable"] is not True
            or not isinstance(environment["environmentId"], str)
            or _SAFE_ENVIRONMENT_ID.fullmatch(environment["environmentId"]) is None
            or environment["environmentId"].casefold() in {"prod", "production", "live", "main"}
            or environment["coreBuild"] != self.commit
            or environment["aiBuild"] != self.commit
            or not isinstance(environment["flywayVersion"], str)
            or re.fullmatch(r"V[0-9]+", environment["flywayVersion"]) is None
            or int(environment["flywayVersion"][1:]) < 51
            or environment["tlsMode"] != "MTLS"
            or environment["generationId"] != generation
            or environment["collectionName"] != collection
        ):
            raise ValueError("environment metadata does not match the run")
        proof_dir = _private_directory(Path(self.proof_dir).absolute())
        object.__setattr__(self, "run_id", run_id)
        object.__setattr__(self, "generation", generation)
        object.__setattr__(self, "collection", collection)
        object.__setattr__(self, "environment", environment)
        object.__setattr__(self, "proof_dir", proof_dir)


@dataclass(frozen=True)
class ScenarioRequest:
    contract_version: str
    run_id: str
    commit: str
    generation: str
    collection: str


def _parse_request(body: object, context: ScenarioContext) -> ScenarioRequest:
    if not isinstance(body, dict) or set(body) != {
        "contractVersion", "runId", "sourceCommit", "generationId", "collectionName",
    }:
        raise ValueError("request fields are not exact")
    values = (
        body["contractVersion"], body["runId"], body["sourceCommit"],
        body["generationId"], body["collectionName"],
    )
    if any(type(value) is not str or not value for value in values):
        raise ValueError("request fields must be nonempty strings")
    if body["contractVersion"] != "1.0":
        raise ValueError("unsupported contract")
    if (
        _canonical_run_id(body["runId"]) != context.run_id
        or body["sourceCommit"] != context.commit
        or body["generationId"] != context.generation
        or body["collectionName"] != context.collection
    ):
        raise ValueError("request provenance does not match the run")
    return ScenarioRequest(
        contract_version=body["contractVersion"],
        run_id=body["runId"],
        commit=body["sourceCommit"],
        generation=body["generationId"],
        collection=body["collectionName"],
    )


def _json_body(handler: BaseHTTPRequestHandler) -> object:
    if handler.headers.get("Transfer-Encoding"):
        raise ValueError("chunked request is not accepted")
    length = handler.headers.get("Content-Length")
    if (
        length is None
        or not length.isascii()
        or not length.isdecimal()
        or int(length) > MAX_REQUEST_BYTES
    ):
        raise ValueError("bounded content length is required")
    if handler.headers.get_content_type() != "application/json":
        raise ValueError("JSON content type is required")
    raw = handler.rfile.read(int(length))
    if len(raw) != int(length):
        raise ValueError("request body is truncated")
    try:
        return json.loads(raw, object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise ValueError("request body is not valid JSON") from error


class _ScenarioHandler(BaseHTTPRequestHandler):
    server: ScenarioHTTPServer

    def log_message(self, _format, *_args):
        # Request paths can contain operator-controlled data; do not copy them
        # into an unreviewed log stream.  The driver retains sanitized evidence.
        return None

    def _send(self, status: int, payload: dict[str, str]) -> None:
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._send(405, {"error": "method_not_allowed"})

    def do_POST(self):
        parts = urlsplit(self.path)
        if parts.query or parts.fragment or not parts.path.startswith(_PATH_PREFIX):
            self._send(404, {"error": "not_found"})
            return
        scenario = unquote(parts.path[len(_PATH_PREFIX):])
        if "/" in scenario or scenario not in REQUIRED:
            self._send(404, {"error": "unknown_scenario"})
            return
        try:
            request = _parse_request(_json_body(self), self.server.context)
        except (ValueError, TypeError, UnicodeError):
            self._send(400, {"error": "invalid_request"})
            return

        try:
            with self.server.execution_lock:
                result = self.server.executor.execute(scenario, request, self.server.context)
        except ScenarioUnavailable:
            self._send(503, {"error": "scenario_unavailable"})
            return
        except Exception:  # noqa: BLE001
            self._send(500, {"error": "scenario_failed"})
            return

        if not isinstance(result, dict):
            self._send(502, {"error": "scenario_evidence_invalid"})
            return
        try:
            if result.get("environment") != self.server.context.environment:
                raise ValueError("environment was not independently bound")
            validate_live_evidence(
                scenario,
                result,
                run_id=request.run_id,
                commit=request.commit,
                generation=request.generation,
                collection=request.collection,
            )
            verify_proof_files(result, self.server.context.proof_dir)
        except (ValueError, TypeError, KeyError):
            self._send(502, {"error": "scenario_evidence_invalid"})
            return

        # The payload has already been validated against the unchanged contract;
        # this handler never creates or edits the independently collected proof.
        raw = json.dumps(result, sort_keys=True, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)


class ScenarioHTTPServer(ThreadingHTTPServer):
    """Threaded local server with one immutable run context."""

    allow_reuse_address = False
    daemon_threads = True

    def __init__(
        self,
        server_address,
        context: ScenarioContext,
        executor: ScenarioExecutor,
    ):
        self.context = context
        self.executor = executor
        self.execution_lock = threading.Lock()
        super().__init__(server_address, _ScenarioHandler)


def _build_l01_executor(
    context: ScenarioContext,
    run_root: Path,
) -> tuple[ScenarioExecutor, Callable[[], None]]:
    """Build the explicit L01 executor without activating any later scenario."""
    from l01_adapter import build_l01_executor
    from runtime_config import load_run_configuration
    from scenario_orchestrator import OrchestrationContext

    run_root = Path(run_root).absolute()
    source_dir = run_root / "observation-sources"
    _private_directory(source_dir)
    orchestration_context = OrchestrationContext(
        run_id=context.run_id,
        commit=context.commit,
        generation=context.generation,
        collection=context.collection,
        environment=context.environment,
        proof_dir=context.proof_dir,
        source_dir=source_dir,
    )
    configuration = load_run_configuration(context.run_id, run_root)
    executor, operations = build_l01_executor(
        orchestration_context, configuration,
    )
    return executor, operations.close


def _build_l02_l10_executor(
    context: ScenarioContext,
    run_root: Path,
) -> tuple[ScenarioExecutor, Callable[[], None]]:
    """Build the explicit real-service L02-L10 executor as one run boundary."""
    from real_scenario_adapter import build_l02_l10_executor
    from runtime_config import load_run_configuration
    from scenario_orchestrator import OrchestrationContext

    run_root = Path(run_root).absolute()
    source_dir = run_root / "observation-sources"
    _private_directory(source_dir)
    orchestration_context = OrchestrationContext(
        run_id=context.run_id,
        commit=context.commit,
        generation=context.generation,
        collection=context.collection,
        environment=context.environment,
        proof_dir=context.proof_dir,
        source_dir=source_dir,
    )
    configuration = load_run_configuration(context.run_id, run_root)
    executor, operations = build_l02_l10_executor(
        orchestration_context, configuration,
    )

    def close() -> None:
        for operation in reversed(operations):
            operation.close()

    return executor, close


def _private_file(path: Path, *, private: bool = False) -> Path:
    path = Path(path)
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError("symbolic TLS path is not allowed")
    info = path.stat()
    if (
        not path.is_file()
        or info.st_uid != os.getuid()
        or info.st_mode & (0o077 if private else 0o022)
    ):
        raise ValueError("TLS material must be a regular owner-controlled file")
    return path


def serve(
    context: ScenarioContext,
    executor: ScenarioExecutor | None = None,
    *,
    host: str = "127.0.0.1",
    port: int = 9443,
    certificate: Path | None = None,
    key: Path | None = None,
    client_ca: Path | None = None,
    cleanup: Callable[[], None] | None = None,
) -> None:
    """Serve the endpoint; TLS with mandatory client authentication is required."""
    if not isinstance(host, str) or not host or type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("invalid listen endpoint")
    paths = (certificate, key, client_ca)
    if any(path is None for path in paths):
        raise ValueError("server certificate, key and client CA are required")
    certificate = _private_file(certificate)
    key = _private_file(key, private=True)
    client_ca = _private_file(client_ca)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.verify_mode = ssl.CERT_REQUIRED
    tls.load_cert_chain(certfile=str(certificate), keyfile=str(key))
    tls.load_verify_locations(cafile=str(client_ca))
    server: ScenarioHTTPServer | None = None
    try:
        server = ScenarioHTTPServer(
            (host, port),
            context,
            executor if executor is not None else UnimplementedExecutor(),
        )
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        server.serve_forever()
    finally:
        if server is not None:
            server.server_close()
        if cleanup is not None:
            cleanup()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--generation", required=True)
    parser.add_argument("--collection", required=True)
    parser.add_argument("--environment-file", required=True, type=Path)
    parser.add_argument("--proof-dir", required=True, type=Path)
    parser.add_argument("--run-root", type=Path)
    activation = parser.add_mutually_exclusive_group()
    activation.add_argument(
        "--enable-l01",
        action="store_true",
        help="explicitly bind the real-service full-pipeline scenario only",
    )
    activation.add_argument(
        "--enable-l02-l10",
        action="store_true",
        help="explicitly bind all real-service L02-L10 scenarios only",
    )
    parser.add_argument("--certificate", required=True, type=Path)
    parser.add_argument("--key", required=True, type=Path)
    parser.add_argument("--client-ca", required=True, type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=9443, type=int)
    args = parser.parse_args()
    cleanup: Callable[[], None] | None = None
    try:
        environment_path = _private_file(args.environment_file, private=True)
        if environment_path.stat().st_size > 16 * 1024:
            raise ValueError("environment metadata is oversized")
        environment = json.loads(
            environment_path.read_text(encoding="utf-8"),
            object_pairs_hook=_unique_object,
        )
        context = ScenarioContext(
            run_id=args.run_id,
            commit=args.source_commit,
            generation=args.generation,
            collection=args.collection,
            environment=environment,
            proof_dir=args.proof_dir,
        )
        executor: ScenarioExecutor | None = None
        if args.enable_l01 or args.enable_l02_l10:
            if args.run_root is None:
                raise ValueError("--run-root is required for real scenario activation")
            if args.enable_l01:
                executor, cleanup = _build_l01_executor(context, args.run_root)
            else:
                executor, cleanup = _build_l02_l10_executor(context, args.run_root)
            cleanup = _cleanup_once(cleanup)
        serve(
            context,
            executor=executor,
            host=args.host,
            port=args.port,
            certificate=args.certificate,
            key=args.key,
            client_ca=args.client_ca,
            cleanup=cleanup,
        )
    except Exception:  # noqa: BLE001
        if cleanup is not None:
            cleanup()
        print("BLOCKED: scenario server configuration is invalid", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
