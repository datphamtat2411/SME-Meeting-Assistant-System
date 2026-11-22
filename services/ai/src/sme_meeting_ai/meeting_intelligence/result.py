"""Serialize bounded, source-bound Summary and Decision result candidates."""

import json
import re
from uuid import UUID

from .grounding import (
    GROUNDING_DIAGNOSTIC_VERSION,
    RESULT_WARNING_CODES,
    validate_diagnostic_counts,
    validate_diagnostic_payloads,
)


class ResultError(Exception):
    def __init__(self):
        super().__init__("INTELLIGENCE_RESULT_INVALID")


def _text(value, maximum, *, content=False):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError
    for index, char in enumerate(value):
        if char == "\r" and content and index + 1 < len(value) and value[index + 1] == "\n":
            continue
        if (ord(char) < 32 or 127 <= ord(char) <= 159) and not (content and char in "\n\t"):
            raise ValueError


def serialize_result(candidate, claim, snapshot):
    try:
        if not isinstance(candidate, dict) or set(candidate) != {"producer", "result"}:
            raise ValueError
        producer, result = candidate["producer"], candidate["result"]
        if not isinstance(producer, dict) or not {"model", "promptVersion"} <= producer.keys() or producer.keys() - {"model", "promptVersion", "provider"}:
            raise ValueError
        for key, limit in (("model", 160), ("promptVersion", 80), ("provider", 80)):
            if key in producer:
                _text(producer[key], limit)
        if not isinstance(result, dict) or not isinstance(result.get("warnings"), list):
            raise ValueError
        warnings = result["warnings"]
        if (len(warnings) > len(RESULT_WARNING_CODES) or len(set(warnings)) != len(warnings)
                or any(w not in RESULT_WARNING_CODES for w in warnings)):
            raise ValueError
        diagnostics = validate_diagnostic_payloads(result.get("diagnostics", ()))
        has_diagnostic_metadata = (
            "diagnosticsVersion" in result or "diagnosticCounts" in result
        )
        has_claim_diagnostics = any(
            "diagnosticVersion" in diagnostic for diagnostic in diagnostics
        )
        if has_claim_diagnostics and not has_diagnostic_metadata:
            raise ValueError
        if has_diagnostic_metadata:
            if (set(result) - {
                    "content", "candidates", "warnings", "diagnostics",
                    "diagnosticsVersion", "diagnosticCounts",
                }
                    or result.get("diagnosticsVersion") != GROUNDING_DIAGNOSTIC_VERSION
                    or "diagnosticCounts" not in result):
                raise ValueError
            counts = validate_diagnostic_counts(result["diagnosticCounts"], diagnostics)
        else:
            counts = None
        if set(result) - {
                "content", "candidates", "warnings", "diagnostics",
                "diagnosticsVersion", "diagnosticCounts",
            }:
            raise ValueError
        if claim.executionStageCode == "GENERATING_SUMMARY":
            if set(result) - {
                    "content", "warnings", "diagnostics",
                    "diagnosticsVersion", "diagnosticCounts",
                } or "content" not in result:
                raise ValueError
            _text(result["content"], 20000, content=True)
            kind = "SUMMARY"
        elif claim.executionStageCode == "EXTRACTING_DECISIONS":
            if (set(result) - {
                        "candidates", "warnings", "diagnostics",
                        "diagnosticsVersion", "diagnosticCounts",
                    }
                    or "candidates" not in result
                    or not isinstance(result["candidates"], list)
                    or len(result["candidates"]) > 500):
                raise ValueError
            valid_ids = {UUID(segment["id"]) for segment in snapshot["transcript"]["segments"]}
            keys = set()
            for item in result["candidates"]:
                if not isinstance(item, dict) or set(item) != {"candidateKey", "content", "evidenceSegmentIds", "uncertainty"}:
                    raise ValueError
                key = item["candidateKey"]
                if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", key) or key in keys:
                    raise ValueError
                keys.add(key)
                _text(item["content"], 5000, content=True)
                ids = item["evidenceSegmentIds"]
                if not isinstance(ids, list) or not 1 <= len(ids) <= 50 or item["uncertainty"] not in {"NONE", "LOW", "MATERIAL"}:
                    raise ValueError
                parsed = [UUID(value) for value in ids]
                if len(set(parsed)) != len(parsed) or not set(parsed) <= valid_ids:
                    raise ValueError
            kind = "DECISION_EXTRACTION"
        else:
            raise ValueError
        source = claim.source
        result_payload = dict(result)
        if "diagnostics" in result:
            result_payload["diagnostics"] = list(diagnostics)
        if counts is not None:
            result_payload["diagnosticsVersion"] = GROUNDING_DIAGNOSTIC_VERSION
            result_payload["diagnosticCounts"] = counts
        payload = dict(schemaVersion="1.0", resultType=kind, processingJobId=claim.processingJobId,
            stageRunId=claim.executionStageRunId, source=dict(transcriptId=source.transcriptId,
            contentRevision=source.contentRevision, inputSnapshotId=source.snapshotId, sha256=source.sha256),
            producer=producer, result=result_payload)
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError
        return raw
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        raise ResultError() from None
