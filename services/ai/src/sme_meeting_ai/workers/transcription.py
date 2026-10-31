"""Corrected-only contract mapping and fenced atomic offline-job execution."""

import asyncio
import hashlib
import json
import re
import struct
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from contextlib import AsyncExitStack, ExitStack
from contextvars import copy_context
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import AfterValidator, Field, ValidationError, model_validator

from sme_meeting_ai.audio.models import AudioSource, SampleInterval, SpeechMapWarning
from sme_meeting_ai.integrations.core_api import (
    MAX_RESULT_BYTES,
    CoreError,
    Count,
    DeliveryStatus,
    Digest,
    TransportBudget,
    Uuid,
    WireModel,
    claim_fields,
    strict_json,
)
from sme_meeting_ai.integrations.messaging import MessageError, decode_event
from sme_meeting_ai.integrations.object_storage import StorageError
from sme_meeting_ai.observability.context import (
    correlation_scope,
    new_correlation_context,
)
from sme_meeting_ai.pipeline.offline_transcription import (
    OfflineTranscriptionOutcome,
    OfflineTranscriptionStage,
    OfflineTranscriptionStatus,
)
from sme_meeting_ai.transcription.asr import AsrErrorCategory
from sme_meeting_ai.transcription.correction import (
    CorrectedSegment,
    TranscriptCorrectionResult,
)
from sme_meeting_ai.transcription.coverage import CoverageReason
from sme_meeting_ai.transcription.reconciliation import (
    ReconciliationChunkState,
    ReconciliationFlag,
)
from sme_meeting_ai.transcription.recovery import RecoveryStopReason


class ResultValidationError(Exception):
    def __init__(self, category="VALIDATION"):
        self.category = category
        super().__init__(f"WORKER_RESULT_{category}")


def _require(condition):
    if not condition:
        raise ResultValidationError()


def _token(value):
    if (not value.strip() or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]*", value) is None
            or "://" in value or ".." in value):
        raise ValueError("Invalid provenance token")
    return value


def _text(value):
    if (not value.strip() or any(unicodedata.category(c) in ("Cc", "Cf", "Cs") and c not in "\t\r\n" for c in value)):
        raise ValueError("Invalid corrected text")
    value.encode("utf-8", errors="strict")
    return value


Token = Annotated[str, AfterValidator(_token)]
Text = Annotated[str, Field(min_length=1, max_length=20000), AfterValidator(_text)]


class Segment(WireModel):
    ordinal: Count
    startMs: Count
    endMs: Count
    text: Text = Field(repr=False)
    qualityStatus: Literal["ACCEPTED", "SUSPICIOUS", "UNRESOLVED"]


class Coverage(WireModel):
    startMs: Count
    endMs: Count
    coverageStatus: Literal["COVERED", "SUSPICIOUS", "UNRESOLVED_ERROR"]
    recovered: bool
    retryCount: Count


_WARNING_CODES = {
    "PREPROCESSING": {w.value for w in SpeechMapWarning},
    "CHUNK_PLANNING": set(),
    "ASR": {w.value for w in ReconciliationChunkState},
    "COVERAGE_RECOVERY": ({w.value for w in CoverageReason} | {w.value for w in RecoveryStopReason}
                          | {w.value for w in AsrErrorCategory} | {"unresolved-speech"}),
    "RECONCILIATION": ({w.value for w in ReconciliationChunkState} | {w.value for w in ReconciliationFlag}
                       | {"unresolved-interval"}),
    "CORRECTION": {"completed-with-warnings", "empty-transcript"},
}


class Warning(WireModel):
    stage: Literal["PREPROCESSING", "CHUNK_PLANNING", "ASR", "COVERAGE_RECOVERY", "RECONCILIATION", "CORRECTION"]
    code: str
    startSample: Count | None
    endSample: Count | None
    sourceChunkIds: list[Annotated[Token, Field(max_length=128)]] = Field(max_length=64)
    phase: Literal["initial", "final", "attempt"] | None

    @model_validator(mode="after")
    def registry(self):
        if self.code not in _WARNING_CODES[self.stage]:
            raise ValueError("Invalid warning code")
        if (self.startSample is None) != (self.endSample is None):
            raise ValueError("Invalid warning interval")
        if self.startSample is not None and not self.startSample < self.endSample:
            raise ValueError("Invalid warning interval")
        return self


