"""Explicit standard-library JSON logging with an allowlisted record schema."""

import json
import logging
import re
import sys
from datetime import UTC, datetime

from sme_meeting_ai.core.config import Settings, get_settings
from sme_meeting_ai.meeting_intelligence.errors import (
    MAX_VALIDATION_ITEM_INDEX,
    MAX_VALIDATION_REFERENCE_OFFSET,
    MAX_VALIDATION_REFERENCES,
    VALIDATION_EVIDENCE_ASSESSMENTS,
    VALIDATION_LEAF_REASONS,
    VALIDATION_RULES,
    ValidationEvidence,
    ValidationReference,
)

from .context import get_correlation_context

_EVENT = re.compile(r"[a-z0-9_.-]{1,128}")
_HANDLER_TAG = "_sme_meeting_ai_json_handler"
_EVENT_KEY = "_sme_meeting_ai_event"
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
)
_DIGEST = re.compile(r"[0-9a-f]{64}")
_PROCESSING_PHASES = frozenset({
    "SOURCE_DOWNLOAD", "INFERENCE", "RESULT_VALIDATION", "RESULT_STORAGE", "INTERRUPTED",
})
_STAGE_CODES = frozenset({
    "GENERATING_SUMMARY", "EXTRACTING_DECISIONS", "EXTRACTING_ACTION_ITEMS",
})


def _valid_event(event: object) -> bool:
    return isinstance(event, str) and _EVENT.fullmatch(event) is not None


def _safe_validation_evidence(value: object) -> dict | None:
    if not isinstance(value, ValidationEvidence):
        return None
    if not all(
        isinstance(identifier, str) and _UUID.fullmatch(identifier)
        for identifier in (value.source_snapshot_id, value.transcript_id)
    ):
        return None
    if (
        type(value.content_revision) is not int
        or not 0 <= value.content_revision <= 2**63 - 1
        or not isinstance(value.source_sha256, str)
        or _DIGEST.fullmatch(value.source_sha256) is None
        or not isinstance(value.references, tuple)
        or not value.references
        or len(value.references) > MAX_VALIDATION_REFERENCES
        or not isinstance(value.model_category, str)
        or re.fullmatch(r"[A-Z_]{1,32}", value.model_category) is None
        or not isinstance(value.statement_sha256, str)
        or _DIGEST.fullmatch(value.statement_sha256) is None
        or type(value.statement_char_length) is not int
        or not 0 <= value.statement_char_length <= 2_000
        or not isinstance(value.evidence_sha256, str)
        or _DIGEST.fullmatch(value.evidence_sha256) is None
        or type(value.evidence_char_length) is not int
        or not 0 <= value.evidence_char_length <= 16 * 1024 * 1024
        or type(value.affirmative_marker) is not bool
        or type(value.negative_marker) is not bool
        or not isinstance(value.assessment, str)
        or value.assessment not in VALIDATION_EVIDENCE_ASSESSMENTS
    ):
        return None
    references = []
    seen = set()
    for reference in value.references:
        if not isinstance(reference, ValidationReference):
            return None
        if (
            _UUID.fullmatch(reference.segment_id) is None
            or type(reference.char_start) is not int
            or type(reference.char_end) is not int
            or not 0 <= reference.char_start <= reference.char_end <= MAX_VALIDATION_REFERENCE_OFFSET
        ):
            return None
        key = (reference.segment_id, reference.char_start, reference.char_end)
        if key in seen:
            return None
        seen.add(key)
        references.append({
            "segment_id": reference.segment_id,
            "char_start": reference.char_start,
            "char_end": reference.char_end,
        })
    return {
        "validation_source_snapshot_id": value.source_snapshot_id,
        "validation_transcript_id": value.transcript_id,
        "validation_content_revision": value.content_revision,
        "validation_source_sha256": value.source_sha256,
        "validation_references": references,
        "validation_model_category": value.model_category,
        "validation_statement_sha256": value.statement_sha256,
        "validation_statement_char_length": value.statement_char_length,
        "validation_evidence_sha256": value.evidence_sha256,
        "validation_evidence_char_length": value.evidence_char_length,
        "validation_affirmative_marker": value.affirmative_marker,
        "validation_negative_marker": value.negative_marker,
        "validation_assessment": value.assessment,
    }


class _StructuredEvent:
    """Marker used only by the event helper, never arbitrary message text."""

    def __init__(self, name: str) -> None:
        self.name = name


