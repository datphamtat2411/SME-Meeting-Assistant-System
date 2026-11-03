"""Explicitly opted-in real comparison entry point; never run by ordinary tests."""

import os

import pytest

from .asr_strategy_comparison import run_live_comparison
from .support import EvaluationError

pytestmark = [pytest.mark.evaluation, pytest.mark.skipif(
    os.environ.get("RUN_ASR_COMPARISON_LIVE") != "1", reason="ASR comparison live opt-in required")]


def test_asr_strategy_comparison_quality(asr_comparison_run):
    __tracebackhide__ = True
    root, config, output, budget, settings = asr_comparison_run
    try:
        report = run_live_comparison(root, config, output, budget, settings)
    except EvaluationError:
        pytest.fail("ASR comparison preflight or execution unavailable", pytrace=False)
    # Successful execution is not a Vietnamese quality PASS. In particular, the
    # existing gate contract does not establish reviewed whole-file quality gates.
    assert report["quality_status"] == "PASS", "ASR comparison quality not established; see sanitized report"
