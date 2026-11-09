from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from sme_meeting_ai.api import create_app
from sme_meeting_ai.api.security import VerifiedServiceIdentity
from sme_meeting_ai.assistant import (
    AssistantAnswerStatus,
    AssistantFailureCategory,
    AssistantOrchestrator,
    AssistantProviderError,
    AssistantRequest,
    AssistantSettings,
    ContextualizedQuestion,
    GeneratedAnswer,
    GenerationResult,
    ModelProvenance,
    build_grounding_context,
)
from sme_meeting_ai.core.config import Environment, Settings
from sme_meeting_ai.providers.openrouter_assistant import OpenRouterAssistantAdapter
from sme_meeting_ai.rag import (
    AuthorizedRetrievalScope,
    CanonicalSourceIdentity,
    CanonicalSourceReference,
    ChunkProvenance,
    RetrievalEvidence,
    RetrievalFilters,
    RetrievalResult,
    RetrievalStatus,
    SourceRevision,
    SourceVerification,
    StaticAuthorizationProvider,
    StaticSourceVerificationProvider,
)

NOW = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)
RERANKER_REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"


def _scope(*meeting_ids: str) -> AuthorizedRetrievalScope:
    return AuthorizedRetrievalScope(
        contractVersion="1.0",
        scopeId=str(uuid4()),
        principalId=str(uuid4()),
        scopeVersion="scope-v1",
        issuedAt="2026-11-09T11:00:00Z",
        expiresAt="2026-11-09T13:00:00Z",
        allowedMeetingIds=meeting_ids,
    )


def _evidence(text: str, *, source_type: str = "TRANSCRIPT") -> RetrievalEvidence:
    meeting_id, source_id, chunk_id, segment_id = (str(uuid4()) for _ in range(4))
    identity = CanonicalSourceIdentity(
        sourceType=source_type,
        sourceId=source_id,
        meetingId=meeting_id,
    )
    revision = SourceRevision(number=2, contentSha256="a" * 64)
    reference = CanonicalSourceReference(
        sourceIdentity=identity,
        sourceRevision=revision,
        segmentId=segment_id if source_type == "TRANSCRIPT" else None,
        timelineStartMs=1_000 if source_type == "TRANSCRIPT" else None,
        timelineEndMs=2_000 if source_type == "TRANSCRIPT" else None,
    )
    provenance = ChunkProvenance(
        snapshotId=str(uuid4()),
        meetingId=meeting_id,
        sourceType=source_type,
        sourceIdentity=identity,
        sourceRevision=revision,
        indexGenerationId="rag-t03-test-v1",
        authorityClass={
            "TRANSCRIPT": "PRIMARY_TRANSCRIPT",
            "DECISION": "CONFIRMED_DECISION",
            "SUMMARY": "SECONDARY_APPROVED_SUMMARY",
            "ACTION_ITEM": "OFFICIAL_ACTION_ITEM",
        }[source_type],
        qualityClass="ACCEPTED",
        sourceStatus="READY",
        sourceCurrent=True,
        sourceReferences=(reference,),
        timelineStartMs=reference.timeline_start_ms,
        timelineEndMs=reference.timeline_end_ms,
    )
    verification = SourceVerification(
        sourceIdentity=identity,
        sourceRevision=revision,
        currentRevision=revision,
        status="CURRENT",
        eligible=True,
        available=True,
        visible=True,
        verifiedAt="2026-11-09T12:00:00Z",
    )
    return RetrievalEvidence(
        rank=1,
        pointId=chunk_id,
        chunkId=chunk_id,
        displayText=text,
        retrievalText=text,
        provenance=provenance,
        sourceVerification=verification,
        rrfScore=0.8,
        rerankerScore=0.9,
        rerankerInputTruncated=False,
    )


