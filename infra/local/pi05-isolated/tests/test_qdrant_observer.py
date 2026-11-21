"""Offline-only tests: synthetic responses and receipts are not live evidence."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
import stat
import sys
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "services/ai/tests"))
from pi05_live_contract import verify_proof_files  # noqa: E402
import qdrant_observer as observer  # noqa: E402
from preflight import Blocked  # noqa: E402
from tls_support import create_test_pki  # noqa: E402


@pytest.fixture
def isolated_run(tmp_path, monkeypatch):
    run_id = str(uuid4())
    base = tmp_path / "runs"
    root = base / run_id
    for directory in (
        root, root / "secrets", root / "pki", root / "pki" / "qdrant-server",
        root / "proofs", root / "observation-sources",
    ):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    (root / "secrets" / "qdrant.env").write_text(
        "QDRANT__SERVICE__API_KEY=offline_unit_credential_only\n"
    )
    (root / "secrets" / "qdrant.env").chmod(0o600)
    monkeypatch.setattr(observer, "RUNS_BASE", base)
    calls = []

    def inspect(identity, directory):
        calls.append((identity, directory))
        return {"qdrant": "127.0.0.1:53123"}

    monkeypatch.setattr(observer.runtime_inspection, "inspect_topology", inspect)
    return {
        "run_id": run_id,
        "root": root,
        "generation": "generation-" + run_id,
        "collection": "collection-" + run_id,
        "meeting_id": str(uuid4()),
        "source_id": str(uuid4()),
        "revision": 4,
        "calls": calls,
    }


def observe(run):
    return observer.observe_indexed(**{k: v for k, v in run.items() if k != "calls"})


def test_qdrant_tls_requires_dual_san_and_server_eku(isolated_run, tmp_path):
    certificate_dir = tmp_path / "certificates"
    certificate_dir.mkdir()
    certificates = create_test_pki(certificate_dir)
    qdrant = isolated_run["root"] / "pki" / "qdrant-server"
    shutil.copy2(certificates / "server.crt", qdrant / "tls.crt")
    shutil.copy2(certificates / "server.key", qdrant / "tls.key")
    shutil.copy2(certificates / "ca.crt", qdrant / "issuer-ca.crt")
    (qdrant / "tls.crt").chmod(0o600)
    (qdrant / "tls.key").chmod(0o600)
    (qdrant / "issuer-ca.crt").chmod(0o600)

    context, leaf = observer._qdrant_tls(isolated_run["root"])

    assert context.check_hostname is True
    assert isinstance(leaf, bytes)
    assert hashlib.sha256(leaf).hexdigest()


def test_qdrant_tls_rejects_a_dns_only_leaf(isolated_run, tmp_path):
    certificate_dir = tmp_path / "certificates"
    certificate_dir.mkdir()
    certificates = create_test_pki(certificate_dir)
    qdrant = isolated_run["root"] / "pki" / "qdrant-server"
    shutil.copy2(certificates / "ai-server.crt", qdrant / "tls.crt")
    shutil.copy2(certificates / "ai-server.key", qdrant / "tls.key")
    shutil.copy2(certificates / "ca.crt", qdrant / "issuer-ca.crt")
    (qdrant / "tls.crt").chmod(0o600)
    (qdrant / "tls.key").chmod(0o600)
    (qdrant / "issuer-ca.crt").chmod(0o600)

    with pytest.raises(Blocked, match="TLS identity"):
        observer._qdrant_tls(isolated_run["root"])


def test_qdrant_tls_rejects_a_leaf_and_key_mismatch(isolated_run, tmp_path):
    certificate_dir = tmp_path / "certificates"
    certificate_dir.mkdir()
    certificates = create_test_pki(certificate_dir)
    qdrant = isolated_run["root"] / "pki" / "qdrant-server"
    shutil.copy2(certificates / "server.crt", qdrant / "tls.crt")
    shutil.copy2(certificates / "ai-server.key", qdrant / "tls.key")
    shutil.copy2(certificates / "ca.crt", qdrant / "issuer-ca.crt")
    (qdrant / "tls.crt").chmod(0o600)
    (qdrant / "tls.key").chmod(0o600)
    (qdrant / "issuer-ca.crt").chmod(0o600)

    with pytest.raises(Blocked, match="TLS identity"):
        observer._qdrant_tls(isolated_run["root"])


def test_writes_separate_content_addressed_receipt_and_sanitized_source(isolated_run, monkeypatch):
    run = isolated_run
    captured = {}

    def query(**kwargs):
        captured.update(kwargs)
        return 3, "a" * 64

    monkeypatch.setattr(observer, "_query_qdrant", query)
    digest = observe(run)
    root = run["root"]
    raw = (root / "proofs" / (digest + ".json")).read_bytes()
    receipt = json.loads(raw)
    source = json.loads((root / "observation-sources" / (digest + ".json")).read_bytes())
    assert hashlib.sha256(raw).hexdigest() == digest
    assert receipt["step"] == "qdrant-points"
    assert receipt["component"] == "QDRANT"
    assert receipt["observedResult"] == "INDEXED"
    assert receipt["runId"] == run["run_id"]
    verify_proof_files({"observations": [{**receipt, "proofSha256": digest}]}, root / "proofs")
    assert source["proofSha256"] == digest
    assert source["requestId"] == receipt["requestId"] == captured["request_id"]
    assert source["pointCount"] == 3
    assert source["meetingId"] == run["meeting_id"]
    assert source["sourceId"] == run["source_id"]
    assert source["sourceRevision"] == 4
    assert source["generationId"] == run["generation"]
    assert source["collectionName"] == run["collection"]
    assert source["endpoint"] == "127.0.0.1:53123"
    assert source["tlsLeafSha256"] == "a" * 64
    assert run["calls"] == [(run["run_id"], root)]
    assert captured["port"] == 53123
    for directory in ("proofs", "observation-sources"):
        path = root / directory / (digest + ".json")
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert b"offline_unit_credential_only" not in path.read_bytes()


@pytest.mark.parametrize("problem", [
    "foreign-root", "foreign-generation", "foreign-collection", "bad-meeting",
    "bad-source", "negative-revision", "boolean-revision", "symlink-proof",
    "unsafe-port", "missing-qdrant",
])
def test_rejects_unscoped_inputs_before_any_query(isolated_run, monkeypatch, problem):
    run = isolated_run
    root = run["root"]
    if problem == "foreign-root":
        run["root"] = root.parent / str(uuid4())
    elif problem == "foreign-generation":
        run["generation"] = "foreign-generation"
    elif problem == "foreign-collection":
        run["collection"] = "foreign-collection"
    elif problem == "bad-meeting":
        run["meeting_id"] = "../not-an-id"
    elif problem == "bad-source":
        run["source_id"] = "../not-an-id"
    elif problem == "negative-revision":
        run["revision"] = -1
    elif problem == "boolean-revision":
        run["revision"] = True
    elif problem == "symlink-proof":
        (root / "proofs").rmdir()
        (root / "proofs").symlink_to(root / "observation-sources", target_is_directory=True)
    elif problem in {"unsafe-port", "missing-qdrant"}:
        result = {"qdrant": "0.0.0.0:53123"} if problem == "unsafe-port" else {}
        monkeypatch.setattr(observer.runtime_inspection, "inspect_topology", lambda *_: result)
    monkeypatch.setattr(observer, "_query_qdrant", lambda **_: pytest.fail("unexpected query"))
    with pytest.raises(Blocked):
        observe(run)
    assert not list((root / "observation-sources").iterdir())


@pytest.mark.parametrize("count", [0, -1, True, "3"])
def test_no_receipt_for_nonpositive_or_invalid_count(isolated_run, monkeypatch, count):
    monkeypatch.setattr(observer, "_query_qdrant", lambda **_: (count, "a" * 64))
    with pytest.raises(Blocked):
        observe(isolated_run)
    assert not list((isolated_run["root"] / "proofs").iterdir())
    assert not list((isolated_run["root"] / "observation-sources").iterdir())


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self.body = body

    def read(self, size):
        return self.body[:size]


class FakeConnection:
    def __init__(self, response):
        self.response = response
        self.connected = False
        self.closed = False
        self.request_args = None

    def connect(self):
        self.connected = True

    def request(self, method, path, body, headers):
        assert self.connected
        self.request_args = method, path, json.loads(body), headers

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


def query(run):
    return observer._query_qdrant(
        port=53123, root=run["root"], api_key="offline_unit_credential_only",
        generation=run["generation"], collection=run["collection"],
        meeting_id=run["meeting_id"], source_id=run["source_id"], revision=run["revision"],
        request_id=str(uuid4()),
    )


def test_real_http_query_is_source_scoped_and_requests_exact_count(isolated_run, monkeypatch):
    connection = FakeConnection(FakeResponse(200, b'{"result":{"count":3},"status":"ok","time":0.01}'))
    monkeypatch.setattr(observer, "_qdrant_tls", lambda _: (object(), b"unit-leaf"))
    monkeypatch.setattr(observer, "_PinnedQdrantConnection", lambda *a: connection)
    count, leaf = query(isolated_run)
    assert (count, leaf) == (3, hashlib.sha256(b"unit-leaf").hexdigest())
    method, path, body, headers = connection.request_args
    assert method == "POST"
    assert path == f"/collections/{isolated_run['collection']}/points/count"
    assert body == {
        "exact": True,
        "filter": {"must": [
            {"key": "meeting_id", "match": {"value": isolated_run["meeting_id"]}},
            {"key": "source_type", "match": {"value": "TRANSCRIPT"}},
            {"key": "canonical_source_id", "match": {"value": isolated_run["source_id"]}},
            {"key": "canonical_source_revision", "match": {"value": 4}},
            {"key": "index_generation_id", "match": {"value": isolated_run["generation"]}},
        ]},
    }
    assert headers["api-key"] == "offline_unit_credential_only"
    assert headers["X-Request-Id"]
    assert connection.closed


@pytest.mark.parametrize(("status", "body"), [
    (401, b'{"result":{"count":1},"status":"ok"}'),
    (200, b"not-json"),
    (200, b'{"result":{"count":0},"status":"ok"}'),
    (200, b'{"result":{"count":true},"status":"ok"}'),
    (200, b'{"result":{"count":1},"status":"error"}'),
    (200, b'{"result":{"count":1,"payload":"unwanted"},"status":"ok"}'),
    (200, b'{"result":{"count":1},"result":{"count":2},"status":"ok"}'),
    (200, b"x" * 65537),
])
def test_rejects_bad_or_ambiguous_responses(isolated_run, monkeypatch, status, body):
    connection = FakeConnection(FakeResponse(status, body))
    monkeypatch.setattr(observer, "_qdrant_tls", lambda _: (object(), b"unit-leaf"))
    monkeypatch.setattr(observer, "_PinnedQdrantConnection", lambda *a: connection)
    with pytest.raises(Blocked):
        query(isolated_run)
    assert connection.closed


class FakeSocket:
    def __init__(self, certificate):
        self.certificate = certificate
        self.sent = bytearray()
        self.closed = False

    def getpeercert(self, binary_form=False):
        assert binary_form
        return self.certificate

    def sendall(self, data):
        self.sent.extend(data)

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, tls):
        self.tls = tls

    def wrap_socket(self, raw, *, server_hostname):
        assert server_hostname == "localhost"
        return self.tls


@pytest.mark.parametrize("matches", [False, True])
def test_pins_peer_before_transmitting_credential(monkeypatch, matches):
    tls = FakeSocket(b"run-owned-leaf" if matches else b"foreign-leaf")
    raw = FakeSocket(None)
    endpoints = []

    def connect(endpoint, timeout):
        endpoints.append(endpoint)
        return raw

    monkeypatch.setattr(observer.socket, "create_connection", connect)
    conn = observer._PinnedQdrantConnection(53123, FakeContext(tls), b"run-owned-leaf")
    if matches:
        conn.request("POST", "/collections/unit/points/count", body="{}", headers={"api-key": "unit-key"})
        assert b"unit-key" in tls.sent
    else:
        with pytest.raises(Blocked):
            conn.request("POST", "/collections/unit/points/count", body="{}", headers={"api-key": "unit-key"})
        assert not tls.sent
        assert tls.closed
    assert endpoints == [("127.0.0.1", 53123)]
    conn.close()


def test_existing_source_file_is_never_overwritten(tmp_path):
    directory = tmp_path / "sources"
    directory.mkdir(mode=0o700)
    path = directory / "name.json"
    path.write_bytes(b"original")
    path.chmod(0o600)
    with pytest.raises(Blocked):
        observer._write_once(directory, "name.json", b"replacement")
    assert path.read_bytes() == b"original"
