"""Independent, fenced diarization execution; never imports an ASR/LLM pipeline."""

import asyncio
import hashlib
import logging
import multiprocessing
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import AsyncExitStack, ExitStack
from contextvars import copy_context
from datetime import datetime
from uuid import UUID, uuid4

from sme_meeting_ai.core.config import Environment
from sme_meeting_ai.diarization.contract import (
    MAX_RESULT_BYTES,
    ContractValidationError,
    DiarizationResultEnvelope,
    ResultArtifact,
    ValidationContext,
    serialize_result,
    validate_result,
)
from sme_meeting_ai.diarization.models import (
    DiarizationErrorCategory,
    TimedTranscriptSegment,
)
from sme_meeting_ai.diarization.service import (
    DiarizationRequest,
    DiarizationResponse,
    DiarizationService,
)
from sme_meeting_ai.integrations.core_api import CoreError, TransportBudget
from sme_meeting_ai.integrations.diarization import (
    QUEUE,
    DiarizationCoreClient,
    DiarizationStatus,
    decode_notification,
    owner_fields,
)
from sme_meeting_ai.integrations.messaging import MessageError, RabbitConsumer
from sme_meeting_ai.integrations.object_storage import ObjectStorage, StorageError
from sme_meeting_ai.observability.context import (
    correlation_scope,
    new_correlation_context,
)
from sme_meeting_ai.observability.logging import log_event
from sme_meeting_ai.providers.replicate_diarization import (
    _MAX_UPLOAD_BYTES as PROVIDER_MAX_UPLOAD_BYTES,
)

logger = logging.getLogger(__name__)


class WorkFailure(Exception):
    def __init__(self, phase, category):
        self.phase, self.category = phase, category
        super().__init__("WORKER_DIARIZATION_FAILED")


def _service_child(sender, service, request):
    # Spawned without inheriting broker, S3, HTTP connections or executor threads.
    # Only normalized service evidence crosses back; never exception/provider text.
    try:
        try:
            result = service.run(request)
        except Exception:
            result = DiarizationResponse("failed", error_category="processing_failed")
        sender.send(result)
    finally:
        sender.close()


class IsolatedService:
    """Killable boundary around the unchanged synchronous DiarizationService.

    The worker owns one bounded executor for its lifetime. Each admitted inference
    has a spawned child, so blocking provider I/O cannot outlive local cancellation.
    The existing adapter still enforces its own timeout and remote Cancel-After.
    """

    def __init__(self, service):
        self.service = service
        self.closed = threading.Event()

    def run(self, request, fence, deadline):
        context = multiprocessing.get_context("spawn")
        receiver, sender = context.Pipe(duplex=False)
        process = context.Process(target=_service_child, args=(sender, self.service, request), daemon=True)
        started = False
        try:
            if fence.is_set() or self.closed.is_set():
                raise WorkFailure("INTERRUPTED", "CANCELLED")
            process.start()
            started = True
            sender.close()
            while True:
                if fence.is_set() or self.closed.is_set():
                    raise WorkFailure("INTERRUPTED", "CANCELLED")
                if time.monotonic() >= deadline:
                    raise WorkFailure("INFERENCE", "TIMEOUT")
                if receiver.poll(0.025):
                    try:
                        return receiver.recv()
                    except EOFError:
                        raise WorkFailure("INFERENCE", "RESOURCE") from None
                if not process.is_alive():
                    raise WorkFailure("INFERENCE", "RESOURCE")
        finally:
            if started:
                if process.is_alive():
                    process.terminate()
                process.join(0.25)
                if process.is_alive():
                    process.kill()
                    process.join()
                process.close()
            receiver.close()
            sender.close()

    def close(self):
        self.closed.set()


