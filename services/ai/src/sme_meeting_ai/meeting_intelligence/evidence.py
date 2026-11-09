"""Immutable, source-preserving normalization of Core TranscriptViews snapshots."""

import json
import re
from dataclasses import asdict, dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, Mapping
from uuid import UUID

from .contracts import canonical_json, valid_text
from .errors import IntelligenceError, check_authority, require
from .processor import StageContext

if TYPE_CHECKING:
    from .context import ContextLimits

_HEADER = {"id", "meetingId", "sourceMediaId", "processingJobId", "versionNumber",
           "languageCode", "status", "durationMs", "finalizedAt", "contentRevision", "segments"}
_SEGMENT = {"id", "ordinal", "startMs", "endMs", "text", "qualityStatus",
            "speakerClusterId", "speakerLabel", "version"}
_OPTIONAL_SEGMENT = ("startMs", "endMs", "qualityStatus", "speakerClusterId", "speakerLabel", "version")


def _uuid(value):
    require(isinstance(value, str) and len(value) == 36, "INVALID_SOURCE")
    return UUID(value)


def _integer(value, minimum=0):
    require(type(value) is int and minimum <= value <= 2**63 - 1, "INVALID_SOURCE")
    return value


def _optional_text(value, maximum):
    require(value is None or valid_text(value, maximum), "INVALID_SOURCE")


def _timeline(start, end, duration):
    for value in (start, end):
        if value is not None:
            _integer(value)
            require(duration is None or value <= duration, "INVALID_SOURCE")
    require(start is None or end is None or end > start, "INVALID_SOURCE")


@dataclass(frozen=True)
class SourceIdentity:
    snapshot_id: str
    transcript_id: str
    content_revision: int
    sha256: str


@dataclass(frozen=True)
class EvidenceUnit:
    source: SourceIdentity
    segment_id: str
    ordinal: int
    char_start: int
    char_end: int
    text: str = field(repr=False)
    start_ms: int | None
    end_ms: int | None
    speaker_cluster_id: str | None
    speaker_label: str | None = field(repr=False)
    quality_status: str | None
    missing_fields: tuple[str, ...]

    def to_dict(self) -> dict:
        # Timing describes the original segment, never interpolated subrange timing.
        return {"segment_id": self.segment_id, "ordinal": self.ordinal,
                "char_start": self.char_start, "char_end": self.char_end, "text": self.text,
                "segment_start_ms": self.start_ms, "segment_end_ms": self.end_ms,
                "speaker_cluster_id": self.speaker_cluster_id, "speaker_label": self.speaker_label,
                "quality_status": self.quality_status, "missing_fields": self.missing_fields}


@dataclass(frozen=True)
class EvidenceSegment:
    segment_id: str
    ordinal: int
    text: str = field(repr=False)
    start_ms: int | None
    end_ms: int | None
    speaker_cluster_id: str | None
    speaker_label: str | None = field(repr=False)
    quality_status: str | None
    version: int | None
    missing_fields: tuple[str, ...]


@dataclass(frozen=True)
class CoverageRegion:
    region_id: str
    start_ms: int
    end_ms: int
    status: str
    recovered: bool
    retry_count: int


@dataclass(frozen=True)
class Speaker:
    cluster_id: str
    label: str = field(repr=False)
    user_id: str | None = field(repr=False)
    display_name: str | None = field(repr=False)
    missing_fields: tuple[str, ...]


