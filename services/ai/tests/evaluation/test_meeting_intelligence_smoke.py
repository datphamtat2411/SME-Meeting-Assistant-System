import json
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from intelligence_support import settings, snapshot, stage, task, uid

from sme_meeting_ai.meeting_intelligence.action_items import extraction_task
from sme_meeting_ai.meeting_intelligence.composition import prepare_context
from sme_meeting_ai.meeting_intelligence.contracts import ModelResult, ModelUsage
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
from sme_meeting_ai.providers.openrouter_intelligence import (
    OpenRouterIntelligenceAdapter,
)

from .meeting_intelligence_runner import run_action_smoke_case

SMOKE_FIXTURE = json.loads(
    (Path(__file__).parents[1] / "fixtures" / "action-smoke-vietnamese.json").read_text()
)


def _action_context(texts):
    return replace(stage(snapshot(tuple(texts))), stage_code="EXTRACTING_ACTION_ITEMS")


def _identity(request):
    identity = request.window.source
    return {
        "source_snapshot_id": identity.snapshot_id,
        "transcript_id": identity.transcript_id,
        "content_revision": identity.content_revision,
    }


class ScriptedActionAdapter:
    def __init__(self, specs=(), *, invalid_reference=False, metadata=None,
                 group_mode="singleton", group_failure_category=None,
                 reported=True, usage=None):
        self.specs = {}
        for spec in specs:
            self.specs.setdefault(spec["ordinal"], []).append(spec)
        self.invalid_reference = invalid_reference
        self.metadata = metadata
        self.group_mode = group_mode
        self.group_failure_category = group_failure_category
        self.reported = reported
        self.usage = usage or ModelUsage(
            input_tokens=11,
            output_tokens=7,
            total_tokens=18,
            reasoning_tokens=3,
            reported_cost=Fraction(1, 100000),
        )
        self.requests = []
        self.outputs = []

    def _output(self, request):
        payload = json.loads(request.window.evidence_json)
        if request.task.schema.name == "action_window_signals":
            signals = []
            for evidence in payload["evidence"]:
                for spec in self.specs.get(evidence["ordinal"], ()):
                    reference = {
                        "segment_id": evidence["segment_id"],
                        "char_start": evidence["char_start"],
                        "char_end": evidence["char_end"],
                    }
                    if self.invalid_reference:
                        reference["segment_id"] = uid(9999)
                    signals.append({
                        "action": spec["action"],
                        "deliverable": spec["deliverable"],
                        "signal_type": spec["type"],
                        "mentioned_party": spec.get("party", ""),
                        "deadline_expression": spec.get("deadline", ""),
                        "qualification": spec.get("qualification", ""),
                        "uncertainty": "NONE",
                        "requires_context": False,
                        "evidence": [reference],
                    })
            return {**_identity(request), "signals": signals}

        assert request.task.schema.name == "action_resolution_groups"
        source = payload["source"]
        signal_ids = [signal["signal_id"] for signal in payload["signals"]]
        if self.group_mode == "singleton":
            groups = [[signal_id] for signal_id in signal_ids]
        elif self.group_mode == "merge_all":
            groups = [signal_ids]
        elif self.group_mode == "merge_current_assigned":
            groups = [[signal_ids[0], signal_ids[-1]], [signal_ids[1]]
                      ]
        elif self.group_mode == "omit_last":
            groups = [[signal_id] for signal_id in signal_ids[:-1]]
        elif self.group_mode == "hallucinated_id":
            groups = [[signal_id] for signal_id in signal_ids]
            groups.append(["not-a-real-signal"])
        else:
            raise AssertionError(f"unknown group mode: {self.group_mode}")
        return {
            "source_snapshot_id": source["snapshot_id"],
            "transcript_id": source["transcript_id"],
            "content_revision": source["content_revision"],
            "groups": groups,
        }

    def complete(self, request):
        self.requests.append(request)
        if (
            request.task.schema.name == "action_resolution_groups"
            and self.group_failure_category is not None
        ):
            raise IntelligenceError(self.group_failure_category)
        identity = request.window.source
        output = self._output(request)
        self.outputs.append(output)
        return ModelResult(
            output=output,
            requested_model=request.model,
            reported_model=request.model if self.reported else None,
            provider="controlled",
            reported_provider="controlled" if self.reported else None,
            prompt_version=request.task.prompt_version,
            schema_version=request.task.schema.version,
            schema_sha256=request.task.schema.sha256,
            source=identity,
            window_id=request.window.window_id,
            planning_version=request.window.planning_version,
            configuration_sha256=request.window.configuration_sha256,
            task_sha256=request.task.sha256,
            estimated_input_tokens=request.window.estimated_input_tokens,
            usage=self.usage,
            duration_seconds=0.012,
            attempts=1,
            failed_attempt_categories=(),
            reasoning_effort=request.reasoning_effort,
        )


