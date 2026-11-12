"""PI-06 negative tests: build success or a simple enabled=true cannot imply release."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

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
            policy = [{"metric": name, "threshold": 1, "forSeconds": 60,
                       "owner": "oncall-team", "runbook": "PI06-OPERATIONS"}
                      for name in sorted(ALERT_METRICS)]
            path.write_text(json.dumps({"schemaVersion": "1.0",
                                        "sourceCommit": SHA, "alerts": policy}))
            self.assertEqual(check_alerts(path, SHA), [])
            policy.pop()
            path.write_text(json.dumps({"schemaVersion": "1.0",
                                        "sourceCommit": SHA, "alerts": policy}))
            self.assertTrue(check_alerts(path, SHA))


if __name__ == "__main__":
    unittest.main()