class JsonFormatter(logging.Formatter):
    """Serialize fixed safe fields without formatting messages or exceptions."""

    def __init__(self, service_name: str) -> None:
        super().__init__()
        self.service_name = service_name

    def format(self, record: logging.LogRecord) -> str:
        structured = getattr(record, _EVENT_KEY, None)
        event = (
            structured.name
            if isinstance(structured, _StructuredEvent) and _valid_event(structured.name)
            else "unstructured"
        )
        # Resolve severity from the numeric level, not arbitrary record extras.
        severity = {
            logging.DEBUG: "DEBUG",
            logging.INFO: "INFO",
            logging.WARNING: "WARNING",
            logging.ERROR: "ERROR",
            logging.CRITICAL: "CRITICAL",
        }.get(record.levelno, "NOTSET")
        data = {
            "timestamp": datetime.fromtimestamp(record.created, UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "severity": severity,
            "event": event,
            "service": self.service_name,
        }
        duration = getattr(record, "_sme_duration_ms", None)
        if type(duration) is int and 0 <= duration <= 86400000:
            data["duration_ms"] = duration
        upload_bytes = getattr(record, "_sme_upload_bytes", None)
        if type(upload_bytes) is int and 0 < upload_bytes <= 100000000:
            data["upload_bytes"] = upload_bytes
        for field in ("input_tokens", "output_tokens", "total_tokens", "reasoning_tokens", "reserved_tokens"):
            value = getattr(record, "_sme_" + field, None)
            if type(value) is int and 0 <= value <= 2**63 - 1:
                data[field] = value
        attempts = getattr(record, "_sme_attempts", None)
        if type(attempts) is int and 0 <= attempts <= 100:
            data["attempts"] = attempts
        validation_reason = getattr(record, "_sme_validation_reason", None)
        if isinstance(validation_reason, str) and validation_reason in VALIDATION_LEAF_REASONS:
            data["validation_reason"] = validation_reason
            validation_rule = getattr(record, "_sme_validation_rule", None)
            if isinstance(validation_rule, str) and validation_rule in VALIDATION_RULES:
                data["validation_rule"] = validation_rule
            validation_item_index = getattr(record, "_sme_validation_item_index", None)
            if (type(validation_item_index) is int
                    and 0 <= validation_item_index <= MAX_VALIDATION_ITEM_INDEX):
                data["validation_item_index"] = validation_item_index
            evidence = getattr(record, "_sme_validation_evidence", None)
            if isinstance(evidence, dict):
                data.update(evidence)
        processing_phase = getattr(record, "_sme_processing_phase", None)
        if processing_phase in _PROCESSING_PHASES:
            data["processing_phase"] = processing_phase
        stage_code = getattr(record, "_sme_stage_code", None)
        if stage_code in _STAGE_CODES:
            data["stage_code"] = stage_code
        stage_run_id = getattr(record, "_sme_stage_run_id", None)
        if isinstance(stage_run_id, str) and _UUID.fullmatch(stage_run_id):
            data["stage_run_id"] = stage_run_id
        job_id = getattr(record, "_sme_job_id", None)
        if isinstance(job_id, str) and _UUID.fullmatch(job_id):
            data["job_id"] = job_id
        context = get_correlation_context()
        if context is not None:
            for field in (
                "trace_id", "span_id", "trace_flags", "parent_span_id",
                "request_id", "job_id",
            ):
                value = getattr(context, field)
                if value is not None:
                    data[field] = value
        return json.dumps(data, ensure_ascii=True, separators=(",", ":"))


def configure_logging(settings: Settings | None = None) -> None:
    """Configure only the package logger; replace only our tagged handlers."""
    if settings is None:
        settings = get_settings()
    logger = logging.getLogger("sme_meeting_ai")
    handler = logging.StreamHandler(sys.stdout)
    setattr(handler, _HANDLER_TAG, True)
    handler.setFormatter(JsonFormatter(settings.service_name))
    for existing in logger.handlers[:]:
        if getattr(existing, _HANDLER_TAG, False):
            logger.removeHandler(existing)
            existing.close()
    logger.addHandler(handler)
    logger.setLevel(settings.log_level)
    logger.propagate = False


def log_event(logger: logging.Logger, level: int, event: str, *, duration_ms: int | None = None,
              upload_bytes: int | None = None, input_tokens: int | None = None,
              output_tokens: int | None = None, total_tokens: int | None = None,
              reasoning_tokens: int | None = None, reserved_tokens: int | None = None,
              attempts: int | None = None, validation_reason: str | None = None,
              validation_rule: str | None = None, validation_item_index: int | None = None,
              processing_phase: str | None = None, stage_code: str | None = None,
              stage_run_id: str | None = None, job_id: str | None = None,
              validation_evidence: ValidationEvidence | None = None) -> None:
    """Log a bounded stable event name, with no free-text payload API."""
    if not _valid_event(event):
        raise ValueError("Invalid event name")
    extra = {_EVENT_KEY: _StructuredEvent(event)}
    if type(duration_ms) is int and 0 <= duration_ms <= 86400000:
        extra["_sme_duration_ms"] = duration_ms
    if type(upload_bytes) is int and 0 < upload_bytes <= 100000000:
        extra["_sme_upload_bytes"] = upload_bytes
    for field, value in (("input_tokens", input_tokens), ("output_tokens", output_tokens),
                         ("total_tokens", total_tokens), ("reasoning_tokens", reasoning_tokens),
                         ("reserved_tokens", reserved_tokens)):
        if type(value) is int and 0 <= value <= 2**63 - 1:
            extra["_sme_" + field] = value
    if type(attempts) is int and 0 <= attempts <= 100:
        extra["_sme_attempts"] = attempts
    if isinstance(validation_reason, str) and validation_reason in VALIDATION_LEAF_REASONS:
        extra["_sme_validation_reason"] = validation_reason
        if isinstance(validation_rule, str) and validation_rule in VALIDATION_RULES:
            extra["_sme_validation_rule"] = validation_rule
        if (type(validation_item_index) is int
                and 0 <= validation_item_index <= MAX_VALIDATION_ITEM_INDEX):
            extra["_sme_validation_item_index"] = validation_item_index
        safe_evidence = _safe_validation_evidence(validation_evidence)
        if safe_evidence is not None:
            extra["_sme_validation_evidence"] = safe_evidence
    if processing_phase in _PROCESSING_PHASES:
        extra["_sme_processing_phase"] = processing_phase
    if stage_code in _STAGE_CODES:
        extra["_sme_stage_code"] = stage_code
    if isinstance(stage_run_id, str) and _UUID.fullmatch(stage_run_id):
        extra["_sme_stage_run_id"] = stage_run_id
    if isinstance(job_id, str) and _UUID.fullmatch(job_id):
        extra["_sme_job_id"] = job_id
    logger.log(level, "", extra=extra)
