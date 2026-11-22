from dataclasses import replace
from types import SimpleNamespace

import pytest
from intelligence_support import settings, snapshot, stage

from sme_meeting_ai.integrations.intelligence import ExecutionBudget
from sme_meeting_ai.meeting_intelligence.composition import (
    CallCapacity,
    InferenceBudget,
)
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
from sme_meeting_ai.workers.intelligence import (
    DurableProviderAttemptLedger,
    plan_downstream,
)

STAGES = ("GENERATING_SUMMARY", "EXTRACTING_DECISIONS", "EXTRACTING_ACTION_ITEMS")


def budget(**overrides):
    return ExecutionBudget(**(dict(
        remainingStages=STAGES, remainingStageAttempts=dict.fromkeys(STAGES, 16),
        aggregateAttemptCeiling=44, aggregateReservedAttempts=0, aggregateReservedTokens=0,
        reservedTokenCeiling=2_000_000, aggregateEstimatedCostUsd="0",
        aggregateReportedCostUsd="0", estimatedCostCeilingUsd="0.75",
        inputCostPerMillionUsd="0.2", outputCostPerMillionUsd="1",
    ) | overrides))


@pytest.mark.parametrize("minutes", [5, 30, 45])
def test_reviewed_transcript_plan_keeps_all_stages_within_default_execution_ceiling(minutes):
    texts = [f"Lượt {i}: Nhóm cần kiểm tra kết quả tích hợp API và đối chiếu tiến độ dự án."
             for i in range(minutes * 12)]
    data = snapshot(texts)
    data["transcript"]["durationMs"] = minutes * 60_000
    data["coverage"][0]["endMs"] = minutes * 60_000
    for i, segment in enumerate(data["transcript"]["segments"]):
        segment.update(startMs=i * 5000, endMs=(i + 1) * 5000)
    context = stage(data)
    ledger = DurableProviderAttemptLedger(None, None, None, SimpleNamespace(budget=budget()))
    conf = settings()
    plan_downstream(context, conf, ledger)
    from sme_meeting_ai.meeting_intelligence.summary import prepare_summary
    prepared = prepare_summary(replace(context, provider_attempts=ledger), conf)
    assert 2 <= prepared.budget.pending_work.calls < 16
    assert sum(w.calls for w in ledger.downstream.values()) >= 3


def test_optional_physical_retry_cannot_use_remaining_required_call_slots():
    ledger = DurableProviderAttemptLedger(None, None, None, SimpleNamespace(budget=budget(
        aggregateAttemptCeiling=3, remainingStageAttempts=dict.fromkeys(STAGES, 3))))
    ledger.downstream = {STAGES[1]: CallCapacity(1, 10, 5),
                         STAGES[2]: CallCapacity(1, 10, 5)}
    local = InferenceBudget(100, check_execution=ledger.check_capacity)
    request = SimpleNamespace(window=SimpleNamespace(estimated_input_tokens=10), output_budget=5)
    work = CallCapacity.for_request(request)
    local.plan((work,))
    local.begin(request)
    local.reserve(request)
    ledger.usage = ledger.usage.model_copy(update={"aggregateReservedAttempts": 1})
    with pytest.raises(IntelligenceError, match="CONTEXT_BUDGET"):
        local.reserve(request)
    assert local.reserved_tokens == 15


@pytest.mark.parametrize("overrides", [
    {"reservedTokenCeiling": 44},
    {"aggregateReportedCostUsd": "0.74999"},
    {"remainingStageAttempts": dict(zip(STAGES, (3, 0, 3), strict=True))},
])
def test_pipeline_preflight_checks_future_stage_ceilings_tokens_and_cost(overrides):
    ledger = DurableProviderAttemptLedger(None, None, None, SimpleNamespace(budget=budget(**overrides)))
    ledger.downstream = {key: CallCapacity(1, 10, 5) for key in STAGES[1:]}
    with pytest.raises(IntelligenceError, match="CONTEXT_BUDGET"):
        ledger.check_capacity(CallCapacity(1, 10, 5))
