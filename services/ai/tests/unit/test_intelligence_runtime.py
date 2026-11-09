import asyncio
import json
from uuid import uuid4

import httpx
import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.integrations.core_api import CoreError
from sme_meeting_ai.integrations.intelligence import IntelligenceCoreClient, IntelligenceEvent
from sme_meeting_ai.workers.intelligence import IntelligenceExecution


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
