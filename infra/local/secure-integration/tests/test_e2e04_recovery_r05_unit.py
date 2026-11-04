"""R05 seed validation must check every original binding and digest."""

from uuid import uuid4

import pytest
from e2e04_recovery_support import validate_seed

from sme_meeting_ai.workers.transcription import ResultValidationError


def test_invalid_existing_bytes_cannot_be_promoted_as_authorized_reuse():
    with pytest.raises(ResultValidationError):
        validate_seed(b'{"invalid":true}', job_id=str(uuid4()), media_id=str(uuid4()),
                      source_revision="a" * 64, producer_id=str(uuid4()))


def test_worker_pipeline_observation_is_at_actual_run_boundary(tmp_path, monkeypatch, capsys):
    import test_worker_e2e04 as e2e
    from e2e04_recovery_faults import campaign_pipeline

    from sme_meeting_ai.core.config import Settings

    source = tmp_path / "source.wav"
    source.write_bytes(e2e.synthetic_wav())
    from contextlib import ExitStack

    from sme_meeting_ai.audio import AudioSource

    settings = Settings(service_name="e2e04-unit", service_identity="ai-worker", environment="test",
                        audio_temp_dir=tmp_path, _env_file=None)
    with ExitStack() as resources:
        pipeline = campaign_pipeline(settings, resources)
        assert "E2E04_PIPELINE" not in capsys.readouterr().out
        outcome = pipeline.run(AudioSource(str(uuid4()), source))
        assert outcome.failure is None
    assert capsys.readouterr().out.count("E2E04_PIPELINE ") == 1
