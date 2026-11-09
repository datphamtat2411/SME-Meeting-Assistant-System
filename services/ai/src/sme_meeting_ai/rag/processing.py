"""Deterministic validation, normalization, and structure-aware chunking."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from hashlib import sha256
from typing import Protocol, Sequence
from uuid import UUID

from pydantic import ValidationError

from .contracts import (
    ActionItemSnapshot,
    AuthorityClass,
    CanonicalSourceIdentity,
    CanonicalSourceReference,
    ChunkingConfig,
    ChunkProvenance,
    DecisionSnapshot,
    EligibilityResult,
    EvidenceReference,
    IndexGeneration,
    KnowledgeChunk,
    KnowledgeSnapshot,
    NormalizationResult,
    NormalizedActionItem,
    NormalizedDecision,
    NormalizedMetadata,
    NormalizedSource,
    NormalizedSummary,
    NormalizedTranscript,
    NormalizedTranscriptUnit,
    ProcessingIssue,
    ProcessingResult,
    ProcessingStatus,
    SnapshotMetadata,
    SourceRevision,
    SummarySnapshot,
    TranscriptCoverage,
    TranscriptSegment,
    TranscriptSnapshot,
    parse_knowledge_snapshot,
)


class KnowledgeContractError(ValueError):
    """A source failed the versioned contract before business processing."""

    code = "INVALID_SOURCE_CONTRACT"

    def __init__(self, code: str | None = None):
        self.code = code or type(self).code
        super().__init__(self.code)


class KnowledgeProcessingError(ValueError):
    """A validated source could not be bounded by the supplied processor."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class TokenCounter(Protocol):
    """Small model-independent interface used by every chunking operation."""

    def count(self, text: str) -> int: ...


def _issue(code: str, severity: str, *, source_id: str | None = None,
           segment_id: str | None = None) -> ProcessingIssue:
    return ProcessingIssue(code=code, severity=severity, source_id=source_id, segment_id=segment_id)


def validate_snapshot(value: object) -> KnowledgeSnapshot:
    """Return a validated immutable snapshot or a sanitized contract error."""

    try:
        return parse_knowledge_snapshot(value)
    except (ValidationError, ValueError, TypeError, KeyError, RecursionError, OverflowError):
        raise KnowledgeContractError() from None


def verify_snapshot_bytes(raw: bytes, metadata: SnapshotMetadata) -> bytes:
    """Verify immutable external snapshot bytes before JSON contract parsing."""

    integrity = metadata.integrity
    if (
        not isinstance(raw, bytes)
        or integrity is None
        or len(raw) != integrity.size_bytes
        or not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), integrity.sha256)
    ):
        raise KnowledgeContractError("INVALID_SNAPSHOT_INTEGRITY")
    return raw


