import copy
import hashlib
import json
from types import SimpleNamespace

import pytest

from .meeting_intelligence_support import (
    ActionReference,
    AnnotationProvenance,
    CaseDescriptor,
    DecisionReference,
    EvaluationError,
    EvidenceReference,
    GatePolicy,
    ReferenceAnnotations,
    ReferenceDescriptor,
    SourceDescriptor,
    SummaryFact,
    SummaryHumanReview,
    build_evaluation_report,
    compare_reports,
    cross_feature_consistency,
    decision_metrics,
    evaluate_quality_gates,
    human_review_metrics,
    load_meeting_dataset,
    render_evaluation_summary,
    score_action_items,
    score_summary,
    validate_processor_candidate,
)
from .support import canonical_json


def _source(texts):
    from intelligence_support import snapshot, uid

    data = snapshot(tuple(texts))
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    return data, raw, uid(6), uid(1), uid(2), uid(3)


def _descriptor(root, data, raw, *, name="source.json"):
    transcript = data["transcript"]
    return SourceDescriptor(
        schema_version=1,
        path=f"sources/{name}",
        sha256=hashlib.sha256(raw).hexdigest(),
        snapshot_id="00000000-0000-0000-0000-000000000006",
        transcript_id=transcript["id"],
        meeting_id=transcript["meetingId"],
        source_media_id=transcript["sourceMediaId"],
        content_revision=transcript["contentRevision"],
        language="vi",
        size_bytes=len(raw),
    )


def _reference_descriptor(raw, name="reference.json"):
    return ReferenceDescriptor(
        schema_version=1,
        path=f"references/{name}",
        sha256=hashlib.sha256(raw).hexdigest(),
        reference_version="reference-1",
        annotation_version="annotation-1",
        origin="synthetic-independent",
    )


def _evidence(segment_id, end=200):
    return EvidenceReference(segment_id=segment_id, char_start=0, char_end=end)


def _annotations(data, *, decisions=(), actions=(), facts=(), warnings=()):
    from intelligence_support import uid

    return ReferenceAnnotations(
        schema_version=1,
        fixture_id="case-1",
        reference_version="reference-1",
        annotation_version="annotation-1",
        source_snapshot_id=uid(6),
        transcript_id=uid(1),
        content_revision=3,
        source_sha256="a" * 64,
        provenance=AnnotationProvenance(
            origin="synthetic-independent", review_status="NOT_REVIEWED", reviewers=[], disagreement_count=0,
        ),
        summary_facts=list(facts),
        decisions=list(decisions),
        action_items=list(actions),
        expected_warnings=list(warnings),
    )


def test_source_and_reference_contracts_reject_unsafe_or_conflicting_data(tmp_path):
    data, raw, *_ = _source(("Nhóm thống nhất dùng PostgreSQL.",))
    source = _descriptor(tmp_path, data, raw)
    reference_raw = canonical_json({"schema_version": 1}).encode()
    descriptor = _reference_descriptor(reference_raw)
    case = CaseDescriptor(
        fixture_id="case-1", dataset_version="2026.11.1", source=source, reference=descriptor,
        annotation_version="annotation-1", categories=["short-routine"],
        features=["summary", "decision", "action"], eligibility="DETERMINISTIC_REGRESSION",
    )
    assert case.source.sha256 == hashlib.sha256(raw).hexdigest()
    with pytest.raises(ValueError):
        SourceDescriptor.model_validate({**source.model_dump(), "path": "../private.json"})
    first = DecisionReference(
        decision_id="d-1", match_key="same", scope="cơ sở dữ liệu", scope_phrases=["cơ sở dữ liệu"],
        outcome="PostgreSQL", outcome_phrases=["PostgreSQL"], status="ACCEPTED", valid=True,
        uncertainty="NONE", evidence=[_evidence("00000000-0000-0000-0000-000000000064")],
    )
    second = first.model_copy(update={"decision_id": "d-2", "valid": False, "status": "REJECTED",
                                      "negative_category": "rejected-proposal"})
    with pytest.raises(ValueError, match="conflicting"):
        _annotations(data, decisions=(first, second))


