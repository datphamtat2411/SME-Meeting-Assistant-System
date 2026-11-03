"""Offline V6.1 composition and unchanged worker/Core contract; no live discovery."""

import asyncio
import json
import traceback
from concurrent.futures import CancelledError
from dataclasses import FrozenInstanceError, replace
from types import SimpleNamespace

import httpx
import pytest
from integration.test_correction_v6_pipeline import USAGE, response
from integration.test_correction_v6_pipeline import v6_workflow as span_workflow
from integration.test_correction_v6_worker import (
    BINDING,
    MEDIA,
    ROOT_FIELDS,
    assert_worker_resources_released,
)
from integration.test_offline_transcription_pipeline import assert_released
from integration.test_offline_transcription_pipeline import workflow as workflow
from integration.test_transcription_worker_integration import Delivery, cleanup, setup
from unit.test_correction import Provider, configuration, meeting
from unit.test_correction_v6 import edit
from unit.test_correction_v6 import offline_environment as offline_environment

from sme_meeting_ai.audio import AudioProcessingError, SampleInterval
from sme_meeting_ai.pipeline import OfflineTranscriptionPipeline
from sme_meeting_ai.pipeline.offline_transcription import (
    OfflineTranscriptionStage as Stage,
)
from sme_meeting_ai.pipeline.offline_transcription import (
    OfflineTranscriptionStatus as Status,
)
from sme_meeting_ai.providers.openrouter_instruction_llm_v61 import (
    OpenRouterInstructionLlmV61Adapter,
)
from sme_meeting_ai.transcription import correction_v6_pipeline as v6_bridge
from sme_meeting_ai.transcription import correction_v61_pipeline as bridge
from sme_meeting_ai.transcription.asr import AsrError, AsrErrorCategory
from sme_meeting_ai.transcription.correction import (
    CorrectionProvenance,
    CorrectionProviderResponse,
    CorrectionUsage,
    TranscriptCorrectionStatus,
)
from sme_meeting_ai.transcription.correction_v6 import (
    CORRECTION_V6_JSON_SCHEMA,
    CORRECTION_V6_SCHEMA_NAME,
    V6EditResult,
)
from sme_meeting_ai.transcription.correction_v6_generation import (
    V6_SYSTEM_PROMPT,
    V6CorrectionRequest,
)
from sme_meeting_ai.transcription.correction_v61 import V61_ENGINE_VERSION
from sme_meeting_ai.transcription.correction_v61_generation import (
    V61_PROMPT_VERSION,
    V61_SYSTEM_PROMPT,
)
from sme_meeting_ai.transcription.reconciliation import ReconciliationFlag
from sme_meeting_ai.workers.transcription import (
    ResultValidationError,
    correction_digest,
    map_result,
    validate_result_bytes,
)

__all__ = ["span_workflow"]

TEXTS = (
    "trong buổi họp hôm nay nhóm bàn về cảnh quay và sai cái rapport của phim "
    "khi gương mặt mà nó bị chày chuỗi",
    "nhóm cùng kiểm tra cảnh hành động bắn dụng và con dòng trong phim "
    "rồi kể đoạn đứt như chằn chắn vào buổi chiều",
)
PRIVATE = "synthetic-private-diagnostics-never-publish"
LEGACY_REASONS = (
    "unresolvable_span", "overlap_conflict", "partial_token", "noop_edit",
    "protected_token", "unsafe_expansion", "unsafe_length_change", "unsupported_lexical_change",
)
NEW_REASONS = (
    "insufficient_lexical_similarity", "unsupported_phrase_alignment",
    "insufficient_context_evidence", "unsafe_phrase_contraction",
)


def proposals(*, reject=False):
    entries = [edit("rapport", "raccord"), edit("chày chuỗi", "trầy xước"),
               edit("bắn dụng", "bắn rụng", segment=1), edit("con dòng", "con rồng", segment=1)]
    if reject:
        entries.append(edit("đứt như chằn chắn", "đứt dây chằng", segment=1))
    return entries


@pytest.fixture
def v61_workflow(span_workflow):
    def make(*, entries=(), texts=TEXTS, **kwargs):
        h = span_workflow(entries=entries, texts=texts, **kwargs)

        def complete(request):
            h.requests.append(request)
            return replace(response(request, entries), resolved_model="test/resolved-v61")

        h.correction_callback = complete
        return h
    return make


def selected_pipeline(h, mode="v61_edits"):
    return OfflineTranscriptionPipeline(h.preprocessing, h.planner, h.transcriber, h.corrector,
                                        h.settings, correction_mode=mode)


