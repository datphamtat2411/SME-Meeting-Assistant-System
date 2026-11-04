import os
from pathlib import Path

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.providers.replicate_diarization import ReplicateDiarizationAdapter


@pytest.mark.live_provider
def test_live_replicate_diarization():
    if os.environ.get("AI_RUN_REPLICATE_LIVE") != "1":
        pytest.skip("Set AI_RUN_REPLICATE_LIVE=1 to opt in")
    if not os.environ.get("REPLICATE_API_TOKEN") or not os.environ.get("AI_DIARIZATION_LIVE_AUDIO"):
        pytest.skip("Token and permitted short audio path are required")
    settings = Settings(service_name="live-test", service_identity="ai-core", _env_file=None)
    result = ReplicateDiarizationAdapter(settings).diarize(Path(os.environ["AI_DIARIZATION_LIVE_AUDIO"]))
    assert result.turns
    assert all(turn.speaker_label in result.speakers for turn in result.turns)
