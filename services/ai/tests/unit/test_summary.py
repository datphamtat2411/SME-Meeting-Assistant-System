import json
import os
from pathlib import Path

import pytest
from intelligence_support import settings, snapshot, stage, uid

from sme_meeting_ai.meeting_intelligence.contracts import ModelResult, ModelUsage
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
from sme_meeting_ai.meeting_intelligence.summary import SummaryProcessor
from sme_meeting_ai.workers.intelligence import production_processors


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(os, "environ", {})


def _identity(request):
    identity = request.window.source
    return {
        "source_snapshot_id": identity.snapshot_id,
        "transcript_id": identity.transcript_id,
        "content_revision": identity.content_revision,
    }


def _result(request, output):
    return ModelResult(
        output=output,
        requested_model=request.model,
        reported_model=request.model,
        provider="test-provider",
        reported_provider="test-provider",
        prompt_version=request.task.prompt_version,
        schema_version=request.task.schema.version,
        schema_sha256=request.task.schema.sha256,
        source=request.window.source,
        window_id=request.window.window_id,
        planning_version=request.window.planning_version,
        configuration_sha256=request.window.configuration_sha256,
        task_sha256=request.task.sha256,
        estimated_input_tokens=request.window.estimated_input_tokens,
        usage=ModelUsage(),
        duration_seconds=0,
        attempts=1,
        failed_attempt_categories=(),
    )


def _evidence_output(request, units):
    return {**_identity(request), "units": units}


def _unit(statement, category, evidence, uncertainty="NONE", qualification=""):
    return {
        "statement": statement,
        "category": category,
        "uncertainty": uncertainty,
        "qualification": qualification,
        "evidence": evidence,
    }


def _reference(unit, *, segment_id=None, char_start=None, char_end=None):
    return {
        "segment_id": unit["segment_id"] if segment_id is None else segment_id,
        "char_start": unit["char_start"] if char_start is None else char_start,
        "char_end": unit["char_end"] if char_end is None else char_end,
    }


class ScriptedAdapter:
    def __init__(self, callback):
        self.callback = callback
        self.requests = []

    def complete(self, request):
        self.requests.append(request)
        return _result(request, self.callback(request))


def _all_window_units(request):
    payload = json.loads(request.window.evidence_json)
    return payload["evidence"]


def _identity_from_payload(payload):
    source = payload["source"]
    return {
        "source_snapshot_id": source["snapshot_id"],
        "transcript_id": source["transcript_id"],
        "content_revision": source["content_revision"],
    }


def _responsive_output(request):
    if request.task.schema.name == "summary_window_evidence":
        units = []
        for evidence in _all_window_units(request):
            if not evidence["text"].strip():
                continue
            units.append(_unit(evidence["text"][:180], "FACT", [_reference(evidence)]))
        return _evidence_output(request, units)

    payload = json.loads(request.window.evidence_json)
    if request.task.schema.name == "summary_reduction_evidence":
        return {**_identity_from_payload(payload), "units": payload["records"]}

    records = payload["records"]
    claims = [
        {
            "text": record["statement"],
            "category": record["category"],
            "uncertainty": record["uncertainty"],
            "qualification": record["qualification"],
            "evidence": record["evidence"],
        }
        for record in records
    ]
    return {
        **_identity_from_payload(payload),
        "overview": [claim for claim in claims if claim["category"] == "TOPIC"][:1],
        "topics": [claim for claim in claims if claim["category"] == "TOPIC"],
        "findings": [claim for claim in claims if claim["category"] in {"FACT", "CONCLUSION", "PROBLEM"}],
        "agreements": [claim for claim in claims if claim["category"] == "AGREEMENT"],
        "changes": [claim for claim in claims if claim["category"] in {"REJECTION", "CORRECTION", "DISAGREEMENT"}],
        "open_questions": [claim for claim in claims if claim["category"] in {"OPEN_QUESTION", "PROPOSAL"}],
    }