class LeaseKeeper:
    def __init__(self, core, event, claim, round_trip, execution_deadline):
        self.core, self.event, self.claim = core, event, claim
        self.maximum = execution_deadline
        self.fence = threading.Event()
        self.lost = asyncio.Event()
        self.core_stop = False
        self.deadline = 0
        self.confirm(claim, round_trip)
        self.task = asyncio.create_task(self.renew())

    def confirm(self, lease, round_trip):
        seconds = (datetime.fromisoformat(lease.leaseExpiresAt) - datetime.fromisoformat(lease.serverTime)).total_seconds()
        now = asyncio.get_running_loop().time()
        self.deadline = min(self.maximum, now + seconds - round_trip - min(1, max(0, seconds / 10)))
        self.renew_after = lease.renewAfterSeconds
        if self.deadline <= now:
            self.lose()

    def lose(self):
        self.fence.set()
        self.lost.set()

    def live(self):
        if asyncio.get_running_loop().time() >= self.deadline:
            self.lose()
        return not self.fence.is_set()

    async def renew(self):
        try:
            while self.live():
                await asyncio.sleep(min(self.renew_after, max(0, self.deadline - asyncio.get_running_loop().time())))
                if not self.live():
                    break
                start = asyncio.get_running_loop().time()
                lease = await self.core.request(self.event, "renew", owner_fields(self.claim), deadline=self.deadline)
                # A response arriving after the old safe deadline never revives authority.
                if not self.live():
                    break
                self.confirm(lease, asyncio.get_running_loop().time() - start)
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
                raise CoreError(409, "WORKER_LEASE_LOST")
            return await task
        finally:
            lost.cancel()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, lost, return_exceptions=True)

    async def close(self):
        self.lose()
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


def validation_context(claim, snapshot):
    if (snapshot.transcriptId != claim.transcript.transcriptId
            or snapshot.transcriptRevision != claim.transcript.transcriptRevision
            or snapshot.durationMs > claim.source.durationMs):
        raise WorkFailure("SNAPSHOT", "INTEGRITY")
    return ValidationContext(UUID(claim.processingJobId), UUID(claim.source.sourceMediaId),
        claim.source.sourceRevision, UUID(snapshot.transcriptId), snapshot.transcriptRevision,
        UUID(claim.executionStageRunId), snapshot.durationMs, tuple(s.ordinal for s in snapshot.segments))


