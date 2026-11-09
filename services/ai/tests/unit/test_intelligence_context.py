import json
import os
import time
from dataclasses import replace

import pytest
from intelligence_support import settings, snapshot, stage, task, uid
from pydantic import ValidationError

from sme_meeting_ai.meeting_intelligence.composition import prepare_context
from sme_meeting_ai.meeting_intelligence.context import ContextLimits
from sme_meeting_ai.meeting_intelligence.contracts import estimate_input_tokens
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
from sme_meeting_ai.meeting_intelligence.evidence import normalize_evidence


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(os, "environ", {})


def prepare(data=None, **options):
    return prepare_context(stage(data), task(), settings(**options))


def test_exact_normalization_identity_metadata_and_reference_resolution():
    data = snapshot(("  Tôi nói: API v2, CI/CD và dữ liệu tiếng Việt.\n", "Chưa rõ."))
    data["transcript"]["segments"][1]["qualityStatus"] = "SUSPICIOUS"
    data["coverage"][0]["coverageStatus"] = "UNRESOLVED_ERROR"
    context = stage(data)
    source = normalize_evidence(context, ContextLimits.from_settings(settings()))
    assert source.identity.snapshot_id == context.source_snapshot_id
    assert source.identity.sha256 == context.source_sha256
    assert source.identity.transcript_id == uid(1) and source.identity.content_revision == 3
    assert [s.segment_id for s in source.segments] == [uid(100), uid(101)]
    assert source.resolve(uid(100)).text == data["transcript"]["segments"][0]["text"]
    assert source.resolve(uid(100), 2, 8).text == data["transcript"]["segments"][0]["text"][2:8]
    assert source.segments[0].start_ms == 0 and source.segments[0].end_ms == 1000
    assert source.segments[0].speaker_label == "SPEAKER_00"
    assert source.speakers[0].user_id is None
    assert source.coverage[0].status == "UNRESOLVED_ERROR"
    assert {"INCOMPLETE_COVERAGE", "UNRESOLVED_EVIDENCE", "SUSPICIOUS_EVIDENCE",
            "ANONYMOUS_SPEAKERS", "SOURCE_QUALITY_WARNING"} <= set(source.quality_flags)
    data["transcript"]["segments"][0]["text"] = "mutated"
    assert source.segments[0].text != "mutated"
    with pytest.raises(IntelligenceError, match="INVALID_REFERENCE"):
        source.resolve(uid(999))
    for bounds in [(-1, 2), (3, 2), (0, 9999), (True, 2)]:
        with pytest.raises(IntelligenceError, match="INVALID_REFERENCE"):
            source.resolve(uid(100), *bounds)


@pytest.mark.parametrize("change", ["duplicate", "order", "negative_order", "blank", "control", "text_type",
    "reverse_time", "backwards_time", "beyond_duration", "boolean_time", "speaker_conflict",
    "speaker_missing", "duplicate_speaker", "coverage_time", "coverage_status", "quality", "unknown_field"])
def test_structurally_invalid_source_is_never_repaired(change):
    data = snapshot()
    first, second = data["transcript"]["segments"]
    if change == "duplicate":
        second["id"] = first["id"]
    elif change == "order":
        second["ordinal"] = 0
    elif change == "negative_order":
        first["ordinal"] = -1
    elif change == "blank":
        first["text"] = "  "
    elif change == "control":
        first["text"] = "abc\x00"
    elif change == "text_type":
        first["text"] = 1
    elif change == "reverse_time":
        first["endMs"] = 0
    elif change == "backwards_time":
        second["startMs"] = 0
        first["startMs"] = 1
    elif change == "beyond_duration":
        second["endMs"] = 3000
    elif change == "boolean_time":
        first["startMs"] = False
    elif change == "speaker_conflict":
        first["speakerLabel"] = "Nhầm nhãn"
    elif change == "speaker_missing":
        first["speakerClusterId"] = uid(999)
    elif change == "duplicate_speaker":
        data["speakers"].append(dict(data["speakers"][0]))
    elif change == "coverage_time":
        data["coverage"][0]["endMs"] = 0
    elif change == "coverage_status":
        data["coverage"][0]["coverageStatus"] = "INVENTED"
    elif change == "quality":
        first["qualityStatus"] = "INVENTED"
    elif change == "unknown_field":
        first["privateUrl"] = "https://private.invalid"
    with pytest.raises(IntelligenceError, match="INVALID_SOURCE"):
        prepare(data)


