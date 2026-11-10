import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx

from sme_meeting_ai.api import create_app
from sme_meeting_ai.api.security import VerifiedServiceIdentity
from sme_meeting_ai.core.config import Settings

GENERATION = "rag-t02-bge-m3-v1"
MEETING_ID = "11111111-1111-4111-8111-111111111111"
SOURCE_ID = "22222222-2222-4222-8222-222222222222"


class Boundary:
    async def identity_for(self, scope):
        return VerifiedServiceIdentity(
            principal="core-api",
            certificate_verified=True,
            request_scope=scope,
            expires_at=datetime.now(UTC) + timedelta(minutes=1),
        )


class FakeStore:
    def __init__(self):
        self.spec = SimpleNamespace(compatibility=SimpleNamespace(index_generation_id=GENERATION))
        self.validated = False
        self.requests = []

    def validate_retrieval_schema(self):
        self.validated = True

    def count_source_points(self, meeting_id, source_type, source_id, source_revision, generation_id):
        self.requests.append((meeting_id, source_type, source_id, source_revision, generation_id))
        return 3


def test_reconciliation_endpoint_returns_exact_source_point_count():
    store = FakeStore()
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    app = create_app(
        settings,
        identity_source=Boundary(),
        operation_policy={"knowledge.reconciliation": {"core-api"}},
        knowledge_vector_store=store,
    )

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post(
                "/internal/v1/knowledge-indexing/reconciliation",
                json={
                    "contractVersion": "1.0",
                    "generationId": GENERATION,
                    "requests": [{
                        "sourceIdentity": {
                            "sourceType": "ACTION_ITEM",
                            "sourceId": SOURCE_ID,
                            "meetingId": MEETING_ID,
                        },
                        "sourceRevision": {"number": 4},
                    }],
                },
            )

    response = asyncio.run(run())

    assert response.status_code == 200
    assert response.json() == {
        "contractVersion": "1.0",
        "generationId": GENERATION,
        "records": [{
            "sourceIdentity": {
                "sourceType": "ACTION_ITEM",
                "sourceId": SOURCE_ID,
                "meetingId": MEETING_ID,
            },
            "sourceRevision": {"number": 4},
            "pointCount": 3,
        }],
    }
    assert store.validated is True
    assert store.requests == [(MEETING_ID, "ACTION_ITEM", SOURCE_ID, 4, GENERATION)]
