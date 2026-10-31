import asyncio
import copy
import io
import struct
import threading
import traceback
import wave
import weakref
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from dataclasses import fields, replace
from fractions import Fraction

import pytest

from sme_meeting_ai.audio.models import (
    AudioProbe,
    AudioProvenance,
    DetectionProvenance,
    NormalizedAudioArtifact,
    SampleInterval,
    SpeechMapProvenance,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import PreprocessingProvenance
from sme_meeting_ai.transcription import (
    AsrAudioChunk,
    AsrCandidate,
    AsrChunk,
    AsrChunkPlan,
    AsrChunkResult,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrTimelineSegment,
    AsrUsage,
    ChunkBoundaryReason,
    ChunkPlanningProvenance,
    chunk_execution,
    execute_asr_chunks,
)


def settings(**overrides):
    return Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        **overrides,
    )


def altered(value, **changes):
    result = copy.copy(value)
    for name, item in changes.items():
        object.__setattr__(result, name, item)
    return result


@pytest.fixture
def handoff(tmp_path):
    # Non-zero sample signatures bracket real silence, including chunk context.
    samples = tuple(0 if 90 <= i < 250 else i - 175 for i in range(350))
    path = tmp_path / "private-cuoc-hop.wav"
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(struct.pack("<350h", *samples))
    probe = AudioProbe("recording-1", "wav", "pcm_s16le", 48000, 2, "stereo", None, 0)
    normalization = AudioProvenance(
        "recording-1", "1", "ffmpeg", "7-test",
        {"container": "wav", "codec": "pcm_s16le", "sample_format": "s16",
         "sample_rate_hz": 16000, "channels": 1},
        {"max_duration_seconds": 3600},
    )
    detection = DetectionProvenance(
        "silero-test", "5", "a" * 64, "test-backend", "1",
        {"sample_rate_hz": 16000, "frame_samples": 512},
    )
    speech_map = SpeechMapProvenance(
        "recording-1", 350, "1", detection,
        {"boundary_padding_samples": 0, "merge_gap_samples": 0, "energy_floor_dbfs": -50},
    )
    preprocessing = PreprocessingProvenance(
        "1", "recording-1", 350, normalization, detection, speech_map,
    )
    configuration = {
        "target_core_samples": 100, "max_request_samples": 150, "overlap_samples": 30,
        "boundary_search_samples": 20, "max_chunks": 10, "max_core_samples": 120,
        "left_context_samples": 15, "right_context_samples": 15,
        "minimum_progress_samples": 80, "max_timeline_samples": 57600000,
    }
    chunks = []
    start_reason = ChunkBoundaryReason.TIMELINE_START
    for ordinal, (start, end) in enumerate(((0, 120), (120, 240), (240, 350))):
        end_reason = (ChunkBoundaryReason.TIMELINE_END if end == 350
                      else ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH)
        chunks.append(AsrChunk(
            f"chunk-{ordinal:06d}", ordinal, SampleInterval(start, end),
            SampleInterval(max(0, start - 15), min(350, end + 15)),
            start_reason, end_reason,
        ))
        start_reason = end_reason

    class BorrowedOwnership:
        def cleanup(self):
            pytest.fail("executor closed preprocessing ownership")

    audio = NormalizedAudioArtifact(
        path, "recording-1", probe, 350, normalization, BorrowedOwnership(),
    )
    plan = AsrChunkPlan(
        "recording-1", 350, tuple(chunks),
        ChunkPlanningProvenance("1", preprocessing, configuration),
    )
    return plan, audio, samples


def candidate(chunk, *, text="Nội dung cuộc họp", segments=None):
    if segments is None:
        segments = (AsrSegment(Fraction(0), chunk.duration, text),)
    return AsrCandidate(
        text, segments, AsrQualityMetadata(language="vi"),
        AsrUsage(input_tokens=3, cost=Fraction(1, 100)),
        AsrProvenance("fake", "whisper-test", resolved_model="resolved-test"), chunk.chunk_id,
    )


class Transcriber:
    def __init__(self, callback=None):
        self.calls = []
        self.callback = callback or candidate

    def transcribe(self, chunk):
        self.calls.append(chunk.chunk_id)
        return self.callback(chunk)

    def close(self):
        pytest.fail("executor closed borrowed transcriber/client")


