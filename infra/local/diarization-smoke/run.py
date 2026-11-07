#!/usr/bin/env python3
"""SPK-11 offline gate and opt-in disposable full-stack smoke runner."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
AI = ROOT / "services/ai"
API = ROOT / "services/api"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full-stack", action="store_true", help="Start disposable Docker infrastructure via Testcontainers")
    parser.add_argument("--full-suites", action="store_true", help="Run the full existing AI and Core suites instead of diarization-focused selection")
    args = parser.parse_args()
    env = {k: v for k, v in os.environ.items() if not k.startswith((
        "AI_", "APP_", "AWS_", "DB_", "RABBITMQ_", "S3_", "REPLICATE_", "OPENROUTER_",
        "E2E", "RUN_", "SPK", "LIVE_", "V62_FIXTURE_DIR",
    ))}
    # External service credentials/opt-ins are never inherited. Test subprocesses
    # receive only the suite-owned disposable transport configuration via stdin.
    env["AWS_EC2_METADATA_DISABLED"] = "true"
    env["SPK11_PYTHON"] = str(AI / ".venv/bin/python")
    if args.full_stack:
        env["SPK11_FULL_STACK"] = "1"
    focused = [
        "tests/unit/test_diarization.py", "tests/unit/test_diarization_service.py",
        "tests/unit/test_diarization_contract.py", "tests/unit/test_diarization_runtime.py",
        "tests/integration/test_diarization_worker.py", "tests/integration/test_spk11_offline.py",
    ]
    checks = [
        ("ai-lint", AI, ["uv", "run", "--locked", "ruff", "check", "src", "tests"]),
        ("ai-tests", AI, ["uv", "run", "--locked", "pytest", *(["tests"] if args.full_suites else focused),
                           "-m", "not evaluation and not live_provider and not live_infrastructure"]),
        ("ai-build", AI, ["uv", "build"]),
        ("monitoring-rules", ROOT, ["python3", "services/ai/ops/validate_monitoring.py"]),
        ("core-verify", API, ["./mvnw", "-B", "-ntp", *([] if args.full_suites else [
            "-Dtest=*Diarization*,Spk11FullStackSmokeTests"]), "verify"]),
    ]
    output = API / "target/spk11-gate"
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for name, cwd, command in checks:
        print(f"RUN {name}: {' '.join(command)}", flush=True)
        start = time.monotonic()
        with (output / f"{name}.log").open("w") as log:
            try:
                result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
                                        timeout=1800, check=False)
                code = result.returncode
                if name == "core-verify" and args.full_stack and code == 0:
                    report = API / "target/surefire-reports/TEST-com.sme.meetingassistant.api.transport.Spk11FullStackSmokeTests.xml"
                    try:
                        suite = ET.parse(report).getroot()
                        if int(suite.attrib["tests"]) < 23 or any(int(suite.attrib.get(k, "0")) for k in ("skipped", "errors", "failures")):
                            code = 1
                    except (OSError, KeyError, ValueError, ET.ParseError):
                        code = 1
                    if code:
                        log.write("\nSPK-11 full-stack evidence missing, fewer than 23 cases, skipped, or unsuccessful.\n")
            except (OSError, subprocess.TimeoutExpired):
                code = 124
        results.append(dict(check=name, exitCode=code, seconds=round(time.monotonic()-start, 2)))
        print(f"{'PASS' if code == 0 else 'FAIL'} {name}; log: {output / (name + '.log')}", flush=True)
    report = dict(fullStackRequested=args.full_stack, fullSuites=args.full_suites, checks=results)
    (output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Results: {output / 'results.json'}", flush=True)
    return int(any(r["exitCode"] for r in results))


if __name__ == "__main__":
    sys.exit(main())
