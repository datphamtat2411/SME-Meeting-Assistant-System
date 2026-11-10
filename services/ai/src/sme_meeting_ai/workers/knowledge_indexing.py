"""Core-fenced RabbitMQ worker for the T05 knowledge indexing pipeline."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
from contextlib import AsyncExitStack
from datetime import datetime
from uuid import UUID, uuid4, uuid5

from pydantic import ValidationError

from sme_meeting_ai.integrations.core_api import (
    CoreError,
    KnowledgeClaim,
    KnowledgeCoreApiClient,
    KnowledgeDeliveryStatus,
    KnowledgeLease,
    strict_json,
)
from sme_meeting_ai.integrations.knowledge_indexing import (
    KnowledgeIndexingEvent,
    decode_notification,
)
from sme_meeting_ai.integrations.messaging import MessageError, RabbitConsumer
from sme_meeting_ai.observability.context import (
    correlation_scope,
    new_correlation_context,
)
from sme_meeting_ai.observability.logging import log_event
from sme_meeting_ai.rag.contracts import (
    IndexGeneration,
    KnowledgeSnapshot,
    ProcessingStatus,
    SnapshotIntegrity,
)
from sme_meeting_ai.rag.indexing import (
    IndexingResult,
    IndexingStatus,
    KnowledgeIndexingEngine,
)
from sme_meeting_ai.rag.processing import (
    KnowledgeContractError,
    process_snapshot,
    validate_snapshot,
)
from sme_meeting_ai.rag.tokenizer import BgeM3Tokenizer, bge_m3_chunking_config

logger = logging.getLogger(__name__)

_RETRYABLE_CORE_CODES = frozenset({
    "WORKER_DELIVERY_NOT_PUBLISHED",
    "WORKER_ATTEMPT_BUSY",
    "WORKER_RETRY_BACKOFF",
    "WORKER_LEASE_LOST",
    "SERVICE_UNAVAILABLE",
    "WORKER_TRANSPORT",
    "WORKER_RESPONSE_INVALID",
})
_PERMANENT_CORE_CODES = frozenset({
    "WORKER_DELIVERY_UNKNOWN",
    "WORKER_DELIVERY_NOT_FOUND",
    "WORKER_IDENTITY_CONFLICT",
    "WORKER_GENERATION_CONFLICT",
    "WORKER_RESULT_CONFLICT",
    "WORKER_CONTRACT_UNSUPPORTED",
    "VALIDATION_ERROR",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
})
_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,79}$")


class KnowledgeWorkerFailure(Exception):
    """A bounded failure that can be represented by the Core result contract."""

    def __init__(self, code: str, *, retryable: bool):
        self.code = code if _ERROR_CODE.fullmatch(code) else "KNOWLEDGE_WORKER_FAILURE"
        self.retryable = retryable
        super().__init__(self.code)


class KnowledgeLeaseLost(CoreError):
    def __init__(self):
        super().__init__(409, "WORKER_LEASE_LOST")


def indexing_receipt(
    *,
    event_id: str,
    meeting_id: str,
    source_type: str,
    source_id: str,
    source_revision: int,
    snapshot_id: str,
    snapshot_sha256: str,
    snapshot_size_bytes: int,
    generation_id: str,
    configuration_version: str,
    configuration_sha256: str,
    tokenizer_id: str,
    outcome: str,
    chunk_count: int,
    point_ids: tuple[str, ...] = (),
    error_code: str = "NONE",
) -> str:
    """Hash the canonical, content-free receipt manifest used by Core results."""

    manifest = {
        "contractVersion": "1.0",
        "eventId": event_id,
        "meetingId": meeting_id,
        "sourceType": source_type,
        "sourceId": source_id,
        "sourceRevision": source_revision,
        "snapshotId": snapshot_id,
        "snapshotSha256": snapshot_sha256,
        "snapshotSizeBytes": snapshot_size_bytes,
        "generationId": generation_id,
        "configurationVersion": configuration_version,
        "configurationSha256": configuration_sha256,
        "tokenizerId": tokenizer_id,
        "outcome": outcome,
        "chunkCount": chunk_count,
        "pointIds": sorted(set(point_ids)),
        "errorCode": error_code,
    }
    raw = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


class KnowledgeLeaseGuard:
    """Renew a Core lease and fence local work immediately when renewal fails."""

    def __init__(self, core, event, claim: KnowledgeClaim, round_trip: float, maximum_seconds: float):
        self.core = core
        self.event = event
        self.claim = claim
        self.lost = asyncio.Event()
        self.core_stop = False
        self._maximum = asyncio.get_running_loop().time() + maximum_seconds
        self.deadline = 0.0
        self.renew_after = 1.0
        self._confirm(claim, round_trip)
        self.task = asyncio.create_task(self._renew())

    def _confirm(self, lease: KnowledgeLease, round_trip: float) -> None:
        try:
            remaining = (
                datetime.fromisoformat(lease.leaseExpiresAt.replace("Z", "+00:00"))
                - datetime.fromisoformat(lease.serverTime.replace("Z", "+00:00"))
            ).total_seconds()
        except (TypeError, ValueError, OverflowError):
            self.lose()
            return
        self.deadline = min(
            self._maximum,
            asyncio.get_running_loop().time() + remaining - max(0.0, round_trip) - 5,
        )
        self.renew_after = max(1.0, min(float(lease.renewAfterSeconds), max(1.0, remaining / 2)))
        if self.deadline <= asyncio.get_running_loop().time():
            self.lose()

    def lose(self) -> None:
        self.lost.set()

    def live(self) -> bool:
        if asyncio.get_running_loop().time() >= self.deadline:
            self.lose()
        return not self.lost.is_set()

    async def _renew(self) -> None:
        try:
            while self.live():
                remaining = self.deadline - asyncio.get_running_loop().time()
                await asyncio.sleep(min(self.renew_after, max(0.0, remaining)))
                if not self.live():
                    return
                started = asyncio.get_running_loop().time()
                renewed = await self.core.renew(self.event, self.claim, deadline=self.deadline)
                self._confirm(renewed, asyncio.get_running_loop().time() - started)
        except CoreError as error:
            self.core_stop = error.stop_intake
            self.lose()
        except Exception:
            self.lose()

    async def protect(self, awaitable):
        task = asyncio.ensure_future(awaitable)
        lost = asyncio.create_task(self.lost.wait())
        try:
            done, _ = await asyncio.wait((task, lost), return_when=asyncio.FIRST_COMPLETED)
            if lost in done or not self.live():
                raise KnowledgeLeaseLost()
            return await task
        finally:
            lost.cancel()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, lost, return_exceptions=True)

    async def close(self) -> None:
        self.lose()
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


class _IndexOutcome:
    def __init__(self, state: str, chunk_count: int, point_ids=(), error_code="NONE"):
        self.state = state
        self.chunk_count = chunk_count
        self.point_ids = tuple(point_ids)
        self.error_code = error_code


class KnowledgeIndexingWorker:
    """At-least-once consumer whose authority comes only from Core claims."""

    def __init__(self, settings, core, tokenizer, chunking, engine):
        self.settings = settings
        self.core = core
        self.tokenizer = tokenizer
        self.chunking = chunking
        self.engine: KnowledgeIndexingEngine = engine
        self.stop_intake = asyncio.Event()
        self._slots = asyncio.Semaphore(settings.knowledge_indexing_worker_concurrency)
        self._event_locks: dict[str, asyncio.Lock] = {}
        self._closed = False

    @property
    def generation(self) -> IndexGeneration:
        return self.chunking.index_generation

    def _event_lock(self, event_id: str) -> asyncio.Lock:
        return self._event_locks.setdefault(event_id, asyncio.Lock())

    def _validate_generation(self, event: KnowledgeIndexingEvent) -> None:
        if event.index_generation != self.generation:
            raise KnowledgeWorkerFailure("WORKER_GENERATION_CONFLICT", retryable=False)

    async def _delay(self, seconds: float, shutdown_requested) -> bool:
        seconds = max(0.0, min(30.0, seconds))
        if shutdown_requested is None:
            await asyncio.sleep(seconds)
            return True
        try:
            await asyncio.wait_for(shutdown_requested.wait(), seconds)
        except TimeoutError:
            return True
        return False

    async def _unresolved(self, delivery, *, shutdown_requested=None, delay=0.0, dead=False):
        headers = getattr(delivery, "headers", {}) or {}
        count = headers.get("x-delivery-count", 0)
        if getattr(delivery, "redelivered", False) and "x-delivery-count" not in headers:
            dead = True
        if type(count) is not int or count < 0:
            dead = True
        if dead or (type(count) is int and count >= self.settings.rabbitmq_delivery_limit):
            await delivery.reject(requeue=False)
            return
        if not await self._delay(delay, shutdown_requested):
            return
        await delivery.nack(requeue=True)

    async def _snapshot(self, event, claim, guard):
        response = await guard.protect(self.core.snapshot(event, claim, deadline=guard.deadline))
        reference = event.snapshot
        if (
            response.snapshot_id != reference.snapshot_id
            or response.sha256 != reference.sha256
            or response.size_bytes != reference.size_bytes
            or len(response.bytes) != reference.size_bytes
            or not hmac.compare_digest(hashlib.sha256(response.bytes).hexdigest(), reference.sha256)
        ):
            raise KnowledgeWorkerFailure("SNAPSHOT_INTEGRITY_INVALID", retryable=False)
        try:
            value = strict_json(response.bytes, 8 * 1024 * 1024)
            snapshot = validate_snapshot(value)
        except (UnicodeDecodeError, ValueError, TypeError, RecursionError, ValidationError, KnowledgeContractError):
            raise KnowledgeWorkerFailure("SNAPSHOT_CONTRACT_INVALID", retryable=False) from None
        metadata = snapshot.metadata
        if (
            metadata.snapshot_id != reference.snapshot_id
            or metadata.meeting_id != event.meeting_id
            or metadata.source_identity != event.source_identity
            or metadata.source_revision.number != event.source_revision.number
            or snapshot.snapshot_type != event.source_identity.source_type
        ):
            raise KnowledgeWorkerFailure("SNAPSHOT_IDENTITY_MISMATCH", retryable=False)
        if metadata.integrity is not None and (
            metadata.integrity.sha256 != reference.sha256 or metadata.integrity.size_bytes != reference.size_bytes
        ):
            raise KnowledgeWorkerFailure("SNAPSHOT_INTEGRITY_MISMATCH", retryable=False)
        integrity = SnapshotIntegrity(sha256=reference.sha256, sizeBytes=reference.size_bytes)
        return snapshot.model_copy(update={"metadata": metadata.model_copy(update={"integrity": integrity})})

    def _process(self, snapshot: KnowledgeSnapshot) -> _IndexOutcome:
        processing = process_snapshot(snapshot, token_counter=self.tokenizer, config=self.chunking)
        if processing.status is ProcessingStatus.NO_ELIGIBLE_CONTENT:
            return _IndexOutcome("NO_ELIGIBLE_CONTENT", 0)
        if processing.status is not ProcessingStatus.PROCESSED:
            return _IndexOutcome("TERMINAL_FAILURE", 0, error_code=f"PROCESSING_{processing.status.value}")
        result: IndexingResult = self.engine.index(processing)
        if result.status is IndexingStatus.INDEXED and result.persisted_count == result.chunk_count:
            return _IndexOutcome("INDEXED", result.chunk_count, result.point_ids)
        issue = result.issues[0].code if result.issues else "INDEXING_FAILED"
        if result.status is IndexingStatus.REJECTED:
            return _IndexOutcome("TERMINAL_FAILURE", 0, result.point_ids, issue)
        return _IndexOutcome("RETRYABLE_FAILURE", 0, result.point_ids, issue)

    async def _submit(self, event, claim, snapshot, outcome, guard):
        error_code = outcome.error_code
        receipt = indexing_receipt(
            event_id=event.event_id,
            meeting_id=event.meeting_id,
            source_type=event.source_identity.source_type,
            source_id=event.source_identity.source_id,
            source_revision=event.source_revision.number,
            snapshot_id=event.snapshot.snapshot_id,
            snapshot_sha256=event.snapshot.sha256,
            snapshot_size_bytes=event.snapshot.size_bytes,
            generation_id=event.index_generation.generation_id,
            configuration_version=event.index_generation.configuration_version,
            configuration_sha256=event.index_generation.configuration_sha256,
            tokenizer_id=event.index_generation.tokenizer_id,
            outcome=outcome.state,
            chunk_count=outcome.chunk_count,
            point_ids=outcome.point_ids,
            error_code=error_code,
        )
        result_id = str(uuid5(
            UUID(event.event_id),
            f"knowledge-indexing-result-v1:{claim.claimToken.get_secret_value()}:{receipt}",
        ))
        status = await guard.protect(self.core.result(
            event,
            claim,
            result_id=result_id,
            state=outcome.state,
            index_generation_id=event.index_generation.generation_id,
            chunk_count=outcome.chunk_count if outcome.state == "INDEXED" else 0,
            receipt_sha256=receipt,
            error_code=error_code,
            deadline=guard.deadline,
        ))
        return status

    async def _process_delivery(self, delivery, event, shutdown_requested):
        self._validate_generation(event)
        status = await self.core.lookup(event)
        if status.durable:
            await delivery.ack()
            return
        if shutdown_requested.is_set():
            return
        claim_request_id = uuid4()
        started = asyncio.get_running_loop().time()
        claim = await self.core.claim(event, claim_request_id=claim_request_id)
        if isinstance(claim, KnowledgeDeliveryStatus):
            if claim.durable:
                await delivery.ack()
            else:
                await self._unresolved(
                    delivery,
                    shutdown_requested=shutdown_requested,
                    delay=self.settings.knowledge_indexing_retry_delay_seconds,
                )
            return
        guard = KnowledgeLeaseGuard(
            self.core,
            event,
            claim,
            asyncio.get_running_loop().time() - started,
            self.settings.knowledge_indexing_worker_execution_timeout_seconds,
        )
        try:
            if not guard.live():
                raise KnowledgeLeaseLost()
            try:
                snapshot = await self._snapshot(event, claim, guard)
                outcome = await guard.protect(asyncio.to_thread(self._process, snapshot))
            except KnowledgeWorkerFailure as failure:
                outcome = _IndexOutcome("RETRYABLE_FAILURE" if failure.retryable else "TERMINAL_FAILURE", 0,
                                        error_code=failure.code)
            if not guard.live():
                raise KnowledgeLeaseLost()
            status = await self._submit(event, claim, snapshot if "snapshot" in locals() else None, outcome, guard)
            if status.durable:
                await delivery.ack()
            elif status.state == "RETRYABLE_FAILURE":
                await self._unresolved(
                    delivery,
                    shutdown_requested=shutdown_requested,
                    delay=self.settings.knowledge_indexing_retry_delay_seconds,
                )
            else:
                await self._unresolved(
                    delivery,
                    shutdown_requested=shutdown_requested,
                    delay=self.settings.knowledge_indexing_retry_delay_seconds,
                )
        finally:
            await guard.close()

    def _temporary(self, error: CoreError) -> bool:
        return error.code in _RETRYABLE_CORE_CODES or error.retryable or error.status >= 500

    async def handle(self, delivery, shutdown_requested=None):
        await self._slots.acquire()
        event = None
        try:
            event = decode_notification(delivery)
            if shutdown_requested is None:
                shutdown_requested = asyncio.Event()
            async with self._event_lock(event.event_id):
                with correlation_scope(new_correlation_context(request_id=event.request_id, job_id=event.meeting_id)):
                    await self._process_delivery(delivery, event, shutdown_requested)
        except MessageError:
            await delivery.reject(requeue=False)
        except KnowledgeWorkerFailure:
            await delivery.reject(requeue=False)
        except CoreError as error:
            if error.stop_intake:
                self.stop_intake.set()
            if event is not None:
                try:
                    status = await self.core.lookup(event)
                    if status.durable:
                        await delivery.ack()
                        return
                except CoreError as lookup_error:
                    if lookup_error.stop_intake:
                        self.stop_intake.set()
            await self._unresolved(
                delivery,
                shutdown_requested=shutdown_requested,
                delay=max(self.settings.knowledge_indexing_retry_delay_seconds, error.retry_after),
                dead=error.code in _PERMANENT_CORE_CODES and not self._temporary(error),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            self.stop_intake.set()
            await self._unresolved(
                delivery,
                shutdown_requested=shutdown_requested,
                delay=self.settings.knowledge_indexing_retry_delay_seconds,
            )
        finally:
            self._slots.release()

    async def run(self, broker, shutdown_requested):
        await broker.start(lambda delivery: self.handle(delivery, shutdown_requested))
        log_event(logger, logging.INFO, "worker.knowledge_indexing.consuming")
        waits = [asyncio.create_task(event.wait()) for event in (
            shutdown_requested, self.stop_intake, broker.failure,
        )]
        closed = asyncio.ensure_future(asyncio.shield(broker.connection.closed()))
        try:
            await asyncio.wait((*waits, closed), return_when=asyncio.FIRST_COMPLETED)
            await broker.stop()
            await broker.drain()
            if self.stop_intake.is_set() or broker.failure.is_set() or closed.done():
                raise RuntimeError("worker.knowledge_indexing.stopped")
        finally:
            await broker.stop()
            for wait in (*waits, closed):
                wait.cancel()
            await asyncio.gather(*waits, closed, return_exceptions=True)


class KnowledgeIndexingExecution:
    """Runtime-owned model, Core, Qdrant, and broker resources."""

    def __init__(self, settings):
        self.settings = settings
        self.resources = AsyncExitStack()
        self.tokenizer = None
        self.adapter = None
        self.store = None
        self.core = None
        self.broker = None
        self.worker = None
        self._exited = False

    async def __aenter__(self):
        try:
            if not self.settings.knowledge_indexing_worker_enabled:
                raise ValueError
            if self.settings.rag_model_path is None:
                raise ValueError
            self.tokenizer = BgeM3Tokenizer(self.settings.rag_model_path)
            chunking = bge_m3_chunking_config(
                self.tokenizer,
                max_tokens=self.settings.rag_embedding_max_input_tokens,
                target_tokens=self.settings.rag_chunk_target_tokens,
                generation_id=self.settings.rag_index_generation_id,
                configuration_version=self.settings.rag_index_configuration_version,
            )
            configured_sha = self.settings.rag_index_configuration_sha256 or chunking.index_generation.configuration_sha256
            if chunking.index_generation.configuration_sha256 != configured_sha:
                raise ValueError
            from sme_meeting_ai.rag.embedding import BgeM3EmbeddingAdapter
            from sme_meeting_ai.rag.qdrant import QdrantVectorStore

            self.adapter = BgeM3EmbeddingAdapter.from_settings(self.settings, tokenizer=self.tokenizer)
            self.store = QdrantVectorStore.from_settings(self.settings, self.adapter.compatibility)
            self.core = KnowledgeCoreApiClient(self.settings)
            self.resources.push_async_callback(self.core.aclose)
            self.broker = await self.resources.enter_async_context(RabbitConsumer(
                self.settings,
                queue_name=self.settings.knowledge_indexing_queue,
                prefetch=self.settings.knowledge_indexing_worker_concurrency,
            ))
            self.worker = KnowledgeIndexingWorker(
                self.settings,
                self.core,
                self.tokenizer,
                chunking,
                KnowledgeIndexingEngine(
                    self.adapter,
                    self.store,
                    token_counter=self.tokenizer,
                    batch_size=self.settings.rag_qdrant_upsert_batch_size,
                    expected_generation_id=self.settings.rag_index_generation_id,
                ),
            )
            return self
        except asyncio.CancelledError:
            await self.__aexit__(None, None, None)
            raise
        except Exception:
            await self.__aexit__(None, None, None)
            raise RuntimeError("worker.knowledge_indexing.startup.failed")

    async def __call__(self, shutdown_requested):
        await self.worker.run(self.broker, shutdown_requested)

    async def __aexit__(self, *_):
        if self._exited:
            return
        self._exited = True
        await self.resources.aclose()
        if self.adapter is not None:
            self.adapter.close()
        if self.store is not None:
            self.store.close()
