"""Dedicated Meeting Intelligence execution and broker disposition."""

import asyncio
import hashlib
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import AsyncExitStack, ExitStack
from datetime import datetime
from uuid import uuid4

from sme_meeting_ai.integrations.core_api import CoreError, strict_json
from sme_meeting_ai.integrations.intelligence import (
    QUEUE,
    IntelligenceClaim,
    IntelligenceCoreClient,
    IntelligenceStatus,
    decode_notification,
    owner_fields,
)
from sme_meeting_ai.integrations.messaging import MessageError, RabbitConsumer
from sme_meeting_ai.integrations.object_storage import ObjectStorage, StorageError
from sme_meeting_ai.meeting_intelligence.action_item_contract import (
    prepare_action_item_request,
)
from sme_meeting_ai.meeting_intelligence.action_items import build_action_item_processor
from sme_meeting_ai.meeting_intelligence.decision import build_decision_processor
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
from sme_meeting_ai.meeting_intelligence.processor import StageContext
from sme_meeting_ai.meeting_intelligence.result import ResultError, serialize_result
from sme_meeting_ai.meeting_intelligence.source import (
    SourceIntegrityError,
    verify_snapshot,
)
from sme_meeting_ai.meeting_intelligence.summary import build_summary_processor
from sme_meeting_ai.observability.context import (
    correlation_scope,
    new_correlation_context,
)
from sme_meeting_ai.observability.logging import log_event

logger = logging.getLogger(__name__)


class LeaseGuard:
    def __init__(self, core, event, claim, elapsed, maximum):
        self.core, self.event, self.claim, self.maximum = core, event, claim, maximum
        self.fence = threading.Event()
        self.lost = asyncio.Event()
        self.timer = None
        self.deadline = 0
        self.confirm(claim, elapsed)
        self.task = asyncio.create_task(self.renew())

    def lose(self):
        self.fence.set()
        self.lost.set()

    def live(self):
        if asyncio.get_running_loop().time() >= self.deadline:
            self.lose()
        return not self.fence.is_set()

    def confirm(self, lease, elapsed):
        now = asyncio.get_running_loop().time()
        seconds = (datetime.fromisoformat(lease.leaseExpiresAt) - datetime.fromisoformat(lease.serverTime)).total_seconds()
        self.deadline = min(self.maximum, now + min(seconds, lease.leaseSeconds) - elapsed - min(1, max(0, seconds / 10)))
        self.renew_after = lease.renewAfterSeconds
        if self.timer:
            self.timer.cancel()
        self.timer = asyncio.get_running_loop().call_at(self.deadline, self.lose)
        self.live()

    async def renew(self):
        try:
            while self.live():
                await asyncio.sleep(min(self.renew_after, max(0, self.deadline - asyncio.get_running_loop().time())))
                if not self.live():
                    break
                start = asyncio.get_running_loop().time()
                lease = await self.core.request(self.event, "renew", owner_fields(self.claim), deadline=self.deadline)
                if not self.live():
                    break
                self.confirm(lease, asyncio.get_running_loop().time() - start)
        except Exception:
            self.lose()

    async def protect(self, awaitable):
        task = asyncio.ensure_future(awaitable)
        lost = asyncio.create_task(self.lost.wait())
        try:
            await asyncio.wait((task, lost), return_when=asyncio.FIRST_COMPLETED)
            if not self.live():
                raise CoreError(409, "WORKER_LEASE_LOST")
            return await task
        finally:
            lost.cancel()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, lost, return_exceptions=True)

    async def close(self):
        self.lose()
        if self.timer:
            self.timer.cancel()
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


class WorkFailure(Exception):
    def __init__(self, phase, category):
        self.phase, self.category = phase, category
        super().__init__("INTELLIGENCE_WORK_FAILED")


