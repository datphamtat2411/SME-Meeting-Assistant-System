"""Versioned, provider-neutral contracts for RAG knowledge processing.

The models in this module are the boundary between Core-owned canonical
projections and AI-owned derived chunks.  They deliberately contain no model,
vector-store, transport, or job-lifecycle state.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from enum import Enum
from typing import Annotated, Literal, TypeAlias
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    model_validator,
)

CONTRACT_VERSION = "1.0"
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_TRANSCRIPT_SEGMENTS = 100_000
MAX_SOURCE_TEXT = 100_000
_IDENTIFIER = r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}"


def _uuid(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Invalid UUID")
    try:
        return str(UUID(value))
    except (ValueError, AttributeError, TypeError):
        raise ValueError("Invalid UUID") from None


def _timestamp(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})",
        value,
    ):
        raise ValueError("Invalid timestamp")
    try:
        if datetime.fromisoformat(value).utcoffset() is None:
            raise ValueError
    except (ValueError, TypeError, OverflowError):
        raise ValueError("Invalid timestamp") from None
    return value


def _date(value: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) is None:
        raise ValueError("Invalid date")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d").date()
    except (ValueError, TypeError, OverflowError):
        raise ValueError("Invalid date") from None
    if parsed.isoformat() != value:
        raise ValueError("Invalid date")
    return value


def _text(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Invalid text")
    for char in value:
        if ord(char) >= 0xD800 and ord(char) <= 0xDFFF:
            raise ValueError("Invalid text")
        if unicodedata.category(char) in {"Cc", "Cf", "Cs"} and char not in "\r\n\t":
            raise ValueError("Invalid text")
    value.encode("utf-8", errors="strict")
    return value


def _identifier(value: str) -> str:
    if not isinstance(value, str) or re.fullmatch(_IDENTIFIER, value) is None:
        raise ValueError("Invalid identifier")
    return value


Uuid = Annotated[str, AfterValidator(_uuid)]
Timestamp = Annotated[str, AfterValidator(_timestamp)]
DateValue = Annotated[str, AfterValidator(_date)]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Identifier = Annotated[str, AfterValidator(_identifier)]
SafeText = Annotated[str, AfterValidator(_text)]


class StrictModel(BaseModel):
    """Frozen strict models with aliases matching Core's JSON projections."""

    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        frozen=True,
        hide_input_in_errors=True,
        populate_by_name=True,
    )


SourceType = Literal["TRANSCRIPT", "DECISION", "SUMMARY", "ACTION_ITEM"]
AuthorityClass = Literal[
    "PRIMARY_TRANSCRIPT",
    "CONFIRMED_DECISION",
    "OFFICIAL_ACTION_ITEM",
    "SECONDARY_APPROVED_SUMMARY",
]
QualityClass = Literal["ACCEPTED", "WARNING", "MIXED"]


class SourceRevision(StrictModel):
    """Canonical source revision, intentionally separate from index generation."""

    number: int = Field(ge=0)
    content_sha256: Digest | None = Field(default=None, alias="contentSha256")


class CanonicalSourceIdentity(StrictModel):
    source_type: SourceType = Field(alias="sourceType")
    source_id: Uuid = Field(alias="sourceId")
    meeting_id: Uuid = Field(alias="meetingId")


class SnapshotIntegrity(StrictModel):
    sha256: Digest
    size_bytes: int = Field(gt=0, le=MAX_SNAPSHOT_BYTES, alias="sizeBytes")


class SnapshotMetadata(StrictModel):
    snapshot_id: Uuid = Field(alias="snapshotId")
    meeting_id: Uuid = Field(alias="meetingId")
    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    source_revision: SourceRevision = Field(alias="sourceRevision")
    integrity: SnapshotIntegrity | None = None

    @model_validator(mode="after")
    def identity_matches(self):
        if self.meeting_id != self.source_identity.meeting_id:
            raise ValueError("Snapshot meeting identity mismatch")
        return self


TranscriptStatus = Literal[
    "READY",
    "READY_WITH_WARNINGS",
    "DRAFT",
    "PROCESSING",
    "FAILED",
    "SUPERSEDED",
    "DELETED",
]
TranscriptRepresentation = Literal["RECONCILED", "RAW_ASR", "CORRECTED_CANDIDATE"]
TranscriptQuality = Literal["ACCEPTED", "SUSPICIOUS", "UNRESOLVED"]


