"""Strict canonical proposal transport preparation; never a sink fingerprint."""

import re
import unicodedata
from datetime import date

from sme_meeting_ai.integrations.core_api import uuid_string

from .contracts import canonical_json, identifier, valid_text
from .errors import require

MAX_HANDOFF_BYTES = 4 * 1024 * 1024
_FIELDS = {"candidateKey", "title", "details", "suggestedDueDate", "evidenceSegmentIds"}


def _prose(value, maximum, multiline=False):
    require(valid_text(value, maximum), "GROUNDING_FAILURE")
    require(all(not unicodedata.category(c).startswith("C")
        or multiline and c in "\r\n\t" for c in value), "GROUNDING_FAILURE")


def prepare_action_item_request(candidate, claim, snapshot):
    """Validate the entire processor output and freeze the exact live-attempt bytes."""
    require(claim.executionStageCode == "EXTRACTING_ACTION_ITEMS" and claim.resultSlot is None, "CONFIGURATION")
    require(isinstance(candidate, dict) and set(candidate) == {"producer", "result"}, "MALFORMED_OUTPUT")
    producer = candidate["producer"]
    require(isinstance(producer, dict) and {"model", "promptVersion"} <= set(producer)
        and not set(producer) - {"model", "promptVersion", "provider"}
        and identifier(producer["model"], r"[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}")
        and identifier(producer["promptVersion"]), "MALFORMED_OUTPUT")
    require(isinstance(candidate["result"], dict) and set(candidate["result"]) == {"candidates"}, "MALFORMED_OUTPUT")
    items = candidate["result"]["candidates"]
    require(isinstance(items, list) and len(items) <= 200, "CONTEXT_BUDGET")
    allowed = {s["id"] for s in snapshot["transcript"]["segments"]}
    keys = set()
    for item in items:
        require(isinstance(item, dict) and set(item) == _FIELDS, "MALFORMED_OUTPUT")
        key = item["candidateKey"]
        require(isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9._-]{1,128}", key)
            and key not in keys, "MALFORMED_OUTPUT")
        keys.add(key)
        _prose(item["title"], 500)
        if item["details"] is not None:
            _prose(item["details"], 10000, True)
        due = item["suggestedDueDate"]
        if due is not None:
            require(isinstance(due, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", due), "GROUNDING_FAILURE")
            try:
                require(date.fromisoformat(due).isoformat() == due, "GROUNDING_FAILURE")
            except ValueError:
                require(False, "GROUNDING_FAILURE")
        evidence = item["evidenceSegmentIds"]
        require(isinstance(evidence, list) and 1 <= len(evidence) <= 50
            and all(isinstance(s, str) and s in allowed for s in evidence)
            and len(set(evidence)) == len(evidence), "INVALID_REFERENCE")
        for segment in evidence:
            uuid_string(segment)
    source = claim.source
    body = dict(contractVersion="1.0", eventId=claim.eventId, stageRunId=claim.executionStageRunId,
        claimToken=claim.claimToken.get_secret_value(), source=dict(snapshotId=source.snapshotId,
            transcriptId=source.transcriptId, contentRevision=source.contentRevision, sha256=source.sha256), candidates=items)
    raw = canonical_json(body).encode("utf-8")
    require(len(raw) <= MAX_HANDOFF_BYTES, "CONTEXT_BUDGET")
    return raw
