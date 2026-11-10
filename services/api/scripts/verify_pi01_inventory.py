#!/usr/bin/env python3
"""Validate PI-01 inventory structure and evidence provenance without third-party dependencies.

This static gate DOES NOT verify runtime integration or mark live scenarios PASS.
"""
from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[3]
INVENTORY = Path("services/api/docs/PI01-INVENTORY.json")
REPORT = Path("services/api/docs/PI01-INTEGRATION-AUDIT.md")
REQUIREMENTS = {
    "AI": "requirement-docs/RE01-AI.md",
    "API": "requirement-docs/RE02-API.md",
    "ARCH": "requirement-docs/RE03-ARCHITECTURE.md",
    "BR": "requirement-docs/RE04-BUSINESS_RULES.md",
    "DB": "requirement-docs/RE05-DATABASE.md",
    "FEAT": "requirement-docs/RE06-FEATURES.md",
    "PRD": "requirement-docs/RE07-PRODUCT.md",
    "SEC": "requirement-docs/RE08-SECURITY.md",
}
REQUIRED = {
    "AUTH", "USER_ORG", "MEETING", "ROOM_SCHEDULING",
    "MEDIA_PROCESSING", "TRANSCRIPT_REVIEW", "SPEAKER_DIARIZATION",
    "MEETING_INTELLIGENCE", "ACTION_ITEMS", "NOTIFICATIONS",
    "KNOWLEDGE_RAG", "ASSISTANT", "DASHBOARD", "EXPORT", "INFRA_OPERATIONS",
}
IMPLEMENTATION = {"PRESENT", "PARTIAL", "MISSING"}
INTEGRATION = {"LINKED", "NOT_LINKED", "UNVERIFIED"}
VERIFICATION = {"UNVERIFIED", "REPORTED_DETERMINISTIC", "VERIFIED_LIVE"}
SEVERITY = {"CRITICAL", "HIGH", "MEDIUM", "LOW"}
FINDING_STATE = {"OPEN", "RESOLVED_IN_PI01"}


class AuditError(ValueError):
    """Audit cannot be trusted until the reference or state is corrected."""


def _record(errors: list[str], ok: bool, message: str) -> None:
    if not ok:
        errors.append(message)


def _path(root: Path, raw: str, errors: list[str], label: str) -> Path | None:
    if not isinstance(raw, str) or not raw or "\\" in raw:
        errors.append(f"{label}: expected non-empty POSIX repository path")
        return None
    parts = PurePosixPath(raw)
    if parts.is_absolute() or ".." in parts.parts or "." in parts.parts:
        errors.append(f"{label}: unsafe repository path {raw!r}")
        return None
    path = root.joinpath(*parts.parts)
    if not path.resolve().is_relative_to(root.resolve()):
        errors.append(f"{label}: path escapes repository {raw!r}")
        return None
    return path