class Component(WireModel):
    name: Token = Field(max_length=128)
    version: Token = Field(max_length=80)


class VadModel(WireModel):
    modelId: Token = Field(max_length=256)
    modelVersion: Token = Field(max_length=80)
    sha256: Digest


class Model(WireModel):
    role: Literal["ASR", "CORRECTION"]
    provider: Token = Field(max_length=80)
    requestedModel: Token = Field(max_length=256)
    resolvedModel: Annotated[Token, Field(max_length=256)] | None


class Provenance(WireModel):
    pipelineVersion: Token = Field(max_length=80)
    configurationSha256: Digest
    components: list[Component] = Field(min_length=1, max_length=16)
    vadModel: VadModel
    models: list[Model] = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def unique(self):
        if len({c.name for c in self.components}) != len(self.components):
            raise ValueError("Duplicate component")
        entries = [tuple(m.model_dump().values()) for m in self.models]
        if len(set(entries)) != len(entries) or not any(m.role == "CORRECTION" for m in self.models):
            raise ValueError("Invalid model provenance")
        return self


class CorrectionProof(WireModel):
    contextScope: Literal["WHOLE_MEETING"]
    promptVersion: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
    outputSha256: Digest


def _intersects(a, b):
    return a.startMs < b.endMs and b.startMs < a.endMs


class CorrectedEnvelope(WireModel):
    contractVersion: Literal["1.0"]
    resultType: Literal["CORRECTED_TRANSCRIPT"]
    processingJobId: Uuid
    sourceMediaId: Uuid
    sourceRevision: Digest
    producerStageRunId: Uuid
    pipelineStatus: Literal["COMPLETED", "COMPLETED_WITH_WARNINGS"]
    languageCode: Token = Field(min_length=1, max_length=16)
    sampleRateHz: Literal[16000]
    sampleCount: int = Field(ge=1, le=230400000)
    durationMs: int = Field(gt=0)
    segments: list[Segment] = Field(min_length=1, max_length=16384, repr=False)
    coverage: list[Coverage] = Field(min_length=1, max_length=65536)
    warnings: list[Warning] = Field(max_length=4096)
    provenance: Provenance
    correctionProof: CorrectionProof

    @model_validator(mode="after")
    def timeline_and_proof(self):
        if self.durationMs != (self.sampleCount * 1000 + 15999) // 16000:
            raise ValueError("Invalid sample duration")
        for group in (self.segments, self.coverage):
            previous = -1
            for item in group:
                if not 0 <= item.startMs < item.endMs <= self.durationMs or item.startMs < previous:
                    raise ValueError("Invalid timeline")
                previous = item.startMs
        if [s.ordinal for s in self.segments] != list(range(len(self.segments))):
            raise ValueError("Invalid segment ordinals")
        if any(w.endSample is not None and w.endSample > self.sampleCount for w in self.warnings):
            raise ValueError("Invalid warning timeline")
        for segment in self.segments:
            regions = [c for c in self.coverage if _intersects(segment, c)]
            if not regions:
                raise ValueError("Missing segment coverage")
            if (any(c.coverageStatus == "UNRESOLVED_ERROR" for c in regions)
                    and segment.qualityStatus != "UNRESOLVED"):
                raise ValueError("Upgraded unresolved quality")
            if (any(c.coverageStatus == "SUSPICIOUS" for c in regions)
                    and segment.qualityStatus == "ACCEPTED"):
                raise ValueError("Upgraded suspicious quality")
        for region in self.coverage:
            if region.coverageStatus == "COVERED" and not any(
                s.qualityStatus == "ACCEPTED" and _intersects(s, region) for s in self.segments
            ):
                raise ValueError("Missing accepted corrected speech")
            if region.recovered and not region.retryCount:
                raise ValueError("Invalid recovery evidence")
        flagged = (bool(self.warnings) or any(s.qualityStatus != "ACCEPTED" for s in self.segments)
                   or any(c.coverageStatus != "COVERED" for c in self.coverage))
        if (self.pipelineStatus == "COMPLETED_WITH_WARNINGS") != flagged:
            raise ValueError("Invalid warning status")
        if correction_digest([s.model_dump() for s in self.segments]) != self.correctionProof.outputSha256:
            raise ValueError("Invalid correction proof")
        return self


