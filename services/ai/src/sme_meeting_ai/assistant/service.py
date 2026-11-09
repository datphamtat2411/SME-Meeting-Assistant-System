"""Application-controlled grounded Assistant orchestration over T03 retrieval."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import re
import time
from datetime import datetime, timezone
from typing import Awaitable, Callable, Protocol, Sequence

from pydantic import ValidationError

from sme_meeting_ai.rag.contracts import AuthorizedRetrievalScope
from sme_meeting_ai.rag.retrieval import (
    AuthorizationVerificationError,
    SourceVerificationError,
    prepare_query,
)
from sme_meeting_ai.rag.retrieval_contracts import (
    RetrievalEvidence,
    RetrievalRequest,
    RetrievalResult,
    RetrievalStatus,
    SourceVerificationRequest,
    TrustedAuthorizationContext,
)

from .context import AssistantSettings, ContextBudgetError, build_grounding_context
from .contracts import (
    AnswerClaim,
    AssistantAnswer,
    AssistantAnswerStatus,
    AssistantDiagnostics,
    AssistantFailure,
    AssistantFailureCategory,
    AssistantRequest,
    Citation,
    ContextualizedQuestion,
    ConversationMessage,
    GeneratedAnswer,
    GenerationResult,
    GroundingContext,
)
from .errors import AssistantProviderError, FinalVerificationError


class RetrievalCapability(Protocol):
    def retrieve(self, request: RetrievalRequest) -> RetrievalResult: ...


class GenerationCapability(Protocol):
    async def generate(self, context: GroundingContext, *, deadline: float) -> GenerationResult: ...

    async def contextualize(
        self,
        question: str,
        conversation: Sequence[ConversationMessage],
        *,
        deadline: float,
    ) -> ContextualizedQuestion: ...


class FinalVerifier(Protocol):
    def verify(
        self,
        scope: AuthorizedRetrievalScope,
        evidence: Sequence[RetrievalEvidence],
        *,
        now: datetime,
    ) -> None: ...


_FAILURE_MESSAGES = {
    AssistantFailureCategory.INVALID_REQUEST: "Assistant request is invalid",
    AssistantFailureCategory.INVALID_AUTHORIZATION: "Authorization could not be verified",
    AssistantFailureCategory.AUTHORIZATION_UNAVAILABLE: "Authorization verification is unavailable",
    AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE: "Source verification is unavailable",
    AssistantFailureCategory.SOURCE_INVALIDATED: "The cited source is no longer current or visible",
    AssistantFailureCategory.RETRIEVAL_FAILURE: "Meeting evidence retrieval failed",
    AssistantFailureCategory.MODEL_INDEX_INCOMPATIBLE: "Retrieval model or index is incompatible",
    AssistantFailureCategory.PROVIDER_UNAVAILABLE: "Assistant generation provider is unavailable",
    AssistantFailureCategory.PROVIDER_TIMEOUT: "Assistant generation timed out",
    AssistantFailureCategory.INVALID_GENERATED_RESPONSE: "Assistant generation did not satisfy its contract",
    AssistantFailureCategory.CITATION_VALIDATION_FAILURE: "Generated evidence references could not be validated",
    AssistantFailureCategory.CONTEXT_BUDGET_EXHAUSTED: "The verified evidence exceeds the Assistant context budget",
    AssistantFailureCategory.INSUFFICIENT_CONTEXT: "There is not enough safe dialogue context to resolve the follow-up",
    AssistantFailureCategory.FEATURE_UNAVAILABLE: "Assistant capability is unavailable",
    AssistantFailureCategory.DEPENDENCY_UNAVAILABLE: "Assistant dependencies are unavailable",
    AssistantFailureCategory.REQUEST_TIMEOUT: "Assistant request timed out",
    AssistantFailureCategory.CANCELLED: "Assistant request was cancelled",
}


def _message(category: AssistantFailureCategory) -> str:
    return _FAILURE_MESSAGES[category]


def _scope_digest(scope: AuthorizedRetrievalScope) -> str:
    payload = json.dumps(scope.model_dump(mode="json", by_alias=True), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _scope_current(scope: AuthorizedRetrievalScope, now: datetime) -> bool:
    issued = datetime.fromisoformat(scope.issued_at.replace("Z", "+00:00"))
    expires = datetime.fromisoformat(scope.expires_at.replace("Z", "+00:00"))
    current = now.astimezone(timezone.utc)
    return scope.authority == "CORE_APPROVED" and issued <= current < expires


def _source_key(evidence: RetrievalEvidence) -> tuple[str, str, str, int]:
    identity = evidence.provenance.source_identity
    return identity.source_type, identity.source_id, identity.meeting_id, evidence.provenance.source_revision.number


def _evidence_in_scope(request: AssistantRequest, evidence: RetrievalEvidence) -> bool:
    identity = evidence.provenance.source_identity
    scope = request.authorized_scope
    filters = request.user_filters
    if identity.meeting_id not in scope.allowed_meeting_ids:
        return False
    if scope.allowed_source_ids and identity.source_id not in scope.allowed_source_ids:
        return False
    if scope.allowed_source_types and identity.source_type not in scope.allowed_source_types:
        return False
    if filters.meeting_ids and identity.meeting_id not in filters.meeting_ids:
        return False
    if filters.source_ids and identity.source_id not in filters.source_ids:
        return False
    if filters.source_types and identity.source_type not in filters.source_types:
        return False
    return True


class TrustedFinalVerifier:
    """Re-run T03's configured trust providers immediately before delivery."""

    def __init__(self, authorization_provider, source_provider, *, timeout_seconds: float = 10):
        self.authorization_provider = authorization_provider
        self.source_provider = source_provider
        self.timeout_seconds = timeout_seconds

    def verify(
        self,
        scope: AuthorizedRetrievalScope,
        evidence: Sequence[RetrievalEvidence],
        *,
        now: datetime,
    ) -> None:
        if self.authorization_provider is None:
            raise FinalVerificationError("AUTHORIZATION_UNAVAILABLE")
        try:
            context = self.authorization_provider.verify(scope, now=now)
        except AuthorizationVerificationError:
            raise FinalVerificationError("INVALID_AUTHORIZATION") from None
        except Exception:
            raise FinalVerificationError("AUTHORIZATION_UNAVAILABLE") from None
        if not isinstance(context, TrustedAuthorizationContext):
            raise FinalVerificationError("AUTHORIZATION_UNAVAILABLE")
        if (
            context.scope != scope
            or context.scope_digest != _scope_digest(scope)
            or not _scope_current(scope, now)
        ):
            raise FinalVerificationError("INVALID_AUTHORIZATION")
        if self.source_provider is None:
            raise FinalVerificationError("SOURCE_VERIFICATION_UNAVAILABLE")

        requests: list[SourceVerificationRequest] = []
        seen: set[tuple[str, str, str, int]] = set()
        for item in evidence:
            key = _source_key(item)
            if key in seen:
                continue
            seen.add(key)
            requests.append(
                SourceVerificationRequest(
                    sourceIdentity=item.provenance.source_identity,
                    sourceRevision=item.provenance.source_revision,
                )
            )
        try:
            records = tuple(
                self.source_provider.verify(
                    tuple(requests), now=now, timeout_seconds=self.timeout_seconds
                )
            )
        except SourceVerificationError:
            raise FinalVerificationError("SOURCE_VERIFICATION_UNAVAILABLE") from None
        except Exception:
            raise FinalVerificationError("SOURCE_VERIFICATION_UNAVAILABLE") from None
        record_map = {}
        for record in records:
            key = (
                record.source_identity.source_type,
                record.source_identity.source_id,
                record.source_identity.meeting_id,
                record.source_revision.number,
            )
            if key in record_map:
                raise FinalVerificationError("SOURCE_VERIFICATION_UNAVAILABLE")
            record_map[key] = record
        for item in evidence:
            record = record_map.get(_source_key(item))
            if record is None or record.status != "CURRENT" or not (
                record.eligible and record.available and record.visible
            ):
                raise FinalVerificationError("SOURCE_INVALIDATED")
            if (
                record.source_identity != item.provenance.source_identity
                or record.source_revision != item.provenance.source_revision
            ):
                raise FinalVerificationError("SOURCE_INVALIDATED")


