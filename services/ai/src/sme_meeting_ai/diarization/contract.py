"""Diarization result v1: pure data boundary, independent of worker infrastructure."""

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from .models import DiarizationError, SpeakerAssignment, SpeakerTurn
from .service import DiarizationResponse

CONTRACT_VERSION = "1.0"
RESULT_TYPE = "DIARIZATION_RESULT"
PROCESSING_STAGE = "DIARIZING"
MAX_RESULT_BYTES = 16_777_216
MAX_SPEAKERS = 1000
MAX_TURNS = 100_000
MAX_ASSIGNMENTS = 16_384
_MAX_DEPTH = 8
_MAX_INTEGER_DIGITS = 4300
_INTEGER_LIMIT = 10 ** _MAX_INTEGER_DIGITS
_UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
_DIGEST = re.compile(r"[0-9a-f]{64}")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)*(?::[A-Za-z0-9][A-Za-z0-9_.-]*)?")
_SECRET_PREFIXES = ("sk-", "sk_", "r8_", "hf_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_",
                    "github_pat_", "xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-", "akia", "asia", "eyj")
_SECRET_NAMES = {"api_key", "api-key", "apikey", "access_token", "access-token",
                 "authorization", "bearer", "password", "secret", "token"}
_FIELDS = {"contractVersion", "resultType", "processingJobId", "sourceMediaId", "sourceRevision",
           "transcriptId", "transcriptRevision", "producerStageRunId", "modelId", "status",
           "speakerLabels", "turns", "assignments", "diagnostics"}


class ContractValidationError(ValueError):
    def __init__(self):
        super().__init__("Diarization result contract validation failed.")


def _require(condition: bool) -> None:
    if not condition:
        raise ContractValidationError()


def _count(value: object) -> None:
    _require(type(value) is int and 0 <= value < _INTEGER_LIMIT)


def _digest(value: object) -> None:
    _require(type(value) is str and _DIGEST.fullmatch(value) is not None)


def _bindings(value) -> None:
    for identity in (value.processing_job_id, value.source_media_id, value.transcript_id, value.producer_stage_run_id):
        _require(type(identity) is UUID)
    _digest(value.source_revision)
    _count(value.transcript_revision)


def _model(value: object) -> None:
    _require(type(value) is str and 1 <= len(value) <= 256 and _MODEL.fullmatch(value) is not None)
    _require(".." not in value)
    for part in re.split(r"[/:]", value.lower()):
        _require(part not in _SECRET_NAMES and not part.startswith(_SECRET_PREFIXES))


@dataclass(frozen=True, slots=True)
class ValidationContext:
    """Authenticated Core snapshot/attempt bindings, never extracted from an artifact or queue claim."""

    processing_job_id: UUID
    source_media_id: UUID
    source_revision: str
    transcript_id: UUID
    transcript_revision: int
    producer_stage_run_id: UUID
    trusted_duration_ms: int
    expected_segment_ordinals: tuple[int, ...]

    def __post_init__(self) -> None:
        _bindings(self)
        _count(self.trusted_duration_ms)
        _require(type(self.expected_segment_ordinals) is tuple and len(self.expected_segment_ordinals) <= MAX_ASSIGNMENTS)
        for ordinal in self.expected_segment_ordinals:
            _count(ordinal)
        _require(len(set(self.expected_segment_ordinals)) == len(self.expected_segment_ordinals))


@dataclass(frozen=True, slots=True)
class Diagnostics:
    unknown_assignment_count: int

    def __post_init__(self) -> None:
        _count(self.unknown_assignment_count)
        _require(self.unknown_assignment_count <= MAX_ASSIGNMENTS)


@dataclass(frozen=True, slots=True)
class ResultArtifact:
    data: bytes
    sha256: str


