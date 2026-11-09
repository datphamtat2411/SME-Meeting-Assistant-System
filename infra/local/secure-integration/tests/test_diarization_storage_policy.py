"""Deterministic IAM/map checks; no live storage or worker process required."""
import ast
import fnmatch
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DiarizationStoragePolicyTests(unittest.TestCase):
    def policy(self, role):
        # Isolate the pure policy function from the operator-only boto/admin imports.
        tree = ast.parse((ROOT / "storage_admin.py").read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "policy")
        namespace = {"re": re}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "storage_admin.py", "exec"), namespace)
        return namespace["policy"]("meeting-media", role)

    def allowed(self, role, action, key):
        resource = "arn:aws:s3:::meeting-media/" + key
        return any(action in s["Action"] and any(fnmatch.fnmatchcase(resource, r) for r in s["Resource"])
                   for s in self.policy(role)["Statement"])

    def test_separate_capability_preserves_transcription_permissions(self):
        result = "processing/job/diarization/results/stage.json"
        self.assertTrue(self.allowed("diarization-worker", "s3:PutObject", result))
        self.assertTrue(self.allowed("diarization-worker", "s3:GetObject", "meetings/meeting/sources/media"))
        self.assertTrue(self.allowed("core", "s3:GetObject", result))
        for role in ("worker", "core", "diarization-worker"):
            self.assertFalse(self.allowed(role, "s3:DeleteObject", result))
        self.assertFalse(self.allowed("worker", "s3:GetObject", result))
        self.assertFalse(self.allowed("worker", "s3:PutObject", result))
        self.assertFalse(self.allowed("diarization-worker", "s3:PutObject", "processing/job/transcription/results/stage.json"))
        self.assertFalse(self.allowed("diarization-worker", "s3:GetObject", "meetings/meeting/pending/media"))

    def test_intelligence_capability_has_only_snapshot_and_result_access(self):
        source = "processing/job/intelligence/source/snapshot.json"
        result = "processing/job/intelligence/results/stage.json"
        self.assertTrue(self.allowed("intelligence", "s3:GetObject", source))
        self.assertTrue(self.allowed("intelligence", "s3:GetObject", result))
        self.assertTrue(self.allowed("intelligence", "s3:PutObject", result))
        self.assertFalse(self.allowed("intelligence", "s3:PutObject", source))
        self.assertFalse(self.allowed("intelligence", "s3:GetObject", "meetings/meeting/sources/media"))
        self.assertFalse(self.allowed("intelligence", "s3:DeleteObject", result))

    def map_value(self, name, value):
        text = (ROOT / "storage-boundary.conf").read_text()
        body = re.search(r"map [^\n]+ \$" + name + r" \{(.*?)\n    \}", text, re.S).group(1)
        default = None
        for key, result in re.findall(r'^\s*("[^"\n]+"|[^#\s][^\s]*)\s+([01]);', body, re.M):
            if key == "default":
                default = int(result)
            elif key.startswith("~") and re.search(key[1:], value) or key.strip('"') == value:
                return int(result)
        return default

    def test_create_only_boundary_protects_both_result_namespaces(self):
        for capability in ("transcription", "diarization"):
            path = f"/meeting-media/processing/job/{capability}/results/stage.json"
            self.assertEqual(self.map_value("corrected_result", path), 1)
            for allowed in ("1:GET::: ", "1:HEAD::: ", "1:PUT:*::"):
                self.assertEqual(self.map_value("deny_result_mutation", allowed), 0)
            for denied in ("1:PUT::::", "1:PUT:*:uploadId=x:", "1:POST::: ", "1:PUT:*::source", "1:DELETE::: "):
                self.assertEqual(self.map_value("deny_result_mutation", denied), 1)
            self.assertEqual(self.map_value("deny_protected_delete", "DELETE:" + path), 1)


if __name__ == "__main__":
    unittest.main()