def test_decision_matching_is_one_to_one_and_records_negative_failures():
    ref = DecisionReference(
        decision_id="d-1", match_key="postgresql-reporting", scope="cơ sở dữ liệu báo cáo",
        scope_phrases=["báo cáo"], outcome="PostgreSQL", outcome_phrases=["PostgreSQL"],
        status="ACCEPTED", valid=True, uncertainty="NONE",
        evidence=[_evidence("00000000-0000-0000-0000-000000000064")],
    )
    rejected = DecisionReference(
        decision_id="d-old", match_key="mongodb-reporting", scope="cơ sở dữ liệu báo cáo",
        scope_phrases=["báo cáo"], outcome="MongoDB", outcome_phrases=["MongoDB"],
        status="REJECTED", valid=False, uncertainty="NONE", negative_category="rejected-proposal",
        evidence=[_evidence("00000000-0000-0000-0000-000000000064")],
    )
    annotations = SimpleNamespace(decisions=(ref, rejected))
    prediction = {
        "producer": {"model": "controlled/model", "promptVersion": "decision-v1", "provider": "controlled"},
        "result": {"candidates": [
            {"candidateKey": "one", "content": "Nhóm thống nhất dùng PostgreSQL cho báo cáo.",
             "evidenceSegmentIds": ["00000000-0000-0000-0000-000000000064"], "uncertainty": "NONE"},
            {"candidateKey": "two", "content": "Nhóm thống nhất dùng PostgreSQL cho báo cáo.",
             "evidenceSegmentIds": ["00000000-0000-0000-0000-000000000064"], "uncertainty": "NONE"},
        ], "warnings": []},
    }
    metrics = decision_metrics(prediction, annotations)
    assert metrics["true_positive"] == 1
    assert metrics["false_positive"] == 1
    assert metrics["false_negative"] == 0
    assert metrics["duplicate_candidate_count"] == 1
    assert metrics["precision"] == {"numerator": 1, "denominator": 2}


def test_summary_coverage_grounding_warnings_and_regions_are_separate():
    facts = (
        SummaryFact(
            fact_id="f-early", match_key="api-plan", statement="Rà soát API",
            match_phrases=["rà soát API"], importance="critical", region="early",
            evidence=[_evidence("00000000-0000-0000-0000-000000000064")],
        ),
        SummaryFact(
            fact_id="f-late", match_key="rollback", statement="Cần kiểm tra rollback",
            match_phrases=["rollback"], importance="material", region="late",
            required_qualifications=["chưa chốt"],
            required_uncertainty_terms=["có thể"],
            evidence=[_evidence("00000000-0000-0000-0000-000000000065")],
        ),
    )
    annotations = SimpleNamespace(summary_facts=facts, expected_warnings=("INCOMPLETE_COVERAGE",))
    prediction = {"result": {"content": """# Tóm tắt cuộc họp

## Chủ đề chính
- Rà soát API
""", "warnings": []}}
    metrics = score_summary(prediction, annotations)
    assert metrics["coverage_rate"] == {"numerator": 1, "denominator": 2}
    assert metrics["material_omission_count"] == 1
    assert metrics["groundedness_status"] == "UNESTABLISHED"
    assert metrics["warning_recall"] == {"numerator": 0, "denominator": 1}
    assert metrics["coverage_by_region"]["early"] == {"numerator": 1, "denominator": 1}
    assert metrics["coverage_by_region"]["late"] == {"numerator": 0, "denominator": 1}
    assert metrics["uncertainty_missing_count"] == 1


