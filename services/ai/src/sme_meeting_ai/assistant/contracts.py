"""Strict, provider-neutral contracts for the grounded Assistant capability."""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Literal, Self

from pydantic import Field, field_validator, model_validator

from sme_meeting_ai.rag.contracts import (
    AuthorityClass,
    AuthorizedRetrievalScope,
    CanonicalSourceIdentity,
    CanonicalSourceReference,
    DateValue,
    EvidenceReference,
    QualityClass,
    RetrievalFilters,
    SafeText,
    SourceRevision,
    SpeakerAttribution,
    StrictModel,
    Timestamp,
    Uuid,
)
from sme_meeting_ai.rag.retrieval_contracts import RetrievalStatus

ASSISTANT_CONTRACT_VERSION = "1.0"
ASSISTANT_QUERY_MAX_CHARACTERS = 4_096
ASSISTANT_MAX_CONVERSATION_MESSAGES = 6
ASSISTANT_MAX_MESSAGE_CHARACTERS = 4_096
ASSISTANT_MAX_ANSWER_UNITS = 32
ASSISTANT_MAX_CITATIONS = 64
EVIDENCE_HANDLE_PATTERN = r"^E[1-9][0-9]{0,2}$"
CONTEXT_EVIDENCE_HANDLE_PATTERN = r"^E[1-8]$"


def _tuple_fields(values: object, *names: str) -> object:
    if not isinstance(values, dict):
        return values
    result = dict(values)
    for name in names:
        if isinstance(result.get(name), list):
            result[name] = tuple(result[name])
    return result


class AssistantAnswerStatus(StrEnum):
    GROUNDED = "GROUNDED"
    PARTIAL = "PARTIAL"
    CONVERSATIONAL = "CONVERSATIONAL"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    FAILED = "FAILED"


class AssistantFailureCategory(StrEnum):
    INVALID_REQUEST = "INVALID_REQUEST"
    INVALID_AUTHORIZATION = "INVALID_AUTHORIZATION"
    AUTHORIZATION_UNAVAILABLE = "AUTHORIZATION_UNAVAILABLE"
    SOURCE_VERIFICATION_UNAVAILABLE = "SOURCE_VERIFICATION_UNAVAILABLE"
    SOURCE_INVALIDATED = "SOURCE_INVALIDATED"
    RETRIEVAL_FAILURE = "RETRIEVAL_FAILURE"
    MODEL_INDEX_INCOMPATIBLE = "MODEL_INDEX_INCOMPATIBLE"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT"
    INVALID_GENERATED_RESPONSE = "INVALID_GENERATED_RESPONSE"
    CITATION_VALIDATION_FAILURE = "CITATION_VALIDATION_FAILURE"
    CONTEXT_BUDGET_EXHAUSTED = "CONTEXT_BUDGET_EXHAUSTED"
    INSUFFICIENT_CONTEXT = "INSUFFICIENT_CONTEXT"
    FEATURE_UNAVAILABLE = "FEATURE_UNAVAILABLE"
    DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE"
    REQUEST_TIMEOUT = "REQUEST_TIMEOUT"
    CANCELLED = "CANCELLED"


class GeneratedAnswerStatus(StrEnum):
    GROUNDED = "GROUNDED"
    PARTIAL = "PARTIAL"
    CONVERSATIONAL = "CONVERSATIONAL"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


class AnswerSupport(StrEnum):
    SUPPORTED = "SUPPORTED"
    UNSUPPORTED = "UNSUPPORTED"
    CONFLICTED = "CONFLICTED"
    GENERAL = "GENERAL"
    INFERRED = "INFERRED"

    @property
    def requires_evidence(self) -> bool:
        return self in {self.SUPPORTED, self.CONFLICTED, self.INFERRED}


class ConversationRole(StrEnum):
    USER = "USER"
    ASSISTANT = "ASSISTANT"