def _metadata(request_count=1, statuses=None):
    return SimpleNamespace(
        request_count=request_count,
        response_statuses=statuses if statuses is not None else [200] * request_count,
        transport_error_count=0,
    )


def _all_fixture_specs():
    expected = SMOKE_FIXTURE["expected"]
    return [
        {
            "ordinal": 0,
            "action": "thiết kế giao diện đã hoàn thành",
            "deliverable": "thiết kế giao diện",
            "type": "HISTORICAL",
        },
        {
            "ordinal": 0,
            "action": "đang tích hợp mô-đun thanh toán",
            "deliverable": "mô-đun thanh toán",
            "type": "COMMITTED",
            "qualification": "hiện đạt khoảng bảy mươi phần trăm",
        },
        {
            "ordinal": expected["evidenceOrdinal"],
            "action": "hoàn thiện tích hợp mô-đun thanh toán và gửi bản chạy thử cho nhóm",
            "deliverable": "bản chạy thử",
            "party": expected["party"],
            "type": "ASSIGNED",
            "deadline": expected["dueDate"],
        },
    ]


class ReplayThenScriptedAdapter:
    """Replay extraction locally, then exercise the real grouping path."""

    def __init__(self, extraction_result, grouping_adapter):
        self.extraction_result = extraction_result
        self.grouping_adapter = grouping_adapter
        self.requests = []

    def complete(self, request):
        self.requests.append(request)
        if len(self.requests) == 1:
            assert request.task.schema.name == "action_window_signals"
            return self.extraction_result
        assert request.task.schema.name == "action_resolution_groups"
        return self.grouping_adapter.complete(request)


def _captured_extraction_result(context, configured, specs):
    seed_adapter = ScriptedActionAdapter(specs)
    prepared = prepare_context(context, extraction_task(), configured)
    return seed_adapter.complete(prepared.request(0))


def test_original_synthetic_fixture_has_one_explicit_grounded_action():
    expected = SMOKE_FIXTURE["expected"]
    adapter = ScriptedActionAdapter([{
        "ordinal": expected["evidenceOrdinal"],
        "action": "hoàn thiện tích hợp mô-đun thanh toán và gửi bản chạy thử cho nhóm",
        "deliverable": "bản chạy thử",
        "party": expected["party"],
        "type": "ASSIGNED",
        "deadline": expected["dueDate"],
    }])
    result = run_action_smoke_case(
        _action_context(SMOKE_FIXTURE["segments"]),
        settings(),
        adapter,
        expected_count=expected["count"],
        expected_action_phrase=expected["actionPhrase"],
        expected_due_date=expected["dueDate"],
        expected_party=expected["party"],
        expected_evidence_segment_id=uid(102),
        provider_metadata=_metadata(),
    )
    assert result["status"] == "SUCCESS"
    assert result["schema_validation"] == "PASS"
    assert result["semantic_validation"] == "PASS"
    assert result["smoke_semantic_validation"] == "PASS"
    assert result["candidate_count"] == 1
    assert result["telemetry"]["provider_request_count"] == 1
    assert result["telemetry"]["provider_response_statuses"] == [200]


def test_empty_grounded_action_result_is_valid_and_not_a_provider_failure():
    adapter = ScriptedActionAdapter()
    result = run_action_smoke_case(
        _action_context(("Nhóm thống nhất sử dụng PostgreSQL.",)),
        settings(),
        adapter,
        expected_count=0,
    )
    assert result["status"] == "SUCCESS"
    assert result["empty_result"] is True
    assert result["semantic_validation"] == "PASS"
    assert result["smoke_semantic_validation"] == "PASS"
    assert result["candidate_count"] == 0
    assert len(adapter.requests) == 1


