import asyncio
import json
from fractions import Fraction
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from pydantic import SecretStr

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.integrations.core_api import CoreError
from sme_meeting_ai.integrations.intelligence import (
    ExecutionBudget,
    IntelligenceCoreClient,
    IntelligenceEvent,
)
from sme_meeting_ai.workers.intelligence import (
    DurableProviderAttemptLedger,
    IntelligenceExecution,
    _worker_category,
    validate_provider_credentials,
)


def event():
    return IntelligenceEvent.model_validate(dict(eventId=str(uuid4()), schemaVersion=1,
        processingJobId=str(uuid4()), executionStageRunId=str(uuid4()),
        executionStageCode="GENERATING_SUMMARY", occurredAt="2026-11-09T12:00:00Z", requestId=None))


def config():
    return Settings(service_name="test", service_identity="ai-worker", _env_file=None,
        core_api_base_url="https://core.invalid", core_api_max_attempts=2)


def response(data):
    return httpx.Response(200, headers={"Cache-Control": "no-store"},
        json=dict(success=True, code="OK", message="ok", data=data, meta={}))


def test_control_binds_identity_and_keeps_bearer_out_of_control():
    async def run():
        item = event()
        seen = []
        def handler(request):
            seen.append(request)
            return response(dict(contractVersion="1.0", processingJobId=item.processingJobId,
                eventId=item.eventId, executionStageRunId=item.executionStageRunId,
                executionStageCode=item.executionStageCode, state="AVAILABLE", acknowledge=False))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = IntelligenceCoreClient(config(), client=http, acceptance_token="A" * 43)
            result = await client.lookup(item)
            assert result.state == "AVAILABLE"
            assert seen[0].headers["x-request-id"] == item.eventId
            assert "authorization" not in seen[0].headers
            assert seen[0].url.path.endswith(f"/intelligence/deliveries/{item.eventId}")
    asyncio.run(run())


def test_mismatched_control_response_is_rejected():
    async def run():
        item = event()
        def handler(request):
            return response(dict(contractVersion="1.0", processingJobId=str(uuid4()),
                eventId=item.eventId, executionStageRunId=item.executionStageRunId,
                executionStageCode=item.executionStageCode, state="AVAILABLE", acknowledge=False))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = IntelligenceCoreClient(config(), client=http, acceptance_token="A" * 43)
            with pytest.raises(CoreError):
                await client.lookup(item)
    asyncio.run(run())


def test_provider_attempt_control_contract_reserves_and_reports_without_acceptance_bearer():
    async def run():
        item = event()
        claim = SimpleNamespace(
            eventId=item.eventId,
            executionStageRunId=item.executionStageRunId,
            executionStageCode=item.executionStageCode,
            claimToken=SecretStr(str(uuid4())),
            budget=ExecutionBudget(
                remainingStages=("GENERATING_SUMMARY",),
                remainingStageAttempts={"GENERATING_SUMMARY": 16},
                aggregateAttemptCeiling=44,
                aggregateReservedAttempts=0,
                reservedTokenCeiling=161970,
                aggregateReservedTokens=0,
                estimatedCostCeilingUsd="0.15",
                aggregateEstimatedCostUsd="0",
                aggregateReportedCostUsd="0",
                inputCostPerMillionUsd="0.2",
                outputCostPerMillionUsd="1",
            ),
        )
        request = SimpleNamespace(
            window=SimpleNamespace(estimated_input_tokens=7431),
            output_budget=32768,
        )
        attempt_id = str(uuid4())
        observed = []

        def handler(request_):
            observed.append(request_)
            body = json.loads(request_.content)
            assert "authorization" not in request_.headers
            assert request_.headers["x-request-id"] == item.eventId
            if request_.url.path.endswith("/attempts/reserve"):
                assert body == {
                    "contractVersion": "1.0",
                    "eventId": item.eventId,
                    "executionStageRunId": item.executionStageRunId,
                    "claimToken": claim.claimToken.get_secret_value(),
                    "attemptId": attempt_id,
                    "executionStageCode": "GENERATING_SUMMARY",
                    "estimatedInputTokens": 7431,
                    "outputTokenCeiling": 32768,
                    "reservedTokens": 40199,
                    "estimatedCostUsd": "0.0342542",
                }
                return response(dict(
                    contractVersion="1.0", processingJobId=item.processingJobId,
                    eventId=item.eventId, executionStageRunId=item.executionStageRunId,
                    executionStageCode=item.executionStageCode, attemptId=attempt_id,
                    outcome="RESERVED", estimatedInputTokens=7431,
                    outputTokenCeiling=32768, reservedTokens=40199,
                    estimatedCostUsd="0.0342542", reportedCostUsd=None, replay=False,
                    budgetExceeded=False, aggregateReservedAttempts=1,
                    aggregateReservedTokens=40199, aggregateEstimatedCostUsd="0.0342542",
                    aggregateReportedCostUsd="0", reservedTokenCeiling=161970,
                    estimatedCostCeilingUsd="0.15",
                    providerAccountLimitEnforced=False,
                ))
            assert request_.url.path.endswith("/attempts/report")
            assert body == {
                "contractVersion": "1.0",
                "eventId": item.eventId,
                "executionStageRunId": item.executionStageRunId,
                "claimToken": claim.claimToken.get_secret_value(),
                "attemptId": attempt_id,
                "executionStageCode": "GENERATING_SUMMARY",
                "outcome": "SUCCEEDED",
                "inputTokens": 7400,
                "outputTokens": 1200,
                "totalTokens": 8600,
                "reasoningTokens": 300,
                "reportedCostUsd": "0.001",
                "failureCategory": None,
            }
            return response(dict(
                contractVersion="1.0", processingJobId=item.processingJobId,
                eventId=item.eventId, executionStageRunId=item.executionStageRunId,
                executionStageCode=item.executionStageCode, attemptId=attempt_id,
                outcome="SUCCEEDED", estimatedInputTokens=7431,
                outputTokenCeiling=32768, reservedTokens=40199,
                estimatedCostUsd="0.0342542", reportedCostUsd="0.001", replay=False,
                budgetExceeded=False, aggregateReservedAttempts=1,
                aggregateReservedTokens=40199, aggregateEstimatedCostUsd="0.0342542",
                aggregateReportedCostUsd="0.001", reservedTokenCeiling=161970,
                estimatedCostCeilingUsd="0.15",
                providerAccountLimitEnforced=False,
            ))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = IntelligenceCoreClient(config(), client=http, acceptance_token="A" * 43)
            reserved = await client.reserve_provider_attempt(item, claim, request, attempt_id)
            reported = await client.report_provider_attempt(
                item, claim, attempt_id, outcome="SUCCEEDED", input_tokens=7400,
                output_tokens=1200, total_tokens=8600, reasoning_tokens=300,
                reported_cost=Fraction(1, 1000),
            )
            assert reserved.attemptId == attempt_id and reserved.outcome == "RESERVED"
            assert reported.reportedCostUsd == "0.001" and reported.outcome == "SUCCEEDED"
            assert len(observed) == 2

    asyncio.run(run())


