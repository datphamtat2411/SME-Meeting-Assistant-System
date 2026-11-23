from __future__ import annotations

import io
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tool.run_android_native_verification import (
    GradleExecutionError,
    GradleTimeoutError,
    MergedManifestValidationError,
    classify_gradle_failure,
    run_gradle,
    validate_merged_manifest,
)


class GradleDiagnosticTests(unittest.TestCase):
    def test_classifies_dependency_resolution_failures(self) -> None:
        self.assertEqual(
            classify_gradle_failure(
                "> Task :app:processDebugManifest FAILED\n"
                "Could not resolve all files for configuration ':app:debugRuntimeClasspath'."
            ),
            "dependency-resolution",
        )

    def test_classifies_manifest_processing_failures(self) -> None:
        self.assertEqual(
            classify_gradle_failure(
                "Execution failed for task ':app:processDebugManifest'."
            ),
            "manifest-processing",
        )

    def test_classifies_native_compilation_failures(self) -> None:
        self.assertEqual(
            classify_gradle_failure(
                "Execution failed for task ':app:compileDebugKotlin'."
            ),
            "native-compilation",
        )

    def test_classifies_other_gradle_failures(self) -> None:
        self.assertEqual(
            classify_gradle_failure(
                "Execution failed for task ':app:testDebugUnitTest'."
            ),
            "gradle-task",
        )

    def test_nonzero_exit_reports_category_and_visible_tail(self) -> None:
        output = io.StringIO()
        with self.assertRaises(GradleExecutionError) as raised:
            run_gradle(
                [
                    sys.executable,
                    "-c",
                    "print('Could not resolve dependency from repository')\n"
                    "raise SystemExit(17)",
                ],
                cwd=Path.cwd(),
                timeout_seconds=5,
                output_stream=output,
            )

        self.assertEqual(raised.exception.return_code, 17)
        self.assertEqual(raised.exception.category, "dependency-resolution")
        self.assertIn("Could not resolve dependency", output.getvalue())
        self.assertIn("dependency-resolution", str(raised.exception))

    def test_timeout_is_distinct_and_terminates_gradle_process(self) -> None:
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "gradle.pid"
            script = (
                "import os, signal, sys, time\n"
                f"open({str(pid_file)!r}, 'w').write(str(os.getpid()))\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "print('> Task :app:processDebugManifest', flush=True)\n"
                "time.sleep(30)\n"
            )
            started = time.monotonic()

            with self.assertRaises(GradleTimeoutError) as raised:
                run_gradle(
                    [sys.executable, "-c", script],
                    cwd=Path(directory),
                    timeout_seconds=1,
                    termination_grace_seconds=0.1,
                    output_stream=output,
                )

            self.assertLess(time.monotonic() - started, 5)
            self.assertIn("timed out after 1 second", str(raised.exception))
            self.assertIn("process group was terminated", str(raised.exception))
            self.assertIn("> Task :app:processDebugManifest", output.getvalue())
            pid = int(pid_file.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_source_manifest_is_not_accepted_as_merged_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_manifest = root / "android/app/src/main/AndroidManifest.xml"
            source_manifest.parent.mkdir(parents=True)
            source_manifest.write_text(
                '<manifest xmlns:android="http://schemas.android.com/apk/res/android">'
                '<application android:allowBackup="true" '
                'android:fullBackupContent="@xml/backup_rules" '
                'android:dataExtractionRules="@xml/data_extraction_rules"/>'
                "</manifest>"
            )

            with self.assertRaises(MergedManifestValidationError) as raised:
                validate_merged_manifest(root)

            self.assertIn("effective merged debug", str(raised.exception))

    def test_validates_backup_rules_on_effective_merged_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            merged_manifest = (
                root
                / "build/app/intermediates/merged_manifests/debug/"
                "processDebugManifest/AndroidManifest.xml"
            )
            merged_manifest.parent.mkdir(parents=True)
            merged_manifest.write_text(
                '<manifest xmlns:android="http://schemas.android.com/apk/res/android">'
                '<application android:allowBackup="true" '
                'android:fullBackupContent="@xml/backup_rules" '
                'android:dataExtractionRules="@xml/data_extraction_rules"/>'
                "</manifest>"
            )

            validate_merged_manifest(root)


if __name__ == "__main__":
    unittest.main()
