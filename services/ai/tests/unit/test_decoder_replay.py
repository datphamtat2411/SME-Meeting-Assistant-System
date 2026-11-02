"""Independent acoustic re-observation, not deletion on lexical similarity."""

import io
import struct
import wave
from dataclasses import replace
from fractions import Fraction

import pytest

from sme_meeting_ai.transcription import chunk_execution
from sme_meeting_ai.transcription.asr import AsrError, AsrErrorCategory, AsrSegment, AsrWord
from sme_meeting_ai.transcription.coverage import _valid_result

from .test_asr_recheck import BOILERPLATE
from .test_chunk_execution import candidate, settings
from .test_chunk_execution import handoff as handoff  # noqa: F401

FULL = "Khi kiểm thử đã xong rồi, kiểm thử đã ổn rồi"
REPLAY = "Kiểm thử xong rồi, kiểm thử đã ổn rồi"
PREFIX = "Giữ nguyên lời mở đầu"


def observations(audio, interval, rows, *, words=False):
    segments = tuple(AsrSegment(Fraction(a - interval.start_sample, 16000),
                                Fraction(b - interval.start_sample, 16000), text) for a, b, text in rows)
    value = candidate(audio, text=" ".join(s.text for s in segments), segments=segments)
    if words:
        value = replace(value, words=tuple(AsrWord(s.start, s.end, s.text) for s in segments))
    return value


class Reobserver:
    def __init__(self, plan, ordinal=0, mode="confirmed", words=False):
        self.plan, self.ordinal, self.mode, self.words = plan, ordinal, mode, words
        self.calls = []
        self.original = None

    def transcribe(self, audio):
        chunk = self.plan.chunks[self.ordinal]
        self.calls.append(audio)
        if audio.chunk_id != chunk.chunk_id:
            return candidate(audio)
        first = sum(a.chunk_id == chunk.chunk_id for a in self.calls) == 1
        core = chunk.core_interval
        if first:
            rows = [(chunk.request_interval.start_sample, core.start_sample + 70, PREFIX),
                    (core.start_sample + 70, core.end_sample - 8, FULL),
                    (core.end_sample - 8, chunk.request_interval.end_sample, REPLAY)]
            if self.mode == "not-a-replay":
                rows[-1] = (*rows[-1][:2], "À không, cần kiểm thử thêm trước khi triển khai")
            self.original = observations(audio, chunk.request_interval, rows, words=self.words)
            if self.mode == "word-supported-repetition":
                self.original = replace(self.original, words=(
                    *self.original.words[:-1], replace(self.original.words[-1],
                        end=Fraction(core.end_sample - 1 - chunk.request_interval.start_sample, 16000)),
                ))
            return self.original
        if self.mode == "failure":
            raise AsrError(AsrErrorCategory.TIMEOUT)
        if self.mode == "empty":
            return candidate(audio, text="", segments=())
        if self.mode == "hallucination":
            return candidate(audio, text=BOILERPLATE)
        rows = [(core.start_sample, core.start_sample + 75, "Nhận dạng khác ngoài vùng nghi ngờ"),
                (core.start_sample + 75, core.end_sample, FULL)]
        if self.mode == "genuine-repetition":
            rows = [(core.start_sample, core.start_sample + 75, PREFIX),
                    (core.start_sample + 75, core.end_sample - 8, FULL),
                    (core.end_sample - 8, core.end_sample, REPLAY)]
        elif self.mode == "two-complete-occurrences":
            rows = [(core.start_sample, core.start_sample + 70, PREFIX),
                    (core.start_sample + 70, core.end_sample - 8, FULL),
                    (core.end_sample - 8, core.end_sample, FULL)]
        elif self.mode == "one-sample-uncovered":
            rows[-1] = (*rows[-1][:1], core.end_sample - 1, FULL)
        elif self.mode == "changed-words":
            rows[-1] = (*rows[-1][:2], FULL.replace("ổn", "hỏng"))
        elif self.mode == "different-provider":
            return replace(observations(audio, core, rows),
                           provenance=replace(self.original.provenance, upstream_provider="different"))
        elif self.mode == "segmentation":
            rows = [rows[0], (core.start_sample + 75, core.end_sample - 8, "Khi kiểm thử đã xong rồi,"),
                    (core.end_sample - 8, core.end_sample, "kiểm thử đã ổn rồi")]
        elif self.mode == "malformed":
            return candidate(audio, text=FULL, segments=(AsrSegment(Fraction(-1), audio.duration, FULL),))
        return observations(audio, core, rows, words=self.words)


