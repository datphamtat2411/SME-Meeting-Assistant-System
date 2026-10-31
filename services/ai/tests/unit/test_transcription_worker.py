import hashlib
import json
from dataclasses import replace
from uuid import uuid4

import pytest
from integration.test_offline_transcription_pipeline import pipeline
from integration.test_offline_transcription_pipeline import workflow as workflow

from sme_meeting_ai.pipeline import OfflineTranscriptionStatus as Status
from sme_meeting_ai.pipeline.offline_transcription import OfflineTranscriptionFailure
from sme_meeting_ai.transcription.asr import AsrCandidate
from sme_meeting_ai.workers.transcription import (
    ResultValidationError,
    correction_digest,
    map_result,
    validate_result_bytes,
)


def binding(h):
    return dict(job_id=str(uuid4()), media_id=h.source.source_id, source_revision="a" * 64,
                producer_id=str(uuid4()))


def test_cross_language_vietnamese_digest():
    segments = [dict(ordinal=0, startMs=0, endMs=1000, text="Xin chào."),
                dict(ordinal=1, startMs=1000, endMs=1750, text="Chốt lịch họp.")]
    assert correction_digest(segments) == "dfa8c6d7a8a5297c28f1b4f7f4fcea73a0c21b04fe4e3377a5b9ad29e9acb70a"
    with pytest.raises(ResultValidationError):
        correction_digest([segments[0], segments[0]])


def test_corrected_only_mapping_exact_timeline_warning_provenance(workflow):
    h = workflow(count=4095)
    # The transport contract requires UUID source identities.
    h.source = replace(h.source, source_id=str(uuid4()))
    outcome = pipeline(h).run(h.source)
    bound = binding(h)
    raw = map_result(outcome, h.settings, **bound)
    result = validate_result_bytes(raw, **bound)
    data = json.loads(raw)
    assert data["sampleCount"] == 4095 and data["durationMs"] == 256
    assert data["segments"][-1]["endMs"] == 256
    assert [s["text"] for s in data["segments"]] == [s.text for s in outcome.result.segments]
    assert data["correctionProof"]["contextScope"] == "WHOLE_MEETING"
    assert data["correctionProof"]["outputSha256"] == correction_digest(data["segments"])
    assert {m["role"] for m in data["provenance"]["models"]} == {"ASR", "CORRECTION"}
    assert result.pipelineStatus == "COMPLETED"
    assert "raw" not in data and "speakerLabel" not in data["segments"][0]
    formatted = json.dumps(data, ensure_ascii=False, indent=2).encode()
    assert hashlib.sha256(raw).digest() != hashlib.sha256(formatted).digest()
    assert validate_result_bytes(formatted, **bound).correctionProof == result.correctionProof


def test_initial_recovery_warnings_are_retained(workflow):
    h = workflow(probability=0.5)
    h.source = replace(h.source, source_id=str(uuid4()))
    outcome = pipeline(h).run(h.source)
    result = validate_result_bytes(map_result(outcome, h.settings, **binding(h)))
    assert result.pipelineStatus == "COMPLETED_WITH_WARNINGS"
    assert result.warnings


def test_raw_and_failed_outcomes_never_serialize(workflow):
    h = workflow()
    h.source = replace(h.source, source_id=str(uuid4()))
    outcome = pipeline(h).run(h.source)
    failed = replace(outcome, status=Status.FAILED,
                     failure=OfflineTranscriptionFailure(outcome.completed_stages[-1], "RESOURCE"))
    for value in (failed, AsrCandidate, outcome.result):
        with pytest.raises(ResultValidationError):
            map_result(value, h.settings, **binding(h))


@pytest.mark.parametrize("mutation", ["unknown", "digest", "empty", "unicode", "status", "timing", "warning", "provenance"])
def test_result_validation_fails_closed(workflow, mutation):
    h = workflow()
    h.source = replace(h.source, source_id=str(uuid4()))
    bound = binding(h)
    data = json.loads(map_result(pipeline(h).run(h.source), h.settings, **bound))
    if mutation == "unknown":
        data["rawCandidate"] = "sensitive raw ASR"
    elif mutation == "digest":
        data["correctionProof"]["outputSha256"] = "0" * 64
    elif mutation == "empty":
        data["segments"] = []
    elif mutation == "unicode":
        data["segments"][0]["text"] = "bad\ud800"
    elif mutation == "status":
        data["pipelineStatus"] = "FAILED"
    elif mutation == "timing":
        data["segments"][0]["startMs"] = True
    elif mutation == "warning":
        data["warnings"] = [{"stage": "ASR", "code": "provider private diagnostic", "startSample": None,
                             "endSample": None, "sourceChunkIds": [], "phase": None}]
    elif mutation == "provenance":
        data["provenance"]["models"][0]["requestedModel"] = "https://secret.example/key"
    with pytest.raises(ResultValidationError):
        validate_result_bytes(json.dumps(data).encode(), **bound)
