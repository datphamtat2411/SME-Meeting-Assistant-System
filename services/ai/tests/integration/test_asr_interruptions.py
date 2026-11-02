"""Pre-LLM interruption regressions: synthetic PCM/evidence, no network/models."""

import io
import wave
from array import array
from fractions import Fraction

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
from sme_meeting_ai.transcription.boundary_alignment import analyze_boundary_alignment
from sme_meeting_ai.transcription.chunk_execution import execute_asr_chunks
from sme_meeting_ai.transcription.recovery import recover_speech

BEFORE = "Chúng ta kiểm tra chất lượng âm thanh"
ONSET = "Tiếp tục cuộc họp"
CRITICAL = "Giữ nguyên thời hạn triển khai API mới"
AFTER = "Nhóm sẽ xác nhận kết quả vào ngày mai"


def test_music_silence_resume_preserves_uncertain_onset_critical_words_and_absolute_pcm(handoff, caplog):
    configuration = Settings(_env_file=None, audio_asr_chunk_max_chunks=16,
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
