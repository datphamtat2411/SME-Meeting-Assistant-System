import json
import os
from dataclasses import replace
from pathlib import Path

import pytest
from intelligence_support import settings, snapshot, stage, uid

from sme_meeting_ai.meeting_intelligence.contracts import ModelResult, ModelUsage
from sme_meeting_ai.meeting_intelligence.decision import DecisionProcessor
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
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
        reasoning_effort=request.reasoning_effort,
    )


def _reference(item):
    return {
        "segment_id": item["segment_id"],
        "char_start": item["char_start"],
        "char_end": item["char_end"],
    }


def _signal(spec, evidence):
    return {
        "proposition": spec["proposition"],
        "scope": spec["scope"],
        "status": spec["status"],
        "uncertainty": spec["uncertainty"],
        "qualification": spec["qualification"],
        "requires_context": False,
        "evidence": [_reference(evidence)],
    }


class ScriptedAdapter:
    def __init__(self, callback):
        self.callback = callback
        self.requests = []

    def complete(self, request):
        self.requests.append(request)
        return _result(request, self.callback(request))


def _window_evidence(request):
    return json.loads(request.window.evidence_json)["evidence"]


def _derived_identity(payload):
    source = payload["source"]
    return {
        "source_snapshot_id": source["snapshot_id"],
        "transcript_id": source["transcript_id"],
        "content_revision": source["content_revision"],
    }


def _fixture_callback(fixture, *, reverse=False):
    by_ordinal = {spec["ordinal"]: spec for spec in fixture["signals"]}

    def callback(request):
        if request.task.schema.name == "decision_window_signals":
            output = []
            seen = set()
            for evidence in _window_evidence(request):
                spec = by_ordinal.get(evidence["ordinal"])
                if spec is None or spec["ordinal"] in seen or not evidence["text"].strip():
                    continue
                seen.add(spec["ordinal"])
                output.append(_signal(spec, evidence))
            return {**_identity(request), "signals": output}

        payload = json.loads(request.window.evidence_json)
        output = list(payload["signals"])
        if reverse:
            output.reverse()
        return {**_derived_identity(payload), "signals": output}

    return callback


def _fixture(name):
    path = Path(__file__).parents[1] / "fixtures" / "decision-vietnamese.json"
    return next(item for item in json.loads(path.read_text()) if item["name"] == name)


def _fixture_data(fixture):
    data = snapshot(tuple(fixture["segments"]))
    if fixture.get("quality") == "UNRESOLVED":
        data["transcript"]["status"] = "READY_WITH_WARNINGS"
        data["transcript"]["segments"][0]["qualityStatus"] = "UNRESOLVED"
        data["coverage"][0]["coverageStatus"] = "UNRESOLVED_ERROR"
    return data


def _decision_stage(data=None):
    return replace(stage(data), stage_code="EXTRACTING_DECISIONS")


@pytest.mark.parametrize("name", [
    "explicit-agreement", "proposal-without-approval", "proposal-rejected-final-retained",
    "decision-revised", "proposal-and-agreement-different-windows", "same-technology-different-scopes",
    "overlap-repeat", "conditional-adoption", "action-items-only", "no-valid-decision",
    "incomplete-coverage", "prompt-injection-transcript", "vietnamese-english-technical",
    "historical-reference", "contradictory-unresolved",
])
def test_vietnamese_decision_fixtures_are_conservative_and_grounded(name):
    fixture = _fixture(name)
    options = {}
    if fixture.get("long"):
        options.update(
            meeting_intelligence_max_input_tokens=7000,
            meeting_intelligence_context_window_tokens=8500,
            meeting_intelligence_max_output_tokens=1200,
        )
    adapter = ScriptedAdapter(_fixture_callback(fixture))
    candidate = DecisionProcessor(settings(**options), adapter)(_decision_stage(_fixture_data(fixture)))
    result = candidate["result"]

    assert len(result["candidates"]) == fixture["expectedCandidates"]
    assert all(item["evidenceSegmentIds"] for item in result["candidates"])
    assert all("SPEAKER_" not in item["content"] for item in result["candidates"])
    if fixture.get("contentIncludes"):
        assert fixture["contentIncludes"] in result["candidates"][0]["content"]
    if fixture.get("expectedUncertainty"):
        assert result["candidates"][0]["uncertainty"] == fixture["expectedUncertainty"]
    if fixture.get("expectedWarnings"):
        assert set(fixture["expectedWarnings"]) <= set(result["warnings"])
    if name == "prompt-injection-transcript":
        assert not any("reveal secrets" in item["content"].lower() for item in result["candidates"])
    if fixture.get("long"):
        assert len(adapter.requests) > 1
        assert any(request.task.schema.name == "decision_synthesis_signals" for request in adapter.requests)


