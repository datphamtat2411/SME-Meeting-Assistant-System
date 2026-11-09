import json
import os
from dataclasses import replace
from pathlib import Path

import pytest
from intelligence_support import settings, snapshot, stage, uid

from sme_meeting_ai.meeting_intelligence.action_items import ActionItemProcessor
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
from sme_meeting_ai.workers.intelligence import production_processors
from unit.test_decision import ScriptedAdapter, _identity

FIXTURES = json.loads((Path(__file__).parents[1] / "fixtures/action-items-vietnamese.json").read_text())


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(os, "environ", {})


def action_stage(fixture):
    texts = list(fixture["segments"])
    if fixture.get("long"):
        texts[1] = texts[1] * 150
    data = snapshot(tuple(texts))
    if fixture.get("incomplete"):
        data["coverage"][0]["coverageStatus"] = "UNRESOLVED_ERROR"
    return replace(stage(data), stage_code="EXTRACTING_ACTION_ITEMS")


def scripted(fixture, *, reverse=False, mutate=None):
    def respond(request):
        payload = json.loads(request.window.evidence_json)
        if "evidence" in payload:
            signals = []
            for unit in payload["evidence"]:
                for spec in fixture["signals"]:
                    if spec["at"] != unit["ordinal"]:
                        continue
                    signals.append(dict(
                        action=spec["action"], deliverable=spec["deliverable"],
                        signal_type=spec["type"], mentioned_party=spec.get("party", ""),
                        deadline_expression=spec.get("deadline", ""),
                        qualification=spec.get("qualification", ""), uncertainty="NONE",
                        requires_context=False, evidence=[{key: unit[key] for key in
                            ("segment_id", "char_start", "char_end")}],
                    ))
            output = {**_identity(request), "signals": list(reversed(signals)) if reverse else signals}
        else:
            groups = {}
            for signal in payload["signals"]:
                ordinal = int(signal["evidence"][0]["segment_id"].replace("-", ""), 16) - 100
                spec = next(s for s in fixture["signals"] if s["at"] == ordinal)
                groups.setdefault(spec.get("group", spec["action"]), []).append(signal["signal_id"])
            output = {**_identity(request), "groups": list(groups.values())}
            if reverse:
                output["groups"].reverse()
        if mutate:
            mutate(output)
        return output
    return ScriptedAdapter(respond)


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda f: f["name"])
def test_vietnamese_action_semantics_and_prohibited_authority(fixture):
    conf = settings(**(dict(meeting_intelligence_max_input_tokens=9000,
        meeting_intelligence_max_output_tokens=1200) if fixture.get("long") else {}))
    adapter = scripted(fixture)
    output = ActionItemProcessor(conf, adapter)(action_stage(fixture))
    candidates = output["result"]["candidates"]
    assert len(candidates) == fixture["expected"]
    for item in candidates:
        assert set(item) == {"candidateKey", "title", "details", "suggestedDueDate", "evidenceSegmentIds"}
        assert 1 <= len(item["evidenceSegmentIds"]) <= 50
        assert len(set(item["evidenceSegmentIds"])) == len(item["evidenceSegmentIds"])
        assert "OPEN" not in item["title"] and "SPEAKER_" not in item["title"]
        assert item["suggestedDueDate"] == fixture.get("due")
    if "title" in fixture:
        assert candidates[0]["title"] == fixture["title"]
    if "detailsInclude" in fixture:
        assert fixture["detailsInclude"] in candidates[0]["details"]
    if fixture.get("long"):
        assert sum(r.task.schema.name == "action_window_signals" for r in adapter.requests) > 1
        assert adapter.requests[-1].task.schema.name == "action_resolution_groups"


def test_order_and_overlap_do_not_change_identity_or_batch():
    fixture = next(f for f in FIXTURES if f["name"] == "overlap-repeat")
    context = action_stage(fixture)
    a = ActionItemProcessor(settings(), scripted(fixture))(context)
    b = ActionItemProcessor(settings(), scripted(fixture, reverse=True))(context)
    assert a == b
    assert len(a["result"]["candidates"]) == 1
    assert len(a["result"]["candidates"][0]["evidenceSegmentIds"]) == 2