def correction_digest(segments):
    failed = False
    try:
        digest = hashlib.sha256(b"SME-CONTEXTUAL-CORRECTION-V1\x00")
        ordered = sorted(segments, key=lambda s: s["ordinal"])
        _require([s["ordinal"] for s in ordered] == list(range(len(ordered))))
        for segment in ordered:
            _require(all(type(segment[k]) is int and segment[k] >= 0 for k in ("ordinal", "startMs", "endMs")))
            _require(segment["startMs"] < segment["endMs"])
            encoded = _text(segment["text"]).encode("utf-8")
            digest.update(struct.pack(">iqqi", segment["ordinal"], segment["startMs"], segment["endMs"], len(encoded)))
            digest.update(encoded)
        return digest.hexdigest()
    except Exception:
        failed = True
    if failed:
        raise ResultValidationError()


def validate_result_bytes(raw, *, job_id=None, media_id=None, source_revision=None, producer_id=None):
    category = "VALIDATION"
    try:
        data = strict_json(raw, MAX_RESULT_BYTES)
        result = CorrectedEnvelope.model_validate(data)
        for expected, actual in ((job_id, result.processingJobId), (media_id, result.sourceMediaId),
                                 (source_revision, result.sourceRevision), (producer_id, result.producerStageRunId)):
            _require(expected is None or expected == actual)
        return result
    except (ValueError, TypeError, KeyError, RecursionError, ValidationError, ResultValidationError):
        pass
    raise ResultValidationError(category)


def _sample_overlap(left, right):
    return left.start_sample < right.end_sample and right.start_sample < left.end_sample