def test_missing_unknown_and_overlapping_timing_are_preserved():
    data = snapshot()
    first, second = data["transcript"]["segments"]
    first.pop("startMs")
    first["endMs"] = None
    first["speakerClusterId"] = first["speakerLabel"] = None
    second["startMs"] = 500  # Concurrent speech is valid; no invented non-overlap rule.
    source = prepare(data).plan.source
    assert source.segments[0].missing_fields == ("startMs",)
    assert source.segments[0].start_ms is None
    assert {"MISSING_TIMING", "UNKNOWN_SPEAKERS"} <= set(source.quality_flags)
    data["transcript"]["segments"][0]["text"] = ""
    data["transcript"]["segments"][0]["qualityStatus"] = "UNRESOLVED"
    source = prepare(data).plan.source
    assert source.segments[0].text == "" and "UNRESOLVED_EVIDENCE" in source.quality_flags


def test_stage_identity_must_agree_with_snapshot():
    context = replace(stage(), transcript_id=uid(900))
    with pytest.raises(IntelligenceError, match="INVALID_SOURCE"):
        prepare_context(context, task(), settings())


def test_plan_is_deterministic_and_preserves_all_source_subranges_with_overlap():
    texts = tuple((f"Lượt {i}: API và kiểm thử tiếng Việt. " * 15) for i in range(10))
    data = snapshot(texts)
    options = dict(meeting_intelligence_max_input_tokens=6000,
                   meeting_intelligence_context_window_tokens=9000,
                   meeting_intelligence_max_output_tokens=1000,
                   meeting_intelligence_overlap_units=1)
    a, b = prepare(data, **options), prepare(data, **options)
    assert a.plan.to_json() == b.plan.to_json()
    plan = a.plan
    assert plan.complete and len(plan.windows) > 1
    assert all(not w.contains_entire_source for w in plan.windows)
    seen = set()
    overlap = False
    for index, window in enumerate(plan.windows):
        assert window.index == index
        assert window.estimated_input_tokens <= 6000
        assert set(window.segment_ids) == {u.segment_id for u in window.units}
        keys = {(u.segment_id, u.char_start, u.char_end) for u in window.units}
        overlap |= bool(keys & seen)
        seen.update(keys)
        assert [u.ordinal for u in window.units] == sorted(u.ordinal for u in window.units)
        for unit in window.units:
            assert unit.text == plan.source.resolve(unit.segment_id, unit.char_start, unit.char_end).text
    assert overlap
    for segment in plan.source.segments:
        ranges = sorted((start, end) for sid, start, end in seen if sid == segment.segment_id)
        cursor = 0
        for start, end in ranges:
            assert start == cursor
            cursor = end
        assert cursor == len(segment.text)
    assert plan.total_estimated_input_tokens == sum(w.estimated_input_tokens for w in plan.windows)
    assert plan.source.identity.sha256 in plan.to_json()


def test_long_individual_segment_is_split_losslessly_without_replacement_ids():
    text = "Tiếng Việt: hạ tầng Kubernetes và API.\n" * 350
    prepared = prepare(snapshot((text,)), meeting_intelligence_max_input_tokens=5000,
                       meeting_intelligence_max_windows=100, meeting_intelligence_overlap_units=0)
    units = [u for w in prepared.plan.windows for u in w.units]
    assert len(units) > 1 and {u.segment_id for u in units} == {uid(100)}
    assert "".join(u.text for u in units) == text
    assert all(u.char_end > u.char_start for u in units)


def test_estimator_counts_utf8_format_schema_instructions_and_margin():
    prepared = prepare()
    request = prepared.request(0)
    from sme_meeting_ai.meeting_intelligence.contracts import request_payload
    serialized = json.dumps(request_payload(request), ensure_ascii=False, sort_keys=True,
                            separators=(",", ":")).encode()
    estimate = estimate_input_tokens(request_payload(request))
    assert estimate >= len(serialized) + 256
    assert estimate == prepared.plan.windows[0].estimated_input_tokens
    exact = settings(meeting_intelligence_max_input_tokens=estimate,
                     meeting_intelligence_overlap_units=0)
    assert prepare_context(stage(), task(), exact).plan.complete
    larger_task = replace(task(), instructions="Dữ liệu tiếng Việt " * 1000)
    with pytest.raises(IntelligenceError, match="CONTEXT_BUDGET"):
        prepare_context(stage(), larger_task, exact)