def validate_inventory(root: Path, inventory: dict) -> None:
    """Validate all errors in one batch; do not silently ignore bad evidence."""
    errors: list[str] = []
    _record(errors, inventory.get("schema_version") == 1, "schema_version must be 1")
    _record(errors, inventory.get("audit_id") == "PI-01", "audit_id must be PI-01")
    _record(errors, inventory.get("snapshot_branch") == "api/module-product-integration",
            "wrong audit branch")
    _record(errors, bool(re.fullmatch(r"[a-f0-9]{40}", str(inventory.get("snapshot_commit", "")))),
            "snapshot_commit must be a full SHA")
    capabilities = inventory.get("capabilities")
    findings = inventory.get("findings")
    if not isinstance(capabilities, list) or not isinstance(findings, list):
        raise AuditError("capabilities and findings must be arrays")

    ids = [v.get("id") for v in capabilities if isinstance(v, dict)]
    fids = [v.get("id") for v in findings if isinstance(v, dict)]
    _record(errors, len(ids) == len(set(ids)), "duplicate capability ID")
    _record(errors, len(fids) == len(set(fids)), "duplicate finding ID")
    _record(errors, REQUIRED.issubset(set(ids)), f"missing required capabilities: {sorted(REQUIRED - set(ids))}")
    _record(errors, len(ids) == len(capabilities), "capability must be object")
    _record(errors, len(fids) == len(findings), "finding must be object")

    report_file = _path(root, REPORT.as_posix(), errors, "report")
    report = report_file.read_text(encoding="utf-8") if report_file and report_file.is_file() else ""
    _record(errors, bool(report), "PI-01 narrative report missing or empty")
    req_cache: dict[str, str] = {}
    for doc_path in REQUIREMENTS.values():
        file = _path(root, doc_path, errors, "canonical requirement")
        req_cache[doc_path] = file.read_text(encoding="utf-8") if file and file.is_file() else ""
        _record(errors, bool(req_cache[doc_path]), f"canonical requirement missing: {doc_path}")

    for i, finding in enumerate(findings):
        if not isinstance(finding, dict):
            continue
        fid = finding.get("id")
        _record(errors, bool(re.fullmatch(r"G-[0-9]{3}", str(fid))), f"finding[{i}] invalid id")
        _record(errors, finding.get("severity") in SEVERITY, f"{fid} invalid severity")
        _record(errors, finding.get("state") in FINDING_STATE, f"{fid} invalid state")
        _record(errors, bool(str(finding.get("owner", "")).strip()), f"{fid} missing owner")
        _record(errors, len(str(finding.get("summary", "")).strip()) >= 30, f"{fid} missing description")
        _record(errors, str(fid) in report, f"{fid} missing from narrative report")

    all_used: set[str] = set()
    for i, cap in enumerate(capabilities):
        if not isinstance(cap, dict):
            continue
        cid = cap.get("id")
        _record(errors, bool(re.fullmatch(r"[A-Z][A-Z0-9_]+", str(cid))), f"capability[{i}] invalid id")
        _record(errors, cap.get("implementation") in IMPLEMENTATION, f"{cid} invalid implementation")
        _record(errors, cap.get("integration") in INTEGRATION, f"{cid} invalid integration")
        _record(errors, cap.get("verification") in VERIFICATION, f"{cid} invalid verification")
        _record(errors, bool(str(cap.get("owner", "")).strip()), f"{cid} missing owner")
        _record(errors, str(cid) in report, f"{cid} missing from narrative report")
        if cap.get("verification") == "VERIFIED_LIVE":
            url = cap.get("live_run_url")
            _record(errors, isinstance(url, str) and url.startswith("https://github.com/"),
                    f"{cid}: VERIFIED_LIVE needs a real GitHub run URL")
        for field in ("requirement_ids", "evidence_paths", "finding_ids"):
            _record(errors, isinstance(cap.get(field), list) and bool(cap[field]), f"{cid} missing {field}")
        for req_id in cap.get("requirement_ids", []):
            if not isinstance(req_id, str):
                errors.append(f"{cid}: invalid requirement ID type")
                continue
            prefix = req_id.split("-", 1)[0]
            owner = REQUIREMENTS.get(prefix)
            _record(errors, owner is not None, f"{cid}: unknown requirement owner for {req_id}")
            if owner:
                _record(errors, req_id in req_cache[owner], f"{cid}: missing canonical requirement {req_id}")
        for raw in cap.get("evidence_paths", []):
            file = _path(root, raw, errors, str(cid))
            _record(errors, file is not None and file.exists(), f"{cid}: missing evidence path {raw}")
        for fid in cap.get("finding_ids", []):
            _record(errors, fid in fids, f"{cid}: references missing finding {fid}")
            all_used.add(str(fid))
    # A resolved repository-level CI/plan finding need not belong to a runtime capability.
    # Every OPEN finding still requires a linked capability and explicit owner.
    unlinked_open = {f["id"] for f in findings if isinstance(f, dict)
                     and f.get("state") == "OPEN" and f.get("id") not in all_used}
    _record(errors, not unlinked_open, f"unlinked OPEN findings: {sorted(unlinked_open)}")

    for i, assertion in enumerate(inventory.get("source_assertions", [])):
        raw = assertion.get("path", "")
        file = _path(root, raw, errors, f"assertion[{i}]")
        if not file or not file.is_file():
            errors.append(f"assertion[{i}] missing source {raw}")
            continue
        content = file.read_text(encoding="utf-8")
        for token in assertion.get("contains", []):
            _record(errors, token in content, f"assertion[{i}] missing source contract token {token!r}")

    for raw in inventory.get("missing_paths", []):
        file = _path(root, raw, errors, "missing_paths")
        _record(errors, file is not None and not file.exists(),
                f"old gap was resolved, update PI-01 inventory: {raw}")

    if errors:
        raise AuditError("PI-01 inventory integrity failed:\n - " + "\n - ".join(errors))


def main() -> int:
    root = ROOT
    with (root / INVENTORY).open(encoding="utf-8") as source:
        inventory = json.load(source)
    try:
        validate_inventory(root, inventory)
    except AuditError as exc:
        print(exc)
        return 1
    print(f"PI-01 integrity PASS: {len(inventory['capabilities'])} capabilities, "
          f"{len(inventory['findings'])} tracked findings; runtime acceptance NOT evaluated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
