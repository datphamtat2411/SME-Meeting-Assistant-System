"""Task 03 V6 -> unchanged worker/Core V1 contract with offline infrastructure."""

import asyncio
import json
from fractions import Fraction
from pathlib import Path

import pytest
from integration.test_correction_v6_pipeline import (
    PRIVATE,
    TEXTS,
    independent_edits,
    response,
    v6_pipeline,
)
from integration.test_correction_v6_pipeline import (
    offline_environment as offline_environment,
)
from integration.test_correction_v6_pipeline import v6_workflow as v6_workflow
from integration.test_offline_transcription_pipeline import assert_released, pipeline
from integration.test_offline_transcription_pipeline import workflow as workflow
from integration.test_transcription_worker_integration import Delivery, cleanup, setup
from unit.test_correction_v6 import edit

from sme_meeting_ai.pipeline.offline_transcription import (
    OfflineTranscriptionStatus as Status,
)
from sme_meeting_ai.transcription import correction_v6_pipeline as bridge
from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrUsage,
)
from sme_meeting_ai.transcription.correction import (
    CorrectionErrorCategory,
    CorrectionProviderResponse,
)
from sme_meeting_ai.transcription.correction_v6 import V6EditResult
from sme_meeting_ai.transcription.correction_v6_generation import (
    V6GenerationError,
    V6GenerationReason,
)
from sme_meeting_ai.workers.transcription import (
    ResultValidationError,
    correction_digest,
    map_result,
    pipeline_failure,
    validate_result_bytes,
)

MEDIA = "22222222-2222-4222-8222-222222222222"
BINDING = dict(job_id="11111111-1111-4111-8111-111111111111", media_id=MEDIA,
               source_revision="a" * 64, producer_id="33333333-3333-4333-8333-333333333333")
ROOT_FIELDS = {
    "contractVersion", "resultType", "processingJobId", "sourceMediaId", "sourceRevision", "producerStageRunId",
    "pipelineStatus", "languageCode", "sampleRateHz", "sampleCount", "durationMs", "segments", "coverage",
    "warnings", "provenance", "correctionProof",
}


def assert_worker_resources_released(h, runtime):
    # ObjectStorage retains its shared, empty base directory; each instance root,
    # download, normalized artifact and speech-evidence artifact must be gone.
    base = h.work / "sme-transcription-worker"
    assert list(h.work.iterdir()) == [base]
    assert list(base.iterdir()) == []
    assert all(not Path(artifact._temporary.name).exists() for artifact in h.artifacts)
    assert all(not source.path.exists() for source in runtime.calls)
    assert h.source.path.read_bytes() == b"original media remains recoverable"