def test_exact_first_middle_last_wav_and_silence_are_preserved(handoff, monkeypatch, caplog):
    plan, audio, samples = handoff
    original = audio.path.read_bytes()
    candidates = {}

    def transcribe(chunk):
        planned = plan.chunks[int(chunk.chunk_id[-6:])]
        interval = planned.request_interval
        assert chunk.duration == Fraction(interval.end_sample - interval.start_sample, 16000)
        assert {item.name for item in fields(chunk)} == {"chunk_id", "payload", "duration"}
        with wave.open(io.BytesIO(chunk.payload), "rb") as reader:
            assert reader.getparams()[:4] == (1, 2, 16000, interval.end_sample - interval.start_sample)
            assert reader.getcomptype() == "NONE"
            assert reader.readframes(reader.getnframes()) == struct.pack(
                f"<{interval.end_sample - interval.start_sample}h",
                *samples[interval.start_sample:interval.end_sample],
            )
        assert len(chunk.payload) == 44 + 2 * (interval.end_sample - interval.start_sample)
        result = candidate(chunk)
        candidates[chunk.chunk_id] = result
        return result

    def forbidden(*args):
        pytest.fail("executor closed preprocessing-owned audio")

    monkeypatch.setattr(NormalizedAudioArtifact, "close", forbidden)
    transcriber = Transcriber(transcribe)
    # Current geometry must not replace the much smaller captured plan geometry.
    results = execute_asr_chunks(plan, audio, transcriber, settings())
    assert isinstance(results, tuple)
    assert [result.chunk for result in results] == list(plan.chunks)
    for result in results:
        assert isinstance(result, AsrChunkResult)
        assert result.candidate is candidates[result.chunk.chunk_id]
        assert result.failure is None
        assert result.candidate.usage.input_tokens == 3
        assert result.candidate.provenance.resolved_model == "resolved-test"
        assert result.timeline_segments == (AsrTimelineSegment(
            result.candidate.segments[0], result.chunk.request_interval,
        ),)
    assert transcriber.calls == [chunk.chunk_id for chunk in plan.chunks]
    assert audio.path.read_bytes() == original
    assert not caplog.records


def test_overlap_candidates_translate_from_request_not_core_without_deduplication(handoff):
    plan, audio, _ = handoff

    def transcribe(chunk):
        # The same source interval is independently reported in both requests.
        start = 0 if chunk.chunk_id == "chunk-000000" else 105 if chunk.chunk_id == "chunk-000001" else 225
        absolute_start = 110 if start < 225 else 230
        return candidate(chunk, segments=(AsrSegment(
            Fraction(absolute_start - start, 16000),
            Fraction(absolute_start + 5 - start, 16000), "trùng ngữ cảnh",
        ),))

    results = execute_asr_chunks(plan, audio, Transcriber(transcribe), settings())
    assert [r.timeline_segments[0].interval for r in results] == [
        SampleInterval(110, 115), SampleInterval(110, 115), SampleInterval(230, 235),
    ]
    assert all(r.timeline_segments[0].segment is r.candidate.segments[0] for r in results)