def test_multiple_grounded_action_results_are_valid_without_exact_one_assertion():
    adapter = ScriptedActionAdapter([
        {
            "ordinal": 0,
            "action": "gửi báo cáo API",
            "deliverable": "báo cáo API",
            "party": "Minh",
            "type": "COMMITTED",
        },
        {
            "ordinal": 1,
            "action": "kiểm thử API thanh toán",
            "deliverable": "API thanh toán",
            "party": "Lan",
            "type": "COMMITTED",
        },
    ])
    result = run_action_smoke_case(
        _action_context(("Minh sẽ gửi báo cáo API.", "Lan sẽ kiểm thử API thanh toán.")),
        settings(),
        adapter,
        expected_count=2,
    )
    assert result["status"] == "SUCCESS"
    assert result["candidate_count"] == 2
    assert result["smoke_semantic_validation"] == "PASS"
    assert [request.task.schema.name for request in adapter.requests] == [
        "action_window_signals", "action_resolution_groups",
    ]


def test_three_extraction_signals_use_the_mandatory_grouping_pass():
    expected = SMOKE_FIXTURE["expected"]
    adapter = ScriptedActionAdapter(_all_fixture_specs())
    result = run_action_smoke_case(
        _action_context(SMOKE_FIXTURE["segments"]),
        settings(),
        adapter,
        expected_count=expected["count"],
        expected_action_phrase=expected["actionPhrase"],
        expected_due_date=expected["dueDate"],
        expected_party=expected["party"],
        expected_evidence_segment_id=uid(102),
        provider_metadata=_metadata(2),
        max_provider_calls=2,
        aggregate_token_budget=100_000,
    )
    assert result["status"] == "SUCCESS"
    assert result["candidate_count"] == 1
    assert result["smoke_semantic_validation"] == "PASS"
    assert len(adapter.requests) == 2
    assert [request.task.schema.name for request in adapter.requests] == [
        "action_window_signals", "action_resolution_groups",
    ]
    telemetry = result["telemetry"]
    assert telemetry["call_count"] == 2
    assert telemetry["aggregate_accepted_calls"] == 2
    assert telemetry["aggregate_blocked_calls"] == 0
    assert telemetry["aggregate_reserved_tokens"] <= 100_000
    assert telemetry["reported_cost_call_count"] == 2
    assert telemetry["cost"] == {"numerator": 1, "denominator": 50000}


def test_related_but_distinct_deliverables_are_rejected_when_provider_merges_them():
    adapter = ScriptedActionAdapter(
        _all_fixture_specs(),
        group_mode="merge_current_assigned",
    )
    result = run_action_smoke_case(
        _action_context(SMOKE_FIXTURE["segments"]),
        settings(),
        adapter,
        expected_count=1,
        provider_metadata=_metadata(2),
        max_provider_calls=2,
        aggregate_token_budget=100_000,
    )
    assert result["status"] == "SUCCESS"
    assert result["failure_category"] is None
    assert result["schema_validation"] == "PASS"
    assert result["semantic_validation"] == "PASS"
    assert result["candidate_count"] == 1
    assert [request.task.schema.name for request in adapter.requests] == [
        "action_window_signals", "action_resolution_groups",
    ]
    assert result["telemetry"]["provider_request_count"] == 2


def test_retained_extraction_can_replay_into_unchanged_grouping_path():
    expected = SMOKE_FIXTURE["expected"]
    configured = settings()
    context = _action_context(SMOKE_FIXTURE["segments"])
    replayed = _captured_extraction_result(context, configured, _all_fixture_specs())
    grouping_adapter = ScriptedActionAdapter()
    adapter = ReplayThenScriptedAdapter(replayed, grouping_adapter)
    result = run_action_smoke_case(
        context,
        configured,
        adapter,
        expected_count=expected["count"],
        expected_action_phrase=expected["actionPhrase"],
        expected_due_date=expected["dueDate"],
        expected_party=expected["party"],
        expected_evidence_segment_id=uid(102),
        provider_metadata=_metadata(2),
        max_provider_calls=2,
        aggregate_token_budget=100_000,
    )
    assert result["status"] == "SUCCESS"
    assert result["smoke_semantic_validation"] == "PASS"
    assert [request.task.schema.name for request in adapter.requests] == [
        "action_window_signals", "action_resolution_groups",
    ]
    assert len(grouping_adapter.requests) == 1
    assert replayed.source == adapter.requests[0].window.source
    assert replayed.window_id == adapter.requests[0].window.window_id
    assert replayed.configuration_sha256 == adapter.requests[0].window.configuration_sha256
    assert replayed.task_sha256 == adapter.requests[0].task.sha256