@pytest.mark.parametrize("reject", [False, True])
def test_v6_mapping_proof_and_serialization_keep_exact_existing_contract(v6_workflow, reject):
    h = v6_workflow(source_id=MEDIA, entries=independent_edits(reject=reject), count=4095)
    outcome = v6_pipeline(h).run(h.source)
    raw = map_result(outcome, h.settings, **BINDING)
    wire = validate_result_bytes(raw, **BINDING)
    data = json.loads(raw)
    assert set(data) == ROOT_FIELDS
    assert data["resultType"] == "CORRECTED_TRANSCRIPT" and data["contractVersion"] == "1.0"
    assert {k: data[k] for k in ("processingJobId", "sourceMediaId", "sourceRevision", "producerStageRunId")} == {
        "processingJobId": BINDING["job_id"], "sourceMediaId": MEDIA,
        "sourceRevision": BINDING["source_revision"], "producerStageRunId": BINDING["producer_id"],
    }
    assert wire.sampleRateHz == 16000 and wire.sampleCount == 4095 and wire.durationMs == 256
    assert [(s.ordinal, s.startMs, s.endMs) for s in wire.segments] == [(0, 0, 128), (1, 128, 256)]
    assert [s.text for s in wire.segments] == [s.text for s in outcome.result.segments]
    assert all(s.qualityStatus == "ACCEPTED" for s in wire.segments)
    assert all(r.coverageStatus == "COVERED" and not r.recovered and r.retryCount == 0 for r in wire.coverage)
    assert wire.correctionProof.contextScope == "WHOLE_MEETING"
    assert wire.correctionProof.promptVersion == "vi-whole-meeting-6.0"
    assert wire.correctionProof.outputSha256 == correction_digest(data["segments"])
    assert map_result(outcome, h.settings, **BINDING) == raw
    assert validate_result_bytes(json.dumps(data, indent=2).encode(), **BINDING).correctionProof == wire.correctionProof
    assert {c.name: c.version for c in wire.provenance.components}["correction"] == "5"
    assert any(m.role == "CORRECTION" and m.resolvedModel == "test/resolved-v6" for m in wire.provenance.models)
    assert wire.pipelineStatus == ("COMPLETED_WITH_WARNINGS" if reject else "COMPLETED")
    assert [(w.stage, w.code) for w in wire.warnings] == (
        [("CORRECTION", "completed-with-warnings")] if reject else []
    )
    for forbidden in ("proposed_edit_count", "accepted_edit_count", "rejected_edit_count", "rejected_segment_count",
                      "rejection_reason_counts", "unsafe_length_change", "effective_configuration", "alternatives"):
        assert forbidden not in raw.decode()
    assert all(set(s) == {"ordinal", "startMs", "endMs", "text", "qualityStatus"} for s in data["segments"])
    assert_released(h)


def test_all_rejected_or_valid_empty_proposals_still_publish_validated_results(v6_workflow):
    for entries in ([], [edit("vâng vâng", "vâng")]):
        h = v6_workflow(source_id=MEDIA, entries=entries)
        outcome = v6_pipeline(h).run(h.source)
        wire = validate_result_bytes(map_result(outcome, h.settings, **BINDING), **BINDING)
        assert tuple(s.text for s in wire.segments) == TEXTS
        assert wire.pipelineStatus == ("COMPLETED_WITH_WARNINGS" if entries else "COMPLETED")
        assert outcome.provenance.correction.accepted_edit_count == 0
        assert h.correction_calls == 1
        assert_released(h)


def test_upstream_unresolved_quality_and_recovery_evidence_are_not_upgraded(v6_workflow):
    h = v6_workflow(source_id=MEDIA, probability=0.5)

    def observed(audio):
        if audio.chunk_id != "chunk-000000":
            raise AsrError(AsrErrorCategory.TIMEOUT)
        text = TEXTS[0]
        return AsrCandidate(text, (AsrSegment(Fraction(0), audio.duration, text),), AsrQualityMetadata(),
                             AsrUsage(), AsrProvenance("openrouter", "openai/whisper-large-v3"), audio.chunk_id)

    h.asr_callback = observed
    outcome = v6_pipeline(h).run(h.source)
    assessment = outcome.evidence.coverage
    original = tuple(assessment.regions)
    wire = validate_result_bytes(map_result(outcome, h.settings, **BINDING), **BINDING)
    assert wire.pipelineStatus == "COMPLETED_WITH_WARNINGS"
    assert all(s.qualityStatus == "UNRESOLVED" for s in wire.segments)
    assert [(r.coverageStatus, r.recovered) for r in wire.coverage] == [(r.state.value, False) for r in original]
    assert any(w.stage == "CORRECTION" and w.code == "completed-with-warnings" for w in wire.warnings)
    assert outcome.result.coverage is assessment and assessment.regions == original
    assert outcome.evidence.recovery.attempts and all(a.failure for a in outcome.evidence.recovery.attempts)
    assert_released(h)