@pytest.mark.parametrize("mutate", [
    lambda p: None,
    lambda p: replace(p, source_id="private-other"),
    lambda p: replace(p, sample_count=349),
    lambda p: replace(p, sample_count=True),
    lambda p: replace(p, chunks=()),
    lambda p: replace(p, provenance=None),
    lambda p: replace(p, provenance=replace(p.provenance, planner_version="")),
    lambda p: replace(p, provenance=replace(p.provenance, planner_version="private-unknown")),
    lambda p: replace(p, provenance=altered(p.provenance, sample_rate_hz=8000)),
    lambda p: replace(p, provenance=replace(p.provenance, effective_configuration={})),
    lambda p: replace(p, provenance=replace(p.provenance, effective_configuration={
        **p.provenance.effective_configuration, "left_context_samples": 14})),
    lambda p: replace(p, provenance=replace(p.provenance, effective_configuration={
        **p.provenance.effective_configuration, "max_chunks": 2})),
    lambda p: replace(p, provenance=replace(p.provenance, effective_configuration={
        **p.provenance.effective_configuration, "max_timeline_samples": 349})),
    *[lambda p, key=key, value=value: replace(p, provenance=replace(
        p.provenance, preprocessing=replace(p.provenance.preprocessing, **{key: value}),
    )) for key, value in [
        ("pipeline_version", ""), ("source_id", "private-other"), ("sample_count", 349),
        ("normalization", None), ("detection", None), ("speech_map", None),
    ]],
    lambda p: replace(p, provenance=replace(p.provenance, preprocessing=replace(
        p.provenance.preprocessing, speech_map=replace(
            p.provenance.preprocessing.speech_map, sample_count=349)))),
    lambda p: replace(p, provenance=replace(p.provenance, preprocessing=replace(
        p.provenance.preprocessing, speech_map=replace(
            p.provenance.preprocessing.speech_map, mapper_version="")))),
    lambda p: replace(p, provenance=replace(p.provenance, preprocessing=replace(
        p.provenance.preprocessing,
        detection=replace(p.provenance.preprocessing.detection, model_id=""),
        speech_map=replace(p.provenance.preprocessing.speech_map, detector_provenance=replace(
            p.provenance.preprocessing.detection, model_id="")),
    ))),
    *[lambda p, key=key, value=value: replace(p, chunks=(
        replace(p.chunks[0], **{key: value}), *p.chunks[1:],
    )) for key, value in [
        ("chunk_id", "private-other"), ("ordinal", True), ("ordinal", False), ("ordinal", 1),
        ("core_interval", SampleInterval(1, 120)),
        ("core_interval", SampleInterval(0, 121)),
        ("request_interval", SampleInterval(0, 134)),
        ("request_interval", SampleInterval(0, 351)),
        ("request_interval", altered(SampleInterval(0, 135), start_sample=-1)),
        ("request_interval", altered(SampleInterval(0, 135), end_sample=135.0)),
        ("start_boundary_reason", ChunkBoundaryReason.TIMELINE_END),
        ("end_boundary_reason", ChunkBoundaryReason.TIMELINE_END),
    ]],
    lambda p: replace(p, chunks=(*p.chunks[:-1], replace(
        p.chunks[-1], core_interval=SampleInterval(240, 349)))),
])
def test_invalid_plan_handoffs_are_sanitized_before_inference(handoff, mutate):
    plan, audio, _ = handoff
    transcriber = Transcriber()
    with pytest.raises(AsrError) as caught:
        execute_asr_chunks(mutate(plan), audio, transcriber, settings())
    assert caught.value.category is AsrErrorCategory.VALIDATION
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None
    assert "private-" not in "".join(traceback.format_exception(caught.value))
    assert transcriber.calls == []


@pytest.mark.parametrize("mutate", [
    lambda a: None,
    lambda a: replace(a, source_id="private-other"),
    lambda a: replace(a, sample_count=349),
    lambda a: altered(a, sample_rate_hz=8000),
    lambda a: altered(a, channels=2),
    lambda a: altered(a, sample_format="f32"),
    lambda a: replace(a, provenance=replace(a.provenance, decoder_version="different")),
    lambda a: replace(a, source_metadata=replace(a.source_metadata, source_id="private-other")),
])
def test_invalid_audio_metadata_fails_before_inference(handoff, mutate):
    plan, audio, _ = handoff
    transcriber = Transcriber()
    with pytest.raises(AsrError) as caught:
        execute_asr_chunks(plan, mutate(audio), transcriber, settings())
    assert caught.value.category is AsrErrorCategory.VALIDATION
    assert caught.value.__context__ is None
    assert transcriber.calls == []


@pytest.mark.parametrize("parameters", [(2, 2, 16000, 350), (1, 1, 16000, 350),
                                        (1, 2, 8000, 350), (1, 2, 16000, 349)])
def test_wrong_wav_structure_fails_before_inference(handoff, parameters):
    plan, audio, _ = handoff
    channels, width, rate, count = parameters
    with wave.open(str(audio.path), "wb") as output:
        output.setparams((channels, width, rate, 0, "NONE", "not compressed"))
        output.writeframes(b"\x00" * channels * width * count)
    transcriber = Transcriber()
    with pytest.raises(AsrError) as caught:
        execute_asr_chunks(plan, audio, transcriber, settings())
    assert caught.value.category is AsrErrorCategory.VALIDATION
    assert transcriber.calls == []


@pytest.mark.parametrize("damage", ["malformed", "truncated", "missing"])
def test_unreadable_wav_is_a_global_sanitized_validation_failure(handoff, damage):
    plan, audio, _ = handoff
    if damage == "missing":
        audio.path.unlink()
    else:
        audio.path.write_bytes(b"private-malformed" if damage == "malformed" else audio.path.read_bytes()[:-1])
    transcriber = Transcriber()
    with pytest.raises(AsrError) as caught:
        execute_asr_chunks(plan, audio, transcriber, settings())
    assert caught.value.category is AsrErrorCategory.VALIDATION
    assert "private-" not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None
    assert transcriber.calls == []


