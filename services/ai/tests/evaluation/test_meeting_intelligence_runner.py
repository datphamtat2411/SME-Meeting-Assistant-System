import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from sme_meeting_ai.meeting_intelligence.contracts import ModelResult, ModelUsage
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError

from .meeting_intelligence_runner import (
    EvaluationMode,
    build_review_template,
    load_captured_run,
    require_live_evaluation,
    run_processor_case,
    score_captured_run,
)
from .meeting_intelligence_support import EvaluationError
from .support import canonical_json


def _adapter(callback):
    class Adapter:
        def __init__(self):
            self.requests = []

        def complete(self, request):
            self.requests.append(request)
            identity = request.window.source
            output = callback(request)
            return ModelResult(
                output=output,
                requested_model=request.model,
                reported_model=request.model,
                provider="controlled",
                reported_provider="controlled",
                prompt_version=request.task.prompt_version,
                schema_version=request.task.schema.version,
                schema_sha256=request.task.schema.sha256,
                source=identity,
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

    return Adapter()


def _identity(request):
    identity = request.window.source
    return {
        "source_snapshot_id": identity.snapshot_id,
        "transcript_id": identity.transcript_id,
        "content_revision": identity.content_revision,
    }


def test_controlled_runner_invokes_actual_processor_and_preserves_empty_success():
    from intelligence_support import settings, snapshot, stage

    data = snapshot(("Không có quyết định hay nhiệm vụ trong cuộc họp.",))

    def response(request):
        if request.task.schema.name == "decision_window_signals":
            return {**_identity(request), "signals": []}
        raise AssertionError("decision should not require derived calls")

    result = run_processor_case(
        "decision", replace(stage(data), stage_code="EXTRACTING_DECISIONS"), settings(), _adapter(response),
        mode=EvaluationMode.DETERMINISTIC_OFFLINE,
        fixture_id="fixture-1",
    )
    assert result["status"] == "SUCCESS"
    assert result["empty_result"] is True
    assert result["failure_category"] is None
    assert result["provenance"]["provider"] == "controlled"
    assert result["telemetry"]["call_count"] == 1
    assert result["quality_status"] == "UNESTABLISHED"
    assert result["fixture_id"] == "fixture-1"


def test_controlled_runner_does_not_turn_processor_failure_into_empty_result():
    from intelligence_support import settings, stage

    def failure(_request):
        raise IntelligenceError("PROVIDER")

    result = run_processor_case(
        "decision", replace(stage(), stage_code="EXTRACTING_DECISIONS"), settings(), _adapter(failure),
        mode=EvaluationMode.DETERMINISTIC_OFFLINE,
    )
    assert result["status"] == "FAILED"
    assert result["empty_result"] is False
    assert result["failure_category"] == "PROVIDER"
    assert result["metrics"] is None


def test_controlled_runner_uses_summary_and_action_production_processors():
    from intelligence_support import settings, snapshot, stage

    data = snapshot(("Nhóm rà soát API và kế hoạch triển khai.",))

    def summary_response(request):
        payload = json.loads(request.window.evidence_json)
        evidence = payload["evidence"][0]
        identity = _identity(request)
        if request.task.schema.name == "summary_window_evidence":
            return {**identity, "units": [{
                "statement": evidence["text"], "category": "FACT", "uncertainty": "NONE",
                "qualification": "", "evidence": [{"segment_id": evidence["segment_id"],
                                                       "char_start": evidence["char_start"],
                                                       "char_end": evidence["char_end"]}],
            }]}
        raise AssertionError("short summary should not use derived synthesis")

    summary = run_processor_case(
        "summary", stage(data), settings(), _adapter(summary_response), mode=EvaluationMode.DETERMINISTIC_OFFLINE,
    )
    assert summary["status"] == "SUCCESS"
    assert summary["empty_result"] is False
    assert "API" in summary["prediction"]["result"]["content"]

    def action_response(request):
        return {**_identity(request), "signals": []}

    action = run_processor_case(
        "action", replace(stage(data), stage_code="EXTRACTING_ACTION_ITEMS"), settings(),
        _adapter(action_response), mode=EvaluationMode.DETERMINISTIC_OFFLINE,
    )
    assert action["status"] == "SUCCESS"
    assert action["empty_result"] is True


def test_captured_output_requires_safe_json_and_preserves_failed_status(tmp_path):
    path = tmp_path / "captured.json"
    path.write_text(canonical_json({
        "schema_version": 1, "evaluation_version": "meeting-intelligence-1",
        "mode": "offline-captured-real", "dataset": {"dataset_id": "d", "dataset_version": "1"},
        "results": [{"fixture_id": "case-1", "feature": "decision", "status": "FAILED",
                      "failure_category": "PROVIDER", "prediction": None,
                      "source": {"snapshot_id": "s", "transcript_id": "t", "content_revision": 1,
                                 "source_sha256": "a" * 64}}],
    }))
    captured = load_captured_run(path)
    assert captured["results"][0]["status"] == "FAILED"
    with pytest.raises(EvaluationError):
        path.write_text('{"schema_version": 1, "schema_version": 1}')
        load_captured_run(path)


def test_live_evaluation_is_never_authorized_by_credentials_alone(monkeypatch):
    from sme_meeting_ai.core.config import Settings

    settings = Settings(service_name="t07-test", service_identity="ai-core", _env_file=None,
                        OPENROUTER_API_KEY="synthetic-key", meeting_intelligence_inference_enabled=True)
    monkeypatch.delenv("RUN_MEETING_INTELLIGENCE_LIVE", raising=False)
    with pytest.raises(EvaluationError):
        require_live_evaluation(settings, operator_opt_in=False, dataset_authorized=True,
                                 max_calls=1, budget=1, output_path="/secure/result.json")
    monkeypatch.setenv("RUN_MEETING_INTELLIGENCE_LIVE", "1")
    with pytest.raises(EvaluationError):
        require_live_evaluation(settings, operator_opt_in=True, dataset_authorized=False,
                                 max_calls=1, budget=1, output_path="/secure/result.json")


def test_review_template_is_explicitly_incomplete_and_does_not_claim_human_review():
    template = build_review_template([{"fixture_id": "case-1", "feature": "summary"}], run_id="run-1")
    assert template["status"] == "NOT_COMPLETED"
    assert template["human_review_status"] == "PENDING"
    assert template["cases"][0]["fixture_id"] == "case-1"


def test_offline_captured_scoring_rejects_incompatible_dataset(tmp_path):
    path = tmp_path / "captured.json"
    path.write_text(canonical_json({
        "schema_version": 1, "evaluation_version": "meeting-intelligence-1",
        "mode": "offline-captured-real", "dataset": {"dataset_id": "other", "dataset_version": "1"},
        "results": [],
    }))
    captured = load_captured_run(path)
    manifest = SimpleNamespace(dataset_id="meeting-intelligence", dataset_version="1")
    with pytest.raises(EvaluationError, match="dataset"):
        score_captured_run(captured, manifest, references={})


def test_offline_captured_scoring_validates_canonical_prediction_shape():
    captured = {
        "mode": "offline-captured-real",
        "dataset": {"dataset_id": "meeting-intelligence", "dataset_version": "1"},
        "results": [{
            "fixture_id": "case-1", "feature": "decision", "status": "SUCCESS",
            "prediction": {"producer": {"model": "model-1", "promptVersion": "prompt-1"},
                           "result": {"candidates": [], "warnings": []}},
        }],
    }
    manifest = SimpleNamespace(dataset_id="meeting-intelligence", dataset_version="1")
    reference = SimpleNamespace(provenance=SimpleNamespace(review_status="NOT_REVIEWED"), decisions=())
    report = score_captured_run(captured, manifest, {"case-1": reference})
    assert report["feature_metrics"]["decision"]["case_count"] == 1

    captured["results"][0]["prediction"]["result"] = {"candidates": [{"bad": True}], "warnings": []}
    with pytest.raises(EvaluationError, match="canonical shape"):
        score_captured_run(captured, manifest, {"case-1": reference})
