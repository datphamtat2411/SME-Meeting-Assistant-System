"""Offline tests for the fail-closed PI-05 scenario endpoint."""

from __future__ import annotations

import hashlib
import http.client
import json
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "services/ai/tests"))

from pi05_live_contract import REQUIRED
from scenario_server import (
    ScenarioContext,
    ScenarioHTTPServer,
    ScenarioUnavailable,
    UnimplementedExecutor,
    _build_l01_executor,
    _build_l02_l10_executor,
    _private_file,
)


def _context(tmp_path: Path) -> ScenarioContext:
    run_id = str(uuid4())
    proof_dir = tmp_path / "proofs"
    proof_dir.mkdir(mode=0o700)
    commit = "a" * 40
    generation = "generation-" + run_id
    collection = "collection-" + run_id
    environment = {
        "disposable": True,
        "environmentId": "offline-fixture",
        "coreBuild": commit,
        "aiBuild": commit,
        "flywayVersion": "V59",
        "tlsMode": "MTLS",
        "generationId": generation,
        "collectionName": collection,
    }
    return ScenarioContext(
        run_id=run_id,
        commit=commit,
        generation=generation,
        collection=collection,
        environment=environment,
        proof_dir=proof_dir,
    )


def _request(context: ScenarioContext, scenario: str = "room-notification") -> dict:
    return {
        "contractVersion": "1.0",
        "runId": context.run_id,
        "sourceCommit": context.commit,
        "generationId": context.generation,
        "collectionName": context.collection,
    }


