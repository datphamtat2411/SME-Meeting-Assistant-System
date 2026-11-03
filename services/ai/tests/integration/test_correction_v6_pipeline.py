"""Offline Task 03 composition: real stages/engine/generator, synthetic providers."""

import asyncio
import json
import math
import traceback
import unicodedata
from collections import Counter
from concurrent.futures import CancelledError, ThreadPoolExecutor
from dataclasses import FrozenInstanceError, replace
from fractions import Fraction

import httpx
import pytest
from integration.test_offline_transcription_pipeline import (
    RAW,
    assert_released,
    pipeline,
    spy_stages,
)
from integration.test_offline_transcription_pipeline import workflow as workflow
from unit.test_correction import configuration, meeting
from unit.test_correction_v6 import edit
from unit.test_correction_v6 import offline_environment as offline_environment

from sme_meeting_ai.audio import AudioProcessingError, SampleInterval
from sme_meeting_ai.pipeline import OfflineTranscriptionPipeline
from sme_meeting_ai.pipeline.offline_transcription import (
    OfflineTranscriptionFailure,
)
from sme_meeting_ai.pipeline.offline_transcription import (
    OfflineTranscriptionStage as Stage,
)
from sme_meeting_ai.pipeline.offline_transcription import (
    OfflineTranscriptionStatus as Status,
)
from sme_meeting_ai.providers.openrouter_instruction_llm import (
    OpenRouterInstructionLlmAdapter,
)
from sme_meeting_ai.providers.openrouter_instruction_llm_v6 import (
    OpenRouterInstructionLlmV6Adapter,
)
from sme_meeting_ai.transcription import correction
from sme_meeting_ai.transcription import correction_v6_pipeline as bridge
from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrUsage,
)
from sme_meeting_ai.transcription.correction import (
    CorrectionErrorCategory as Category,
)
from sme_meeting_ai.transcription.correction import (
    CorrectionProvenance,
    CorrectionProviderResponse,
    CorrectionUsage,
    TranscriptCorrectionFailure,
    TranscriptCorrectionResult,
)
from sme_meeting_ai.transcription.correction import (
    TranscriptCorrectionStatus as CorrectionStatus,
)
from sme_meeting_ai.transcription.correction_v6 import (
    CORRECTION_V6_SCHEMA_NAME,
    V6EditResult,
    V6FailureReason,
    V6ValidationError,
    V6ValidationFailure,
)
from sme_meeting_ai.transcription.correction_v6_generation import (
    V6_PROMPT_VERSION,
    V6CorrectionRequest,
)
from sme_meeting_ai.transcription.coverage import CoverageRegion, CoverageState
from sme_meeting_ai.transcription.reconciliation import ReconciliationFlag

TEXTS = (
    "vâng vâng giữa nguyên và tinh tiết trong buổi họp hôm nay",
    "nhóm sẽ kiểm tra tài liêu và dùng configg ngày mai",
)
PRIVATE = "private-task03-provider-diagnostic"
KEY = "synthetic-task03-key"
USAGE = CorrectionUsage(113, 47, 160, Fraction(123456789, 10**12), 11)


def response(request, entries=(), *, usage=USAGE):
    return CorrectionProviderResponse(json.dumps({"edits": entries}, ensure_ascii=False),
                                      "fake", request.model, "test/resolved-v6", usage)


def independent_edits(*, reject=False):
    entries = [edit("giữa nguyên", "giữ nguyên"), edit("tinh tiết", "tình tiết")]
    if reject:
        entries.insert(1, edit("vâng vâng", "vâng"))
    return entries


@pytest.fixture
def v6_workflow(workflow):
    def make(*, entries=(), texts=TEXTS, **kwargs):
        h = workflow(**kwargs)
        count = kwargs.get("count", 4096)

        def transcribe(audio):
            ordinal = int(audio.chunk_id[-6:])
            text = texts[ordinal % len(texts)]
            baseline = audio.chunk_id.startswith("chunk-")
            left = 128 if baseline and ordinal else 0
            right = 128 if baseline and (ordinal + 1) * 2048 < count else 0
            return AsrCandidate(
                text, (AsrSegment(Fraction(left, 16000), audio.duration - Fraction(right, 16000), text),),
                AsrQualityMetadata(confidence=0.95, language="vi"), AsrUsage(),
                AsrProvenance("openrouter", "openai/whisper-large-v3"), audio.chunk_id,
            )

        h.asr_callback = transcribe
        h.requests = []

        def complete(request):
            assert isinstance(request, V6CorrectionRequest)
            h.requests.append(request)
            return response(request, entries)

        h.correction_callback = complete
        return h
    return make


