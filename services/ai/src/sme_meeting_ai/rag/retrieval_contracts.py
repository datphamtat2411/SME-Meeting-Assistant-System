"""Strict contracts for authorized retrieval and evidence delivery.

These models are deliberately separate from transport contracts.  A retrieval
request may contain a Core-shaped scope, but execution still requires the
injected authorization provider to turn it into a trusted context.
"""

from __future__ import annotations

import math
from enum import StrEnum
from typing import Literal

from pydantic import Field, model_validator

from .contracts import (
    AuthorizedRetrievalScope,
    CanonicalSourceIdentity,
    ChunkProvenance,
    Identifier,
    IndexGeneration,
    RetrievalFilters,
    SafeText,
    SourceRevision,
    StrictModel,
    Timestamp,
    Uuid,
)
from .embedding import EmbeddingCompatibility

RETRIEVAL_CONTRACT_VERSION = "1.0"
MAX_RETRIEVAL_QUERY_CHARACTERS = 4_096
MAX_RETRIEVAL_FAILURE_MESSAGE = 160


class RetrievalStatus(StrEnum):
    EVIDENCE_AVAILABLE = "EVIDENCE_AVAILABLE"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    EMPTY_AUTHORIZATION = "EMPTY_AUTHORIZATION"
    INVALID_AUTHORIZATION = "INVALID_AUTHORIZATION"
    INVALID_QUESTION = "INVALID_QUESTION"
    SOURCE_VERIFICATION_UNAVAILABLE = "SOURCE_VERIFICATION_UNAVAILABLE"
    INDEX_MODEL_INCOMPATIBLE = "INDEX_MODEL_INCOMPATIBLE"
    RETRIEVAL_FAILURE = "RETRIEVAL_FAILURE"
    RERANKER_FAILURE = "RERANKER_FAILURE"


class RetrievalRequest(StrictModel):
    """Programmatic retrieval input; this is not a public HTTP request model."""

    contract_version: Literal[RETRIEVAL_CONTRACT_VERSION] = Field(alias="contractVersion")
    query: str
    authorized_scope: AuthorizedRetrievalScope = Field(alias="authorizedScope")
    user_filters: RetrievalFilters = Field(default_factory=RetrievalFilters, alias="userFilters")


class PreparedQuery(StrictModel):
    original_query: str = Field(alias="originalQuery", min_length=1, max_length=MAX_RETRIEVAL_QUERY_CHARACTERS)
    normalized_query: SafeText = Field(
        alias="normalizedQuery", min_length=1, max_length=MAX_RETRIEVAL_QUERY_CHARACTERS
    )
    token_count: int | None = Field(default=None, ge=1, alias="tokenCount")


class TrustedAuthorizationContext(StrictModel):
    """Evidence that a configured trusted integration verified a Core scope."""

    scope: AuthorizedRetrievalScope
    provider_id: Identifier = Field(alias="providerId")
    verification_reference: Identifier = Field(alias="verificationReference")
    verified_at: Timestamp = Field(alias="verifiedAt")
    scope_digest: str = Field(pattern=r"^[a-f0-9]{64}$", alias="scopeDigest")


class EffectiveRetrievalScope(StrictModel):
    """The intersection applied identically to both vector branches."""

    scope_id: Uuid = Field(alias="scopeId")
    scope_version: Identifier = Field(alias="scopeVersion")
    meeting_ids: tuple[Uuid, ...] = Field(alias="meetingIds", max_length=10_000)
    source_ids: tuple[Uuid, ...] = Field(default=(), alias="sourceIds", max_length=50_000)
    source_types: tuple[str, ...] = Field(default=(), alias="sourceTypes", max_length=4)
    source_ids_restricted: bool = Field(alias="sourceIdsRestricted")
    source_types_restricted: bool = Field(alias="sourceTypesRestricted")
    index_generation_id: Identifier = Field(alias="indexGenerationId")
    embedding_model_id: str = Field(alias="embeddingModelId", min_length=1, max_length=160)
    embedding_model_revision: str = Field(alias="embeddingModelRevision", pattern=r"^[a-f0-9]{40}$")
    tokenizer_id: str = Field(alias="tokenizerId", min_length=1, max_length=255)
    representation_version: str = Field(alias="representationVersion", min_length=1, max_length=160)
    index_configuration_sha256: str = Field(
        alias="indexConfigurationSha256", pattern=r"^[a-f0-9]{64}$"
    )