def assess_eligibility(value: KnowledgeSnapshot | object) -> EligibilityResult:
    """Apply trusted source-state rules without inspecting free-form content."""

    snapshot = validate_snapshot(value)
    identity = snapshot.metadata.source_identity
    source_id = identity.source_id
    reasons: list[ProcessingIssue] = []

    if isinstance(snapshot, TranscriptSnapshot):
        content = snapshot.payload.transcript
        if not snapshot.current:
            reasons.append(_issue("SOURCE_NOT_CURRENT", "ERROR", source_id=source_id))
        if snapshot.representation != "RECONCILED":
            reasons.append(_issue("TRANSCRIPT_NOT_RECONCILED", "ERROR", source_id=source_id))
        if content.status not in {"READY", "READY_WITH_WARNINGS"}:
            reasons.append(_issue("TRANSCRIPT_NOT_FINALIZED", "ERROR", source_id=source_id))
        if content.finalized_at is None:
            reasons.append(_issue("TRANSCRIPT_FINALIZATION_MISSING", "ERROR", source_id=source_id))
        quality = "WARNING" if content.status == "READY_WITH_WARNINGS" else "ACCEPTED"
        return EligibilityResult(
            source_identity=identity,
            eligible=not reasons,
            authority_class="PRIMARY_TRANSCRIPT" if not reasons else None,
            quality_class=quality,
            reasons=tuple(reasons),
        )

    if isinstance(snapshot, DecisionSnapshot):
        content = snapshot.content
        if content.status != "CONFIRMED":
            reasons.append(_issue("DECISION_NOT_CONFIRMED", "ERROR", source_id=source_id))
        if content.is_stale:
            reasons.append(_issue("DECISION_STALE", "ERROR", source_id=source_id))
        return EligibilityResult(
            source_identity=identity,
            eligible=not reasons,
            authority_class="CONFIRMED_DECISION" if not reasons else None,
            quality_class="ACCEPTED" if not reasons else None,
            reasons=tuple(reasons),
        )

    if isinstance(snapshot, SummarySnapshot):
        content = snapshot.content
        if not content.is_current:
            reasons.append(_issue("SUMMARY_NOT_CURRENT", "ERROR", source_id=source_id))
        if not content.is_approved:
            reasons.append(_issue("SUMMARY_NOT_APPROVED", "ERROR", source_id=source_id))
        if content.is_stale:
            reasons.append(_issue("SUMMARY_STALE", "ERROR", source_id=source_id))
        quality = "WARNING" if content.quality_status == "READY_WITH_WARNINGS" else "ACCEPTED"
        if content.ai_warnings and quality == "ACCEPTED":
            quality = "WARNING"
        return EligibilityResult(
            source_identity=identity,
            eligible=not reasons,
            authority_class="SECONDARY_APPROVED_SUMMARY" if not reasons else None,
            quality_class=quality if not reasons else None,
            reasons=tuple(reasons),
        )

    if isinstance(snapshot, ActionItemSnapshot):
        content = snapshot.content
        if not content.is_official or content.status == "PROPOSED":
            reasons.append(_issue("ACTION_ITEM_NOT_OFFICIAL", "ERROR", source_id=source_id))
        return EligibilityResult(
            source_identity=identity,
            eligible=not reasons,
            authority_class="OFFICIAL_ACTION_ITEM" if not reasons else None,
            quality_class="ACCEPTED" if not reasons else None,
            reasons=tuple(reasons),
        )

    return EligibilityResult(
        source_identity=identity,
        eligible=False,
        reasons=(_issue("UNSUPPORTED_SOURCE_TYPE", "ERROR", source_id=source_id),),
    )


def _normalize_text(value: str) -> str:
    # Collapse layout whitespace only. Vietnamese punctuation, accents, names,
    # and business wording remain unchanged.
    return re.sub(r"[\t\r\n ]+", " ", value).strip()


def _source_metadata(
    metadata: SnapshotMetadata,
    authority_class: AuthorityClass,
    quality_class: str,
    source_status: str,
    current: bool,
    *,
    source_media_id: str | None = None,
    processing_job_id: str | None = None,
    source_detail: str | None = None,
    selection_epoch: int | None = None,
    ai_warnings: tuple[str, ...] = (),
    confirmed_by_user_id: str | None = None,
    confirmed_at: str | None = None,
) -> NormalizedMetadata:
    integrity = metadata.integrity
    return NormalizedMetadata(
        snapshot_id=metadata.snapshot_id,
        source_identity=metadata.source_identity,
        source_revision=metadata.source_revision,
        authority_class=authority_class,
        quality_class=quality_class,
        source_status=source_status,
        current=current,
        snapshot_sha256=integrity.sha256 if integrity else None,
        snapshot_size_bytes=integrity.size_bytes if integrity else None,
        source_media_id=source_media_id,
        processing_job_id=processing_job_id,
        source_detail=source_detail,
        selection_epoch=selection_epoch,
        ai_warnings=ai_warnings,
        confirmed_by_user_id=confirmed_by_user_id,
        confirmed_at=confirmed_at,
    )


def _coverage_overlaps(segment: TranscriptSegment, region: TranscriptCoverage) -> bool:
    return (
        segment.start_ms is not None
        and segment.end_ms is not None
        and segment.start_ms < region.end_ms
        and region.start_ms < segment.end_ms
    )