def v6_pipeline(h):
    return OfflineTranscriptionPipeline(h.preprocessing, h.planner, h.transcriber, h.corrector,
                                        h.settings, "offline-test-1", correction_mode="v6_edits")


def spy_composition(monkeypatch):
    generated, applied = [], []
    generate, apply = bridge.generate_v6_proposal, bridge.apply_v6_edits

    def generation(*args):
        outcome = generate(*args)
        generated.append((args[0], outcome))
        return outcome

    def application(*args, **kwargs):
        applied.append((args, kwargs))
        return apply(*args, **kwargs)

    monkeypatch.setattr(bridge, "generate_v6_proposal", generation)
    monkeypatch.setattr(bridge, "apply_v6_edits", application)
    return generated, applied


def http_success(content, *, usage=None):
    return httpx.Response(200, json={
        "model": "test/resolved-v6", "choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": content,
        }}], **({"usage": usage} if usage is not None else {}),
    })


def test_default_v5_request_and_provenance_stay_unchanged(workflow, monkeypatch):
    h = workflow(OPENROUTER_API_KEY=KEY)
    calls = []
    monkeypatch.setattr(bridge, "generate_v6_proposal", lambda *a: pytest.fail("V6 dispatched by default"))

    def complete(request):
        body = json.loads(request.content)
        calls.append(body)
        assert body["response_format"] == {"type": "json_object"}
        assert "provider" not in body
        entries = json.loads(body["messages"][1]["content"])["segments"]
        assert [e["text"] for e in entries] == list(RAW)
        assert all(set(e) == {"segment_id", "ordinal", "text", "start_sample", "end_sample"} for e in entries)
        return http_success(json.dumps({"segments": [
            {k: e[k] for k in ("segment_id", "ordinal", "text")} for e in entries
        ]}))

    with httpx.Client(transport=httpx.MockTransport(complete)) as client:
        h.corrector = OpenRouterInstructionLlmAdapter(h.settings, client)
        outcome = pipeline(h).run(h.source)
        assert not client.is_closed
    assert outcome.status is Status.COMPLETED
    assert len(calls) == 1
    assert outcome.provenance.correction.correction_version == "4"
    assert outcome.provenance.correction.prompt_version == "vi-whole-meeting-5.3"
    assert outcome.provenance.correction.proposed_edit_count == 0
    assert dict(outcome.provenance.correction.rejection_reason_counts) == {}
    assert_released(h)