class RetrievalCandidate(StrictModel):
    """Validated, authorized-ready Qdrant result with complete T01 provenance."""

    point_id: Identifier = Field(alias="pointId")
    chunk_id: Identifier = Field(alias="chunkId")
    display_text: SafeText = Field(alias="displayText", min_length=1)
    retrieval_text: SafeText = Field(alias="retrievalText", min_length=1)
    rrf_score: float = Field(alias="rrfScore")
    provenance: ChunkProvenance
    index_generation: IndexGeneration = Field(alias="indexGeneration")
    embedding_compatibility: EmbeddingCompatibility = Field(alias="embeddingCompatibility")

    @model_validator(mode="after")
    def validate_candidate(self) -> RetrievalCandidate:
        if self.point_id != self.chunk_id:
            raise ValueError("Qdrant point and chunk identities must match")
        if not math.isfinite(self.rrf_score):
            raise ValueError("RRF score must be finite")
        if not self.provenance.source_current:
            raise ValueError("Stale indexed sources cannot become retrieval candidates")
        if self.index_generation.generation_id != self.embedding_compatibility.index_generation_id:
            raise ValueError("Candidate index generation does not match embedding compatibility")
        if self.index_generation.configuration_sha256 != self.embedding_compatibility.index_configuration_sha256:
            raise ValueError("Candidate index configuration does not match embedding compatibility")
        if self.index_generation.tokenizer_id != self.embedding_compatibility.tokenizer_id:
            raise ValueError("Candidate tokenizer does not match embedding compatibility")
        expected_authority = {
            "TRANSCRIPT": "PRIMARY_TRANSCRIPT",
            "DECISION": "CONFIRMED_DECISION",
            "SUMMARY": "SECONDARY_APPROVED_SUMMARY",
            "ACTION_ITEM": "OFFICIAL_ACTION_ITEM",
        }[self.provenance.source_type]
        if self.provenance.authority_class != expected_authority:
            raise ValueError("Candidate source authority is incompatible with its source type")
        return self


class SourceVerificationRequest(StrictModel):
    """Deduplicated canonical identity/revision lookup requested from Core."""

    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    source_revision: SourceRevision = Field(alias="sourceRevision")


SourceVerificationState = Literal[
    "CURRENT",
    "SUPERSEDED",
    "REVOKED",
    "DELETED",
    "INELIGIBLE",
    "NOT_VISIBLE",
    "UNAVAILABLE",
]


class SourceVerification(StrictModel):
    """Authoritative source-current and visibility decision, not Qdrant metadata."""

    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    source_revision: SourceRevision = Field(alias="sourceRevision")
    current_revision: SourceRevision | None = Field(default=None, alias="currentRevision")
    status: SourceVerificationState
    eligible: bool
    available: bool
    visible: bool
    verified_at: Timestamp = Field(alias="verifiedAt")

    @model_validator(mode="after")
    def validate_current_state(self) -> SourceVerification:
        if self.status == "CURRENT":
            if not (self.eligible and self.available and self.visible):
                raise ValueError("Current source verification must be eligible, available, and visible")
            if self.current_revision is None or self.current_revision.number != self.source_revision.number:
                raise ValueError("Current source verification must match the requested revision")
        return self


class RerankedCandidate(StrictModel):
    candidate: RetrievalCandidate
    reranker_score: float = Field(alias="rerankerScore")
    reranker_input_truncated: bool = Field(alias="rerankerInputTruncated")

    @model_validator(mode="after")
    def validate_score(self) -> RerankedCandidate:
        if not math.isfinite(self.reranker_score):
            raise ValueError("Reranker score must be finite")
        return self


class RetrievalEvidence(StrictModel):
    """Final evidence item suitable for T04 context construction."""

    rank: int = Field(ge=1)
    point_id: Identifier = Field(alias="pointId")
    chunk_id: Identifier = Field(alias="chunkId")
    display_text: SafeText = Field(alias="displayText", min_length=1)
    retrieval_text: SafeText = Field(alias="retrievalText", min_length=1)
    provenance: ChunkProvenance
    source_verification: SourceVerification = Field(alias="sourceVerification")
    rrf_score: float = Field(alias="rrfScore")
    reranker_score: float = Field(alias="rerankerScore")
    reranker_input_truncated: bool = Field(alias="rerankerInputTruncated")
    verification_status: Literal["AUTHORITATIVELY_VERIFIED"] = Field(
        default="AUTHORITATIVELY_VERIFIED", alias="verificationStatus"
    )

    @model_validator(mode="after")
    def validate_evidence(self) -> RetrievalEvidence:
        if self.point_id != self.chunk_id:
            raise ValueError("Evidence point and chunk identities must match")
        if self.source_verification.status != "CURRENT":
            raise ValueError("Evidence must refer to a current source")
        if not math.isfinite(self.rrf_score) or not math.isfinite(self.reranker_score):
            raise ValueError("Evidence scores must be finite")
        if self.source_verification.source_identity != self.provenance.source_identity:
            raise ValueError("Evidence source verification identity mismatch")
        if self.source_verification.source_revision != self.provenance.source_revision:
            raise ValueError("Evidence source verification revision mismatch")
        return self