def test_v61_composes_exact_generator_and_validator_once_from_original(v61_workflow, monkeypatch):
    h = v61_workflow(entries=proposals(), transcript_correction_reasoning_effort="medium")
    generations, applications = [], []
    generate, apply = bridge.generate_v61_proposal, bridge.apply_v61_edits

    def generation(*args):
        value = generate(*args)
        generations.append((args[0], value.result))
        return value

    def application(*args, **kwargs):
        value = apply(*args, **kwargs)
        applications.append((args, kwargs, value))
        return value

    monkeypatch.setattr(bridge, "generate_v61_proposal", generation)
    monkeypatch.setattr(bridge, "apply_v61_edits", application)
    monkeypatch.setattr(v6_bridge, "generate_v6_proposal", lambda *a: pytest.fail("V6 generation used"))
    monkeypatch.setattr(v6_bridge, "apply_v6_edits", lambda *a, **k: pytest.fail("V6 engine used"))
    outcome = selected_pipeline(h).run(h.source)
    assert outcome.status is Status.COMPLETED and outcome.completed_stages == tuple(Stage)
    assert len(generations) == len(applications) == h.correction_calls == 1
    canonical, generation_result = generations[0]
    args, limits, engine_result = applications[0]
    assert args[0] is canonical and args[1] is generation_result.proposal
    assert limits == {"min_text_ratio": 0.65, "max_text_ratio": 1.5}
    request, = h.requests
    assert isinstance(request, V6CorrectionRequest) and request.system_prompt == V61_SYSTEM_PROMPT
    assert request.reasoning_effort == "medium"
    assert tuple(s["text"] for s in json.loads(request.transcript_json)["segments"]) == TEXTS
    assert tuple(s.text for s in canonical.segments) == TEXTS
    assert tuple(s.text for s in outcome.result.segments) == engine_result.texts
    assert engine_result.texts == (
        TEXTS[0].replace("rapport", "raccord").replace("chày chuỗi", "trầy xước"),
        TEXTS[1].replace("bắn dụng", "bắn rụng").replace("con dòng", "con rồng"),
    )
    for original, final in zip(canonical.segments, outcome.result.segments, strict=True):
        for field in ("segment_id", "ordinal", "interval", "source_chunk_ids", "flags"):
            assert getattr(original, field) == getattr(final, field)
    assert outcome.result.coverage is outcome.evidence.coverage is outcome.evidence.recovery.final_assessment
    assert outcome.result.unresolved_intervals == canonical.unresolved_intervals
    p = outcome.result.provenance
    assert (p.correction_version, p.prompt_version) == ("6.1", V61_PROMPT_VERSION)
    assert dict(p.effective_configuration) == {
        **generation_result.effective_configuration, "correction_mode": "v61_edits",
        "schema_name": CORRECTION_V6_SCHEMA_NAME, "validator_version": V61_ENGINE_VERSION,
    }
    assert p.provider == "fake" and p.requested_model == request.model
    assert p.resolved_model == "test/resolved-v61" and p.usage is USAGE and p.attempts == 1
    assert p.proposed_edit_count == p.accepted_edit_count == 4
    assert p.rejected_edit_count == p.rejected_segment_count == 0
    assert h.asr_calls == ["chunk-000000", "chunk-000001"]
    assert_released(h)


@pytest.mark.parametrize("entries,accepted,reasons", [
    ([], 0, {}), (proposals(reject=True), 4, {"unsafe_phrase_contraction": 1}),
    ([edit("đứt như chằn chắn", "đứt dây chằng", segment=1)], 0, {"unsafe_phrase_contraction": 1}),
])
def test_empty_and_independent_local_rejections_do_not_retry_or_publish_rejections(v61_workflow, entries, accepted, reasons):
    h = v61_workflow(entries=entries)
    outcome = selected_pipeline(h).run(h.source)
    assert outcome.status is (Status.COMPLETED_WITH_WARNINGS if reasons else Status.COMPLETED)
    assert outcome.failure is None and outcome.result is not None
    p = outcome.result.provenance
    assert p.proposed_edit_count == len(entries) == p.accepted_edit_count + p.rejected_edit_count
    assert p.accepted_edit_count == accepted and dict(p.rejection_reason_counts) == reasons
    assert p.rejected_edit_count == sum(reasons.values()) == p.rejected_segment_count
    assert "đứt như chằn chắn" in outcome.result.segments[1].text
    assert "đứt dây chằng" not in outcome.result.segments[1].text
    if not accepted:
        assert tuple(s.text for s in outcome.result.segments) == TEXTS
    else:
        assert "raccord" in outcome.result.segments[0].text and "trầy xước" in outcome.result.segments[0].text
    assert h.correction_calls == 1
    assert_released(h)