def test_explicit_v6_composes_once_at_existing_stage_with_complete_context(v6_workflow, monkeypatch):
    h = v6_workflow(entries=independent_edits(), transcript_correction_min_text_ratio=0.7,
                    transcript_correction_max_text_ratio=1.3)
    generated, applied = spy_composition(monkeypatch)
    spy_stages(h, monkeypatch)
    original = bridge.correct_transcript_v6

    def correct(*args):
        h.calls.append(Stage.CORRECTION)
        return original(*args)

    monkeypatch.setattr(bridge, "correct_transcript_v6", correct)
    for name in ("correct_transcript", "_validated_texts", "_unsupported_lexical_edit", "_integrity"):
        monkeypatch.setattr(correction, name, lambda *a, **k: pytest.fail("V5 acceptance gate invoked"))
    outcome = v6_pipeline(h).run(h.source)
    assert outcome.status is Status.COMPLETED and outcome.failure is None
    assert outcome.completed_stages == tuple(Stage) == tuple(h.calls)
    assert h.asr_calls == ["chunk-000000", "chunk-000001"]
    assert len(generated) == len(applied) == h.correction_calls == 1
    canonical, generation = generated[0]
    args, limits = applied[0]
    assert args[0] is canonical and args[1] is generation.result.proposal
    assert limits == {"min_text_ratio": 0.7, "max_text_ratio": 1.3}
    entries = json.loads(h.requests[0].transcript_json)["segments"]
    assert [e["text"] for e in entries] == list(TEXTS)
    assert [(e["segment_id"], e["ordinal"]) for e in entries] == [(s.segment_id, s.ordinal) for s in canonical.segments]
    assert isinstance(outcome.result, TranscriptCorrectionResult)
    assert outcome.result.segments[0].text == TEXTS[0].replace("giữa", "giữ").replace("tinh", "tình")
    assert [s.text for s in canonical.segments] == list(TEXTS)
    assert outcome.result.coverage is outcome.evidence.coverage is outcome.evidence.recovery.final_assessment
    assert outcome.result.source_id == canonical.source_id
    assert outcome.result.sample_count == canonical.sample_count
    assert outcome.result.sample_rate_hz == canonical.sample_rate_hz == 16000
    assert outcome.result.unresolved_intervals == canonical.unresolved_intervals
    for source, final in zip(canonical.segments, outcome.result.segments, strict=True):
        for field in ("segment_id", "ordinal", "interval", "source_chunk_ids", "flags"):
            assert getattr(final, field) == getattr(source, field)
        assert not hasattr(final, "alternatives") and not hasattr(final, "speaker")
    provenance = outcome.provenance.correction
    assert provenance.correction_version == "5"
    assert provenance.prompt_version == V6_PROMPT_VERSION
    assert provenance.provider == generation.result.provider == "fake"
    assert provenance.requested_model == generation.result.requested_model
    assert provenance.resolved_model == generation.result.resolved_model == "test/resolved-v6"
    assert provenance.usage is generation.result.usage is USAGE
    assert provenance.attempts == 1
    assert provenance.proposed_edit_count == provenance.accepted_edit_count == 2
    assert provenance.rejected_edit_count == provenance.rejected_segment_count == 0
    assert dict(provenance.effective_configuration) == {
        **generation.result.effective_configuration, "correction_mode": "v6_edits",
        "schema_name": CORRECTION_V6_SCHEMA_NAME,
    }
    assert_released(h)


@pytest.mark.parametrize("entries,accepted,rejected", [
    (independent_edits(reject=True), 2, 1),
    ([edit("vâng vâng", "vâng")], 0, 1),
    ([], 0, 0),
])
def test_local_rejection_or_empty_proposal_is_success_without_retry(v6_workflow, monkeypatch, entries, accepted, rejected):
    h = v6_workflow(entries=entries)
    observed = []
    original = bridge.correct_transcript_v6

    def correct(*args):
        outcome = original(*args)
        observed.append(outcome.status)
        return outcome

    monkeypatch.setattr(bridge, "correct_transcript_v6", correct)
    outcome = v6_pipeline(h).run(h.source)
    assert outcome.status is (Status.COMPLETED_WITH_WARNINGS if rejected else Status.COMPLETED)
    assert observed == [CorrectionStatus.COMPLETED_WITH_WARNINGS if rejected else CorrectionStatus.COMPLETED]
    assert outcome.result is not None and outcome.failure is None
    expected = TEXTS[0].replace("giữa", "giữ").replace("tinh", "tình") if accepted else TEXTS[0]
    assert outcome.result.segments[0].text == expected
    assert outcome.result.segments[0].text.startswith("vâng vâng")
    p = outcome.provenance.correction
    assert p.proposed_edit_count == len(entries)
    assert p.accepted_edit_count == accepted and p.rejected_edit_count == rejected
    assert p.rejected_segment_count == rejected
    assert dict(p.rejection_reason_counts) == ({"unsafe_length_change": 1} if rejected else {})
    assert outcome.result.quality.changed_segment_count == int(bool(accepted))
    assert [(w.stage, w.code) for w in outcome.warnings] == (
        [(Stage.CORRECTION, "completed-with-warnings")] if rejected else []
    )
    assert h.correction_calls == p.attempts == 1
    assert_released(h)


