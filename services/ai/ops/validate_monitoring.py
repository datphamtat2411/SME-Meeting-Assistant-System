#!/usr/bin/env python3
"""Validate importable dashboards and execute real Prometheus rule evaluation offline."""
import json
import subprocess
import tempfile
from pathlib import Path

OPS = Path(__file__).resolve().parent
IMAGE = "prom/prometheus:v3.5.0@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996"


def labels(name="", **tags):
    return name + "{" + ",".join(f"{key}={json.dumps(value)}" for key, value in tags.items()) + "}"


def populated_panels(expressions):
    series = []

    def metric(name, value, **tags):
        for instance in ("one", "two"):
            series.append({"series": labels(name, job="core-diarization", environment="test",
                                             cluster="a", instance=instance, **tags),
                           "values": f"{value}+0x2"})

    def expected(value, **tags):
        return {"labels": labels(**tags), "value": value}

    for outcome, count, seconds in (("accepted", 2, 120), ("failed", 2, 180)):
        metric("diarization_window_outcomes", 40 if outcome == "accepted" else 10, outcome=outcome)
        metric("diarization_window_stage_duration_count", count, outcome=outcome)
        metric("diarization_window_stage_duration_seconds", seconds, outcome=outcome)
    distributions = (
        ("diarization_window_stage_duration", "le_seconds", [("30", 1), ("120", 2), ("300", 3),
                                                            ("900", 4), ("3600", 4), ("infinity", 4)]),
        ("diarization_window_speakers", "le", [("0", 0), ("1", 1), ("2", 2), ("5", 3), ("10", 3), ("1000", 3)]),
        ("diarization_window_unknown_assignments", "le", [("0", 1), ("1", 2), ("5", 3), ("10", 3), ("100", 3), ("16384", 3)]),
    )
    for name, key, buckets in distributions:
        for bound, value in buckets:
            metric(name, value, **{key: bound})
    for state, value in (("actionable", 2), ("stale", 3), ("superseded", 3)):
        metric("diarization_verified_only_count", value, state=state)
    for name, value in (("diarization_window_retries", 3), ("diarization_verified_only_outstanding", 8),
                        ("diarization_verified_only_oldest_age_seconds", 1800),
                        ("diarization_window_lease_expirations", 7), ("diarization_metrics_aggregation_healthy", 1), ("up", 1)):
        metric(name, value)
    samples = [
        [expected(40, outcome="accepted"), expected(10, outcome="failed")],
        [expected(60, outcome="accepted"), expected(90, outcome="failed")],
        [expected(3)],
        *[[expected(value, **{key: bound}) for bound, value in buckets] for _, key, buckets in distributions],
        [expected(8)],
        [expected(value, state=state) for state, value in (("actionable", 2), ("stale", 3), ("superseded", 3))],
        [expected(1800)], [expected(7)],
        *[[{"labels": labels(name, job="core-diarization", environment="test", cluster="a", instance=instance), "value": 1}
           for instance in ("one", "two")] for name in ("diarization_metrics_aggregation_healthy", "up")],
    ]
    return {"name": "Actual dashboard calculations with two database replicas", "interval": "1m",
            "input_series": series, "promql_expr_test": [
                {"expr": expr, "eval_time": "1m", "exp_samples": sample}
                for expr, sample in zip(expressions, samples, strict=True)]}


def main():
    dashboard = json.loads((OPS / "diarization-dashboard.json").read_text())
    expressions = [target["expr"].replace("$environment", "test").replace("$cluster", "a")
                   for panel in dashboard["panels"] for target in panel["targets"]]
    assert len(expressions) == 12 and len({p["id"] for p in dashboard["panels"]}) == 12
    # Check real calculations and missing-data behavior, not only PromQL syntax.
    with tempfile.TemporaryDirectory(prefix="spk12-promtool-") as temporary:
        path = Path(temporary)
        path.chmod(0o755)
        (path / "panels.json").write_text(json.dumps({"rule_files": [], "tests": [{
            "promql_expr_test": [{"expr": expr, "eval_time": "1m", "exp_samples": []}
                                 for expr in expressions]}, populated_panels(expressions)]}))
        base = ["docker", "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
                "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
                "--entrypoint=/bin/promtool", "-v", f"{OPS}:/ops:ro", "-v", f"{path}:/checks:ro",
                "-w", "/ops", IMAGE]
        for command in (["check", "rules", "diarization.rules.yml"],
                        ["check", "config", "--syntax-only", "diarization-prometheus.yml"],
                        ["test", "rules", "diarization.rules.test.yml", "/checks/panels.json"]):
            subprocess.run([*base, *command], check=True, timeout=120)
    print("PASS: 12 dashboard queries, scrape syntax, recording and sustained alert rules")


if __name__ == "__main__":
    main()
