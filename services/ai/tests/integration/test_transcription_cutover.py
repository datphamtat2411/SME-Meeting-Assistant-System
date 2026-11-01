"""T08 real production composition → unchanged publication; synthetic inputs only."""

import asyncio
import json
import socket
from concurrent.futures import CancelledError
from fractions import Fraction

import pytest
from test_offline_transcription_pipeline import (
    PRIVATE,
    assert_released,
    enable_v2,
    pipeline,
    workflow,
)

from sme_meeting_ai.pipeline import OfflineTranscriptionStatus
from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrUsage,
)
from sme_meeting_ai.transcription.correction import CorrectionProviderResponse
from sme_meeting_ai.workers.transcription import (
    ResultValidationError,
    map_result,
    validate_result_bytes,
)

__all__ = ["workflow"]
MEDIA = "22222222-2222-4222-8222-222222222222"
IDS = dict(job_id="11111111-1111-4111-8111-111111111111", media_id=MEDIA,
           source_revision="a" * 64, producer_id="33333333-3333-4333-8333-333333333333")


@pytest.fixture(autouse=True)
def deterministic_only(monkeypatch):
    monkeypatch.setattr(socket.socket, "connect", lambda *a: pytest.fail("network in deterministic E2E"))


@pytest.mark.parametrize("mode,eligible,fallback", [("chunked", True, False), ("adaptive", True, False),
                                                   ("adaptive", False, False), ("adaptive", True, True)])
def test_r01_r08_r34_full_composition_publication(workflow, monkeypatch, caplog, mode, eligible, fallback):
    h = workflow(source_id=MEDIA, audio_asr_strategy_mode=mode,
                 audio_asr_native_max_samples=10000 if eligible else 1)
    enable_v2(h, monkeypatch)
    calls = []
    original = h.preprocessing.run
    def preprocess(source):
        calls.append(source)
        return original(source)
    monkeypatch.setattr(h.preprocessing, "run", preprocess)
    if fallback:
        def respond(audio):
            if len(h.asr_calls) == 1:
                raise AsrError(AsrErrorCategory.TIMEOUT)
        h.asr_callback = respond
    outcome = pipeline(h).run(h.source)
    raw = map_result(outcome, h.settings, **IDS)
    envelope = validate_result_bytes(raw, **IDS)
    assert len(calls) == 1 and calls[0] is h.source
    assert envelope.contractVersion == "1.0" and envelope.resultType == "CORRECTED_TRANSCRIPT"
    assert envelope.sampleRateHz == 16000 and envelope.sampleCount == 4096 and envelope.durationMs == 256
    assert envelope.sourceMediaId == MEDIA and envelope.sourceRevision == IDS["source_revision"]
    assert [s.ordinal for s in envelope.segments] == list(range(len(envelope.segments)))
    assert all(0 <= s.interval.start_sample < s.interval.end_sample <= 4096 for s in outcome.result.segments)
    assert outcome.result.coverage is outcome.evidence.coverage is outcome.evidence.recovery.final_assessment
    assert outcome.provenance.coverage.assessment_phase.value == "final-canonical"
    assert all(getattr(outcome.provenance, name) is not None for name in
               ("preprocessing", "planning", "asr", "reconciliation", "coverage", "recovery", "correction", "strategy"))
    t = outcome.provenance.strategy
    assert t.total_actual_asr_calls == len(h.asr_calls) == t.native_attempts + t.chunked_baseline_calls + t.recovery_calls
    assert t.fallback_used is fallback
    assert t.native_attempts == int(mode == "adaptive" and eligible)
    assert bool(outcome.evidence.asr.boundary_alignment) == (mode == "chunked" or not eligible or fallback)
    assert envelope.correctionProof.outputSha256
    assert_released(h)
    assert PRIVATE not in caplog.text


@pytest.mark.parametrize("damage", ["proof", "digest", "ordering", "source", "coverage", "unresolved", "suspicious", "recovered", "status", "contract"])
def test_r35_r37_r52_r53_publication_corruptions_fail_closed(workflow, damage):
    h = workflow(source_id=MEDIA, probability=0.5)
    outcome = pipeline(h).run(h.source)
    raw = json.loads(map_result(outcome, h.settings, **IDS))
    if damage == "proof":
        del raw["correctionProof"]
    elif damage == "digest":
        raw["correctionProof"]["outputSha256"] = "0" * 64
    elif damage == "ordering":
        raw["segments"][0]["ordinal"] = 20
    elif damage == "source":
        raw["sourceMediaId"] = IDS["job_id"]
    elif damage == "coverage":
        raw["coverage"] = []
    elif damage in ("unresolved", "suspicious"):
        raw["coverage"][0]["coverageStatus"] = "UNRESOLVED_ERROR" if damage == "unresolved" else "SUSPICIOUS"
        raw["segments"][0]["qualityStatus"] = "ACCEPTED"
    elif damage == "recovered":
        raw["coverage"][0].update(recovered=True, retryCount=0)
    elif damage == "status":
        raw["pipelineStatus"] = "COMPLETED"
    else:
        raw["contractVersion"] = "2.0"
    with pytest.raises(ResultValidationError):
        validate_result_bytes(json.dumps(raw).encode(), **IDS)
    assert_released(h)


