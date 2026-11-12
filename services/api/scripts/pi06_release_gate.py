#!/usr/bin/env python3
"""PI-06 release-admission verifier; never deploys or modifies application data."""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path
from uuid import UUID

from pi05_collect_evidence import LIVE_SCENARIOS, SCENARIOS

ROOT = Path(__file__).resolve().parents[3]
AI_TESTS = ROOT / "services" / "ai" / "tests"
if str(AI_TESTS) not in sys.path:
    sys.path.insert(0, str(AI_TESTS))
from pi05_live_contract import REQUIRED, validate_live_evidence, verify_proof_files  # noqa: E402

LIVE_MAPPING = dict(zip(LIVE_SCENARIOS, REQUIRED, strict=True))
REQUIRED_TRUE = frozenset({
    "APP_TRANSPORT_PRIVATE_ENABLED", "APP_MONITORING_PRIVATE_ENABLED",
    "APP_TRANSPORT_AI_ENABLED", "APP_MEDIA_OUTBOX_ENABLED",
    "APP_WORKER_TRANSCRIPTION_ENABLED", "APP_WORKER_TRANSCRIPTION_INFRASTRUCTURE_VERIFIED",
    "APP_MEDIA_INTELLIGENCE_ENABLED", "APP_MEDIA_INTELLIGENCE_DISPATCH_ENABLED",
    "APP_MEDIA_INTELLIGENCE_INFRASTRUCTURE_VERIFIED", "APP_MI_INTERNAL_RESULT_ENABLED",
    "APP_MEDIA_KNOWLEDGE_INDEXING_ENABLED", "APP_EXPORTS_PUBLIC_ADMISSION_ENABLED",
    "APP_EXPORTS_WORKER_ENABLED",
})
REQUIRED_FALSE = frozenset({
    "APP_EXPORTS_RECONCILIATION_PURGE_ENABLED", "APP_MI_ORPHAN_CLEANUP_ENABLED",
})
PINNED = frozenset({
    "APP_MEDIA_KNOWLEDGE_INDEXING_GENERATION_ID",
    "APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_VERSION",
    "APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_SHA256",
    "APP_MEDIA_KNOWLEDGE_INDEXING_TOKENIZER_ID",
})
TRANSPORT_CHECKS = frozenset({
    "corePrivateMtls", "aiPrivateMtls", "rabbitMqTls",
    "objectStorageTls", "qdrantAuthenticated", "monitoringIdentity",
    "brokerDlqObserved",
})
ALERT_METRICS = frozenset({
    "product.integration.outbox.oldest.age.seconds",
    "product.integration.processing.oldest.age.seconds",
    "product.integration.assistant.expired.turns",
    "product.integration.knowledge.oldest.age.seconds",
    "product.integration.knowledge.terminal",
    "product.integration.reconciliation.open.findings",
    "product.integration.notification.failed",
    "product.integration.exports.oldest.age.seconds",
    "product.integration.metrics.aggregation.healthy",
})


def read_json(path: Path | None) -> object:
    if path is None or not path.is_file() or path.is_symlink() or path.stat().st_size > 1_000_000:
        raise ValueError("Evidence absent, symbolic or oversized")
    return json.loads(path.read_text(encoding="utf-8"))