class ConversationMessage(StrictModel):
    """Core-owned dialogue context; it is never treated as meeting evidence."""

    role: ConversationRole
    content: SafeText = Field(min_length=1, max_length=ASSISTANT_MAX_MESSAGE_CHARACTERS)
    scope_id: Uuid = Field(alias="scopeId")
    scope_version: str = Field(alias="scopeVersion", min_length=1, max_length=128)

    @field_validator("role", mode="before")
    @classmethod
    def parse_role(cls, value: object) -> object:
        return ConversationRole(value) if isinstance(value, str) else value


class CanonicalContextItem(StrictModel):
    """Bounded Core projection; verified again before it receives a prompt handle."""

    reference: CanonicalSourceReference
    authority_class: AuthorityClass = Field(alias="authorityClass")
    quality_class: QualityClass = Field(alias="qualityClass")
    source_status: str = Field(alias="sourceStatus", min_length=1, max_length=64)
    text: SafeText = Field(min_length=1, max_length=2400)


class AssistantRequest(StrictModel):
    contract_version: Literal[ASSISTANT_CONTRACT_VERSION] = Field(alias="contractVersion")
    request_id: str = Field(
        alias="requestId",
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
    )
    question: SafeText = Field(min_length=1, max_length=ASSISTANT_QUERY_MAX_CHARACTERS)
    authorized_scope: AuthorizedRetrievalScope = Field(alias="authorizedScope")
    user_filters: RetrievalFilters = Field(default_factory=RetrievalFilters, alias="userFilters")
    conversation_context: tuple[ConversationMessage, ...] = Field(
        default=(), alias="conversationContext", max_length=ASSISTANT_MAX_CONVERSATION_MESSAGES
    )
    canonical_context: tuple[CanonicalContextItem, ...] = Field(
        default=(), alias="canonicalContext", max_length=8
    )

    @model_validator(mode="before")
    @classmethod
    def normalize_json_arrays(cls, values: object) -> object:
        if not isinstance(values, dict):
            return values
        result = dict(values)
        for key in ("authorizedScope", "authorized_scope"):
            if isinstance(result.get(key), dict):
                result[key] = _tuple_fields(
                    result[key],
                    "allowedMeetingIds",
                    "allowed_meeting_ids",
                    "allowedSourceIds",
                    "allowed_source_ids",
                    "allowedSourceTypes",
                    "allowed_source_types",
                )
        for key in ("userFilters", "user_filters"):
            if isinstance(result.get(key), dict):
                result[key] = _tuple_fields(
                    result[key],
                    "meetingIds",
                    "meeting_ids",
                    "sourceIds",
                    "source_ids",
                    "sourceTypes",
                    "source_types",
                )
        return _tuple_fields(result, "conversationContext", "conversation_context",
                             "canonicalContext", "canonical_context")

    @model_validator(mode="after")
    def validate_turn_bound(self) -> Self:
        if sum(message.role is ConversationRole.USER for message in self.conversation_context) > 3:
            raise ValueError("Conversation context exceeds the three-turn bound")
        if sum(message.role is ConversationRole.ASSISTANT for message in self.conversation_context) > 3:
            raise ValueError("Conversation context exceeds the three-turn bound")
        return self


class ModelProvenance(StrictModel):
    provider: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    configured_model: str = Field(
        alias="configuredModel", min_length=1, max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$",
    )
    reported_model: str | None = Field(
        default=None, alias="reportedModel", max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$",
    )
    reasoning_effort: str | None = Field(default=None, alias="reasoningEffort", max_length=16)
    input_tokens: int | None = Field(default=None, ge=0, alias="inputTokens")
    output_tokens: int | None = Field(default=None, ge=0, alias="outputTokens")
    total_tokens: int | None = Field(default=None, ge=0, alias="totalTokens")
    attempts: int = Field(ge=1, le=3)

    @model_validator(mode="after")
    def usage_is_consistent(self) -> Self:
        if self.total_tokens is not None and self.input_tokens is not None and self.output_tokens is not None:
            if self.total_tokens != self.input_tokens + self.output_tokens:
                raise ValueError("Model usage totals are inconsistent")
        return self


