import asyncio
import json
import threading
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.integrations.core_api import (
    CoreError,
    KnowledgeClaim,
    KnowledgeCoreApiClient,
    KnowledgeDeliveryStatus,
    KnowledgeIndexGeneration,
    KnowledgeLease,
    KnowledgeSnapshotReference,
    KnowledgeSourceIdentity,
    KnowledgeSourceRevision,
)
from sme_meeting_ai.integrations.knowledge_indexing import decode_notification
from sme_meeting_ai.rag.contracts import ProcessingStatus
from sme_meeting_ai.rag.indexing import IndexingIssue, IndexingResult, IndexingStatus
from sme_meeting_ai.workers import knowledge_indexing as knowledge_worker_module
from sme_meeting_ai.workers.knowledge_indexing import (
    KnowledgeIndexingExecution,
    KnowledgeIndexingWorker,
    KnowledgeLeaseGuard,
    KnowledgeLeaseLost,
    _IndexOutcome,
)


def event():
    meeting_id, source_id, event_id, snapshot_id = (str(uuid4()) for _ in range(4))
    body = {
        "contractVersion": "1.0",
        "schemaVersion": 1,
        "eventId": event_id,
        "occurredAt": "2026-11-10T06:00:00Z",
        "requestId": "resilience-test",
        "meetingId": meeting_id,
        "sourceIdentity": {
            "sourceType": "ACTION_ITEM",
            "sourceId": source_id,
            "meetingId": meeting_id,
        },
        "sourceRevision": {"number": 1},
        "operation": "UPSERT",
        "snapshot": {"snapshotId": snapshot_id, "sha256": "a" * 64, "sizeBytes": 100},
        "indexGeneration": {
            "generationId": "rag-t02-bge-m3-v1",
            "configurationVersion": "rag-t02-bge-m3-v1",
            "configurationSha256": "b" * 64,
            "tokenizerId": "tokenizer-v1",
        },
        "reason": "NEW_REVISION",
    }
    delivery = SimpleNamespace(
        body=json.dumps(body).encode(),
        content_type="application/json",
        delivery_mode=2,
        routing_key="knowledge.indexing.requested",
        exchange="meeting.processing",
        message_id=event_id,
        redelivered=False,
        headers={
            "eventId": event_id,
            "eventType": "KNOWLEDGE_INDEXING_REQUESTED",
            "eventSchemaVersion": 1,
            "x-delivery-count": 0,
        },
    )
    return decode_notification(delivery)


def lifecycle_event(operation="INVALIDATE", reason="ELIGIBILITY_CHANGED"):
    item = event()
    body = item.model_dump(mode="json", by_alias=True)
    body.pop("snapshot")
    body.update(operation=operation, reason=reason)
    return decode_notification(SimpleNamespace(
        body=json.dumps(body).encode(),
        content_type="application/json",
        delivery_mode=2,
        routing_key="knowledge.indexing.requested",
        exchange="meeting.processing",
        message_id=item.event_id,
        redelivered=False,
        headers={
            "eventId": item.event_id,
            "eventType": "KNOWLEDGE_INDEXING_REQUESTED",
            "eventSchemaVersion": 1,
            "x-delivery-count": 0,
        },
    ))


def settings(**overrides):
    return SimpleNamespace(
        knowledge_indexing_worker_concurrency=1,
        knowledge_indexing_retry_delay_seconds=0,
        knowledge_indexing_worker_execution_timeout_seconds=30,
        rabbitmq_delivery_limit=5,
        **overrides,
    )


def status_for(item, state="PENDING", *, attempt=0):
    return KnowledgeDeliveryStatus(
        contractVersion="1.0",
        eventId=item.event_id,
        meetingId=item.meeting_id,
        sourceType=item.source_identity.source_type,
        sourceId=item.source_identity.source_id,
        sourceRevision=item.source_revision.number,
        indexGenerationId=item.index_generation.generation_id,
        state=state,
        acknowledge=state in {"INDEXED", "NO_ELIGIBLE_CONTENT", "TERMINAL_FAILURE", "SUPERSEDED"},
        attemptCount=attempt,
        replay=False,
        resultId=None,
        chunkCount=None,
        receiptSha256=None,
        errorCode=None,
    )