def _normalize_transcript(snapshot: TranscriptSnapshot) -> tuple[NormalizedTranscript, tuple[ProcessingIssue, ...]]:
    payload = snapshot.payload
    projection = payload.transcript
    issues: list[ProcessingIssue] = []
    units: list[NormalizedTranscriptUnit] = []
    excluded: list[str] = []
    non_covered = tuple(region for region in payload.coverage if region.coverage_status != "COVERED")
    speakers = {speaker.id: speaker for speaker in payload.speakers}

    for segment in projection.segments:
        exclusion_code: str | None = None
        if segment.quality_status == "SUSPICIOUS":
            exclusion_code = "SUSPICIOUS_SEGMENT_EXCLUDED"
        elif segment.quality_status == "UNRESOLVED":
            exclusion_code = "UNRESOLVED_SEGMENT_EXCLUDED"
        elif segment.quality_status != "ACCEPTED":
            exclusion_code = "UNKNOWN_SEGMENT_QUALITY"
        elif non_covered and (
            any(_coverage_overlaps(segment, region) for region in non_covered)
            or segment.start_ms is None
        ):
            exclusion_code = "UNCOVERED_SEGMENT_EXCLUDED"

        text = _normalize_text(segment.text)
        if not text:
            exclusion_code = exclusion_code or "EMPTY_SEGMENT"

        if exclusion_code is not None:
            excluded.append(segment.id)
            severity = "WARNING" if exclusion_code == "EMPTY_SEGMENT" else "INFO"
            issues.append(_issue(exclusion_code, severity, source_id=projection.id, segment_id=segment.id))
            continue

        units.append(
            NormalizedTranscriptUnit(
                segment_id=segment.id,
                ordinal=segment.ordinal,
                text=text,
                start_ms=segment.start_ms,
                end_ms=segment.end_ms,
                speaker_cluster_id=segment.speaker_cluster_id,
                speaker_label=segment.speaker_label,
                speaker_user_id=(
                    speakers[segment.speaker_cluster_id].user_id
                    if segment.speaker_cluster_id in speakers else None
                ),
                speaker_display_name=(
                    speakers[segment.speaker_cluster_id].display_name
                    if segment.speaker_cluster_id in speakers else None
                ),
                segment_version=segment.version,
            )
        )

    quality = "MIXED" if excluded else (
        "WARNING" if projection.status == "READY_WITH_WARNINGS" else "ACCEPTED"
    )
    return (
        NormalizedTranscript(
            source_type="TRANSCRIPT",
            metadata=_source_metadata(
                snapshot.metadata,
                "PRIMARY_TRANSCRIPT",
                quality,
                projection.status,
                snapshot.current,
                source_media_id=projection.source_media_id,
                processing_job_id=projection.processing_job_id,
                source_detail=snapshot.representation,
            ),
            language_code=projection.language_code,
            duration_ms=projection.duration_ms,
            units=tuple(units),
            excluded_segment_ids=tuple(excluded),
        ),
        tuple(issues),
    )


def _evidence_references(
    identity: CanonicalSourceIdentity,
    transcript_id: str | None,
    revision: SourceRevision | None,
    segment_ids: Sequence[str],
) -> tuple[EvidenceReference, ...]:
    if not segment_ids or transcript_id is None:
        return ()
    transcript_identity = CanonicalSourceIdentity(
        source_type="TRANSCRIPT", source_id=transcript_id, meeting_id=identity.meeting_id
    )
    return tuple(
        EvidenceReference(
            evidence_type="TRANSCRIPT_SEGMENT",
            source_identity=transcript_identity,
            source_revision=revision,
            segment_id=segment_id,
        )
        for segment_id in segment_ids
    )


def _effective_transcript_revision(content) -> SourceRevision | None:
    if content.transcript_revision is not None:
        return content.transcript_revision
    if content.content_revision is not None:
        return SourceRevision(number=content.content_revision)
    return None


def _normalize_decision(snapshot: DecisionSnapshot) -> tuple[NormalizedDecision, tuple[ProcessingIssue, ...]]:
    content = snapshot.content
    normalized = _normalize_text(content.content)
    transcript_revision = _effective_transcript_revision(content)
    issues: list[ProcessingIssue] = []
    if not normalized:
        issues.append(_issue("EMPTY_CONTENT", "WARNING", source_id=content.id))
    if content.evidence_segment_ids and transcript_revision is None:
        issues.append(_issue("EVIDENCE_REVISION_MISSING", "WARNING", source_id=content.id))
    return (
        NormalizedDecision(
            source_type="DECISION",
            metadata=_source_metadata(
                snapshot.metadata,
                "CONFIRMED_DECISION",
                "ACCEPTED",
                content.status,
                True,
                source_detail=content.source_type,
                ai_warnings=content.ai_warnings,
                confirmed_by_user_id=content.confirmed_by_user_id,
                confirmed_at=content.confirmed_at,
            ),
            content=normalized,
            status="CONFIRMED",
            version=content.version,
            evidence_references=_evidence_references(
                snapshot.metadata.source_identity,
                content.transcript_id,
                transcript_revision,
                content.evidence_segment_ids,
            ),
            transcript_id=content.transcript_id,
            transcript_revision=transcript_revision,
            ai_warnings=content.ai_warnings,
        ),
        tuple(issues),
    )


