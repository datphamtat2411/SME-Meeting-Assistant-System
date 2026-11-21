"""Regression tests for rejecting superficial or false PI-01 inventory evidence."""
from __future__ import annotations

import copy
import json
import unittest

from verify_pi01_inventory import AuditError, INVENTORY, ROOT, validate_inventory


class PI01IntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = json.loads((ROOT / INVENTORY).read_text(encoding="utf-8"))

    def assert_rejected(self, edit):
        candidate = copy.deepcopy(self.original)
        edit(candidate)
        with self.assertRaises(AuditError):
            validate_inventory(ROOT, candidate)

    def test_repository_inventory_passes(self):
        validate_inventory(ROOT, self.original)

    def test_duplicate_capability_is_rejected(self):
        self.assert_rejected(lambda obj: obj["capabilities"].append(copy.deepcopy(obj["capabilities"][0])))

    def test_unknown_requirement_cannot_be_faked(self):
        self.assert_rejected(lambda obj: obj["capabilities"][0]["requirement_ids"].append("API-EP-AST-999"))

    def test_missing_evidence_path_cannot_be_faked(self):
        self.assert_rejected(lambda obj: obj["capabilities"][0]["evidence_paths"].append("services/api/does-not-exist.java"))

    def test_live_claim_requires_real_run_identity(self):
        self.assert_rejected(lambda obj: obj["capabilities"][0].update(verification="VERIFIED_LIVE"))

    def test_unlinked_finding_is_rejected(self):
        self.assert_rejected(lambda obj: obj["findings"].append({
            "id": "G-900", "severity": "HIGH", "state": "OPEN",
            "owner": "PI-01", "summary": "Not referenced by any audited capability."
        }))

    def test_path_traversal_is_rejected(self):
        self.assert_rejected(lambda obj: obj["capabilities"][0]["evidence_paths"].append("../outside"))

    def test_untracked_resolution_is_rejected(self):
        self.assert_rejected(lambda obj: obj["missing_paths"].append("services/api/src/main/java"))


if __name__ == "__main__":
    unittest.main()
