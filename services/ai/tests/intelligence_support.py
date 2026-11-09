"""Synthetic Core TranscriptViews projection, never private meeting data."""

import hashlib
import json
import time
from threading import Event
from types import SimpleNamespace
from uuid import UUID

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.meeting_intelligence.processor import StageContext
from sme_meeting_ai.meeting_intelligence.source import verify_snapshot


def uid(number):
    return str(UUID(int=number))


def settings(**overrides):
    return Settings(_env_file=None, service_name="t03-test", service_identity="ai-core",
                    **overrides)


def snapshot(texts=("Chúng ta kiểm tra API trước khi triển khai.", "Có lẽ tuần tới, chưa chốt.")):
    return {
        "schemaVersion": "1.0",
        "transcript": {
            "id": uid(1), "meetingId": uid(2), "sourceMediaId": uid(3),
            "processingJobId": uid(4), "versionNumber": 1, "languageCode": "vi",
            "status": "READY_WITH_WARNINGS", "durationMs": len(texts) * 1000,
            "finalizedAt": "2026-11-09T12:00:00Z", "contentRevision": 3,
            "segments": [dict(id=uid(100 + i), ordinal=i, startMs=i * 1000,
                              endMs=(i + 1) * 1000, text=text, qualityStatus="ACCEPTED",
                              speakerClusterId=uid(10), speakerLabel="SPEAKER_00", version=0)
                         for i, text in enumerate(texts)],
        },
        "coverage": [dict(id=uid(20), startMs=0, endMs=len(texts) * 1000,
                          coverageStatus="COVERED", recovered=False, retryCount=0)],
        "speakers": [dict(id=uid(10), label="SPEAKER_00", userId=None, displayName=None)],
    }


def stage(data=None):
    data = snapshot() if data is None else data
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    digest = hashlib.sha256(raw).hexdigest()
    claim = SimpleNamespace(meetingId=uid(2), sourceMediaId=uid(3), source=SimpleNamespace(
        transcriptId=uid(1), contentRevision=3, schemaVersion=1, sizeBytes=len(raw), sha256=digest))
    verified = verify_snapshot(raw, claim)
    return StageContext(uid(4), uid(5), "GENERATING_SUMMARY", uid(2), uid(6), digest,
                        uid(1), 3, verified, time.monotonic() + 10, Event())


def task():
    from sme_meeting_ai.meeting_intelligence.contracts import ResponseSchema, TaskSpec

    return TaskSpec("Return only the original evidence segment references; do not infer claims.",
                    "probe-v1", ResponseSchema("evidence_probe", "probe-schema-v1", {
                        "type": "object", "properties": {"segment_ids": {
                            "type": "array", "items": {"type": "string", "maxLength": 36},
                            "maxItems": 100}}, "required": ["segment_ids"],
                        "additionalProperties": False}))


def envelope(content=None, **overrides):
    return dict(choices=[dict(message=dict(role="assistant", content=content or json.dumps(
        {"segment_ids": [uid(100), uid(101)]})), finish_reason="stop")],
        model="openai/gpt-5-mini-2025-08-07", provider="OpenAI",
        usage=dict(prompt_tokens=100, completion_tokens=30, total_tokens=130,
                   completion_tokens_details=dict(reasoning_tokens=10), cost=0.0001), **overrides)