@pytest.mark.parametrize("options", [
    {"meeting_intelligence_max_windows": 1, "meeting_intelligence_max_input_tokens": 4000},
    {"meeting_intelligence_max_total_context_tokens": 5000},
    {"meeting_intelligence_max_source_bytes": 500},
    {"meeting_intelligence_max_evidence_units": 1},
])
def test_complete_plan_or_explicit_budget_failure(options):
    with pytest.raises(IntelligenceError, match="CONTEXT_BUDGET"):
        prepare(snapshot(tuple("Bàn về kỹ thuật " * 300 for _ in range(5))), **options)


@pytest.mark.parametrize("kind", ["cancel", "deadline"])
def test_preparation_honors_t02_authority(kind):
    context = stage()
    if kind == "cancel":
        context.cancelled.set()
    else:
        context = replace(context, deadline=time.monotonic() - 1)
    with pytest.raises(IntelligenceError, match="CANCELLED" if kind == "cancel" else "DEADLINE"):
        prepare_context(context, task(), settings())


def test_preparation_checks_authority_inside_work(monkeypatch):
    from sme_meeting_ai.meeting_intelligence import evidence
    context = stage(snapshot(tuple("Nội dung" for _ in range(100))))
    original = evidence.check_authority
    calls = []
    def check(deadline, cancelled):
        calls.append(1)
        if len(calls) == 8:
            cancelled.set()
        original(deadline, cancelled)
    monkeypatch.setattr(evidence, "check_authority", check)
    with pytest.raises(IntelligenceError, match="CANCELLED"):
        prepare_context(context, task(), settings())
    assert len(calls) == 8


@pytest.mark.parametrize("options", [
    {"meeting_intelligence_max_input_tokens": 99999},
    {"meeting_intelligence_max_attempts": 3},
    {"meeting_intelligence_overlap_units": 9},
    {"meeting_intelligence_max_response_bytes": 0},
    {"meeting_intelligence_max_windows": True},
])
def test_configuration_rejects_incompatible_or_unbounded_limits(options):
    with pytest.raises(ValidationError):
        settings(**options)


def test_covered_readable_text_does_not_erase_ready_with_warning_status():
    source = prepare().plan.source
    assert "SOURCE_QUALITY_WARNING" in source.quality_flags
    assert "INCOMPLETE_COVERAGE" not in source.quality_flags


def test_absent_coverage_and_no_usable_text_remain_explicit():
    data = snapshot(("",))
    data["coverage"] = []
    data["transcript"]["segments"][0]["qualityStatus"] = "UNRESOLVED"
    prepared = prepare(data)
    assert not prepared.plan.source.has_usable_evidence
    assert "COVERAGE_UNKNOWN" in prepared.plan.source.quality_flags
    assert prepared.plan.complete and prepared.plan.windows[0].units[0].text == ""


def test_cancellation_during_window_planning(monkeypatch):
    from sme_meeting_ai.meeting_intelligence import context as planning
    context = stage(snapshot(tuple("Lượt nói tiếng Việt " * 80 for _ in range(20))))
    original, calls = planning.check_authority, []
    def check(deadline, cancelled):
        calls.append(1)
        if len(calls) == 10:
            cancelled.set()
        original(deadline, cancelled)
    monkeypatch.setattr(planning, "check_authority", check)
    with pytest.raises(IntelligenceError, match="CANCELLED"):
        prepare_context(context, task(), settings())


def test_subdivision_unit_limit_fails_instead_of_truncating_long_segment():
    with pytest.raises(IntelligenceError, match="CONTEXT_BUDGET"):
        prepare(snapshot(("Tiếng Việt " * 3000,)), meeting_intelligence_max_input_tokens=4000,
                meeting_intelligence_max_evidence_units=2)
