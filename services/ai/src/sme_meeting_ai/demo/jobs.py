"""Bounded, ephemeral execution with real thread/file ownership until completion."""

import asyncio
import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.observability.logging import log_event

from .models import (
    DemoJobAccepted,
    DemoJobError,
    DemoJobStatus,
    DemoResult,
    SpeakerHints,
)
from .pipeline import DemoProcessingError, processing_budget_seconds

logger = logging.getLogger(__name__)


class DemoCapacityError(Exception):
    pass


@dataclass
class _Job:
    job_id: str
    path: Path = field(repr=False)
    upload: TemporaryDirectory = field(repr=False)
    hints: SpeakerHints
    status: str = "queued"
    stage: str = "queued"
    result: DemoResult | None = field(default=None, repr=False)
    error: DemoJobError | None = None
    finished_at: float | None = None


class DemoJobManager:
    def __init__(self, settings: Settings, runner, *, clock=time.monotonic, cleanup_interval_seconds=None):
        self._settings, self._runner, self._clock = settings, runner, clock
        self._capacity = settings.demo_max_concurrent_jobs + settings.demo_max_queued_jobs
        self._budget = processing_budget_seconds(settings)
        self._temporary = TemporaryDirectory(prefix="ai-demo-", dir=settings.audio_temp_dir)
        self.root = Path(self._temporary.name)
        self._executor = ThreadPoolExecutor(max_workers=settings.demo_max_concurrent_jobs, thread_name_prefix="ai-demo")
        self._lock = threading.RLock()
        self._jobs: dict[str, _Job] = {}
        self._futures: dict[str, Future] = {}
        self._reservations: set[str] = set()
        self._closed = self._resources_closed = False
        self._cleanup_interval = cleanup_interval_seconds or min(30, settings.demo_result_ttl_seconds)
        self._reaper = None

    def start(self):
        self._reaper = asyncio.create_task(self._reap(), name="demo-result-expiry")

    async def _reap(self):
        while True:
            await asyncio.sleep(self._cleanup_interval)
            with self._lock:
                self._expire()

    def _expire(self):
        now = self._clock()
        terminal = sorted((job for job in self._jobs.values() if job.finished_at is not None),
                          key=lambda job: job.finished_at)
        excess = max(0, len(terminal) - self._settings.demo_max_retained_jobs)
        for index, job in enumerate(terminal):
            if index < excess or now - job.finished_at >= self._settings.demo_result_ttl_seconds:
                self._jobs.pop(job.job_id, None)

    def reserve(self) -> str:
        """Reserve before receiving multipart data, bounding uploads and work together."""
        with self._lock:
            self._expire()
            if self._closed or len(self._futures) + len(self._reservations) >= self._capacity:
                raise DemoCapacityError()
            token = str(uuid4())
            self._reservations.add(token)
            return token

    def release(self, reservation: str):
        with self._lock:
            self._reservations.discard(reservation)
        self._close_if_idle()

    def new_upload(self) -> TemporaryDirectory:
        with self._lock:
            if self._closed:
                raise DemoCapacityError()
            return TemporaryDirectory(prefix="upload-", dir=self.root)

    def submit(self, reservation: str, path: Path, upload: TemporaryDirectory,
               hints: SpeakerHints) -> DemoJobAccepted:
        accepted = None
        with self._lock:
            if not self._closed and reservation in self._reservations:
                self._reservations.remove(reservation)
                job_id = str(uuid4())
                job = _Job(job_id, path, upload, hints)
                self._jobs[job_id] = job
                try:
                    future = self._executor.submit(self._execute, job)
                    self._futures[job_id] = future
                    future.add_done_callback(lambda completed: self._finished(job, completed))
                    accepted = DemoJobAccepted(jobId=job_id)
                except Exception:
                    self._jobs.pop(job_id, None)
        if accepted is not None:
            return accepted
        self._cleanup_upload(upload)
        self.release(reservation)
        raise DemoCapacityError()

    def get(self, job_id: str) -> DemoJobStatus | None:
        with self._lock:
            self._expire()
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return DemoJobStatus(jobId=job.job_id, status=job.status, stage=job.stage,
                                 result=job.result, error=job.error)

    def _stage(self, job, stage):
        # Only runner-backed stages, never guessed progress or percentages.
        if stage not in ("transcription", "diarization"):
            return
        with self._lock:
            job.status, job.stage = "processing", stage

    def _execute(self, job: _Job):
        result, error = None, None
        with self._lock:
            stopped = self._closed
            if not stopped:
                job.status, job.stage = "processing", "transcription"
        try:
            if stopped:
                error = DemoJobError(code="SHUTDOWN", message="Demo processing stopped during shutdown.")
            else:
                result = self._runner.run(job.path, hints=job.hints,
                                          on_stage=lambda stage: self._stage(job, stage),
                                          deadline=self._clock() + self._budget)
                if not isinstance(result, DemoResult):
                    raise DemoProcessingError()
        except DemoProcessingError as failure:
            error = DemoJobError(code=failure.code, message="Audio transcription could not be completed.")
        except Exception:
            error = DemoJobError(code="PROCESSING_FAILED", message="Audio transcription could not be completed.")
        finally:
            # Terminal publication happens after deleting raw audio. The runner's
            # own preprocessing context has already closed its temporary artifacts.
            cleaned = self._cleanup_upload(job.upload)
        if not cleaned:
            result = None
            error = DemoJobError(code="PROCESSING_FAILED", message="Audio processing cleanup could not be completed.")
        with self._lock:
            job.result, job.error = result if error is None else None, error
            job.status = "completed" if error is None else "failed"
            if error is None:
                job.stage = "completed"
            job.finished_at = self._clock()
            self._expire()

    @staticmethod
    def _cleanup_upload(upload) -> bool:
        try:
            upload.cleanup()
            return True
        except Exception:
            log_event(logger, logging.ERROR, "demo.upload.cleanup.failed")
            return False

    def _finished(self, job: _Job, future: Future):
        if future.cancelled():
            self._cleanup_upload(job.upload)
        with self._lock:
            self._futures.pop(job.job_id, None)
            if self._closed:
                self._jobs.pop(job.job_id, None)
        self._close_if_idle()

    def _close_if_idle(self):
        with self._lock:
            close = (self._closed and not self._futures and not self._reservations
                     and not self._resources_closed)
            if close:
                self._resources_closed = True
                self._jobs.clear()
        if close:
            # Concurrent-future callbacks remain valid after the asyncio loop
            # closes. No reader can still be using VAD/providers or upload files.
            try:
                self._runner.close()
            except Exception:
                log_event(logger, logging.ERROR, "demo.resources.cleanup.failed")
            self._cleanup_upload(self._temporary)

    async def aclose(self):
        with self._lock:
            self._closed = True
            pending = tuple(self._futures.values())
            for future in pending:
                future.cancel()  # Only not-yet-running work can be canceled.
            self._jobs.clear()
        self._executor.shutdown(wait=False, cancel_futures=True)
        if self._reaper is not None:
            self._reaper.cancel()
            await asyncio.gather(self._reaper, return_exceptions=True)
        if pending:
            await asyncio.wait([asyncio.wrap_future(future) for future in pending],
                               timeout=self._settings.http_shutdown_timeout_seconds)
        self._close_if_idle()