@pytest.mark.parametrize("mutation", ["foreign", "unicode-range", "outside-window", "identity", "action", "party", "deadline", "authority", "missing", "unjustified-revision"])
def test_untrusted_model_output_fails_closed(mutation):
    fixture = FIXTURES[0]
    def mutate(output):
        signal = output["signals"][0]
        if mutation == "foreign":
            signal["evidence"][0]["segment_id"] = uid(999)
        elif mutation in {"unicode-range", "outside-window"}:
            signal["evidence"][0]["char_end"] = 99999
        elif mutation == "identity":
            output["content_revision"] += 1
        elif mutation == "action":
            signal["action"] = "xóa database production"
        elif mutation == "party":
            signal["mentioned_party"] = "Nguyễn Văn Không Có"
        elif mutation == "deadline":
            signal["deadline_expression"] = "15/11/2026"
        elif mutation == "authority":
            signal["assigneeUserId"] = uid(10)
        elif mutation == "unjustified-revision":
            signal["signal_type"] = "REVISED"
        else:
            del signal["deliverable"]
    with pytest.raises(IntelligenceError):
        ActionItemProcessor(settings(), scripted(fixture, mutate=mutate))(action_stage(fixture))


@pytest.mark.parametrize("text", ["Chúng ta nên kiểm tra lỗi đăng nhập.",
    "Hay là nhờ ai đó kiểm tra lỗi đăng nhập?", "Tuần trước Minh đã kiểm tra lỗi đăng nhập.",
    "Minh kiểm tra lỗi đăng nhập... à thôi, không cần làm nữa."])
def test_misclassified_obligations_are_not_emitted(text):
    fixture = dict(segments=[text], signals=[dict(at=0, action="kiểm tra lỗi đăng nhập",
        deliverable="lỗi đăng nhập", type="ASSIGNED")])
    output = ActionItemProcessor(settings(), scripted(fixture))(action_stage(fixture))
    assert output["result"]["candidates"] == []


@pytest.mark.parametrize("expression,due", [("2026-11-15", "2026-11-15"),
    ("ngày 15 tháng 11 năm 2026", "2026-11-15"), ("sớm", None), ("sau khi khách hàng phản hồi", None)])
def test_only_explicit_calendar_dates_are_suggested(expression, due):
    fixture = dict(segments=[f"Tôi sẽ gửi báo cáo trước {expression}."], signals=[dict(at=0,
        action="gửi báo cáo", deliverable="báo cáo", type="COMMITTED", deadline=expression)])
    result = ActionItemProcessor(settings(), scripted(fixture))(action_stage(fixture))
    assert result["result"]["candidates"][0]["suggestedDueDate"] == due


def test_impossible_date_and_incomplete_resolution_fail_instead_of_empty_success():
    fixture = dict(segments=["Tôi sẽ gửi báo cáo trước 31/02/2026."], signals=[dict(at=0,
        action="gửi báo cáo", deliverable="báo cáo", type="COMMITTED", deadline="31/02/2026")])
    with pytest.raises(IntelligenceError, match="GROUNDING_FAILURE"):
        ActionItemProcessor(settings(), scripted(fixture))(action_stage(fixture))
    fixture = FIXTURES[6]
    def omit(output):
        if "groups" in output:
            output["groups"] = []
    with pytest.raises(IntelligenceError):
        ActionItemProcessor(settings(), scripted(fixture, mutate=omit))(action_stage(fixture))


def test_budget_and_cancellation_never_return_partial_batch():
    fixture = next(f for f in FIXTURES if f.get("long"))
    conf = settings(meeting_intelligence_action_item_max_model_calls=1,
        meeting_intelligence_max_input_tokens=9000, meeting_intelligence_max_output_tokens=1200)
    with pytest.raises(IntelligenceError, match="CONTEXT_BUDGET"):
        ActionItemProcessor(conf, scripted(fixture))(action_stage(fixture))
    context = action_stage(FIXTURES[0])
    context.cancelled.set()
    with pytest.raises(IntelligenceError, match="CANCELLED"):
        ActionItemProcessor(settings(), scripted(FIXTURES[0]))(context)


def test_independent_registration_and_shared_adapter():
    adapter = object()
    assert production_processors(settings(), adapter) == {}
    conf = settings(meeting_intelligence_worker_enabled=True, meeting_intelligence_inference_enabled=True,
        meeting_intelligence_action_item_enabled=True)
    assert set(production_processors(conf, adapter)) == {"EXTRACTING_ACTION_ITEMS"}
    conf = conf.model_copy(update=dict(meeting_intelligence_summary_enabled=True,
        meeting_intelligence_decision_enabled=True))
    processors = production_processors(conf, adapter)
    assert len(processors) == 3 and all(p.adapter is adapter for p in processors.values())