@pytest.mark.parametrize("rewrite", ["unrelated", "expansion", "delete", "new-segment"])
def test_r31_r33_correction_cannot_replace_canonical_evidence(workflow, rewrite):
    h = workflow(source_id=MEDIA)
    def bad(request):
        entries = json.loads(request.transcript_json)["segments"]
        output = [{k: e[k] for k in ("segment_id", "ordinal", "text")} for e in entries]
        if rewrite == "delete":
            output.pop()
        elif rewrite == "new-segment":
            output.append({"segment_id": "segment-999999", "ordinal": 2, "text": "Invented missing speech"})
        else:
            output[0]["text"] = "unrelated inserted words" if rewrite == "unrelated" else "invented speech " * 50
        return CorrectionProviderResponse(json.dumps({"segments": output}), "fake", request.model)
    h.correction_callback = bad
    outcome = pipeline(h).run(h.source)
    assert outcome.status is OfflineTranscriptionStatus.FAILED and outcome.result is None
    assert h.correction_calls == 2
    with pytest.raises(ResultValidationError):
        map_result(outcome, h.settings, **IDS)
    assert_released(h)


def test_r54_r55_r60_r61_rollback_is_new_execution_configuration(workflow, monkeypatch):
    h = workflow(source_id=MEDIA)
    assert h.settings.audio_asr_strategy_mode == "chunked"
    enable_v2(h, monkeypatch)
    h.settings.audio_asr_strategy_mode = "adaptive"
    active = pipeline(h)
    previous_settings = h.settings.model_copy(deep=True)
    previous = active.run(h.source)
    published = map_result(previous, previous_settings, **IDS)
    h.settings.audio_asr_strategy_mode = "chunked"
    # Existing runner configuration is snapshotted; replacement workers use rollback.
    still_active = active.run(h.source)
    rolled_back = pipeline(h).run(h.source)
    assert previous.provenance.strategy.native_attempts == still_active.provenance.strategy.native_attempts == 1
    assert rolled_back.provenance.strategy.native_attempts == 0
    assert rolled_back.provenance.strategy.selected_strategy.value == "chunked"
    assert published == map_result(previous, previous_settings, **IDS)
    validate_result_bytes(published, **IDS)
    assert_released(h)


def test_r12_r15_genuine_repeated_native_utterances_and_technical_tokens(workflow, monkeypatch):
    h = workflow(source_id=MEDIA, audio_asr_strategy_mode="adaptive")
    enable_v2(h, monkeypatch)
    def repeated(audio):
        wording = "Đúng đúng API C++ v2.1"
        return AsrCandidate(wording, (
            AsrSegment(Fraction(0), Fraction(2048, 16000), wording),
            AsrSegment(Fraction(2048, 16000), Fraction(4096, 16000), wording)),
            AsrQualityMetadata(), AsrUsage(), AsrProvenance("openrouter", "openai/whisper-large-v3"), audio.chunk_id)
    h.asr_callback = repeated
    outcome = pipeline(h).run(h.source)
    assert [s.text for s in outcome.result.segments] == ["Đúng đúng API C++ v2.1."] * 2
    assert outcome.provenance.strategy.native_attempts == 1
    validate_result_bytes(map_result(outcome, h.settings, **IDS), **IDS)
    assert_released(h)


@pytest.mark.parametrize("exception", [CancelledError, asyncio.CancelledError, KeyboardInterrupt])
@pytest.mark.parametrize("stage", ["asr", "correction"])
def test_r49_r50_cancelled_provider_diagnostics_are_private(workflow, exception, stage, caplog):
    h = workflow(source_id=MEDIA)
    cancellation = exception(PRIVATE)
    def cancel(*args):
        raise cancellation
    if stage == "asr":
        h.asr_callback = cancel
    else:
        h.correction_callback = cancel
    with pytest.raises(exception) as caught:
        pipeline(h).run(h.source)
    assert caught.value is cancellation
    assert PRIVATE not in str(caught.value) + caplog.text
    assert_released(h)


def test_boundary_spanning_canonical_uncertainty_is_not_upgraded_for_publication(workflow):
    h = workflow(source_id=MEDIA)
    def observed(audio):
        if audio.chunk_id != "chunk-000000":
            raise AsrError(AsrErrorCategory.AUTHENTICATION)
        wording = "Kiểm tra API-v2 với Kubernetes"
        return AsrCandidate(wording, (AsrSegment(Fraction(0), audio.duration, wording),),
                            AsrQualityMetadata(), AsrUsage(), AsrProvenance("openrouter", "openai/whisper-large-v3"), audio.chunk_id)
    h.asr_callback = observed
    outcome = pipeline(h).run(h.source)
    assert outcome.failure is None and len(outcome.result.segments) == 1
    assert "unresolved-boundary" in {flag.value for flag in outcome.result.segments[0].flags}
    assert {r.state.value for r in outcome.result.coverage.regions} == {"SUSPICIOUS", "UNRESOLVED_ERROR"}
    result = validate_result_bytes(map_result(outcome, h.settings, **IDS), **IDS)
    assert result.pipelineStatus == "COMPLETED_WITH_WARNINGS"
    assert result.segments[0].qualityStatus == "UNRESOLVED"
    assert {r.coverageStatus for r in result.coverage} == {"SUSPICIOUS", "UNRESOLVED_ERROR"}
    assert outcome.result.coverage is outcome.evidence.coverage
    assert_released(h)