class RetrievalFailure(StrictModel):
    code: Identifier
    stage: Literal[
        "AUTHORIZATION",
        "QUERY",
        "EMBEDDING",
        "QDRANT",
        "CANDIDATE_VALIDATION",
        "SOURCE_VERIFICATION",
        "RERANKER",
        "SUFFICIENCY",
    ]
    retryable: bool
    message: str = Field(min_length=1, max_length=MAX_RETRIEVAL_FAILURE_MESSAGE)


class RetrievalDiagnostics(StrictModel):
    dense_prefetch_limit: int = Field(ge=0, alias="densePrefetchLimit")
    sparse_prefetch_limit: int = Field(ge=0, alias="sparsePrefetchLimit")
    fused_candidate_count: int = Field(ge=0, alias="fusedCandidateCount")
    validated_candidate_count: int = Field(ge=0, alias="validatedCandidateCount")
    source_verified_count: int = Field(ge=0, alias="sourceVerifiedCount")
    source_verification_rejected_count: int = Field(ge=0, alias="sourceVerificationRejectedCount")
    reranked_candidate_count: int = Field(ge=0, alias="rerankedCandidateCount")
    final_evidence_count: int = Field(ge=0, alias="finalEvidenceCount")
    rejected_candidate_count: int = Field(ge=0, alias="rejectedCandidateCount")
    query_term_coverage: float | None = Field(default=None, ge=0, le=1, alias="queryTermCoverage")
    reranker_duration_ms: int | None = Field(default=None, ge=0, alias="rerankerDurationMs")


class SufficiencyPolicy(StrictModel):
    """Traceability for the provisional relevance operating point."""

    dataset_id: Identifier = Field(alias="datasetId")
    model_id: str = Field(alias="modelId", min_length=1, max_length=160)
    model_revision: str = Field(alias="modelRevision", pattern=r"^[a-f0-9]{40}$")
    score_cutoff: float = Field(alias="scoreCutoff")
    case_count: int = Field(alias="caseCount", gt=0)
    limitations: tuple[SafeText, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def finite_cutoff(self) -> SufficiencyPolicy:
        if not math.isfinite(self.score_cutoff):
            raise ValueError("Sufficiency score cutoff must be finite")
        return self


class RetrievalResult(StrictModel):
    contract_version: Literal[RETRIEVAL_CONTRACT_VERSION] = Field(
        default=RETRIEVAL_CONTRACT_VERSION, alias="contractVersion"
    )
    status: RetrievalStatus
    query_original: str | None = Field(default=None, alias="queryOriginal")
    query_normalized: str | None = Field(default=None, alias="queryNormalized")
    scope_id: Uuid | None = Field(default=None, alias="scopeId")
    scope_version: Identifier | None = Field(default=None, alias="scopeVersion")
    authorization_verified: bool = Field(default=False, alias="authorizationVerified")
    source_verification_status: Literal[
        "NOT_RUN", "AUTHORITATIVELY_VERIFIED", "PARTIAL_REJECTION", "UNAVAILABLE"
    ] = Field(default="NOT_RUN", alias="sourceVerificationStatus")
    active_index_generation_id: Identifier | None = Field(default=None, alias="activeIndexGenerationId")
    embedding_model_id: str | None = Field(default=None, alias="embeddingModelId")
    embedding_model_revision: str | None = Field(default=None, alias="embeddingModelRevision")
    reranker_model_id: str | None = Field(default=None, alias="rerankerModelId")
    reranker_model_revision: str | None = Field(default=None, alias="rerankerModelRevision")
    sufficiency_policy: SufficiencyPolicy = Field(alias="sufficiencyPolicy")
    evidence: tuple[RetrievalEvidence, ...] = ()
    failures: tuple[RetrievalFailure, ...] = ()
    diagnostics: RetrievalDiagnostics