def _normalize_summary(snapshot: SummarySnapshot) -> tuple[NormalizedSummary, tuple[ProcessingIssue, ...]]:
    content = snapshot.content
    transcript_revision = _effective_transcript_revision(content)
    normalized = "\n\n".join(
        _normalize_text(paragraph)
        for paragraph in re.split(r"\n\s*\n", content.content)
        if _normalize_text(paragraph)
    )
    issues = (_issue("EMPTY_CONTENT", "WARNING", source_id=content.id),) if not normalized else ()
    quality = "WARNING" if content.quality_status == "READY_WITH_WARNINGS" or content.ai_warnings else "ACCEPTED"
    return (
        NormalizedSummary(
            source_type="SUMMARY",
            metadata=_source_metadata(
                snapshot.metadata,
                "SECONDARY_APPROVED_SUMMARY",
                quality,
                content.quality_status,
                content.is_current,
                source_detail=content.source_type,
                selection_epoch=content.selection_epoch,
                ai_warnings=content.ai_warnings,
            ),
            content=normalized,
            version=content.version_number,
            source_type_detail=content.source_type,
            transcript_id=content.transcript_id,
            transcript_revision=transcript_revision,
            ai_warnings=content.ai_warnings,
        ),
        issues,
    )


def _normalize_action_item(snapshot: ActionItemSnapshot) -> tuple[NormalizedActionItem, tuple[ProcessingIssue, ...]]:
    content = snapshot.content
    transcript_revision = _effective_transcript_revision(content)
    title = _normalize_text(content.title)
    details = None if content.details is None else _normalize_text(content.details)
    issues: list[ProcessingIssue] = []
    if not title and not details:
        issues.append(_issue("EMPTY_CONTENT", "WARNING", source_id=content.id))
    if content.evidence_segment_ids and transcript_revision is None:
        issues.append(_issue("EVIDENCE_REVISION_MISSING", "WARNING", source_id=content.id))
    return (
        NormalizedActionItem(
            source_type="ACTION_ITEM",
            metadata=_source_metadata(
                snapshot.metadata,
                "OFFICIAL_ACTION_ITEM",
                "ACCEPTED",
                content.status,
                True,
                source_detail=content.source_type,
                confirmed_by_user_id=content.confirmed_by_user_id,
                confirmed_at=content.confirmed_at,
            ),
            title=title,
            details=details,
            status=content.status,
            version=content.version,
            assignee_user_id=content.assignee_user_id,
            due_date=content.due_date,
            transcript_id=content.transcript_id,
            transcript_revision=transcript_revision,
            evidence_references=_evidence_references(
                snapshot.metadata.source_identity,
                content.transcript_id,
                transcript_revision,
                content.evidence_segment_ids,
            ),
        ),
        tuple(issues),
    )