def claim_for(item):
    source_identity = KnowledgeSourceIdentity.model_validate(
        item.source_identity.model_dump(mode="json", by_alias=True)
    )
    source_revision = KnowledgeSourceRevision(number=item.source_revision.number)
    snapshot = KnowledgeSnapshotReference.model_validate(
        item.snapshot.model_dump(mode="json", by_alias=True)
    )
    generation = KnowledgeIndexGeneration.model_validate(
        item.index_generation.model_dump(mode="json", by_alias=True)
    )
    return KnowledgeClaim(
        contractVersion="1.0",
        eventId=item.event_id,
        leaseExpiresAt="2026-11-10T06:30:00Z",
        serverTime="2026-11-10T06:00:00Z",
        renewAfterSeconds=600,
        meetingId=item.meeting_id,
        sourceIdentity=source_identity,
        sourceRevision=source_revision,
        snapshot=snapshot,
        indexGeneration=generation,
        claimToken=str(uuid4()),
        leaseSeconds=1800,
        replay=False,
    )


class Delivery:
    def __init__(self, item, *, count=0, cancel_ack=False):
        self.body = json.dumps(item.model_dump(mode="json", by_alias=True)).encode()
        self.content_type = "application/json"
        self.delivery_mode = 2
        self.routing_key = "knowledge.indexing.requested"
        self.exchange = "meeting.processing"
        self.message_id = item.event_id
        self.headers = {
            "eventId": item.event_id,
            "eventType": "KNOWLEDGE_INDEXING_REQUESTED",
            "eventSchemaVersion": 1,
            "x-delivery-count": count,
        }
        self.redelivered = count > 0
        self.acked = 0
        self.nacked = []
        self.rejected = []
        self.cancel_ack = cancel_ack

    async def ack(self):
        self.acked += 1
        if self.cancel_ack:
            raise asyncio.CancelledError()

    async def nack(self, *, requeue):
        self.nacked.append(requeue)

    async def reject(self, *, requeue):
        self.rejected.append(requeue)


class FakeCore:
    def __init__(self, item):
        self.item = item
        self.state = "PENDING"
        self.claim_count = 0
        self.result_count = 0
        self.permit_count = 0
        self.started_permits = []
        self.completed_permits = []

    async def lookup(self, _event, **_options):
        return status_for(self.item, self.state, attempt=self.claim_count)

    async def claim(self, _event, *, claim_request_id):
        del claim_request_id
        if self.state in {"INDEXED", "NO_ELIGIBLE_CONTENT", "TERMINAL_FAILURE", "SUPERSEDED"}:
            return status_for(self.item, self.state, attempt=self.claim_count)
        self.claim_count += 1
        return claim_for(self.item)

    async def renew(self, _event, _claim, **_options):
        return KnowledgeLease(
            contractVersion="1.0",
            eventId=self.item.event_id,
            leaseExpiresAt="2026-11-10T06:30:00Z",
            serverTime="2026-11-10T06:00:00Z",
            renewAfterSeconds=600,
        )

    async def result(self, _event, _claim, *, state, **_options):
        self.result_count += 1
        self.state = state
        return status_for(self.item, state, attempt=self.claim_count)

    async def acquire_write_permit(self, _event, _claim, **_options):
        self.permit_count += 1
        return SimpleNamespace(
            permitId=str(uuid4()),
            state="RESERVED",
            mutationExecutionId=str(uuid4()),
        )

    async def start_write_permit(self, _event, _claim, permit, **_options):
        self.started_permits.append(permit.permitId)
        return SimpleNamespace(
            permitId=permit.permitId,
            state="RUNNING",
            mutationExecutionId=permit.mutationExecutionId,
        )

    async def complete_write_permit(self, _event, _claim, permit, *, state, outcome_code, **_options):
        self.completed_permits.append((permit.permitId, state, outcome_code))
        return SimpleNamespace(permitId=permit.permitId, state=state)


def worker_for(item, core):
    worker = KnowledgeIndexingWorker(
        settings(),
        core,
        None,
        SimpleNamespace(index_generation=item.index_generation),
        None,
    )

    async def snapshot(_event, _claim, _guard):
        return SimpleNamespace()

    worker._snapshot = snapshot
    worker._process = lambda _snapshot: _IndexOutcome("INDEXED", 1, (str(uuid4()),))
    return worker


@pytest.mark.parametrize("count,method,expected", [
    (4, "nack", [True]),
    (5, "reject", [False]),
    (True, "reject", [False]),
])
def test_delivery_failure_handling_is_bounded_at_the_broker_limit(count, method, expected):
    async def run():
        item = event()
        worker = worker_for(item, FakeCore(item))
        delivery = Delivery(item, count=count)
        await worker._unresolved(delivery, delay=0)
        assert getattr(delivery, f"{method}ed" if method == "nack" else "rejected") == expected
        assert not delivery.acked

    asyncio.run(run())