class TranscriptSegment(StrictModel):
    id: Uuid
    ordinal: int = Field(ge=0)
    start_ms: int | None = Field(default=None, ge=0, alias="startMs")
    end_ms: int | None = Field(default=None, ge=0, alias="endMs")
    text: SafeText = Field(max_length=MAX_SOURCE_TEXT)
    quality_status: TranscriptQuality | None = Field(default=None, alias="qualityStatus")
    speaker_cluster_id: Uuid | None = Field(default=None, alias="speakerClusterId")
    speaker_label: SafeText | None = Field(default=None, max_length=160, alias="speakerLabel")
    version: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def valid_timeline(self):
        if (self.start_ms is None) != (self.end_ms is None):
            raise ValueError("Segment timing must be complete or absent")
        if self.start_ms is not None and self.end_ms is not None and self.end_ms <= self.start_ms:
            raise ValueError("Segment timing is not chronological")
        return self


class TranscriptSpeaker(StrictModel):
    id: Uuid
    label: SafeText = Field(max_length=160)
    user_id: Uuid | None = Field(default=None, alias="userId")
    display_name: SafeText | None = Field(default=None, max_length=255, alias="displayName")


CoverageStatus = Literal["COVERED", "SUSPICIOUS", "UNRESOLVED_ERROR"]


class TranscriptCoverage(StrictModel):
    id: Uuid
    start_ms: int = Field(ge=0, alias="startMs")
    end_ms: int = Field(gt=0, alias="endMs")
    coverage_status: CoverageStatus = Field(alias="coverageStatus")
    recovered: bool
    retry_count: int = Field(ge=0, alias="retryCount")

    @model_validator(mode="after")
    def valid_timeline(self):
        if self.end_ms <= self.start_ms:
            raise ValueError("Coverage timing is not chronological")
        return self


class TranscriptProjection(StrictModel):
    """The `transcript` object from Core's existing snapshot projection."""

    id: Uuid
    meeting_id: Uuid = Field(alias="meetingId")
    source_media_id: Uuid = Field(alias="sourceMediaId")
    processing_job_id: Uuid = Field(alias="processingJobId")
    version_number: int = Field(ge=0, alias="versionNumber")
    language_code: SafeText = Field(min_length=1, max_length=16, alias="languageCode")
    status: TranscriptStatus
    duration_ms: int | None = Field(default=None, gt=0, alias="durationMs")
    finalized_at: Timestamp | None = Field(default=None, alias="finalizedAt")
    content_revision: int = Field(ge=0, alias="contentRevision")
    segments: tuple[TranscriptSegment, ...] = Field(max_length=MAX_TRANSCRIPT_SEGMENTS)


class TranscriptPayload(StrictModel):
    """Existing immutable payload: schemaVersion/transcript/coverage/speakers."""

    schema_version: Literal["1.0"] = Field(alias="schemaVersion")
    transcript: TranscriptProjection
    coverage: tuple[TranscriptCoverage, ...] = Field(max_length=MAX_TRANSCRIPT_SEGMENTS)
    speakers: tuple[TranscriptSpeaker, ...] = Field(max_length=MAX_TRANSCRIPT_SEGMENTS)

    @model_validator(mode="after")
    def validate_projection(self):
        transcript = self.transcript
        if transcript.segments:
            previous_ordinal = -1
            previous_start = -1
            seen_segments: set[str] = set()
            for segment in transcript.segments:
                if segment.id in seen_segments or segment.ordinal <= previous_ordinal:
                    raise ValueError("Transcript segments are not uniquely ordered")
                seen_segments.add(segment.id)
                previous_ordinal = segment.ordinal
                if segment.start_ms is not None:
                    if segment.start_ms < previous_start:
                        raise ValueError("Transcript segments are not chronologically ordered")
                    previous_start = segment.start_ms
                    if transcript.duration_ms is not None and segment.end_ms > transcript.duration_ms:
                        raise ValueError("Segment exceeds transcript duration")
            if transcript.duration_ms is not None and any(
                segment.end_ms is not None and segment.end_ms > transcript.duration_ms
                for segment in transcript.segments
            ):
                raise ValueError("Segment exceeds transcript duration")

        speaker_ids: set[str] = set()
        speaker_labels: dict[str, str] = {}
        for speaker in self.speakers:
            if speaker.id in speaker_ids or speaker.label in speaker_labels.values():
                raise ValueError("Transcript speakers are not unique")
            speaker_ids.add(speaker.id)
            speaker_labels[speaker.id] = speaker.label
        for segment in transcript.segments:
            if segment.speaker_cluster_id is not None and speaker_ids:
                if segment.speaker_cluster_id not in speaker_labels:
                    raise ValueError("Unknown transcript speaker cluster")
                if segment.speaker_label is not None and segment.speaker_label != speaker_labels[segment.speaker_cluster_id]:
                    raise ValueError("Transcript speaker label mismatch")

        previous_coverage_start = -1
        seen_coverage: set[str] = set()
        for region in self.coverage:
            if region.id in seen_coverage or region.start_ms < previous_coverage_start:
                raise ValueError("Transcript coverage is not uniquely ordered")
            seen_coverage.add(region.id)
            previous_coverage_start = region.start_ms
            if transcript.duration_ms is not None and region.end_ms > transcript.duration_ms:
                raise ValueError("Coverage exceeds transcript duration")
        return self