def _retrieval_result(scope: AuthorizedRetrievalScope, evidence=()) -> RetrievalResult:
    return RetrievalResult(
        status=RetrievalStatus.EVIDENCE_AVAILABLE if evidence else RetrievalStatus.INSUFFICIENT_EVIDENCE,
        queryOriginal="Câu hỏi",
        queryNormalized="Câu hỏi",
        scopeId=scope.scope_id,
        scopeVersion=scope.scope_version,
        authorizationVerified=True,
        sourceVerificationStatus="AUTHORITATIVELY_VERIFIED",
        activeIndexGenerationId="rag-t03-test-v1",
        embeddingModelId="BAAI/bge-m3",
        embeddingModelRevision="b" * 40,
        rerankerModelId="BAAI/bge-reranker-v2-m3",
        rerankerModelRevision=RERANKER_REVISION,
        sufficiencyPolicy={
            "datasetId": "rag-t03-vietnamese-baseline",
            "modelId": "BAAI/bge-reranker-v2-m3",
            "modelRevision": RERANKER_REVISION,
            "scoreCutoff": 0.0,
            "caseCount": 1,
            "limitations": ("test policy",),
        },
        evidence=tuple(evidence),
        diagnostics={
            "densePrefetchLimit": 40,
            "sparsePrefetchLimit": 40,
            "fusedCandidateCount": len(evidence),
            "validatedCandidateCount": len(evidence),
            "sourceVerifiedCount": len(evidence),
            "sourceVerificationRejectedCount": 0,
            "rerankedCandidateCount": len(evidence),
            "finalEvidenceCount": len(evidence),
            "rejectedCandidateCount": 0,
        },
    )


def _request(scope: AuthorizedRetrievalScope, question="Kế hoạch phát hành là gì?", context=()):
    return AssistantRequest(
        contractVersion="1.0",
        requestId="request-1",
        question=question,
        authorizedScope=scope,
        userFilters=RetrievalFilters(),
        conversationContext=context,
    )


def _generation(handles=("E1",), status="GROUNDED"):
    return GenerationResult(
        answer=GeneratedAnswer(
            status=status,
            answerUnits=(
                {
                    "text": "Kế hoạch phát hành vào thứ Sáu.",
                    "support": "SUPPORTED",
                    "evidenceHandles": handles,
                },
            ),
            conflictDetected=False,
            uncertainties=(),
        ),
        provenance=ModelProvenance(
            provider="openrouter",
            configuredModel="openai/gpt-6-luna",
            reportedModel="openai/gpt-6-luna",
            reasoningEffort="high",
            inputTokens=100,
            outputTokens=20,
            totalTokens=120,
            attempts=1,
        ),
    )


class FakeRetrieval:
    def __init__(self, result, scope, evidence=()):
        self.result = result
        self.calls = []
        self.authorization_provider = StaticAuthorizationProvider([scope])
        self.source_provider = StaticSourceVerificationProvider(
            [item.source_verification for item in evidence]
        )

    def retrieve(self, request):
        self.calls.append(request)
        return self.result


class FakeGenerator:
    def __init__(self, generated):
        self.generated = generated
        self.calls = []
        self.contextualization_calls = []

    async def generate(self, context, *, deadline):
        self.calls.append((context, deadline))
        return self.generated

    async def contextualize(self, question, conversation, *, deadline):
        self.contextualization_calls.append((question, conversation, deadline))
        return ContextualizedQuestion(
            standaloneQuestion="Deadline của kế hoạch phát hành là khi nào?",
            provenance=self.generated.provenance,
        )


def _orchestrator(retrieval, generator, **kwargs):
    return AssistantOrchestrator(
        retrieval,
        generator,
        config=AssistantSettings(
            model="openai/gpt-6-luna",
            reasoning_effort="high",
            request_timeout_seconds=10,
            **kwargs,
        ),
        clock=lambda: NOW,
    )


def test_grounded_answer_maps_backend_handles_to_verified_citations():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    retrieval = FakeRetrieval(_retrieval_result(scope, (evidence,)), scope, (evidence,))
    generator = FakeGenerator(_generation())

    result = asyncio.run(_orchestrator(retrieval, generator).answer(_request(scope)))

    assert result.status is AssistantAnswerStatus.GROUNDED
    assert result.claims[0].citation_ids == ("C1",)
    assert result.citations[0].source_identity == evidence.provenance.source_identity
    assert result.citations[0].source_revision == evidence.provenance.source_revision
    assert result.citations[0].retrieval_chunk_id == evidence.chunk_id