def test_serialized_payload_limit_includes_wav_header_and_is_per_chunk(handoff):
    plan, audio, _ = handoff
    transcriber = Transcriber()
    # First = 314 bytes, middle = 344, last = 294.
    results = execute_asr_chunks(plan, audio, transcriber, settings(audio_asr_max_payload_bytes=314))
    assert [r.failure for r in results] == [None, AsrErrorCategory.RESOURCE, None]
    assert transcriber.calls == ["chunk-000000", "chunk-000002"]
    assert results[1].candidate is None and results[1].timeline_segments == ()


@pytest.mark.parametrize("segments", [
    (AsrSegment(Fraction(-1, 16000), Fraction(1, 16000), "private-text"),),
    (AsrSegment(Fraction(2, 16000), Fraction(1, 16000), "private-text"),),
    (AsrSegment(Fraction(0), Fraction(0), "private-text"),),
    (AsrSegment(Fraction(0), Fraction(136, 16000), "private-text"),),
    (AsrSegment(Fraction(1, 32000), Fraction(1, 16000), "private-text"),),
    (AsrSegment(Fraction(0), Fraction(3, 32000), "private-text"),),
    (AsrSegment(0.0, 0.001, "private-text"),),
    (AsrSegment(Fraction(10, 16000), Fraction(20, 16000), "private-text"),
     AsrSegment(Fraction(0), Fraction(5, 16000), "private-text")),
    (AsrSegment(Fraction(0), Fraction(20, 16000), "private-text"),
     AsrSegment(Fraction(19, 16000), Fraction(21, 16000), "private-text")),
])
def test_untrusted_timestamps_fail_independently_without_clipping(handoff, segments, caplog):
    plan, audio, _ = handoff
    transcriber = Transcriber(lambda c: candidate(c, segments=segments) if c.chunk_id == "chunk-000000" else candidate(c))
    results = execute_asr_chunks(plan, audio, transcriber, settings())
    assert results[0].failure is AsrErrorCategory.MALFORMED_OUTPUT
    assert results[0].candidate is None and results[0].timeline_segments == ()
    assert all(r.failure is None for r in results[1:])
    assert not caplog.records


@pytest.mark.parametrize("mutate", [
    lambda c: None,
    lambda c: replace(c, chunk_id="private-other"),
    lambda c: replace(c, text=None),
    lambda c: replace(c, segments=()),
    lambda c: replace(c, segments=(None,)),
])
def test_wrong_candidate_contract_is_a_chunk_failure(handoff, mutate):
    plan, audio, _ = handoff
    results = execute_asr_chunks(plan, audio, Transcriber(lambda c: mutate(candidate(c))), settings())
    assert all(r.failure is AsrErrorCategory.MALFORMED_OUTPUT for r in results)


def test_empty_candidate_is_valid_without_fabricated_segments(handoff):
    plan, audio, _ = handoff
    results = execute_asr_chunks(
        plan, audio, Transcriber(lambda c: candidate(c, text="", segments=())), settings(),
    )
    assert all(r.failure is None and r.candidate.text == "" and r.timeline_segments == () for r in results)


@pytest.mark.parametrize("limit", [1, 2, 4])
def test_bounded_workers_and_submission_window_consume_out_of_order(handoff, monkeypatch, limit):
    plan, audio, _ = handoff
    lock = threading.Lock()
    later_finished = threading.Event()
    state = {"active": 0, "peak": 0, "submitted": 0, "completed": 0}
    completion_order = []

    class TrackingExecutor(ThreadPoolExecutor):
        def submit(self, fn, *args, **kwargs):
            with lock:
                state["submitted"] += 1
                assert state["submitted"] - state["completed"] <= limit
            return super().submit(fn, *args, **kwargs)

    monkeypatch.setattr(chunk_execution, "ThreadPoolExecutor", TrackingExecutor)

    def transcribe(chunk):
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        if limit > 1 and chunk.chunk_id == "chunk-000000":
            assert later_finished.wait(5)
        with lock:
            state["active"] -= 1
            state["completed"] += 1
            completion_order.append(chunk.chunk_id)
        if chunk.chunk_id == "chunk-000001":
            later_finished.set()
        return candidate(chunk)

    results = execute_asr_chunks(plan, audio, Transcriber(transcribe), settings(audio_asr_max_concurrent_chunks=limit))
    assert [r.chunk.ordinal for r in results] == [0, 1, 2]
    assert all(r.failure is None for r in results)
    assert 1 <= state["peak"] <= limit
    if limit > 1:
        assert completion_order.index("chunk-000001") < completion_order.index("chunk-000000")


