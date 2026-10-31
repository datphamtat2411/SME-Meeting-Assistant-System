"""Bounded, independent ASR calls on exact, unchanged source sample intervals."""

import io
import math
import traceback
import wave
from concurrent.futures import CancelledError, FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from fractions import Fraction

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import AudioSource, NormalizedAudioArtifact, SampleInterval
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

_RATE = 16000
_WAV_HEADER_BYTES = 44


@dataclass(frozen=True, slots=True)
class AsrTimelineSegment:
    """Original provisional segment with exact absolute, half-open sample bounds."""

    segment: AsrSegment = field(repr=False)
    interval: SampleInterval


@dataclass(frozen=True, slots=True)
class AsrChunkResult:
    """Transient evidence or category-only failure, never a durable transcript."""

    chunk: AsrChunk
    candidate: AsrCandidate | None = field(default=None, repr=False)
    timeline_segments: tuple[AsrTimelineSegment, ...] = ()
    failure: AsrErrorCategory | None = None


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
    request = chunk.request_interval
    for segment in candidate.segments:
        if (
            not isinstance(segment, AsrSegment) or not isinstance(segment.text, str)
            or not isinstance(segment.start, Fraction) or not isinstance(segment.end, Fraction)
            or not previous_end <= segment.start < segment.end <= request.duration
        ):
            raise AsrError(AsrErrorCategory.MALFORMED_OUTPUT)
        start, end = segment.start * _RATE, segment.end * _RATE
        if start.denominator != 1 or end.denominator != 1:
            raise AsrError(AsrErrorCategory.MALFORMED_OUTPUT)
        translated.append(AsrTimelineSegment(segment, SampleInterval(
            request.start_sample + start.numerator, request.start_sample + end.numerator,
        )))
        previous_end = segment.end
    return tuple(translated)


def _execute_chunk(
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
    try:
        for _ in range(min(concurrency, len(plan.chunks))):
            pending.add(executor.submit(_execute_chunk, next(chunks), normalized_audio, transcriber, payload_limit))
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
                    pending.add(executor.submit(_execute_chunk, chunk, normalized_audio, transcriber, payload_limit))
    finally:
        for future in pending:
            future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)
    return tuple(results[chunk.ordinal] for chunk in plan.chunks)
