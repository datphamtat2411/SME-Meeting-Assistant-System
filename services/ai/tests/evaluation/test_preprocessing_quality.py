"""Actual FFmpeg + pinned Silero evaluation; requires approved external assets."""

import pytest

from sme_meeting_ai.audio import AudioSource

from .support import analyze_result, build_report, verify_source, write_report

pytestmark = pytest.mark.evaluation


def test_preprocessing_quality(evaluation_run):
    manifest, root, output, pipeline, model_sha256 = evaluation_run
    records = []
    for fixture in sorted(manifest.fixtures, key=lambda item: item.fixture_id):
        source = verify_source(root, fixture)
        try:
            with pipeline.run(AudioSource(fixture.fixture_id, source)) as outcome:
                assert outcome.failure is None, "evaluation preprocessing stage failed"
                assert outcome.result is not None, "evaluation preprocessing result missing"
                records.append(analyze_result(
                    manifest, fixture, outcome.result, expected_model_sha256=model_sha256,
                ))
        finally:
            verify_source(root, fixture)
    report = build_report(manifest, records)
    write_report(output, report)
    # Missing evidence-backed gates are reported explicitly, never fabricated.
    print(f"preprocessing quality gates: {report['quality_gate_status']}")
    assert report["quality_gate_status"] != "FAIL", "evidence-backed quality gate failed; see evaluation output"