@pytest.mark.parametrize("failure,category", [
    (AsrError(AsrErrorCategory.TIMEOUT), AsrErrorCategory.TIMEOUT),
    (AsrError(AsrErrorCategory.RATE_LIMIT), AsrErrorCategory.RATE_LIMIT),
    (TimeoutError("private-timeout"), AsrErrorCategory.TIMEOUT),
    (RuntimeError("private-response-and-key"), AsrErrorCategory.PROVIDER),
    (MemoryError("private-payload"), AsrErrorCategory.RESOURCE),
])
def test_provider_failure_preserves_other_candidates_and_metadata(handoff, failure, category, caplog):
    plan, audio, _ = handoff

    def transcribe(chunk):
        if chunk.chunk_id == "chunk-000001":
            raise failure
        return candidate(chunk)

    results = execute_asr_chunks(plan, audio, Transcriber(transcribe), settings(audio_asr_max_concurrent_chunks=2))
    assert [r.failure for r in results] == [None, category, None]
    assert results[0].candidate.quality.language == "vi"
    assert results[2].candidate.usage.cost == Fraction(1, 100)
    assert "private-" not in repr(results)
    assert not caplog.records


def test_extraction_failure_does_not_discard_other_results(handoff, monkeypatch):
    plan, audio, _ = handoff
    original_open = wave.open
    opens = 0

    def fail_one_reader(*args, **kwargs):
        nonlocal opens
        if len(args) > 1 and args[1] == "rb":
            opens += 1
            if opens == 3:  # Global validation, first request, failing middle request.
                raise OSError("private-path")
        return original_open(*args, **kwargs)

    monkeypatch.setattr(wave, "open", fail_one_reader)
    results = execute_asr_chunks(plan, audio, Transcriber(), settings())
    assert [r.failure for r in results] == [None, AsrErrorCategory.RESOURCE, None]


@pytest.mark.parametrize("cancel", [None, asyncio.CancelledError, CancelledError, KeyboardInterrupt])
def test_executor_resources_released_on_provider_failure_and_cancellation(handoff, monkeypatch, cancel):
    plan, audio, _ = handoff
    executors, futures, buffers, requests = [], [], [], []
    original_buffer = io.BytesIO

    class TrackedBuffer(original_buffer):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            buffers.append(weakref.ref(self))

    class TrackedRequest(AsrAudioChunk):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            requests.append(weakref.ref(self))

    class TrackingExecutor(ThreadPoolExecutor):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            executors.append(self)

        def submit(self, *args, **kwargs):
            future = super().submit(*args, **kwargs)
            futures.append(future)
            return future

    monkeypatch.setattr(chunk_execution, "ThreadPoolExecutor", TrackingExecutor)
    monkeypatch.setattr(chunk_execution, "AsrAudioChunk", TrackedRequest)
    monkeypatch.setattr(io, "BytesIO", TrackedBuffer)

    def transcribe(chunk):
        if chunk.chunk_id == "chunk-000000":
            if cancel is not None:
                raise cancel()
            raise AsrError(AsrErrorCategory.PROVIDER)
        return candidate(chunk)

    if cancel is None:
        results = execute_asr_chunks(plan, audio, Transcriber(transcribe), settings())
        assert results[0].failure is AsrErrorCategory.PROVIDER
        assert len(futures) == 3
    else:
        with pytest.raises(cancel):
            execute_asr_chunks(plan, audio, Transcriber(transcribe), settings())
        assert len(futures) == 1  # No work submitted after cancellation.
    assert executors and all(not thread.is_alive() for e in executors for thread in e._threads)
    assert all(future.done() or future.cancelled() for future in futures)
    assert buffers and all(ref() is None or ref().closed for ref in buffers)
    assert requests and all(ref() is None for ref in requests)
    assert audio.path.exists()


