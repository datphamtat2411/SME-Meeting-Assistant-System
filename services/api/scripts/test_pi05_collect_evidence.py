"""Negative acceptance-evidence tests: PASS cannot be inferred from missing/failed/skipped XML."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, ElementTree

from pi05_collect_evidence import SCENARIOS, LIVE_SCENARIOS, build_evidence, evaluate


class AcceptanceEvidenceTests(unittest.TestCase):
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

    def test_invalid_xml_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/"TEST-invalid.xml").write_text("<testsuite><testcase")
            with self.assertRaises(Exception):
                build_evidence(Path(directory))


if __name__ == "__main__":
    unittest.main()