def _payload(context: ScenarioContext, scenario: str = "room-notification") -> dict:
    observations = []
    for step, (component, outcome) in REQUIRED[scenario].items():
        record = {
            "runId": context.run_id,
            "requestId": str(uuid4()),
            "step": step,
            "component": component,
            "observedResult": outcome,
            "observedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        }
        raw = json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(raw).hexdigest()
        (context.proof_dir / f"{digest}.json").write_bytes(raw)
        (context.proof_dir / f"{digest}.json").chmod(0o600)
        record["proofSha256"] = digest
        observations.append(record)
    return {
        "contractVersion": "1.0",
        "scenario": scenario,
        "status": "PASS",
        "runId": context.run_id,
        "sourceCommit": context.commit,
        "environment": context.environment,
        "observations": observations,
    }


class RecordingExecutor:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def execute(self, scenario, request, context):
        self.calls.append((scenario, request, context))
        if self.error is not None:
            raise self.error
        return self.result


@pytest.fixture
def server_factory():
    servers = []

    def create(context, executor=None):
        server = ScenarioHTTPServer(
            ("127.0.0.1", 0), context, executor or UnimplementedExecutor(),
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append((server, thread))
        return server

    yield create
    for server, thread in servers:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def call(server, method, path, body=None):
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
    encoded = None if body is None else json.dumps(body).encode()
    headers = {}
    if encoded is not None:
        headers.update({"Content-Type": "application/json", "Content-Length": str(len(encoded))})
    connection.request(method, path, body=encoded, headers=headers)
    response = connection.getresponse()
    raw = response.read()
    connection.close()
    return response.status, json.loads(raw)


def test_default_server_never_claims_pass_for_unimplemented_scenario(tmp_path, server_factory):
    context = _context(tmp_path)
    server = server_factory(context)

    status, body = call(
        server, "POST", "/v1/pi05/scenarios/room-notification", _request(context),
    )

    assert status == 503
    assert body == {"error": "scenario_unavailable"}


def test_l01_activation_builder_is_explicit_and_run_scoped(tmp_path, monkeypatch):
    context = _context(tmp_path)
    source_dir = tmp_path / "observation-sources"
    source_dir.mkdir(mode=0o700)
    calls = []
    configuration = object()

    class Operations:
        def close(self):
            calls.append(("close",))

    operations = Operations()

    def load(run_id, root):
        calls.append(("load", run_id, root))
        return configuration

    def build(orchestration_context, loaded):
        calls.append(("build", orchestration_context, loaded))
        return object(), operations

    monkeypatch.setattr("runtime_config.load_run_configuration", load)
    monkeypatch.setattr("l01_adapter.build_l01_executor", build)

    executor, cleanup = _build_l01_executor(context, tmp_path)

    assert executor is not None
    assert calls[0] == ("load", context.run_id, tmp_path.absolute())
    assert calls[1][0] == "build"
    assert calls[1][1].run_id == context.run_id
    assert calls[1][1].proof_dir == context.proof_dir
    assert calls[1][1].source_dir == source_dir
    assert calls[1][2] is configuration
    cleanup()
    assert calls[-1] == ("close",)


def test_l02_l10_activation_builder_is_explicit_and_closes_all_operations(
    tmp_path, monkeypatch,
):
    context = _context(tmp_path)
    source_dir = tmp_path / "observation-sources"
    source_dir.mkdir(mode=0o700)
    calls = []
    configuration = object()

    class Operation:
        def __init__(self, name):
            self.name = name

        def close(self):
            calls.append(("close", self.name))

    operations = [Operation("revision"), Operation("room")]

    def load(run_id, root):
        calls.append(("load", run_id, root))
        return configuration

    def build(orchestration_context, loaded):
        calls.append(("build", orchestration_context, loaded))
        return object(), operations

    monkeypatch.setattr("runtime_config.load_run_configuration", load)
    monkeypatch.setattr("real_scenario_adapter.build_l02_l10_executor", build)

    executor, cleanup = _build_l02_l10_executor(context, tmp_path)

    assert executor is not None
    assert calls[0] == ("load", context.run_id, tmp_path.absolute())
    assert calls[1][0] == "build"
    assert calls[1][1].run_id == context.run_id
    assert calls[1][1].proof_dir == context.proof_dir
    assert calls[1][1].source_dir == source_dir
    assert calls[1][2] is configuration

    cleanup()
    assert calls[-2:] == [("close", "room"), ("close", "revision")]


def test_request_contract_is_checked_before_executor(tmp_path, server_factory):
    context = _context(tmp_path)
    executor = RecordingExecutor(result=_payload(context))
    server = server_factory(context, executor)
    request = _request(context)
    request["unexpected"] = "reject"

    status, body = call(server, "POST", "/v1/pi05/scenarios/room-notification", request)

    assert status == 400
    assert body == {"error": "invalid_request"}
    assert executor.calls == []


def test_verified_executor_result_is_returned_without_writing_evidence(
    tmp_path, server_factory,
):
    context = _context(tmp_path)
    result = _payload(context)
    before = sorted(context.proof_dir.iterdir())
    executor = RecordingExecutor(result=result)
    server = server_factory(context, executor)

    status, body = call(
        server, "POST", "/v1/pi05/scenarios/room-notification", _request(context),
    )

    assert status == 200
    assert body["status"] == "PASS"
    assert body["scenario"] == "room-notification"
    assert sorted(context.proof_dir.iterdir()) == before
    assert executor.calls[0][0] == "room-notification"


def test_invalid_executor_evidence_cannot_become_pass(tmp_path, server_factory):
    context = _context(tmp_path)
    result = _payload(context)
    (context.proof_dir / f"{result['observations'][0]['proofSha256']}.json").unlink()
    executor = RecordingExecutor(result=result)
    server = server_factory(context, executor)

    status, body = call(
        server, "POST", "/v1/pi05/scenarios/room-notification", _request(context),
    )

    assert status == 502
    assert body == {"error": "scenario_evidence_invalid"}


def test_executor_failure_is_sanitized(tmp_path, server_factory):
    context = _context(tmp_path)
    executor = RecordingExecutor(error=RuntimeError("secret-looking internal detail"))
    server = server_factory(context, executor)

    status, body = call(
        server, "POST", "/v1/pi05/scenarios/room-notification", _request(context),
    )

    assert status == 500
    assert body == {"error": "scenario_failed"}
    assert "secret-looking" not in json.dumps(body)


def test_unavailable_executor_maps_to_bounded_response(tmp_path, server_factory):
    context = _context(tmp_path)
    executor = RecordingExecutor(error=ScenarioUnavailable())
    server = server_factory(context, executor)

    status, body = call(
        server, "POST", "/v1/pi05/scenarios/room-notification", _request(context),
    )

    assert status == 503
    assert body == {"error": "scenario_unavailable"}


def test_private_file_check_rejects_group_or_world_readable_secret(tmp_path):
    path = tmp_path / "key.pem"
    path.write_text("offline-only")
    path.chmod(0o644)

    with pytest.raises(ValueError):
        _private_file(path, private=True)