class DiarizationWorker:
    def __init__(self, settings, core, storage, runner):
        self.settings, self.core, self.storage, self.runner = settings, core, storage, runner
        self.stop_intake = asyncio.Event()
        self._slots = asyncio.Semaphore(settings.diarization_worker_concurrency)
        self._executor = ThreadPoolExecutor(max_workers=settings.diarization_worker_concurrency,
                                            thread_name_prefix="diarization")
        self._pending = set()
        self._fences = set()
        self._closed = False

    def prepare(self, claim, snapshot, context, fence, deadline):
        phase = "RESULT_STORAGE"
        try:
            if fence.is_set():
                raise WorkFailure("INTERRUPTED", "CANCELLED")
            try:
                raw = self.storage.get_result(claim.resultSlot.storageId, claim.resultSlot.objectKey, fence)
            except StorageError as error:
                if error.category != "NOT_FOUND":
                    raise
            else:
                phase = "RESULT_VALIDATION"
                digest = hashlib.sha256(raw).hexdigest()
                validate_result(raw, context, digest)
                return ResultArtifact(raw, digest)
            if claim.source.sizeBytes > PROVIDER_MAX_UPLOAD_BYTES:
                raise WorkFailure("PREPROCESSING", "VALIDATION")
            phase = "SOURCE_DOWNLOAD"
            with self.storage.source_file(claim.source, fence) as path:
                if fence.is_set():
                    raise WorkFailure("INTERRUPTED", "CANCELLED")
                phase = "INFERENCE"
                request = DiarizationRequest(path, snapshot.durationMs, tuple(
                    TimedTranscriptSegment(s.ordinal, s.startMs, s.endMs) for s in snapshot.segments))
                outcome = self.runner.run(request, fence, deadline)
            if fence.is_set():
                raise WorkFailure("INTERRUPTED", "CANCELLED")
            if not isinstance(outcome, DiarizationResponse):
                raise WorkFailure("RESULT_VALIDATION", "MALFORMED_OUTPUT")
            if outcome.diagnostic_status != "completed":
                category = outcome.error_category
                if category == "input_too_large":
                    raise WorkFailure("PREPROCESSING", "VALIDATION")
                allowed = {c.value: c.name for c in DiarizationErrorCategory if c.name != "INPUT_TOO_LARGE"}
                raise WorkFailure("INFERENCE", "EMPTY_OUTPUT" if outcome.diagnostic_status == "skipped"
                                  else allowed.get(category, "RESOURCE"))
            phase = "RESULT_VALIDATION"
            artifact = serialize_result(DiarizationResultEnvelope.from_response(outcome, context), context)
            validate_result(artifact.data, context, artifact.sha256)
            if fence.is_set():
                raise WorkFailure("INTERRUPTED", "CANCELLED")
            phase = "RESULT_STORAGE"
            stored = self.storage.put_result(claim.resultSlot.storageId, claim.resultSlot.objectKey, artifact.data, fence)
            phase = "RESULT_VALIDATION"
            if stored != artifact.data:
                raise WorkFailure(phase, "INTEGRITY")
            validate_result(stored, context, artifact.sha256)
            return artifact
        except WorkFailure:
            raise
        except ContractValidationError:
            category = "INTEGRITY"
        except StorageError as error:
            category = error.category
        except Exception:
            category = "RESOURCE"
        raise WorkFailure(phase, category)

    async def terminal_command(self, event, claim, guard, operation, body):
        budget = TransportBudget(self.settings.core_api_max_attempts)
        querying = False
        while budget.remaining:
            if not querying and not guard.live():
                querying = True
            try:
                status = (await self.core.lookup(event, budget=budget, once=True) if querying else
                          await self.core.request(event, operation, body, budget=budget, once=True, deadline=guard.deadline))
                if status.durable or status.state == "RESULT_VERIFIED":
                    if operation == "complete" and status.state in ("RESULT_ACCEPTED", "RESULT_VERIFIED"):
                        digest = (status.receipt["resultSha256"] if status.durable else status.verification.resultSha256)
                        if digest != body["resultSha256"]:
                            return None
                    return status
                if not guard.live():
                    return None
                querying = not querying
            except CoreError as error:
                if error.stop_intake:
                    self.stop_intake.set()
                    return None
                if operation == "complete" and error.status == 422 and error.code in (
                    "DIARIZATION_RESULT_INVALID", "DIARIZATION_RESULT_MISSING", "VALIDATION_ERROR",
                ):
                    operation = "fail"
                    body = dict(**owner_fields(claim), commandId=str(uuid4()), phase="RESULT_VALIDATION", category="VALIDATION")
                    querying = False
                elif error.status == 409:
                    guard.lose()
                    querying = True
                elif error.retryable:
                    querying = True
                    if budget.remaining:
                        await self.core.backoff(budget, error)
                else:
                    return None
        return None

    async def disposition(self, delivery, status):
        if isinstance(status, DiarizationStatus) and status.durable:
            await delivery.ack()
            log_event(logger, logging.INFO, f"worker.diarization.{status.state.lower()}")
        else:
            # Keep the unacknowledged delivery and immutable bytes. run() cancels
            # intake and closes this dedicated connection once active work drains.
            self.stop_intake.set()
            if isinstance(status, DiarizationStatus):
                log_event(logger, logging.WARNING, f"worker.diarization.{status.state.lower()}")
            log_event(logger, logging.WARNING, "worker.diarization.intake.paused")

    async def reconcile(self, event):
        try:
            return await self.core.lookup(event, once=True)
        except CoreError:
            return None

    async def handle(self, delivery):
        await self._slots.acquire()
        guard = pending = event = correlation = None
        started = asyncio.get_running_loop().time()
        try:
            if self.stop_intake.is_set() or self._closed:
                return
            event = decode_notification(delivery)
            correlation = new_correlation_context(request_id=event.requestId, job_id=event.processingJobId)
            with correlation_scope(correlation):
                maximum = started + self.settings.diarization_worker_execution_timeout_seconds
                async with asyncio.timeout_at(maximum):
                    status = await self.core.lookup(event, deadline=maximum)
                    if status.state != "AVAILABLE":
                        await self.disposition(delivery, status)
                        return
                    begin = asyncio.get_running_loop().time()
                    claim = await self.core.claim(event, deadline=maximum)
                    if isinstance(claim, DiarizationStatus):
                        await self.disposition(delivery, claim)
                        return
                    guard = LeaseKeeper(self.core, event, claim, asyncio.get_running_loop().time() - begin, maximum)
                    self._fences.add(guard.fence)
                    failure = None
                    try:
                        snapshot = await guard.protect(self.core.request(event, "snapshot", owner_fields(claim), deadline=guard.deadline))
                        context = validation_context(claim, snapshot)
                        pending = self._executor.submit(copy_context().run, self.prepare, claim, snapshot, context,
                                                        guard.fence, time.monotonic() + maximum - asyncio.get_running_loop().time())
                        self._pending.add(pending)
                        wrapped = asyncio.wrap_future(pending)
                        wrapped.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
                        artifact = await guard.protect(asyncio.shield(wrapped))
                    except WorkFailure as error:
                        failure = error
                    if failure:
                        log_event(logger, logging.WARNING, f"worker.diarization.failure.{failure.phase.lower()}.{failure.category.lower()}")
                        if failure.category in ("AUTHENTICATION", "CONFIGURATION"):
                            self.stop_intake.set()
                        if failure.phase == "RESULT_STORAGE" and failure.category in ("TRANSPORT", "TIMEOUT", "RESOURCE"):
                            status = await self.reconcile(event)
                        elif guard.live():
                            command = dict(**owner_fields(claim), commandId=str(uuid4()), phase=failure.phase, category=failure.category)
                            status = await self.terminal_command(event, claim, guard, "fail", command)
                        else:
                            status = await self.reconcile(event)
                    else:
                        command = dict(**owner_fields(claim), commandId=str(uuid4()), resultSha256=artifact.sha256,
                                       resultProducerStageRunId=claim.executionStageRunId)
                        status = await self.terminal_command(event, claim, guard, "complete", command)
                    await self.disposition(delivery, status)
        except MessageError:
            await delivery.reject(requeue=False)
            log_event(logger, logging.WARNING, "worker.diarization.notification.invalid")
        except (CoreError, TimeoutError) as error:
            if (isinstance(error, CoreError) and error.stop_intake) or (guard and guard.core_stop):
                self.stop_intake.set()
            log_event(logger, logging.WARNING, "worker.diarization.execution.timeout" if isinstance(error, TimeoutError)
                      else f"worker.diarization.control.{error.code.lower()}")
            if guard:
                guard.lose()
            await self.disposition(delivery, await self.reconcile(event) if event else None)
        except asyncio.CancelledError:
            if guard:
                guard.lose()
            log_event(logger, logging.WARNING, "worker.diarization.interrupted.cancelled")
            raise
        except Exception:
            # Includes uncertain ACK/broker failures; never issue a contradictory failure.
            self.stop_intake.set()
            log_event(logger, logging.ERROR, "worker.diarization.delivery.unresolved")
        finally:
            if guard:
                await guard.close()
                self._fences.discard(guard.fence)
            if pending is not None and not pending.done():
                loop = asyncio.get_running_loop()

                def release(future):
                    if not loop.is_closed():
                        loop.call_soon_threadsafe(self._pending.discard, future)
                        loop.call_soon_threadsafe(self._slots.release)
                pending.add_done_callback(release)
            else:
                self._pending.discard(pending)
                self._slots.release()
            with correlation_scope(correlation or new_correlation_context()):
                log_event(logger, logging.INFO, "worker.diarization.finished",
                          duration_ms=min(86400000, int((asyncio.get_running_loop().time() - started) * 1000)))

    async def run(self, broker, shutdown_requested):
        waits = []
        try:
            await broker.start(self.handle)
            log_event(logger, logging.INFO, "worker.diarization.consuming")
            waits = [asyncio.create_task(e.wait()) for e in (shutdown_requested, self.stop_intake, broker.failure)]
            waits.append(asyncio.ensure_future(asyncio.shield(broker.connection.closed())))
            await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
            await broker.stop()
            await broker.drain()
        except Exception:
            self.stop_intake.set()
            log_event(logger, logging.ERROR, "worker.diarization.broker.paused")
        finally:
            try:
                await broker.__aexit__(None, None, None)
            except Exception:
                self.stop_intake.set()
                log_event(logger, logging.ERROR, "worker.diarization.broker.cleanup.failed")
            for task in waits:
                task.cancel()
            await asyncio.gather(*waits, return_exceptions=True)
        # A projection/provider operational pause must not restart in a hot loop
        # or interrupt the independent transcription capability.
        if not shutdown_requested.is_set():
            await shutdown_requested.wait()

    async def aclose(self, *, wait=True):
        if not self._closed:
            self._closed = True
            for fence in tuple(self._fences):
                fence.set()
            self.runner.close()
            self._executor.shutdown(wait=False, cancel_futures=True)
        if wait and self._pending:
            await asyncio.gather(*(asyncio.wrap_future(f) for f in tuple(self._pending)), return_exceptions=True)