def normalize_snapshot(value: KnowledgeSnapshot | object) -> NormalizationResult:
    """Normalize a trusted projection and retain explicit ineligible outcomes."""

    if isinstance(value, dict):
        snapshot_type = value.get("snapshotType", value.get("snapshot_type"))
        if snapshot_type is not None and snapshot_type not in {
            "TRANSCRIPT", "DECISION", "SUMMARY", "ACTION_ITEM",
        }:
            return NormalizationResult(
                contract_version="1.0",
                status="UNSUPPORTED",
                issues=(_issue("UNSUPPORTED_SOURCE_TYPE", "ERROR"),),
            )
    try:
        snapshot = validate_snapshot(value)
    except KnowledgeContractError:
        return NormalizationResult(
            contract_version="1.0",
            status="INVALID",
            issues=(_issue("INVALID_SOURCE_CONTRACT", "ERROR"),),
        )

    eligibility = assess_eligibility(snapshot)
    if not eligibility.eligible:
        return NormalizationResult(
            contract_version="1.0",
            status="INELIGIBLE",
            issues=eligibility.reasons,
        )

    if isinstance(snapshot, TranscriptSnapshot):
        normalized, issues = _normalize_transcript(snapshot)
        has_content = bool(normalized.units)
    elif isinstance(snapshot, DecisionSnapshot):
        normalized, issues = _normalize_decision(snapshot)
        has_content = bool(normalized.content)
    elif isinstance(snapshot, SummarySnapshot):
        normalized, issues = _normalize_summary(snapshot)
        has_content = bool(normalized.content)
    elif isinstance(snapshot, ActionItemSnapshot):
        normalized, issues = _normalize_action_item(snapshot)
        has_content = bool(normalized.title or normalized.details)
    else:
        return NormalizationResult(
            contract_version="1.0",
            status="INVALID",
            issues=(_issue("UNSUPPORTED_SOURCE_TYPE", "ERROR"),),
        )

    return NormalizationResult(
        contract_version="1.0",
        status="NORMALIZED" if has_content else "NO_ELIGIBLE_CONTENT",
        normalized=normalized,
        issues=issues,
    )


def _count(counter: TokenCounter, text: str) -> int:
    try:
        value = counter.count(text)
    except Exception:
        raise KnowledgeProcessingError("TOKEN_COUNTER_FAILED") from None
    if type(value) is not int or value < 0:
        raise KnowledgeProcessingError("TOKEN_COUNTER_INVALID")
    return value


def _render_speaker(label: str | None, text: str) -> str:
    return f"{label}: {text}" if label else text


def _boundary_positions(text: str) -> tuple[int, ...]:
    positions: set[int] = set()
    for match in re.finditer(r"[.!?。！？;；](?=\s|$)", text):
        positions.add(match.end())
    for match in re.finditer(r"\s+", text):
        positions.add(match.start())
    return tuple(sorted(position for position in positions if 0 < position < len(text)))


def _split_text(text: str, prefix: str, maximum: int, counter: TokenCounter) -> tuple[str, ...]:
    if _count(counter, prefix + text) <= maximum:
        return (text,)
    if _count(counter, prefix) >= maximum:
        raise KnowledgeProcessingError("SOURCE_UNIT_EXCEEDS_TOKEN_BUDGET")

    remaining = text
    pieces: list[str] = []
    while remaining:
        if _count(counter, prefix + remaining) <= maximum:
            pieces.append(remaining)
            break

        selected: tuple[str, str] | None = None
        for cut in reversed(_boundary_positions(remaining)):
            left = remaining[:cut].rstrip()
            right = remaining[cut:].lstrip()
            if left and _count(counter, prefix + left) <= maximum:
                selected = (left, right)
                break

        if selected is None:
            # A long unbroken token has no semantic boundary. Binary search a
            # deterministic character cut; never discard or repeat characters.
            low, high = 1, len(remaining)
            best = 0
            while low <= high:
                middle = (low + high) // 2
                candidate = remaining[:middle]
                if _count(counter, prefix + candidate) <= maximum:
                    best = middle
                    low = middle + 1
                else:
                    high = middle - 1
            if best == 0:
                raise KnowledgeProcessingError("SOURCE_UNIT_EXCEEDS_TOKEN_BUDGET")
            selected = (remaining[:best], remaining[best:])

        left, remaining = selected
        pieces.append(left)
    return tuple(pieces)


def _split_document(text: str, maximum: int, counter: TokenCounter, *, paragraphs: bool) -> tuple[str, ...]:
    if not paragraphs:
        return _split_text(text, "", maximum, counter)

    source_paragraphs = tuple(
        _normalize_text(paragraph)
        for paragraph in re.split(r"\n\s*\n", text)
        if _normalize_text(paragraph)
    )
    if not source_paragraphs:
        return ()

    pieces: list[str] = []
    current = ""
    for paragraph in source_paragraphs:
        for part in _split_text(paragraph, "", maximum, counter):
            candidate = part if not current else f"{current}\n\n{part}"
            if current and _count(counter, candidate) > maximum:
                pieces.append(current)
                current = part
            else:
                current = candidate
    if current:
        pieces.append(current)
    return tuple(pieces)