class ContextualizedQuestion(StrictModel):
    standalone_question: SafeText = Field(
        alias="standaloneQuestion", min_length=1, max_length=ASSISTANT_QUERY_MAX_CHARACTERS
    )
    provenance: ModelProvenance


class AnswerUnit(StrictModel):
    text: SafeText = Field(min_length=1, max_length=4_000)
    support: AnswerSupport
    evidence_handles: tuple[str, ...] = Field(
        default=(), alias="evidenceHandles", max_length=8
    )

    @field_validator("support", mode="before")
    @classmethod
    def parse_support(cls, value: object) -> object:
        return AnswerSupport(value) if isinstance(value, str) else value

    @model_validator(mode="before")
    @classmethod
    def normalize_json_arrays(cls, values: object) -> object:
        return _tuple_fields(values, "evidenceHandles", "evidence_handles")

    @model_validator(mode="after")
    def validate_support_references(self) -> Self:
        if len(set(self.evidence_handles)) != len(self.evidence_handles):
            raise ValueError("Answer evidence handles must be unique")
        if any(re.fullmatch(EVIDENCE_HANDLE_PATTERN, handle) is None for handle in self.evidence_handles):
            raise ValueError("Answer evidence handle is malformed")
        if self.support.requires_evidence != bool(self.evidence_handles):
            raise ValueError("Evidence handles must match the unit's support")
        if self.support is AnswerSupport.CONFLICTED and len(self.evidence_handles) < 2:
            raise ValueError("Conflicted answer units require representative evidence")
        return self


class GeneratedAnswer(StrictModel):
    """The only answer shape accepted from an LLM provider."""

    status: GeneratedAnswerStatus
    answer_units: tuple[AnswerUnit, ...] = Field(alias="answerUnits", min_length=1, max_length=ASSISTANT_MAX_ANSWER_UNITS)
    conflict_detected: bool = Field(default=False, alias="conflictDetected")
    uncertainties: tuple[SafeText, ...] = Field(default=(), max_length=16)

    @field_validator("status", mode="before")
    @classmethod
    def parse_status(cls, value: object) -> object:
        return GeneratedAnswerStatus(value) if isinstance(value, str) else value

    @model_validator(mode="before")
    @classmethod
    def normalize_json_arrays(cls, values: object) -> object:
        return _tuple_fields(values, "answerUnits", "answer_units", "uncertainties")

    @model_validator(mode="after")
    def validate_answer_status(self) -> Self:
        supports = {unit.support for unit in self.answer_units}
        if self.status is GeneratedAnswerStatus.CONVERSATIONAL and supports != {AnswerSupport.GENERAL}:
            raise ValueError("Conversation may contain only general units")
        if self.status is GeneratedAnswerStatus.INSUFFICIENT_EVIDENCE and (
            AnswerSupport.UNSUPPORTED not in supports or any(s.requires_evidence for s in supports)
        ):
            raise ValueError("Insufficiency must identify missing information without claims of fact")
        if self.status is GeneratedAnswerStatus.GROUNDED and supports - {
            AnswerSupport.SUPPORTED, AnswerSupport.CONFLICTED
        }:
            raise ValueError("Grounded answers may contain only supported or conflicting facts")
        if self.status is GeneratedAnswerStatus.PARTIAL and not any(s.requires_evidence for s in supports):
            raise ValueError("Partial answers require some meeting evidence")
        if self.conflict_detected and AnswerSupport.CONFLICTED not in supports:
            raise ValueError("Conflict indicator requires a conflicted answer unit")
        return self


class GenerationResult(StrictModel):
    answer: GeneratedAnswer
    provenance: ModelProvenance