class TranscriptSnapshot(StrictModel):
    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    snapshot_type: Literal["TRANSCRIPT"] = Field(alias="snapshotType")
    metadata: SnapshotMetadata
    current: bool
    representation: TranscriptRepresentation
    payload: TranscriptPayload

    @model_validator(mode="after")
    def validate_binding(self):
        identity = self.metadata.source_identity
        transcript = self.payload.transcript
        if identity.source_type != "TRANSCRIPT" or identity.source_id != transcript.id:
            raise ValueError("Transcript source identity mismatch")
        if identity.meeting_id != transcript.meeting_id or self.metadata.meeting_id != transcript.meeting_id:
            raise ValueError("Transcript meeting identity mismatch")
        if self.metadata.source_revision.number != transcript.content_revision:
            raise ValueError("Transcript source revision mismatch")
        return self


DecisionStatus = Literal["PROPOSED", "CONFIRMED", "REJECTED"]
AiUncertainty = Literal["NONE", "LOW", "MATERIAL"]


class DecisionProjection(StrictModel):
    id: Uuid
    meeting_id: Uuid = Field(alias="meetingId")
    content: SafeText = Field(max_length=MAX_SOURCE_TEXT)
    status: DecisionStatus
    source_type: Identifier = Field(alias="sourceType", max_length=64)
    evidence_segment_ids: tuple[Uuid, ...] = Field(default=(), max_length=50, alias="evidenceSegmentIds")
    transcript_id: Uuid | None = Field(default=None, alias="transcriptId")
    transcript_revision: SourceRevision | None = Field(default=None, alias="transcriptRevision")
    content_revision: int | None = Field(default=None, ge=0, alias="contentRevision")
    version: int = Field(ge=0)
    is_stale: bool = Field(default=False, alias="isStale")
    confirmed_by_user_id: Uuid | None = Field(default=None, alias="confirmedByUserId")
    confirmed_at: Timestamp | None = Field(default=None, alias="confirmedAt")
    ai_uncertainty: AiUncertainty | None = Field(default=None, alias="aiUncertainty")
    ai_warnings: tuple[Identifier, ...] = Field(default=(), max_length=32, alias="aiWarnings")

    @model_validator(mode="after")
    def validate_evidence(self):
        if len(set(self.evidence_segment_ids)) != len(self.evidence_segment_ids):
            raise ValueError("Decision evidence is not unique")
        if self.evidence_segment_ids and (self.transcript_id is None):
            raise ValueError("Decision evidence requires a transcript")
        if self.transcript_revision is not None and self.content_revision is not None:
            if self.transcript_revision.number != self.content_revision:
                raise ValueError("Decision transcript revision mismatch")
        return self


class DecisionSnapshot(StrictModel):
    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    snapshot_type: Literal["DECISION"] = Field(alias="snapshotType")
    metadata: SnapshotMetadata
    content: DecisionProjection

    @model_validator(mode="after")
    def validate_binding(self):
        identity = self.metadata.source_identity
        if identity.source_type != "DECISION" or identity.source_id != self.content.id:
            raise ValueError("Decision source identity mismatch")
        if identity.meeting_id != self.content.meeting_id or self.metadata.meeting_id != self.content.meeting_id:
            raise ValueError("Decision meeting identity mismatch")
        if self.metadata.source_revision.number != self.content.version:
            raise ValueError("Decision source revision mismatch")
        return self


SummaryQuality = Literal["READY", "READY_WITH_WARNINGS"]


class SummaryProjection(StrictModel):
    id: Uuid
    meeting_id: Uuid = Field(alias="meetingId")
    version_number: int = Field(ge=0, alias="versionNumber")
    content: SafeText = Field(max_length=MAX_SOURCE_TEXT)
    source_type: Identifier = Field(alias="sourceType", max_length=64)
    quality_status: SummaryQuality = Field(alias="qualityStatus")
    is_current: bool = Field(alias="isCurrent")
    is_approved: bool = Field(alias="isApproved")
    is_stale: bool = Field(alias="isStale")
    processing_job_id: Uuid | None = Field(default=None, alias="processingJobId")
    transcript_id: Uuid | None = Field(default=None, alias="transcriptId")
    transcript_revision: SourceRevision | None = Field(default=None, alias="transcriptRevision")
    content_revision: int | None = Field(default=None, ge=0, alias="contentRevision")
    selection_epoch: int = Field(default=0, ge=0, alias="selectionEpoch")
    ai_warnings: tuple[Identifier, ...] = Field(default=(), max_length=32, alias="aiWarnings")

    @model_validator(mode="after")
    def validate_transcript_revision(self):
        if self.transcript_revision is not None and self.content_revision is not None:
            if self.transcript_revision.number != self.content_revision:
                raise ValueError("Summary transcript revision mismatch")
        return self