@dataclass(frozen=True)
class _AtomicUnit:
    text: str
    source_reference: CanonicalSourceReference
    evidence_references: tuple[EvidenceReference, ...]
    label: str | None = None
    cluster_id: str | None = None
    user_id: str | None = None
    display_name: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None
    unit_key: str = ""


def _ref(
    normalized: NormalizedSource,
    *,
    segment_id: str | None = None,
    start_ms: int | None = None,
    end_ms: int | None = None,
) -> CanonicalSourceReference:
    return CanonicalSourceReference(
        source_identity=normalized.metadata.source_identity,
        source_revision=normalized.metadata.source_revision,
        segment_id=segment_id,
        timeline_start_ms=start_ms,
        timeline_end_ms=end_ms,
    )


def _transcript_atoms(
    normalized: NormalizedTranscript, config: ChunkingConfig, counter: TokenCounter
) -> tuple[_AtomicUnit, ...]:
    atoms: list[_AtomicUnit] = []
    for unit in normalized.units:
        prefix = f"{unit.speaker_label}: " if unit.speaker_label else ""
        pieces = _split_text(unit.text, prefix, config.max_tokens, counter)
        for part_index, part in enumerate(pieces):
            ref = _ref(
                normalized,
                segment_id=unit.segment_id,
                start_ms=unit.start_ms,
                end_ms=unit.end_ms,
            )
            evidence = EvidenceReference(
                evidence_type="TRANSCRIPT_SEGMENT",
                source_identity=normalized.metadata.source_identity,
                source_revision=normalized.metadata.source_revision,
                segment_id=unit.segment_id,
                timeline_start_ms=unit.start_ms,
                timeline_end_ms=unit.end_ms,
            )
            atoms.append(
                _AtomicUnit(
                    text=_render_speaker(unit.speaker_label, part),
                    source_reference=ref,
                    evidence_references=(evidence,),
                    label=unit.speaker_label,
                    cluster_id=unit.speaker_cluster_id,
                    user_id=unit.speaker_user_id,
                    display_name=unit.speaker_display_name,
                    start_ms=unit.start_ms,
                    end_ms=unit.end_ms,
                    unit_key=f"{unit.ordinal}:{part_index}",
                )
            )
    return tuple(atoms)


def _gap_exceeds(current: _AtomicUnit, incoming: _AtomicUnit, maximum: int) -> bool:
    return (
        current.end_ms is not None
        and incoming.start_ms is not None
        and incoming.start_ms - current.end_ms > maximum
    )


def _unique_speakers(atoms: Sequence[_AtomicUnit]):
    result = []
    seen: set[tuple[str | None, str | None]] = set()
    for atom in atoms:
        key = (atom.cluster_id, atom.label)
        if key == (None, None) or key in seen:
            continue
        seen.add(key)
        result.append({
            "clusterId": atom.cluster_id,
            "label": atom.label,
            "userId": atom.user_id,
            "displayName": atom.display_name,
        })
    return tuple(result)


def _timeline(refs: Sequence[CanonicalSourceReference]):
    timed = [(ref.timeline_start_ms, ref.timeline_end_ms) for ref in refs if ref.timeline_start_ms is not None]
    if not timed:
        return None, None
    return min(start for start, _ in timed), max(end for _, end in timed)