@pytest.mark.parametrize("ordinal", [0, 1])
@pytest.mark.parametrize("mode", ["confirmed", "segmentation"])
def test_replay_recheck_selects_intact_observations_and_records_per_segment_origins(handoff, ordinal, mode):
    plan, audio, samples = handoff
    source = audio.path.read_bytes()
    provider = Reobserver(plan, ordinal, mode, words=True)
    output = chunk_execution.execute_asr_chunks(plan, audio, provider, settings(audio_asr_recovery_max_total_attempts=1))
    selected = output[ordinal]
    assert selected.recheck_outcome.value == "replay-replaced"
    assert _valid_result(selected)
    assert selected.candidate.segments[0] == provider.original.segments[0]
    assert selected.candidate.text == PREFIX + " " + FULL
    assert REPLAY not in tuple(s.text for s in selected.candidate.segments)
    core = plan.chunks[ordinal].core_interval
    assert selected.timeline_segments[-1].interval.end_sample == core.end_sample
    assert selected.timeline_segments[1].interval.start_sample == core.start_sample + 75
    first, second = selected.decoding_attempts
    assert first.selected and second.selected
    assert first.segment_selections == ((0, 0),)
    assert second.segment_selections == (((1, 1),) if mode == "confirmed" else ((1, 1), (2, 2)))
    assert len(selected.candidate.words) == len(selected.candidate.segments)
    assert len(provider.calls) == len(plan.chunks) + 1
    retry, = [a for a in provider.calls if a.chunk_id == selected.chunk.chunk_id and a.duration == core.duration]
    with wave.open(io.BytesIO(retry.payload), "rb") as reader:
        assert reader.readframes(reader.getnframes()) == struct.pack(
            f"<{core.end_sample - core.start_sample}h", *samples[core.start_sample:core.end_sample],
        )
    assert audio.path.read_bytes() == source
    assert FULL not in repr(selected)


@pytest.mark.parametrize("mode", ["genuine-repetition", "two-complete-occurrences", "one-sample-uncovered",
                                 "changed-words", "empty", "hallucination", "failure", "malformed", "different-provider"])
def test_inconclusive_or_genuine_repeated_speech_is_never_deleted(handoff, mode):
    plan, audio, _ = handoff
    provider = Reobserver(plan, mode=mode)
    selected = chunk_execution.execute_asr_chunks(plan, audio, provider, settings())[0]
    assert selected.candidate is provider.original
    assert tuple(s.text for s in selected.candidate.segments) == (PREFIX, FULL, REPLAY)
    assert selected.recheck_outcome.value in {"inconclusive", "corroborated"}
    assert [a.selected for a in selected.decoding_attempts] == [True, False]
    assert _valid_result(selected)


def test_repetition_is_only_a_recheck_signal_and_cannot_spend_beyond_the_shared_budget(handoff):
    plan, audio, _ = handoff
    provider = Reobserver(plan)
    selected = chunk_execution._execute_chunk(plan.chunks[0], audio, provider, 25000000,
                                              chunk_execution._RecheckBudget(0))
    assert selected.candidate is provider.original
    assert selected.recheck_outcome.value == "limit-reached"
    assert len(provider.calls) == 1
    assert _valid_result(selected)


def test_false_start_or_lexically_different_final_utterance_does_not_trigger_a_replay_check(handoff):
    plan, audio, _ = handoff
    provider = Reobserver(plan, mode="not-a-replay")
    selected = chunk_execution.execute_asr_chunks(plan, audio, provider, settings())[0]
    assert selected.candidate is provider.original and selected.recheck_outcome is None
    assert len(provider.calls) == len(plan.chunks)


def test_available_word_evidence_for_repetition_inside_core_vetoes_replacement(handoff):
    plan, audio, _ = handoff
    provider = Reobserver(plan, mode="word-supported-repetition", words=True)
    selected = chunk_execution.execute_asr_chunks(plan, audio, provider, settings())[0]
    assert selected.candidate is provider.original
    assert selected.recheck_outcome.value == "inconclusive"
    assert _valid_result(selected)


def test_replay_pair_without_an_earlier_prefix_has_an_explicit_single_source_selection(handoff):
    plan, audio, _ = handoff

    class Provider(Reobserver):
        def transcribe(self, payload):
            value = super().transcribe(payload)
            if value is self.original:
                value = replace(value, segments=value.segments[1:], text=FULL + " " + REPLAY)
                self.original = value
            return value

    selected = chunk_execution.execute_asr_chunks(plan, audio, Provider(plan), settings())[0]
    assert selected.recheck_outcome.value == "replay-replaced"
    assert _valid_result(selected)
    first, second = selected.decoding_attempts
    assert not first.selected and first.segment_selections == ()
    assert second.selected and second.segment_selections == ((0, 1),)


@pytest.mark.parametrize("damage", ["missing", "duplicate", "provider-order", "wrong-interval", "boolean-index"])
def test_mixed_observation_handoff_requires_complete_unambiguous_source_selections(handoff, damage):
    plan, audio, _ = handoff
    selected = chunk_execution.execute_asr_chunks(plan, audio, Reobserver(plan), settings())[0]
    first, second = selected.decoding_attempts
    if damage == "missing":
        first = replace(first, segment_selections=())
    elif damage == "duplicate":
        second = replace(second, segment_selections=((0, 1),))
    elif damage == "provider-order":
        first = replace(first, segment_selections=((0, 2), (1, 1)))
    elif damage == "boolean-index":
        second = replace(second, segment_selections=((True, 1),))
    else:
        second = replace(second, interval=replace(second.interval, end_sample=119))
    assert not _valid_result(replace(selected, decoding_attempts=(first, second)))