def test_short_summary_is_vietnamese_grounded_and_warns_without_inventing_identity():
    data = snapshot((
        "Mục tiêu là rà soát API và CI/CD trước khi triển khai.",
        "Nhóm thống nhất kiểm thử API trước triển khai.",
    ))
    context = stage(data)

    def callback(request):
        evidence = _all_window_units(request)
        return _evidence_output(request, [
            _unit("Rà soát API và CI/CD trước khi triển khai", "TOPIC", [_reference(evidence[0])]),
            _unit("Nhóm thống nhất kiểm thử API trước triển khai", "AGREEMENT", [_reference(evidence[1])]),
        ])

    adapter = ScriptedAdapter(callback)
    candidate = SummaryProcessor(settings(), adapter)(context)

    assert len(adapter.requests) == 1
    assert candidate["producer"] == {
        "model": "openai/gpt-5-mini",
        "promptVersion": "summary-v1",
        "provider": "test-provider",
    }
    assert candidate["result"]["warnings"] == ["SOURCE_QUALITY_WARNING"]
    content = candidate["result"]["content"]
    assert "## Chủ đề chính" in content
    assert "## Kết quả được thống nhất" in content
    assert "API" in content and "CI/CD" in content
    assert "SPEAKER_00" not in content


@pytest.mark.parametrize("mode", ["unknown_reference", "unsupported_number"])
def test_summary_rejects_invalid_or_ungrounded_window_claims(mode):
    context = stage()

    def callback(request):
        evidence = _all_window_units(request)[0]
        reference = _reference(evidence)
        if mode == "unknown_reference":
            reference["segment_id"] = uid(9999)
            statement = evidence["text"]
        else:
            statement = "Cuộc họp đã phê duyệt ngân sách 900000 đồng cho Kubernetes."
        return _evidence_output(request, [_unit(statement, "FACT", [reference])])

    with pytest.raises(IntelligenceError) as error:
        SummaryProcessor(settings(), ScriptedAdapter(callback))(context)
    assert error.value.category in {"INVALID_REFERENCE", "GROUNDING_FAILURE"}


def test_overlapping_windows_are_deduplicated_before_final_synthesis():
    data = snapshot(tuple(f"Lượt {i}: API gateway và CI/CD cần kiểm thử." for i in range(13)))
    context = stage(data)
    conf = settings(
        meeting_intelligence_max_input_tokens=11000,
        meeting_intelligence_context_window_tokens=12500,
        meeting_intelligence_max_output_tokens=1200,
        meeting_intelligence_overlap_units=1,
    )
    def repeated_topics(request):
        if request.task.schema.name != "summary_window_evidence":
            return _responsive_output(request)
        evidence = next(item for item in _all_window_units(request) if item["text"].strip())
        return _evidence_output(request, [
            _unit("API gateway và CI/CD cần kiểm thử", "FACT", [_reference(evidence)])
        ])

    adapter = ScriptedAdapter(repeated_topics)
    candidate = SummaryProcessor(conf, adapter)(context)

    assert len(context.snapshot["transcript"]["segments"]) == 13
    assert len(adapter.requests) > 2
    synthesis_payloads = [
        json.loads(request.window.evidence_json)
        for request in adapter.requests
        if request.task.schema.name == "summary_synthesis"
    ]
    assert synthesis_payloads
    statements = [record["statement"] for record in synthesis_payloads[-1]["records"]]
    assert len(statements) == len(set(statements))
    assert candidate["result"]["content"].count("API gateway") == len(set(statements))


def test_proposal_is_not_rendered_as_an_agreement():
    context = stage(snapshot(("Có lẽ nên đổi API, nhưng chưa chốt.",)))

    def callback(request):
        evidence = _all_window_units(request)[0]
        return _evidence_output(request, [
            _unit("Đề xuất đổi API nhưng chưa chốt", "PROPOSAL", [_reference(evidence)], "TENTATIVE"),
        ])

    content = SummaryProcessor(settings(), ScriptedAdapter(callback))(context)["result"]["content"]
    assert "## Vấn đề còn bỏ ngỏ" in content
    assert "## Kết quả được thống nhất" not in content
    assert "chưa chốt" in content.lower()