def test_retained_provider_error_does_not_retain_executor_payload(handoff, monkeypatch):
    plan, audio, _ = handoff
    requests = []
    error = RuntimeError("private-provider-error")

    class TrackedRequest(AsrAudioChunk):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            requests.append(weakref.ref(self))

    monkeypatch.setattr(chunk_execution, "AsrAudioChunk", TrackedRequest)

    def transcribe(chunk):
        raise error

    results = execute_asr_chunks(plan, audio, Transcriber(transcribe), settings())
    assert all(r.failure is AsrErrorCategory.PROVIDER for r in results)
    assert len(requests) == 3 and all(ref() is None for ref in requests)


@pytest.mark.parametrize("overrides", [
    {"audio_asr_max_concurrent_chunks": True}, {"audio_asr_max_concurrent_chunks": 0},
    {"audio_asr_max_concurrent_chunks": 5}, {"audio_asr_max_payload_bytes": 0},
    {"audio_asr_timeout_seconds": float("inf")},
])
def test_mutated_execution_configuration_is_rejected_before_inference(handoff, overrides):
    plan, audio, _ = handoff
    transcriber = Transcriber()
    with pytest.raises(AsrError) as caught:
        execute_asr_chunks(plan, audio, transcriber, settings().model_copy(update=overrides))
    assert caught.value.category is AsrErrorCategory.VALIDATION
    assert transcriber.calls == []


def test_cancellation_cancels_the_bounded_pending_window(handoff, monkeypatch):
    plan, audio, _ = handoff
    pending = []
    shutdown_calls = []

    class ControlledExecutor:
        def __init__(self, max_workers):
            assert max_workers == 2

        def submit(self, *args):
            future = Future()
            if not pending:
                future.set_exception(CancelledError())
            pending.append(future)
            return future

        def shutdown(self, *, wait, cancel_futures):
            shutdown_calls.append((wait, cancel_futures))

    monkeypatch.setattr(chunk_execution, "ThreadPoolExecutor", ControlledExecutor)
    with pytest.raises(CancelledError):
        execute_asr_chunks(plan, audio, Transcriber(), settings(audio_asr_max_concurrent_chunks=2))
    assert len(pending) == 2
    assert pending[1].cancelled()
    assert shutdown_calls == [(True, True)]


def test_recovery_window_execution_is_sequential_and_uses_absolute_request_bounds(handoff):
    from sme_meeting_ai.transcription import (
        CoverageRegion,
        CoverageState,
        RecoveryWindow,
        execute_asr_windows,
    )

    plan, audio, _ = handoff
    region = CoverageRegion(SampleInterval(20, 200), CoverageState.UNRESOLVED_ERROR,
                            (), (), (), 0, 0, 0, 180, 0, 0)
    windows = tuple(RecoveryWindow(
        replace(plan.chunks[0], chunk_id=f"recovery-{i:06d}", ordinal=len(plan.chunks) + i,
                core_interval=SampleInterval(20, 100), request_interval=SampleInterval(10 + i, 110 + i)),
        region, i + 1, "balanced-context", (plan.chunks[0].chunk_id,), plan.provenance,
    ) for i in range(2))
    transcriber = Transcriber()
    results = execute_asr_windows(tuple(reversed(windows)), audio, transcriber, settings())
    assert [r.chunk.ordinal for r in results] == [3, 4]
    assert [r.timeline_segments[0].interval for r in results] == [w.chunk.request_interval for w in windows]
    assert transcriber.calls == [w.chunk.chunk_id for w in windows]
    assert audio.path.exists()


def test_recovery_window_execution_validates_all_windows_before_inference(handoff):
    from sme_meeting_ai.transcription import (
        CoverageRegion,
        CoverageState,
        RecoveryWindow,
        execute_asr_windows,
    )

    plan, audio, _ = handoff
    region = CoverageRegion(SampleInterval(20, 200), CoverageState.UNRESOLVED_ERROR,
                            (), (), (), 0, 0, 0, 180, 0, 0)
    window = RecoveryWindow(
        replace(plan.chunks[0], chunk_id="recovery-000000", ordinal=3,
                core_interval=SampleInterval(20, 100), request_interval=SampleInterval(10, 351)),
        region, 1, "balanced-context", (plan.chunks[0].chunk_id,), plan.provenance,
    )
    transcriber = Transcriber()
    with pytest.raises(AsrError) as caught:
        execute_asr_windows((window,), audio, transcriber, settings())
    assert caught.value.category is AsrErrorCategory.VALIDATION
    assert transcriber.calls == []
