#!/usr/bin/env python3
"""Independently observe one L01 Qdrant boundary, not an entire PI-05 scenario.

Only an exact filtered count is read. No vector payloads, prompts, source content,
or credentials are written. This tool does not provision or modify any service.
The source record is an audit aid, not cryptographic proof of observer honesty.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import http.client
import json
import os
import re
import socket
import ssl
import stat
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import runtime_inspection
from preflight import ENV_KEYS, Blocked, _directory, _file, _read_env, _run_id

RUNS_BASE = Path.home() / ".local/share/sme-pi05/runs"
MAX_RESPONSE_BYTES = 65536


def _canonical_uuid(value: str) -> str:
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError
    except (ValueError, TypeError, AttributeError) as error:
        raise Blocked("A canonical source UUID is required") from error
    return value


def _scoped_name(value: str, run_id: str) -> str:
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is None
        or not any(token in value.lower() for token in (run_id, run_id.replace("-", "")))
    ):
        raise Blocked("Generation and collection must be scoped to this run UUID")
    return value


def _qdrant_tls(root: Path) -> tuple[ssl.SSLContext, bytes]:
    directory = root / "pki" / "qdrant-server"
    _directory(directory)
    certificate = directory / "tls.crt"
    key = directory / "tls.key"
    issuer = directory / "issuer-ca.crt"
    _file(certificate)
    _file(key, private=True)
    _file(issuer)
    try:
        pem = certificate.read_text(encoding="ascii")
        match = re.search(
            r"-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----",
            pem,
        )
        if not match:
            raise ValueError("missing leaf")
        leaf = ssl.PEM_cert_to_DER_cert(match.group())
        decoded = ssl._ssl._test_decode_cert(str(certificate))
        sans = tuple(decoded.get("subjectAltName", ()))
        if set(sans) != {
            ("DNS", "localhost"),
            ("IP Address", "127.0.0.1"),
        } or len(sans) != 2:
            raise ValueError("Qdrant server SAN contract is invalid")
        subprocess.run(
            ["openssl", "x509", "-in", str(certificate), "-checkend", "60", "-noout"],
            check=True,
            capture_output=True,
        )
        eku = subprocess.run(
            ["openssl", "x509", "-in", str(certificate), "-noout", "-ext", "extendedKeyUsage"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        eku_values = [
            item.strip()
            for item in eku.split(":", 1)[-1].split(",")
            if item.strip()
        ]
        if eku_values != ["TLS Web Server Authentication"]:
            raise ValueError("Qdrant server EKU contract is invalid")
        certificate_key = subprocess.run(
            ["openssl", "x509", "-in", str(certificate), "-pubkey", "-noout"],
            check=True,
            capture_output=True,
        ).stdout
        private_key = subprocess.run(
            ["openssl", "pkey", "-in", str(key), "-pubout"],
            check=True,
            capture_output=True,
        ).stdout
        if not certificate_key or certificate_key != private_key:
            raise ValueError("Qdrant server certificate and key do not match")
        for identity in ("localhost", "127.0.0.1"):
            identity_option = "-verify_ip" if identity[0].isdigit() else "-verify_hostname"
            subprocess.run(
                [
                    "openssl", "verify", "-no-CApath", "-no-CAstore",
                    "-CAfile", str(issuer), "-purpose", "sslserver",
                    identity_option, identity, str(certificate),
                ],
                check=True,
                capture_output=True,
            )
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_verify_locations(cafile=str(issuer))
    except (OSError, UnicodeError, ValueError, ssl.SSLError, subprocess.SubprocessError) as error:
        raise Blocked("Qdrant TLS identity or trust material is invalid") from error
    return context, leaf


class _PinnedQdrantConnection(http.client.HTTPSConnection):
    """Use loopback, verify hostname/CA, then pin the leaf before HTTP is sent."""

    def __init__(self, port: int, context: ssl.SSLContext, leaf: bytes):
        super().__init__("localhost", port=port, timeout=10, context=context)
        self._expected_leaf = leaf

    def connect(self) -> None:
        raw = socket.create_connection(("127.0.0.1", self.port), self.timeout)
        try:
            wrapped = self._context.wrap_socket(raw, server_hostname="localhost")
        except Exception:
            raw.close()
            raise
        try:
            peer = wrapped.getpeercert(binary_form=True)
            if not isinstance(peer, bytes) or not hmac.compare_digest(peer, self._expected_leaf):
                raise Blocked("Qdrant TLS leaf does not match this isolated run")
        except Exception:
            wrapped.close()
            raise
        self.sock = wrapped


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _query_qdrant(
    *, port: int, root: Path, api_key: str, generation: str, collection: str,
    meeting_id: str, source_id: str, revision: int, request_id: str,
) -> tuple[int, str]:
    context, leaf = _qdrant_tls(root)
    criteria = (
        ("meeting_id", meeting_id),
        ("source_type", "TRANSCRIPT"),
        ("canonical_source_id", source_id),
        ("canonical_source_revision", revision),
        ("index_generation_id", generation),
    )
    body = json.dumps({
        "exact": True,
        "filter": {"must": [{"key": key, "match": {"value": value}} for key, value in criteria]},
    }, separators=(",", ":"))
    connection = _PinnedQdrantConnection(port, context, leaf)
    try:
        # Connect explicitly: a pin mismatch must fail before the API key is sent.
        connection.connect()
        connection.request(
            "POST", f"/collections/{collection}/points/count", body=body,
            headers={"Content-Type": "application/json", "api-key": api_key, "X-Request-Id": request_id},
        )
        response = connection.getresponse()
        if response.status != 200:
            raise Blocked("Qdrant did not authorize and complete the count request")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise Blocked("Qdrant count response exceeds the permitted size")
        document = json.loads(raw, object_pairs_hook=_unique_object)
        if (
            not isinstance(document, dict) or document.get("status") != "ok"
            or not isinstance(document.get("result"), dict)
            or set(document["result"]) != {"count"}
        ):
            raise Blocked("Qdrant count response is invalid")
        count = document["result"]["count"]
        if type(count) is not int or count <= 0:
            raise Blocked("No matching indexed transcript points were observed")
        return count, hashlib.sha256(leaf).hexdigest()
    except (OSError, http.client.HTTPException, ValueError, UnicodeError) as error:
        raise Blocked("Qdrant observation could not be completed safely") from error
    finally:
        connection.close()


def _write_once(directory: Path, name: str, raw: bytes) -> None:
    """Write exclusively through a checked directory descriptor; never replace."""
    try:
        parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(parent)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise Blocked("Observation directory must be private and owner-controlled")
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            with os.fdopen(fd, "wb") as output:
                output.write(raw)
        finally:
            os.close(parent)
    except OSError as error:
        raise Blocked("Observation output already exists or is unavailable") from error


def observe_indexed(
    *, run_id: str, root: Path, generation: str, collection: str,
    meeting_id: str, source_id: str, revision: int, request_id: str | None = None,
) -> str:
    """Query real isolated Qdrant and write one receipt plus its source record."""
    run_id = _run_id(run_id)
    root = Path(os.path.abspath(root))
    if root != RUNS_BASE / run_id:
        raise Blocked("Run root does not match the dedicated UUID directory")
    _directory(root, private=True)
    proof_dir, source_dir = root / "proofs", root / "observation-sources"
    _directory(proof_dir, private=True)
    _directory(source_dir, private=True)
    generation, collection = _scoped_name(generation, run_id), _scoped_name(collection, run_id)
    meeting_id, source_id = _canonical_uuid(meeting_id), _canonical_uuid(source_id)
    if type(revision) is not int or revision < 0:
        raise Blocked("Transcript revision must be a nonnegative integer")

    ports = runtime_inspection.inspect_topology(run_id, root)
    endpoint = ports.get("qdrant") if isinstance(ports, dict) else None
    match = re.fullmatch(r"127\.0\.0\.1:([1-9][0-9]{0,4})", endpoint or "")
    if not match or int(match[1]) > 65535:
        raise Blocked("Qdrant does not have a verified run-owned loopback endpoint")
    port = int(match[1])
    values = _read_env(root / "secrets" / "qdrant.env", ENV_KEYS["qdrant.env"])
    request_id = request_id or str(uuid4())
    try:
        if str(UUID(request_id)) != request_id:
            raise ValueError
    except (ValueError, TypeError, AttributeError) as error:
        raise Blocked("Qdrant observation request ID is invalid") from error
    count, leaf_digest = _query_qdrant(
        port=port, root=root, api_key=values["QDRANT__SERVICE__API_KEY"],
        generation=generation, collection=collection, meeting_id=meeting_id,
        source_id=source_id, revision=revision, request_id=request_id,
    )
    if type(count) is not int or count <= 0 or re.fullmatch(r"[0-9a-f]{64}", leaf_digest or "") is None:
        raise Blocked("Qdrant did not produce a valid indexed-point observation")
    observed_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    receipt = {
        "runId": run_id,
        "requestId": request_id,
        "step": "qdrant-points",
        "component": "QDRANT",
        "observedResult": "INDEXED",
        "observedAt": observed_at,
    }
    raw = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
    digest = hashlib.sha256(raw).hexdigest()
    source = {
        "contractVersion": "pi05-observer-source-v1",
        "proofSha256": digest,
        "runId": run_id,
        "requestId": request_id,
        "observedAt": observed_at,
        "boundary": "QDRANT",
        "operation": "exact-filtered-count",
        "endpoint": endpoint,
        "tlsServerName": "localhost",
        "tlsLeafSha256": leaf_digest,
        "httpStatus": 200,
        "generationId": generation,
        "collectionName": collection,
        "meetingId": meeting_id,
        "sourceType": "TRANSCRIPT",
        "sourceId": source_id,
        "sourceRevision": revision,
        "pointCount": count,
    }
    source_raw = json.dumps(source, sort_keys=True, separators=(",", ":")).encode()
    # Preserve an incomplete source record for review if the later proof write
    # fails; never silently overwrite or delete an earlier observation.
    _write_once(source_dir, digest + ".json", source_raw)
    _write_once(proof_dir, digest + ".json", raw)
    return digest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--generation", required=True)
    parser.add_argument("--collection", required=True)
    parser.add_argument("--meeting-id", required=True)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--revision", required=True, type=int)
    args = parser.parse_args()
    try:
        digest = observe_indexed(
            run_id=args.run_id, root=args.run_root, generation=args.generation,
            collection=args.collection, meeting_id=args.meeting_id,
            source_id=args.source_id, revision=args.revision,
        )
    except Blocked as error:
        print("BLOCKED:", error)
        return 1
    print("PASS: Qdrant indexed-point observation only; receipt SHA-256:", digest)
    print("This does not establish that PI-05 L01 or any live scenario passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
