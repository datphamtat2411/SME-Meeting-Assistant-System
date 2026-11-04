"""F02: genuine correction handoff validation, scoped controls and exact replay."""

import asyncio
import json
from contextlib import ExitStack
from types import SimpleNamespace
from uuid import uuid4

import pytest
import test_worker_e2e04 as e2e
from e2e04_f02_evidence import invalid_correction_handoff
from e2e04_recovery_faults import RecoveryFaults, campaign_pipeline

from sme_meeting_ai.audio import AudioSource
from sme_meeting_ai.core.config import Environment, Settings
from sme_meeting_ai.pipeline.offline_transcription import OfflineTranscriptionStage
from sme_meeting_ai.transcription import correction
from sme_meeting_ai.workers.transcription import pipeline_failure


def test_f02_uses_real_handoff_validator_before_any_provider(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("AI_E2E04_FAULT", "evidence_invalid")
    source = tmp_path / "synthetic.wav"
    source.write_bytes(e2e.synthetic_wav())
    settings = Settings(service_name="f02-unit", service_identity="ai-worker", environment="test",
                        audio_temp_dir=tmp_path, _env_file=None)
    validated = []
    original_handoff = correction._handoff
    original_entry = correction.correct_transcript

    def observe_actual_validation(reconciliation, coverage):
        validated.append((reconciliation.sample_count, coverage.sample_count))
        return original_handoff(reconciliation, coverage)

    monkeypatch.setattr(correction, "_handoff", observe_actual_validation)
    with ExitStack() as resources:
        outcome = campaign_pipeline(settings, resources).run(AudioSource(str(uuid4()), source))
    failure = pipeline_failure(outcome)
    assert validated == [(16001, 16000)]
    assert correction.correct_transcript is original_entry
    assert (failure.phase, failure.category, failure.completed_through) == (
        "CORRECTION", "VALIDATION", "RECONCILIATION")
    assert failure.metrics["sampleCount"] == 16000
    assert outcome.failure.attempts == 0 and outcome.result is None
    assert outcome.completed_stages == tuple(OfflineTranscriptionStage)[:-1]
    assert outcome.evidence.reconciliation is not None and outcome.evidence.coverage.sample_count == 16000
    diagnostics = capsys.readouterr().out
    assert diagnostics.count("E2E04_F02_FAULT ") == 1
    assert "E2E04_F02_PROVIDER " not in diagnostics
    assert "Cuộc họp" not in diagnostics


@pytest.mark.parametrize("environment", [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION])
def test_f02_control_is_forbidden_outside_test(environment):
    original = correction.correct_transcript
    with pytest.raises(ValueError, match="test environment"):
        with invalid_correction_handoff(environment):
            pytest.fail("non-test fault activated")
    assert correction.correct_transcript is original


def test_f02_entry_is_restored_after_exception():
    original = correction.correct_transcript
    with pytest.raises(RuntimeError, match="synthetic interruption"):
        with invalid_correction_handoff(Environment.TEST):
            assert correction.correct_transcript is not original
            raise RuntimeError("synthetic interruption")
    assert correction.correct_transcript is original


def test_f02_exact_replay_keeps_private_command_and_existing_receipt(capsys):
    calls = []
    receipt = {"receiptId": str(uuid4()), "errorCode": "TRANSCRIPTION_EVIDENCE_INVALID",
               "retryable": False, "retryExhausted": False}
    body = {"commandId": str(uuid4()), "claimToken": "synthetic-private-sentinel"}
    event = SimpleNamespace(eventId=str(uuid4()), generation=0)

    async def actual_call(event, operation, command, deadline):
        calls.append((operation, command, deadline))
        return SimpleNamespace(state="FAILURE_RECORDED", receipt=receipt, replay=len(calls) == 2)

    faults = RecoveryFaults(SimpleNamespace(), "evidence_invalid")
    result = asyncio.run(faults.once(actual_call, event, "fail", body, 123))
    assert result.receipt == receipt and result.replay is False
    assert len(calls) == 2 and calls[0] == ("fail", body, 123) and calls[1] == ("fail", body, None)
    assert all(command is body for _, command, _ in calls)
    output = capsys.readouterr().out
    assert body["claimToken"] not in output and "claimToken" not in output
    report, = [json.loads(line.split(" ", 1)[1]) for line in output.splitlines()
               if line.startswith("E2E04_F02_REPLAY ")]
    assert report["status"] == 200 and report["originalReplay"] is False and report["replay"] is True
    assert report["receiptId"] == receipt["receiptId"]


def test_f02_failed_first_http_call_is_not_replayed(capsys):
    calls = []

    async def actual_call(*args):
        calls.append(args)
        raise e2e.worker_diagnostics.CoreError(403)

    faults = RecoveryFaults(SimpleNamespace(), "evidence_invalid")
    with pytest.raises(e2e.worker_diagnostics.CoreError):
        asyncio.run(faults.once(actual_call, SimpleNamespace(), "fail", {}, None))
    assert len(calls) == 1 and "E2E04_F02_REPLAY " not in capsys.readouterr().out