class EvidenceContextItem(StrictModel):
    """Backend-assigned handle plus the minimum verified provenance for prompting."""

    handle: str = Field(pattern=CONTEXT_EVIDENCE_HANDLE_PATTERN)
    rank: int = Field(ge=1, le=8)
    chunk_id: str = Field(alias="chunkId", min_length=1, max_length=128)
    snapshot_id: Uuid | None = Field(default=None, alias="snapshotId")
    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    source_revision: SourceRevision = Field(alias="sourceRevision")
    source_type: Literal["TRANSCRIPT", "DECISION", "SUMMARY", "ACTION_ITEM", "MEETING"] = Field(alias="sourceType")
    authority_class: AuthorityClass = Field(alias="authorityClass")
    quality_class: QualityClass = Field(alias="qualityClass")
    source_status: str = Field(alias="sourceStatus", min_length=1, max_length=64)
    verification_status: Literal["AUTHORITATIVELY_VERIFIED"] = Field(alias="verificationStatus")
    meeting_id: Uuid = Field(alias="meetingId")
    source_references: tuple[CanonicalSourceReference, ...] = Field(alias="sourceReferences", min_length=1)
    evidence_references: tuple[EvidenceReference, ...] = Field(default=(), alias="evidenceReferences", max_length=50)
    timeline_start_ms: int | None = Field(default=None, ge=0, alias="timelineStartMs")
    timeline_end_ms: int | None = Field(default=None, gt=0, alias="timelineEndMs")
    speakers: tuple[SpeakerAttribution, ...] = Field(default=(), max_length=32)
    action_status: str | None = Field(default=None, alias="actionStatus", max_length=64)
    assignee_user_id: Uuid | None = Field(default=None, alias="assigneeUserId")
    due_date: DateValue | None = Field(default=None, alias="dueDate")
    confirmed_by_user_id: Uuid | None = Field(default=None, alias="confirmedByUserId")
    confirmed_at: Timestamp | None = Field(default=None, alias="confirmedAt")
    text: SafeText = Field(min_length=1, max_length=100_000)

    @model_validator(mode="before")
    @classmethod
    def normalize_json_arrays(cls, values: object) -> object:
        return _tuple_fields(values, "sourceReferences", "source_references", "evidenceReferences",
                             "evidence_references", "speakers")

    @model_validator(mode="after")
    def validate_identity(self) -> Self:
        if self.meeting_id != self.source_identity.meeting_id or self.source_type != self.source_identity.source_type:
            raise ValueError("Evidence context identity mismatch")
        if (self.timeline_start_ms is None) != (self.timeline_end_ms is None):
            raise ValueError("Evidence context timeline is incomplete")
        if self.timeline_start_ms is not None and self.timeline_end_ms <= self.timeline_start_ms:
            raise ValueError("Evidence context timeline is invalid")
        return self


class GroundingContext(StrictModel):
    question: SafeText = Field(min_length=1, max_length=ASSISTANT_QUERY_MAX_CHARACTERS)
    conversation: tuple[ConversationMessage, ...] = Field(default=(), max_length=6)
    evidence: tuple[EvidenceContextItem, ...] = Field(default=(), max_length=8)
    context_limitation: str | None = Field(default=None, alias="contextLimitation", max_length=96)
    estimated_input_tokens: int = Field(alias="estimatedInputTokens", ge=1)
    max_input_tokens: int = Field(alias="maxInputTokens", ge=1)
    max_output_tokens: int = Field(alias="maxOutputTokens", ge=1)

    @model_validator(mode="before")
    @classmethod
    def normalize_json_arrays(cls, values: object) -> object:
        return _tuple_fields(values, "conversation", "evidence")


