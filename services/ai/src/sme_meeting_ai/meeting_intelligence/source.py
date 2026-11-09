"""Verify snapshot bytes against the descriptor authorized by Core API."""

import hashlib
import hmac
from uuid import UUID

from sme_meeting_ai.integrations.core_api import strict_json, uuid_string


class SourceIntegrityError(Exception):
    def __init__(self):
        super().__init__("INTELLIGENCE_SOURCE_INTEGRITY")


def verify_snapshot(raw, claim):
    """Return the decoded snapshot only after checking bytes and source identity."""
    try:
        source = claim.source
        if (not isinstance(raw, bytes) or not 0 < len(raw) <= 8 * 1024 * 1024
                or len(raw) != source.sizeBytes or source.schemaVersion != 1
                or not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), source.sha256)):
            raise ValueError
        data = strict_json(raw, 8 * 1024 * 1024)
        if not isinstance(data, dict) or set(data) != {"schemaVersion", "transcript", "coverage", "speakers"}:
            raise ValueError
        transcript = data["transcript"]
        if (data["schemaVersion"] != "1.0" or not isinstance(transcript, dict)
                or not isinstance(data["coverage"], list) or not isinstance(data["speakers"], list)
                or type(transcript.get("contentRevision")) is not int
                or transcript["contentRevision"] != source.contentRevision
                or any(UUID(uuid_string(transcript[name])) != UUID(expected) for name, expected in (
                    ("id", source.transcriptId), ("meetingId", claim.meetingId),
                    ("sourceMediaId", claim.sourceMediaId)))
                or not isinstance(transcript.get("segments"), list) or not transcript["segments"]):
            raise ValueError
        return data
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        raise SourceIntegrityError() from None