@pytest.mark.parametrize("mode,prompt,version", [
    (None, "vi-whole-meeting-5.3", "4"), ("v5_full", "vi-whole-meeting-5.3", "4"),
    ("v6_edits", "vi-whole-meeting-6.0", "5"), ("v61_edits", V61_PROMPT_VERSION, "6.1"),
])
def test_selection_is_explicit_and_default_stays_v53(v61_workflow, mode, prompt, version):
    h = v61_workflow()

    def complete(request):
        h.requests.append(request)
        if mode in (None, "v5_full"):
            entries = json.loads(request.transcript_json)["segments"]
            content = {"segments": [{k: s[k] for k in ("segment_id", "ordinal", "text")} for s in entries]}
            return CorrectionProviderResponse(json.dumps(content), "fake", request.model)
        assert request.system_prompt == (V6_SYSTEM_PROMPT if mode == "v6_edits" else V61_SYSTEM_PROMPT)
        return response(request)

    h.correction_callback = complete
    pipeline = (OfflineTranscriptionPipeline(h.preprocessing, h.planner, h.transcriber, h.corrector, h.settings)
                if mode is None else selected_pipeline(h, mode))
    outcome = pipeline.run(h.source)
    assert outcome.status is Status.COMPLETED
    assert outcome.provenance.correction.prompt_version == prompt
    assert outcome.provenance.correction.correction_version == version
    assert h.correction_calls == 1
    assert_released(h)


@pytest.mark.parametrize("mode", ["v61", "V61_EDITS", "", None, True, [], PRIVATE])
def test_invalid_selection_fails_at_construction(v61_workflow, mode):
    h = v61_workflow()
    with pytest.raises(AudioProcessingError):
        selected_pipeline(h, mode)
    assert h.correction_calls == 0 and not h.asr_calls and not h.artifacts


@pytest.mark.parametrize("kind,category,reason", [
    ("provider", "PROVIDER", "provider_failure"), ("auth", "AUTHENTICATION", "http_request_rejected"),
    ("json", "MALFORMED_OUTPUT", "invalid_correction_json"),
    ("schema", "MALFORMED_OUTPUT", "invalid_correction_schema"),
    ("global", "SUSPICIOUS_OUTPUT", "proposal_integrity"),
])
def test_real_adapter_failures_are_terminal_sanitized_and_never_fallback(v61_workflow, caplog, kind, category, reason):
    h = v61_workflow(OPENROUTER_API_KEY="synthetic-only", transcript_correction_max_attempts=1)
    calls = []

    def handle(request):
        calls.append(request)
        body = json.loads(request.content)
        assert body["messages"][0]["content"] == V61_SYSTEM_PROMPT
        assert body["response_format"] == {"type": "json_schema", "json_schema": {
            "name": CORRECTION_V6_SCHEMA_NAME, "strict": True, "schema": CORRECTION_V6_JSON_SCHEMA,
        }}
        if kind == "provider":
            raise RuntimeError(PRIVATE)
        if kind == "auth":
            return httpx.Response(401, content=PRIVATE.encode())
        content = PRIVATE if kind == "json" else json.dumps(
            {"segments": []} if kind == "schema" else {"edits": [edit(TEXTS[0], "tóm tắt")]})
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": content,
        }}]})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with OpenRouterInstructionLlmV61Adapter(h.settings, client) as adapter:
            h.corrector = adapter
            outcome = selected_pipeline(h).run(h.source)
        assert not client.is_closed
    assert len(calls) == 1
    assert outcome.status is Status.FAILED and outcome.result is None
    assert (outcome.failure.category, outcome.failure.reason, outcome.failure.attempts) == (category, reason, 1)
    assert outcome.completed_stages == tuple(Stage)[:-1] and outcome.provenance.correction is None
    assert PRIVATE not in repr(outcome) + caplog.text
    assert_released(h)