@dataclass(frozen=True)
class EvidenceSource:
    identity: SourceIdentity
    segments: tuple[EvidenceSegment, ...] = field(repr=False)
    coverage: tuple[CoverageRegion, ...]
    speakers: tuple[Speaker, ...] = field(repr=False)
    quality_flags: tuple[str, ...]
    has_usable_evidence: bool
    metadata_json: str = field(repr=False)
    _index: Mapping[UUID, EvidenceSegment] = field(repr=False, compare=False)

    def resolve(self, segment_id: str, char_start: int = 0, char_end: int | None = None) -> EvidenceUnit:
        try:
            segment = self._index[UUID(segment_id)]
            end = len(segment.text) if char_end is None else char_end
            require(type(char_start) is int and type(end) is int
                    and 0 <= char_start <= end <= len(segment.text)
                    and (end > char_start or not segment.text), "INVALID_REFERENCE")
        except (ValueError, TypeError, KeyError, AttributeError, IntelligenceError):
            pass
        else:
            return EvidenceUnit(self.identity, segment.segment_id, segment.ordinal, char_start, end,
                                segment.text[char_start:end], segment.start_ms, segment.end_ms,
                                segment.speaker_cluster_id, segment.speaker_label, segment.quality_status,
                                segment.missing_fields)
        raise IntelligenceError("INVALID_REFERENCE")

    def provenance(self) -> dict:
        return {"source": asdict(self.identity), "transcript": json.loads(self.metadata_json),
                "quality_flags": self.quality_flags, "has_usable_evidence": self.has_usable_evidence,
                "coverage": [asdict(region) for region in self.coverage],
                "speakers": [asdict(speaker) for speaker in self.speakers]}


def normalize_evidence(context: StageContext, limits: "ContextLimits") -> EvidenceSource:
    category = "INVALID_SOURCE"
    try:
        return _normalize(context, limits)
    except IntelligenceError as error:
        category = error.category
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        pass
    except MemoryError:
        category = "RESOURCE"
    raise IntelligenceError(category)