def test_duplicate_delivery_is_idempotently_acked_after_the_first_durable_result():
    async def run():
        item = event()
        core = FakeCore(item)
        worker = worker_for(item, core)
        first, second = Delivery(item), Delivery(item, count=1)

        await asyncio.gather(worker.handle(first), worker.handle(second))

        assert core.claim_count == 1
        assert core.result_count == 1
        assert first.acked == second.acked == 1
        assert not first.nacked and not second.nacked
        assert not first.rejected and not second.rejected

    asyncio.run(run())


def test_result_persisted_before_ack_is_recovered_by_lookup_after_worker_cancellation():
    async def run():
        item = event()
        core = FakeCore(item)
        worker = worker_for(item, core)
        crashed = Delivery(item, cancel_ack=True)

        with pytest.raises(asyncio.CancelledError):
            await worker.handle(crashed)
        assert core.state == "INDEXED"
        assert core.result_count == 1
        assert crashed.acked == 1
        assert not crashed.nacked and not crashed.rejected

        recovered = Delivery(item, count=1)
        await worker.handle(recovered)
        assert core.claim_count == 1
        assert core.result_count == 1
        assert recovered.acked == 1

    asyncio.run(run())


def test_lease_loss_stops_protected_work_without_submitting_a_late_result():
    async def run():
        item = event()

        class LeaseFailureCore:
            async def renew(self, *_args, **_kwargs):
                raise CoreError(409, "WORKER_LEASE_LOST")

        claim = claim_for(item)
        guard = KnowledgeLeaseGuard(LeaseFailureCore(), item, claim, 0, 30)
        guard.renew_after = 0
        try:
            with pytest.raises(KnowledgeLeaseLost):
                await guard.protect(asyncio.sleep(10))
        finally:
            await guard.close()

    asyncio.run(run())


def test_cancelled_asyncio_waiter_leaves_permit_open_until_qdrant_thread_returns():
    async def run():
        item = event()
        core = FakeCore(item)
        worker = worker_for(item, core)
        claim = claim_for(item)
        entered = threading.Event()
        release = threading.Event()

        class Guard:
            deadline = 60.0

            def __init__(self):
                self.lost = asyncio.Event()

            async def protect(self, awaitable):
                return await awaitable

            def live(self):
                return True

        def blocked_mutation():
            entered.set()
            release.wait(5)
            return _IndexOutcome("INDEXED", 1, (str(uuid4()),))

        task = asyncio.create_task(worker._run_permitted_mutation(
            item, claim, Guard(), blocked_mutation,
        ))
        await asyncio.to_thread(entered.wait, 1)
        assert len(core.started_permits) == 1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert core.completed_permits == []

        release.set()
        assert await worker.wait_for_mutations(2)
        assert core.completed_permits[0][1:] == ("SUCCEEDED", "NONE")

    asyncio.run(run())


def test_qdrant_unavailability_is_retryable_but_schema_rejection_is_terminal():
    item = event()
    worker = worker_for(item, FakeCore(item))
    processing = SimpleNamespace(status=ProcessingStatus.PROCESSED, chunks=(object(),))

    class Engine:
        def __init__(self, result):
            self.result = result

        def index(self, _processing):
            return self.result

    worker.engine = Engine(IndexingResult(
        status=IndexingStatus.FAILED,
        chunk_count=1,
        attempted_count=1,
        persisted_count=0,
        issues=(IndexingIssue(code="QDRANT_UNAVAILABLE", severity="ERROR"),),
    ))
    worker._process = KnowledgeIndexingWorker._process.__get__(worker)
    # The production method only needs the processed status and engine result here.
    worker_module_processing = __import__(
        "sme_meeting_ai.workers.knowledge_indexing", fromlist=["process_snapshot"]
    )
    original = worker_module_processing.process_snapshot
    worker_module_processing.process_snapshot = lambda *_args, **_kwargs: processing
    try:
        retryable = worker._process(SimpleNamespace())
        assert retryable.state == "RETRYABLE_FAILURE"
        assert retryable.error_code == "QDRANT_UNAVAILABLE"

        worker.engine = Engine(IndexingResult(
            status=IndexingStatus.REJECTED,
            chunk_count=1,
            attempted_count=0,
            persisted_count=0,
            issues=(IndexingIssue(code="SCHEMA_INCOMPATIBLE", severity="ERROR"),),
        ))
        terminal = worker._process(SimpleNamespace())
        assert terminal.state == "TERMINAL_FAILURE"
        assert terminal.error_code == "SCHEMA_INCOMPATIBLE"
    finally:
        worker_module_processing.process_snapshot = original


