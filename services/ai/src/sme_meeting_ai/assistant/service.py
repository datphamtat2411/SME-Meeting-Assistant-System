"""Application-controlled grounded Assistant orchestration over T03 retrieval."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
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
    AnswerSupport,
    AssistantAnswer,
    AssistantAnswerStatus,
    AssistantDiagnostics,
    AssistantFailure,
    AssistantFailureCategory,
    AssistantRequest,
    Citation,
    CanonicalContextItem,
    ConversationMessage,
    EvidenceContextItem,
    GeneratedAnswer,
    GenerationResult,
    GroundingContext,
)
from .errors import AssistantProviderError, FinalVerificationError

LOG = logging.getLogger(__name__)


class RetrievalCapability(Protocol):
    def retrieve(self, request: RetrievalRequest) -> RetrievalResult: ...


class GenerationCapability(Protocol):
    async def generate(self, context: GroundingContext, *, deadline: float) -> GenerationResult: ...

class FinalVerifier(Protocol):
    def verify(
        self,
        scope: AuthorizedRetrievalScope,
        evidence: Sequence[RetrievalEvidence | CanonicalContextItem | EvidenceContextItem],
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


def _source(evidence):
    if isinstance(evidence, RetrievalEvidence):
        return evidence.provenance
    if isinstance(evidence, CanonicalContextItem):
        return evidence.reference
    return evidence


def _evidence_in_scope(request: AssistantRequest, evidence) -> bool:
    identity = _source(evidence).source_identity
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
        evidence: Sequence[RetrievalEvidence | CanonicalContextItem | EvidenceContextItem],
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
        if not evidence:
            return  # Authorization-only verification before sending dialogue to a model.
        if self.source_provider is None:
            raise FinalVerificationError("SOURCE_VERIFICATION_UNAVAILABLE")

        requests: list[SourceVerificationRequest] = []
        seen = set()
        for item in evidence:
            source = _source(item)
            key = source.source_identity, source.source_revision
            if key in seen:
                continue
            seen.add(key)
            requests.append(
                SourceVerificationRequest(
                    sourceIdentity=source.source_identity,
                    sourceRevision=source.source_revision,
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
            key = record.source_identity, record.source_revision
            if key in record_map:
                raise FinalVerificationError("SOURCE_VERIFICATION_UNAVAILABLE")
            record_map[key] = record
        for item in evidence:
            source = _source(item)
            record = record_map.get((source.source_identity, source.source_revision))
            if record is None or record.status != "CURRENT" or not (
                record.eligible and record.available and record.visible
            ):
                raise FinalVerificationError("SOURCE_INVALIDATED")


_MEETING = re.compile(r"\b(cuộc họp|buổi họp|meeting|participants|người tham dự)\b", re.I)
_GENERAL = re.compile(
    r"(?:xin\s+chào|chào(?:\s+bạn)?|hello|hi|hey|cảm ơn|thanks)[!.?\s]*$|"
    r"(?:bạn (?:có thể làm gì|giúp được gì)|what can you do|how can you help)[!.?\s]*$",
    re.I,
)
_DEFINITION = re.compile(r"[A-Z][A-Z0-9-]{1,15}\s+là gì[?.!\s]*$|(?i:what (?:is|are)) [A-Z][A-Z0-9-]{1,15}[?.!\s]*$")
_FOLLOW_UP = re.compile(
    r"\b(vậy|đó|ấy|rõ hơn|là sao|ý là|that|it|those|elaborate|explain more)\b", re.I,
)
_OVERVIEW = re.compile(r"tóm\s+tắt|tổng\s+hợp|chủ\s+đề|nói\s+về|thảo\s+luận|"
                       r"summar|overview|main topics|discuss|about|problems", re.I)


def _general_question(question: str) -> bool:
    return not _MEETING.search(question) and not _FOLLOW_UP.search(question) and bool(
        _GENERAL.fullmatch(question) or _DEFINITION.fullmatch(question)
    )


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

        scope = request.authorized_scope
        if not scope.allowed_meeting_ids:
            return _failure(request.request_id, AssistantFailureCategory.INVALID_AUTHORIZATION)
        try:
            question = prepare_query(request.question, max_characters=self.config.max_question_characters).normalized_query
        except ValueError:
            return _failure(request.request_id, AssistantFailureCategory.INVALID_REQUEST)
        if failure := await self._verify(request, (), deadline):
            return failure

        current_messages = tuple(
            msg for msg in request.conversation_context
            if msg.scope_id == scope.scope_id and msg.scope_version == scope.scope_version
        )
        previous_question = next(
            (msg.content for msg in reversed(current_messages) if msg.role.value == "USER"), None
        )
        follows = bool(_FOLLOW_UP.search(question))
        general = _general_question(question) or (
            follows and previous_question is not None and _general_question(previous_question)
            and not _MEETING.search(question)
        )
        overview = bool(_MEETING.search(question) and _OVERVIEW.search(question))
        query = f"{question} {previous_question[:800]}" if follows and previous_question and not general else question
        if len(query) > self.config.max_question_characters:
            query = question
        canonical = () if general else tuple(
            item for item in request.canonical_context if _evidence_in_scope(request, item)
        )
        status = None
        limitation = None
        evidence = ()
        if canonical and (failure := await self._verify(request, canonical, deadline)):
            if failure.failures[0].category is not AssistantFailureCategory.SOURCE_INVALIDATED:
                return failure
            canonical = ()
            limitation = "SOURCE_INVALIDATED"
        has_meeting_content = any(item.reference.source_identity.source_type != "MEETING" for item in canonical)
        if not general and not (overview and has_meeting_content):
            try:
                retrieval_request = RetrievalRequest(
                    contractVersion="1.0", query=query, authorizedScope=scope, userFilters=request.user_filters,
                )
                retrieval_deadline = min(deadline, time.monotonic() + self.config.request_timeout_seconds / 3, time.monotonic() + 10)
                result = _as_retrieval_result(await _within_deadline(
                    _call(self.retrieval.retrieve, retrieval_request), retrieval_deadline
                ))
            except asyncio.CancelledError:
                raise
            except Exception:
                status, limitation = RetrievalStatus.RETRIEVAL_FAILURE, "RETRIEVAL_UNAVAILABLE"
            else:
                status = result.status
                if status is RetrievalStatus.INVALID_AUTHORIZATION:
                    unavailable = any(f.code == "AUTHORIZATION_PROVIDER_UNAVAILABLE" for f in result.failures)
                    return _failure(request.request_id, (
                        AssistantFailureCategory.AUTHORIZATION_UNAVAILABLE if unavailable
                        else AssistantFailureCategory.INVALID_AUTHORIZATION
                    ), retryable=unavailable, retrieval_status=status)
                if status is RetrievalStatus.SOURCE_VERIFICATION_UNAVAILABLE:
                    return _failure(request.request_id, AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE,
                                    retryable=True, retrieval_status=status)
                if status is RetrievalStatus.INVALID_QUESTION:
                    return _failure(request.request_id, AssistantFailureCategory.INVALID_REQUEST, retrieval_status=status)
                if result.evidence:
                    if (not result.authorization_verified or result.scope_id != scope.scope_id
                            or result.scope_version != scope.scope_version
                            or result.source_verification_status != "AUTHORITATIVELY_VERIFIED"
                            or any(item.verification_status != "AUTHORITATIVELY_VERIFIED"
                                   or not _evidence_in_scope(request, item) for item in result.evidence)):
                        return _failure(request.request_id, AssistantFailureCategory.RETRIEVAL_FAILURE,
                                        retrieval_status=status)
                    evidence = result.evidence
                if result.failures:
                    limitation = result.failures[0].code
                elif not evidence and limitation is None:
                    limitation = ("NO_RELEVANT_INDEXED_EVIDENCE" if has_meeting_content
                                  else "NO_MEETING_CONTENT_AVAILABLE")
        if limitation and limitation not in {"NO_RELEVANT_INDEXED_EVIDENCE", "NO_MEETING_CONTENT_AVAILABLE"}:
            LOG.warning("assistant.retrieval.degraded request_id=%s code=%s", request.request_id, limitation)

        try:
            context = build_grounding_context(
                question=question,
                conversation=current_messages,
                evidence=evidence,
                canonical=canonical,
                canonical_first=overview,
                limitation=limitation,
                config=self.config,
            )
        except ContextBudgetError:
            return _failure(
                request.request_id,
                AssistantFailureCategory.CONTEXT_BUDGET_EXHAUSTED,
                retrieval_status=status,
                evidence_count=len(evidence),
                conversation_messages_used=len(current_messages),
                contextualized=query != question,
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
        if failure := await self._verify(request, context.evidence, deadline):
            return failure

        answer_text = "\n\n".join(claim.text for claim in claims)
        if len(answer_text) > self.config.max_answer_characters:
            return _failure(request.request_id, AssistantFailureCategory.INVALID_GENERATED_RESPONSE)
        answer_status = AssistantAnswerStatus(generated.answer.status.value)
        if answer_status is AssistantAnswerStatus.GROUNDED and (
            context.context_limitation
            or any(c.quality_class != "ACCEPTED" for c in citations)
            or any(claim.support is AnswerSupport.CONFLICTED for claim in claims)
        ):
            answer_status = AssistantAnswerStatus.PARTIAL
        return AssistantAnswer(
            requestId=request.request_id,
            status=answer_status,
            answer=answer_text,
            claims=tuple(claims),
            citations=tuple(citations),
            scopeId=request.authorized_scope.scope_id,
            scopeVersion=request.authorized_scope.scope_version,
            modelProvenance=generated.provenance,
            diagnostics=AssistantDiagnostics(
                retrievalStatus=status,
                evidenceCount=len(context.evidence),
                conversationMessagesUsed=len(context.conversation),
                contextualized=query != question,
                estimatedInputTokens=context.estimated_input_tokens,
                generationAttempts=generated.provenance.attempts,
                contextLimitation=context.context_limitation,
                sourceDependencies=tuple(dict.fromkeys(item.source_references[0] for item in context.evidence)),
            ),
        )

    async def _verify(self, request: AssistantRequest, evidence, deadline: float) -> AssistantAnswer | None:
        unavailable = (AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE if evidence
                       else AssistantFailureCategory.AUTHORIZATION_UNAVAILABLE)
        try:
            await _within_deadline(_call(
                self.final_verifier.verify, request.authorized_scope, evidence,
                now=self.clock().astimezone(timezone.utc),
            ), deadline)
        except asyncio.CancelledError:
            raise
        except FinalVerificationError as error:
            category = AssistantFailureCategory.__members__.get(error.category, unavailable)
        except Exception:
            category = unavailable
        else:
            return None
        return _failure(request.request_id, category, retryable=category in {
            AssistantFailureCategory.AUTHORIZATION_UNAVAILABLE,
            AssistantFailureCategory.SOURCE_VERIFICATION_UNAVAILABLE,
        })

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
]
