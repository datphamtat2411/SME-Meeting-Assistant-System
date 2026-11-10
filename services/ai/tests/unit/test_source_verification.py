from uuid import uuid4

import httpx
import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.integrations.source_verification import (
    CoreSourceVerificationError,
    CoreSourceVerificationProvider,
)
from sme_meeting_ai.rag.retrieval_contracts import SourceVerificationRequest


def request():
    meeting_id, source_id = (str(uuid4()) for _ in range(2))
    return SourceVerificationRequest(
        sourceIdentity={"sourceType": "SUMMARY", "sourceId": source_id, "meetingId": meeting_id},
        sourceRevision={"number": 4},
    )


def test_core_provider_parses_only_bounded_authoritative_records():
    item = request()

    def handler(http_request):
        assert http_request.url.path.endswith("/source-verification")
        body = http_request.read()
        assert b"contractVersion" in body
        identity = item.source_identity.model_dump(mode="json", by_alias=True)
        record = {
            "sourceIdentity": identity,
            "sourceRevision": {"number": 4},
            "currentRevision": {"number": 4},
            "status": "CURRENT",
            "eligible": True,
            "available": True,
            "visible": True,
            "verifiedAt": "2026-11-10T06:00:00Z",
        }
        return httpx.Response(
            200,
            json={"success": True, "data": {"contractVersion": "1.0", "records": [record]}},
            headers={"cache-control": "no-store", "content-type": "application/json"},
        )

    settings = Settings(service_name="test-ai", service_identity="knowledge-worker", _env_file=None,
                        core_api_base_url="https://core.test")
    with httpx.Client(transport=httpx.MockTransport(handler), base_url="https://core.test") as client:
        provider = CoreSourceVerificationProvider(settings, client=client)
        records = provider.verify((item,), now=None, timeout_seconds=1)

    assert records[0].status == "CURRENT"
    assert records[0].source_identity.source_id == item.source_identity.source_id


def test_core_provider_fails_closed_when_core_does_not_return_no_store():
    settings = Settings(service_name="test-ai", service_identity="knowledge-worker", _env_file=None,
                        core_api_base_url="https://core.test")
    request_item = request()

    def handler(_request):
        return httpx.Response(200, json={"success": True, "data": {"contractVersion": "1.0", "records": []}})

    with httpx.Client(transport=httpx.MockTransport(handler), base_url="https://core.test") as client:
        provider = CoreSourceVerificationProvider(settings, client=client)
        with pytest.raises(CoreSourceVerificationError):
            provider.verify((request_item,), now=None, timeout_seconds=1)