def test_final_integrity_failure_discards_all_text_without_retry():
    canonical, coverage = meeting(("aaa aaa", "bbbb bbbb"))
    before = replace(canonical)
    provider = Provider({"edits": [edit("aaa", "Aaa!!"), edit("aaa", "Aaa!!", occurrence=1),
                                   edit("bbbb bbbb", "b", segment=1)]})
    outcome = bridge.correct_transcript_v61(canonical, coverage, provider, configuration(
        transcript_correction_min_text_ratio=0.1, transcript_correction_max_text_ratio=1.1))
    assert outcome.status is TranscriptCorrectionStatus.FAILED and outcome.result is None
    assert outcome.failure.reason == "final_integrity" and outcome.failure.attempts == 1
    assert len(provider.requests) == 1 and canonical == before


@pytest.mark.parametrize("mutation", ["prompt", "schema", "attempts", "type", "texts"])
def test_invalid_generation_or_engine_handoff_cannot_claim_v61(monkeypatch, mutation):
    canonical, coverage = meeting(TEXTS)
    provider = Provider({"edits": []})
    generated = bridge.generate_v61_proposal(canonical, provider, configuration())
    if mutation == "texts":
        monkeypatch.setattr(bridge, "apply_v61_edits", lambda *a, **k: V6EditResult((), 0, 0, 0, 0, {}))
    else:
        updates = {"prompt": {"prompt_version": "vi-whole-meeting-6.0"},
                   "schema": {"schema_name": "other-schema"}, "attempts": {"attempts": True}}
        generated = (SimpleNamespace(result=generated.result) if mutation == "type"
                     else replace(generated, result=replace(generated.result, **updates[mutation])))
        monkeypatch.setattr(bridge, "apply_v61_edits", lambda *a, **k: pytest.fail("invalid generation applied"))
    monkeypatch.setattr(bridge, "generate_v61_proposal", lambda *a: generated)
    outcome = bridge.correct_transcript_v61(canonical, coverage, object(), configuration())
    assert outcome.status is TranscriptCorrectionStatus.FAILED and outcome.result is None
    assert outcome.failure.reason == "invalid_correction_result"


@pytest.mark.parametrize("mutation", ["source", "sample_count", "interval", "chunks", "ordinal"])
def test_untrusted_reconciliation_coverage_never_dispatches(monkeypatch, mutation):
    canonical, coverage = meeting(TEXTS)
    if mutation == "source":
        coverage = replace(coverage, source_id="foreign")
    elif mutation == "sample_count":
        coverage = replace(coverage, sample_count=1)
    else:
        updates = {"interval": {"interval": SampleInterval(0, 999)},
                   "chunks": {"source_chunk_ids": ("foreign",)}, "ordinal": {"ordinal": 10}}
        canonical = replace(canonical, segments=(replace(canonical.segments[0], **updates[mutation]),
                                                 *canonical.segments[1:]))
    monkeypatch.setattr(bridge, "generate_v61_proposal", lambda *a: pytest.fail("untrusted handoff dispatched"))
    outcome = bridge.correct_transcript_v61(canonical, coverage, object(), configuration())
    assert outcome.failure.reason == "invalid_reconciliation" and outcome.failure.attempts == 0


def test_coverage_and_reconciliation_warnings_are_separate_from_edit_rejections():
    canonical, coverage = meeting(TEXTS)
    canonical = replace(canonical, unresolved_intervals=(SampleInterval(1, 2),), segments=(
        replace(canonical.segments[0], flags=(ReconciliationFlag.CONFLICTING_OVERLAP,)), canonical.segments[1]))
    coverage = replace(coverage, unresolved_intervals=(SampleInterval(2, 3),))
    outcome = bridge.correct_transcript_v61(canonical, coverage, Provider({"edits": []}), configuration())
    assert outcome.status is TranscriptCorrectionStatus.COMPLETED_WITH_WARNINGS
    assert outcome.result.coverage is coverage and outcome.result.unresolved_intervals == canonical.unresolved_intervals
    assert outcome.result.segments[0].flags == canonical.segments[0].flags
    assert outcome.result.provenance.rejected_edit_count == 0


@pytest.mark.parametrize("source,replacement,reason", [
    ("configg", "planning", "insufficient_lexical_similarity"),
    ("mạch ngầm", "chiến lược", "unsupported_phrase_alignment"),
    ("micro service chạy", "microservice chạy", "insufficient_context_evidence"),
    ("đứt như chằn chắn", "đứt dây chằng", "unsafe_phrase_contraction"),
])
def test_actual_v61_rejection_vocabulary_survives_canonical_bridge(source, replacement, reason):
    canonical, coverage = meeting((f"nội dung {source} kết thúc", TEXTS[0]))
    outcome = bridge.correct_transcript_v61(
        canonical, coverage, Provider({"edits": [edit(source, replacement)]}), configuration())
    assert outcome.status is TranscriptCorrectionStatus.COMPLETED_WITH_WARNINGS
    assert tuple(s.text for s in outcome.result.segments) == tuple(s.text for s in canonical.segments)
    assert dict(outcome.result.provenance.rejection_reason_counts) == {reason: 1}