def test_uncertainty_metadata_cannot_append_ungrounded_user_visible_facts():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    retrieval = FakeRetrieval(_retrieval_result(scope, (evidence,)), scope, (evidence,))
    generated = _generation().model_copy(
        update={
            "answer": _generation().answer.model_copy(
                update={
                    "uncertainties": (
                        "Ban lãnh đạo đã phê duyệt ngân sách mới vào ngày mai.",
                    )
                }
            )
        }
    )

    result = asyncio.run(_orchestrator(retrieval, FakeGenerator(generated)).answer(_request(scope)))

    assert result.status is AssistantAnswerStatus.GROUNDED
    assert result.answer == result.claims[0].text
    assert "Ban lãnh đạo đã phê duyệt ngân sách mới" not in result.answer


def test_insufficient_retrieval_never_invokes_generation():
    scope = _scope(str(uuid4()))
    retrieval = FakeRetrieval(_retrieval_result(scope), scope)
    generator = FakeGenerator(_generation())

    result = asyncio.run(_orchestrator(retrieval, generator).answer(_request(scope)))

    assert result.status is AssistantAnswerStatus.INSUFFICIENT_EVIDENCE
    assert generator.calls == []
    assert result.citations == ()


def test_generation_failure_returns_failed_response_without_answer_content():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    retrieval = FakeRetrieval(_retrieval_result(scope, (evidence,)), scope, (evidence,))

    class FailedGenerator(FakeGenerator):
        async def generate(self, context, *, deadline):
            del context, deadline
            raise AssistantProviderError("INFERENCE_FAILED")

    result = asyncio.run(_orchestrator(retrieval, FailedGenerator(_generation())).answer(_request(scope)))

    assert result.status is AssistantAnswerStatus.FAILED
    assert result.failures[0].category is AssistantFailureCategory.PROVIDER_UNAVAILABLE
    assert result.answer is None
    assert result.claims == ()
    assert result.citations == ()


def test_fabricated_evidence_handle_is_a_validation_failure():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    retrieval = FakeRetrieval(_retrieval_result(scope, (evidence,)), scope, (evidence,))
    generator = FakeGenerator(_generation(handles=("E9",)))

    result = asyncio.run(_orchestrator(retrieval, generator).answer(_request(scope)))

    assert result.status is AssistantAnswerStatus.FAILED
    assert result.failures[0].category is AssistantFailureCategory.CITATION_VALIDATION_FAILURE


def test_partial_answer_keeps_supported_claims_and_explicit_unknown_aspects():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    retrieval = FakeRetrieval(_retrieval_result(scope, (evidence,)), scope, (evidence,))
    generated = GenerationResult(
        answer={
            "status": "PARTIAL",
            "answerUnits": (
                {
                    "text": "Kế hoạch phát hành vào thứ Sáu.",
                    "support": "SUPPORTED",
                    "evidenceHandles": ("E1",),
                },
                {
                    "text": "Người phụ trách chưa được xác định trong bằng chứng.",
                    "support": "UNSUPPORTED",
                    "evidenceHandles": (),
                },
            ),
            "conflictDetected": False,
            "uncertainties": (),
        },
        provenance=_generation().provenance,
    )

    result = asyncio.run(_orchestrator(retrieval, FakeGenerator(generated)).answer(_request(scope)))

    assert result.status is AssistantAnswerStatus.PARTIAL
    assert [claim.support.value for claim in result.claims] == ["SUPPORTED", "UNSUPPORTED"]
    assert result.claims[1].citation_ids == ()