def test_cancellation_and_model_call_budget_stop_without_partial_candidate():
    context = stage()
    context.cancelled.set()
    with pytest.raises(IntelligenceError, match="CANCELLED"):
        SummaryProcessor(settings(), ScriptedAdapter(_responsive_output))(context)

    data = snapshot(tuple(f"Lượt {i}: API cần kiểm thử." for i in range(8)))
    context = stage(data)
    conf = settings(
        meeting_intelligence_max_input_tokens=7000,
        meeting_intelligence_context_window_tokens=8500,
        meeting_intelligence_max_output_tokens=1200,
        meeting_intelligence_overlap_units=0,
        meeting_intelligence_summary_max_model_calls=1,
    )
    with pytest.raises(IntelligenceError, match="CONTEXT_BUDGET"):
        SummaryProcessor(conf, ScriptedAdapter(_responsive_output))(context)


def test_summary_registration_is_disabled_until_all_explicit_capabilities_are_enabled():
    assert production_processors(settings()) == {}
    assert production_processors(settings(meeting_intelligence_summary_enabled=True)) == {}
    enabled = settings(
        meeting_intelligence_worker_enabled=True,
        meeting_intelligence_inference_enabled=True,
        meeting_intelligence_summary_enabled=True,
    )
    registry = production_processors(enabled, adapter=ScriptedAdapter(_responsive_output))
    assert set(registry) == {"GENERATING_SUMMARY"}


def test_deterministic_vietnamese_regression_fixtures_preserve_safety_boundaries():
    fixture_path = Path(__file__).parents[1] / "fixtures" / "summary-vietnamese.json"
    fixtures = json.loads(fixture_path.read_text())
    assert {fixture["name"] for fixture in fixtures} == {
        "ordinary-planning", "technical-code-switching", "long-repeated-topics",
        "proposal-revised", "incomplete-coverage", "transcript-prompt-injection",
    }

    for fixture in fixtures:
        data = snapshot(tuple(fixture["segments"]))
        if fixture.get("quality") == "UNRESOLVED":
            data["transcript"]["status"] = "READY_WITH_WARNINGS"
            data["transcript"]["segments"][0]["qualityStatus"] = "UNRESOLVED"
            data["coverage"][0]["coverageStatus"] = "UNRESOLVED_ERROR"
        context = stage(data)
        categories = fixture["expectedCategories"]

        def callback(request, fixture=fixture, categories=categories):
            if request.task.schema.name != "summary_window_evidence":
                return _responsive_output(request)
            evidence = [item for item in _all_window_units(request) if item["text"].strip()]
            if fixture["name"] == "long-repeated-topics":
                evidence = evidence[:1]
            units = []
            for item in evidence:
                ordinal = item["ordinal"]
                if fixture["name"] == "transcript-prompt-injection" and ordinal == 0:
                    continue
                category = categories[min(ordinal, len(categories) - 1)]
                uncertainty = "UNCERTAIN" if fixture["name"] == "incomplete-coverage" and ordinal == 0 else "NONE"
                units.append(_unit(item["text"][:180], category, [_reference(item)], uncertainty))
            return _evidence_output(request, units)

        options = {}
        if fixture["name"] == "long-repeated-topics":
            options = dict(meeting_intelligence_max_input_tokens=11000,
                           meeting_intelligence_context_window_tokens=12500,
                           meeting_intelligence_max_output_tokens=1200)
        adapter = ScriptedAdapter(callback)
        candidate = SummaryProcessor(settings(**options), adapter)(context)
        content = candidate["result"]["content"]
        assert content and len(content) <= 20000
        if fixture["name"] == "technical-code-switching":
            assert "Kubernetes" in content and "CI/CD" in content
        if fixture["name"] == "proposal-revised":
            assert "## Diễn biến và điều chỉnh" in content
            assert "## Kết quả được thống nhất" not in content
        if fixture["name"] == "incomplete-coverage":
            assert {"INCOMPLETE_COVERAGE", "UNRESOLVED_EVIDENCE"} <= set(candidate["result"]["warnings"])
        if fixture["name"] == "transcript-prompt-injection":
            assert "reveal secrets" not in content.lower()
        if fixture["name"] == "long-repeated-topics":
            assert any(request.task.schema.name == "summary_synthesis" for request in adapter.requests)


