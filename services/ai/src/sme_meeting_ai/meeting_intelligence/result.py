"""Serialize bounded, source-bound Summary and Decision result candidates."""

import json
import re
from uuid import UUID


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
        if (len(warnings) > 4 or len(set(warnings)) != len(warnings)
                or any(w not in {"INCOMPLETE_COVERAGE", "UNRESOLVED_EVIDENCE", "SUSPICIOUS_EVIDENCE", "SOURCE_QUALITY_WARNING"} for w in warnings)):
            raise ValueError
        if claim.executionStageCode == "GENERATING_SUMMARY":
            if set(result) != {"content", "warnings"}:
                raise ValueError
            _text(result["content"], 20000, content=True)
            kind = "SUMMARY"
        elif claim.executionStageCode == "EXTRACTING_DECISIONS":
            if set(result) != {"candidates", "warnings"} or not isinstance(result["candidates"], list) or len(result["candidates"]) > 500:
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
        payload = dict(schemaVersion="1.0", resultType=kind, processingJobId=claim.processingJobId,
            stageRunId=claim.executionStageRunId, source=dict(transcriptId=source.transcriptId,
            contentRevision=source.contentRevision, inputSnapshotId=source.snapshotId, sha256=source.sha256),
            producer=producer, result=result)
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError
        return raw
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        raise ResultError() from None