def test_conflicting_answer_preserves_representative_citations():
    first = _evidence("Đề xuất phát hành vào thứ Sáu.")
    second = _evidence("Quyết định xác nhận phát hành vào thứ Hai.", source_type="DECISION")
    scope = _scope(first.provenance.meeting_id, second.provenance.meeting_id)
    retrieval = FakeRetrieval(
        _retrieval_result(scope, (first, second)), scope, (first, second)
    )
    generated = GenerationResult(
        answer={
            "status": "GROUNDED",
            "answerUnits": (
                {
                    "text": "Các nguồn có thời hạn phát hành khác nhau.",
                    "support": "CONFLICTED",
                    "evidenceHandles": ("E1", "E2"),
                },
            ),
            "conflictDetected": True,
            "uncertainties": (),
        },
        provenance=_generation().provenance,
    )

    result = asyncio.run(_orchestrator(retrieval, FakeGenerator(generated)).answer(_request(scope)))

    assert result.status is AssistantAnswerStatus.GROUNDED
    assert result.claims[0].support.value == "CONFLICTED"
    assert result.claims[0].citation_ids == ("C1", "C2")


def test_follow_up_uses_only_scope_matching_dialogue_and_retrieves_rewritten_question():
    evidence = _evidence("Deadline là thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    retrieval = FakeRetrieval(_retrieval_result(scope, (evidence,)), scope, (evidence,))
    generator = FakeGenerator(_generation())
    context = (
        {
            "role": "USER",
            "content": "Kế hoạch phát hành là gì?",
            "scopeId": scope.scope_id,
            "scopeVersion": scope.scope_version,
        },
        {
            "role": "ASSISTANT",
            "content": "Kế hoạch phát hành vào thứ Sáu.",
            "scopeId": scope.scope_id,
            "scopeVersion": scope.scope_version,
        },
    )

    result = asyncio.run(
        _orchestrator(retrieval, generator).answer(
            _request(scope, question="Vậy deadline của việc đó là khi nào?", context=context)
        )
    )

    assert result.status is AssistantAnswerStatus.GROUNDED
    assert generator.contextualization_calls
    assert retrieval.calls[0].query == "Deadline của kế hoạch phát hành là khi nào?"


def test_scope_changed_dialogue_is_not_reused_for_follow_up():
    evidence = _evidence("Deadline là thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    other_scope = _scope(scope.allowed_meeting_ids[0])
    retrieval = FakeRetrieval(_retrieval_result(scope, (evidence,)), scope, (evidence,))
    generator = FakeGenerator(_generation())
    context = (
        {
            "role": "ASSISTANT",
            "content": "Kế hoạch cũ là thứ Sáu.",
            "scopeId": other_scope.scope_id,
            "scopeVersion": other_scope.scope_version,
        },
    )

    result = asyncio.run(
        _orchestrator(retrieval, generator).answer(
            _request(scope, question="Vậy deadline của việc đó là khi nào?", context=context)
        )
    )

    assert result.status is AssistantAnswerStatus.INSUFFICIENT_EVIDENCE
    assert result.failures[0].category is AssistantFailureCategory.INSUFFICIENT_CONTEXT
    assert retrieval.calls == []
    assert generator.calls == []


def test_final_source_invalidation_fails_closed_after_generation():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    retrieval = FakeRetrieval(_retrieval_result(scope, (evidence,)), scope, (evidence,))
    retrieval.source_provider = StaticSourceVerificationProvider(
        [
            evidence.source_verification.model_copy(
                update={
                    "status": "SUPERSEDED",
                    "currentRevision": None,
                    "eligible": False,
                    "available": False,
                    "visible": False,
                }
            )
        ]
    )

    result = asyncio.run(_orchestrator(retrieval, FakeGenerator(_generation())).answer(_request(scope)))

    assert result.status is AssistantAnswerStatus.FAILED
    assert result.failures[0].category is AssistantFailureCategory.SOURCE_INVALIDATED


def test_context_budget_drops_optional_dialogue_before_evidence():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    context = build_grounding_context(
        question="Kế hoạch phát hành là gì?",
        conversation=tuple(
            SimpleNamespace(
                role="USER",
                content="một đoạn hội thoại rất dài " * 50,
                scope_id=str(uuid4()),
                scope_version="scope-v1",
            )
            for _ in range(2)
        ),
        evidence=(evidence,),
        config=AssistantSettings(
            model="openai/gpt-6-luna",
            reasoning_effort="high",
            max_input_tokens=5_000,
            conversation_context_token_budget=50,
        ),
    )

    assert context.evidence
    assert context.conversation == ()
    assert context.estimated_input_tokens <= 5_000


class Boundary:
    async def identity_for(self, scope):
        return VerifiedServiceIdentity(
            principal="core-api",
            certificate_verified=True,
            request_scope=scope,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=1),
        )


def test_internal_endpoint_requires_feature_and_exact_operation_grant():
    settings = Settings(
        service_name="test-ai",
        service_identity="ai-core",
        assistant_enabled=True,
        assistant_inference_enabled=True,
        openrouter_api_key="test-only-provider-key",
        _env_file=None,
    )
    app = create_app(settings, identity_source=Boundary(), operation_policy={})

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post("/internal/v1/assistant/answers", json={})
            public = await client.post("/assistant/answers", json={})
            return response, public

    response, public = asyncio.run(run())
    assert response.status_code == 403
    assert public.status_code == 404


def test_internal_endpoint_runs_injected_grounded_service():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    retrieval = FakeRetrieval(_retrieval_result(scope, (evidence,)), scope, (evidence,))
    service = _orchestrator(retrieval, FakeGenerator(_generation()))
    settings = Settings(
        service_name="test-ai",
        service_identity="ai-core",
        assistant_enabled=True,
        assistant_inference_enabled=True,
        openrouter_api_key="test-only-provider-key",
        _env_file=None,
    )
    app = create_app(
        settings,
        identity_source=Boundary(),
        operation_policy={"assistant.answers": {"core-api"}},
        assistant_service=service,
    )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.post(
                "/internal/v1/assistant/answers",
                json=_request(scope).model_dump(mode="json", by_alias=True),
            )

    response = asyncio.run(run())
    assert response.status_code == 200
    assert response.json()["status"] == "GROUNDED"
    assert response.json()["citations"][0]["citationId"] == "C1"


def test_internal_endpoint_fails_closed_when_feature_is_disabled():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    app = create_app(
        settings,
        identity_source=Boundary(),
        operation_policy={"assistant.answers": {"core-api"}},
    )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.post(
                "/internal/v1/assistant/answers",
                json=_request(scope).model_dump(mode="json", by_alias=True),
            )

    response = asyncio.run(run())
    assert response.status_code == 503
    assert response.json()["failures"][0]["category"] == "FEATURE_UNAVAILABLE"


def test_production_endpoint_drops_unattested_injected_service():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    scope = _scope(evidence.provenance.meeting_id)
    retrieval = FakeRetrieval(_retrieval_result(scope, (evidence,)), scope, (evidence,))
    service = _orchestrator(retrieval, FakeGenerator(_generation()))
    settings = Settings(
        service_name="test-ai",
        service_identity="ai-core",
        environment=Environment.PRODUCTION,
        assistant_enabled=True,
        assistant_inference_enabled=True,
        openrouter_api_key="test-only-provider-key",
        _env_file=None,
    )
    app = create_app(
        settings,
        identity_source=Boundary(),
        operation_policy={"assistant.answers": {"core-api"}},
        assistant_service=service,
    )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.post(
                "/internal/v1/assistant/answers",
                json=_request(scope).model_dump(mode="json", by_alias=True),
            )

    response = asyncio.run(run())
    assert response.status_code == 503
    assert response.json()["failures"][0]["category"] == "FEATURE_UNAVAILABLE"


def test_internal_endpoint_bounds_chunked_request_bytes():
    settings = Settings(
        service_name="test-ai",
        service_identity="ai-core",
        assistant_max_request_bytes=32,
        _env_file=None,
    )
    app = create_app(settings)

    async def chunks():
        yield json.dumps({"x": "x" * 64}).encode()

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.post(
                "/internal/v1/assistant/answers",
                content=chunks(),
                headers={"content-type": "application/json"},
            )

    response = asyncio.run(run())
    assert response.status_code == 413, response.text
    assert response.json()["error"]["code"] == "payload_too_large"


def _provider_settings(**overrides):
    return Settings(
        service_name="test-ai",
        service_identity="ai-core",
        assistant_enabled=True,
        assistant_inference_enabled=True,
        openrouter_api_key="test-only-provider-key",
        _env_file=None,
        **overrides,
    )


def _provider_body(content, **overrides):
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "model": "openai/gpt-6-luna",
        "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
        **overrides,
    }