@pytest.mark.parametrize("code", [
    "WORKER_BUDGET_EXHAUSTED",
    "WORKER_BUDGET_CONFIGURATION_CONFLICT",
    "WORKER_BUDGET_NOT_FOUND",
    "WORKER_ATTEMPT_NOT_FOUND",
    "WORKER_USAGE_INVALID",
])
def test_intelligence_budget_errors_remain_distinguishable(code):
    assert CoreError(409, code).code == code


@pytest.mark.parametrize("code,category", [
    ("WORKER_CONTRACT_UNSUPPORTED", "CONFIGURATION"),
    ("WORKER_RESPONSE_INVALID", "CONFIGURATION"),
    ("WORKER_BUDGET_EXHAUSTED", "CONTEXT_BUDGET"),
    ("WORKER_BUDGET_NOT_FOUND", "CONTEXT_BUDGET"),
    ("WORKER_BUDGET_CONFIGURATION_CONFLICT", "CONFIGURATION"),
    ("WORKER_ATTEMPT_NOT_FOUND", "CONFIGURATION"),
    ("WORKER_USAGE_INVALID", "CONFIGURATION"),
])
def test_core_budget_and_accounting_errors_fail_closed(code, category):
    internal = DurableProviderAttemptLedger._category(CoreError(409, code))
    assert internal == category
    assert _worker_category(internal) == "CONFIGURATION"


def test_acceptance_scopes_bearer_and_sends_only_claim_and_digest():
    async def run():
        item = event()
        token = str(uuid4())
        observed = []
        def handler(request):
            observed.append(request)
            return response(dict(replay=False, writtenRows=1))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = IntelligenceCoreClient(config(), client=http, acceptance_token="A" * 43)
            result = await client.accept(item, token, "a" * 64)
            assert result.replay is False
            assert observed[0].headers["authorization"] == "Bearer " + "A" * 43
            assert observed[0].url.path == "/internal/api/v1/meeting-intelligence/results/accept"
            assert json.loads(observed[0].content) == dict(stageRunId=item.executionStageRunId,
                claimToken=token, artifactSha256="a" * 64)
    asyncio.run(run())


def test_intelligence_worker_disabled_by_default():
    assert config().meeting_intelligence_worker_enabled is False


def test_enabled_capability_requires_credentials_before_consumption():
    async def run():
        execution = IntelligenceExecution(config().model_copy(update={"meeting_intelligence_worker_enabled": True}))
        with pytest.raises(ValueError):
            await execution.__aenter__()
        assert execution.broker is None
    asyncio.run(run())


def test_enabled_inference_requires_provider_credentials_before_startup():
    settings = config().model_copy(update=dict(
        meeting_intelligence_worker_enabled=True,
        meeting_intelligence_inference_enabled=True,
    ))
    with pytest.raises(ValueError):
        validate_provider_credentials(settings)

    settings = settings.model_copy(update=dict(openrouter_api_key=SecretStr("synthetic-provider-key")))
    validate_provider_credentials(settings)
