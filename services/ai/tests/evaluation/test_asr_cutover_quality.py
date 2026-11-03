"""Release-quality collection requires a separate explicit operator invocation."""

import os

import pytest

from sme_meeting_ai.core.config import load_settings

from .asr_cutover import run_live_cutover
from .support import EvaluationError

pytestmark = pytest.mark.evaluation


def test_asr_cutover_quality(request):
    __tracebackhide__ = True
    if os.environ.get("RUN_ASR_CUTOVER_LIVE") != "1":
        pytest.skip("cutover quality requires separate explicit live authorization")
    try:
        config = request.config
        report = run_live_cutover(
            config.getoption("evaluation_fixture_root"),
            config.getoption("transcription_evaluation_config"),
            config.getoption("asr_cutover_policy"),
            config.getoption("asr_cutover_output"),
            config.getoption("asr_cutover_max_calls"),
            load_settings(env_file=None),
        )
    except (EvaluationError, ValueError):
        pytest.fail("cutover evaluation unavailable; output suppressed", pytrace=False)
    # Collection can succeed while release quality remains unavailable/unapproved.
    assert report["release_decision"] == "NO-GO"
