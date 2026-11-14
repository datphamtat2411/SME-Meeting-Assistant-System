import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest

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


def test_inventory_endpoint_returns_paginated_identities_and_rejects_broad_requests():
    class InventoryStore(FakeStore):
        def inventory_source_page(self, generation_id, limit, cursor):
            assert generation_id == GENERATION
            assert limit == 2
            assert cursor is None
            return ([{
                "sourceIdentity": {
                    "sourceType": "ACTION_ITEM", "sourceId": SOURCE_ID, "meetingId": MEETING_ID,
                },
                "sourceRevision": {"number": 4},
            }], "7")

    store = InventoryStore()
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    app = create_app(
        settings,
        identity_source=Boundary(),
        operation_policy={"knowledge.reconciliation": {"core-api"}},
        knowledge_vector_store=store,
    )

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            good = await client.post("/internal/v1/knowledge-indexing/reconciliation/inventory",
                json={"contractVersion": "1.0", "generationId": GENERATION, "limit": 2})
            invalid = await client.post("/internal/v1/knowledge-indexing/reconciliation/inventory",
                json={"contractVersion": "1.0", "generationId": GENERATION, "limit": 501})
            return good, invalid

    good, invalid = asyncio.run(run())
    assert good.status_code == 200
    assert good.json() == {
        "contractVersion": "1.0", "generationId": GENERATION,
        "records": [{
            "sourceIdentity": {"sourceType": "ACTION_ITEM", "sourceId": SOURCE_ID, "meetingId": MEETING_ID},
            "sourceRevision": {"number": 4},
        }],
        "nextCursor": "7",
    }
    assert invalid.status_code == 422
    assert store.validated is True


@pytest.mark.parametrize(
    "cursor",
    [
        "abcd",
        "bad-cursor",
        "-1",
        "",
        " ",
        " 7",
        "7 ",
        "18446744073709551616",
        "１２３",
        True,
        7,
        [],
        {},
    ],
)
def test_inventory_endpoint_rejects_malformed_cursor_before_qdrant(cursor):
    class InventoryStore(FakeStore):
        def inventory_source_page(self, *args):
            self.requests.append(args)
            raise AssertionError("invalid cursors must not reach inventory")

    store = InventoryStore()
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    app = create_app(
        settings,
        identity_source=Boundary(),
        operation_policy={"knowledge.reconciliation": {"core-api"}},
        knowledge_vector_store=store,
    )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.post(
                "/internal/v1/knowledge-indexing/reconciliation/inventory",
                json={
                    "contractVersion": "1.0",
                    "generationId": GENERATION,
                    "cursor": cursor,
                    "limit": 100,
                },
            )

    response = asyncio.run(run())
    assert response.status_code == 422
    assert "Invalid Qdrant inventory cursor" not in response.text
    assert "Traceback" not in response.text
    assert store.validated is False
    assert store.requests == []


@pytest.mark.parametrize(
    ("cursor", "normalized"),
    [
        ("0007", "7"),
        ("22222222222222222222222222222222", "22222222-2222-2222-2222-222222222222"),
    ],
)
def test_inventory_endpoint_accepts_and_normalizes_valid_cursors(cursor, normalized):
    class InventoryStore(FakeStore):
        def inventory_source_page(self, generation_id, limit, received_cursor):
            self.requests.append((generation_id, limit, received_cursor))
            return [], None

    store = InventoryStore()
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    app = create_app(
        settings,
        identity_source=Boundary(),
        operation_policy={"knowledge.reconciliation": {"core-api"}},
        knowledge_vector_store=store,
    )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.post(
                "/internal/v1/knowledge-indexing/reconciliation/inventory",
                json={
                    "contractVersion": "1.0",
                    "generationId": GENERATION,
                    "cursor": cursor,
                    "limit": 100,
                },
            )

    response = asyncio.run(run())
    assert response.status_code == 200
    assert store.requests == [(GENERATION, 100, normalized)]


def test_inventory_endpoint_preserves_generation_conflict_and_qdrant_failures():
    from sme_meeting_ai.rag.qdrant import QdrantError

    class InventoryStore(FakeStore):
        def inventory_source_page(self, *args):
            raise QdrantError("QDRANT_UNAVAILABLE")

    class IntegrityStore(FakeStore):
        def inventory_source_page(self, *args):
            raise QdrantError("INVENTORY_CURSOR_INVALID")

    store = InventoryStore()
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    app = create_app(
        settings,
        identity_source=Boundary(),
        operation_policy={"knowledge.reconciliation": {"core-api"}},
        knowledge_vector_store=store,
    )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            conflict = await client.post(
                "/internal/v1/knowledge-indexing/reconciliation/inventory",
                json={
                    "contractVersion": "1.0",
                    "generationId": "another-generation",
                    "cursor": "7",
                    "limit": 100,
                },
            )
            unavailable = await client.post(
                "/internal/v1/knowledge-indexing/reconciliation/inventory",
                json={
                    "contractVersion": "1.0",
                    "generationId": GENERATION,
                    "cursor": "7",
                    "limit": 100,
                },
            )
            app.state.knowledge_vector_store = IntegrityStore()
            integrity = await client.post(
                "/internal/v1/knowledge-indexing/reconciliation/inventory",
                json={
                    "contractVersion": "1.0",
                    "generationId": GENERATION,
                    "cursor": "7",
                    "limit": 100,
                },
            )
            return conflict, unavailable, integrity

    conflict, unavailable, integrity = asyncio.run(run())
    assert conflict.status_code == 409
    assert unavailable.status_code == 503
    assert integrity.status_code == 503
    assert integrity.json() == {
        "error": {"code": "inventory_integrity_failure", "message": "Knowledge inventory unavailable"}
    }


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