def test_missing_expected_quang_action_is_a_fixture_semantic_failure():
    expected = SMOKE_FIXTURE["expected"]
    adapter = ScriptedActionAdapter(_all_fixture_specs()[:2])
    result = run_action_smoke_case(
        _action_context(SMOKE_FIXTURE["segments"]),
        settings(),
        adapter,
        expected_count=expected["count"],
        expected_action_phrase=expected["actionPhrase"],
        expected_due_date=expected["dueDate"],
        expected_party=expected["party"],
        expected_evidence_segment_id=uid(102),
        provider_metadata=_metadata(2),
        max_provider_calls=2,
        aggregate_token_budget=100_000,
    )
    assert result["status"] == "SUCCESS"
    assert result["candidate_count"] == 0
    assert result["smoke_semantic_validation"] == "FAIL"
    assert "EXPECTED_ACTION_NOT_FOUND" in result["smoke_semantic_failure_reasons"]
    assert len(adapter.requests) == 2


def test_duplicate_signals_are_grouped_into_one_grounded_candidate():
    adapter = ScriptedActionAdapter([
        {
            "ordinal": 0,
            "action": "gửi báo cáo API",
            "deliverable": "báo cáo API",
            "party": "Minh",
            "type": "COMMITTED",
        },
        {
            "ordinal": 1,
            "action": "gửi báo cáo API",
            "deliverable": "báo cáo API",
            "party": "Minh",
            "type": "COMMITTED",
        },
    ], group_mode="merge_all")
    result = run_action_smoke_case(
        _action_context(("Minh sẽ gửi báo cáo API.", "Minh sẽ gửi báo cáo API.")),
        settings(),
        adapter,
        expected_count=1,
        expected_action_phrase="gửi báo cáo API",
        expected_due_date=None,
        expected_party="Minh",
        expected_evidence_segment_id=uid(100),
        provider_metadata=_metadata(2),
        max_provider_calls=2,
        aggregate_token_budget=100_000,
    )
    candidate = result["prediction"]["result"]["candidates"][0]
    assert result["status"] == "SUCCESS"
    assert result["smoke_semantic_validation"] == "PASS"
    assert candidate["evidenceSegmentIds"] == [uid(100), uid(101)]
    assert len(adapter.requests) == 2


def test_missing_assignee_is_preserved_as_missing_not_invented():
    adapter = ScriptedActionAdapter([{
        "ordinal": 0,
        "action": "hoàn thành bản kiểm tra thanh toán",
        "deliverable": "bản kiểm tra thanh toán",
        "type": "COMMITTED",
    }])
    result = run_action_smoke_case(
        _action_context(("Tôi sẽ hoàn thành bản kiểm tra thanh toán.",)),
        settings(),
        adapter,
        expected_count=1,
        expected_action_phrase="hoàn thành bản kiểm tra thanh toán",
        expected_due_date=None,
        expected_party=None,
    )
    candidate = result["prediction"]["result"]["candidates"][0]
    assert result["smoke_semantic_validation"] == "PASS"
    assert candidate["details"] is None


def test_ambiguous_deadline_is_retained_as_text_but_not_converted_to_date():
    adapter = ScriptedActionAdapter([{
        "ordinal": 0,
        "action": "gửi báo cáo",
        "deliverable": "báo cáo",
        "party": "Quang",
        "type": "COMMITTED",
        "deadline": "khi khách hàng phản hồi",
    }])
    result = run_action_smoke_case(
        _action_context(("Quang sẽ gửi báo cáo khi khách hàng phản hồi.",)),
        settings(),
        adapter,
        expected_count=1,
        expected_action_phrase="gửi báo cáo",
        expected_due_date=None,
        expected_party="Quang",
    )
    candidate = result["prediction"]["result"]["candidates"][0]
    assert result["smoke_semantic_validation"] == "PASS"
    assert candidate["suggestedDueDate"] is None
    assert "khi khách hàng phản hồi" in candidate["details"]


