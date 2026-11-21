import json
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

# Initialize the rag package before importing an integration that is wired into
# the production retrieval runtime.
import sme_meeting_ai.rag  # noqa: F401
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.integrations.source_verification import (
    CoreSourceVerificationError,
    CoreSourceVerificationProvider,
)
from sme_meeting_ai.rag.retrieval_contracts import SourceVerificationRequest


def request(*, content_hash: str | None = None):
    meeting_id, source_id = (str(uuid4()) for _ in range(2))
    revision = {"number": 4}
    if content_hash is not None:
        revision["contentSha256"] = content_hash
    return SourceVerificationRequest(
        sourceIdentity={"sourceType": "SUMMARY", "sourceId": source_id, "meetingId": meeting_id},
        sourceRevision=revision,
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


def test_core_provider_omits_missing_hash_and_preserves_valid_hash():
    without_hash = request()
    with_hash = request(content_hash="a" * 64)
    sent = []

    def handler(http_request):
        payload = json.loads(http_request.read())
        sent.append(payload)
        records = []
        for item in payload["requests"]:
            records.append(
                {
                    "sourceIdentity": item["sourceIdentity"],
                    "sourceRevision": item["sourceRevision"],
                    "currentRevision": {"number": item["sourceRevision"]["number"]},
                    "status": "CURRENT",
                    "eligible": True,
                    "available": True,
                    "visible": True,
                    "verifiedAt": "2026-11-10T06:00:00Z",
                }
            )
        return httpx.Response(
            200,
            json={"success": True, "data": {"contractVersion": "1.0", "records": records}},
            headers={"cache-control": "no-store", "content-type": "application/json"},
        )

    settings = Settings(
        service_name="test-ai",
        service_identity="knowledge-worker",
        _env_file=None,
        core_api_base_url="https://core.test",
    )
    with httpx.Client(transport=httpx.MockTransport(handler), base_url="https://core.test") as client:
        provider = CoreSourceVerificationProvider(settings, client=client)
        provider.verify((without_hash, with_hash), now=None, timeout_seconds=1)

    requests = sent[0]["requests"]
    assert requests[0]["sourceRevision"] == {"number": 4}
    assert requests[1]["sourceRevision"] == {"number": 4, "contentSha256": "a" * 64}


@pytest.mark.parametrize("content_hash", ("a" * 63, "g" * 64, "A" * 64))
def test_source_verification_rejects_invalid_content_hash(content_hash):
    with pytest.raises(ValidationError):
        request(content_hash=content_hash)


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