_CONTEXT_REFERENCES = (
    re.compile(r"\b(vậy|đó|này|phần đó|việc đó|quyết định này|cuộc họp trước|so với)\b", re.IGNORECASE),
    re.compile(r"\b(that|this|it|those|the previous meeting|compared with)\b", re.IGNORECASE),
)


def question_requires_context(question: str) -> bool:
    return any(pattern.search(question) for pattern in _CONTEXT_REFERENCES)


def _failure(
    request_id: str,
    category: AssistantFailureCategory,
    *,
    retryable: bool = False,
    retrieval_status: RetrievalStatus | None = None,
    evidence_count: int = 0,
    scope_id: str | None = None,
    scope_version: str | None = None,
    contextualized: bool = False,
    conversation_messages_used: int = 0,
    estimated_input_tokens: int | None = None,
) -> AssistantAnswer:
    return AssistantAnswer(
        requestId=request_id,
        status=AssistantAnswerStatus.FAILED,
        scopeId=scope_id,
        scopeVersion=scope_version,
        diagnostics=AssistantDiagnostics(
            retrievalStatus=retrieval_status,
            evidenceCount=evidence_count,
            conversationMessagesUsed=conversation_messages_used,
            contextualized=contextualized,
            estimatedInputTokens=estimated_input_tokens,
        ),
        failures=(
            AssistantFailure(
                category=category,
                code=category.value,
                retryable=retryable,
                message=_message(category),
            ),
        ),
    )


