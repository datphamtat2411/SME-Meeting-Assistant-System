"""Authorized BGE-M3 hybrid retrieval and deterministic evidence selection."""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from importlib import resources
from typing import Any, Callable, Protocol, Sequence

from pydantic import ValidationError
from qdrant_client import models

from sme_meeting_ai.core.config import Settings

from .contracts import (
    AuthorizedRetrievalScope,
    CanonicalSourceIdentity,
    ChunkProvenance,
    IndexGeneration,
    RetrievalFilters,
    SourceRevision,
)
from .embedding import EmbeddingCompatibility, EmbeddingError, ModelAdapter
from .qdrant import (
    HybridVectorStore,
    QdrantError,
    QdrantRetrievedPoint,
    QdrantSchemaError,
)
from .reranking import RerankerAdapter, RerankerError, RerankerScore
from .retrieval_contracts import (
    MAX_RETRIEVAL_QUERY_CHARACTERS,
    EffectiveRetrievalScope,
    PreparedQuery,
    RetrievalCandidate,
    RetrievalDiagnostics,
    RetrievalEvidence,
    RetrievalFailure,
    RetrievalRequest,
    RetrievalResult,
    RetrievalStatus,
    SourceVerification,
    SourceVerificationRequest,
    SufficiencyPolicy,
    TrustedAuthorizationContext,
)

RERANKER_MODEL_ID = "BAAI/bge-reranker-v2-m3"
RERANKER_MODEL_REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"


class AuthorizationVerificationError(RuntimeError):
    def __init__(self, category: str):
        self.category = category
        super().__init__(category)


class SourceVerificationError(RuntimeError):
    def __init__(self, category: str):
        self.category = category
        super().__init__(category)


class QueryPreparationError(ValueError):
    def __init__(self, category: str):
        self.category = category
        super().__init__(category)


class CandidateValidationError(ValueError):
    def __init__(self, category: str):
        self.category = category
        super().__init__(category)


class CandidateIntegrityError(CandidateValidationError):
    pass


class AuthorizationProvider(Protocol):
    provider_id: str

    def verify(
        self, scope: AuthorizedRetrievalScope, *, now: datetime
    ) -> TrustedAuthorizationContext: ...


class SourceVerificationProvider(Protocol):
    provider_id: str

    def verify(
        self,
        requests: Sequence[SourceVerificationRequest],
        *,
        now: datetime,
        timeout_seconds: float,
    ) -> Sequence[SourceVerification]: ...


@dataclass(frozen=True)
class RerankerValidationPolicy:
    dataset_id: str
    model_id: str
    model_revision: str
    score_cutoff: float
    case_count: int
    limitations: tuple[str, ...]


def load_reranker_validation_policy() -> RerankerValidationPolicy:
    """Load the small labeled Vietnamese baseline metadata shipped with T03."""

    path = resources.files("sme_meeting_ai.rag").joinpath("reranker_validation.json")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        cases = value["cases"]
        labels = value["label_counts"]
        case_count = int(value["case_count"])
        if not isinstance(cases, list) or len(cases) != case_count:
            raise ValueError
        if sum(int(count) for count in labels.values()) != case_count:
            raise ValueError
        policy = RerankerValidationPolicy(
            dataset_id=value["dataset_id"],
            model_id=value["model_id"],
            model_revision=value["model_revision"],
            score_cutoff=float(value["provisional_raw_score_cutoff"]),
            case_count=case_count,
            limitations=tuple(value["limitations"]),
        )
    except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError) as error:
        raise ValueError("Reranker validation policy is invalid") from error
    if policy.model_id != RERANKER_MODEL_ID or policy.model_revision != RERANKER_MODEL_REVISION:
        raise ValueError("Reranker validation policy does not match the pinned model")
    if not policy.limitations or not math.isfinite(policy.score_cutoff):
        raise ValueError("Reranker validation policy is incomplete")
    return policy


@dataclass(frozen=True)
class RetrievalConfig:
    dense_prefetch_limit: int = 40
    sparse_prefetch_limit: int = 40
    fusion_limit: int = 40
    rerank_limit: int = 40
    final_evidence_limit: int = 8
    reranker_score_cutoff: float = 0.0
    source_verification_timeout_seconds: float = 10
    max_query_characters: int = MAX_RETRIEVAL_QUERY_CHARACTERS
    max_evidence_per_meeting: int = 4
    max_evidence_per_source: int = 3
    authority_comparable_margin: float = 0.25
    near_duplicate_similarity: float = 0.92
    validation_policy: RerankerValidationPolicy = field(default_factory=load_reranker_validation_policy)

    @classmethod
    def from_settings(cls, settings: Settings) -> "RetrievalConfig":
        return cls(
            dense_prefetch_limit=settings.rag_retrieval_dense_prefetch_limit,
            sparse_prefetch_limit=settings.rag_retrieval_sparse_prefetch_limit,
            fusion_limit=settings.rag_retrieval_fusion_limit,
            rerank_limit=settings.rag_retrieval_rerank_limit,
            final_evidence_limit=settings.rag_retrieval_final_evidence_limit,
            reranker_score_cutoff=settings.rag_retrieval_score_cutoff,
            source_verification_timeout_seconds=settings.rag_qdrant_timeout_seconds,
        )

    def __post_init__(self) -> None:
        limits = (
            self.dense_prefetch_limit,
            self.sparse_prefetch_limit,
            self.fusion_limit,
            self.rerank_limit,
            self.final_evidence_limit,
        )
        if any(limit < 1 or limit > 256 for limit in limits):
            raise ValueError("Retrieval limits are outside the supported bound")
        if self.rerank_limit > self.fusion_limit or self.final_evidence_limit > self.rerank_limit:
            raise ValueError("Retrieval limits must decrease from fusion to final evidence")
        if not math.isfinite(self.reranker_score_cutoff):
            raise ValueError("Reranker cutoff must be finite")
        if self.source_verification_timeout_seconds <= 0:
            raise ValueError("Source verification timeout must be positive")
        if self.max_query_characters < 1 or self.max_query_characters > MAX_RETRIEVAL_QUERY_CHARACTERS:
            raise ValueError("Query character bound is outside the supported limit")
        if self.max_evidence_per_meeting < 1 or self.max_evidence_per_source < 1:
            raise ValueError("Evidence diversity limits must be positive")
        if not 0 <= self.near_duplicate_similarity <= 1:
            raise ValueError("Near duplicate similarity must be between zero and one")
        if (
            self.validation_policy.model_id != RERANKER_MODEL_ID
            or self.validation_policy.model_revision != RERANKER_MODEL_REVISION
        ):
            raise ValueError("Sufficiency policy does not match the pinned reranker")