@pytest.mark.parametrize("kind,category,reason,attempts", [
    ("provider_json", "MALFORMED_OUTPUT", "invalid_provider_json", 2),
    ("json", "MALFORMED_OUTPUT", "invalid_correction_json", 2),
    ("schema", "MALFORMED_OUTPUT", "invalid_correction_schema", 2),
    ("timeout", "TIMEOUT", "deadline_exceeded", 2),
    ("rate_limit", "RATE_LIMIT", "http_request_rejected", 2),
    ("auth", "AUTHENTICATION", "http_request_rejected", 1),
    ("context", "CONTEXT_OVERFLOW", "http_request_rejected", 1),
    ("exhausted", "MALFORMED_OUTPUT", "invalid_correction_schema", 3),
])
def test_generation_failure_preserves_safe_diagnostics_and_attempts_without_engine(
    v6_workflow, monkeypatch, caplog, kind, category, reason, attempts,
):
    h = v6_workflow(OPENROUTER_API_KEY=KEY, transcript_correction_max_attempts=3 if kind == "exhausted" else 2)
    calls, generations = [], []
    generate = bridge.generate_v6_proposal

    def generation(*args):
        generations.append(True)
        return generate(*args)

    monkeypatch.setattr(bridge, "generate_v6_proposal", generation)
    monkeypatch.setattr(bridge, "apply_v6_edits", lambda *a, **k: pytest.fail("engine after generation failure"))

    def complete(request):
        calls.append(request.content)
        if kind == "timeout":
            raise httpx.ReadTimeout(PRIVATE + TEXTS[0] + KEY, request=request)
        if kind in ("rate_limit", "auth", "context"):
            return httpx.Response({"rate_limit": 429, "auth": 401, "context": 413}[kind], content=PRIVATE.encode())
        if kind == "provider_json":
            return httpx.Response(200, content=PRIVATE.encode())
        return http_success(PRIVATE if kind == "json" else '{"segments":[]}')

    with httpx.Client(transport=httpx.MockTransport(complete)) as client:
        h.corrector = OpenRouterInstructionLlmV6Adapter(h.settings, client)
        outcome = v6_pipeline(h).run(h.source)
        assert not client.is_closed
        assert KEY not in repr(h.corrector)
    assert outcome.status is Status.FAILED and outcome.result is None
    assert outcome.failure == OfflineTranscriptionFailure(Stage.CORRECTION, category, attempts, reason)
    assert outcome.completed_stages == tuple(Stage)[:-1]
    assert outcome.provenance.correction is None and outcome.evidence.reconciliation is not None
    assert len(calls) == attempts and generations == [True]
    assert all(call == calls[0] for call in calls)
    for sensitive in (PRIVATE, KEY, *TEXTS):
        assert sensitive not in repr(outcome) + caplog.text
    assert_released(h)


def test_generation_retry_is_owned_only_by_task02_and_usage_describes_accepted_response(v6_workflow, monkeypatch):
    h = v6_workflow()
    generated, applied = spy_composition(monkeypatch)

    def complete(request):
        h.requests.append(request)
        if len(h.requests) == 1:
            return CorrectionProviderResponse(PRIVATE, "fake", request.model, usage=CorrectionUsage(999, 999))
        return response(request, independent_edits())

    h.correction_callback = complete
    outcome = v6_pipeline(h).run(h.source)
    assert outcome.status is Status.COMPLETED
    assert len(generated) == len(applied) == 1
    assert h.correction_calls == outcome.provenance.correction.attempts == 2
    assert h.requests[0] == h.requests[1]
    assert outcome.provenance.correction.usage is USAGE
    assert_released(h)


def test_global_integrity_failure_never_publishes_accepted_subset_or_retries(v6_workflow, monkeypatch):
    h = v6_workflow(entries=[edit(TEXTS[0], "tóm tắt"), edit("configg", "config", segment=1)])
    generated, applied = spy_composition(monkeypatch)
    outcome = v6_pipeline(h).run(h.source)
    assert outcome.status is Status.FAILED and outcome.result is None
    assert outcome.failure == OfflineTranscriptionFailure(Stage.CORRECTION, "SUSPICIOUS_OUTPUT", 1, "proposal_integrity")
    assert len(generated) == len(applied) == h.correction_calls == 1
    assert [s.text for s in generated[0][0].segments] == list(TEXTS)
    assert outcome.evidence.reconciliation.segments and outcome.provenance.reconciliation is not None
    assert_released(h)


