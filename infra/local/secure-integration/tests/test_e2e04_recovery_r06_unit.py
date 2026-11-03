"""R06 controlled exception traverses real correction and Worker classification."""

import os
from contextlib import ExitStack
from types import SimpleNamespace
from uuid import uuid4

import test_worker_e2e04 as e2e
from e2e04_recovery_faults import campaign_pipeline

from sme_meeting_ai.audio import AudioSource
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.offline_transcription import OfflineTranscriptionStage
from sme_meeting_ai.workers.transcription import pipeline_failure


def test_provider_failure_preserves_real_validated_reconciliation_prefix(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("AI_E2E04_FAULT", "provider_failure")
    source = tmp_path / "source.wav"
    source.write_bytes(e2e.synthetic_wav())
    settings = Settings(service_name="e2e04-unit", service_identity="ai-worker", environment="test",
                        audio_temp_dir=tmp_path, _env_file=None)
    with ExitStack() as resources:
        outcome = campaign_pipeline(settings, resources).run(AudioSource(str(uuid4()), source))
    failure = pipeline_failure(outcome)
    assert failure.phase == "CORRECTION" and failure.category == "PROVIDER"
    assert failure.completed_through == "RECONCILIATION"
    assert outcome.completed_stages == tuple(OfflineTranscriptionStage)[:-1]
    assert outcome.result is None and outcome.evidence.reconciliation is not None
    assert failure.metrics["sampleCount"] == 16000
    # PROVIDER is deliberately not a local correction repair retry category.
    # Core's separately admitted generations own the retry in this scenario.
    assert capsys.readouterr().out.count("E2E04_PROVIDER_FAILURE ") == 1
    assert os.environ["AI_E2E04_FAULT"] == "provider_failure"


def test_retry_event_diagnostics_preserve_real_supported_type():
    import json

    event = str(uuid4())
    delivery = SimpleNamespace(body=json.dumps({"eventId": event, "processingJobId": str(uuid4()),
                                                "schemaVersion": 2}).encode(),
                               headers={"eventId": event, "eventType": "PROCESSING_JOB_RETRY_REQUESTED"},
                               message_id=event, content_type="application/json", delivery_mode=2,
                               exchange="meeting.processing", routing_key="processing.job.queued",
                               channel=SimpleNamespace(number=1), delivery_tag=2, redelivered=False)
    observed = e2e.worker_diagnostics.message_observation(delivery)
    assert observed["headerEventType"] == observed["eventType"] == "PROCESSING_JOB_RETRY_REQUESTED"
