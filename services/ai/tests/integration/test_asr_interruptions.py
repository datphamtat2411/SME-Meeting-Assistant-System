"""Pre-LLM interruption regressions: synthetic PCM/evidence, no network/models."""

import io
import wave
from array import array
from fractions import Fraction

import pytest
from unit.test_coverage_validation import handoff as handoff  # noqa: F401

from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrUsage,
)
from sme_meeting_ai.transcription.asr_strategy import AsrStrategyRunner
from sme_meeting_ai.transcription.boundary_alignment import analyze_boundary_alignment
from sme_meeting_ai.transcription.chunk_execution import execute_asr_chunks
from sme_meeting_ai.transcription.chunk_planning import (
    ChunkBoundaryReason,
    SpeechAwareAsrChunkPlanner,
)
from sme_meeting_ai.transcription.recovery import recover_speech

BEFORE = "Chúng ta kiểm tra chất lượng âm thanh"
ONSET = "Tiếp tục cuộc họp"
CRITICAL = "Giữ nguyên thời hạn triển khai API mới"
AFTER = "Nhóm sẽ xác nhận kết quả vào ngày mai"


def test_music_silence_resume_preserves_uncertain_onset_critical_words_and_absolute_pcm(handoff, caplog):
    configuration = Settings(_env_file=None, service_name="test-ai", service_identity="ai-core", audio_asr_chunk_max_chunks=16,
                             audio_asr_recovery_max_total_attempts=4)
    labels = (("speech",) * 250 + ("high",) * 63 + ("silence",) * 100
              + ("high",) * 10 + ("uncertain",) * 10 + ("weak",) * 10 + ("speech",) * 250)
    processed, plan, _ = handoff(labels, configuration=configuration)
    onset = (250 + 63 + 100) * 512
    critical = onset + 30 * 512
    end = processed.normalized_artifact.sample_count
    occurrences = ((0, 250 * 512, BEFORE), (onset, critical, ONSET),
                   (critical, critical + 125 * 512, CRITICAL), (critical + 125 * 512, end, AFTER))
    samples = array("h", (0 if label == "silence" else (index % 32000 + 1)
                          for index, label in enumerate(labels) for _ in range(512)))
    pcm = samples.tobytes()
    with wave.open(str(processed.normalized_artifact.path), "wb") as writer:
        writer.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        writer.writeframes(pcm)
    calls = []

    class Transcriber:
        def transcribe(self, audio):
            provenance = AsrProvenance("openrouter", "openai/whisper-large-v3",
                                       inference_config=(("language", "vi"),))
            if audio.chunk_id.startswith("recovery-"):
                calls.append(None)
                return AsrCandidate("", (), AsrQualityMetadata(), AsrUsage(), provenance, audio.chunk_id)
            chunk = next(c for c in plan.chunks if c.chunk_id == audio.chunk_id)
            request = chunk.request_interval
            calls.append(request)
            with wave.open(io.BytesIO(audio.payload), "rb") as reader:
                assert reader.getnframes() == request.end_sample - request.start_sample
                assert reader.readframes(reader.getnframes()) == pcm[2 * request.start_sample:2 * request.end_sample]
            selected = [(a, b, text) for a, b, text in occurrences
                        if request.start_sample <= a < b <= request.end_sample]
            # A decoder failure across long interruptions must be prevented by
            # independent windows, not repaired by invented downstream wording.
            if request.start_sample < onset - 16000 and request.end_sample > critical:
                selected = [(a, b, text) for a, b, text in selected if b <= onset]
                selected.append((onset - 16000, request.end_sample, "Nội dung không có trong âm thanh"))
            segments = tuple(AsrSegment(Fraction(a - request.start_sample, 16000),
                                        Fraction(b - request.start_sample, 16000), text)
                             for a, b, text in selected)
            return AsrCandidate(" ".join(s.text for s in segments), segments, AsrQualityMetadata(),
                                AsrUsage(), provenance, audio.chunk_id)

    provider = Transcriber()
    original = execute_asr_chunks(plan, processed.normalized_artifact, provider, configuration)
    alignment = analyze_boundary_alignment(plan, original)
    recovered = recover_speech(processed, plan, original, provider, configuration, boundary_alignment=alignment)
    actual = recovered.accepted_reconciliation.segments
    assert [(s.interval, s.text) for s in actual] == [(SampleInterval(a, b), text) for a, b, text in occurrences]
    assert len(plan.chunks) == 2
    assert len(calls) == 2 + len(recovered.attempts)
    assert len(recovered.attempts) <= configuration.audio_asr_recovery_max_total_attempts
    assert all(a.admission.value == "rejected"
               and a.window.target_region.interval.end_sample <= 313 * 512 for a in recovered.attempts)
    assert recovered.final_assessment.quality.likely_speech_without_canonical_text_samples == 0
    assert any(i.start_sample <= onset < i.end_sample for i in processed.speech_map.uncertain_intervals)
    assert any(i.start_sample <= onset + 20 * 512 < i.end_sample for i in processed.speech_map.speech_intervals)
    assert sum(c.core_interval.end_sample - c.core_interval.start_sample for c in plan.chunks) == end
    assert calls[1].start_sample == onset
    assert alignment.metrics.total_core_samples == end
    assert not caplog.records