@pytest.mark.parametrize("exception", [CancelledError, asyncio.CancelledError, KeyboardInterrupt])
def test_v61_cancellation_preserves_ownership_identity_and_privacy(v61_workflow, exception, caplog):
    h = v61_workflow()
    cancellation = exception(PRIVATE)

    def cancel(request):
        raise cancellation

    h.correction_callback = cancel
    with pytest.raises(exception) as caught:
        selected_pipeline(h).run(h.source)
    assert caught.value is cancellation
    assert PRIVATE not in "".join(traceback.format_exception(caught.value)) + caplog.text
    assert h.correction_calls == 1
    assert_released(h)


def provenance(version="6.1", **updates):
    return CorrectionProvenance(**{
        "correction_version": version, "prompt_version": V61_PROMPT_VERSION, "provider": "fake",
        "requested_model": "test/corrector", "resolved_model": None, "effective_configuration": {},
        "attempts": 1, "usage": CorrectionUsage(), **updates,
    })


@pytest.mark.parametrize("version", ["4", "5", "6.1"])
@pytest.mark.parametrize("reason", LEGACY_REASONS)
def test_existing_reason_vocabulary_remains_valid(version, reason):
    p = provenance(version, proposed_edit_count=1, rejected_edit_count=1, rejected_segment_count=1,
                   rejection_reason_counts={reason: 1})
    assert dict(p.rejection_reason_counts) == {reason: 1}


@pytest.mark.parametrize("version", ["4", "5", "6.1", "future"])
@pytest.mark.parametrize("reason", NEW_REASONS)
def test_v61_only_reasons_are_version_scoped(version, reason):
    kwargs = dict(proposed_edit_count=1, rejected_edit_count=1, rejected_segment_count=1,
                  rejection_reason_counts={reason: 1})
    if version == "6.1":
        assert dict(provenance(version, **kwargs).rejection_reason_counts) == {reason: 1}
    else:
        with pytest.raises(ValueError, match="Invalid correction rejection reasons"):
            provenance(version, **kwargs)


@pytest.mark.parametrize("version", ["4", "5", "6.1"])
@pytest.mark.parametrize("reason", [PRIVATE, "unknown", "raccord", "unsafe_phrase_contraction\n", 1])
def test_unknown_and_transcript_bearing_reason_codes_never_cross_boundary(version, reason):
    with pytest.raises(ValueError) as caught:
        provenance(version, proposed_edit_count=1, rejected_edit_count=1, rejection_reason_counts={reason: 1})
    assert PRIVATE not in str(caught.value)


@pytest.mark.parametrize("updates", [
    {"proposed_edit_count": 1}, {"accepted_edit_count": 1}, {"rejected_segment_count": 1},
    {"proposed_edit_count": 1, "rejected_edit_count": 1},
    {"proposed_edit_count": 1, "rejected_edit_count": 1, "rejected_segment_count": 2,
     "rejection_reason_counts": {"unsafe_phrase_contraction": 1}},
    {"proposed_edit_count": 1, "rejected_edit_count": 1, "rejection_reason_counts": {"noop_edit": 2}},
    {"rejection_reason_counts": {"noop_edit": True}}, {"rejection_reason_counts": {"noop_edit": -1}},
    {"accepted_edit_count": True}, {"rejected_edit_count": 1.0}, {"rejected_segment_count": -1},
])
def test_v61_count_invariants_are_mandatory(updates):
    with pytest.raises(ValueError, match="Invalid"):
        provenance(**updates)


def test_v61_statistics_remain_copied_and_immutable():
    reasons = {"unsafe_phrase_contraction": 1}
    config = {"validator_version": V61_ENGINE_VERSION}
    p = provenance(proposed_edit_count=2, accepted_edit_count=1, rejected_edit_count=1,
                   rejected_segment_count=1, rejection_reason_counts=reasons, effective_configuration=config)
    reasons.clear()
    config.clear()
    assert dict(p.rejection_reason_counts) == {"unsafe_phrase_contraction": 1}
    assert p.effective_configuration["validator_version"] == V61_ENGINE_VERSION
    with pytest.raises(TypeError):
        p.rejection_reason_counts["noop_edit"] = 1
    with pytest.raises(FrozenInstanceError):
        p.accepted_edit_count = 9