def _interval_ms(interval, count):
    _require(isinstance(interval, SampleInterval) and interval.end_sample <= count)
    return dict(startMs=interval.start_sample * 1000 // 16000,
                endMs=(interval.end_sample * 1000 + 15999) // 16000)


def _provenance(outcome, settings):
    p = outcome.provenance
    pre = p.preprocessing
    versions = [
        ("normalization", pre.normalization.normalizer_version),
        ("detection", pre.detection.detector_version), ("speech-map", pre.speech_map.mapper_version),
        ("planning", p.planning.planner_version), ("asr-adapter", "openrouter-whisper-v1"),
        ("coverage", p.coverage.assessor_version), ("recovery", p.recovery.recovery_version),
        ("reconciliation", p.reconciliation.reconciler_version), ("correction", p.correction.correction_version),
    ]
    models = []
    for _, model in (*p.asr.asr, *p.coverage.asr, *p.reconciliation.asr):
        entry = dict(role="ASR", provider=model.provider, requestedModel=model.requested_model,
                     resolvedModel=model.resolved_model)
        if entry not in models:
            models.append(entry)
    models.append(dict(role="CORRECTION", provider=p.correction.provider,
                       requestedModel=p.correction.requested_model, resolvedModel=p.correction.resolved_model))
    # Explicit effective inference configuration only. No transport credentials,
    # paths, endpoints, provider response maps or environment dumps are included.
    config = {k: v for k, v in settings.model_dump(mode="json").items()
              if k.startswith(("audio_", "transcript_correction_"))
              and k not in ("audio_temp_dir", "audio_vad_model_path")}
    snapshot = json.dumps(dict(version="worker-config-v1", settings=config), sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode()
    return dict(pipelineVersion=p.pipeline_version, configurationSha256=hashlib.sha256(snapshot).hexdigest(),
                components=[dict(name=name, version=version) for name, version in versions],
                vadModel=dict(modelId=pre.detection.model_id, modelVersion=pre.detection.model_version,
                              sha256=pre.detection.model_sha256), models=models)


def map_result(outcome, settings, *, job_id, media_id, source_revision, producer_id):
    category = "VALIDATION"
    try:
        _require(isinstance(outcome, OfflineTranscriptionOutcome)
                 and outcome.status in (OfflineTranscriptionStatus.COMPLETED, OfflineTranscriptionStatus.COMPLETED_WITH_WARNINGS)
                 and outcome.failure is None and outcome.completed_stages == tuple(OfflineTranscriptionStage))
        result = outcome.result
        _require(isinstance(result, TranscriptCorrectionResult))
        if not result.segments or not any(s.text.strip() for s in result.segments):
            raise ResultValidationError("EMPTY_OUTPUT")
        evidence = outcome.evidence
        count = result.sample_count
        _require(result.source_id == outcome.provenance.source_id == evidence.source_id == media_id
                 and result.sample_rate_hz == outcome.provenance.sample_rate_hz == 16000
                 and count == outcome.provenance.sample_count == evidence.audio_metadata.sample_count
                 and evidence.provenance == outcome.provenance
                 and outcome.provenance.preprocessing.source_id == media_id
                 and outcome.provenance.preprocessing.sample_count == count
                 and evidence.audio_metadata.source_metadata.source_id == media_id
                 and result.provenance == outcome.provenance.correction
                 and result.coverage == evidence.coverage == evidence.recovery.final_assessment
                 and result.coverage.source_id == media_id and result.coverage.sample_count == count
                 and result.coverage.provenance == outcome.provenance.coverage
                 and evidence.reconciliation.provenance == outcome.provenance.reconciliation
                 and result.unresolved_intervals == evidence.reconciliation.unresolved_intervals
                 and result.quality.validated_segment_count == result.quality.segment_count == len(result.segments)
                 and outcome.warnings == evidence.warnings)
        segments = []
        _require(len(result.segments) == len(evidence.reconciliation.segments))
        for segment, original in zip(result.segments, evidence.reconciliation.segments, strict=True):
            _require(isinstance(segment, CorrectedSegment) and segment.segment_id == original.segment_id
                     and segment.ordinal == original.ordinal and segment.interval == original.interval
                     and segment.flags == original.flags and segment.source_chunk_ids == original.source_chunk_ids)
            unresolved = any(_sample_overlap(segment.interval, interval) for interval in (
                *result.coverage.unresolved_intervals, *result.unresolved_intervals,
            )) or any(r.state.value == "UNRESOLVED_ERROR" and _sample_overlap(segment.interval, r.interval)
                      for r in result.coverage.regions)
            suspicious = bool(segment.flags) or any(
                r.state.value == "SUSPICIOUS" and _sample_overlap(segment.interval, r.interval)
                for r in result.coverage.regions
            )
            segments.append(dict(ordinal=segment.ordinal, **_interval_ms(segment.interval, count), text=segment.text,
                                 qualityStatus="UNRESOLVED" if unresolved else "SUSPICIOUS" if suspicious else "ACCEPTED"))
        coverage = []
        for region in result.coverage.regions:
            attempts = [a for a in evidence.recovery.attempts
                        if _sample_overlap(a.window.chunk.request_interval, region.interval)]
            supported = any(a.failure is None and a.window.chunk.chunk_id in region.supporting_chunk_ids
                            for a in attempts)
            coverage.append(dict(**_interval_ms(region.interval, count), coverageStatus=region.state.value,
                                 recovered=supported, retryCount=len(attempts)))
        warnings = [dict(stage=w.stage.name, code=w.code,
                         startSample=w.interval.start_sample if w.interval else None,
                         endSample=w.interval.end_sample if w.interval else None,
                         sourceChunkIds=list(w.source_chunk_ids), phase=w.phase) for w in outcome.warnings]
        data = dict(contractVersion="1.0", resultType="CORRECTED_TRANSCRIPT", processingJobId=job_id,
                    sourceMediaId=media_id, sourceRevision=source_revision, producerStageRunId=producer_id,
                    pipelineStatus=outcome.status.value, languageCode=settings.audio_asr_language,
                    sampleRateHz=16000, sampleCount=count, durationMs=(count * 1000 + 15999) // 16000,
                    segments=segments, coverage=coverage, warnings=warnings, provenance=_provenance(outcome, settings),
                    correctionProof=dict(contextScope="WHOLE_MEETING", promptVersion=result.provenance.prompt_version,
                                         outputSha256=correction_digest(segments)))
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        validate_result_bytes(raw, job_id=job_id, media_id=media_id,
                              source_revision=source_revision, producer_id=producer_id)
        return raw
    except ResultValidationError as error:
        category = error.category
    except Exception:
        pass
    raise ResultValidationError(category)


class WorkFailure(Exception):
    def __init__(self, phase, category, completed_through=None, metrics=None):
        self.phase, self.category = phase, category
        self.completed_through, self.metrics = completed_through, metrics or {}
        super().__init__("WORKER_EXECUTION_FAILED")


_CATEGORIES = frozenset(("VALIDATION", "DECODING", "RESOURCE", "TIMEOUT", "PROVIDER", "TRANSPORT",
    "RATE_LIMIT", "AUTHENTICATION", "CONFIGURATION", "CONTEXT_OVERFLOW", "MALFORMED_OUTPUT",
    "SUSPICIOUS_OUTPUT", "INTEGRITY", "NOT_FOUND", "EMPTY_OUTPUT", "CANCELLED"))


def pipeline_failure(outcome):
    failure = outcome.failure
    category = failure.category if failure.category in _CATEGORIES else {
        "MODEL_UNAVAILABLE": "CONFIGURATION", "INFERENCE": "RESOURCE",
    }.get(failure.category, "RESOURCE")
    completed = None
    metrics = {}
    # Only the validated completed prefix and text-free evidence authorize the
    # partial-stage proof. A failed outcome's nonnull result is never serialized.
    if (failure.stage is OfflineTranscriptionStage.CORRECTION
            and outcome.completed_stages == tuple(OfflineTranscriptionStage)[:-1]
            and outcome.evidence.reconciliation is not None and outcome.evidence.coverage is not None
            and outcome.evidence.source_id == outcome.provenance.source_id
            and outcome.evidence.reconciliation.provenance == outcome.provenance.reconciliation):
        completed = "RECONCILIATION"
        count = outcome.provenance.sample_count
        if type(count) is int and 0 <= count <= 230400000:
            metrics["sampleCount"] = count
        metrics["warningCount"] = len(outcome.warnings)
        metrics["unresolvedRegionCount"] = len(outcome.evidence.coverage.unresolved_intervals)
    return WorkFailure(failure.stage.name, category, completed, metrics)


@dataclass(frozen=True, repr=False)
class PreparedResult:
    raw: bytes
    producer_id: str

    @property
    def digest(self):
        return hashlib.sha256(self.raw).hexdigest()


class LeaseGuard:
    def __init__(self, core, event, claim, round_trip, maximum_seconds):
        self.core, self.event, self.claim = core, event, claim
        self.fence = threading.Event()
        self.lost = asyncio.Event()
        self.deadline = 0
        self.renew_after = 0
        self.maximum = asyncio.get_running_loop().time() + maximum_seconds
        self.confirm(claim, round_trip)
        self.task = asyncio.create_task(self._renew())

    def confirm(self, lease, round_trip):
        remaining = (datetime.fromisoformat(lease.leaseExpiresAt) - datetime.fromisoformat(lease.serverTime)).total_seconds()
        self.deadline = min(self.maximum, asyncio.get_running_loop().time() + remaining - round_trip - 5)
        self.renew_after = lease.renewAfterSeconds
        if self.deadline <= asyncio.get_running_loop().time():
            self.lose()

    def lose(self):
        self.fence.set()
        self.lost.set()

    def live(self):
        if asyncio.get_running_loop().time() >= self.deadline:
            self.lose()
        return not self.fence.is_set()

    async def _renew(self):
        try:
            while self.live():
                remaining = self.deadline - asyncio.get_running_loop().time()
                await asyncio.sleep(min(self.renew_after, max(0, remaining)))
                if not self.live():
                    break
                start = asyncio.get_running_loop().time()
                lease = await self.core.request(self.event, "renew", claim_fields(self.claim), deadline=self.deadline)
                self.confirm(lease, asyncio.get_running_loop().time() - start)
        except CoreError as error:
            if error.stop_intake:
                self.core_stop = True
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


class TranscriptionWorker:
    def __init__(self, settings, core, storage, pipeline):
        self.settings, self.core, self.storage, self.pipeline = settings, core, storage, pipeline
        self.stop_intake = asyncio.Event()
        self._slots = asyncio.Semaphore(settings.worker_concurrency)
        self._executor = ThreadPoolExecutor(max_workers=settings.worker_concurrency, thread_name_prefix="transcription")
        self._pending = set()
        self._closed = False

    def _prepare(self, claim, fence):
        binding = dict(job_id=claim.processingJobId, media_id=claim.sourceMediaId,
                       source_revision=claim.source.sourceRevision)
        references = [(claim.resultSlot, claim.executionStageRunId)]
        if claim.reusableResult:
            references.append((claim.reusableResult, claim.reusableResult.producerStageRunId))
        phase = "RESULT_STORAGE"
        try:
            for reference, producer in references:
                try:
                    raw = self.storage.get_result(reference.storageId, reference.objectKey, fence)
                except StorageError as error:
                    if error.category == "NOT_FOUND":
                        continue
                    raise
                phase = "RESULT_VALIDATION"
                validate_result_bytes(raw, **binding, producer_id=producer)
                return PreparedResult(raw, producer)
            if claim.executionStageCode == "FINALIZING_TRANSCRIPT":
                raise WorkFailure("PUBLICATION", "NOT_FOUND")
            phase = "SOURCE_DOWNLOAD"
            with self.storage.source_file(claim.source, fence) as path:
                if fence.is_set():
                    raise WorkFailure("INTERRUPTED", "CANCELLED")
                phase = "PREPROCESSING"
                outcome = self.pipeline.run(AudioSource(claim.sourceMediaId, path))
            if not isinstance(outcome, OfflineTranscriptionOutcome):
                raise WorkFailure("RESULT_VALIDATION", "VALIDATION")
            if outcome.status is OfflineTranscriptionStatus.FAILED:
                raise pipeline_failure(outcome)
            phase = "RESULT_VALIDATION"
            raw = map_result(outcome, self.settings, **binding, producer_id=claim.executionStageRunId)
            if fence.is_set():
                raise WorkFailure("INTERRUPTED", "CANCELLED")
            phase = "RESULT_STORAGE"
            stored = self.storage.put_result(claim.resultSlot.storageId, claim.resultSlot.objectKey, raw, fence)
            phase = "RESULT_VALIDATION"
            validate_result_bytes(stored, **binding, producer_id=claim.executionStageRunId)
            return PreparedResult(stored, claim.executionStageRunId)
        except WorkFailure:
            raise
        except StorageError as error:
            category = error.category
        except ResultValidationError as error:
            category = error.category
        except Exception:
            category = "RESOURCE"
        raise WorkFailure(phase, category)

    async def _terminal_command(self, event, claim, guard, operation, body):
        # A single shared budget covers command -> lookup -> identical command.
        budget = TransportBudget(self.settings.core_api_max_attempts)
        querying = False
        can_resend = True
        error = None
        while budget.remaining:
            if not querying and not guard.live():
                querying = True
            try:
                if querying:
                    status = await self.core.lookup(event, budget=budget, once=True)
                else:
                    status = await self.core.request(event, operation, body, budget=budget,
                                                     once=True, deadline=guard.deadline)
                if isinstance(status, DeliveryStatus) and status.durable:
                    return status
                if not guard.live():
                    break
                if querying and not can_resend:
                    break
                querying = False
            except CoreError as caught:
                error = caught
                if error.stop_intake:
                    self.stop_intake.set()
                    break
                if (not querying and error.status in (400, 413, 415, 422)
                        and operation == "complete"):
                    # A definitive result rejection permits a typed failure,
                    # using what remains of this same terminal-cycle budget.
                    operation = "fail"
                    body = dict(**claim_fields(claim), commandId=str(uuid4()), phase="RESULT_VALIDATION",
                                category="VALIDATION", completedThrough=None, metrics={})
                    querying = False
                elif error.retryable or error.status == 409 or error.status >= 500:
                    querying = True
                    can_resend = error.retryable
                    if error.status == 409:
                        guard.lose()
                    if budget.remaining and error.retryable:
                        await self.core.backoff(budget, error)
                else:
                    break
        if error and error.status == 409:
            return None
        return None

    async def _unresolved(self, delivery, *, dead=False):
        count = delivery.headers.get("x-delivery-count", 0)
        if getattr(delivery, "redelivered", False) and "x-delivery-count" not in delivery.headers:
            # A classic/misprovisioned queue cannot silently create an unbounded
            # crash-redelivery loop when the required broker counter is absent.
            dead = True
        if type(count) is not int or count < 0:
            dead = True
        if dead or (type(count) is int and count >= self.settings.rabbitmq_delivery_limit):
            await delivery.reject(requeue=False)
        else:
            await delivery.nack(requeue=True)

    async def handle(self, delivery):
        await self._slots.acquire()
        pending = None
        guard = None
        event = claim = None
        try:
            event = decode_event(delivery.body, headers=delivery.headers, message_id=delivery.message_id,
                                 content_type=delivery.content_type, delivery_mode=delivery.delivery_mode)
            with correlation_scope(new_correlation_context(request_id=event.requestId, job_id=event.processingJobId)):
                started = asyncio.get_running_loop().time()
                claim = await self.core.claim(event)
                if isinstance(claim, DeliveryStatus):
                    if claim.durable:
                        await delivery.ack()
                    else:
                        await self._unresolved(delivery)
                    return
                guard = LeaseGuard(self.core, event, claim, asyncio.get_running_loop().time() - started,
                                   self.settings.worker_execution_timeout_seconds)
                pending = self._executor.submit(copy_context().run, self._prepare, claim, guard.fence)
                self._pending.add(pending)
                wrapped = asyncio.wrap_future(pending)
                # Consume late exceptions even after a lease/cancellation fences
                # this handler. Completed futures must not retain result bytes.
                wrapped.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
                failure = None
                try:
                    prepared = await guard.protect(asyncio.shield(wrapped))
                except WorkFailure as caught:
                    failure = caught
                if getattr(guard, "core_stop", False):
                    self.stop_intake.set()
                if failure:
                    if failure.category in ("CONFIGURATION", "AUTHENTICATION"):
                        self.stop_intake.set()
                    if failure.phase == "RESULT_STORAGE" and failure.category in ("TRANSPORT", "TIMEOUT", "RESOURCE"):
                        # PUT may have succeeded. Keep immutable bytes for the next
                        # authorized owner; never contradict an uncertain result.
                        status = await self.core.lookup(event)
                    else:
                        command = dict(**claim_fields(claim), commandId=str(uuid4()), phase=failure.phase,
                            category=failure.category, completedThrough=failure.completed_through, metrics=failure.metrics)
                        status = await self._terminal_command(event, claim, guard, "fail", command)
                else:
                    command = dict(**claim_fields(claim), commandId=str(uuid4()), resultSha256=prepared.digest,
                                   resultProducerStageRunId=prepared.producer_id)
                    status = await self._terminal_command(event, claim, guard, "complete", command)
                if status is not None and status.durable:
                    await delivery.ack()
                else:
                    await self._unresolved(delivery, dead=not guard.live())
        except MessageError:
            await delivery.reject(requeue=False)
        except CoreError as error:
            if error.stop_intake or (guard and getattr(guard, "core_stop", False)):
                self.stop_intake.set()
            if event is not None and error.status == 409:
                try:
                    status = await self.core.lookup(event)
                    if status.durable:
                        await delivery.ack()
                        return
                except CoreError as lookup_error:
                    if lookup_error.stop_intake:
                        self.stop_intake.set()
            await self._unresolved(delivery, dead=error.status in (404, 409, 422) and error.code != "WORKER_ATTEMPT_BUSY")
        except asyncio.CancelledError:
            # Runtime cancellation leaves the delivery unacknowledged. A late
            # synchronous reader owns its source until its own finally executes.
            raise
        except Exception:
            # Includes ACK/connection failure: no contradictory failure command.
            self.stop_intake.set()
        finally:
            if guard:
                await guard.close()
            if pending is not None and not pending.done():
                loop = asyncio.get_running_loop()

                def release(_):
                    if not loop.is_closed():
                        loop.call_soon_threadsafe(self._pending.discard, pending)
                        loop.call_soon_threadsafe(self._slots.release)

                pending.add_done_callback(release)
            else:
                self._pending.discard(pending)
                self._slots.release()

    async def run(self, broker, shutdown_requested):
        await broker.start(self.handle)
        waits = [asyncio.create_task(e.wait()) for e in (shutdown_requested, self.stop_intake, broker.failure)]
        closed = asyncio.ensure_future(asyncio.shield(broker.connection.closed()))
        try:
            await asyncio.wait((*waits, closed), return_when=asyncio.FIRST_COMPLETED)
            await broker.stop()
            await broker.drain()
            if self.stop_intake.is_set() or broker.failure.is_set() or closed.done():
                raise RuntimeError("worker.transcription.stopped")
        finally:
            await broker.stop()
            for wait in (*waits, closed):
                wait.cancel()
            await asyncio.gather(*waits, closed, return_exceptions=True)

    async def aclose(self, *, wait=True):
        if not self._closed:
            self._closed = True
            self._executor.shutdown(wait=False, cancel_futures=True)
        if wait and self._pending:
            await asyncio.gather(*(asyncio.wrap_future(f) for f in tuple(self._pending)), return_exceptions=True)


class TranscriptionExecution:
    """Runtime-owned composition; synchronous resources outlive active readers."""

    def __init__(self, settings):
        self.settings = settings
        self._async = AsyncExitStack()
        self._sync = ExitStack()
        self.worker = None
        self.broker = None

    async def __aenter__(self):
        from sme_meeting_ai.audio import (
            AudioEvidenceDetector,
            AudioNormalizer,
            SpeechMapBuilder,
        )
        from sme_meeting_ai.audio.vad import SileroVadBackend
        from sme_meeting_ai.integrations.core_api import CoreApiClient
        from sme_meeting_ai.integrations.messaging import RabbitConsumer
        from sme_meeting_ai.integrations.object_storage import ObjectStorage
        from sme_meeting_ai.pipeline import (
            AudioPreprocessingPipeline,
            OfflineTranscriptionPipeline,
        )
        from sme_meeting_ai.providers.openrouter_instruction_llm import (
            OpenRouterInstructionLlmAdapter,
        )
        from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
        from sme_meeting_ai.transcription.chunk_planning import (
            SpeechAwareAsrChunkPlanner,
        )

        failed = False
        try:
            if not self.settings.openrouter_api_key or not self.settings.transcript_correction_model:
                raise ValueError
            core = CoreApiClient(self.settings)
            self._async.push_async_callback(core.aclose)
            storage = self._sync.enter_context(ObjectStorage(self.settings))
            backend = SileroVadBackend.from_settings(self.settings)
            self._sync.callback(backend.close)
            transcriber = self._sync.enter_context(OpenRouterWhisperAdapter(self.settings))
            corrector = self._sync.enter_context(OpenRouterInstructionLlmAdapter(self.settings))
            pipeline = OfflineTranscriptionPipeline(
                AudioPreprocessingPipeline(AudioNormalizer(self.settings),
                    AudioEvidenceDetector(self.settings, backend), SpeechMapBuilder(self.settings)),
                SpeechAwareAsrChunkPlanner(self.settings), transcriber, corrector, self.settings,
            )
            self.worker = TranscriptionWorker(self.settings, core, storage, pipeline)
            self.broker = await self._async.enter_async_context(RabbitConsumer(self.settings))
            return self
        except Exception:
            failed = True
        if failed:
            await self.__aexit__(None, None, None)
            raise RuntimeError("worker.transcription.startup.failed")

    async def __call__(self, shutdown_requested):
        await self.worker.run(self.broker, shutdown_requested)

    async def __aexit__(self, *_):
        try:
            await self._async.aclose()
        finally:
            pending = tuple(self.worker._pending) if self.worker else ()
            if self.worker:
                await self.worker.aclose(wait=False)
            if not pending:
                self._sync.close()
            else:
                # Concurrent-future callbacks still run if the asyncio loop has
                # closed. Never close VAD/providers while their reader is alive.
                lock = threading.Lock()
                remaining = set(pending)

                def finished(future):
                    with lock:
                        remaining.discard(future)
                        if not remaining:
                            # ExitStack attempts every close. Suppress raw
                            # filesystem/provider exceptions in future callbacks.
                            try:
                                self._sync.close()
                            except Exception:
                                import logging

                                from sme_meeting_ai.observability.logging import (
                                    log_event,
                                )

                                log_event(logging.getLogger(__name__), logging.ERROR,
                                          "worker.transcription.cleanup.failed")

                for future in pending:
                    future.add_done_callback(finished)