@pytest.mark.parametrize("last_wording", [
    "Nhóm sẽ xác nhận kết quả triển khai vào ngày mai",
    "Hãy subscribe cho kênh để không bỏ lỡ những video hấp dẫn",
])
@pytest.mark.parametrize("boundary_padding_samples", [0, 1600, 2048])
def test_context_recheck_replaces_boilerplate_preserves_source_pcm_and_real_wording(
    handoff, last_wording, boundary_padding_samples,
):
    configuration = Settings(_env_file=None, service_name="test-ai", service_identity="ai-core", audio_asr_chunk_max_chunks=16,
                             audio_asr_recovery_max_total_attempts=4,
                             audio_speech_map_boundary_padding_samples=boundary_padding_samples)
    # Reproduce the observed failure: a context-bearing request returns only
    # boilerplate, but an independent observation of its actual core has speech.
    # Plausible scores/full-duration timestamps must not prevent the recheck.
    labels = ("speech",) * 250 + ("high",) * 63 + ("silence",) * 100
    silence_start = (250 + 63) * 512
    onset = len(labels) * 512
    expected_restart = onset - boundary_padding_samples
    labels += ("speech",) * 740 + ("silence",) + ("speech",) * 259
    processed, plan, _ = handoff(labels, configuration=configuration)
    end = processed.normalized_artifact.sample_count
    occurrences = [(0, 8 * 16000, BEFORE)]
    occurrences += [(onset + n * 16000, onset + (n + 1) * 16000,
                     last_wording if n == 31 else f"Nhóm xác nhận hạng-mục-{n} triển-khai-{n}")
                    for n in range(32)]
    pcm = array("h", (0 if label == "silence" else 1200 for label in labels for _ in range(512))).tobytes()
    with wave.open(str(processed.normalized_artifact.path), "wb") as writer:
        writer.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        writer.writeframes(pcm)
    hallucination = "Hãy subscribe cho kênh Ghiền Mì Gõ Để không bỏ lỡ những video hấp dẫn"
    calls = []

    class Transcriber:
        def transcribe(self, audio):
            from sme_meeting_ai.transcription.asr import AsrSegmentQuality

            provenance = AsrProvenance("openrouter", "openai/whisper-large-v3",
                                       inference_config=(("language", "vi"),))
            calls.append(audio.chunk_id)
            if audio.chunk_id.startswith("recovery-"):
                return AsrCandidate("", (), AsrQualityMetadata(), AsrUsage(), provenance, audio.chunk_id)
            chunk = next(c for c in plan.chunks if c.chunk_id == audio.chunk_id)
            request = (chunk.core_interval if audio.duration == chunk.core_interval.duration
                       else chunk.request_interval)
            with wave.open(io.BytesIO(audio.payload), "rb") as reader:
                assert reader.getnframes() == request.end_sample - request.start_sample
                assert reader.readframes(reader.getnframes()) == pcm[2 * request.start_sample:2 * request.end_sample]
            selected = [(a, b, text) for a, b, text in occurrences
                        if request.start_sample <= a < b <= request.end_sample]
            if chunk is plan.chunks[-1] and request == chunk.request_interval:
                selected = [(request.start_sample, request.end_sample, hallucination)]
            segments = tuple(AsrSegment(Fraction(a - request.start_sample, 16000),
                                        Fraction(b - request.start_sample, 16000), text,
                                        AsrSegmentQuality(average_log_probability=-0.15, no_speech_probability=0.07))
                             for a, b, text in selected)
            return AsrCandidate(" ".join(s.text for s in segments), segments, AsrQualityMetadata(),
                                AsrUsage(), provenance, audio.chunk_id)

    provider = Transcriber()
    runner = AsrStrategyRunner(provider, configuration)
    runner.prepare(processed, SpeechAwareAsrChunkPlanner(configuration))
    execution = runner.execute(processed.normalized_artifact)
    assert execution.plan == plan
    original = execution.baseline
    recovered = runner.recover(processed, execution, boundary_alignment=analyze_boundary_alignment(plan, original))
    actual = recovered.accepted_reconciliation.segments
    assert [(s.interval, s.text) for s in actual] == [(SampleInterval(a, b), text) for a, b, text in occurrences]
    assert hallucination not in [s.text for s in actual]
    assert actual[-1].text == last_wording and actual[-1].interval.end_sample == end
    assert len(plan.chunks) == 3
    assert len(calls) == len(plan.chunks) + 1 + len(recovered.attempts)
    assert len(calls) <= len(plan.chunks) + configuration.audio_asr_recovery_max_total_attempts
    repaired = original[-1]
    assert repaired.recheck_outcome.value == "replaced"
    assert [(a.interval, a.selected) for a in repaired.decoding_attempts] == [
        (plan.chunks[-1].request_interval, False), (plan.chunks[-1].core_interval, True),
    ]
    assert len(recovered.attempts) <= configuration.audio_asr_recovery_max_total_attempts
    # Speech-map padding protects the first phoneme; the reset must keep that
    # silent pre-roll without borrowing music/context across the interruption.
    left, resumed = plan.chunks[:2]
    decision = plan.boundary_decisions[0]
    assert decision.reason is resumed.start_boundary_reason is ChunkBoundaryReason.SPEECH_RESUMPTION
    assert left.end_boundary_reason is ChunkBoundaryReason.SPEECH_RESUMPTION
    assert decision.candidate_gap == SampleInterval(silence_start, expected_restart)
    assert decision.boundary_sample == expected_restart
    assert left.core_interval.end_sample == resumed.core_interval.start_sample == expected_restart
    assert left.request_interval.end_sample == resumed.request_interval.start_sample == expected_restart
    assert silence_start <= expected_restart <= onset
    assert pcm[2 * expected_restart:2 * onset] == bytes(2 * boundary_padding_samples)
    assert sum(c.core_interval.end_sample - c.core_interval.start_sample for c in plan.chunks) == end
