#!/usr/bin/env python3
"""Run bounded Android Gradle checks and verify the effective merged manifest."""

from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sys
import threading
import xml.etree.ElementTree as ET
from collections import deque
from pathlib import Path
from typing import TextIO


ROOT = Path(__file__).resolve().parents[1]
ANDROID_NS = "http://schemas.android.com/apk/res/android"
DEFAULT_TIMEOUT_SECONDS = 25 * 60
GRADLE_TASKS = (":app:processDebugManifest", ":app:testDebugUnitTest")
MANIFEST_CANDIDATES = (
    Path("build/app/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml"),
    Path("build/app/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml"),
)
TAIL_LINE_COUNT = 30


class GradleTimeoutError(RuntimeError):
    def __init__(self, timeout_seconds: int, *, process_group_terminated: bool) -> None:
        self.timeout_seconds = timeout_seconds
        self.process_group_terminated = process_group_terminated
        seconds = (
            f"{timeout_seconds} second"
            if timeout_seconds == 1
            else f"{timeout_seconds} seconds"
        )
        cleanup = (
            "The Gradle process group was terminated."
            if process_group_terminated
            else "Gradle process cleanup could not be confirmed."
        )
        super().__init__(
            f"Android Gradle verification timed out after {seconds}. "
            f"{cleanup} Inspect the last visible Gradle task and retry with "
            "the same cached workspace."
        )


class GradleExecutionError(RuntimeError):
    def __init__(self, return_code: int, category: str, tail: list[str]) -> None:
        self.return_code = return_code
        self.category = category
        details = "\n".join(tail[-12:])
        message = (
            f"Android Gradle {category} failure (exit code {return_code})."
        )
        if details:
            message += f"\nLast Gradle output:\n{details}"
        super().__init__(message)


class GradleLaunchError(RuntimeError):
    pass


class MergedManifestValidationError(RuntimeError):
    pass


def classify_gradle_failure(output: str) -> str:
    normalized = output.lower()
    dependency_failure_patterns = (
        "could not resolve ",
        "could not resolve all files",
        "could not find ",
        "could not get resource",
        "could not download ",
        "unknownhostexception",
        "pkix path building failed",
        "temporary failure in name resolution",
        "no cached version available for offline mode",
    )
    if any(pattern in normalized for pattern in dependency_failure_patterns):
        return "dependency-resolution"

    if (
        "execution failed for task ':app:processdebugmanifest'" in normalized
        or ":app:processdebugmanifest failed" in normalized
        or "manifest merger failed" in normalized
    ):
        return "manifest-processing"

    if re.search(
        r"execution failed for task ['\"][^'\"]*(?:compile|kapt|ksp)[^'\"]*['\"]",
        output,
        flags=re.IGNORECASE,
    ):
        return "native-compilation"

    return "gradle-task"


def _signal_process_group(process: subprocess.Popen[str], sig: int) -> bool:
    if os.name == "nt":
        try:
            if sig == signal.SIGKILL:
                process.kill()
            else:
                process.terminate()
            return True
        except ProcessLookupError:
            return True

    try:
        os.killpg(process.pid, sig)
        return True
    except ProcessLookupError:
        return process.poll() is not None


def _terminate_process_group(
    process: subprocess.Popen[str],
    output_thread: threading.Thread,
    grace_seconds: float,
) -> bool:
    _signal_process_group(process, signal.SIGTERM)
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        _signal_process_group(process, signal.SIGKILL)
        process.wait()

    output_thread.join(timeout=grace_seconds)
    if output_thread.is_alive():
        _signal_process_group(process, signal.SIGKILL)
        output_thread.join(timeout=grace_seconds)
    return process.poll() is not None and not output_thread.is_alive()