@pytest.mark.parametrize("reject", [False, True])
def test_worker_core_v61_mapping_and_proof_preserve_exact_wire_shape(v61_workflow, reject):
    h = v61_workflow(source_id=MEDIA, entries=proposals(reject=reject), count=4095)
    outcome = selected_pipeline(h).run(h.source)
    raw = map_result(outcome, h.settings, **BINDING)
    wire = validate_result_bytes(raw, **BINDING)
    data = json.loads(raw)
    assert set(data) == ROOT_FIELDS
    assert wire.contractVersion == "1.0" and wire.resultType == "CORRECTED_TRANSCRIPT"
    assert wire.correctionProof.contextScope == "WHOLE_MEETING"
    assert wire.correctionProof.promptVersion == V61_PROMPT_VERSION
    assert wire.correctionProof.outputSha256 == correction_digest(data["segments"])
    assert wire.pipelineStatus == ("COMPLETED_WITH_WARNINGS" if reject else "COMPLETED")
    assert [(s.ordinal, s.startMs, s.endMs) for s in wire.segments] == [(0, 0, 128), (1, 128, 256)]
    assert [s.text for s in wire.segments] == [s.text for s in outcome.result.segments]
    assert all(c.coverageStatus == "COVERED" for c in wire.coverage)
    assert {c.name: c.version for c in wire.provenance.components}["correction"] == "6.1"
    assert any(m.role == "CORRECTION" and m.resolvedModel == "test/resolved-v61" for m in wire.provenance.models)
    assert [(w.stage, w.code) for w in wire.warnings] == (
        [("CORRECTION", "completed-with-warnings")] if reject else [])
    for forbidden in ("replacement", "rejection_reason_counts", "unsafe_phrase_contraction", "effective_configuration"):
        assert forbidden not in raw.decode()
    data["segments"][0]["text"] += " altered"
    with pytest.raises(ResultValidationError):
        validate_result_bytes(json.dumps(data).encode(), **BINDING)
    assert_released(h)


def test_unreported_usage_is_not_estimated_as_zero():
    canonical, coverage = meeting(TEXTS)
    provider = SimpleNamespace(complete=lambda request: CorrectionProviderResponse('{"edits":[]}', "fake", request.model))
    outcome = bridge.correct_transcript_v61(canonical, coverage, provider, configuration())
    assert outcome.result.provenance.usage == CorrectionUsage()
    assert outcome.result.provenance.usage.cost is None


def test_v61_worker_retains_acoustic_warnings_without_lexical_rejections(v61_workflow):
    h = v61_workflow(source_id=MEDIA)
    transcribe = h.asr_callback

    def observed(audio):
        if audio.chunk_id != "chunk-000000":
            raise AsrError(AsrErrorCategory.TIMEOUT)
        return transcribe(audio)

    h.asr_callback = observed
    outcome = selected_pipeline(h).run(h.source)
    wire = validate_result_bytes(map_result(outcome, h.settings, **BINDING), **BINDING)
    assert wire.pipelineStatus == "COMPLETED_WITH_WARNINGS"
    assert any(r.coverageStatus == "UNRESOLVED_ERROR" for r in wire.coverage)
    assert any(w.stage == "COVERAGE_RECOVERY" for w in wire.warnings)
    assert outcome.result.provenance.rejected_edit_count == 0
    assert outcome.result.coverage is outcome.evidence.recovery.final_assessment
    assert h.correction_calls == 1
    assert_released(h)


def test_mocked_worker_core_accepts_v61_and_replays_without_provider_reexecution(v61_workflow):
    async def run():
        h = v61_workflow(entries=proposals(reject=True))
        runtime = await setup(h, run=selected_pipeline(h).run)
        try:
            delivery = Delivery(runtime.body)
            await runtime.worker.handle(delivery)
            assert delivery.actions == ["ack"] and runtime.core.state == "RESULT_ACCEPTED"
            raw, = runtime.s3.objects.values()
            wire = validate_result_bytes(raw)
            assert wire.correctionProof.promptVersion == V61_PROMPT_VERSION
            assert wire.pipelineStatus == "COMPLETED_WITH_WARNINGS"
            await runtime.worker.handle(Delivery(runtime.body, 1))
            assert len(runtime.s3.objects) == len(runtime.core.transcripts) == h.correction_calls == 1
        finally:
            await cleanup(runtime)
        assert_worker_resources_released(h, runtime)
    asyncio.run(run())