def test_knowledge_worker_validates_its_generation_collection_before_consuming(monkeypatch, tmp_path):
    order = []
    settings_value = Settings(
        service_name="test-ai",
        service_identity="ai-worker",
        _env_file=None,
        knowledge_indexing_worker_enabled=True,
        rag_model_path=tmp_path,
    )
    generation = SimpleNamespace(
        generation_id=settings_value.rag_index_generation_id,
        configuration_sha256="c" * 64,
    )

    class FakeTokenizer:
        def __init__(self, _path):
            self.manifest = SimpleNamespace()

    class FakeChunking:
        index_generation = generation

    class FakeEmbedding:
        compatibility = SimpleNamespace(index_generation_id=generation.generation_id)

        @classmethod
        def from_settings(cls, _settings, *, tokenizer):
            del tokenizer
            return cls()

        def close(self):
            order.append("embedding-close")

    class FakeStore:
        @classmethod
        def from_settings(cls, _settings, _compatibility):
            return cls()

        def ensure_schema(self):
            order.append("schema")

        def close(self):
            order.append("store-close")

    class FakeCore:
        def __init__(self, _settings):
            pass

        async def aclose(self):
            order.append("core-close")

    class FakeBroker:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            assert order == ["schema"]
            order.append("broker-enter")
            return self

        async def __aexit__(self, *_args):
            order.append("broker-exit")

    monkeypatch.setattr(knowledge_worker_module, "BgeM3Tokenizer", FakeTokenizer)
    monkeypatch.setattr(knowledge_worker_module, "bge_m3_chunking_config", lambda *_args, **_kwargs: FakeChunking())
    monkeypatch.setattr("sme_meeting_ai.rag.embedding.BgeM3EmbeddingAdapter", FakeEmbedding)
    monkeypatch.setattr("sme_meeting_ai.rag.qdrant.QdrantVectorStore", FakeStore)
    monkeypatch.setattr(knowledge_worker_module, "KnowledgeCoreApiClient", FakeCore)
    monkeypatch.setattr(knowledge_worker_module, "RabbitConsumer", FakeBroker)

    async def run():
        execution = KnowledgeIndexingExecution(settings_value)
        await execution.__aenter__()
        try:
            assert order[:2] == ["schema", "broker-enter"]
        finally:
            await execution.__aexit__(None, None, None)

    asyncio.run(run())


def test_lifecycle_operations_use_exact_qdrant_source_scope():
    item = lifecycle_event()
    calls = []

    class Store:
        def invalidate_source(self, *args):
            calls.append(("invalidate", args))
            return 2

        def delete_source(self, *args):
            calls.append(("delete", args))
            return 2

    worker = worker_for(item, FakeCore(item))
    worker.engine = SimpleNamespace(store=Store())

    outcome = worker._process_lifecycle(item)

    assert outcome.state == "INVALIDATED"
    assert outcome.chunk_count == 0
    assert calls == [(
        "invalidate",
        (item.meeting_id, item.source_identity.source_type, item.source_identity.source_id,
         item.source_revision.number, item.index_generation.generation_id),
    )]


def test_core_knowledge_api_retries_temporary_unavailability_with_a_bounded_budget():
    async def run():
        item = event()
        calls = []
        durable = status_for(item, "INDEXED", attempt=1).model_dump(mode="json", by_alias=True)

        async def handler(_request):
            calls.append(True)
            if len(calls) < 3:
                return httpx.Response(
                    503,
                    json={"success": False, "code": "SERVICE_UNAVAILABLE", "message": "safe", "data": None},
                    headers={"cache-control": "no-store"},
                )
            return httpx.Response(
                200,
                json={"success": True, "code": "OK", "message": "safe", "data": durable},
                headers={"cache-control": "no-store"},
            )

        configuration = Settings(
            service_name="test-ai",
            service_identity="knowledge-worker",
            _env_file=None,
            core_api_base_url="https://core.test",
            core_api_max_attempts=3,
            core_api_timeout_seconds=1,
            core_api_connect_timeout_seconds=1,
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = KnowledgeCoreApiClient(configuration, client=http, sleep=lambda _delay: asyncio.sleep(0))
            result = await client.lookup(item)
        assert result.durable
        assert len(calls) == 3

    asyncio.run(run())
