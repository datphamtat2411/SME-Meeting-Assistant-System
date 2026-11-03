"""Decoder re-observation contracts, not a simulation of Whisper accuracy."""
import io
import struct
import wave
from concurrent.futures import CancelledError
from dataclasses import replace
from fractions import Fraction

import pytest

from sme_meeting_ai.transcription.asr import AsrError, AsrErrorCategory, AsrWord
from sme_meeting_ai.transcription.chunk_execution import execute_asr_chunks

from .test_chunk_execution import candidate, settings
from .test_chunk_execution import handoff as handoff  # noqa: F401

BOILERPLATE = "Hãy subscribe cho kênh Ghiền Mì Gõ để không bỏ lỡ những video hấp dẫn"
SPEECH = "Nhóm xác nhận đầy đủ nội dung thời hạn triển khai và kết quả kiểm thử vào ngày mai"


def test_recheck_rereads_exact_core_and_translates_segments_words_without_source_mutation(handoff):
    plan, audio, samples = handoff
    original_bytes = audio.path.read_bytes()
    calls = []

    class Provider:
        def transcribe(self, payload):
            chunk = next(c for c in plan.chunks if c.chunk_id == payload.chunk_id)
            first = chunk.chunk_id not in calls
            calls.append(chunk.chunk_id)
            interval = chunk.request_interval if first else chunk.core_interval
            with wave.open(io.BytesIO(payload.payload), "rb") as reader:
                assert reader.getnframes() == interval.end_sample - interval.start_sample
                assert reader.readframes(reader.getnframes()) == struct.pack(
                    f"<{interval.end_sample - interval.start_sample}h", *samples[interval.start_sample:interval.end_sample],
                )
            result = candidate(payload, text=BOILERPLATE if first else SPEECH)
            return result if first else replace(result, words=(AsrWord(Fraction(0), payload.duration, SPEECH),))

    output = execute_asr_chunks(plan, audio, Provider(), settings(audio_asr_recovery_max_total_attempts=3))
    assert len(calls) == 2 * len(plan.chunks)
    for result in output:
        chunk = result.chunk
        offset = Fraction(chunk.core_interval.start_sample - chunk.request_interval.start_sample, 16000)
        assert result.recheck_outcome.value == "replaced"
        assert result.candidate.text == SPEECH
        assert result.candidate.segments[0].start == result.candidate.words[0].start == offset
        assert result.timeline_segments[0].interval == chunk.core_interval
        assert [(a.interval, a.selected) for a in result.decoding_attempts] == [
            (chunk.request_interval, False), (chunk.core_interval, True),
        ]
    assert audio.path.read_bytes() == original_bytes
    assert BOILERPLATE not in repr(output) and SPEECH not in repr(output)


@pytest.mark.parametrize("mode", ["genuine", "empty", "short", "failure"])
def test_genuine_wording_and_inconclusive_rechecks_never_erase_original_evidence(handoff, mode):
    plan, audio, _ = handoff
    seen = set()

    class Provider:
        def transcribe(self, payload):
            if payload.chunk_id not in seen:
                seen.add(payload.chunk_id)
                return candidate(payload, text=BOILERPLATE)
            if mode == "failure":
                raise AsrError(AsrErrorCategory.TIMEOUT)
            if mode == "empty":
                return candidate(payload, text="", segments=())
            return candidate(payload, text=BOILERPLATE if mode == "genuine" else "Xin chào")

    output = execute_asr_chunks(plan, audio, Provider(), settings(audio_asr_recovery_max_total_attempts=3))
    assert all(r.candidate.text == BOILERPLATE and r.failure is None for r in output)
    assert all(r.timeline_segments[0].interval == r.chunk.request_interval for r in output)
    assert all(r.recheck_outcome.value == ("corroborated" if mode == "genuine" else "inconclusive") for r in output)
    assert all(r.decoding_attempts[0].selected and not r.decoding_attempts[1].selected for r in output)


def test_recheck_budget_is_shared_across_concurrent_chunks(handoff):
    plan, audio, _ = handoff
    calls = []

    class Provider:
        def transcribe(self, payload):
            calls.append(payload.chunk_id)
            return candidate(payload, text=BOILERPLATE)

    output = execute_asr_chunks(plan, audio, Provider(), settings(
        audio_asr_max_concurrent_chunks=2, audio_asr_recovery_max_total_attempts=1,
    ))
    assert len(calls) == len(plan.chunks) + 1
    assert sum(len(r.decoding_attempts) == 2 for r in output) == 1
    assert sum(r.recheck_outcome.value == "limit-reached" for r in output) == len(plan.chunks) - 1


def test_recheck_cancellation_keeps_identity_and_stops_further_calls(handoff):
    plan, audio, _ = handoff
    cancellation = CancelledError()
    calls = []

    class Provider:
        def transcribe(self, payload):
            calls.append(payload.chunk_id)
            if len(calls) == 2:
                raise cancellation
            return candidate(payload, text=BOILERPLATE)

    with pytest.raises(CancelledError) as caught:
        execute_asr_chunks(plan, audio, Provider(), settings(audio_asr_max_concurrent_chunks=1))
    assert caught.value is cancellation
    assert len(calls) == 2