def test_repeated_window_evidence_is_deduplicated_and_candidate_keys_are_order_independent():
    fixture = _fixture("overlap-repeat")
    data = _fixture_data(fixture)
    first = DecisionProcessor(settings(), ScriptedAdapter(_fixture_callback(fixture)))(_decision_stage(data))
    second = DecisionProcessor(settings(), ScriptedAdapter(_fixture_callback(fixture, reverse=True)))(_decision_stage(data))
    assert first["result"]["candidates"] == second["result"]["candidates"]
    assert len(first["result"]["candidates"]) == 1


def test_invalid_references_and_ungrounded_adoption_fail_closed():
    context = _decision_stage(snapshot(("Tôi đề xuất dùng Redis cho hệ thống mới.",)))

    def invalid_reference(request):
        evidence = _window_evidence(request)[0]
        item = _signal({
            "ordinal": 0,
            "scope": "hệ thống mới",
            "proposition": evidence["text"],
            "status": "PROPOSED",
            "uncertainty": "NONE",
            "qualification": "",
        }, evidence)
        item["evidence"][0]["segment_id"] = uid(9999)
        return {**_identity(request), "signals": [item]}

    with pytest.raises(IntelligenceError, match="INVALID_REFERENCE"):
        DecisionProcessor(settings(), ScriptedAdapter(invalid_reference))(context)

    def unsupported_adoption(request):
        evidence = _window_evidence(request)[0]
        return {
            **_identity(request),
            "signals": [_signal({
                "ordinal": 0,
                "scope": "hệ thống mới",
                "proposition": evidence["text"],
                "status": "ACCEPTED",
                "uncertainty": "NONE",
                "qualification": "",
            }, evidence)],
        }

    with pytest.raises(IntelligenceError, match="GROUNDING_FAILURE"):
        DecisionProcessor(settings(), ScriptedAdapter(unsupported_adoption))(context)


def test_invalid_schema_is_not_converted_to_an_empty_success():
    def malformed(request):
        return {"unexpected": True}

    with pytest.raises(IntelligenceError, match="SCHEMA_MISMATCH"):
        DecisionProcessor(settings(), ScriptedAdapter(malformed))(_decision_stage())


def test_historical_adoption_is_not_emitted_even_if_model_misclassifies_the_state():
    fixture = _fixture("historical-reference")
    base = _fixture_callback(fixture)

    def misclassified(request):
        output = base(request)
        if request.task.schema.name == "decision_window_signals":
            for signal in output["signals"]:
                signal["status"] = "ACCEPTED"
        return output

    result = DecisionProcessor(settings(), ScriptedAdapter(misclassified))(
        _decision_stage(_fixture_data(fixture)),
    )["result"]
    assert result["candidates"] == []


def test_cancellation_and_model_call_budget_stop_without_partial_candidate():
    context = _decision_stage()
    context.cancelled.set()
    with pytest.raises(IntelligenceError, match="CANCELLED"):
        DecisionProcessor(settings(), ScriptedAdapter(_fixture_callback(_fixture("no-valid-decision"))))(context)

    fixture = _fixture("proposal-and-agreement-different-windows")
    data = _fixture_data(fixture)
    options = dict(
        meeting_intelligence_max_input_tokens=7000,
        meeting_intelligence_context_window_tokens=8500,
        meeting_intelligence_max_output_tokens=1200,
        meeting_intelligence_decision_max_model_calls=1,
    )
    with pytest.raises(IntelligenceError, match="CONTEXT_BUDGET"):
        DecisionProcessor(settings(**options), ScriptedAdapter(_fixture_callback(fixture)))(_decision_stage(data))


def test_decision_registration_is_independent_of_summary():
    adapter = ScriptedAdapter(_fixture_callback(_fixture("explicit-agreement")))
    base = dict(meeting_intelligence_worker_enabled=True, meeting_intelligence_inference_enabled=True)
    decision_only = production_processors(settings(**base, meeting_intelligence_decision_enabled=True), adapter=adapter)
    assert decision_only.keys() == {"EXTRACTING_DECISIONS"}
    both = production_processors(settings(**base, meeting_intelligence_summary_enabled=True,
                                         meeting_intelligence_decision_enabled=True), adapter=adapter)
    assert set(both) == {"GENERATING_SUMMARY", "EXTRACTING_DECISIONS"}
    summary_only = production_processors(settings(**base, meeting_intelligence_summary_enabled=True), adapter=adapter)
    assert set(summary_only) == {"GENERATING_SUMMARY"}
    assert production_processors(settings(**base, meeting_intelligence_decision_enabled=True), adapter=None) == {}


def test_decision_defaults_are_disabled_and_bounded():
    configured = settings()
    assert configured.meeting_intelligence_decision_enabled is False
    assert configured.meeting_intelligence_decision_max_signals == 2048
    assert configured.meeting_intelligence_decision_max_candidates == 128
    assert configured.meeting_intelligence_decision_max_synthesis_depth == 3
    assert configured.meeting_intelligence_decision_max_model_calls == 128