class SummarySnapshot(StrictModel):
    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    snapshot_type: Literal["SUMMARY"] = Field(alias="snapshotType")
    metadata: SnapshotMetadata
    content: SummaryProjection

    @model_validator(mode="after")
    def validate_binding(self):
        identity = self.metadata.source_identity
        if identity.source_type != "SUMMARY" or identity.source_id != self.content.id:
            raise ValueError("Summary source identity mismatch")
        if identity.meeting_id != self.content.meeting_id or self.metadata.meeting_id != self.content.meeting_id:
            raise ValueError("Summary meeting identity mismatch")
        if self.metadata.source_revision.number != self.content.version_number:
            raise ValueError("Summary source revision mismatch")
        return self


ActionStatus = Literal["PROPOSED", "OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]
ActionSourceType = Literal["MANUAL", "AI_EXTRACTED"]


class ActionItemProjection(StrictModel):
    id: Uuid
    meeting_id: Uuid = Field(alias="meetingId")
    title: SafeText = Field(max_length=500)
    details: SafeText | None = Field(default=None, max_length=MAX_SOURCE_TEXT)
    status: ActionStatus
    source_type: ActionSourceType = Field(alias="sourceType")
    is_official: bool = Field(alias="isOfficial")
    assignee_user_id: Uuid | None = Field(default=None, alias="assigneeUserId")
    due_date: DateValue | None = Field(default=None, alias="dueDate")
    version: int = Field(ge=0)
    confirmed_by_user_id: Uuid | None = Field(default=None, alias="confirmedByUserId")
    confirmed_at: Timestamp | None = Field(default=None, alias="confirmedAt")
    transcript_id: Uuid | None = Field(default=None, alias="transcriptId")
    transcript_revision: SourceRevision | None = Field(default=None, alias="transcriptRevision")
    content_revision: int | None = Field(default=None, ge=0, alias="contentRevision")
    evidence_segment_ids: tuple[Uuid, ...] = Field(default=(), max_length=50, alias="evidenceSegmentIds")

    @model_validator(mode="after")
    def validate_authority_state(self):
        if self.status == "PROPOSED" and self.is_official:
            raise ValueError("Proposed action item cannot be official")
        if self.is_official and self.status in {"OPEN", "IN_PROGRESS"} and self.assignee_user_id is None:
            raise ValueError("Official active action item requires an assignee")
        if len(set(self.evidence_segment_ids)) != len(self.evidence_segment_ids):
            raise ValueError("Action item evidence is not unique")
        if self.evidence_segment_ids and self.transcript_id is None:
            raise ValueError("Action item evidence requires a transcript")
        if self.transcript_revision is not None and self.content_revision is not None:
            if self.transcript_revision.number != self.content_revision:
                raise ValueError("Action item transcript revision mismatch")
        return self


class ActionItemSnapshot(StrictModel):
    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    snapshot_type: Literal["ACTION_ITEM"] = Field(alias="snapshotType")
    metadata: SnapshotMetadata
    content: ActionItemProjection

    @model_validator(mode="after")
    def validate_binding(self):
        identity = self.metadata.source_identity
        if identity.source_type != "ACTION_ITEM" or identity.source_id != self.content.id:
            raise ValueError("Action item source identity mismatch")
        if identity.meeting_id != self.content.meeting_id or self.metadata.meeting_id != self.content.meeting_id:
            raise ValueError("Action item meeting identity mismatch")
        if self.metadata.source_revision.number != self.content.version:
            raise ValueError("Action item source revision mismatch")
        return self


KnowledgeSnapshot: TypeAlias = Annotated[
    TranscriptSnapshot | DecisionSnapshot | SummarySnapshot | ActionItemSnapshot,
    Field(discriminator="snapshot_type"),
]
_KNOWLEDGE_SNAPSHOT_ADAPTER = TypeAdapter(KnowledgeSnapshot)


class NormalizedMetadata(StrictModel):
    snapshot_id: Uuid = Field(alias="snapshotId")
    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    source_revision: SourceRevision = Field(alias="sourceRevision")
    authority_class: AuthorityClass = Field(alias="authorityClass")
    quality_class: QualityClass = Field(alias="qualityClass")
    source_status: Identifier = Field(alias="sourceStatus", max_length=64)
    current: bool
    snapshot_sha256: Digest | None = Field(default=None, alias="snapshotSha256")
    snapshot_size_bytes: int | None = Field(default=None, gt=0, le=MAX_SNAPSHOT_BYTES, alias="snapshotSizeBytes")
    source_media_id: Uuid | None = Field(default=None, alias="sourceMediaId")
    processing_job_id: Uuid | None = Field(default=None, alias="processingJobId")
    source_detail: Identifier | None = Field(default=None, alias="sourceDetail", max_length=64)
    selection_epoch: int | None = Field(default=None, ge=0, alias="selectionEpoch")
    ai_warnings: tuple[Identifier, ...] = Field(default=(), alias="aiWarnings")
    confirmed_by_user_id: Uuid | None = Field(default=None, alias="confirmedByUserId")
    confirmed_at: Timestamp | None = Field(default=None, alias="confirmedAt")


class NormalizedTranscriptUnit(StrictModel):
    segment_id: Uuid = Field(alias="segmentId")
    ordinal: int = Field(ge=0)
    text: SafeText = Field(max_length=MAX_SOURCE_TEXT)
    start_ms: int | None = Field(default=None, ge=0, alias="startMs")
    end_ms: int | None = Field(default=None, gt=0, alias="endMs")
    speaker_cluster_id: Uuid | None = Field(default=None, alias="speakerClusterId")
    speaker_label: SafeText | None = Field(default=None, max_length=160, alias="speakerLabel")
    speaker_user_id: Uuid | None = Field(default=None, alias="speakerUserId")
    speaker_display_name: SafeText | None = Field(default=None, max_length=255, alias="speakerDisplayName")
    segment_version: int | None = Field(default=None, ge=0, alias="segmentVersion")


class NormalizedTranscript(StrictModel):
    source_type: Literal["TRANSCRIPT"] = Field(alias="sourceType")
    metadata: NormalizedMetadata
    language_code: SafeText = Field(alias="languageCode", max_length=16)
    duration_ms: int | None = Field(default=None, gt=0, alias="durationMs")
    units: tuple[NormalizedTranscriptUnit, ...]
    excluded_segment_ids: tuple[Uuid, ...] = Field(default=(), alias="excludedSegmentIds")


class NormalizedDecision(StrictModel):
    source_type: Literal["DECISION"] = Field(alias="sourceType")
    metadata: NormalizedMetadata
    content: SafeText = Field(max_length=MAX_SOURCE_TEXT)
    status: Literal["CONFIRMED"]
    version: int = Field(ge=0)
    evidence_references: tuple["EvidenceReference", ...] = Field(default=(), alias="evidenceReferences")
    transcript_id: Uuid | None = Field(default=None, alias="transcriptId")
    transcript_revision: SourceRevision | None = Field(default=None, alias="transcriptRevision")
    ai_warnings: tuple[Identifier, ...] = Field(default=(), alias="aiWarnings")


class NormalizedSummary(StrictModel):
    source_type: Literal["SUMMARY"] = Field(alias="sourceType")
    metadata: NormalizedMetadata
    content: SafeText = Field(max_length=MAX_SOURCE_TEXT)
    version: int = Field(ge=0)
    source_type_detail: Identifier = Field(alias="sourceTypeDetail", max_length=64)
    transcript_id: Uuid | None = Field(default=None, alias="transcriptId")
    transcript_revision: SourceRevision | None = Field(default=None, alias="transcriptRevision")
    ai_warnings: tuple[Identifier, ...] = Field(default=(), alias="aiWarnings")


class NormalizedActionItem(StrictModel):
    source_type: Literal["ACTION_ITEM"] = Field(alias="sourceType")
    metadata: NormalizedMetadata
    title: SafeText = Field(max_length=500)
    details: SafeText | None = Field(default=None, max_length=MAX_SOURCE_TEXT)
    status: Literal["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]
    version: int = Field(ge=0)
    assignee_user_id: Uuid | None = Field(default=None, alias="assigneeUserId")
    due_date: DateValue | None = Field(default=None, alias="dueDate")
    transcript_id: Uuid | None = Field(default=None, alias="transcriptId")
    transcript_revision: SourceRevision | None = Field(default=None, alias="transcriptRevision")
    evidence_references: tuple["EvidenceReference", ...] = Field(default=(), alias="evidenceReferences")


NormalizedSource: TypeAlias = Annotated[
    NormalizedTranscript | NormalizedDecision | NormalizedSummary | NormalizedActionItem,
    Field(discriminator="source_type"),
]


class CanonicalSourceReference(StrictModel):
    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    source_revision: SourceRevision = Field(alias="sourceRevision")
    segment_id: Uuid | None = Field(default=None, alias="segmentId")
    timeline_start_ms: int | None = Field(default=None, ge=0, alias="timelineStartMs")
    timeline_end_ms: int | None = Field(default=None, gt=0, alias="timelineEndMs")

    @model_validator(mode="after")
    def valid_reference(self):
        if (self.timeline_start_ms is None) != (self.timeline_end_ms is None):
            raise ValueError("Incomplete source timeline")
        if self.timeline_start_ms is not None and self.timeline_end_ms <= self.timeline_start_ms:
            raise ValueError("Invalid source timeline")
        if self.segment_id is not None and self.source_identity.source_type != "TRANSCRIPT":
            raise ValueError("Only transcript sources have segment references")
        return self


class EvidenceReference(StrictModel):
    evidence_type: Literal["TRANSCRIPT_SEGMENT"] = Field(alias="evidenceType")
    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    source_revision: SourceRevision | None = Field(default=None, alias="sourceRevision")
    segment_id: Uuid = Field(alias="segmentId")
    timeline_start_ms: int | None = Field(default=None, ge=0, alias="timelineStartMs")
    timeline_end_ms: int | None = Field(default=None, gt=0, alias="timelineEndMs")

    @model_validator(mode="after")
    def valid_reference(self):
        if self.source_identity.source_type != "TRANSCRIPT":
            raise ValueError("Evidence must refer to a transcript")
        if (self.timeline_start_ms is None) != (self.timeline_end_ms is None):
            raise ValueError("Incomplete evidence timeline")
        if self.timeline_start_ms is not None and self.timeline_end_ms <= self.timeline_start_ms:
            raise ValueError("Invalid evidence timeline")
        return self


class SpeakerAttribution(StrictModel):
    cluster_id: Uuid | None = Field(default=None, alias="clusterId")
    label: SafeText | None = Field(default=None, max_length=160)
    user_id: Uuid | None = Field(default=None, alias="userId")
    display_name: SafeText | None = Field(default=None, max_length=255, alias="displayName")


class ChunkProvenance(StrictModel):
    snapshot_id: Uuid = Field(alias="snapshotId")
    meeting_id: Uuid = Field(alias="meetingId")
    source_type: SourceType = Field(alias="sourceType")
    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    source_revision: SourceRevision = Field(alias="sourceRevision")
    index_generation_id: Identifier = Field(alias="indexGenerationId")
    authority_class: AuthorityClass = Field(alias="authorityClass")
    quality_class: QualityClass = Field(alias="qualityClass")
    source_status: Identifier = Field(alias="sourceStatus", max_length=64)
    source_current: bool = Field(alias="sourceCurrent")
    snapshot_sha256: Digest | None = Field(default=None, alias="snapshotSha256")
    snapshot_size_bytes: int | None = Field(default=None, gt=0, le=MAX_SNAPSHOT_BYTES, alias="snapshotSizeBytes")
    source_media_id: Uuid | None = Field(default=None, alias="sourceMediaId")
    processing_job_id: Uuid | None = Field(default=None, alias="processingJobId")
    source_detail: Identifier | None = Field(default=None, alias="sourceDetail", max_length=64)
    selection_epoch: int | None = Field(default=None, ge=0, alias="selectionEpoch")
    ai_warnings: tuple[Identifier, ...] = Field(default=(), alias="aiWarnings")
    confirmed_by_user_id: Uuid | None = Field(default=None, alias="confirmedByUserId")
    confirmed_at: Timestamp | None = Field(default=None, alias="confirmedAt")
    source_references: tuple[CanonicalSourceReference, ...] = Field(min_length=1, alias="sourceReferences")
    evidence_references: tuple[EvidenceReference, ...] = Field(default=(), alias="evidenceReferences")
    timeline_start_ms: int | None = Field(default=None, ge=0, alias="timelineStartMs")
    timeline_end_ms: int | None = Field(default=None, gt=0, alias="timelineEndMs")
    speakers: tuple[SpeakerAttribution, ...] = ()
    action_status: str | None = Field(default=None, alias="actionStatus")
    assignee_user_id: Uuid | None = Field(default=None, alias="assigneeUserId")
    due_date: DateValue | None = Field(default=None, alias="dueDate")

    @model_validator(mode="after")
    def valid_provenance(self):
        identity = self.source_identity
        if self.meeting_id != identity.meeting_id or identity.source_type != self.source_type:
            raise ValueError("Chunk provenance identity mismatch")
        if (self.timeline_start_ms is None) != (self.timeline_end_ms is None):
            raise ValueError("Incomplete chunk timeline")
        if self.timeline_start_ms is not None and self.timeline_end_ms <= self.timeline_start_ms:
            raise ValueError("Invalid chunk timeline")
        for reference in self.source_references:
            if reference.source_identity != identity or reference.source_revision != self.source_revision:
                raise ValueError("Chunk source reference mismatch")
        for reference in self.evidence_references:
            if reference.source_identity.meeting_id != self.meeting_id:
                raise ValueError("Chunk evidence meeting mismatch")
        timed = [
            (reference.timeline_start_ms, reference.timeline_end_ms)
            for reference in self.source_references
            if reference.timeline_start_ms is not None
        ]
        if timed:
            if self.timeline_start_ms != min(start for start, _ in timed):
                raise ValueError("Chunk timeline start mismatch")
            if self.timeline_end_ms != max(end for _, end in timed):
                raise ValueError("Chunk timeline end mismatch")
        elif self.timeline_start_ms is not None or self.timeline_end_ms is not None:
            raise ValueError("Chunk timeline exists without source timing")
        return self


class IndexGeneration(StrictModel):
    """Chunking/representation generation; not a source revision or model ID."""

    generation_id: Identifier = Field(alias="generationId")
    configuration_version: Identifier = Field(alias="configurationVersion")
    configuration_sha256: Digest = Field(alias="configurationSha256")
    tokenizer_id: Identifier = Field(alias="tokenizerId")


class KnowledgeChunk(StrictModel):
    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    chunk_id: Identifier = Field(alias="chunkId")
    index_generation: IndexGeneration = Field(alias="indexGeneration")
    position: int = Field(ge=0)
    unit_count: int = Field(gt=0, alias="unitCount")
    display_text: SafeText = Field(min_length=1, max_length=MAX_SOURCE_TEXT, alias="displayText")
    retrieval_text: SafeText = Field(min_length=1, max_length=MAX_SOURCE_TEXT, alias="retrievalText")
    token_count: int = Field(gt=0, alias="tokenCount")
    provenance: ChunkProvenance


class ProcessingStatus(str, Enum):
    PROCESSED = "PROCESSED"
    NO_ELIGIBLE_CONTENT = "NO_ELIGIBLE_CONTENT"
    INELIGIBLE = "INELIGIBLE"
    INVALID = "INVALID"
    UNSUPPORTED = "UNSUPPORTED"
    UNPROCESSABLE = "UNPROCESSABLE"


class ProcessingIssue(StrictModel):
    code: Identifier
    severity: Literal["INFO", "WARNING", "ERROR"]
    source_id: Uuid | None = Field(default=None, alias="sourceId")
    segment_id: Uuid | None = Field(default=None, alias="segmentId")


class EligibilityResult(StrictModel):
    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    eligible: bool
    authority_class: AuthorityClass | None = Field(default=None, alias="authorityClass")
    quality_class: QualityClass | None = Field(default=None, alias="qualityClass")
    reasons: tuple[ProcessingIssue, ...] = ()


class ProcessingResult(StrictModel):
    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    status: ProcessingStatus
    normalized: NormalizedSource | None = None
    chunks: tuple[KnowledgeChunk, ...] = ()
    issues: tuple[ProcessingIssue, ...] = ()


class NormalizationResult(StrictModel):
    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    status: Literal["NORMALIZED", "NO_ELIGIBLE_CONTENT", "INELIGIBLE", "INVALID", "UNSUPPORTED"]
    normalized: NormalizedSource | None = None
    issues: tuple[ProcessingIssue, ...] = ()


class ChunkingConfig(StrictModel):
    max_tokens: int = Field(gt=0, le=32_768, alias="maxTokens")
    target_tokens: int | None = Field(default=None, gt=0, alias="targetTokens")
    max_temporal_gap_ms: int = Field(ge=0, le=3_600_000, alias="maxTemporalGapMs")
    max_units_per_chunk: int = Field(gt=0, le=256, alias="maxUnitsPerChunk")
    index_generation: IndexGeneration = Field(alias="indexGeneration")

    @model_validator(mode="after")
    def valid_targets(self):
        if self.target_tokens is not None and self.target_tokens > self.max_tokens:
            raise ValueError("Target token budget exceeds maximum")
        return self


class RetrievalFilters(StrictModel):
    """User-controlled narrowing filters; never an authorization grant."""

    meeting_ids: tuple[Uuid, ...] = Field(default=(), max_length=10_000, alias="meetingIds")
    source_ids: tuple[Uuid, ...] = Field(default=(), max_length=50_000, alias="sourceIds")
    source_types: tuple[SourceType, ...] = Field(default=(), max_length=4, alias="sourceTypes")

    @model_validator(mode="after")
    def unique_filters(self):
        if len(set(self.meeting_ids)) != len(self.meeting_ids):
            raise ValueError("Duplicate meeting filter")
        if len(set(self.source_ids)) != len(self.source_ids):
            raise ValueError("Duplicate source filter")
        if len(set(self.source_types)) != len(self.source_types):
            raise ValueError("Duplicate source type filter")
        return self


class AuthorizedRetrievalScope(StrictModel):
    """Core-approved scope. Empty allowed IDs always mean no retrieval."""

    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    scope_id: Uuid = Field(alias="scopeId")
    principal_id: Uuid = Field(alias="principalId")
    scope_version: Identifier = Field(alias="scopeVersion")
    issued_at: Timestamp = Field(alias="issuedAt")
    expires_at: Timestamp = Field(alias="expiresAt")
    authority: Literal["CORE_APPROVED"] = "CORE_APPROVED"
    allowed_meeting_ids: tuple[Uuid, ...] = Field(max_length=10_000, alias="allowedMeetingIds")
    allowed_source_ids: tuple[Uuid, ...] = Field(default=(), max_length=50_000, alias="allowedSourceIds")
    allowed_source_types: tuple[SourceType, ...] = Field(default=(), max_length=4, alias="allowedSourceTypes")

    @model_validator(mode="after")
    def validate_scope(self):
        if datetime.fromisoformat(self.expires_at.replace("Z", "+00:00")) <= datetime.fromisoformat(
            self.issued_at.replace("Z", "+00:00")
        ):
            raise ValueError("Retrieval scope expiry must be after issue time")
        if len(set(self.allowed_meeting_ids)) != len(self.allowed_meeting_ids):
            raise ValueError("Duplicate authorized meeting")
        if len(set(self.allowed_source_ids)) != len(self.allowed_source_ids):
            raise ValueError("Duplicate authorized source")
        if len(set(self.allowed_source_types)) != len(self.allowed_source_types):
            raise ValueError("Duplicate authorized source type")
        return self

    def effective_meeting_ids(self, filters: RetrievalFilters | None = None) -> tuple[str, ...]:
        if not self.allowed_meeting_ids:
            return ()
        if filters is None or not filters.meeting_ids:
            return self.allowed_meeting_ids
        requested = set(filters.meeting_ids)
        return tuple(meeting_id for meeting_id in self.allowed_meeting_ids if meeting_id in requested)


class RetrievalScopeRequest(StrictModel):
    """Future retrieval input with authority and client narrowing separated."""

    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    authorized_scope: AuthorizedRetrievalScope = Field(alias="authorizedScope")
    user_filters: RetrievalFilters = Field(default_factory=RetrievalFilters, alias="userFilters")

    @property
    def effective_meeting_ids(self) -> tuple[str, ...]:
        return self.authorized_scope.effective_meeting_ids(self.user_filters)


class ImmutableSnapshotReference(StrictModel):
    snapshot_id: Uuid = Field(alias="snapshotId")
    sha256: Digest
    size_bytes: int = Field(gt=0, le=MAX_SNAPSHOT_BYTES, alias="sizeBytes")


class IndexLifecycleEvent(StrictModel):
    """Small logical event; canonical content is always fetched by reference."""

    contract_version: Literal["1.0"] = Field(alias="contractVersion")
    event_id: Uuid = Field(alias="eventId")
    occurred_at: Timestamp = Field(alias="occurredAt")
    meeting_id: Uuid = Field(alias="meetingId")
    source_identity: CanonicalSourceIdentity = Field(alias="sourceIdentity")
    source_revision: SourceRevision = Field(alias="sourceRevision")
    operation: Literal["UPSERT", "INVALIDATE", "DELETE"]
    snapshot: ImmutableSnapshotReference | None = None
    index_generation: IndexGeneration | None = Field(default=None, alias="indexGeneration")
    reason: Literal["NEW_REVISION", "ELIGIBILITY_CHANGED", "SOURCE_DELETED", "REINDEX_REQUESTED"] = "NEW_REVISION"

    @model_validator(mode="after")
    def validate_event(self):
        if self.meeting_id != self.source_identity.meeting_id:
            raise ValueError("Lifecycle event meeting identity mismatch")
        if self.operation == "UPSERT" and (self.snapshot is None or self.index_generation is None):
            raise ValueError("UPSERT requires snapshot and index generation")
        if self.operation == "DELETE" and self.reason != "SOURCE_DELETED":
            raise ValueError("DELETE requires source deletion reason")
        return self


def parse_knowledge_snapshot(value: object) -> KnowledgeSnapshot:
    """Validate a snapshot without exposing provider/Pydantic input details."""

    if isinstance(value, bytes):
        return _KNOWLEDGE_SNAPSHOT_ADAPTER.validate_json(value)
    return _KNOWLEDGE_SNAPSHOT_ADAPTER.validate_python(value)


NormalizedDecision.model_rebuild()
NormalizedActionItem.model_rebuild()