def test_action_metrics_keep_due_dates_and_cancellation_distinct():
    active = ActionReference(
        action_id="a-1", match_key="send-report", action="gửi báo cáo", deliverable="báo cáo",
        action_phrases=["gửi báo cáo"], deliverable_phrases=["báo cáo"], state="ACTIVE", valid=True,
        mentioned_party="Lan", party_phrases=["Lan"], due_date="2026-11-15", due_date_phrases=["15/11/2026"],
        evidence=[_evidence("00000000-0000-0000-0000-000000000064")],
    )
    cancelled = active.model_copy(update={
        "action_id": "a-old", "match_key": "cancelled-check", "action": "kiểm tra lỗi", "deliverable": "lỗi",
        "action_phrases": ["kiểm tra lỗi"], "deliverable_phrases": ["lỗi"], "state": "CANCELLED", "valid": False,
        "mentioned_party": None, "party_phrases": [], "due_date": None, "due_date_phrases": [],
        "negative_category": "cancelled-task",
    })
    annotations = SimpleNamespace(action_items=(active, cancelled))
    prediction = {"result": {"candidates": [
        {"candidateKey": "active", "title": "gửi báo cáo", "details": "Người được nhắc trong bằng chứng: Lan.",
         "suggestedDueDate": None, "evidenceSegmentIds": ["00000000-0000-0000-0000-000000000064"]},
        {"candidateKey": "cancelled", "title": "kiểm tra lỗi", "details": None,
         "suggestedDueDate": None, "evidenceSegmentIds": ["00000000-0000-0000-0000-000000000064"]},
    ]}}
    metrics = score_action_items(prediction, annotations)
    assert metrics["true_positive"] == 1
    assert metrics["false_positive"] == 1
    assert metrics["unsupported_due_date"] == 0
    assert metrics["missing_supported_due_date"] == 1
    assert metrics["cancelled_task_false_positive_count"] == 1
    assert any(item["category"] == "CANCELLED_WORK_ACTIVE" for item in metrics["critical_failures"])


def test_zero_denominators_and_quality_gates_never_become_perfect():
    empty = SimpleNamespace(decisions=())
    metrics = decision_metrics({"result": {"candidates": []}}, empty)
    assert metrics["precision"] is None and metrics["recall"] is None and metrics["f1"] is None
    assert "precision" in metrics["undefined_metrics"]
    policy = GatePolicy(
        schema_version=1, policy_version="policy-1", minimum_reference_coverage=1,
        minimum_evaluated_cases=1, minimum_decision_precision={"numerator": 1, "denominator": 1},
        minimum_decision_recall={"numerator": 1, "denominator": 1},
        minimum_action_precision=None, minimum_action_recall=None, minimum_summary_groundedness=None,
        maximum_critical_failures=0, require_human_review=True, required_categories=["short-routine"],
    )
    result = evaluate_quality_gates(policy, mode="deterministic-offline", reference_reviewed=False,
                                    attempted_cases=1, reference_coverage=1, metrics={})
    assert result["model_quality_gate"] == "UNESTABLISHED"
    assert result["production_readiness_gate"] == "UNAVAILABLE"
    approved = evaluate_quality_gates(policy, mode="offline-captured-real", reference_reviewed=True,
                                       attempted_cases=1, reference_coverage=1,
                                       metrics={"decision_precision": {"numerator": 1, "denominator": 1},
                                                "decision_recall": {"numerator": 1, "denominator": 1}},
                                       category_coverage=[])
    assert approved["model_quality_gate"] == "FAIL"
    assert approved["missing_required_categories"] == ["short-routine"]


def test_cross_feature_consistency_and_report_comparison_expose_regressions():
    refs = SimpleNamespace(decisions=(), action_items=())
    predictions = {
        "summary": {"result": {"content": "# Tóm tắt\n- Nhóm đã thống nhất dùng Redis.", "warnings": []}},
        "decision": {"result": {"candidates": []}},
        "action": {"result": {"candidates": []}},
    }
    checks = cross_feature_consistency(predictions, refs)
    assert any(item["category"] == "SUMMARY_UNSUPPORTED_CONCLUSION" for item in checks["findings"])
    manifest = SimpleNamespace(
        dataset_id="meeting-intelligence", dataset_version="1", manifest_sha256="a" * 64,
        annotation_version="annotation-1", scoring_policy_version="score-1",
    )
    first = build_evaluation_report(manifest, [], mode="deterministic-offline", policy=None)
    second = copy.deepcopy(first)
    second["run"]["run_id"] = "other"
    comparison = compare_reports(first, second)
    assert comparison["status"] == "COMPARABLE"
    second["dataset"]["dataset_version"] = "2"
    assert compare_reports(first, second)["status"] == "INCOMPATIBLE"