def _insufficient(
    request: AssistantRequest,
    *,
    retrieval_status: RetrievalStatus | None,
    category: AssistantFailureCategory | None = None,
    evidence_count: int = 0,
    contextualized: bool = False,
    conversation_messages_used: int = 0,
) -> AssistantAnswer:
    failures = () if category is None else (
        AssistantFailure(
            category=category,
            code=category.value,
            retryable=False,
            message=_message(category),
        ),
    )
    return AssistantAnswer(
        requestId=request.request_id,
        status=AssistantAnswerStatus.INSUFFICIENT_EVIDENCE,
        answer=(
            "Chưa có đủ bằng chứng cuộc họp đã được xác minh trong phạm vi được phép để trả lời câu hỏi này."
            if category is None or category is not AssistantFailureCategory.INSUFFICIENT_CONTEXT
            else "Chưa đủ ngữ cảnh an toàn để xác định câu hỏi tiếp theo. Vui lòng nêu rõ nội dung cần hỏi."
        ),
        scopeId=request.authorized_scope.scope_id,
        scopeVersion=request.authorized_scope.scope_version,
        diagnostics=AssistantDiagnostics(
            retrievalStatus=retrieval_status,
            evidenceCount=evidence_count,
            conversationMessagesUsed=conversation_messages_used,
            contextualized=contextualized,
        ),
        failures=failures,
    )


def _as_retrieval_result(value: object) -> RetrievalResult:
    if isinstance(value, RetrievalResult):
        return value
    return RetrievalResult.model_validate(value)