@pytest.mark.parametrize("category,reason", [
    (Category.SUSPICIOUS_OUTPUT, V6FailureReason.FINAL_INTEGRITY),
    (Category.MALFORMED_OUTPUT, V6FailureReason.INVALID_FIELD),
    (Category.RESOURCE, V6FailureReason.EDIT_COUNT),
])
def test_sanitized_engine_failures_preserve_category_reason_and_generation_attempts(
    v6_workflow, monkeypatch, category, reason,
):
    h = v6_workflow()
    calls = []

    def reject(*args, **kwargs):
        calls.append(True)
        raise V6ValidationError(V6ValidationFailure(category, reason))

    monkeypatch.setattr(bridge, "apply_v6_edits", reject)
    outcome = v6_pipeline(h).run(h.source)
    assert outcome.result is None and outcome.status is Status.FAILED
    assert outcome.failure == OfflineTranscriptionFailure(Stage.CORRECTION, category.value.upper(), 1, reason.value)
    assert h.correction_calls == 1 and calls == [True]
    assert_released(h)


@pytest.mark.parametrize("mutation", [
    "source", "count", "rate", "coverage_rate", "quality_count", "planning", "preprocessing_source",
    "ordinal", "id", "order", "bounds", "source_reference", "empty_reference", "flag",
    "unresolved_bounds", "coverage_bounds", "coverage_reference", "provenance_rate", "chunk_bounds",
])
def test_invalid_trusted_handoff_is_terminal_before_generation(monkeypatch, mutation):
    canonical, coverage = meeting()
    segments = list(canonical.segments)
    if mutation == "source":
        coverage = replace(coverage, source_id="foreign")
    elif mutation == "count":
        coverage = replace(coverage, sample_count=canonical.sample_count + 1)
    elif mutation in ("rate", "coverage_rate", "provenance_rate"):
        target = {"rate": canonical, "coverage_rate": coverage, "provenance_rate": coverage.provenance}[mutation]
        object.__setattr__(target, "sample_rate_hz", 8000)
    elif mutation == "quality_count":
        coverage = replace(coverage, quality=replace(coverage.quality, sample_count=1))
    elif mutation in ("planning", "preprocessing_source"):
        planning = replace(coverage.provenance.planning, preprocessing=replace(
            coverage.provenance.planning.preprocessing, source_id="foreign",
        ))
        coverage = replace(coverage, provenance=replace(coverage.provenance, planning=planning))
        if mutation == "preprocessing_source":
            canonical = replace(canonical, provenance=replace(canonical.provenance, planning=planning))
    elif mutation == "unresolved_bounds":
        canonical = replace(canonical, unresolved_intervals=(SampleInterval(0, 999),))
    elif mutation in ("coverage_bounds", "coverage_reference"):
        coverage = replace(coverage, regions=(CoverageRegion(
            SampleInterval(0, 999 if mutation == "coverage_bounds" else 100), CoverageState.COVERED, (),
            ("foreign-chunk",) if mutation == "coverage_reference" else ("chunk-000000",), (), 1, 0, 1, 100, 0, 0,
        ),))
    elif mutation == "chunk_bounds":
        chunks = canonical.provenance.source_chunks
        canonical = replace(canonical, provenance=replace(canonical.provenance, source_chunks=(
            replace(chunks[0], request_interval=SampleInterval(0, 999)), *chunks[1:],
        )))
    else:
        if mutation == "order":
            segments.reverse()
        else:
            updates = {
                "ordinal": {"ordinal": True}, "id": {"segment_id": "foreign"},
                "bounds": {"interval": SampleInterval(0, 999)},
                "source_reference": {"source_chunk_ids": ("foreign-chunk",)},
                "empty_reference": {"source_chunk_ids": ()}, "flag": {"flags": (PRIVATE,)},
            }
            segments[0] = replace(segments[0], **updates[mutation])
        canonical = replace(canonical, segments=tuple(segments))
    monkeypatch.setattr(bridge, "generate_v6_proposal", lambda *a: pytest.fail("invalid trusted handoff dispatched"))
    outcome = bridge.correct_transcript_v6(canonical, coverage, object(), configuration())
    assert outcome.status is CorrectionStatus.FAILED and outcome.result is None
    assert outcome.failure.category is Category.VALIDATION and outcome.failure.attempts == 0
    assert outcome.failure.reason == "invalid_reconciliation"
    assert PRIVATE not in repr(outcome)