def _utc_string(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _scope_digest(scope: AuthorizedRetrievalScope) -> str:
    encoded = json.dumps(scope.model_dump(mode="json", by_alias=True), ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class StaticAuthorizationProvider:
    """Controlled fixture provider; production must inject a Core-backed verifier."""

    provider_id = "test-fixture"

    def __init__(self, scopes: Sequence[AuthorizedRetrievalScope]):
        self._scopes = {scope.scope_id: _scope_digest(scope) for scope in scopes}

    def verify(self, scope: AuthorizedRetrievalScope, *, now: datetime) -> TrustedAuthorizationContext:
        if scope.authority != "CORE_APPROVED" or scope.scope_id not in self._scopes:
            raise AuthorizationVerificationError("SCOPE_UNVERIFIABLE")
        if self._scopes[scope.scope_id] != _scope_digest(scope):
            raise AuthorizationVerificationError("SCOPE_DIGEST_MISMATCH")
        issued = _parse_timestamp(scope.issued_at)
        expires = _parse_timestamp(scope.expires_at)
        current = now.astimezone(timezone.utc)
        if current < issued:
            raise AuthorizationVerificationError("SCOPE_NOT_YET_VALID")
        if current >= expires:
            raise AuthorizationVerificationError("SCOPE_EXPIRED")
        return TrustedAuthorizationContext(
            scope=scope,
            providerId=self.provider_id,
            verificationReference=scope.scope_id,
            verifiedAt=_utc_string(current),
            scopeDigest=_scope_digest(scope),
        )


class StaticSourceVerificationProvider:
    """Controlled source-current fixture; Core integration owns production truth."""

    provider_id = "test-source-fixture"

    def __init__(self, records: Sequence[SourceVerification], *, unavailable: bool = False):
        self._records = {
            _source_key(record.source_identity, record.source_revision): record for record in records
        }
        self._unavailable = unavailable

    def verify(
        self,
        requests: Sequence[SourceVerificationRequest],
        *,
        now: datetime,
        timeout_seconds: float,
    ) -> Sequence[SourceVerification]:
        del timeout_seconds
        if self._unavailable:
            raise SourceVerificationError("SOURCE_VERIFICATION_UNAVAILABLE")
        result: list[SourceVerification] = []
        for request in requests:
            record = self._records.get(_source_key(request.source_identity, request.source_revision))
            if record is not None:
                result.append(record)
                continue
            result.append(
                SourceVerification(
                    sourceIdentity=request.source_identity,
                    sourceRevision=request.source_revision,
                    status="UNAVAILABLE",
                    eligible=False,
                    available=False,
                    visible=False,
                    verifiedAt=_utc_string(now),
                )
            )
        return tuple(result)


def _safe_query_text(value: str) -> bool:
    for char in value:
        category = unicodedata.category(char)
        if 0xD800 <= ord(char) <= 0xDFFF or (category in {"Cc", "Cf", "Cs"} and char not in "\r\n\t"):
            return False
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeError:
        return False
    return True


def prepare_query(query: str, *, max_characters: int = MAX_RETRIEVAL_QUERY_CHARACTERS) -> PreparedQuery:
    """Perform bounded NFC/whitespace normalization without rewriting meaning."""

    if not isinstance(query, str) or not query:
        raise QueryPreparationError("QUERY_EMPTY")
    if len(query) > max_characters:
        raise QueryPreparationError("QUERY_TOO_LONG")
    if not _safe_query_text(query):
        raise QueryPreparationError("QUERY_MALFORMED")
    normalized = unicodedata.normalize("NFC", query).strip()
    normalized = " ".join(normalized.split())
    if not normalized:
        raise QueryPreparationError("QUERY_EMPTY")
    if len(normalized) > max_characters:
        raise QueryPreparationError("QUERY_TOO_LONG")
    return PreparedQuery(originalQuery=query, normalizedQuery=normalized)


def build_effective_scope(
    context: TrustedAuthorizationContext,
    filters: RetrievalFilters,
    compatibility,
) -> EffectiveRetrievalScope:
    scope = context.scope
    if filters.meeting_ids:
        requested_meetings = set(filters.meeting_ids)
        meeting_ids = tuple(meeting_id for meeting_id in scope.allowed_meeting_ids if meeting_id in requested_meetings)
    else:
        meeting_ids = scope.allowed_meeting_ids

    source_ids_restricted = bool(scope.allowed_source_ids or filters.source_ids)
    if scope.allowed_source_ids and filters.source_ids:
        requested_sources = set(filters.source_ids)
        source_ids = tuple(source_id for source_id in scope.allowed_source_ids if source_id in requested_sources)
    elif scope.allowed_source_ids:
        source_ids = scope.allowed_source_ids
    else:
        source_ids = filters.source_ids

    source_types_restricted = bool(scope.allowed_source_types or filters.source_types)
    if scope.allowed_source_types and filters.source_types:
        requested_types = set(filters.source_types)
        source_types = tuple(source_type for source_type in scope.allowed_source_types if source_type in requested_types)
    elif scope.allowed_source_types:
        source_types = scope.allowed_source_types
    else:
        source_types = filters.source_types

    return EffectiveRetrievalScope(
        scopeId=scope.scope_id,
        scopeVersion=scope.scope_version,
        meetingIds=meeting_ids,
        sourceIds=source_ids,
        sourceTypes=source_types,
        sourceIdsRestricted=source_ids_restricted,
        sourceTypesRestricted=source_types_restricted,
        indexGenerationId=compatibility.index_generation_id,
        embeddingModelId=compatibility.model_id,
        embeddingModelRevision=compatibility.model_revision,
        tokenizerId=compatibility.tokenizer_id,
        representationVersion=compatibility.representation_version,
        indexConfigurationSha256=compatibility.index_configuration_sha256,
    )


def build_authorization_filter(effective_scope: EffectiveRetrievalScope) -> models.Filter:
    """Build one structured filter; callers must not invoke this for empty scope."""

    if not effective_scope.meeting_ids:
        raise ValueError("An empty authorized meeting scope cannot be searched")
    must: list[Any] = [
        models.FieldCondition(
            key="meeting_id",
            match=models.MatchAny(any=list(effective_scope.meeting_ids)),
        ),
        models.FieldCondition(key="index_generation_id", match=models.MatchValue(value=effective_scope.index_generation_id)),
        models.FieldCondition(key="embedding_model_id", match=models.MatchValue(value=effective_scope.embedding_model_id)),
        models.FieldCondition(
            key="embedding_model_revision",
            match=models.MatchValue(value=effective_scope.embedding_model_revision),
        ),
        models.FieldCondition(key="embedding_tokenizer_id", match=models.MatchValue(value=effective_scope.tokenizer_id)),
        models.FieldCondition(
            key="embedding_representation_version",
            match=models.MatchValue(value=effective_scope.representation_version),
        ),
        models.FieldCondition(
            key="embedding_index_configuration_sha256",
            match=models.MatchValue(value=effective_scope.index_configuration_sha256),
        ),
        models.FieldCondition(key="source_current", match=models.MatchValue(value=True)),
    ]
    if effective_scope.source_ids_restricted:
        if not effective_scope.source_ids:
            raise ValueError("An empty authorized source intersection cannot be searched")
        must.append(
            models.FieldCondition(
                key="canonical_source_id",
                match=models.MatchAny(any=list(effective_scope.source_ids)),
            )
        )
    if effective_scope.source_types_restricted:
        if not effective_scope.source_types:
            raise ValueError("An empty authorized source-type intersection cannot be searched")
        must.append(
            models.FieldCondition(
                key="source_type",
                match=models.MatchAny(any=list(effective_scope.source_types)),
            )
        )
    return models.Filter(must=must)


def _source_key(identity: CanonicalSourceIdentity, revision: SourceRevision) -> tuple[str, str, str, int]:
    return identity.source_type, identity.source_id, identity.meeting_id, revision.number


def _candidate_from_point(
    point: QdrantRetrievedPoint,
    effective_scope: EffectiveRetrievalScope,
    expected_compatibility,
) -> RetrievalCandidate:
    payload = point.payload
    if not isinstance(payload, dict):
        raise CandidateValidationError("CANDIDATE_PAYLOAD_INVALID")

    meeting_id = payload.get("meeting_id")
    source_id = payload.get("canonical_source_id")
    source_type = payload.get("source_type")
    if meeting_id not in effective_scope.meeting_ids:
        raise CandidateIntegrityError("FILTER_INTEGRITY_FAILURE")
    if effective_scope.source_ids_restricted and source_id not in effective_scope.source_ids:
        raise CandidateIntegrityError("FILTER_INTEGRITY_FAILURE")
    if effective_scope.source_types_restricted and source_type not in effective_scope.source_types:
        raise CandidateIntegrityError("FILTER_INTEGRITY_FAILURE")

    required = (
        "chunk_id",
        "display_text",
        "retrieval_text",
        "canonical_source_identity",
        "source_revision",
        "canonical_source_revision",
        "index_generation",
        "index_generation_id",
        "embedding_model_id",
        "embedding_model_revision",
        "embedding_tokenizer_id",
        "embedding_representation_version",
        "embedding_index_configuration_sha256",
        "source_current",
        "provenance",
    )
    if any(key not in payload for key in required):
        raise CandidateValidationError("CANDIDATE_PROVENANCE_MISSING")

    try:
        provenance = ChunkProvenance.model_validate_json(json.dumps(payload["provenance"], ensure_ascii=False))
        index_generation = IndexGeneration.model_validate(payload["index_generation"])
        source_identity = CanonicalSourceIdentity.model_validate(payload["canonical_source_identity"])
        source_revision = SourceRevision.model_validate(payload["source_revision"])
        compatibility = EmbeddingCompatibility(
            model_id=payload["embedding_model_id"],
            model_revision=payload["embedding_model_revision"],
            tokenizer_id=payload["embedding_tokenizer_id"],
            index_generation_id=payload["index_generation_id"],
            index_configuration_sha256=payload["embedding_index_configuration_sha256"],
            representation_version=payload["embedding_representation_version"],
        )
        candidate = RetrievalCandidate(
            pointId=str(point.point_id),
            chunkId=payload["chunk_id"],
            displayText=payload["display_text"],
            retrievalText=payload["retrieval_text"],
            rrfScore=point.score,
            provenance=provenance,
            indexGeneration=index_generation,
            embeddingCompatibility=compatibility,
        )
    except (ValidationError, TypeError, ValueError, KeyError) as error:
        raise CandidateValidationError("CANDIDATE_PROVENANCE_INVALID") from error

    identity = candidate.provenance.source_identity
    if (
        source_identity != identity
        or identity.meeting_id != meeting_id
        or identity.source_id != source_id
        or identity.source_type != source_type
        or source_revision != candidate.provenance.source_revision
        or payload["canonical_source_revision"] != source_revision.number
        or payload["index_generation_id"] != index_generation.generation_id
        or payload["source_current"] is not True
    ):
        raise CandidateValidationError("CANDIDATE_PROVENANCE_MISMATCH")
    if candidate.embedding_compatibility != expected_compatibility:
        raise CandidateValidationError("CANDIDATE_COMPATIBILITY_INVALID")
    return candidate


def _message(category: str) -> str:
    return {
        "SCOPE_UNVERIFIABLE": "Authorization scope could not be verified",
        "SCOPE_DIGEST_MISMATCH": "Authorization scope verification failed",
        "SCOPE_NOT_YET_VALID": "Authorization scope is not yet valid",
        "SCOPE_EXPIRED": "Authorization scope has expired",
        "AUTHORIZATION_PROVIDER_UNAVAILABLE": "Authorization verification is unavailable",
        "QUERY_EMPTY": "Question is empty",
        "QUERY_TOO_LONG": "Question exceeds the configured limit",
        "QUERY_MALFORMED": "Question contains invalid text",
        "TOKEN_BUDGET_EXCEEDED": "Question exceeds the embedding token budget",
        "EMBEDDING_INPUT_INVALID": "Question cannot be embedded",
        "MODEL_MANIFEST_MISMATCH": "Embedding model manifest is incompatible",
        "INDEX_CONFIGURATION_MISMATCH": "Embedding index configuration is incompatible",
        "MODEL_INPUT_BUDGET_INVALID": "Embedding model input budget is incompatible",
        "INFERENCE_FAILED": "Embedding inference failed",
        "INFERENCE_TIMEOUT": "Embedding inference timed out",
        "QDRANT_UNAVAILABLE": "Retrieval infrastructure is unavailable",
        "QUERY_FAILED": "Hybrid retrieval failed",
        "QUERY_RESPONSE_INVALID": "Hybrid retrieval response was invalid",
        "SCHEMA_INCOMPATIBLE": "Active retrieval index is incompatible",
        "FILTER_INTEGRITY_FAILURE": "Retrieval filter integrity failed",
        "CANDIDATE_VALIDATION_FAILED": "No valid retrieval candidates remained",
        "SOURCE_VERIFICATION_UNAVAILABLE": "Authoritative source verification is unavailable",
        "SOURCE_VERIFICATION_INCOMPLETE": "Authoritative source verification was incomplete",
        "INFERENCE_DEPENDENCY_UNAVAILABLE": "Reranker inference dependency is unavailable",
        "RERANKER_INPUT_INVALID": "Reranker input was invalid",
        "RERANKER_CANDIDATE_LIMIT_EXCEEDED": "Reranker candidate limit was exceeded",
        "SCORE_COUNT_INVALID": "Reranker returned an incomplete score set",
        "SCORE_OUTPUT_INVALID": "Reranker returned invalid scores",
        "SCORE_NONFINITE": "Reranker returned non-finite scores",
        "RERANKER_OUTPUT_MISMATCH": "Reranker scores did not match candidates",
        "RERANKER_FAILURE": "Reranker inference failed",
    }.get(category, "Retrieval stage failed")


def _failure(code: str, stage: str, *, retryable: bool = False) -> RetrievalFailure:
    safe_code = code if re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", code) else "RETRIEVAL_STAGE_FAILED"
    return RetrievalFailure(code=safe_code, stage=stage, retryable=retryable, message=_message(safe_code))


def _query_for_result(query: Any, max_characters: int) -> str | None:
    if isinstance(query, str) and 0 < len(query) <= max_characters and _safe_query_text(query):
        return query
    return None


@dataclass(frozen=True)
class _VerifiedRankedCandidate:
    candidate: RetrievalCandidate
    source_verification: SourceVerification
    reranker_score: float
    input_truncated: bool


def _content_tokens(text: str) -> frozenset[str]:
    return frozenset(token for token in re.findall(r"[^\W_]+", text.casefold(), flags=re.UNICODE) if token)


def _normalized_content(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def _similarity(left: str, right: str) -> float:
    left_tokens = _content_tokens(left)
    right_tokens = _content_tokens(right)
    if not left_tokens or not right_tokens:
        return 1.0 if _normalized_content(left) == _normalized_content(right) else 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def _authority_rank(value: str) -> int:
    return {
        "CONFIRMED_DECISION": 4,
        "OFFICIAL_ACTION_ITEM": 3,
        "PRIMARY_TRANSCRIPT": 2,
        "SECONDARY_APPROVED_SUMMARY": 1,
    }[value]


def _redundant(left: _VerifiedRankedCandidate, right: _VerifiedRankedCandidate, threshold: float) -> bool:
    if left.candidate.point_id == right.candidate.point_id:
        return True
    if _normalized_content(left.candidate.retrieval_text) == _normalized_content(right.candidate.retrieval_text):
        return True
    left_provenance = left.candidate.provenance
    right_provenance = right.candidate.provenance
    if (
        left_provenance.source_identity == right_provenance.source_identity
        and left_provenance.source_revision == right_provenance.source_revision
    ):
        left_segments = {reference.segment_id for reference in left_provenance.source_references if reference.segment_id}
        right_segments = {reference.segment_id for reference in right_provenance.source_references if reference.segment_id}
        if left_segments & right_segments and _similarity(left.candidate.retrieval_text, right.candidate.retrieval_text) >= 0.75:
            return True
    return _similarity(left.candidate.retrieval_text, right.candidate.retrieval_text) >= threshold


def _prefer_duplicate(
    candidate: _VerifiedRankedCandidate,
    existing: _VerifiedRankedCandidate,
    comparable_margin: float,
) -> bool:
    if candidate.candidate.provenance.authority_class == existing.candidate.provenance.authority_class:
        return candidate.reranker_score > existing.reranker_score or (
            candidate.reranker_score == existing.reranker_score
            and candidate.candidate.chunk_id < existing.candidate.chunk_id
        )
    candidate_authority = _authority_rank(candidate.candidate.provenance.authority_class)
    existing_authority = _authority_rank(existing.candidate.provenance.authority_class)
    if candidate_authority > existing_authority and candidate.reranker_score >= existing.reranker_score - comparable_margin:
        return True
    return candidate.reranker_score > existing.reranker_score + comparable_margin


_STOPWORDS = frozenset(
    {
        "ai",
        "bạn",
        "cho",
        "các",
        "có",
        "của",
        "đã",
        "được",
        "gì",
        "là",
        "nào",
        "như",
        "the",
        "what",
        "who",
        "when",
        "where",
        "how",
        "is",
        "are",
        "was",
        "were",
        "of",
        "the",
        "and",
        "in",
        "to",
    }
)


def _query_coverage(query: str, evidence: Sequence[_VerifiedRankedCandidate]) -> float | None:
    query_terms = {term for term in _content_tokens(query) if term not in _STOPWORDS and len(term) > 1}
    if not query_terms:
        return None
    evidence_terms = set().union(*(_content_tokens(item.candidate.retrieval_text) for item in evidence))
    return len(query_terms & evidence_terms) / len(query_terms)


def select_evidence(
    query: str,
    ranked: Sequence[_VerifiedRankedCandidate],
    config: RetrievalConfig,
) -> tuple[tuple[RetrievalEvidence, ...], float | None]:
    """Apply score gating, deterministic deduplication, and bounded diversity."""

    ordered = tuple(
        sorted(
            (item for item in ranked if item.reranker_score >= config.reranker_score_cutoff),
            key=lambda item: (-item.reranker_score, -item.candidate.rrf_score, item.candidate.chunk_id),
        )
    )
    if not ordered:
        return (), 0.0 if _content_tokens(query) else None

    unique: list[_VerifiedRankedCandidate] = []
    for item in ordered:
        duplicate_index = next(
            (
                index
                for index, existing in enumerate(unique)
                if _redundant(item, existing, config.near_duplicate_similarity)
            ),
            None,
        )
        if duplicate_index is None:
            unique.append(item)
        elif _prefer_duplicate(item, unique[duplicate_index], config.authority_comparable_margin):
            unique[duplicate_index] = item

    meeting_order: list[str] = []
    by_meeting: dict[str, list[_VerifiedRankedCandidate]] = defaultdict(list)
    for item in unique:
        meeting = item.candidate.provenance.meeting_id
        if meeting not in by_meeting:
            meeting_order.append(meeting)
        by_meeting[meeting].append(item)

    selected: list[_VerifiedRankedCandidate] = []
    meeting_counts: dict[str, int] = defaultdict(int)
    source_counts: dict[tuple[str, str, int], int] = defaultdict(int)

    def add(item: _VerifiedRankedCandidate) -> bool:
        if any(existing.candidate.point_id == item.candidate.point_id for existing in selected):
            return False
        meeting = item.candidate.provenance.meeting_id
        identity = item.candidate.provenance.source_identity
        source_key = (identity.source_type, identity.source_id, item.candidate.provenance.source_revision.number)
        if meeting_counts[meeting] >= config.max_evidence_per_meeting:
            return False
        if source_counts[source_key] >= config.max_evidence_per_source:
            return False
        selected.append(item)
        meeting_counts[meeting] += 1
        source_counts[source_key] += 1
        return True

    if len(meeting_order) > 1:
        for meeting in meeting_order:
            if len(selected) >= config.final_evidence_limit:
                break
            for item in by_meeting[meeting]:
                if add(item):
                    break
    for item in unique:
        if len(selected) >= config.final_evidence_limit:
            break
        add(item)

    selected.sort(key=lambda item: (-item.reranker_score, -item.candidate.rrf_score, item.candidate.chunk_id))
    coverage = _query_coverage(query, selected)
    if coverage is not None and coverage <= 0:
        return (), coverage

    evidence: list[RetrievalEvidence] = []
    for rank, item in enumerate(selected, start=1):
        evidence.append(
            RetrievalEvidence(
                rank=rank,
                pointId=item.candidate.point_id,
                chunkId=item.candidate.chunk_id,
                displayText=item.candidate.display_text,
                retrievalText=item.candidate.retrieval_text,
                provenance=item.candidate.provenance,
                sourceVerification=item.source_verification,
                rrfScore=item.candidate.rrf_score,
                rerankerScore=item.reranker_score,
                rerankerInputTruncated=item.input_truncated,
            )
        )
    return tuple(evidence), coverage


class RetrievalEngine:
    """Synchronous bounded retrieval capability for the future grounded assistant."""

    def __init__(
        self,
        *,
        embedding: ModelAdapter,
        store: HybridVectorStore,
        reranker: RerankerAdapter,
        authorization_provider: AuthorizationProvider,
        source_provider: SourceVerificationProvider | None,
        config: RetrievalConfig | None = None,
        clock: Callable[[], datetime] | None = None,
    ):
        self.embedding = embedding
        self.store = store
        self.reranker = reranker
        self.authorization_provider = authorization_provider
        self.source_provider = source_provider
        self.config = config or RetrievalConfig()
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        compatibility = getattr(embedding, "compatibility", None)
        if compatibility is None:
            raise ValueError("Retrieval requires embedding compatibility")
        self.compatibility = compatibility
        if getattr(reranker, "model_id", None) != RERANKER_MODEL_ID:
            raise ValueError("Retrieval requires the approved BGE reranker")
        if getattr(reranker, "model_revision", None) != RERANKER_MODEL_REVISION:
            raise ValueError("Retrieval requires the pinned BGE reranker revision")

    def _diagnostics(
        self,
        *,
        fused: int = 0,
        validated: int = 0,
        source_verified: int = 0,
        source_rejected: int = 0,
        reranked: int = 0,
        final: int = 0,
        rejected: int = 0,
        coverage: float | None = None,
        reranker_duration_ms: int | None = None,
    ) -> RetrievalDiagnostics:
        return RetrievalDiagnostics(
            densePrefetchLimit=self.config.dense_prefetch_limit,
            sparsePrefetchLimit=self.config.sparse_prefetch_limit,
            fusedCandidateCount=fused,
            validatedCandidateCount=validated,
            sourceVerifiedCount=source_verified,
            sourceVerificationRejectedCount=source_rejected,
            rerankedCandidateCount=reranked,
            finalEvidenceCount=final,
            rejectedCandidateCount=rejected,
            queryTermCoverage=coverage,
            rerankerDurationMs=reranker_duration_ms,
        )

    def _result(
        self,
        status: RetrievalStatus,
        request: RetrievalRequest,
        *,
        prepared: PreparedQuery | None = None,
        context: TrustedAuthorizationContext | None = None,
        source_status: str = "NOT_RUN",
        evidence: Sequence[RetrievalEvidence] = (),
        failures: Sequence[RetrievalFailure] = (),
        diagnostics: RetrievalDiagnostics | None = None,
    ) -> RetrievalResult:
        return RetrievalResult(
            status=status,
            queryOriginal=_query_for_result(request.query, self.config.max_query_characters),
            queryNormalized=prepared.normalized_query if prepared is not None else None,
            scopeId=context.scope.scope_id if context is not None else None,
            scopeVersion=context.scope.scope_version if context is not None else None,
            authorizationVerified=context is not None,
            sourceVerificationStatus=source_status,
            activeIndexGenerationId=self.compatibility.index_generation_id,
            embeddingModelId=self.compatibility.model_id,
            embeddingModelRevision=self.compatibility.model_revision,
            rerankerModelId=getattr(self.reranker, "model_id", None),
            rerankerModelRevision=getattr(self.reranker, "model_revision", None),
            sufficiencyPolicy=SufficiencyPolicy(
                datasetId=self.config.validation_policy.dataset_id,
                modelId=self.config.validation_policy.model_id,
                modelRevision=self.config.validation_policy.model_revision,
                scoreCutoff=self.config.reranker_score_cutoff,
                caseCount=self.config.validation_policy.case_count,
                limitations=self.config.validation_policy.limitations,
            ),
            evidence=tuple(evidence),
            failures=tuple(failures),
            diagnostics=diagnostics or self._diagnostics(),
        )

    def retrieve(self, request: RetrievalRequest) -> RetrievalResult:
        now = self.clock().astimezone(timezone.utc)
        try:
            context = self.authorization_provider.verify(request.authorized_scope, now=now)
        except AuthorizationVerificationError as error:
            return self._result(
                RetrievalStatus.INVALID_AUTHORIZATION,
                request,
                failures=(_failure(error.category, "AUTHORIZATION"),),
            )
        except Exception:
            return self._result(
                RetrievalStatus.INVALID_AUTHORIZATION,
                request,
                failures=(_failure("AUTHORIZATION_PROVIDER_UNAVAILABLE", "AUTHORIZATION", retryable=True),),
            )

        try:
            issued = _parse_timestamp(context.scope.issued_at)
            expires = _parse_timestamp(context.scope.expires_at)
            if (
                context.scope.authority != "CORE_APPROVED"
                or context.scope.scope_id != request.authorized_scope.scope_id
                or context.scope_digest != _scope_digest(context.scope)
                or now < issued
                or now >= expires
            ):
                raise AuthorizationVerificationError("SCOPE_UNVERIFIABLE")
        except AuthorizationVerificationError as error:
            return self._result(
                RetrievalStatus.INVALID_AUTHORIZATION,
                request,
                failures=(_failure(error.category, "AUTHORIZATION"),),
            )
        except (TypeError, ValueError):
            return self._result(
                RetrievalStatus.INVALID_AUTHORIZATION,
                request,
                failures=(_failure("SCOPE_UNVERIFIABLE", "AUTHORIZATION"),),
            )

        if not context.scope.allowed_meeting_ids:
            return self._result(RetrievalStatus.EMPTY_AUTHORIZATION, request, context=context)

        try:
            prepared = prepare_query(request.query, max_characters=self.config.max_query_characters)
        except QueryPreparationError as error:
            return self._result(
                RetrievalStatus.INVALID_QUESTION,
                request,
                context=context,
                failures=(_failure(error.category, "QUERY"),),
            )

        effective_scope = build_effective_scope(context, request.user_filters, self.compatibility)
        if not effective_scope.meeting_ids or (
            effective_scope.source_ids_restricted and not effective_scope.source_ids
        ) or (effective_scope.source_types_restricted and not effective_scope.source_types):
            return self._result(
                RetrievalStatus.INSUFFICIENT_EVIDENCE,
                request,
                prepared=prepared,
                context=context,
                diagnostics=self._diagnostics(),
            )
        if self.source_provider is None:
            return self._result(
                RetrievalStatus.SOURCE_VERIFICATION_UNAVAILABLE,
                request,
                prepared=prepared,
                context=context,
                failures=(_failure("SOURCE_VERIFICATION_UNAVAILABLE", "SOURCE_VERIFICATION", retryable=True),),
            )

        try:
            query_embeddings = tuple(self.embedding.embed_queries((prepared.normalized_query,)))
            if (
                len(query_embeddings) != 1
                or query_embeddings[0].query_index != 0
                or query_embeddings[0].compatibility != self.compatibility
            ):
                raise EmbeddingError("EMBEDDING_COMPATIBILITY_MISMATCH")
        except EmbeddingError as error:
            invalid_query_categories = {"TOKEN_BUDGET_EXCEEDED", "EMBEDDING_INPUT_INVALID"}
            incompatible_categories = {
                "MODEL_MANIFEST_MISMATCH",
                "INDEX_CONFIGURATION_MISMATCH",
                "MODEL_INPUT_BUDGET_INVALID",
                "EMBEDDING_COMPATIBILITY_MISMATCH",
                "TOKENIZER_MANIFEST_MISMATCH",
            }
            if error.category in invalid_query_categories:
                status = RetrievalStatus.INVALID_QUESTION
                stage = "QUERY"
            elif error.category in incompatible_categories:
                status = RetrievalStatus.INDEX_MODEL_INCOMPATIBLE
                stage = "EMBEDDING"
            else:
                status = RetrievalStatus.RETRIEVAL_FAILURE
                stage = "EMBEDDING"
            return self._result(
                status,
                request,
                prepared=prepared,
                context=context,
                failures=(_failure(error.category, stage, retryable=error.category in {"INFERENCE_TIMEOUT"}),),
            )

        try:
            query_filter = build_authorization_filter(effective_scope)
            points = tuple(
                self.store.query_hybrid(
                    query_embeddings[0],
                    query_filter,
                    dense_limit=self.config.dense_prefetch_limit,
                    sparse_limit=self.config.sparse_prefetch_limit,
                    fusion_limit=self.config.fusion_limit,
                )
            )
        except QdrantSchemaError as error:
            category = getattr(error, "category", "SCHEMA_INCOMPATIBLE")
            return self._result(
                RetrievalStatus.INDEX_MODEL_INCOMPATIBLE,
                request,
                prepared=prepared,
                context=context,
                failures=(_failure(category, "QDRANT"),),
            )
        except QdrantError as error:
            category = getattr(error, "category", "QUERY_FAILED")
            return self._result(
                RetrievalStatus.RETRIEVAL_FAILURE,
                request,
                prepared=prepared,
                context=context,
                failures=(_failure(category, "QDRANT", retryable=category == "QDRANT_UNAVAILABLE"),),
            )
        except Exception:
            return self._result(
                RetrievalStatus.RETRIEVAL_FAILURE,
                request,
                prepared=prepared,
                context=context,
                failures=(_failure("QUERY_FAILED", "QDRANT", retryable=True),),
            )

        candidates: list[RetrievalCandidate] = []
        rejected_count = 0
        incompatible_count = 0
        for point in points:
            try:
                candidates.append(_candidate_from_point(point, effective_scope, self.compatibility))
            except CandidateIntegrityError as error:
                return self._result(
                    RetrievalStatus.RETRIEVAL_FAILURE,
                    request,
                    prepared=prepared,
                    context=context,
                    failures=(_failure(error.category, "CANDIDATE_VALIDATION"),),
                    diagnostics=self._diagnostics(fused=len(points), rejected=rejected_count + 1),
                )
            except CandidateValidationError as error:
                rejected_count += 1
                if error.category == "CANDIDATE_COMPATIBILITY_INVALID":
                    incompatible_count += 1

        if not candidates:
            if points and incompatible_count == len(points):
                return self._result(
                    RetrievalStatus.INDEX_MODEL_INCOMPATIBLE,
                    request,
                    prepared=prepared,
                    context=context,
                    failures=(_failure("CANDIDATE_COMPATIBILITY_INVALID", "CANDIDATE_VALIDATION"),),
                    diagnostics=self._diagnostics(fused=len(points), rejected=rejected_count),
                )
            if points:
                return self._result(
                    RetrievalStatus.RETRIEVAL_FAILURE,
                    request,
                    prepared=prepared,
                    context=context,
                    failures=(_failure("CANDIDATE_VALIDATION_FAILED", "CANDIDATE_VALIDATION"),),
                    diagnostics=self._diagnostics(fused=len(points), rejected=rejected_count),
                )
            return self._result(
                RetrievalStatus.INSUFFICIENT_EVIDENCE,
                request,
                prepared=prepared,
                context=context,
                source_status="AUTHORITATIVELY_VERIFIED",
                diagnostics=self._diagnostics(fused=0),
            )

        source_requests: list[SourceVerificationRequest] = []
        request_keys: set[tuple[str, str, str, int]] = set()
        for candidate in candidates:
            key = _source_key(candidate.provenance.source_identity, candidate.provenance.source_revision)
            if key not in request_keys:
                request_keys.add(key)
                source_requests.append(
                    SourceVerificationRequest(
                        sourceIdentity=candidate.provenance.source_identity,
                        sourceRevision=candidate.provenance.source_revision,
                    )
                )
        try:
            records = tuple(
                self.source_provider.verify(
                    tuple(source_requests),
                    now=now,
                    timeout_seconds=self.config.source_verification_timeout_seconds,
                )
            )
            record_map: dict[tuple[str, str, str, int], SourceVerification] = {}
            for record in records:
                key = _source_key(record.source_identity, record.source_revision)
                if key in record_map:
                    raise SourceVerificationError("SOURCE_VERIFICATION_INCOMPLETE")
                record_map[key] = record
        except SourceVerificationError as error:
            return self._result(
                RetrievalStatus.SOURCE_VERIFICATION_UNAVAILABLE,
                request,
                prepared=prepared,
                context=context,
                source_status="UNAVAILABLE",
                failures=(_failure(error.category, "SOURCE_VERIFICATION", retryable=True),),
                diagnostics=self._diagnostics(
                    fused=len(points), validated=len(candidates), rejected=rejected_count
                ),
            )
        except Exception:
            return self._result(
                RetrievalStatus.SOURCE_VERIFICATION_UNAVAILABLE,
                request,
                prepared=prepared,
                context=context,
                source_status="UNAVAILABLE",
                failures=(_failure("SOURCE_VERIFICATION_UNAVAILABLE", "SOURCE_VERIFICATION", retryable=True),),
                diagnostics=self._diagnostics(
                    fused=len(points), validated=len(candidates), rejected=rejected_count
                ),
            )

        verified: list[tuple[RetrievalCandidate, SourceVerification]] = []
        source_rejected = 0
        unavailable_records = 0
        for candidate in candidates:
            key = _source_key(candidate.provenance.source_identity, candidate.provenance.source_revision)
            record = record_map.get(key)
            if record is None:
                source_rejected += 1
                unavailable_records += 1
                continue
            if (
                record.source_identity != candidate.provenance.source_identity
                or record.source_revision != candidate.provenance.source_revision
            ):
                source_rejected += 1
                unavailable_records += 1
                continue
            if record.status == "CURRENT":
                verified.append((candidate, record))
            else:
                source_rejected += 1
                if record.status == "UNAVAILABLE":
                    unavailable_records += 1

        if not verified:
            if unavailable_records:
                return self._result(
                    RetrievalStatus.SOURCE_VERIFICATION_UNAVAILABLE,
                    request,
                    prepared=prepared,
                    context=context,
                    source_status="UNAVAILABLE",
                    failures=(_failure("SOURCE_VERIFICATION_INCOMPLETE", "SOURCE_VERIFICATION", retryable=True),),
                    diagnostics=self._diagnostics(
                        fused=len(points),
                        validated=len(candidates),
                        source_rejected=source_rejected,
                        rejected=rejected_count,
                    ),
                )
            return self._result(
                RetrievalStatus.INSUFFICIENT_EVIDENCE,
                request,
                prepared=prepared,
                context=context,
                source_status="AUTHORITATIVELY_VERIFIED",
                diagnostics=self._diagnostics(
                    fused=len(points),
                    validated=len(candidates),
                    source_verified=0,
                    source_rejected=source_rejected,
                    rejected=rejected_count,
                ),
            )

        rerank_inputs = tuple(
            sorted(
                verified,
                key=lambda item: (-item[0].rrf_score, item[0].chunk_id),
            )[: self.config.rerank_limit]
        )
        rerank_candidates = tuple(candidate for candidate, _ in rerank_inputs)
        rerank_start = time.monotonic()
        try:
            scores = tuple(self.reranker.rerank(prepared.normalized_query, rerank_candidates))
            if len(scores) != len(rerank_candidates):
                raise RerankerError("SCORE_COUNT_INVALID")
            score_map: dict[str, RerankerScore] = {}
            for score in scores:
                if score.candidate_id in score_map or score.candidate_id not in {c.chunk_id for c in rerank_candidates}:
                    raise RerankerError("RERANKER_OUTPUT_MISMATCH")
                score_map[score.candidate_id] = score
            if set(score_map) != {candidate.chunk_id for candidate in rerank_candidates}:
                raise RerankerError("RERANKER_OUTPUT_MISMATCH")
        except RerankerError as error:
            duration = max(0, round((time.monotonic() - rerank_start) * 1000))
            return self._result(
                RetrievalStatus.RERANKER_FAILURE,
                request,
                prepared=prepared,
                context=context,
                source_status="AUTHORITATIVELY_VERIFIED",
                failures=(_failure(error.category, "RERANKER", retryable=error.category in {"INFERENCE_TIMEOUT"}),),
                diagnostics=self._diagnostics(
                    fused=len(points),
                    validated=len(candidates),
                    source_verified=len(verified),
                    source_rejected=source_rejected,
                    rejected=rejected_count,
                    reranker_duration_ms=duration,
                ),
            )
        except Exception:
            duration = max(0, round((time.monotonic() - rerank_start) * 1000))
            return self._result(
                RetrievalStatus.RERANKER_FAILURE,
                request,
                prepared=prepared,
                context=context,
                source_status="AUTHORITATIVELY_VERIFIED",
                failures=(_failure("RERANKER_FAILURE", "RERANKER"),),
                diagnostics=self._diagnostics(
                    fused=len(points),
                    validated=len(candidates),
                    source_verified=len(verified),
                    source_rejected=source_rejected,
                    rejected=rejected_count,
                    reranker_duration_ms=duration,
                ),
            )

        duration = max(0, round((time.monotonic() - rerank_start) * 1000))
        source_map = {
            candidate.chunk_id: source_verification for candidate, source_verification in rerank_inputs
        }
        ranked = tuple(
            _VerifiedRankedCandidate(
                candidate=candidate,
                source_verification=source_map[candidate.chunk_id],
                reranker_score=score_map[candidate.chunk_id].score,
                input_truncated=score_map[candidate.chunk_id].input_truncated,
            )
            for candidate in rerank_candidates
        )
        evidence, coverage = select_evidence(prepared.normalized_query, ranked, self.config)
        diagnostics = self._diagnostics(
            fused=len(points),
            validated=len(candidates),
            source_verified=len(verified),
            source_rejected=source_rejected,
            reranked=len(ranked),
            final=len(evidence),
            rejected=rejected_count,
            coverage=coverage,
            reranker_duration_ms=duration,
        )
        if not evidence:
            return self._result(
                RetrievalStatus.INSUFFICIENT_EVIDENCE,
                request,
                prepared=prepared,
                context=context,
                source_status="AUTHORITATIVELY_VERIFIED",
                diagnostics=diagnostics,
            )
        return self._result(
            RetrievalStatus.EVIDENCE_AVAILABLE,
            request,
            prepared=prepared,
            context=context,
            source_status="AUTHORITATIVELY_VERIFIED",
            evidence=evidence,
            diagnostics=diagnostics,
        )