def run_gradle(
    command: list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    termination_grace_seconds: float = 5,
    output_stream: TextIO | None = None,
) -> None:
    """Stream Gradle output and stop its process group after a bounded timeout."""
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    destination = output_stream or sys.stdout
    tail: deque[str] = deque(maxlen=TAIL_LINE_COUNT)

    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            start_new_session=os.name != "nt",
        )
    except OSError as error:
        raise GradleLaunchError(
            f"Could not start the Android Gradle Wrapper: {error}"
        ) from error

    assert process.stdout is not None

    def forward_output() -> None:
        for line in process.stdout:
            tail.append(line.rstrip())
            destination.write(line)
            destination.flush()

    output_thread = threading.Thread(
        target=forward_output,
        name="android-gradle-output",
        daemon=True,
    )
    output_thread.start()

    try:
        return_code = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        terminated = _terminate_process_group(
            process,
            output_thread,
            termination_grace_seconds,
        )
        raise GradleTimeoutError(
            timeout_seconds,
            process_group_terminated=terminated,
        )
    finally:
        if process.poll() is not None:
            output_thread.join(timeout=termination_grace_seconds)
        if not output_thread.is_alive():
            process.stdout.close()

    if return_code != 0:
        output_tail = list(tail)
        category = classify_gradle_failure("\n".join(output_tail))
        raise GradleExecutionError(return_code, category, output_tail)


def validate_merged_manifest(root: Path = ROOT) -> None:
    manifest_path = next(
        (
            root / relative
            for relative in MANIFEST_CANDIDATES
            if (root / relative).is_file()
        ),
        None,
    )
    if manifest_path is None:
        expected = ", ".join(str(path) for path in MANIFEST_CANDIDATES)
        raise MergedManifestValidationError(
            "Gradle completed without producing an effective merged debug "
            f"Android manifest. Checked: {expected}"
        )

    try:
        merged = ET.fromstring(manifest_path.read_text())
    except (ET.ParseError, OSError) as error:
        raise MergedManifestValidationError(
            f"Effective merged Android manifest is invalid: {error}"
        ) from error

    application = merged.find("application")
    if application is None:
        raise MergedManifestValidationError(
            "Effective merged Android manifest is missing application."
        )

    def android_attribute(name: str) -> str | None:
        return application.attrib.get(f"{{{ANDROID_NS}}}{name}")

    failures = []
    if android_attribute("allowBackup") != "true":
        failures.append("must retain targeted secure-storage backups")
    if android_attribute("fullBackupContent") != "@xml/backup_rules":
        failures.append("is missing legacy backup exclusions")
    if android_attribute("dataExtractionRules") != "@xml/data_extraction_rules":
        failures.append("is missing cloud/device-transfer exclusions")
    if failures:
        raise MergedManifestValidationError(
            "Effective merged Android manifest "
            + "; ".join(failures)
            + "."
        )

    print(f"Effective merged Android manifest validation: PASS ({manifest_path})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=(
            "maximum time for the combined Gradle manifest and JVM test tasks "
            f"(default: {DEFAULT_TIMEOUT_SECONDS} seconds)"
        ),
    )
    arguments = parser.parse_args()

    gradle = ROOT / "android/gradlew"
    command = [
        str(gradle),
        "-p",
        str(ROOT / "android"),
        "--console=plain",
        "--info",
        "--profile",
        *GRADLE_TASKS,
    ]
    print(
        "Starting bounded Android Gradle verification "
        f"(timeout: {arguments.timeout_seconds}s; tasks: "
        + ", ".join(GRADLE_TASKS)
        + ").",
        flush=True,
    )
    try:
        run_gradle(
            command,
            cwd=ROOT,
            timeout_seconds=arguments.timeout_seconds,
        )
    except GradleTimeoutError as error:
        print(f"Android native verification failed: {error}", file=sys.stderr)
        return 1
    except GradleExecutionError as error:
        print(f"Android native verification failed: {error}", file=sys.stderr)
        return 1
    except GradleLaunchError as error:
        print(f"Android native verification failed: {error}", file=sys.stderr)
        return 1

    try:
        validate_merged_manifest()
    except MergedManifestValidationError as error:
        print(
            f"Effective merged-manifest validation failed: {error}",
            file=sys.stderr,
        )
        return 1

    print("Android native Gradle verification: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