class Citation(StrictModel):
    citation_id: str = Field(
        alias="citationId", min_length=2, max_length=8, pattern=r"^C[1-9][0-9]{0,2}$"
    )
    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    source_revision: SourceRevision = Field(alias="sourceRevision")
    retrieval_chunk_id: str = Field(alias="retrievalChunkId", min_length=1, max_length=128)
    contributing_segment_ids: tuple[Uuid, ...] = Field(default=(), alias="contributingSegmentIds", max_length=50)
    source_references: tuple[CanonicalSourceReference, ...] = Field(alias="sourceReferences", min_length=1)
    timeline_start_ms: int | None = Field(default=None, ge=0, alias="timelineStartMs")
    timeline_end_ms: int | None = Field(default=None, gt=0, alias="timelineEndMs")
    speakers: tuple[SpeakerAttribution, ...] = Field(default=(), max_length=32)
    authority_class: AuthorityClass = Field(alias="authorityClass")
    quality_class: QualityClass = Field(alias="qualityClass")
    source_status: str = Field(alias="sourceStatus", min_length=1, max_length=64)
    verification_status: Literal["AUTHORITATIVELY_VERIFIED"] = Field(alias="verificationStatus")

    @model_validator(mode="before")
    @classmethod
    def normalize_json_arrays(cls, values: object) -> object:
        return _tuple_fields(values, "contributingSegmentIds", "contributing_segment_ids",
                             "sourceReferences", "source_references", "speakers")

    @model_validator(mode="after")
    def validate_timeline(self) -> Self:
        if (self.timeline_start_ms is None) != (self.timeline_end_ms is None):
            raise ValueError("Citation timeline is incomplete")
        if self.timeline_start_ms is not None and self.timeline_end_ms <= self.timeline_start_ms:
            raise ValueError("Citation timeline is invalid")
        for reference in self.source_references:
            if reference.source_identity != self.source_identity or reference.source_revision != self.source_revision:
                raise ValueError("Citation source reference does not match the citation")
        return self


class AnswerClaim(StrictModel):
    claim_id: str = Field(alias="claimId", min_length=2, max_length=8, pattern=r"^A[1-9][0-9]{0,2}$")
    text: SafeText = Field(min_length=1, max_length=4_000)
    support: AnswerSupport
    citation_ids: tuple[str, ...] = Field(
        default=(), alias="citationIds", max_length=8,
    )

    @field_validator("support", mode="before")
    @classmethod
    def parse_support(cls, value: object) -> object:
        return AnswerSupport(value) if isinstance(value, str) else value

    @model_validator(mode="before")
    @classmethod
    def normalize_json_arrays(cls, values: object) -> object:
        return _tuple_fields(values, "citationIds", "citation_ids")

    @model_validator(mode="after")
    def validate_citations(self) -> Self:
        if len(set(self.citation_ids)) != len(self.citation_ids):
            raise ValueError("Claim citations must be unique")
        if any(re.fullmatch(r"^C[1-9][0-9]{0,2}$", citation) is None for citation in self.citation_ids):
            raise ValueError("Claim citation identifier is malformed")
        if self.support.requires_evidence != bool(self.citation_ids):
            raise ValueError("Citations must match the claim's support")
        return self


class AssistantFailure(StrictModel):
    category: AssistantFailureCategory
    code: str = Field(min_length=1, max_length=128, pattern=r"^[A-Z][A-Z0-9_]{0,127}$")
    retryable: bool
    message: SafeText = Field(min_length=1, max_length=240)

    @field_validator("category", mode="before")
    @classmethod
    def parse_category(cls, value: object) -> object:
        return AssistantFailureCategory(value) if isinstance(value, str) else value


class AssistantDiagnostics(StrictModel):
    retrieval_status: RetrievalStatus | None = Field(default=None, alias="retrievalStatus")
    evidence_count: int = Field(default=0, ge=0, le=8, alias="evidenceCount")
    conversation_messages_used: int = Field(default=0, ge=0, le=6, alias="conversationMessagesUsed")
    contextualized: bool = False
    estimated_input_tokens: int | None = Field(default=None, ge=0, alias="estimatedInputTokens")
    generation_attempts: int = Field(default=0, ge=0, le=3, alias="generationAttempts")
    context_limitation: str | None = Field(default=None, alias="contextLimitation", max_length=96)
    source_dependencies: tuple[CanonicalSourceReference, ...] = Field(default=(), alias="sourceDependencies", max_length=8)

    @model_validator(mode="before")
    @classmethod
    def normalize_json_arrays(cls, values: object) -> object:
        return _tuple_fields(values, "sourceDependencies", "source_dependencies")