def test_openrouter_assistant_enforces_structured_output_and_tracks_usage():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    context = build_grounding_context(
        question="Kế hoạch phát hành là gì?",
        conversation=(),
        evidence=(evidence,),
    )
    body = json.dumps(
        {
            "status": "GROUNDED",
            "answerUnits": [
                {
                    "text": "Kế hoạch phát hành vào thứ Sáu.",
                    "support": "SUPPORTED",
                    "evidenceHandles": ["E1"],
                }
            ],
            "conflictDetected": False,
            "uncertainties": [],
        },
        ensure_ascii=False,
    )
    seen = []

    def handle(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json=_provider_body(body))

    async def run():
        adapter = OpenRouterAssistantAdapter(
            _provider_settings(), transport=httpx.MockTransport(handle)
        )
        try:
            return await adapter.generate(
                context,
                deadline=asyncio.get_running_loop().time() + 5,
            )
        finally:
            await adapter.aclose()

    result = asyncio.run(run())
    assert result.answer.answer_units[0].evidence_handles == ("E1",)
    assert result.provenance.total_tokens == 70
    assert seen[0]["provider"] == {"require_parameters": True, "allow_fallbacks": False}
    assert seen[0]["response_format"]["type"] == "json_schema"
    evidence_payload = json.loads(seen[0]["messages"][1]["content"])["evidence"][0]
    assert "source_identity" not in evidence_payload
    assert "source_references" not in evidence_payload
    assert evidence_payload["handle"] == "E1"