@pytest.mark.parametrize("kind", ["unresolved", "flags", "noncovered", "quality"])
def test_upstream_warnings_survive_valid_empty_proposals(kind):
    canonical, coverage = meeting()
    if kind == "unresolved":
        canonical = replace(canonical, unresolved_intervals=(SampleInterval(1, 2),))
        coverage = replace(coverage, unresolved_intervals=(SampleInterval(3, 4),))
    elif kind == "flags":
        canonical = replace(canonical, segments=(replace(canonical.segments[0], flags=(
            ReconciliationFlag.CONFLICTING_OVERLAP,
        ), alternatives=(PRIVATE,)), canonical.segments[1]))
    elif kind == "noncovered":
        coverage = replace(coverage, regions=(CoverageRegion(
            SampleInterval(0, 100), CoverageState.SUSPICIOUS, (), ("chunk-000000",), (), 1, 0, 1, 100, 0, 0,
        ),))
    else:
        coverage = replace(coverage, quality=replace(coverage.quality, failed_chunk_count=1))
    provider = type("Provider", (), {"complete": lambda self, request: response(request)})()
    outcome = bridge.correct_transcript_v6(canonical, coverage, provider, configuration())
    assert outcome.status is CorrectionStatus.COMPLETED_WITH_WARNINGS
    assert outcome.result.coverage is coverage
    assert outcome.result.unresolved_intervals == canonical.unresolved_intervals
    assert outcome.result.segments[0].flags == canonical.segments[0].flags
    assert PRIVATE not in repr(outcome)


def test_quality_is_reproducible_observation_of_final_text_not_rejected_proposal(v6_workflow):
    h = v6_workflow(entries=independent_edits(reject=True))
    outcome = v6_pipeline(h).run(h.source)
    quality = outcome.result.quality
    final = tuple(s.text for s in outcome.result.segments)
    source_characters = sum(sum(not c.isspace() for c in unicodedata.normalize("NFC", t).casefold()) for t in TEXTS)
    final_characters = sum(sum(not c.isspace() for c in unicodedata.normalize("NFC", t).casefold()) for t in final)
    assert quality.segment_count == quality.validated_segment_count == 2
    assert quality.changed_segment_count == 1
    assert quality.source_word_count == quality.corrected_word_count == sum(len(t.split()) for t in TEXTS)
    assert quality.source_character_count == source_characters
    assert quality.corrected_character_count == final_characters
    assert quality.character_ratio == final_characters / source_characters
    assert quality.word_ratio == 1.0
    # "giữa" -> "giữ" drops one letter and changes one of 12 lexical keys;
    # "tinh" -> "tình" is accent-only. The rejected "vâng" deletion is excluded.
    assert quality.minimum_content_overlap == 11 / 12
    assert quality.minimum_segment_character_ratio == 45 / 46
    assert quality.maximum_segment_character_ratio == 1.0
    assert_released(h)


@pytest.mark.parametrize("texts,entries,expected", [
    (("ừ",), [edit("ừ", "Ừ...")], ("Ừ...",)),
    (("tôi họp",), [edit("tôi", "Tôi")], ("Tôi họp",)),
    (("!!!",), [], ("!!!",)),
    ((" ",), [], ()),
])
def test_short_unicode_and_empty_word_accounting_is_finite(texts, entries, expected):
    canonical, coverage = meeting(texts)
    provider = type("Provider", (), {"complete": lambda self, request: response(request, entries)})()
    first = bridge.correct_transcript_v6(canonical, coverage, provider, configuration())
    second = bridge.correct_transcript_v6(canonical, coverage, provider, configuration())
    assert first == second and first.failure is None
    assert tuple(s.text for s in first.result.segments) == expected
    for field in ("character_ratio", "word_ratio", "minimum_segment_character_ratio",
                  "maximum_segment_character_ratio", "minimum_content_overlap"):
        assert math.isfinite(getattr(first.result.quality, field))
    assert first.result.quality.word_ratio == 1.0


def provenance(**updates):
    return CorrectionProvenance(**{
        "correction_version": "5", "prompt_version": V6_PROMPT_VERSION, "provider": "fake",
        "requested_model": "test/corrector", "resolved_model": None, "effective_configuration": {},
        "attempts": 1, "usage": CorrectionUsage(), **updates,
    })


@pytest.mark.parametrize("field", ["proposed_edit_count", "accepted_edit_count", "rejected_edit_count", "rejected_segment_count"])
@pytest.mark.parametrize("value", [-1, True, 1.0, "1"])
def test_provenance_rejects_non_integer_or_negative_counts(field, value):
    with pytest.raises(ValueError, match="Invalid"):
        provenance(**{field: value})