class AssistantAnswer(StrictModel):
    contract_version: Literal[ASSISTANT_CONTRACT_VERSION] = Field(
        default=ASSISTANT_CONTRACT_VERSION, alias="contractVersion"
    )
    request_id: str = Field(alias="requestId", min_length=1, max_length=128)
    status: AssistantAnswerStatus
    answer: SafeText | None = Field(default=None, max_length=20_000)
    claims: tuple[AnswerClaim, ...] = Field(default=(), max_length=ASSISTANT_MAX_ANSWER_UNITS)
    citations: tuple[Citation, ...] = Field(default=(), max_length=ASSISTANT_MAX_CITATIONS)
    scope_id: Uuid | None = Field(default=None, alias="scopeId")
    scope_version: str | None = Field(default=None, alias="scopeVersion", max_length=128)
    model_provenance: ModelProvenance | None = Field(default=None, alias="modelProvenance")
    diagnostics: AssistantDiagnostics
    failures: tuple[AssistantFailure, ...] = Field(default=(), max_length=8)

    @field_validator("status", mode="before")
    @classmethod
    def parse_status(cls, value: object) -> object:
        return AssistantAnswerStatus(value) if isinstance(value, str) else value

    @model_validator(mode="before")
    @classmethod
    def normalize_json_arrays(cls, values: object) -> object:
        return _tuple_fields(values, "claims", "citations", "failures")

    @model_validator(mode="after")
    def validate_result_shape(self) -> Self:
        if (self.scope_id is None) != (self.scope_version is None):
            raise ValueError("Scope identity and version must be provided together")
        claim_ids = [claim.claim_id for claim in self.claims]
        citation_ids = [citation.citation_id for citation in self.citations]
        if len(set(claim_ids)) != len(claim_ids) or len(set(citation_ids)) != len(citation_ids):
            raise ValueError("Answer claim and citation identifiers must be unique")
        known_citations = set(citation_ids)
        if any(citation not in known_citations for claim in self.claims for citation in claim.citation_ids):
            raise ValueError("Answer claim references an unknown citation")
        if self.status is not AssistantAnswerStatus.FAILED and self.model_provenance is not None:
            if (
                not self.answer
                or not self.claims
                or not self.model_provenance
                or self.failures
                or self.scope_id is None
            ):
                raise ValueError("Successful Assistant answers require claims and provenance")
            GeneratedAnswer(
                status=self.status.value,
                answerUnits=tuple(AnswerUnit(
                    text=claim.text, support=claim.support,
                    evidenceHandles=tuple(f"E{i}" for i, _ in enumerate(claim.citation_ids, 1)),
                ) for claim in self.claims),
            )
            if self.answer != "\n\n".join(claim.text for claim in self.claims):
                raise ValueError("Answer text must match its validated units")
            if known_citations != {citation for claim in self.claims for citation in claim.citation_ids}:
                raise ValueError("Answer has unreferenced citations")
        elif self.status is AssistantAnswerStatus.INSUFFICIENT_EVIDENCE:
            if (
                not self.answer
                or self.claims
                or self.citations
                or self.model_provenance
                or self.scope_id is None
            ):
                raise ValueError("Insufficient-evidence responses cannot contain generated claims")
        elif self.status is AssistantAnswerStatus.FAILED:
            if self.answer is not None or self.claims or self.citations or not self.failures:
                raise ValueError("Failed Assistant responses cannot contain an answer")
        else:
            raise ValueError("Generated replies require model provenance")
        return self


__all__ = [
    "ASSISTANT_CONTRACT_VERSION",
    "ASSISTANT_MAX_CONVERSATION_MESSAGES",
    "ASSISTANT_QUERY_MAX_CHARACTERS",
    "AnswerClaim",
    "AnswerSupport",
    "AnswerUnit",
    "AssistantAnswer",
    "AssistantAnswerStatus",
    "AssistantDiagnostics",
    "AssistantFailure",
    "AssistantFailureCategory",
    "AssistantRequest",
    "Citation",
    "ContextualizedQuestion",
    "ConversationMessage",
    "ConversationRole",
    "EvidenceContextItem",
    "GeneratedAnswer",
    "GeneratedAnswerStatus",
    "GenerationResult",
    "GroundingContext",
    "ModelProvenance",
]