def test_qdrant_inventory_adapter_paginates_and_filters_generation():
    import pytest

    from sme_meeting_ai.rag.qdrant import QdrantError, QdrantVectorStore

    class Client:
        def __init__(self):
            self.calls = []

        def scroll(self, **kwargs):
            self.calls.append(kwargs)
            if kwargs.get("offset") is None:
                return ([SimpleNamespace(payload={
                    "meeting_id": MEETING_ID,
                    "source_type": "ACTION_ITEM",
                    "canonical_source_id": SOURCE_ID,
                    "canonical_source_revision": 4,
                    "index_generation_id": GENERATION,
                    "meeting_content": "Must never cross inventory API",
                })], 7)
            return ([], None)

    store = object.__new__(QdrantVectorStore)
    store.spec = SimpleNamespace(
        collection_name="isolated-test",
        compatibility=SimpleNamespace(index_generation_id=GENERATION),
    )
    store.client = Client()
    first, cursor = store.inventory_source_page(GENERATION, 1)
    assert cursor == "7"
    assert first == [{
        "sourceIdentity": {"sourceType": "ACTION_ITEM", "sourceId": SOURCE_ID, "meetingId": MEETING_ID},
        "sourceRevision": {"number": 4},
    }]
    second, end = store.inventory_source_page(GENERATION, 1, cursor)
    assert second == [] and end is None
    # Scan ALL points in the generation-isolated collection; a generation
    # filter would conceal malformed or foreign-generation payloads.
    assert "scroll_filter" not in store.client.calls[0]
    assert store.client.calls[1]["offset"] == 7
    with pytest.raises(QdrantError):
        store.inventory_source_page("another-generation", 1)
    from sme_meeting_ai.rag.inventory_cursor import InvalidInventoryCursor

    with pytest.raises(InvalidInventoryCursor):
        store.inventory_source_page(GENERATION, 1, "bad-cursor")


def test_qdrant_inventory_fails_closed_for_malformed_or_stalled_payloads():
    import pytest

    from sme_meeting_ai.rag.qdrant import QdrantError, QdrantVectorStore

    store = object.__new__(QdrantVectorStore)
    store.spec = SimpleNamespace(
        collection_name="isolated-test",
        compatibility=SimpleNamespace(index_generation_id=GENERATION),
    )

    class Malformed:
        def scroll(self, **kwargs):
            return ([SimpleNamespace(payload={
                "meeting_id": MEETING_ID,
                "source_type": "ACTION_ITEM",
                "canonical_source_id": SOURCE_ID,
                "canonical_source_revision": -1,
                "index_generation_id": GENERATION,
            })], None)

    store.client = Malformed()
    with pytest.raises(QdrantError) as error:
        store.inventory_source_page(GENERATION, 10)
    assert error.value.category == "INVENTORY_INVALID"

    class ForeignGeneration:
        def scroll(self, **kwargs):
            return ([SimpleNamespace(payload={
                "meeting_id": MEETING_ID,
                "source_type": "ACTION_ITEM",
                "canonical_source_id": SOURCE_ID,
                "canonical_source_revision": 0,
                "index_generation_id": "foreign-generation",
            })], None)

    store.client = ForeignGeneration()
    with pytest.raises(QdrantError) as error:
        store.inventory_source_page(GENERATION, 10)
    assert error.value.category == "INVENTORY_INVALID"

    class Stalled:
        def scroll(self, **kwargs):
            return ([], 7)

    store.client = Stalled()
    with pytest.raises(QdrantError) as error:
        store.inventory_source_page(GENERATION, 1, "7")
    assert error.value.category == "INVENTORY_STALLED"


@pytest.mark.parametrize("next_offset", [True, "abcd", -1, 2**64, 1.5, [], {}])
def test_qdrant_inventory_rejects_malformed_generated_offsets(next_offset):
    from sme_meeting_ai.rag.qdrant import QdrantError, QdrantVectorStore

    store = object.__new__(QdrantVectorStore)
    store.spec = SimpleNamespace(
        collection_name="isolated-test",
        compatibility=SimpleNamespace(index_generation_id=GENERATION),
    )

    class MalformedOffset:
        def scroll(self, **kwargs):
            return ([], next_offset)

    store.client = MalformedOffset()
    with pytest.raises(QdrantError) as error:
        store.inventory_source_page(GENERATION, 10)
    assert error.value.category == "INVENTORY_CURSOR_INVALID"


def test_qdrant_inventory_detects_semantically_stalled_normalized_cursor():
    from sme_meeting_ai.rag.qdrant import QdrantError, QdrantVectorStore

    store = object.__new__(QdrantVectorStore)
    store.spec = SimpleNamespace(
        collection_name="isolated-test",
        compatibility=SimpleNamespace(index_generation_id=GENERATION),
    )

    class StalledOffset:
        def scroll(self, **kwargs):
            return ([], 7)

    store.client = StalledOffset()
    with pytest.raises(QdrantError) as error:
        store.inventory_source_page(GENERATION, 10, "0007")
    assert error.value.category == "INVENTORY_STALLED"