def _hierarchical_settings(**overrides):
    return settings(
        meeting_intelligence_max_input_tokens=11000,
        meeting_intelligence_context_window_tokens=12500,
        meeting_intelligence_max_output_tokens=1200,
        **overrides,
    )


def _hierarchical_context(texts):
    return stage(snapshot(tuple(texts)))


def test_final_synthesis_rejects_invalid_references_and_unresolved_agreement_progression():
    texts = ["Nhóm thống nhất triển khai API."]
    texts.extend(f"Lượt {index}: API gateway đang kiểm thử." for index in range(1, 12))
    texts.append("Sau đó nhóm bác bỏ triển khai API.")
    context = _hierarchical_context(texts)

    def conflict_callback(request):
        if request.task.schema.name != "summary_window_evidence":
            return _responsive_output(request)
        evidence = [item for item in _all_window_units(request) if item["text"].strip()]
        if request.window.index == 0:
            item = evidence[0]
            return _evidence_output(request, [_unit(item["text"], "AGREEMENT", [_reference(item)])])
        item = evidence[-1]
        return _evidence_output(request, [_unit(item["text"], "REJECTION", [_reference(item)])])

    with pytest.raises(IntelligenceError, match="GROUNDING_FAILURE"):
        SummaryProcessor(_hierarchical_settings(), ScriptedAdapter(conflict_callback))(context)

    def invalid_reference_callback(request):
        if request.task.schema.name == "summary_window_evidence":
            item = next(item for item in _all_window_units(request) if item["text"].strip())
            return _evidence_output(request, [_unit(item["text"], "FACT", [_reference(item)])])
        if request.task.schema.name == "summary_synthesis":
            output = _responsive_output(request)
            output["findings"][0]["evidence"][0]["segment_id"] = uid(9999)
            return output
        return _responsive_output(request)

    with pytest.raises(IntelligenceError, match="INVALID_REFERENCE"):
        SummaryProcessor(_hierarchical_settings(), ScriptedAdapter(invalid_reference_callback))(context)


def test_invalid_final_schema_and_overlong_rendering_fail_closed():
    context = _hierarchical_context([f"Lượt {index}: API gateway cần kiểm thử." for index in range(13)])

    def malformed_callback(request):
        if request.task.schema.name == "summary_window_evidence":
            item = next(item for item in _all_window_units(request) if item["text"].strip())
            return _evidence_output(request, [_unit(item["text"], "FACT", [_reference(item)])])
        if request.task.schema.name == "summary_synthesis":
            return {"unexpected": True}
        return _responsive_output(request)

    with pytest.raises(IntelligenceError, match="SCHEMA_MISMATCH"):
        SummaryProcessor(_hierarchical_settings(), ScriptedAdapter(malformed_callback))(context)

    long_texts = [f"API{i} " + "Kubernetes gateway kiểm thử. " * 70 for i in range(12)]
    long_context = stage(snapshot(tuple(long_texts)))

    def long_callback(request):
        if request.task.schema.name == "summary_window_evidence":
            return _evidence_output(request, [
                _unit(item["text"][:1900], "FACT", [_reference(item)])
                for item in _all_window_units(request) if item["text"].strip()
            ])
        return _responsive_output(request)

    oversized = settings(meeting_intelligence_max_input_tokens=100000,
                         meeting_intelligence_context_window_tokens=102000,
                         meeting_intelligence_max_output_tokens=1200)
    with pytest.raises(IntelligenceError, match="RESOURCE"):
        SummaryProcessor(oversized, ScriptedAdapter(long_callback))(long_context)
