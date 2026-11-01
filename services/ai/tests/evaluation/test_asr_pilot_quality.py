"""Explicit paid pilot invocation; skipped by ordinary CI."""

import os

import pytest

from sme_meeting_ai.core.config import load_settings

from .asr_pilot import run_live_pilot
from .support import EvaluationError

pytestmark = pytest.mark.evaluation


def test_asr_pilot_quality(request):
    __tracebackhide__ = True
    if os.environ.get("RUN_ASR_PILOT_LIVE") != "1":
        pytest.skip("pilot quality requires separate explicit live authorization")
    try:
        config = request.config
        report = run_live_pilot(
            config.getoption("evaluation_fixture_root"),
            config.getoption("transcription_evaluation_config"),
            config.getoption("asr_pilot_approval"),
            config.getoption("asr_pilot_output"),
            config.getoption("asr_pilot_max_calls"),
            load_settings(env_file=None),
        )
    except (EvaluationError, ValueError):
        pytest.fail("pilot unavailable; output suppressed", pytrace=False)
    assert report["evaluation_scope"] == "pilot"
    assert report["production_readiness"] == "NOT_ASSESSED"
    assert report["deployment_authorized"] is False