def check_config(path: Path | None) -> list[str]:
    try:
        if path is None or not path.is_file() or path.is_symlink() or path.stat().st_size > 64000:
            raise ValueError("No external effective configuration snapshot")
        cfg = {}
        for raw in path.read_text(encoding="utf-8").splitlines():
            raw = raw.strip()
            if not raw or raw.startswith("#"):
                continue
            if not re.fullmatch(r"[A-Z][A-Z0-9_]*=[^#\r\n]*", raw):
                raise ValueError("Only literal KEY=VALUE is supported; shell evaluation prohibited")
            k, v = raw.split("=", 1)
            if k in cfg or k not in REQUIRED_TRUE | REQUIRED_FALSE | PINNED:
                raise ValueError("Duplicate or non-allowlisted configuration key")
            cfg[k] = v.strip()
        issues = ["CONFIG_REQUIRED_ON:" + k for k in sorted(REQUIRED_TRUE) if cfg.get(k) != "true"]
        issues += ["CONFIG_REQUIRED_OFF:" + k for k in sorted(REQUIRED_FALSE) if cfg.get(k) != "false"]
        issues += ["CONFIG_UNPINNED:" + k for k in sorted(PINNED)
                   if not cfg.get(k) or "$" + "{" in cfg[k]]
        if not re.fullmatch(r"[a-f0-9]{64}", cfg.get("APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_SHA256", "")):
            issues.append("CONFIG_MODEL_DIGEST_INVALID")
        return issues
    except (OSError, ValueError, UnicodeError):
        return ["CONFIG_INVALID_OR_MISSING"]


def check_ci(path: Path | None, sha: str) -> list[str]:
    try:
        e = read_json(path)
        if not isinstance(e, dict) or e.get("schemaVersion") != "1.0" or e.get("sourceCommit") != sha:
            raise ValueError("CI report mismatch")
        s = e.get("suite")
        if not isinstance(s, dict) or s.get("allPassed") is not True or s.get("invalidTestcases") != 0:
            raise ValueError("CI suite not clean")
        if not isinstance(s.get("observedTestcases"), int) or s["observedTestcases"] < len(SCENARIOS):
            raise ValueError("No executed test evidence")
        if not e.get("githubRunId"):
            raise ValueError("No CI provenance")
        matrix = e.get("deterministic")
        if not isinstance(matrix, dict) or set(matrix) != set(SCENARIOS):
            raise ValueError("Scenario matrix incomplete")
        for name, tests in SCENARIOS.items():
            scenario = matrix[name]
            if scenario.get("status") != "PASS" or scenario.get("kind") != "DETERMINISTIC_POSTGRES":
                raise ValueError("Scenario not passed")
            if set(scenario.get("testcases", {})) != set(tests) or any(
                value != "PASS" for value in scenario["testcases"].values()
            ):
                raise ValueError("Missing individual testcase evidence")
        return []
    except (ValueError, TypeError, OSError, AttributeError, KeyError):
        return ["CI_EVIDENCE_INVALID_OR_MISSING"]


def check_live(directory: Path | None, proofs: Path | None, run_id: str,
               sha: str, generation: str, collection: str) -> list[str]:
    if directory is None or not directory.is_dir() or directory.is_symlink():
        return ["LIVE_RECEIPTS_MISSING"]
    problems = []
    for code, scenario in LIVE_MAPPING.items():
        try:
            report = read_json(directory / f"{run_id}-{scenario}.json")
            validate_live_evidence(scenario, report, run_id=run_id, commit=sha,
                                   generation=generation, collection=collection)
            if proofs is None:
                raise ValueError("No independent observer receipts")
            verify_proof_files(report, proofs)
        except (ValueError, OSError, TypeError, KeyError):
            problems.append("LIVE_NOT_VERIFIED:" + code)
    return problems


def check_transport(path: Path | None, sha: str, run_id: str) -> list[str]:
    try:
        e = read_json(path)
        if not isinstance(e, dict) or set(e) != {
            "schemaVersion", "sourceCommit", "runId", "recordedAt", "checks",
        } or (e["schemaVersion"], e["sourceCommit"], e["runId"]) != ("1.0", sha, run_id):
            raise ValueError("Transport evidence identity mismatch")
        at = datetime.fromisoformat(e["recordedAt"].replace("Z", "+00:00"))
        if at.utcoffset() is None or not isinstance(e["checks"], dict):
            raise ValueError("Unattributed transport evidence")
        if set(e["checks"]) != TRANSPORT_CHECKS or any(x != "PASS" for x in e["checks"].values()):
            raise ValueError("Incomplete transport checks")
        return []
    except (ValueError, KeyError, TypeError, OSError, AttributeError):
        return ["TRANSPORT_EVIDENCE_INVALID_OR_MISSING"]