async def _call(value: Callable, *args, **kwargs):
    """Invoke an async capability without allowing sync test doubles to block HTTP."""

    if inspect.iscoroutinefunction(value):
        return await value(*args, **kwargs)
    result = await asyncio.to_thread(value, *args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


async def _within_deadline(awaitable: Awaitable, deadline: float):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise asyncio.TimeoutError
    async with asyncio.timeout(remaining):
        return await awaitable


class AssistantOrchestrator:
    """One bounded retrieval/generation/final-verification operation."""

    def __init__(
        self,
        retrieval: RetrievalCapability,
        generator: GenerationCapability,
        *,
        config: AssistantSettings | None = None,
        final_verifier: FinalVerifier | None = None,
        clock: Callable[[], datetime] | None = None,
        production_ready: bool = False,
    ):
        self.retrieval = retrieval
        self.generator = generator
        self.config = config or AssistantSettings()
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.production_ready = production_ready
        if final_verifier is None:
            final_verifier = TrustedFinalVerifier(
                getattr(retrieval, "authorization_provider", None),
                getattr(retrieval, "source_provider", None),
            )
        self.final_verifier = final_verifier

    @property
    def ready(self) -> bool:
        return self.retrieval is not None and self.generator is not None and self.final_verifier is not None

    async def aclose(self) -> None:
        close = getattr(self.generator, "aclose", None)
        if callable(close):
            result = close()
            if inspect.isawaitable(result):
                await result

    async def answer(self, request: AssistantRequest, *, deadline: float | None = None) -> AssistantAnswer:
        if not isinstance(request, AssistantRequest):
            raise TypeError("AssistantOrchestrator requires AssistantRequest")
        deadline = deadline or (time.monotonic() + self.config.request_timeout_seconds)
        if time.monotonic() >= deadline:
            return _failure(request.request_id, AssistantFailureCategory.REQUEST_TIMEOUT)

        current_messages = tuple(
            message
            for message in request.conversation_context
            if message.scope_id == request.authorized_scope.scope_id
            and message.scope_version == request.authorized_scope.scope_version
        )
        contextualized = False
        query = request.question
        if question_requires_context(request.question):
            if not current_messages:
                return _insufficient(
                    request,
                    retrieval_status=None,
                    category=AssistantFailureCategory.INSUFFICIENT_CONTEXT,
                )
            contextualizer = getattr(self.generator, "contextualize", None)
            if not callable(contextualizer):
                return _insufficient(
                    request,
                    retrieval_status=None,
                    category=AssistantFailureCategory.INSUFFICIENT_CONTEXT,
                    conversation_messages_used=len(current_messages),
                )
            try:
                contextualized_value = await _within_deadline(
                    _call(
                        contextualizer,
                        request.question,
                        current_messages,
                        deadline=deadline,
                    ),
                    deadline,
                )
                contextualized_result = (
                    contextualized_value
                    if isinstance(contextualized_value, ContextualizedQuestion)
                    else ContextualizedQuestion.model_validate(contextualized_value)
                )
                if re.search(r"\bE[1-8]\b", contextualized_result.standalone_question):
                    raise ValueError
                query = prepare_query(
                    contextualized_result.standalone_question,
                    max_characters=self.config.max_question_characters,
                ).normalized_query
                contextualized = True
            except asyncio.TimeoutError:
                return _failure(request.request_id, AssistantFailureCategory.PROVIDER_TIMEOUT, retryable=True)
            except asyncio.CancelledError:
                raise
            except AssistantProviderError as error:
                category = {
                    "TIMEOUT": AssistantFailureCategory.PROVIDER_TIMEOUT,
                    "MALFORMED_OUTPUT": AssistantFailureCategory.INVALID_GENERATED_RESPONSE,
                    "INCOMPLETE_OUTPUT": AssistantFailureCategory.INVALID_GENERATED_RESPONSE,
                    "REFUSAL": AssistantFailureCategory.INVALID_GENERATED_RESPONSE,
                    "CONTEXT_BUDGET": AssistantFailureCategory.CONTEXT_BUDGET_EXHAUSTED,
                    "INFERENCE_DISABLED": AssistantFailureCategory.FEATURE_UNAVAILABLE,
                }.get(error.category, AssistantFailureCategory.PROVIDER_UNAVAILABLE)
                return _failure(
                    request.request_id,
                    category,
                    retryable=error.retryable,
                )
            except Exception:
                return _insufficient(
                    request,
                    retrieval_status=None,
                    category=AssistantFailureCategory.INSUFFICIENT_CONTEXT,
                    conversation_messages_used=len(current_messages),
                )
        else:
            try:
                query = prepare_query(
                    request.question,
                    max_characters=self.config.max_question_characters,
                ).normalized_query
            except Exception:
                return _failure(request.request_id, AssistantFailureCategory.INVALID_REQUEST)

        retrieval_request = RetrievalRequest(
            contractVersion="1.0",
            query=query,
            authorizedScope=request.authorized_scope,
            userFilters=request.user_filters,
        )
        try:
            retrieval_value = await _within_deadline(
                _call(self.retrieval.retrieve, retrieval_request), deadline
            )
            retrieval_result = _as_retrieval_result(retrieval_value)
        except asyncio.TimeoutError:
            return _failure(request.request_id, AssistantFailureCategory.RETRIEVAL_FAILURE, retryable=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            return _failure(request.request_id, AssistantFailureCategory.RETRIEVAL_FAILURE, retryable=True)

        status = retrieval_result.status
        if status in {RetrievalStatus.INSUFFICIENT_EVIDENCE, RetrievalStatus.EMPTY_AUTHORIZATION}:
            return _insufficient(
                request,
                retrieval_status=status,
                evidence_count=len(retrieval_result.evidence),
                contextualized=contextualized,
                conversation_messages_used=len(current_messages),
            )
        if status is RetrievalStatus.INVALID_AUTHORIZATION:
            authorization_failure = retrieval_result.failures[0].code if retrieval_result.failures else ""
            if authorization_failure == "AUTHORIZATION_PROVIDER_UNAVAILABLE":
                return _failure(
                    request.request_id,
                    AssistantFailureCategory.AUTHORIZATION_UNAVAILABLE,
                    retryable=True,
                    retrieval_status=status,
                )
            return _failure(request.request_id, AssistantFailureCategory.INVALID_AUTHORIZATION, retrieval_status=status)
        if status is RetrievalStatus.SOURCE_VERIFICATION_UNAVAILABLE:
            return _failure(
                request.request_id,
                AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE,
                retryable=True,
                retrieval_status=status,
            )
        if status is RetrievalStatus.INDEX_MODEL_INCOMPATIBLE:
            return _failure(
                request.request_id,
                AssistantFailureCategory.MODEL_INDEX_INCOMPATIBLE,
                retrieval_status=status,
            )
        if status is RetrievalStatus.INVALID_QUESTION:
            return _failure(request.request_id, AssistantFailureCategory.INVALID_REQUEST, retrieval_status=status)
        if status is not RetrievalStatus.EVIDENCE_AVAILABLE:
            return _failure(
                request.request_id,
                AssistantFailureCategory.RETRIEVAL_FAILURE,
                retryable=True,
                retrieval_status=status,
            )
        if not retrieval_result.authorization_verified:
            return _failure(
                request.request_id,
                AssistantFailureCategory.INVALID_AUTHORIZATION,
                retrieval_status=status,
            )
        if retrieval_result.scope_id != request.authorized_scope.scope_id or retrieval_result.scope_version != request.authorized_scope.scope_version:
            return _failure(request.request_id, AssistantFailureCategory.RETRIEVAL_FAILURE, retrieval_status=status)
        if retrieval_result.source_verification_status != "AUTHORITATIVELY_VERIFIED":
            return _failure(
                request.request_id,
                AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE,
                retryable=True,
                retrieval_status=status,
            )
        if not retrieval_result.evidence or any(
            item.verification_status != "AUTHORITATIVELY_VERIFIED"
            or not _evidence_in_scope(request, item)
            for item in retrieval_result.evidence
        ):
            return _failure(request.request_id, AssistantFailureCategory.RETRIEVAL_FAILURE, retrieval_status=status)

        try:
            context = build_grounding_context(
                question=query,
                conversation=current_messages,
                evidence=retrieval_result.evidence,
                config=self.config,
            )
        except ContextBudgetError:
            return _failure(
                request.request_id,
                AssistantFailureCategory.CONTEXT_BUDGET_EXHAUSTED,
                retrieval_status=status,
                evidence_count=len(retrieval_result.evidence),
                conversation_messages_used=len(current_messages),
                contextualized=contextualized,
            )
        except (ValidationError, TypeError, ValueError):
            return _failure(request.request_id, AssistantFailureCategory.INVALID_GENERATED_RESPONSE)

        try:
            generated_value = await _within_deadline(
                _call(self.generator.generate, context, deadline=deadline), deadline
            )
            generated = (
                generated_value
                if isinstance(generated_value, GenerationResult)
                else GenerationResult.model_validate(generated_value)
            )
        except asyncio.TimeoutError:
            return _failure(
                request.request_id,
                AssistantFailureCategory.PROVIDER_TIMEOUT,
                retryable=True,
                retrieval_status=status,
                evidence_count=len(context.evidence),
                estimated_input_tokens=context.estimated_input_tokens,
            )
        except asyncio.CancelledError:
            raise
        except AssistantProviderError as error:
            category = {
                "TIMEOUT": AssistantFailureCategory.PROVIDER_TIMEOUT,
                "CONTEXT_BUDGET": AssistantFailureCategory.CONTEXT_BUDGET_EXHAUSTED,
                "MALFORMED_OUTPUT": AssistantFailureCategory.INVALID_GENERATED_RESPONSE,
                "INCOMPLETE_OUTPUT": AssistantFailureCategory.INVALID_GENERATED_RESPONSE,
                "REFUSAL": AssistantFailureCategory.INVALID_GENERATED_RESPONSE,
                "INFERENCE_DISABLED": AssistantFailureCategory.FEATURE_UNAVAILABLE,
                "AUTHENTICATION": AssistantFailureCategory.PROVIDER_UNAVAILABLE,
            }.get(error.category, AssistantFailureCategory.PROVIDER_UNAVAILABLE)
            return _failure(
                request.request_id,
                category,
                retryable=error.retryable,
                retrieval_status=status,
                evidence_count=len(context.evidence),
                estimated_input_tokens=context.estimated_input_tokens,
            )
        except (ValidationError, TypeError, ValueError):
            return _failure(
                request.request_id,
                AssistantFailureCategory.INVALID_GENERATED_RESPONSE,
                retrieval_status=status,
                evidence_count=len(context.evidence),
                estimated_input_tokens=context.estimated_input_tokens,
            )
        except Exception:
            return _failure(
                request.request_id,
                AssistantFailureCategory.PROVIDER_UNAVAILABLE,
                retryable=True,
                retrieval_status=status,
                evidence_count=len(context.evidence),
                estimated_input_tokens=context.estimated_input_tokens,
            )

        try:
            claims, citations = self._validate_and_map(generated.answer, context)
        except (ValidationError, TypeError, ValueError, KeyError):
            return _failure(
                request.request_id,
                AssistantFailureCategory.CITATION_VALIDATION_FAILURE,
                retrieval_status=status,
                evidence_count=len(context.evidence),
                estimated_input_tokens=context.estimated_input_tokens,
            )
        try:
            await _within_deadline(
                _call(
                    self.final_verifier.verify,
                    request.authorized_scope,
                    retrieval_result.evidence,
                    now=self.clock().astimezone(timezone.utc),
                ),
                deadline,
            )
        except asyncio.TimeoutError:
            return _failure(request.request_id, AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE, retryable=True)
        except asyncio.CancelledError:
            raise
        except FinalVerificationError as error:
            category = {
                "INVALID_AUTHORIZATION": AssistantFailureCategory.INVALID_AUTHORIZATION,
                "AUTHORIZATION_UNAVAILABLE": AssistantFailureCategory.AUTHORIZATION_UNAVAILABLE,
                "SOURCE_VERIFICATION_UNAVAILABLE": AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE,
                "SOURCE_INVALIDATED": AssistantFailureCategory.SOURCE_INVALIDATED,
            }.get(error.category, AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE)
            return _failure(request.request_id, category, retryable=category in {
                AssistantFailureCategory.AUTHORIZATION_UNAVAILABLE,
                AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE,
            })
        except Exception:
            return _failure(request.request_id, AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE, retryable=True)

        answer_text = "\n\n".join(claim.text for claim in claims)
        if generated.answer.uncertainties:
            answer_text += "\n\nLưu ý: " + " ".join(generated.answer.uncertainties)
        if len(answer_text) > self.config.max_answer_characters:
            return _failure(request.request_id, AssistantFailureCategory.INVALID_GENERATED_RESPONSE)
        return AssistantAnswer(
            requestId=request.request_id,
            status=AssistantAnswerStatus(generated.answer.status.value),
            answer=answer_text,
            claims=tuple(claims),
            citations=tuple(citations),
            scopeId=request.authorized_scope.scope_id,
            scopeVersion=request.authorized_scope.scope_version,
            modelProvenance=generated.provenance,
            diagnostics=AssistantDiagnostics(
                retrievalStatus=status,
                evidenceCount=len(context.evidence),
                conversationMessagesUsed=len(current_messages),
                contextualized=contextualized,
                estimatedInputTokens=context.estimated_input_tokens,
                generationAttempts=generated.provenance.attempts,
            ),
        )

    @staticmethod
    def _validate_and_map(generated: GeneratedAnswer, context: GroundingContext) -> tuple[tuple[AnswerClaim, ...], tuple[Citation, ...]]:
        handles = {item.handle: item for item in context.evidence}
        citations: list[Citation] = []
        citation_ids: dict[tuple, str] = {}
        claims: list[AnswerClaim] = []

        def citation_for(handle: str) -> str:
            item = handles.get(handle)
            if item is None:
                raise ValueError("Unknown evidence handle")
            key = (
                item.source_identity,
                item.source_revision,
                item.chunk_id,
                item.source_references,
                item.timeline_start_ms,
                item.timeline_end_ms,
            )
            existing = citation_ids.get(key)
            if existing is not None:
                return existing
            citation_id = f"C{len(citations) + 1}"
            segment_ids = tuple(
                dict.fromkeys(
                    [
                        reference.segment_id
                        for reference in item.source_references
                        if reference.segment_id is not None
                    ]
                    + [
                        reference.segment_id
                        for reference in item.evidence_references
                        if reference.segment_id is not None
                    ]
                )
            )
            citations.append(
                Citation(
                    citationId=citation_id,
                    sourceIdentity=item.source_identity,
                    sourceRevision=item.source_revision,
                    retrievalChunkId=item.chunk_id,
                    contributingSegmentIds=segment_ids,
                    sourceReferences=item.source_references,
                    timelineStartMs=item.timeline_start_ms,
                    timelineEndMs=item.timeline_end_ms,
                    speakers=item.speakers,
                    authorityClass=item.authority_class,
                    qualityClass=item.quality_class,
                    sourceStatus=item.source_status,
                    verificationStatus=item.verification_status,
                )
            )
            citation_ids[key] = citation_id
            return citation_id

        for index, unit in enumerate(generated.answer_units, start=1):
            claim_citations = tuple(citation_for(handle) for handle in unit.evidence_handles)
            claims.append(
                AnswerClaim(
                    claimId=f"A{index}",
                    text=unit.text,
                    support=unit.support,
                    citationIds=claim_citations,
                )
            )
        return tuple(claims), tuple(citations)


__all__ = [
    "AssistantOrchestrator",
    "FinalVerifier",
    "GenerationCapability",
    "RetrievalCapability",
    "TrustedFinalVerifier",
    "question_requires_context",
]