def test_incorrect_source_evidence_fails_semantics_and_keeps_provider_metadata():
    adapter = ScriptedActionAdapter([{
        "ordinal": 0,
        "action": "gửi báo cáo",
        "deliverable": "báo cáo",
        "type": "COMMITTED",
    }], invalid_reference=True)
    result = run_action_smoke_case(
        _action_context(("Tôi sẽ gửi báo cáo.",)),
        settings(),
        adapter,
        expected_count=1,
        provider_metadata=_metadata(),
    )
    assert result["status"] == "FAILED"
    assert result["failure_category"] == "INVALID_REFERENCE"
    assert result["schema_validation"] == "PASS"
    assert result["semantic_validation"] == "FAIL"
    assert result["telemetry"]["provider_request_count"] == 1
    assert result["telemetry"]["provider_response_statuses"] == [200]
    assert result["provenance"]["model"] == "openai/gpt-6-luna"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("party", "Huy"),
        ("deadline", "trước ngày 2027-01-01"),
    ],
)
def test_hallucinated_assignee_or_deadline_fails_grounding(field, value):
    spec = {
        "ordinal": 2,
        "action": "hoàn thiện tích hợp mô-đun thanh toán và gửi bản chạy thử cho nhóm",
        "deliverable": "bản chạy thử",
        "party": "Quang",
        "type": "ASSIGNED",
        "deadline": "trước ngày 2026-12-15",
    }
    spec[field] = value
    adapter = ScriptedActionAdapter([spec])
    result = run_action_smoke_case(
        _action_context(SMOKE_FIXTURE["segments"]),
        settings(),
        adapter,
        expected_count=1,
        provider_metadata=_metadata(),
        max_provider_calls=2,
        aggregate_token_budget=100_000,
    )
    assert result["status"] == "FAILED"
    assert result["failure_category"] == "GROUNDING_FAILURE"
    assert result["schema_validation"] == "PASS"
    assert result["semantic_validation"] == "FAIL"
    assert result["candidate_count"] is None
    assert len(adapter.requests) == 1
    assert len(adapter.outputs) == 1


def test_provider_failure_during_grouping_keeps_first_call_observability():
    adapter = ScriptedActionAdapter(
        _all_fixture_specs(),
        group_failure_category="PROVIDER",
    )
    result = run_action_smoke_case(
        _action_context(SMOKE_FIXTURE["segments"]),
        settings(),
        adapter,
        expected_count=1,
        provider_metadata=_metadata(2, [200, 503]),
        max_provider_calls=2,
        aggregate_token_budget=100_000,
    )
    assert result["status"] == "FAILED"
    assert result["failure_category"] == "PROVIDER"
    assert result["schema_validation"] == "PASS"
    assert result["semantic_validation"] == "FAIL"
    assert result["telemetry"]["call_count"] == 2
    assert result["telemetry"]["provider_request_count"] == 2
    assert result["telemetry"]["provider_response_statuses"] == [200, 503]
    assert result["telemetry"]["calls"][0]["reported_cost"] is not None
    assert result["telemetry"]["calls"][1]["failure_category"] == "PROVIDER"
    assert len(adapter.requests) == 2
    assert len(adapter.outputs) == 1


def test_aggregate_budget_exhaustion_blocks_grouping_before_delegate():
    adapter = ScriptedActionAdapter(_all_fixture_specs())
    result = run_action_smoke_case(
        _action_context(SMOKE_FIXTURE["segments"]),
        settings(),
        adapter,
        expected_count=1,
        provider_metadata=_metadata(),
        max_provider_calls=1,
        aggregate_token_budget=100_000,
    )
    assert result["status"] == "FAILED"
    assert result["failure_category"] == "CONTEXT_BUDGET"
    assert result["schema_validation"] == "PASS"
    assert result["semantic_validation"] == "FAIL"
    assert result["telemetry"]["aggregate_attempted_calls"] == 2
    assert result["telemetry"]["aggregate_accepted_calls"] == 1
    assert result["telemetry"]["aggregate_blocked_calls"] == 1
    assert result["telemetry"]["provider_request_count"] == 1
    assert len(adapter.requests) == 1
    assert len(adapter.outputs) == 1