def test_canonical_candidate_validation_rejects_invalid_empty_substitution():
    from intelligence_support import snapshot, uid

    data = snapshot(("Nhóm thống nhất dùng PostgreSQL.",))
    claim = SimpleNamespace(
        executionStageCode="EXTRACTING_DECISIONS", processingJobId=uid(4), executionStageRunId=uid(5),
        eventId=uid(7), resultSlot=None, claimToken=SimpleNamespace(get_secret_value=lambda: "token"),
        source=SimpleNamespace(snapshotId=uid(6), transcriptId=uid(1), contentRevision=3,
                               sha256=hashlib.sha256(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()),
    )
    bad = {"producer": {"model": "x", "promptVersion": "decision-v1"}, "result": {"candidates": []}}
    with pytest.raises(EvaluationError):
        validate_processor_candidate("decision", bad, data, claim)


def test_report_aggregates_feature_metrics_and_renders_safe_summary():
    manifest = SimpleNamespace(
        dataset_id="meeting-intelligence", dataset_version="1", manifest_sha256="a" * 64,
        annotation_guideline_version="annotation-1", scoring_policy_version="score-1", cases=(),
    )
    rows = [
        {"fixture_id": "case-1", "feature": "decision", "status": "SUCCESS", "reference_reviewed": True,
         "metrics": {"prediction_count": 1, "reference_count": 1, "true_positive": 1,
                     "false_positive": 0, "false_negative": 0, "duplicate_candidate_count": 0,
                     "uncertainty_correct_count": 1, "critical_failures": [], "evidence": []}},
        {"fixture_id": "case-2", "feature": "decision", "status": "SUCCESS", "reference_reviewed": True,
         "metrics": {"prediction_count": 2, "reference_count": 1, "true_positive": 1,
                     "false_positive": 1, "false_negative": 0, "duplicate_candidate_count": 0,
                     "uncertainty_correct_count": 1, "critical_failures": [], "evidence": []}},
    ]
    report = build_evaluation_report(manifest, rows, mode="offline-captured-real", policy=None)
    metrics = report["feature_metrics"]["decision"]["metrics"]
    assert metrics["precision"] == {"numerator": 2, "denominator": 3}
    assert metrics["recall"] == {"numerator": 2, "denominator": 2}
    assert report["gates"]["reference_coverage"] == 2
    summary = render_evaluation_summary(report)
    assert "## Feature Metrics" in summary
    assert "2/3 (66.7%)" in summary
    assert "prediction" not in summary


def test_human_review_metrics_are_explicit_and_dates_are_calendar_valid():
    review = SummaryHumanReview(
        fixture_id="case-1", reviewer_id="reviewer-1", readability="GOOD", usefulness="ACCEPTABLE",
    )
    assert human_review_metrics([review])["status"] == "ESTABLISHED"
    with pytest.raises(ValueError, match="ISO calendar date"):
        ActionReference(
            action_id="a-invalid", match_key="invalid-date", action="gửi báo cáo", deliverable="báo cáo",
            action_phrases=["gửi báo cáo"], deliverable_phrases=["báo cáo"], state="ACTIVE", valid=True,
            due_date="2026-02-30", due_date_phrases=["30/02/2026"],
            evidence=[_evidence("00000000-0000-0000-0000-000000000064")],
        )


def test_committed_vietnamese_corpus_loads_through_core_snapshot_and_evidence_contracts():
    from pathlib import Path

    root = Path(__file__).parent / "fixtures"
    dataset = load_meeting_dataset(root, manifest_path=root / "meeting-intelligence-manifest.json")
    assert len(dataset.cases) == 4
    assert set(dataset.manifest.required_categories) <= {
        category for case in dataset.manifest.cases for category in case.categories
    }
    assert all(case.source.identity.sha256 == case.descriptor.source.sha256 for case in dataset.cases)
    assert all(case.reference.provenance.review_status == "NOT_REVIEWED" for case in dataset.cases)