def test_admitted_recovery_is_preserved_through_v6_worker_mapping(v6_workflow):
    h = v6_workflow(source_id=MEDIA, audio_asr_recovery_max_total_attempts=1)
    transcribe = h.asr_callback

    def observed(audio):
        if audio.chunk_id == "chunk-000001":
            raise AsrError(AsrErrorCategory.TIMEOUT)
        return transcribe(audio)

    h.asr_callback = observed
    outcome = v6_pipeline(h).run(h.source)
    wire = validate_result_bytes(map_result(outcome, h.settings, **BINDING), **BINDING)
    assert any(r.recovered and r.retryCount == 1 for r in wire.coverage)
    assert outcome.evidence.recovery.provenance.accepted_attempt_count == 1
    assert outcome.result.coverage is outcome.evidence.recovery.final_assessment
    assert h.correction_calls == 1
    assert_released(h)


@pytest.mark.parametrize("mutation", ["digest", "status", "coverage", "identity", "unknown", "warning"])
def test_unchanged_worker_validator_rejects_corrupt_v6_results(v6_workflow, mutation):
    h = v6_workflow(source_id=MEDIA, entries=independent_edits(reject=True))
    data = json.loads(map_result(v6_pipeline(h).run(h.source), h.settings, **BINDING))
    if mutation == "digest":
        data["segments"][0]["text"] += "changed"
    elif mutation == "status":
        data["pipelineStatus"] = "COMPLETED"
    elif mutation == "coverage":
        data["coverage"][0]["coverageStatus"] = "UNRESOLVED_ERROR"
    elif mutation == "identity":
        data["producerStageRunId"] = MEDIA
    elif mutation == "unknown":
        data["provenance"]["rejectedEditCount"] = 1
    else:
        data["warnings"][0]["code"] = "unsafe_length_change"
    with pytest.raises(ResultValidationError):
        validate_result_bytes(json.dumps(data).encode(), **BINDING)
    assert_released(h)


@pytest.mark.parametrize("kind", ["malformed", "global", "construction"])
def test_failed_correction_never_reaches_mapping_and_keeps_safe_prefix(v6_workflow, monkeypatch, kind):
    h = v6_workflow(source_id=MEDIA)
    if kind == "malformed":
        h.correction_callback = lambda request: CorrectionProviderResponse(PRIVATE, "fake", request.model)
    elif kind == "global":
        h.correction_callback = lambda request: response(request, [edit(TEXTS[0], "tóm tắt")])
    else:
        monkeypatch.setattr(bridge, "apply_v6_edits", lambda *a, **k: V6EditResult((), 0, 0, 0, 0, {}))
    outcome = v6_pipeline(h).run(h.source)
    assert outcome.status is Status.FAILED and outcome.result is None
    with pytest.raises(ResultValidationError):
        map_result(outcome, h.settings, **BINDING)
    failure = pipeline_failure(outcome)
    assert failure.phase == "CORRECTION" and failure.completed_through == "RECONCILIATION"
    assert failure.category == {"malformed": "MALFORMED_OUTPUT", "global": "SUSPICIOUS_OUTPUT",
                                "construction": "VALIDATION"}[kind]
    assert set(failure.metrics) == {"sampleCount", "warningCount", "unresolvedRegionCount"}
    assert not hasattr(failure, "reason")
    assert PRIVATE not in repr(failure.metrics)
    assert_released(h)


def test_v5_and_v6_worker_envelopes_have_the_same_schema(workflow, v6_workflow):
    h5, h6 = workflow(source_id=MEDIA), v6_workflow(source_id=MEDIA)
    v5 = json.loads(map_result(pipeline(h5).run(h5.source), h5.settings, **BINDING))
    v6 = json.loads(map_result(v6_pipeline(h6).run(h6.source), h6.settings, **BINDING))
    assert set(v5) == set(v6) == ROOT_FIELDS
    for field in ("segments", "coverage", "warnings"):
        assert [set(item) for item in v5[field]] == [set(item) for item in v6[field]]
    assert set(v5["provenance"]) == set(v6["provenance"])
    assert set(v5["correctionProof"]) == set(v6["correctionProof"])
    assert_released(h5)
    assert_released(h6)