def check_alerts(path: Path | None, sha: str) -> list[str]:
    try:
        e = read_json(path)
        if not isinstance(e, dict) or set(e) != {"schemaVersion", "sourceCommit", "alerts"}:
            raise ValueError("Alert evidence malformed")
        if (e["schemaVersion"], e["sourceCommit"]) != ("1.0", sha):
            raise ValueError("Alert policy wrong revision")
        alerts = e["alerts"]
        if not isinstance(alerts, list) or len(alerts) != len(ALERT_METRICS):
            raise ValueError("Incomplete alert policy")
        seen = set()
        for item in alerts:
            if not isinstance(item, dict) or set(item) != {
                "metric", "comparison", "threshold", "forSeconds", "owner", "runbook",
            }:
                raise ValueError("Invalid alert configuration")
            metric = item["metric"]
            if metric not in ALERT_METRICS or metric in seen:
                raise ValueError("Unbounded or duplicate alert metric")
            seen.add(metric)
            expected_comparison = "lt" if metric.endswith(".aggregation.healthy") else "gt"
            if item["comparison"] != expected_comparison:
                raise ValueError("Alert comparator would suppress a failure")
            if (type(item["threshold"]) not in (int, float)
                    or not math.isfinite(item["threshold"]) or item["threshold"] < 0):
                raise ValueError("Alert threshold invalid")
            if type(item["forSeconds"]) is not int or item["forSeconds"] <= 0:
                raise ValueError("Alert evaluation window invalid")
            if any(not isinstance(item[k], str) or len(item[k].strip()) < 3
                   for k in ("owner", "runbook")):
                raise ValueError("Unowned alert")
        return []
    except (ValueError, OSError, TypeError, KeyError, AttributeError):
        return ["ALERT_POLICY_INVALID_OR_MISSING"]


def inspect(sha: str, run_id: str, generation: str, collection: str,
            config: Path | None = None, ci: Path | None = None,
            live: Path | None = None, proofs: Path | None = None,
            transport: Path | None = None, alerts: Path | None = None) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Exact commit SHA required")
    try:
        if str(UUID(run_id)) != run_id:
            raise ValueError()
    except ValueError as error:
        raise ValueError("Canonical run UUID required") from error
    if any(not value or "/" in value or ".." in value for value in (generation, collection)):
        raise ValueError("Invalid source generation or collection")
    sections = {
        "configuration": check_config(config),
        "deterministic": check_ci(ci, sha),
        "live": check_live(live, proofs, run_id, sha, generation, collection),
        "transport": check_transport(transport, sha, run_id),
        "alerts": check_alerts(alerts, sha),
    }
    blockers = sorted(problem for problems in sections.values() for problem in problems)
    return {"schemaVersion": "1.0", "task": "PI-06",
            "sourceCommit": sha, "runId": run_id, "vectorGeneration": generation,
            "releaseDecision": "BLOCKED" if blockers else "READY_FOR_OPERATOR_APPROVAL",
            "checks": {name: "PASS" if not issues else "BLOCKED"
                       for name, issues in sections.items()}, "blockers": blockers}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("sha", "run-id", "generation", "collection"):
        parser.add_argument("--" + arg, required=True)
    for arg in ("config", "ci", "live", "proofs", "transport", "alerts", "output"):
        parser.add_argument("--" + arg, type=Path, required=arg == "output")
    args = parser.parse_args()
    report = inspect(args.sha, args.run_id, args.generation, args.collection,
                     args.config, args.ci, args.live, args.proofs, args.transport, args.alerts)
    if args.output.exists() or args.output.is_symlink():
        parser.error("Never overwrite a prior release decision")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(report["releaseDecision"])
    for reason in report["blockers"]:
        print("BLOCKED:" + reason)
    return 0 if report["releaseDecision"] == "READY_FOR_OPERATOR_APPROVAL" else 1


if __name__ == "__main__":
    raise SystemExit(main())