def test_openrouter_assistant_retries_only_bounded_transient_transport_statuses():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    context = build_grounding_context(
        question="Kế hoạch phát hành là gì?",
        conversation=(),
        evidence=(evidence,),
    )
    body = json.dumps(
        {
            "status": "GROUNDED",
            "answerUnits": [
                {
                    "text": "Kế hoạch phát hành vào thứ Sáu.",
                    "support": "SUPPORTED",
                    "evidenceHandles": ["E1"],
                }
            ],
            "conflictDetected": False,
            "uncertainties": [],
        },
        ensure_ascii=False,
    )
    calls = []

    def handle(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(503, content=b"private provider error")
        return httpx.Response(200, json=_provider_body(body))

    async def run():
        adapter = OpenRouterAssistantAdapter(
            _provider_settings(), transport=httpx.MockTransport(handle)
        )
        try:
            return await adapter.generate(
                context,
                deadline=asyncio.get_running_loop().time() + 5,
            )
        finally:
            await adapter.aclose()

    result = asyncio.run(run())
    assert result.provenance.attempts == 2
    assert len(calls) == 2


def test_openrouter_assistant_rejects_incomplete_provider_output():
    evidence = _evidence("Kế hoạch phát hành vào thứ Sáu.")
    context = build_grounding_context(
        question="Kế hoạch phát hành là gì?",
        conversation=(),
        evidence=(evidence,),
    )

    def handle(_request):
        return httpx.Response(
            200,
            json=_provider_body(
                "{}",
                choices=[{"message": {"content": "{}"}, "finish_reason": "length"}],
            ),
        )

    async def run():
        adapter = OpenRouterAssistantAdapter(
            _provider_settings(), transport=httpx.MockTransport(handle)
        )
        try:
            await adapter.generate(context, deadline=asyncio.get_running_loop().time() + 5)
        finally:
            await adapter.aclose()

    with pytest.raises(AssistantProviderError) as error:
        asyncio.run(run())
    assert error.value.category == "INCOMPLETE_OUTPUT"
