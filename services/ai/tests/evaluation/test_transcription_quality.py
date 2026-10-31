"""Opt-in real Vietnamese quality evaluation; no synthetic speech substitution."""

import pytest

from .support import write_report
from .transcription_runner import build_transcription_report, run_configuration_matrix

pytestmark = pytest.mark.evaluation


def test_transcription_quality(transcription_evaluation_run):
    __tracebackhide__ = True
    manifest, root, output, matrix, factory, settings, baseline, check_output = transcription_evaluation_run
    records = run_configuration_matrix(
        manifest, root, matrix, factory, settings,
        expected_model_sha256=settings.audio_vad_model_sha256, evidence_mode="approved-live",
    )
    report = build_transcription_report(manifest, matrix, records, baseline=baseline)
    check_output()
    write_report(output, report)
    # UNESTABLISHED/UNAVAILABLE are not passing quality evidence. In particular,
    # the mandatory approved historical omission case may never be skipped.
    assert report["quality_gate_status"] == "PASS", "transcription quality not established; see sanitized report"
