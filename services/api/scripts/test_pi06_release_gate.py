"""PI-06 negative tests: build success or a simple enabled=true cannot imply release."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4
from datetime import UTC, datetime
from hashlib import sha256

from pi05_collect_evidence import SCENARIOS
from pi05_live_contract import REQUIRED

from pi06_release_gate import (
    ALERT_METRICS,
    PINNED,
    REQUIRED_FALSE,
    REQUIRED_TRUE,
    check_alerts,
    check_ci,
    check_config,
    check_live,
    check_transport,
    inspect,
)

SHA = "a" * 40
RUN = str(uuid4())


class OperationalGateTests(unittest.TestCase):
    def test_complete_synthetic_contract_is_readable_but_not_live_proof(self):
        # UNIT-ONLY synthetic happy path: verifies the gate is not permanently
        # impossible to satisfy. It MUST NOT be exported as a real acceptance
        # receipt or used to claim infrastructure is working.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            generation, collection = "rag-unit-test", "qdrant-unit-test"
            cfg = {k: "true" for k in REQUIRED_TRUE}
            cfg.update({k: "false" for k in REQUIRED_FALSE})
            cfg.update({k: "approved-v1" for k in PINNED})
            cfg["APP_MEDIA_KNOWLEDGE_INDEXING_GENERATION_ID"] = generation
            cfg["APP_MEDIA_KNOWLEDGE_INDEXING_COLLECTION_NAME"] = collection
            cfg["APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_SHA256"] = "b" * 64
            config_path = root / "config"
            config_path.write_text("\n".join(f"{k}={v}" for k, v in cfg.items()))
            ci_path = root / "ci.json"
            cases = {key: {
                "status": "PASS", "kind": "DETERMINISTIC_POSTGRES",
                "testcases": {test: "PASS" for test in tests},
            } for key, tests in SCENARIOS.items()}
            ci_path.write_text(json.dumps({
                "schemaVersion": "1.0", "sourceCommit": SHA, "githubRunId": "12345",
                "suite": {"allPassed": True, "invalidTestcases": 0,
                          "observedTestcases": sum(len(tests) for tests in SCENARIOS.values())},
                "deterministic": cases,
            }))
            live_path, proof_path = root / "live", root / "proofs"
            live_path.mkdir()
            proof_path.mkdir()
            for scenario, steps in REQUIRED.items():
                observations = []
                for step, (component, result) in steps.items():
                    observation = {
                        "step": step, "component": component, "observedResult": result,
                        "runId": RUN, "requestId": str(uuid4()),
                        "observedAt": datetime.now(UTC).isoformat(),
                    }
                    data = json.dumps(observation, sort_keys=True, separators=(",", ":")).encode()
                    digest = sha256(data).hexdigest()
                    (proof_path / f"{digest}.json").write_bytes(data)
                    observations.append({**observation, "proofSha256": digest})
                payload = {
                    "contractVersion": "1.0", "scenario": scenario, "status": "PASS",
                    "runId": RUN, "sourceCommit": SHA,
                    "environment": {
                        "disposable": True, "environmentId": "unit-fixture",
                        "coreBuild": SHA, "aiBuild": SHA, "flywayVersion": "V51",
                        "tlsMode": "MTLS", "generationId": generation,
                        "collectionName": collection,
                    },
                    "observations": observations,
                }
                (live_path / f"{RUN}-{scenario}.json").write_text(json.dumps(payload))
            transport_path = root / "transport.json"
            from pi06_release_gate import TRANSPORT_CHECKS
            transport_path.write_text(json.dumps({
                "schemaVersion": "1.0", "sourceCommit": SHA, "runId": RUN,
                "recordedAt": datetime.now(UTC).isoformat(),
                "checks": {check: "PASS" for check in TRANSPORT_CHECKS},
            }))
            alerts_path = root / "alerts.json"
            alerts_path.write_text(json.dumps({
                "schemaVersion": "1.0", "sourceCommit": SHA,
                "alerts": [{
                    "metric": metric,
                    "comparison": "lt" if metric.endswith("_aggregation_healthy") else "gt",
                    "threshold": 1, "forSeconds": 60,
                    "owner": "unit-oncall", "runbook": "PI06-OPERATIONS",
                } for metric in ALERT_METRICS],
            }))
            kwargs = dict(config=config_path, ci=ci_path, live=live_path,
                          proofs=proof_path, transport=transport_path, alerts=alerts_path)
            report = inspect(SHA, RUN, generation, collection, **kwargs)
            self.assertEqual(report["releaseDecision"], "READY_FOR_OPERATOR_APPROVAL")
            self.assertEqual(report["blockers"], [])
            wrong = inspect(SHA, RUN, generation + "-other", collection, **kwargs)
            self.assertEqual(wrong["releaseDecision"], "BLOCKED")
            self.assertIn("CONFIG_GENERATION_MISMATCH", wrong["blockers"])

    def test_absent_release_evidence_is_blocked_even_with_green_ci(self):
        report = inspect(SHA, RUN, "approved-gen", "isolated-vectors")
        self.assertEqual(report["releaseDecision"], "BLOCKED")
        self.assertEqual(set(report["checks"].values()), {"BLOCKED"})
        self.assertGreaterEqual(len(report["blockers"]), 5)

    def test_private_mtls_missing_blocks_integration_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"
            cfg = {key: "true" for key in REQUIRED_TRUE}
            cfg.update({key: "false" for key in REQUIRED_FALSE})
            cfg.update({key: "approved-value" for key in PINNED})
            cfg["APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_SHA256"] = "b" * 64
            cfg["APP_TRANSPORT_PRIVATE_ENABLED"] = "false"
            path.write_text("\n".join(f"{k}={v}" for k, v in cfg.items()))
            self.assertIn("CONFIG_REQUIRED_ON:APP_TRANSPORT_PRIVATE_ENABLED", check_config(path))
            cfg["APP_TRANSPORT_PRIVATE_ENABLED"] = "true"
            path.write_text("\n".join(f"{k}={v}" for k, v in cfg.items()))
            self.assertEqual(check_config(path), [])

    def test_release_generation_collection_and_assistant_must_match_actual_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "effective-flags"
            cfg = {key: "true" for key in REQUIRED_TRUE}
            cfg.update({key: "false" for key in REQUIRED_FALSE})
            cfg.update({key: "approved-v1" for key in PINNED})
            cfg["APP_MEDIA_KNOWLEDGE_INDEXING_GENERATION_ID"] = "rag-generation-verified"
            cfg["APP_MEDIA_KNOWLEDGE_INDEXING_COLLECTION_NAME"] = "qdrant-verified"
            cfg["APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_SHA256"] = "b" * 64
            path.write_text("\n".join(f"{key}={value}" for key, value in cfg.items()))
            self.assertEqual(
                check_config(path, "rag-generation-verified", "qdrant-verified"), []
            )
            self.assertIn("CONFIG_GENERATION_MISMATCH",
                          check_config(path, "wrong-generation", "qdrant-verified"))
            self.assertIn("CONFIG_COLLECTION_MISMATCH",
                          check_config(path, "rag-generation-verified", "wrong-collection"))
            cfg["APP_ASSISTANT_ENABLED"] = "false"
            path.write_text("\n".join(f"{key}={value}" for key, value in cfg.items()))
            self.assertIn("CONFIG_REQUIRED_ON:APP_ASSISTANT_ENABLED",
                          check_config(path, "rag-generation-verified", "qdrant-verified"))

    def test_pinned_config_rejects_shell_substitution_and_placeholders(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "effective-flags"
            cfg = {key: "true" for key in REQUIRED_TRUE}
            cfg.update({key: "false" for key in REQUIRED_FALSE})
            cfg.update({key: "approved-v1" for key in PINNED})
            cfg["APP_MEDIA_KNOWLEDGE_INDEXING_CONFIGURATION_SHA256"] = "b" * 64
            for dangerous in ("$(printenv)", "not-approved", "approved value", "../secret"):
                cfg["APP_MEDIA_KNOWLEDGE_INDEXING_GENERATION_ID"] = dangerous
                path.write_text("\n".join(f"{key}={value}" for key, value in cfg.items()))
                self.assertIn("CONFIG_UNPINNED:APP_MEDIA_KNOWLEDGE_INDEXING_GENERATION_ID",
                              check_config(path))

    def test_repeated_keys_or_shell_content_are_not_interpreted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"
            for content in (
                "APP_MEDIA_OUTBOX_ENABLED=true\nAPP_MEDIA_OUTBOX_ENABLED=false\n",
                "APP_MEDIA_OUTBOX_ENABLED=$(whoami)\n",
                "APP_TRANSPORT_PRIVATE_KEY=secret\n",
            ):
                path.write_text(content)
                self.assertTrue(check_config(path))

    def test_all_green_but_fake_ci_matrix_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ci.json"
            path.write_text(json.dumps({
                "schemaVersion": "1.0", "sourceCommit": SHA, "githubRunId": "1",
                "suite": {"allPassed": True, "invalidTestcases": 0, "observedTestcases": 111},
                "deterministic": {},
            }))
            self.assertTrue(check_ci(path, SHA))

    def test_external_harness_pass_booleans_are_not_live_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for scenario in ("full-pipeline", "qdrant-outage"):
                (root / f"{RUN}-{scenario}.json").write_text(json.dumps({"status": "PASS"}))
            self.assertEqual(
                len(check_live(root, root, RUN, SHA, "approved-gen", "isolated-vectors")), 10
            )

    def test_transport_claim_without_correlation_or_real_checks_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "transport.json"
            path.write_text(json.dumps({"schemaVersion": "1.0", "sourceCommit": SHA,
                                        "runId": "foreign", "checks": {}}))
            self.assertTrue(check_transport(path, SHA, RUN))

    def test_alert_policy_requires_exact_metric_owners_and_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "alerts.json"
            policy = [{"metric": name, "comparison": "lt" if name.endswith("_aggregation_healthy") else "gt",
                       "threshold": 1, "forSeconds": 60,
                       "owner": "oncall-team", "runbook": "PI06-OPERATIONS"}
                      for name in sorted(ALERT_METRICS)]
            path.write_text(json.dumps({"schemaVersion": "1.0",
                                        "sourceCommit": SHA, "alerts": policy}))
            self.assertEqual(check_alerts(path, SHA), [])
            policy.pop()
            path.write_text(json.dumps({"schemaVersion": "1.0",
                                        "sourceCommit": SHA, "alerts": policy}))
            self.assertTrue(check_alerts(path, SHA))

    def test_alert_policy_rejects_wrong_comparison_and_nonfinite_threshold(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"alerts.json"
            policy=[{"metric":name,
                     "comparison":"lt" if name.endswith(".aggregation.healthy") else "gt",
                     "threshold":1, "forSeconds":60, "owner":"ops-oncall",
                     "runbook":"PI06-OPERATIONS"} for name in sorted(ALERT_METRICS)]
            policy[0]["comparison"] = "ne"
            path.write_text(json.dumps({"schemaVersion":"1.0","sourceCommit":SHA,"alerts":policy}))
            self.assertTrue(check_alerts(path,SHA))
            policy[0]["comparison"] = ("lt" if policy[0]["metric"].endswith(".aggregation.healthy") else "gt")
            policy[0]["threshold"] = float("nan")
            path.write_text(json.dumps({"schemaVersion":"1.0","sourceCommit":SHA,"alerts":policy}))
            self.assertTrue(check_alerts(path,SHA))


if __name__ == "__main__":
    unittest.main()