def _normalize(context, limits):
    check_authority(context.deadline, context.cancelled)
    data = context.snapshot
    require(isinstance(data, dict) and set(data) == {"schemaVersion", "transcript", "coverage", "speakers"}
            and data["schemaVersion"] == "1.0", "INVALID_SOURCE")
    # Count canonical encoded bytes incrementally: no second whole-source JSON copy.
    size = 0
    for part in json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False).iterencode(data):
        check_authority(context.deadline, context.cancelled)
        size += len(part.encode("utf-8"))
        require(size <= limits.max_source_bytes, "CONTEXT_BUDGET")
    header = data["transcript"]
    require(isinstance(header, dict) and not header.keys() - _HEADER, "INVALID_SOURCE")
    require(_uuid(header["id"]) == _uuid(context.transcript_id)
            and _uuid(header["meetingId"]) == _uuid(context.meeting_id), "INVALID_SOURCE")
    _uuid(header["sourceMediaId"])
    _uuid(context.source_snapshot_id)
    require(isinstance(context.source_sha256, str)
            and re.fullmatch(r"[a-f0-9]{64}", context.source_sha256) is not None, "INVALID_SOURCE")
    revision = _integer(header["contentRevision"])
    require(type(context.content_revision) is int and revision == context.content_revision, "INVALID_SOURCE")
    for key in ("processingJobId",):
        if header.get(key) is not None:
            _uuid(header[key])
    for key in ("versionNumber",):
        if header.get(key) is not None:
            _integer(header[key])
    for key in ("languageCode", "finalizedAt"):
        _optional_text(header.get(key), 80)
    status = header.get("status")
    require(status in {"READY", "READY_WITH_WARNINGS"}, "INVALID_SOURCE")
    duration = header.get("durationMs")
    if duration is not None:
        _integer(duration, 1)
    segments, speakers, coverage = header["segments"], data["speakers"], data["coverage"]
    require(isinstance(segments, list) and bool(segments) and isinstance(speakers, list)
            and isinstance(coverage, list), "INVALID_SOURCE")
    require(len(segments) <= limits.max_evidence_units and len(speakers) <= limits.max_evidence_units
            and len(coverage) <= limits.max_evidence_units, "CONTEXT_BUDGET")
    flags = {"SOURCE_QUALITY_WARNING"} if status == "READY_WITH_WARNINGS" else set()
    normalized_speakers, speaker_index = [], {}
    for item in speakers:
        check_authority(context.deadline, context.cancelled)
        require(isinstance(item, dict) and not item.keys() - {"id", "label", "userId", "displayName"}, "INVALID_SOURCE")
        key = _uuid(item["id"])
        require(key not in speaker_index and valid_text(item["label"], 160), "INVALID_SOURCE")
        user_id = item.get("userId")
        if user_id is not None:
            _uuid(user_id)
        _optional_text(item.get("displayName"), 255)
        speaker = Speaker(item["id"], item["label"], user_id, item.get("displayName"),
                          tuple(k for k in ("userId", "displayName") if k not in item))
        normalized_speakers.append(speaker)
        speaker_index[key] = speaker
    normalized_segments, index = [], {}
    previous_ordinal, previous_start = -1, -1
    for item in segments:
        check_authority(context.deadline, context.cancelled)
        require(isinstance(item, dict) and not item.keys() - _SEGMENT, "INVALID_SOURCE")
        key, ordinal = _uuid(item["id"]), _integer(item["ordinal"])
        require(key not in index and ordinal > previous_ordinal, "INVALID_SOURCE")
        previous_ordinal = ordinal
        quality, text = item.get("qualityStatus"), item["text"]
        require(quality is None or quality in {"ACCEPTED", "SUSPICIOUS", "UNRESOLVED"}, "INVALID_SOURCE")
        require(valid_text(text, limits.max_source_bytes, empty=quality in {"SUSPICIOUS", "UNRESOLVED"}), "INVALID_SOURCE")
        if quality == "SUSPICIOUS":
            flags.add("SUSPICIOUS_EVIDENCE")
        if quality == "UNRESOLVED":
            flags.add("UNRESOLVED_EVIDENCE")
        if quality is None:
            flags.add("UNKNOWN_SEGMENT_QUALITY")
        start, end = item.get("startMs"), item.get("endMs")
        _timeline(start, end, duration)
        if start is None or end is None:
            flags.add("MISSING_TIMING")
        if start is not None:
            require(start >= previous_start, "INVALID_SOURCE")
            previous_start = start
        cluster, label = item.get("speakerClusterId"), item.get("speakerLabel")
        _optional_text(label, 160)
        if cluster is None or label is None:
            flags.add("UNKNOWN_SPEAKERS")
        if cluster is not None:
            speaker = speaker_index.get(_uuid(cluster))
            require(speaker is not None and (label is None or label == speaker.label), "INVALID_SOURCE")
            if speaker.user_id is None:
                flags.add("ANONYMOUS_SPEAKERS")
        version = item.get("version")
        if version is not None:
            _integer(version)
        segment = EvidenceSegment(item["id"], ordinal, text, start, end, cluster, label,
                                  quality, version, tuple(k for k in _OPTIONAL_SEGMENT if k not in item))
        normalized_segments.append(segment)
        index[key] = segment
    normalized_coverage, coverage_ids, previous_start = [], set(), -1
    for item in coverage:
        check_authority(context.deadline, context.cancelled)
        require(isinstance(item, dict) and set(item) == {
            "id", "startMs", "endMs", "coverageStatus", "recovered", "retryCount"}, "INVALID_SOURCE")
        key = _uuid(item["id"])
        require(key not in coverage_ids, "INVALID_SOURCE")
        coverage_ids.add(key)
        start, end = _integer(item["startMs"]), _integer(item["endMs"])
        _timeline(start, end, duration)
        require(start >= previous_start, "INVALID_SOURCE")
        previous_start = start
        coverage_status = item["coverageStatus"]
        require(coverage_status in {"COVERED", "SUSPICIOUS", "UNRESOLVED_ERROR"}
                and type(item["recovered"]) is bool, "INVALID_SOURCE")
        retries = _integer(item["retryCount"])
        if coverage_status == "SUSPICIOUS":
            flags.add("SUSPICIOUS_EVIDENCE")
        if coverage_status == "UNRESOLVED_ERROR":
            flags.update({"INCOMPLETE_COVERAGE", "UNRESOLVED_EVIDENCE"})
        normalized_coverage.append(CoverageRegion(item["id"], start, end, coverage_status, item["recovered"], retries))
    if not normalized_coverage:
        flags.add("COVERAGE_UNKNOWN")
    check_authority(context.deadline, context.cancelled)
    return EvidenceSource(
        SourceIdentity(context.source_snapshot_id, context.transcript_id, revision, context.source_sha256),
        tuple(normalized_segments), tuple(normalized_coverage), tuple(normalized_speakers), tuple(sorted(flags)),
        any(s.text.strip() for s in normalized_segments),
        canonical_json({k: v for k, v in header.items() if k != "segments"}), MappingProxyType(index))
