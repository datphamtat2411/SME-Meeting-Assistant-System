"""Bounded, independent ASR calls on exact, unchanged source sample intervals."""

import io
import math
import re
import time
import traceback
import unicodedata
import wave
from concurrent.futures import FIRST_COMPLETED, CancelledError, ThreadPoolExecutor, wait
from dataclasses import dataclass, field, replace
from enum import StrEnum
from fractions import Fraction
from threading import Lock
from typing import TYPE_CHECKING

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import (
    AudioSource,
    NormalizedAudioArtifact,
    SampleInterval,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.preprocessing import _validate_normalization

from .asr import (
    AsrAudioChunk,
    AsrCandidate,
    AsrError,
    AsrErrorCategory,
    AsrSegment,
    AsrTranscriber,
)
from .chunk_planning import AsrChunk, AsrChunkPlan, validate_asr_chunk_plan

if TYPE_CHECKING:
    from .recovery import RecoveryWindow

_RATE = 16000
_WAV_HEADER_BYTES = 44


@dataclass(frozen=True, slots=True)
class AsrTimelineSegment:
    """Original provisional segment with exact absolute, half-open sample bounds."""

    segment: AsrSegment = field(repr=False)
    interval: SampleInterval


@dataclass(frozen=True, slots=True)
class AsrDecodeAttempt:
    """Actual source request/selection only; discarded wording is never retained."""

    interval: SampleInterval
    selected: bool
    failure: AsrErrorCategory | None = None


class AsrRecheckOutcome(StrEnum):
    REPLACED = "replaced"
    CORROBORATED = "corroborated"
    INCONCLUSIVE = "inconclusive"
    LIMIT_REACHED = "limit-reached"


@dataclass(frozen=True, slots=True)
class AsrChunkResult:
    """Transient evidence or category-only failure, never a durable transcript."""

    chunk: AsrChunk
    candidate: AsrCandidate | None = field(default=None, repr=False)
    timeline_segments: tuple[AsrTimelineSegment, ...] = ()
    failure: AsrErrorCategory | None = None
    decoding_attempts: tuple[AsrDecodeAttempt, ...] = ()
    recheck_outcome: AsrRecheckOutcome | None = None


class _RecheckBudget:
    def __init__(self, maximum):
        self.remaining = maximum
        self.lock = Lock()

    def reserve(self):
        with self.lock:
            if self.remaining <= 0:
                return False
            self.remaining -= 1
            return True


def _comparison(text):
    folded = unicodedata.normalize("NFKD", text.casefold().replace("đ", "d"))
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", folded).split())


def _boilerplate_only(candidate):
    """Known Whisper failure family is a re-observation signal, never a blacklist."""
    texts = [s.text for s in candidate.segments if s.text.strip()]
    if not texts:
        return False
    for text in texts:
        value = _comparison(text)
        if (len(value.split()) > 64 or not re.match(
                r"^(?:cac ban )?(?:hay |nho |dung quen )?(?:subscribe|subcribe|dang ky) (?:cho )?kenh\b", value)
                or "khong bo lo" not in value or "video" not in value):
            return False
    return True


def _require(condition: bool) -> None:
    if not condition:
        raise AsrError(AsrErrorCategory.VALIDATION)


def _validate_wav(reader: wave.Wave_read, sample_count: int) -> None:
    _require(
        reader.getnchannels() == 1 and reader.getsampwidth() == 2
        and reader.getframerate() == _RATE and reader.getcomptype() == "NONE"
        and reader.getnframes() == sample_count
    )
    # Check physical availability without reading the whole source into memory.
    # Reading past the final frame also rejects odd, incomplete PCM sample bytes.
    reader.setpos(sample_count - 1)
    _require(len(reader.readframes(2)) == 2)


def _validate_handoff(
    plan: AsrChunkPlan, audio: NormalizedAudioArtifact,
    transcriber: AsrTranscriber, settings: Settings,
) -> None:
    try:
        validate_asr_chunk_plan(plan)
        _require(isinstance(audio, NormalizedAudioArtifact) and isinstance(settings, Settings))
        _validate_normalization(AudioSource(plan.source_id, audio.path), audio)
        _require(
            audio.sample_count == plan.sample_count
            and audio.provenance == plan.provenance.preprocessing.normalization
            and callable(getattr(transcriber, "transcribe", None))
        )
        concurrency, payload_limit = settings.audio_asr_max_concurrent_chunks, settings.audio_asr_max_payload_bytes
        timeout = settings.audio_asr_timeout_seconds
        _require(type(concurrency) is int and 1 <= concurrency <= 4)
        _require(type(payload_limit) is int and 0 < payload_limit <= 26214400)
        _require(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 600)
        rechecks = settings.audio_asr_recovery_max_total_attempts
        _require(type(rechecks) is int and 1 <= rechecks <= 256)
        with wave.open(str(audio.path), "rb") as reader:
            _validate_wav(reader, plan.sample_count)
        return
    except (AsrError, AudioProcessingError, OSError, EOFError, wave.Error,
            AttributeError, TypeError, ValueError, KeyError, OverflowError):
        pass
    # Discard all input-bearing exception context before scheduling provider work.
    raise AsrError(AsrErrorCategory.VALIDATION)


def _extract_audio(chunk: AsrChunk, audio: NormalizedAudioArtifact, payload_limit: int) -> AsrAudioChunk:
    interval = chunk.request_interval
    count = interval.end_sample - interval.start_sample
    if _WAV_HEADER_BYTES + count * 2 > payload_limit:
        raise AsrError(AsrErrorCategory.RESOURCE)
    with wave.open(str(audio.path), "rb") as reader:
        _validate_wav(reader, audio.sample_count)
        reader.setpos(interval.start_sample)
        pcm = reader.readframes(count)
        if len(pcm) != count * 2:
            raise AsrError(AsrErrorCategory.VALIDATION)
    with io.BytesIO() as buffer:
        with wave.open(buffer, "wb") as writer:
            writer.setparams((1, 2, _RATE, 0, "NONE", "not compressed"))
            writer.writeframes(pcm)
        payload = buffer.getvalue()
    if len(payload) != _WAV_HEADER_BYTES + count * 2 or len(payload) > payload_limit:
        raise AsrError(AsrErrorCategory.RESOURCE)
    return AsrAudioChunk(chunk.chunk_id, payload, Fraction(count, _RATE))


def _translate_candidate(candidate: AsrCandidate, chunk: AsrChunk) -> tuple[AsrTimelineSegment, ...]:
    if (
        not isinstance(candidate, AsrCandidate) or candidate.chunk_id != chunk.chunk_id
        or not isinstance(candidate.text, str) or not isinstance(candidate.segments, tuple)
        or (candidate.text and not candidate.segments)
    ):
        raise AsrError(AsrErrorCategory.MALFORMED_OUTPUT)
    translated = []
    previous_end = Fraction(0)
    previous_end_sample = 0
    request = chunk.request_interval
    request_sample_count = request.end_sample - request.start_sample
    for segment in candidate.segments:
        if (
            not isinstance(segment, AsrSegment) or not isinstance(segment.text, str)
            or not isinstance(segment.start, Fraction) or not isinstance(segment.end, Fraction)
            or not previous_end <= segment.start < segment.end <= request.duration
        ):
            raise AsrError(AsrErrorCategory.MALFORMED_OUTPUT)
        # Fraction rounding is exact nearest-sample quantization, ties to even.
        # Original rational checks above prevent rounding from hiding violations.
        start, end = round(segment.start * _RATE), round(segment.end * _RATE)
        if not 0 <= previous_end_sample <= start < end <= request_sample_count:
            raise AsrError(AsrErrorCategory.MALFORMED_OUTPUT)
        translated.append(AsrTimelineSegment(segment, SampleInterval(
            request.start_sample + start, request.start_sample + end,
        )))
        previous_end = segment.end
        previous_end_sample = end
    return tuple(translated)


def _decode_chunk(
    chunk: AsrChunk, audio: NormalizedAudioArtifact, transcriber: AsrTranscriber, payload_limit: int,
) -> AsrChunkResult:
    failure = AsrErrorCategory.RESOURCE
    audio_chunk = None
    candidate = None
    cancellation = None
    try:
        audio_chunk = _extract_audio(chunk, audio, payload_limit)
        failure = AsrErrorCategory.PROVIDER
        candidate = transcriber.transcribe(audio_chunk)
        failure = AsrErrorCategory.MALFORMED_OUTPUT
        segments = _translate_candidate(candidate, chunk)
        return AsrChunkResult(chunk, candidate, segments)
    except CancelledError as error:
        cancellation = error
    except AsrError as error:
        if isinstance(error.category, AsrErrorCategory):
            failure = error.category
        traceback.clear_frames(error.__traceback__)
    except TimeoutError as error:
        failure = AsrErrorCategory.TIMEOUT
        traceback.clear_frames(error.__traceback__)
    except MemoryError as error:
        failure = AsrErrorCategory.RESOURCE
        traceback.clear_frames(error.__traceback__)
    except Exception as error:
        # Unknown provider diagnostics and extraction paths never leave this call.
        traceback.clear_frames(error.__traceback__)
    except BaseException as error:
        cancellation = error
    finally:
        # The result and executor futures never retain serialized request audio.
        audio_chunk = None
        candidate = None
    if cancellation is not None:
        # Futures retain propagated exceptions: release request-bearing provider
        # and extraction frames before handing whole-execution cancellation back.
        traceback.clear_frames(cancellation.__traceback__)
        raise cancellation.with_traceback(None)
    return AsrChunkResult(chunk=chunk, failure=failure)


def _execute_chunk(
    chunk: AsrChunk, audio: NormalizedAudioArtifact, transcriber: AsrTranscriber, payload_limit: int,
    recheck_budget: _RecheckBudget | None = None,
) -> AsrChunkResult:
    original = retry = value = None
    try:
        original = _decode_chunk(chunk, audio, transcriber, payload_limit)
        if (original.failure is not None or recheck_budget is None
                or chunk.core_interval == chunk.request_interval or not _boilerplate_only(original.candidate)):
            return original
        first = AsrDecodeAttempt(chunk.request_interval, True)
        if not recheck_budget.reserve():
            return replace(original, decoding_attempts=(first,), recheck_outcome=AsrRecheckOutcome.LIMIT_REACHED)
        # Decode the exact original core independently, without the possibly
        # poisoned overlap. No silence insertion, sample removal or new wording.
        retry = _decode_chunk(replace(chunk, request_interval=chunk.core_interval), audio, transcriber, payload_limit)
        if retry.failure is None:
            from .coverage import _valid_result

            if not _valid_result(retry):
                retry = AsrChunkResult(retry.chunk, failure=AsrErrorCategory.MALFORMED_OUTPUT)
        second = AsrDecodeAttempt(chunk.core_interval, False, retry.failure)
        outcome = AsrRecheckOutcome.INCONCLUSIVE
        if retry.failure is None:
            if _comparison(retry.candidate.text) == _comparison(original.candidate.text):
                outcome = AsrRecheckOutcome.CORROBORATED
            elif (retry.candidate.text.strip() and not _boilerplate_only(retry.candidate)
                  and len(retry.candidate.text.split()) >= len(original.candidate.text.split())):
                # Candidate coordinates must remain relative to the unchanged
                # published request. This exact offset preserves provider timing.
                offset = Fraction(chunk.core_interval.start_sample - chunk.request_interval.start_sample, _RATE)
                value = replace(retry.candidate, segments=tuple(
                    replace(s, start=s.start + offset, end=s.end + offset) for s in retry.candidate.segments
                ), words=(tuple(replace(w, start=w.start + offset, end=w.end + offset)
                                for w in retry.candidate.words) if retry.candidate.words is not None else None))
                return AsrChunkResult(
                    chunk, value, _translate_candidate(value, chunk),
                    decoding_attempts=(replace(first, selected=False), replace(second, selected=True)),
                    recheck_outcome=AsrRecheckOutcome.REPLACED,
                )
        return replace(original, decoding_attempts=(first, second), recheck_outcome=outcome)
    except BaseException as error:
        traceback.clear_frames(error.__traceback__)
        raise
    finally:
        original = retry = value = None


def execute_asr_chunks(
    plan: AsrChunkPlan, normalized_audio: NormalizedAudioArtifact,
    transcriber: AsrTranscriber, settings: Settings,
) -> tuple[AsrChunkResult, ...]:
    """Execute each captured request independently, returning plan ordinal order.

    The caller keeps normalized_audio open throughout execution and owns it and
    the transcriber/client. With concurrency > 1, the transcriber must support
    concurrent calls. It must use the existing finite provider timeout contract;
    this synchronous executor does not introduce a second request timeout.

    Candidates and payloads are transient and must not be logged or persisted.
    Cancellation propagates after pending work is cancelled and active calls
    finish within their provider timeout; executor-owned threads are joined.
    """
    _validate_handoff(plan, normalized_audio, transcriber, settings)
    concurrency = settings.audio_asr_max_concurrent_chunks
    payload_limit = settings.audio_asr_max_payload_bytes
    executor = ThreadPoolExecutor(max_workers=concurrency)
    pending = set()
    chunks = iter(plan.chunks)
    results = {}
    rechecks = _RecheckBudget(settings.audio_asr_recovery_max_total_attempts)
    try:
        for _ in range(min(concurrency, len(plan.chunks))):
            pending.add(executor.submit(_execute_chunk, next(chunks), normalized_audio, transcriber, payload_limit, rechecks))
        while pending:
            completed, pending = wait(pending, return_when=FIRST_COMPLETED)
            # Consume every completion before replenishing the bounded window.
            # A cancellation therefore stops further submission immediately.
            for future in completed:
                result = future.result()
                results[result.chunk.ordinal] = result
            for _ in completed:
                chunk = next(chunks, None)
                if chunk is not None:
                    pending.add(executor.submit(_execute_chunk, chunk, normalized_audio, transcriber, payload_limit, rechecks))
    finally:
        for future in pending:
            future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)
    return tuple(results[chunk.ordinal] for chunk in plan.chunks)