def _chunk_id(
    normalized: NormalizedSource,
    generation: IndexGeneration,
    position: int,
    retrieval_text: str,
    refs: Sequence[CanonicalSourceReference],
) -> str:
    payload = {
        "contractVersion": "1.0",
        "meetingId": normalized.metadata.source_identity.meeting_id,
        "sourceType": normalized.metadata.source_identity.source_type,
        "sourceId": normalized.metadata.source_identity.source_id,
        "sourceRevision": normalized.metadata.source_revision.model_dump(mode="json", by_alias=True),
        "indexGeneration": generation.model_dump(mode="json", by_alias=True),
        "position": position,
        "retrievalTextSha256": sha256(retrieval_text.encode("utf-8")).hexdigest(),
        "sourceReferences": [ref.model_dump(mode="json", by_alias=True) for ref in refs],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return str(UUID(hashlib.sha256(encoded).hexdigest()[:32]))


def _make_chunk(
    normalized: NormalizedSource,
    config: ChunkingConfig,
    counter: TokenCounter,
    position: int,
    texts: Sequence[str],
    refs: Sequence[CanonicalSourceReference],
    evidence: Sequence[EvidenceReference],
    atoms: Sequence[_AtomicUnit],
    *,
    action_status: str | None = None,
    assignee_user_id: str | None = None,
    due_date: str | None = None,
) -> KnowledgeChunk:
    retrieval_text = "\n".join(texts)
    token_count = _count(counter, retrieval_text)
    if token_count <= 0 or token_count > config.max_tokens:
        raise KnowledgeProcessingError("CHUNK_TOKEN_BUDGET_EXCEEDED")
    start_ms, end_ms = _timeline(refs)
    provenance = ChunkProvenance(
        snapshot_id=normalized.metadata.snapshot_id,
        meeting_id=normalized.metadata.source_identity.meeting_id,
        source_type=normalized.metadata.source_identity.source_type,
        source_identity=normalized.metadata.source_identity,
        source_revision=normalized.metadata.source_revision,
        index_generation_id=config.index_generation.generation_id,
        authority_class=normalized.metadata.authority_class,
        quality_class=normalized.metadata.quality_class,
        source_status=normalized.metadata.source_status,
        source_current=normalized.metadata.current,
        snapshot_sha256=normalized.metadata.snapshot_sha256,
        snapshot_size_bytes=normalized.metadata.snapshot_size_bytes,
        source_media_id=normalized.metadata.source_media_id,
        processing_job_id=normalized.metadata.processing_job_id,
        source_detail=normalized.metadata.source_detail,
        selection_epoch=normalized.metadata.selection_epoch,
        ai_warnings=normalized.metadata.ai_warnings,
        confirmed_by_user_id=normalized.metadata.confirmed_by_user_id,
        confirmed_at=normalized.metadata.confirmed_at,
        source_references=tuple(refs),
        evidence_references=tuple(evidence),
        timeline_start_ms=start_ms,
        timeline_end_ms=end_ms,
        speakers=_unique_speakers(atoms),
        action_status=action_status,
        assignee_user_id=assignee_user_id,
        due_date=due_date,
    )
    return KnowledgeChunk(
        contract_version="1.0",
        chunk_id=_chunk_id(normalized, config.index_generation, position, retrieval_text, refs),
        index_generation=config.index_generation,
        position=position,
        unit_count=len(atoms),
        display_text=retrieval_text,
        retrieval_text=retrieval_text,
        token_count=token_count,
        provenance=provenance,
    )


def _chunk_transcript(
    normalized: NormalizedTranscript, config: ChunkingConfig, counter: TokenCounter
) -> tuple[KnowledgeChunk, ...]:
    atoms = _transcript_atoms(normalized, config, counter)
    if not atoms:
        return ()
    target = config.target_tokens or config.max_tokens
    chunks: list[KnowledgeChunk] = []
    current: list[_AtomicUnit] = []

    def flush():
        if not current:
            return
        refs = tuple(atom.source_reference for atom in current)
        evidence = tuple(ref for atom in current for ref in atom.evidence_references)
        chunks.append(_make_chunk(
            normalized, config, counter, len(chunks), tuple(atom.text for atom in current),
            refs, evidence, tuple(current),
        ))
        current.clear()

    for atom in atoms:
        if current and (
            _gap_exceeds(current[-1], atom, config.max_temporal_gap_ms)
            or len(current) >= config.max_units_per_chunk
            or any(existing.source_reference.segment_id == atom.source_reference.segment_id for existing in current)
        ):
            flush()
        candidate = tuple(existing.text for existing in (*current, atom))
        candidate_count = _count(counter, "\n".join(candidate))
        if current and candidate_count > config.max_tokens:
            flush()
        if not current and _count(counter, atom.text) > config.max_tokens:
            raise KnowledgeProcessingError("SOURCE_UNIT_EXCEEDS_TOKEN_BUDGET")
        current.append(atom)
        if _count(counter, "\n".join(existing.text for existing in current)) >= target:
            flush()
    flush()
    return tuple(chunks)


def _structured_text(normalized: NormalizedSource):
    if isinstance(normalized, NormalizedDecision):
        return normalized.content, False, normalized.evidence_references, None, None, None
    if isinstance(normalized, NormalizedSummary):
        return normalized.content, True, (), None, None, None
    if isinstance(normalized, NormalizedActionItem):
        parts = [normalized.title]
        if normalized.details:
            parts.append(normalized.details)
        if normalized.due_date:
            parts.append(f"Due date: {normalized.due_date}")
        parts.append(f"Status: {normalized.status}")
        return "\n".join(parts), False, normalized.evidence_references, normalized.status, normalized.assignee_user_id, normalized.due_date
    raise KnowledgeProcessingError("UNSUPPORTED_SOURCE_TYPE")


def _chunk_structured(
    normalized: NormalizedSource, config: ChunkingConfig, counter: TokenCounter
) -> tuple[KnowledgeChunk, ...]:
    text, paragraphs, evidence, action_status, assignee, due_date = _structured_text(normalized)
    if not text:
        return ()
    parts = _split_document(text, config.max_tokens, counter, paragraphs=paragraphs)
    chunks: list[KnowledgeChunk] = []
    ref = _ref(normalized)
    for position, part in enumerate(parts):
        atom = _AtomicUnit(
            text=part,
            source_reference=ref,
            evidence_references=tuple(evidence),
            unit_key=str(position),
        )
        chunks.append(_make_chunk(
            normalized, config, counter, position, (part,), (ref,), evidence, (atom,),
            action_status=action_status, assignee_user_id=assignee, due_date=due_date,
        ))
    return tuple(chunks)


def chunk_normalized(
    normalized: NormalizedSource, *, token_counter: TokenCounter, config: ChunkingConfig
) -> tuple[KnowledgeChunk, ...]:
    """Chunk a normalized source using only the supplied counter."""

    if isinstance(normalized, NormalizedTranscript):
        return _chunk_transcript(normalized, config, token_counter)
    if isinstance(normalized, (NormalizedDecision, NormalizedSummary, NormalizedActionItem)):
        return _chunk_structured(normalized, config, token_counter)
    raise KnowledgeProcessingError("UNSUPPORTED_SOURCE_TYPE")


def process_snapshot(
    value: KnowledgeSnapshot | object, *, token_counter: TokenCounter, config: ChunkingConfig
) -> ProcessingResult:
    """Run the complete canonical-source processing boundary."""

    normalization = normalize_snapshot(value)
    if normalization.status == "INVALID":
        return ProcessingResult(
            contract_version="1.0",
            status=ProcessingStatus.INVALID,
            issues=normalization.issues,
        )
    if normalization.status == "UNSUPPORTED":
        return ProcessingResult(
            contract_version="1.0",
            status=ProcessingStatus.UNSUPPORTED,
            issues=normalization.issues,
        )
    if normalization.status == "INELIGIBLE":
        return ProcessingResult(
            contract_version="1.0",
            status=ProcessingStatus.INELIGIBLE,
            issues=normalization.issues,
        )
    if normalization.normalized is None:
        return ProcessingResult(
            contract_version="1.0",
            status=ProcessingStatus.NO_ELIGIBLE_CONTENT,
            issues=normalization.issues,
        )
    if normalization.status == "NO_ELIGIBLE_CONTENT":
        return ProcessingResult(
            contract_version="1.0",
            status=ProcessingStatus.NO_ELIGIBLE_CONTENT,
            normalized=normalization.normalized,
            issues=normalization.issues,
        )

    try:
        chunks = chunk_normalized(normalization.normalized, token_counter=token_counter, config=config)
    except KnowledgeProcessingError as error:
        return ProcessingResult(
            contract_version="1.0",
            status=ProcessingStatus.UNPROCESSABLE,
            normalized=normalization.normalized,
            issues=(*normalization.issues, _issue(error.code, "ERROR")),
        )
    except ValidationError:
        return ProcessingResult(
            contract_version="1.0",
            status=ProcessingStatus.UNPROCESSABLE,
            normalized=normalization.normalized,
            issues=(*normalization.issues, _issue("CHUNK_CONTRACT_INVALID", "ERROR")),
        )
    status = ProcessingStatus.PROCESSED if chunks else ProcessingStatus.NO_ELIGIBLE_CONTENT
    return ProcessingResult(
        contract_version="1.0",
        status=status,
        normalized=normalization.normalized,
        chunks=chunks,
        issues=normalization.issues,
    )