class DiarizationExecution:
    """Runtime-owned, dedicated transport/storage/provider resources."""

    def __init__(self, settings):
        self.settings = settings
        self._async = AsyncExitStack()
        self._sync = ExitStack()
        self.worker = self.broker = None
        self._exited = False

    async def __aenter__(self):
        if not self.settings.diarization_worker_enabled:
            return self
        failed = False
        try:
            s = self.settings
            token = s.replicate_api_token.get_secret_value() if s.replicate_api_token else ""
            if (not s.diarization_enabled or not s.diarization_worker_provider_approved
                    or s.environment is Environment.PRODUCTION and not s.diarization_worker_projection_ready
                    or not token or any(ord(c) < 33 or ord(c) > 126 for c in token)
                    or not all((s.diarization_worker_s3_access_key_id, s.diarization_worker_s3_secret_access_key))):
                raise ValueError
            # Separate role credentials: existing transcription storage rights stay narrow.
            isolated = s.model_copy(update=dict(worker_concurrency=s.diarization_worker_concurrency,
                s3_access_key_id=s.diarization_worker_s3_access_key_id,
                s3_secret_access_key=s.diarization_worker_s3_secret_access_key))
            core = DiarizationCoreClient(isolated)
            self._async.push_async_callback(core.aclose)
            storage = self._sync.enter_context(ObjectStorage(isolated, result_max_bytes=MAX_RESULT_BYTES,
                                                            namespace="sme-diarization-worker"))
            from sme_meeting_ai.providers.replicate_diarization import (
                ReplicateDiarizationAdapter,
            )
            runner = IsolatedService(DiarizationService(ReplicateDiarizationAdapter(s)))
            self._sync.callback(runner.close)
            self.worker = DiarizationWorker(s, core, storage, runner)
            self.broker = await self._async.enter_async_context(RabbitConsumer(s, queue_name=QUEUE,
                                                                         prefetch=s.diarization_worker_concurrency))
            return self
        except asyncio.CancelledError:
            await self.__aexit__(None, None, None)
            raise
        except Exception:
            failed = True
        if failed:
            await self.__aexit__(None, None, None)
            log_event(logger, logging.ERROR, "worker.diarization.startup.failed")
            raise RuntimeError("worker.diarization.startup.failed")

    async def __call__(self, shutdown_requested):
        if self.worker:
            await self.worker.run(self.broker, shutdown_requested)

    async def __aexit__(self, *_):
        if self._exited:
            return
        self._exited = True
        try:
            await self._async.aclose()
        finally:
            if self.worker:
                await self.worker.aclose(wait=False)
            # ObjectStorage's active-reader ownership delays cleanup until any
            # bounded network read and fenced child have released their source.
            self._sync.close()