@pytest.mark.parametrize("reject", [False, True])
def test_mocked_worker_core_storage_accepts_v6_once_and_replays_receipt(v6_workflow, reject):
    async def run():
        h = v6_workflow(entries=independent_edits(reject=reject))
        selected = v6_pipeline(h)
        r = await setup(h, run=selected.run)
        try:
            delivery = Delivery(r.body)
            await r.worker.handle(delivery)
            assert delivery.actions == ["ack"]
            assert r.core.state == "RESULT_ACCEPTED" and len(r.core.transcripts) == len(r.s3.objects) == 1
            assert not r.core.failures
            raw = next(iter(r.s3.objects.values()))
            wire = validate_result_bytes(raw, job_id=r.body["processingJobId"], media_id=r.body["sourceMediaId"],
                                         source_revision=r.core.claim["source"]["sourceRevision"],
                                         producer_id=r.core.claim["executionStageRunId"])
            assert wire.correctionProof.promptVersion == "vi-whole-meeting-6.0"
            assert wire.pipelineStatus == ("COMPLETED_WITH_WARNINGS" if reject else "COMPLETED")
            receipt = r.core.receipt.copy()
            duplicate = Delivery(r.body, 1)
            await r.worker.handle(duplicate)
            assert duplicate.actions == ["ack"] and r.core.receipt == receipt
            assert len(r.calls) == len(r.core.transcripts) == h.correction_calls == 1
        finally:
            await cleanup(r)
        assert_worker_resources_released(h, r)
    asyncio.run(run())


@pytest.mark.parametrize("kind,category,reason", [
    ("malformed", "MALFORMED_OUTPUT", "invalid_correction_json"),
    ("global", "SUSPICIOUS_OUTPUT", "proposal_integrity"),
    ("auth", "AUTHENTICATION", "authentication_failed"),
    ("timeout", "TIMEOUT", "deadline_exceeded"),
])
def test_mocked_worker_failure_has_no_result_storage_or_unapproved_diagnostics(v6_workflow, kind, category, reason):
    async def run():
        h = v6_workflow()
        outcomes = []

        def complete(request):
            if kind in ("auth", "timeout"):
                raise V6GenerationError(
                    CorrectionErrorCategory.AUTHENTICATION if kind == "auth" else CorrectionErrorCategory.TIMEOUT,
                    V6GenerationReason.AUTHENTICATION_FAILED if kind == "auth" else V6GenerationReason.DEADLINE_EXCEEDED,
                )
            if kind == "malformed":
                return CorrectionProviderResponse(PRIVATE, "fake", request.model)
            return response(request, [edit(TEXTS[0], "tóm tắt")])

        h.correction_callback = complete
        selected = v6_pipeline(h)

        def execute(source):
            result = selected.run(source)
            outcomes.append(result)
            return result

        r = await setup(h, run=execute)
        try:
            delivery = Delivery(r.body)
            await r.worker.handle(delivery)
            assert delivery.actions == ["ack"] and r.core.state == "FAILURE_RECORDED"
            assert not r.s3.objects and not r.core.transcripts
            assert len(r.core.failures) == 1
            command = r.core.failures[0]
            assert command["phase"] == "CORRECTION" and command["category"] == category
            assert command["completedThrough"] == "RECONCILIATION"
            assert set(command) == {"contractVersion", "eventId", "generation", "executionStageRunId", "claimToken",
                                    "commandId", "phase", "category", "completedThrough", "metrics"}
            assert outcomes[0].failure.reason == reason and outcomes[0].result is None
            assert "reason" not in command and PRIVATE not in json.dumps(command)
            assert h.correction_calls == (1 if kind in ("auth", "global") else 2)
        finally:
            await cleanup(r)
        assert_worker_resources_released(h, r)
    asyncio.run(run())