def execute_asr_windows(
    windows: tuple["RecoveryWindow", ...], normalized_audio: NormalizedAudioArtifact,
    transcriber: AsrTranscriber, settings: Settings,
) -> tuple[AsrChunkResult, ...]:
    """Execute only supplied recovery windows, sequentially in stable ordinal order.

    Borrowed artifact/client ownership and the finite provider timeout contract
    are identical to baseline execution. No baseline partition is re-executed.
    All window handoffs are validated before the first request is extracted.
    """
    from .recovery import _validate_execution_windows

    started = time.monotonic()
    try:
        _validate_execution_windows(windows, normalized_audio, transcriber, settings)
        ordered = sorted(windows, key=lambda w: (w.chunk.ordinal, w.chunk.chunk_id))
    except (AsrError, AudioProcessingError, OSError, EOFError, wave.Error,
            AttributeError, TypeError, ValueError, KeyError, OverflowError):
        pass
    else:
        from .coverage import _valid_result

        results = []
        for window in ordered:
            if time.monotonic() - started + settings.audio_asr_timeout_seconds > settings.audio_asr_recovery_max_wall_time_seconds:
                results.append(AsrChunkResult(window.chunk, failure=AsrErrorCategory.TIMEOUT))
            else:
                result = _execute_chunk(window.chunk, normalized_audio, transcriber,
                                        settings.audio_asr_max_payload_bytes)
                if result.failure is None and not _valid_result(result):
                    result = AsrChunkResult(window.chunk, failure=AsrErrorCategory.MALFORMED_OUTPUT)
                results.append(result)
        return tuple(results)
    raise AsrError(AsrErrorCategory.VALIDATION)