def validate_provider_credentials(settings):
    """Reject an enabled real inference worker before it starts consuming work."""
    if not (settings.meeting_intelligence_worker_enabled and settings.meeting_intelligence_inference_enabled):
        return
    secret = settings.openrouter_api_key
    key = "" if secret is None else secret.get_secret_value()
    if not key or any(ord(char) < 33 or ord(char) > 126 for char in key):
        raise ValueError("Meeting Intelligence provider credential is required")


def _worker_category(category):
    """Map feature-local failures to the existing Intelligence worker contract."""
    if category in {"VALIDATION", "RESOURCE", "TIMEOUT", "PROVIDER", "TRANSPORT", "RATE_LIMIT",
                    "AUTHENTICATION", "CONFIGURATION", "MALFORMED_OUTPUT", "INTEGRITY",
                    "NOT_FOUND", "EMPTY_OUTPUT", "CANCELLED"}:
        return category
    if category in {"INVALID_SOURCE", "INVALID_REFERENCE", "GROUNDING_FAILURE"}:
        return "VALIDATION"
    if category in {"CONTEXT_BUDGET", "DEADLINE"}:
        return "TIMEOUT" if category == "DEADLINE" else "RESOURCE"
    if category in {"UNSUPPORTED_SCHEMA", "UNSUPPORTED_PARAMETERS", "INFERENCE_DISABLED"}:
        return "CONFIGURATION"
    if category in {"SCHEMA_MISMATCH", "INCOMPLETE_OUTPUT", "REFUSAL"}:
        return "MALFORMED_OUTPUT"
    return "RESOURCE"


def production_processors(settings, adapter=None):
    """Return only explicitly enabled production capability processors."""
    if not (settings.meeting_intelligence_worker_enabled
            and settings.meeting_intelligence_inference_enabled and adapter is not None):
        return {}
    processors = {}
    if settings.meeting_intelligence_summary_enabled:
        processors["GENERATING_SUMMARY"] = build_summary_processor(settings, adapter)
    if settings.meeting_intelligence_decision_enabled:
        processors["EXTRACTING_DECISIONS"] = build_decision_processor(settings, adapter)
    if settings.meeting_intelligence_action_item_enabled:
        processors["EXTRACTING_ACTION_ITEMS"] = build_action_item_processor(settings, adapter)
    return processors