@pytest.mark.parametrize("updates", [
    {"proposed_edit_count": 1},
    {"proposed_edit_count": 1, "rejected_edit_count": 1},
    {"proposed_edit_count": 1, "rejected_edit_count": 1, "rejection_reason_counts": {"unsafe_length_change": 2}},
    {"rejection_reason_counts": {"unsafe_length_change": True}},
    {"rejection_reason_counts": {"unsafe_length_change": -1}},
    {"rejection_reason_counts": {PRIVATE: 0}},
])
def test_provenance_rejects_inconsistent_or_unsafe_reason_statistics(updates):
    with pytest.raises(ValueError, match="Invalid") as caught:
        provenance(**updates)
    assert PRIVATE not in str(caught.value)


def test_provenance_mapping_is_copied_immutable_and_v5_positional_defaults_survive():
    reasons, config = {"unsafe_length_change": 1}, {"correction_mode": "v6_edits"}
    p = provenance(proposed_edit_count=2, accepted_edit_count=1, rejected_edit_count=1,
                   rejected_segment_count=1, rejection_reason_counts=reasons, effective_configuration=config)
    reasons.clear()
    config.clear()
    assert dict(p.rejection_reason_counts) == {"unsafe_length_change": 1}
    assert dict(p.effective_configuration) == {"correction_mode": "v6_edits"}
    with pytest.raises(TypeError):
        p.rejection_reason_counts["noop_edit"] = 1
    with pytest.raises(FrozenInstanceError):
        p.accepted_edit_count = 7
    old = CorrectionProvenance("4", "vi-whole-meeting-5.3", "fake", "test/model", None, {}, 2, USAGE, 1)
    assert old.rejected_segment_count == 1
    assert old.proposed_edit_count == old.accepted_edit_count == old.rejected_edit_count == 0
    assert dict(old.rejection_reason_counts) == {}
    assert TranscriptCorrectionFailure(Category.PROVIDER, 1).reason is None
    assert OfflineTranscriptionFailure(Stage.CORRECTION, "PROVIDER", 1).reason is None


@pytest.mark.parametrize("model", ["correction", "offline"])
@pytest.mark.parametrize("reason", [PRIVATE, "candidate_text", "invalid_correction_schema\n" + PRIVATE, True, 123])
def test_failure_reason_vocabulary_never_accepts_arbitrary_diagnostics(model, reason):
    with pytest.raises(ValueError, match="Invalid") as caught:
        if model == "correction":
            TranscriptCorrectionFailure(Category.VALIDATION, 0, reason)
        else:
            OfflineTranscriptionFailure(Stage.CORRECTION, "VALIDATION", 0, reason)
    assert PRIVATE not in str(caught.value)


@pytest.mark.parametrize("kind", ["missing_text", "nontext", "rejected_segments", "constructor"])
def test_trusted_result_construction_failure_is_atomic_and_sanitized(v6_workflow, monkeypatch, caplog, kind):
    h = v6_workflow()
    if kind == "constructor":
        def invalid(*args, **kwargs):
            raise RuntimeError(PRIVATE + TEXTS[0])
        monkeypatch.setattr(bridge, "CorrectedSegment", invalid)
    else:
        def invalid(canonical, *args, **kwargs):
            texts = tuple(s.text for s in canonical.segments)
            if kind == "missing_text":
                return V6EditResult(texts[:-1], 0, 0, 0, 0, {})
            if kind == "nontext":
                return V6EditResult((None, *texts[1:]), 0, 0, 0, 0, {})
            return V6EditResult(texts, 3, 0, 3, 3, {"noop_edit": 3})
        monkeypatch.setattr(bridge, "apply_v6_edits", invalid)
    outcome = v6_pipeline(h).run(h.source)
    assert outcome.result is None and outcome.status is Status.FAILED
    assert outcome.failure == OfflineTranscriptionFailure(Stage.CORRECTION, "VALIDATION", 1, "invalid_correction_result")
    assert h.correction_calls == 1
    assert PRIVATE not in repr(outcome) + caplog.text
    assert_released(h)