@dataclass(frozen=True, slots=True)
class DiarizationResultEnvelope:
    contract_version: Literal["1.0"]
    result_type: Literal["DIARIZATION_RESULT"]
    processing_job_id: UUID
    source_media_id: UUID
    source_revision: str
    transcript_id: UUID
    transcript_revision: int
    producer_stage_run_id: UUID
    model_id: str
    status: Literal["COMPLETED"]
    speaker_labels: tuple[str, ...]
    turns: tuple[SpeakerTurn, ...]
    assignments: tuple[SpeakerAssignment, ...]
    diagnostics: Diagnostics

    def __post_init__(self) -> None:
        _require(all(type(v) is str for v in (self.contract_version, self.result_type, self.status)))
        _require(self.contract_version == CONTRACT_VERSION and self.result_type == RESULT_TYPE and self.status == "COMPLETED")
        _bindings(self)
        _model(self.model_id)
        _require(type(self.speaker_labels) is tuple and len(self.speaker_labels) <= MAX_SPEAKERS)
        _require(all(type(label) is str for label in self.speaker_labels))
        _require(self.speaker_labels == tuple(f"SPEAKER_{i:02d}" for i in range(1, len(self.speaker_labels) + 1)))
        declared = set(self.speaker_labels)
        _require(type(self.turns) is tuple and len(self.turns) <= MAX_TURNS)
        previous = -1
        referenced = set()
        for turn in self.turns:
            _require(isinstance(turn, SpeakerTurn))
            _count(turn.start_ms)
            _count(turn.end_ms)
            _require(turn.start_ms < turn.end_ms and turn.start_ms >= previous)
            _require(type(turn.speaker_label) is str and turn.speaker_label in declared)
            previous = turn.start_ms
            referenced.add(turn.speaker_label)
        _require(referenced == declared)
        _require(type(self.assignments) is tuple and len(self.assignments) <= MAX_ASSIGNMENTS)
        ordinals = set()
        unknown = 0
        for assignment in self.assignments:
            _require(isinstance(assignment, SpeakerAssignment))
            _count(assignment.ordinal)
            _require(assignment.ordinal not in ordinals)
            ordinals.add(assignment.ordinal)
            label = assignment.speaker_label
            _require(label is None or type(label) is str and label in declared)
            unknown += label is None
        _require(isinstance(self.diagnostics, Diagnostics) and self.diagnostics.unknown_assignment_count == unknown)

    def validate(self, context: ValidationContext) -> "DiarizationResultEnvelope":
        _require(isinstance(context, ValidationContext))
        for name in ("processing_job_id", "source_media_id", "source_revision", "transcript_id",
                     "transcript_revision", "producer_stage_run_id"):
            _require(getattr(self, name) == getattr(context, name))
        _require(all(turn.end_ms <= context.trusted_duration_ms for turn in self.turns))
        _require(tuple(a.ordinal for a in self.assignments) == context.expected_segment_ordinals)
        return self

    @classmethod
    def from_response(cls, response: DiarizationResponse, context: ValidationContext) -> "DiarizationResultEnvelope":
        _require(isinstance(response, DiarizationResponse) and response.diagnostic_status == "completed"
                 and response.error_category is None)
        _require(isinstance(context, ValidationContext) and type(response.assignments) is tuple)
        _require(all(isinstance(a, SpeakerAssignment) for a in response.assignments))
        return cls(
            CONTRACT_VERSION, RESULT_TYPE, context.processing_job_id, context.source_media_id,
            context.source_revision, context.transcript_id, context.transcript_revision,
            context.producer_stage_run_id, response.model_id, "COMPLETED", response.speaker_labels,
            response.raw_turns, response.assignments,
            Diagnostics(sum(a.speaker_label is None for a in response.assignments)),
        ).validate(context)


def _exact(value, fields):
    _require(type(value) is dict and value.keys() == fields)
    return value


def _array(value, maximum):
    _require(type(value) is list and len(value) <= maximum)
    return value


def _uuid(value):
    _require(type(value) is str and _UUID.fullmatch(value) is not None)
    return UUID(value)


def _unique(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result)
        result[key] = value
    return result


def _no_fractional_number(_value):
    raise ContractValidationError()


def _integer(value):
    _require(len(value.lstrip("-")) <= _MAX_INTEGER_DIGITS)
    return int(value)