class IntelligenceWorker:
    def __init__(self, settings, core, storage, processors):
        self.settings, self.core, self.storage, self.processors = settings, core, storage, dict(processors)
        self.stop_intake = asyncio.Event()
        self.slots = asyncio.Semaphore(settings.meeting_intelligence_worker_concurrency)
        self.executor = ThreadPoolExecutor(max_workers=settings.meeting_intelligence_worker_concurrency, thread_name_prefix="intelligence")
        self.pending, self.fences = set(), set()
        self.closed = False

    def prepare(self, claim, guard, deadline):
        with correlation_scope(new_correlation_context(request_id=claim.eventId,
                                                       job_id=claim.processingJobId)):
            return self._prepare(claim, guard, deadline)

    def _prepare(self, claim, guard, deadline):
        phase = "SOURCE_DOWNLOAD"
        try:
            raw = self.storage.get_intelligence_snapshot(claim.source, guard.fence)
            snapshot = verify_snapshot(raw, claim)
            if guard.fence.is_set():
                raise WorkFailure("INTERRUPTED", "CANCELLED")
            if claim.executionStageCode == "EXTRACTING_ACTION_ITEMS":
                phase = "INFERENCE"
                processor = self.processors.get(claim.executionStageCode)
                if processor is None:
                    raise WorkFailure(phase, "CONFIGURATION")
                context = StageContext(claim.processingJobId, claim.executionStageRunId, claim.executionStageCode,
                    claim.meetingId, claim.source.snapshotId, claim.source.sha256, claim.source.transcriptId,
                    claim.source.contentRevision, snapshot, deadline, guard.fence)
                candidate = processor(context)
                if guard.fence.is_set() or time.monotonic() >= deadline:
                    raise WorkFailure("INTERRUPTED", "CANCELLED")
                phase = "RESULT_VALIDATION"
                return prepare_action_item_request(candidate, claim, snapshot)
            if claim.resultSlot is None:
                raise WorkFailure("INFERENCE", "CONFIGURATION")
            phase = "RESULT_STORAGE"
            try:
                existing = self.storage.get_result(claim.resultSlot.storageId, claim.resultSlot.objectKey, guard.fence)
            except StorageError as error:
                if error.category != "NOT_FOUND":
                    raise
            else:
                phase = "RESULT_VALIDATION"
                payload = strict_json(existing, claim.resultSlot.maxBytes)
                candidate = {"producer": payload["producer"], "result": payload["result"]}
                expected = strict_json(serialize_result(candidate, claim, snapshot), claim.resultSlot.maxBytes)
                if payload != expected:
                    raise WorkFailure(phase, "INTEGRITY")
                return hashlib.sha256(existing).hexdigest()
            phase = "INFERENCE"
            processor = self.processors.get(claim.executionStageCode)
            if processor is None:
                raise WorkFailure(phase, "CONFIGURATION")
            context = StageContext(claim.processingJobId, claim.executionStageRunId, claim.executionStageCode,
                claim.meetingId, claim.source.snapshotId, claim.source.sha256, claim.source.transcriptId,
                claim.source.contentRevision, snapshot, deadline, guard.fence)
            candidate = processor(context)
            if guard.fence.is_set() or time.monotonic() >= deadline:
                raise WorkFailure("INTERRUPTED", "CANCELLED")
            phase = "RESULT_VALIDATION"
            artifact = serialize_result(candidate, claim, snapshot)
            phase = "RESULT_STORAGE"
            if guard.fence.is_set() or time.monotonic() >= deadline:
                raise WorkFailure("INTERRUPTED", "CANCELLED")
            stored = self.storage.put_result(claim.resultSlot.storageId, claim.resultSlot.objectKey, artifact, guard.fence)
            if stored != artifact:
                raise WorkFailure(phase, "INTEGRITY")
            return hashlib.sha256(artifact).hexdigest()
        except WorkFailure:
            raise
        except SourceIntegrityError:
            raise WorkFailure("SOURCE_DOWNLOAD", "INTEGRITY") from None
        except IntelligenceError as error:
            raise WorkFailure(phase, _worker_category(error.category)) from None
        except ResultError:
            raise WorkFailure("RESULT_VALIDATION", "MALFORMED_OUTPUT") from None
        except StorageError as error:
            raise WorkFailure(phase, error.category) from None
        except (ValueError, TypeError, KeyError, AttributeError):
            raise WorkFailure(phase, "INTEGRITY" if phase == "RESULT_VALIDATION" else "RESOURCE") from None
        except Exception:
            raise WorkFailure(phase, "RESOURCE") from None

    async def reconcile(self, event):
        try:
            return await self.core.lookup(event, once=True)
        except CoreError:
            return None

    async def failure(self, event, claim, guard, error):
        if not guard.live():
            return await self.reconcile(event)
        body = dict(**owner_fields(claim), commandId=str(uuid4()), phase=error.phase, category=error.category)
        try:
            return await self.core.request(event, "fail", body, deadline=guard.deadline)
        except CoreError:
            return await self.reconcile(event)

    async def accept(self, event, claim, guard, digest):
        for _ in range(self.settings.core_api_max_attempts):
            if not guard.live():
                return await self.reconcile(event)
            try:
                await guard.protect(self.core.accept(event, claim.claimToken.get_secret_value(), digest, deadline=guard.deadline))
            except CoreError:
                status = await self.reconcile(event)
                if status is None or status.durable or not guard.live():
                    return status
                continue
            # Acceptance itself is durable, but status also establishes the exact delivery disposition.
            return await self.reconcile(event)
        return None

    async def accept_action_items(self, event, claim, guard, prepared):
        # Keep these exact prepared bytes across response-loss retries. Submission
        # uncertainty never causes another model call or contradictory failure.
        for _ in range(self.settings.core_api_max_attempts):
            if not guard.live():
                return await self.reconcile(event)
            try:
                await guard.protect(self.core.accept_action_items(event, claim, prepared, deadline=guard.deadline))
            except CoreError as error:
                status = await self.reconcile(event)
                if (status is None or status.durable or not guard.live()
                        or error.status in (400, 401, 403, 404, 409, 413, 415, 422)):
                    return status
                continue
            return await self.reconcile(event)
        return None

    async def disposition(self, delivery, status):
        if isinstance(status, IntelligenceStatus) and status.durable:
            await delivery.ack()
            log_event(logger, logging.INFO, f"worker.intelligence.{status.state.lower()}")
        else:
            self.stop_intake.set()
            log_event(logger, logging.WARNING, "worker.intelligence.delivery.unresolved")

    async def handle(self, delivery):
        await self.slots.acquire()
        guard = event = future = None
        try:
            if self.closed or self.stop_intake.is_set():
                return
            event = decode_notification(delivery)
            loop = asyncio.get_running_loop()
            maximum = loop.time() + self.settings.meeting_intelligence_worker_execution_timeout_seconds
            async with asyncio.timeout_at(maximum):
                status = await self.core.lookup(event, deadline=maximum)
                if status.state != "AVAILABLE":
                    await self.disposition(delivery, status)
                    return
                started = loop.time()
                claim = await self.core.claim(event, deadline=maximum)
                if isinstance(claim, IntelligenceStatus):
                    await self.disposition(delivery, claim)
                    return
                if not isinstance(claim, IntelligenceClaim):
                    raise CoreError(0, "WORKER_RESPONSE_INVALID")
                guard = LeaseGuard(self.core, event, claim, loop.time() - started, maximum)
                self.fences.add(guard.fence)
                future = self.executor.submit(self.prepare, claim, guard, time.monotonic() + maximum - loop.time())
                self.pending.add(future)
                wrapped = asyncio.wrap_future(future)
                wrapped.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
                try:
                    digest = await guard.protect(asyncio.shield(wrapped))
                except WorkFailure as error:
                    log_event(logger, logging.WARNING,
                              f"worker.intelligence.failure.{error.phase.lower()}.{error.category.lower()}")
                    if error.category in ("AUTHENTICATION", "CONFIGURATION"):
                        self.stop_intake.set()
                    if error.phase == "RESULT_STORAGE" and error.category in ("TIMEOUT", "TRANSPORT", "RESOURCE"):
                        status = await self.reconcile(event)
                    else:
                        status = await self.failure(event, claim, guard, error)
                else:
                    status = (await self.accept_action_items(event, claim, guard, digest)
                        if claim.executionStageCode == "EXTRACTING_ACTION_ITEMS"
                        else await self.accept(event, claim, guard, digest))
                await self.disposition(delivery, status)
        except MessageError:
            await delivery.reject(requeue=False)
            log_event(logger, logging.WARNING, "worker.intelligence.notification.invalid")
        except (CoreError, TimeoutError):
            if guard:
                guard.lose()
            await self.disposition(delivery, await self.reconcile(event) if event else None)
        except asyncio.CancelledError:
            if guard:
                guard.lose()
            raise
        except Exception:
            self.stop_intake.set()
        finally:
            if guard:
                await guard.close()
                self.fences.discard(guard.fence)
            if future is not None and not future.done():
                loop = asyncio.get_running_loop()
                def release(done):
                    if not loop.is_closed():
                        loop.call_soon_threadsafe(self.pending.discard, done)
                        loop.call_soon_threadsafe(self.slots.release)
                future.add_done_callback(release)
            else:
                self.pending.discard(future)
                self.slots.release()

    async def run(self, broker, shutdown_requested):
        waits = []
        try:
            await broker.start(self.handle)
            log_event(logger, logging.INFO, "worker.intelligence.consuming")
            waits = [asyncio.create_task(e.wait()) for e in (shutdown_requested, self.stop_intake, broker.failure)]
            waits.append(asyncio.ensure_future(asyncio.shield(broker.connection.closed())))
            await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
            await broker.stop()
            await broker.drain()
        finally:
            await broker.__aexit__(None, None, None)
            log_event(logger, logging.INFO, "worker.intelligence.stopped")
            for task in waits:
                task.cancel()
            await asyncio.gather(*waits, return_exceptions=True)
        if not shutdown_requested.is_set():
            await shutdown_requested.wait()

    async def aclose(self, *, wait=True):
        if not self.closed:
            self.closed = True
            for fence in tuple(self.fences):
                fence.set()
            self.executor.shutdown(wait=False, cancel_futures=True)
        if wait and self.pending:
            await asyncio.gather(*(asyncio.wrap_future(f) for f in tuple(self.pending)), return_exceptions=True)