def test_grouping_semantic_failure_retains_safe_outputs_without_retry():
    adapter = ScriptedActionAdapter(
        _all_fixture_specs(),
        group_mode="hallucinated_id",
    )
    result = run_action_smoke_case(
        _action_context(SMOKE_FIXTURE["segments"]),
        settings(),
        adapter,
        expected_count=1,
        provider_metadata=_metadata(2),
        max_provider_calls=2,
        aggregate_token_budget=100_000,
    )
    assert result["status"] == "SUCCESS"
    assert result["failure_category"] is None
    assert result["schema_validation"] == "PASS"
    assert result["semantic_validation"] == "PASS"
    assert result["candidate_count"] == 1
    assert result["telemetry"]["call_count"] == 2
    assert result["telemetry"]["reported_cost_call_count"] == 2
    assert len(adapter.requests) == 2
    assert len(adapter.outputs) == 2
    assert len(adapter.outputs[0]["signals"]) == 3
    assert result["telemetry"]["calls"][0]["input_tokens"] == 11
    assert result["telemetry"]["calls"][1]["input_tokens"] == 11


def test_accepted_provider_output_can_fail_fixture_semantics_without_retry():
    adapter = ScriptedActionAdapter([{
        "ordinal": 0,
        "action": "sử dụng PostgreSQL",
        "deliverable": "PostgreSQL",
        "type": "SUGGESTED",
    }])
    result = run_action_smoke_case(
        _action_context(("Nhóm thống nhất sử dụng PostgreSQL.",)),
        settings(),
        adapter,
        expected_count=1,
        provider_metadata=_metadata(),
    )
    assert result["status"] == "SUCCESS"
    assert result["semantic_validation"] == "PASS"
    assert result["smoke_semantic_validation"] == "FAIL"
    assert result["smoke_semantic_failure_reasons"] == ["ACTION_COUNT_MISMATCH"]
    assert result["telemetry"]["call_count"] == 1
    assert result["telemetry"]["provider_request_count"] == 1


def test_semantic_failure_retains_safe_usage_cost_and_timing_metadata():
    adapter = ScriptedActionAdapter([{
        "ordinal": 0,
        "action": "sử dụng PostgreSQL",
        "deliverable": "PostgreSQL",
        "type": "SUGGESTED",
    }], usage=ModelUsage(
        input_tokens=31,
        output_tokens=17,
        total_tokens=48,
        reasoning_tokens=9,
        reported_cost=Fraction(3, 100000),
    ))
    result = run_action_smoke_case(
        _action_context(("Nhóm thống nhất sử dụng PostgreSQL.",)),
        settings(),
        adapter,
        expected_count=1,
        provider_metadata=_metadata(),
    )
    call = result["telemetry"]["calls"][0]
    assert result["smoke_semantic_validation"] == "FAIL"
    assert call["input_tokens"] == 31
    assert call["output_tokens"] == 17
    assert call["reasoning_tokens"] == 9
    assert call["reported_cost"] == {"numerator": 3, "denominator": 100000}
    assert call["duration_ns"] > 0


def test_unavailable_provider_metadata_is_not_fabricated():
    adapter = ScriptedActionAdapter(reported=False, usage=ModelUsage())
    result = run_action_smoke_case(
        _action_context(("Không có nhiệm vụ trong cuộc họp.",)),
        settings(),
        adapter,
        expected_count=0,
    )
    call = result["telemetry"]["calls"][0]
    assert result["status"] == "SUCCESS"
    assert call["reported_model"] is None
    assert call["reported_provider"] is None
    assert call["input_tokens"] is None
    assert result["telemetry"]["provider_request_count"] is None
    assert result["telemetry"]["provider_response_statuses"] is None


def test_single_attempt_provider_failure_never_retries():
    configured = settings(
        meeting_intelligence_inference_enabled=True,
        OPENROUTER_API_KEY="synthetic-provider-key",
        meeting_intelligence_max_attempts=1,
    )
    request = prepare_context(stage(), task(), configured).request(0)
    calls = []

    def provider(_request):
        calls.append(True)
        return httpx.Response(503)

    with OpenRouterIntelligenceAdapter(
        configured,
        transport=httpx.MockTransport(provider),
    ) as adapter:
        with pytest.raises(IntelligenceError, match="PROVIDER"):
            adapter.complete(request)
    assert len(calls) == 1