def _bounded_nesting(text):
    depth, quoted, escaped = 0, False, False
    for char in text:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            _require(depth <= _MAX_DEPTH)
        elif char in "]}":
            depth -= 1


def validate_result(data: bytes, context: ValidationContext, expected_sha256: str) -> DiarizationResultEnvelope:
    """Validate untrusted exact bytes against independent authoritative bindings and integrity."""
    try:
        _require(type(data) is bytes and 0 < len(data) <= MAX_RESULT_BYTES)
        _require(isinstance(context, ValidationContext))
        _digest(expected_sha256)
        _require(hashlib.sha256(data).hexdigest() == expected_sha256)
        text = data.decode("utf-8", errors="strict")
        _require(not text.startswith("\ufeff"))
        _bounded_nesting(text)
        root = _exact(json.loads(text, object_pairs_hook=_unique, parse_constant=_no_fractional_number,
                                 parse_float=_no_fractional_number, parse_int=_integer), _FIELDS)
        labels = tuple(_array(root["speakerLabels"], MAX_SPEAKERS))
        turns = []
        for turn in _array(root["turns"], MAX_TURNS):
            _exact(turn, {"startMs", "endMs", "speakerLabel"})
            turns.append(SpeakerTurn(turn["startMs"], turn["endMs"], turn["speakerLabel"]))
        assignments = []
        for assignment in _array(root["assignments"], MAX_ASSIGNMENTS):
            _exact(assignment, {"ordinal", "speakerLabel"})
            assignments.append(SpeakerAssignment(assignment["ordinal"], assignment["speakerLabel"]))
        diagnostics = _exact(root["diagnostics"], {"unknownAssignmentCount"})
        return DiarizationResultEnvelope(
            root["contractVersion"], root["resultType"], _uuid(root["processingJobId"]),
            _uuid(root["sourceMediaId"]), root["sourceRevision"], _uuid(root["transcriptId"]),
            root["transcriptRevision"], _uuid(root["producerStageRunId"]), root["modelId"], root["status"],
            labels, tuple(turns), tuple(assignments), Diagnostics(diagnostics["unknownAssignmentCount"]),
        ).validate(context)
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError, DiarizationError):
        pass
    # Do not retain decoder exceptions containing untrusted artifact content.
    raise ContractValidationError()


def serialize_result(result: DiarizationResultEnvelope, context: ValidationContext) -> ResultArtifact:
    """Deterministic compact UTF-8; array evidence/order and nullable assignments are untouched."""
    _require(isinstance(result, DiarizationResultEnvelope))
    result.validate(context)
    payload = {
        "contractVersion": result.contract_version, "resultType": result.result_type,
        "processingJobId": str(result.processing_job_id), "sourceMediaId": str(result.source_media_id),
        "sourceRevision": result.source_revision, "transcriptId": str(result.transcript_id),
        "transcriptRevision": result.transcript_revision, "producerStageRunId": str(result.producer_stage_run_id),
        "modelId": result.model_id, "status": result.status, "speakerLabels": result.speaker_labels,
        "turns": [dict(startMs=t.start_ms, endMs=t.end_ms, speakerLabel=t.speaker_label) for t in result.turns],
        "assignments": [dict(ordinal=a.ordinal, speakerLabel=a.speaker_label) for a in result.assignments],
        "diagnostics": {"unknownAssignmentCount": result.diagnostics.unknown_assignment_count},
    }
    try:
        # Incremental encoding bounds the output buffer even for large integer tokens.
        data = bytearray()
        for chunk in json.JSONEncoder(ensure_ascii=False, allow_nan=False, separators=(",", ":")).iterencode(payload):
            encoded = chunk.encode("utf-8", errors="strict")
            _require(len(data) + len(encoded) <= MAX_RESULT_BYTES)
            data.extend(encoded)
        artifact = bytes(data)
        return ResultArtifact(artifact, hashlib.sha256(artifact).hexdigest())
    except (ValueError, TypeError, OverflowError, RecursionError):
        pass
    raise ContractValidationError()
