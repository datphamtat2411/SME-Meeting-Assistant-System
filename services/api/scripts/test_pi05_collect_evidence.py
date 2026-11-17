"""Negative acceptance-evidence tests: PASS cannot be inferred from missing/failed/skipped XML."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, ElementTree

from pi05_collect_evidence import (
    LIVE_SCENARIOS,
    SCENARIOS,
    build_evidence,
    evaluate,
    main as collect_main,
)


PI05_006 = "PI05-006-assistant-idempotency"
EXPECTED_PI05_006 = (
    "AssistantHttpIntegrationTests.successfulSubmissionIsDurableIdempotentAndScopeBound",
    "AssistantHttpIntegrationTests.sourceRevisionChangeBetweenVerificationAndCommitFailsClosed",
    "AssistantAdmissionIntegrationTests.conversationContentionDoesNotCreateGlobalHeadOfLineBlocking",
    "AssistantAdmissionIntegrationTests.sameUserConversationContentionDoesNotCreateGlobalHeadOfLineBlocking",
    "AssistantAdmissionIntegrationTests.competingUsersCannotExceedGlobalActiveCapacity",
    "AssistantAdmissionIntegrationTests.sameMeetingCapacityIsEnforcedBeforeGlobalCapacity",
    "AssistantAdmissionIntegrationTests.completedReplayDoesNotWaitForGlobalAdmissionLock",
    "AssistantAdmissionIntegrationTests.busyRequestDoesNotWaitForGlobalAdmissionLock",
    "AssistantAdmissionIntegrationTests.admissionLockTimeoutReturns503WithoutPartialAdmission",
    "AssistantAdmissionIntegrationTests.tenConcurrentConversationsForOneUserNeverHoldMoreThanTwoTurns",
    "AssistantAdmissionIntegrationTests.independentGuardInstancesSharePostgresCapacityAtTheBoundary",
    "AssistantAdmissionIntegrationTests.askQuotaIsRollingIdempotentAndRejectedRequestDoesNotCreateTurn",
    "AssistantAdmissionIntegrationTests.expiredReclaimReusesTheExistingQuotaEvent",
    "AssistantAdmissionIntegrationTests.staleClaimCannotFinalizeAfterReclaim",
    "AssistantAdmissionIntegrationTests.rolledBackTurnAdmissionLeavesNoDurableWork",
    "AssistantAdmissionIntegrationTests.conversationCreationQuotaIsTransactionalAndUsesCanonical429Contract",
)


class AcceptanceEvidenceTests(unittest.TestCase):
    @staticmethod
    def _write_report(directory: Path, cases: list[tuple[str, str]], filename: str) -> None:
        failures = sum(state == "FAIL" for _, state in cases)
        skipped = sum(state == "BLOCKED" for _, state in cases)
        root = Element(
            "testsuite",
            {
                "name": "synthetic-pi05",
                "tests": str(len(cases)),
                "failures": str(failures),
                "errors": "0",
                "skipped": str(skipped),
            },
        )
        for identity, state in cases:
            classname, method = identity.split(".", 1)
            case = SubElement(
                root,
                "testcase",
                {
                    "classname": f"com.sme.meetingassistant.api.assistant.{classname}",
                    "name": method,
                },
            )
            if state == "FAIL":
                SubElement(case, "failure", {"message": "synthetic failure"})
            elif state == "BLOCKED":
                SubElement(case, "skipped")
        ElementTree(root).write(directory / filename)

    def _pi05_006_cases(self, states: dict[str, str] | None = None) -> list[tuple[str, str]]:
        states = states or {}
        return [(identity, states.get(identity, "PASS")) for identity in EXPECTED_PI05_006]

    def test_pi05_006_matrix_matches_the_complete_contract(self):
        self.assertEqual(set(SCENARIOS[PI05_006]), set(EXPECTED_PI05_006))

    def test_pi05_006_complete_evidence_is_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            self._write_report(reports, self._pi05_006_cases(), "TEST-pi05-006.xml")

            manifest = build_evidence(reports)
            scenario = manifest["deterministic"][PI05_006]

            self.assertEqual(scenario["status"], "PASS")
            self.assertEqual(set(scenario["testcases"]), set(EXPECTED_PI05_006))
            self.assertTrue(all(state == "PASS" for state in scenario["testcases"].values()))
            self.assertTrue(manifest["suite"]["allPassed"])

    def test_pi05_006_missing_per_user_concurrency_is_not_run(self):
        missing = (
            "AssistantAdmissionIntegrationTests."
            "tenConcurrentConversationsForOneUserNeverHoldMoreThanTwoTurns"
        )
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            self._write_report(
                reports,
                [(identity, "PASS") for identity in EXPECTED_PI05_006 if identity != missing],
                "TEST-pi05-006.xml",
            )

            scenario = build_evidence(reports)["deterministic"][PI05_006]

            self.assertEqual(scenario["status"], "NOT_RUN")
            self.assertEqual(scenario["testcases"][missing], "NOT_RUN")

    def test_pi05_006_missing_shared_postgres_capacity_is_not_pass(self):
        missing = (
            "AssistantAdmissionIntegrationTests."
            "independentGuardInstancesSharePostgresCapacityAtTheBoundary"
        )
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            self._write_report(
                reports,
                [(identity, "PASS") for identity in EXPECTED_PI05_006 if identity != missing],
                "TEST-pi05-006.xml",
            )

            scenario = build_evidence(reports)["deterministic"][PI05_006]

            self.assertNotEqual(scenario["status"], "PASS")
            self.assertEqual(scenario["testcases"][missing], "NOT_RUN")

    def test_pi05_006_failed_rolling_quota_is_fail(self):
        failed = (
            "AssistantAdmissionIntegrationTests."
            "askQuotaIsRollingIdempotentAndRejectedRequestDoesNotCreateTurn"
        )
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            self._write_report(
                reports,
                self._pi05_006_cases({failed: "FAIL"}),
                "TEST-pi05-006.xml",
            )

            manifest = build_evidence(reports)

            self.assertEqual(manifest["deterministic"][PI05_006]["status"], "FAIL")
            self.assertEqual(manifest["deterministic"][PI05_006]["testcases"][failed], "FAIL")
            self.assertFalse(manifest["suite"]["allPassed"])

    def test_pi05_006_skipped_stale_token_fencing_is_blocked(self):
        blocked = (
            "AssistantAdmissionIntegrationTests."
            "staleClaimCannotFinalizeAfterReclaim"
        )
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            self._write_report(
                reports,
                self._pi05_006_cases({blocked: "BLOCKED"}),
                "TEST-pi05-006.xml",
            )

            manifest = build_evidence(reports)

            self.assertEqual(manifest["deterministic"][PI05_006]["status"], "BLOCKED")
            self.assertEqual(manifest["deterministic"][PI05_006]["testcases"][blocked], "BLOCKED")
            self.assertFalse(manifest["suite"]["allPassed"])

    def test_pi05_006_duplicate_identity_cannot_pass(self):
        duplicate = EXPECTED_PI05_006[0]
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            self._write_report(reports, self._pi05_006_cases(), "TEST-pi05-006.xml")
            self._write_report(reports, [(duplicate, "PASS")], "TEST-duplicate.xml")

            manifest = build_evidence(reports)

            self.assertEqual(manifest["deterministic"][PI05_006]["status"], "FAIL")
            self.assertEqual(
                manifest["deterministic"][PI05_006]["testcases"][duplicate],
                "FAIL",
            )
            self.assertFalse(manifest["suite"]["allPassed"])

    def test_workflow_cleans_stale_reports_before_acceptance_matrix(self):
        repository = Path(__file__).resolve().parents[3]
        workflow = (repository / ".github/workflows/pi05-system-acceptance.yml").read_text()
        cleanup = workflow.index("run: rm -rf target/surefire-reports")
        matrix = workflow.index("./mvnw -B -ntp")
        collector = workflow.index("python3 scripts/pi05_collect_evidence.py")
        self.assertLess(cleanup, matrix)
        self.assertLess(cleanup, collector)

        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory) / "reports"
            reports.mkdir()
            self._write_report(reports, self._pi05_006_cases(), "TEST-stale.xml")
            shutil.rmtree(reports)
            reports.mkdir()

            manifest = build_evidence(reports)

            self.assertEqual(manifest["deterministic"][PI05_006]["status"], "NOT_RUN")

    def test_missing_or_empty_report_directory_fails_strict_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for reports in (root / "missing", root / "empty"):
                if reports.name == "empty":
                    reports.mkdir()
                output = root / f"{reports.name}.json"

                self.assertNotEqual(
                    collect_main(
                        [
                            "--reports",
                            str(reports),
                            "--output",
                            str(output),
                            "--strict",
                        ]
                    ),
                    0,
                )
                evidence = json.loads(output.read_text())
                self.assertEqual(evidence["deterministic"][PI05_006]["status"], "NOT_RUN")

    def test_unrelated_failure_invalidates_strict_suite(self):
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            cases = self._pi05_006_cases() + [
                ("UnrelatedIntegrationTests.outsideAcceptanceFailure", "FAIL")
            ]
            self._write_report(reports, cases, "TEST-suite.xml")
            output = reports / "evidence.json"

            manifest = build_evidence(reports)

            self.assertEqual(manifest["deterministic"][PI05_006]["status"], "PASS")
            self.assertFalse(manifest["suite"]["allPassed"])
            self.assertEqual(manifest["suite"]["invalidTestcases"], 1)
            self.assertEqual(
                collect_main(
                    [
                        "--reports",
                        str(reports),
                        "--output",
                        str(output),
                        "--strict",
                    ]
                ),
                1,
            )

    def test_live_scenarios_remain_not_run_with_complete_deterministic_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            self._write_report(reports, self._pi05_006_cases(), "TEST-pi05-006.xml")

            manifest = build_evidence(reports)

            self.assertEqual(set(manifest["live"]), set(LIVE_SCENARIOS))
            self.assertTrue(
                all(evidence["status"] == "NOT_RUN" for evidence in manifest["live"].values())
            )

    def test_absent_report_is_not_run_even_when_ci_command_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = build_evidence(Path(directory))
            self.assertEqual(manifest["summary"]["PASS"], 0)
            self.assertEqual(manifest["summary"]["NOT_RUN"], len(SCENARIOS))
            self.assertTrue(all(v["status"] == "NOT_RUN" for v in manifest["live"].values()))
            self.assertEqual(len(manifest["live"]), len(LIVE_SCENARIOS))

    def test_skipped_test_is_not_pass(self):
        key=next(iter(SCENARIOS.values()))[0]
        matrix=evaluate({key:["BLOCKED"]})
        self.assertEqual(next(iter(matrix.values()))["status"],"BLOCKED")

    def test_failure_cannot_be_masked_by_other_successful_cases(self):
        suite=next(iter(SCENARIOS.values()))
        matrix=evaluate({suite[0]:["FAIL"],suite[1]:["PASS"]})
        self.assertEqual(next(iter(matrix.values()))["status"],"FAIL")

    def test_duplicate_case_identity_is_invalid_not_two_passes(self):
        key=next(iter(SCENARIOS.values()))[0]
        matrix=evaluate({key:["PASS","PASS"]})
        self.assertEqual(next(iter(matrix.values()))["status"],"FAIL")

    def test_actual_surefire_xml_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Element("testsuite",{"tests":"1","failures":"0","errors":"0"})
            key=next(iter(SCENARIOS.values()))[0]
            suite,method=key.split(".",1)
            SubElement(root,"testcase",{"classname":"com.test."+suite,"name":method})
            ElementTree(root).write(Path(directory)/"TEST-one.xml")
            manifest=build_evidence(Path(directory))
            self.assertEqual(manifest["deterministic"]["PI05-001-access-revocation"]
                             ["testcases"][key],"PASS")
            self.assertEqual(manifest["deterministic"]["PI05-001-access-revocation"]
                             ["status"],"NOT_RUN")

    def test_falsified_suite_counts_cannot_claim_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Element("testsuite",{"tests":"1","failures":"0","errors":"0"})
            case=SubElement(root,"testcase",{"classname":"com.test.Outside","name":"broken"})
            SubElement(case,"failure",{"message":"example"})
            ElementTree(root).write(Path(directory)/"TEST-invalid-count.xml")
            with self.assertRaises(ValueError):
                build_evidence(Path(directory))

    def test_unrelated_failed_test_invalidates_full_suite(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Element("testsuite",{"tests":"1","failures":"1","errors":"0"})
            case=SubElement(root,"testcase",{"classname":"com.test.Outside","name":"broken"})
            SubElement(case,"failure",{"message":"example"})
            ElementTree(root).write(Path(directory)/"TEST-failed.xml")
            result=build_evidence(Path(directory))
            self.assertFalse(result["suite"]["allPassed"])
            self.assertEqual(result["suite"]["invalidTestcases"],1)

    def test_invalid_xml_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/"TEST-invalid.xml").write_text("<testsuite><testcase")
            with self.assertRaises(Exception):
                build_evidence(Path(directory))


if __name__ == "__main__":
    unittest.main()