@pytest.mark.parametrize("exception", [CancelledError, asyncio.CancelledError, KeyboardInterrupt])
def test_cancellation_identity_ownership_and_privacy_survive_v6(v6_workflow, caplog, exception):
    h = v6_workflow()
    cancellation = exception(PRIVATE + TEXTS[0] + KEY)

    def cancel(request):
        raise cancellation

    h.correction_callback = cancel
    with pytest.raises(exception) as caught:
        v6_pipeline(h).run(h.source)
    assert caught.value is cancellation
    assert caught.value.__cause__ is caught.value.__context__ is None
    formatted = "".join(traceback.format_exception(caught.value))
    for sensitive in (PRIVATE, KEY, *TEXTS):
        assert sensitive not in formatted + caplog.text
    assert h.correction_calls == 1
    assert_released(h)


def test_provider_exception_and_rejected_texts_never_enter_provenance_or_logs(v6_workflow, caplog):
    h = v6_workflow(entries=[edit("tinh tiết", "khác biệt")], OPENROUTER_API_KEY=KEY)
    outcome = v6_pipeline(h).run(h.source)
    assert outcome.result is not None and outcome.provenance.correction.rejected_edit_count == 1
    assert dict(outcome.provenance.correction.rejection_reason_counts) == {"unsupported_lexical_change": 1}
    assert "khác biệt" not in repr(outcome.provenance) + caplog.text

    def fail(request):
        raise RuntimeError(PRIVATE + KEY + TEXTS[0])

    h.correction_callback = fail
    failed = v6_pipeline(h).run(h.source)
    assert failed.failure.category == "PROVIDER" and failed.failure.reason == "provider_failure"
    for sensitive in (PRIVATE, KEY, *TEXTS):
        assert sensitive not in repr(failed) + caplog.text
    assert_released(h)


@pytest.mark.parametrize("mode", ["v6", "V6_EDITS", "v5", "", None, True, [], PRIVATE])
def test_invalid_mode_is_rejected_safely_before_execution(workflow, mode):
    h = workflow()
    with pytest.raises(AudioProcessingError) as caught:
        OfflineTranscriptionPipeline(h.preprocessing, h.planner, h.transcriber, h.corrector,
                                      h.settings, correction_mode=mode)
    assert not h.asr_calls and not h.artifacts and h.correction_calls == 0
    assert PRIVATE not in str(caught.value)


def test_long_meeting_and_oversized_proposal_cannot_bypass_existing_limits(v6_workflow, monkeypatch):
    h = v6_workflow(texts=("nội dung cuộc họp " * 1000, TEXTS[1]), transcript_correction_max_input_tokens=10000)
    outcome = v6_pipeline(h).run(h.source)
    assert outcome.result is None
    assert outcome.failure == OfflineTranscriptionFailure(Stage.CORRECTION, "CONTEXT_OVERFLOW", 0,
                                                         "context_budget_exceeded")
    assert h.correction_calls == 0
    assert_released(h)

    h = v6_workflow(entries=[edit("giữa", "giữ")] * 33)
    monkeypatch.setattr(bridge, "apply_v6_edits", lambda *a, **k: pytest.fail("oversized proposal applied"))
    outcome = v6_pipeline(h).run(h.source)
    assert outcome.result is None
    assert outcome.failure == OfflineTranscriptionFailure(Stage.CORRECTION, "RESOURCE", 1, "segment_edit_count")
    assert h.correction_calls == 1
    assert_released(h)


def test_concurrent_v5_v6_and_repeated_execution_have_independent_state(workflow, v6_workflow):
    old = workflow()
    edited = v6_workflow(entries=independent_edits(reject=True))
    untouched = v6_workflow()
    pipelines = [pipeline(old), v6_pipeline(edited), v6_pipeline(untouched)]
    handles = [old, edited, untouched]
    with ThreadPoolExecutor(max_workers=3) as executor:
        outcomes = list(executor.map(lambda pair: pair[0].run(pair[1].source), zip(pipelines, handles, strict=True)))
    assert [o.provenance.correction.correction_version for o in outcomes] == ["4", "5", "5"]
    assert [o.provenance.correction.rejected_edit_count for o in outcomes] == [0, 1, 0]
    assert isinstance(edited.requests[0], V6CorrectionRequest)
    assert tuple(s.text for s in outcomes[2].result.segments) == TEXTS
    again = pipelines[1].run(edited.source)
    assert again.result == outcomes[1].result
    assert dict(again.provenance.correction.rejection_reason_counts) == Counter({"unsafe_length_change": 1})
    for h in handles:
        assert_released(h)