class IntelligenceExecution:
    def __init__(self, settings, processors=None):
        self.settings = settings
        self._injected_processors = processors is not None
        self.processors = dict(processors or {})
        self.async_resources, self.sync_resources = AsyncExitStack(), ExitStack()
        self.worker = self.broker = None

    async def __aenter__(self):
        s = self.settings
        if not s.meeting_intelligence_worker_enabled:
            return self
        try:
            if not self._injected_processors:
                validate_provider_credentials(s)
            if not all((s.meeting_intelligence_acceptance_token, s.meeting_intelligence_s3_access_key_id,
                        s.meeting_intelligence_s3_secret_access_key, s.meeting_intelligence_core_api_client_cert_file,
                        s.meeting_intelligence_core_api_client_key_file, s.meeting_intelligence_rabbitmq_username,
                        s.meeting_intelligence_rabbitmq_password)):
                raise ValueError
            isolated = s.model_copy(update=dict(worker_concurrency=s.meeting_intelligence_worker_concurrency,
                s3_access_key_id=s.meeting_intelligence_s3_access_key_id,
                s3_secret_access_key=s.meeting_intelligence_s3_secret_access_key,
                rabbitmq_username=s.meeting_intelligence_rabbitmq_username,
                rabbitmq_password=s.meeting_intelligence_rabbitmq_password,
                core_api_client_cert_file=s.meeting_intelligence_core_api_client_cert_file,
                 core_api_client_key_file=s.meeting_intelligence_core_api_client_key_file))
            core = IntelligenceCoreClient(isolated, acceptance_token=s.meeting_intelligence_acceptance_token)
            self.async_resources.push_async_callback(core.aclose)
            if (not self._injected_processors and s.meeting_intelligence_inference_enabled
                    and (s.meeting_intelligence_summary_enabled or s.meeting_intelligence_decision_enabled
                         or s.meeting_intelligence_action_item_enabled)):
                from sme_meeting_ai.providers.openrouter_intelligence import (
                    OpenRouterIntelligenceAdapter,
                )
                adapter = self.sync_resources.enter_context(OpenRouterIntelligenceAdapter(s))
                self.processors = production_processors(s, adapter)
            storage = self.sync_resources.enter_context(ObjectStorage(isolated, result_max_bytes=4194304,
                                                                       namespace="sme-intelligence-worker"))
            self.worker = IntelligenceWorker(s, core, storage, self.processors)
            self.broker = await self.async_resources.enter_async_context(RabbitConsumer(isolated, queue_name=QUEUE,
                                                      prefetch=s.meeting_intelligence_worker_concurrency))
            return self
        except BaseException:
            await self.__aexit__(None, None, None)
            raise

    async def __call__(self, shutdown_requested):
        if self.worker:
            await self.worker.run(self.broker, shutdown_requested)

    async def __aexit__(self, *_):
        try:
            await self.async_resources.aclose()
        finally:
            if self.worker:
                await self.worker.aclose(wait=False)
            self.sync_resources.close()
