"""Exercise production limits and disk-backed preprocessing; no speech accuracy claim."""
import struct
from contextlib import contextmanager
from math import ceil

import pytest

from sme_meeting_ai.audio import AudioNormalizer, AudioProcessingError, AudioSource
from sme_meeting_ai.audio.detection import AudioEvidenceDetector
from sme_meeting_ai.audio.speech_map import SpeechMapBuilder
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.preprocessing import AudioPreprocessingPipeline
from sme_meeting_ai.transcription.asr_strategy import AsrStrategyRunner
from sme_meeting_ai.transcription.chunk_planning import SpeechAwareAsrChunkPlanner


def sparse_pcm(path, seconds):
    pcm_bytes = 2 * 16000 * seconds
    with path.open("wb") as out:
        out.write(struct.pack("<4sI8sIHHIIHH4sI", b"RIFF", 36 + pcm_bytes, b"WAVEfmt ",
                              16, 1, 1, 16000, 32000, 2, 16, b"data", pcm_bytes))
        out.truncate(44 + pcm_bytes)


class PausedSpeech:
    model_id = "capacity-fake"
    model_version = "1"
    model_sha256 = "a" * 64
    backend = "test"
    frame_samples = 512
    max_concurrent_recordings = 1
    inference_threads = 1

    @contextmanager
    def open_stream(self, *, deadline):
        class Stream:
            frame = 0

            def infer(self, _samples):
                # Dense 2.4-second pauses: splitting at every restart would
                # exhaust the authorization even though the source is admissible.
                self.frame += 1
                return .99 if self.frame % 250 < 175 else .01
        yield Stream()


@pytest.mark.parametrize("seconds", [300, 1800, 2700, 5400])
def test_long_recording_normalization_acoustic_plan_and_worker_budget(tmp_path, seconds):
    source = tmp_path / "fixture.wav"
    sparse_pcm(source, seconds)
    profile = Settings(_env_file=None, service_name="capacity", service_identity="ai-core", audio_temp_dir=tmp_path)
    pipeline = AudioPreprocessingPipeline(AudioNormalizer(profile), AudioEvidenceDetector(profile, PausedSpeech()),
                                          SpeechMapBuilder(profile))
    with pipeline.run(AudioSource("capacity", source)) as outcome:
        assert outcome.result is not None, outcome.failure
        assert outcome.result.normalized_artifact.sample_count == seconds * 16000
        runner = AsrStrategyRunner(object(), profile)
        runner.prepare(outcome.result, SpeechAwareAsrChunkPlanner(profile))
        plan = runner.plan
        budget = runner.telemetry.resource_plan
        assert 1 < budget.baseline_calls <= ceil(seconds / (8 if seconds == 300 else 14))
        assert budget.maximum_calls <= profile.audio_asr_max_total_calls
        assert budget.maximum_request_samples <= 480_000
        assert plan.chunks[0].core_interval.start_sample == 0
        assert plan.chunks[-1].core_interval.end_sample == seconds * 16000
        assert all(a.core_interval.end_sample == b.core_interval.start_sample
                   for a, b in zip(plan.chunks, plan.chunks[1:]))
        provider_worst = (
            ceil(budget.maximum_calls / profile.audio_asr_max_concurrent_chunks)
            * (profile.audio_asr_timeout_seconds + 1)
        )
        assert provider_worst + (profile.s3_download_timeout_seconds + profile.audio_decode_timeout_seconds
                                 + profile.audio_vad_timeout_seconds + profile.audio_asr_recovery_max_wall_time_seconds
                                 + 120) < profile.worker_execution_timeout_seconds
    assert list(tmp_path.iterdir()) == [source]


def test_excess_duration_rejected_without_clipping(tmp_path):
    source = tmp_path / "oversize.wav"
    sparse_pcm(source, 5401)
    with pytest.raises(AudioProcessingError, match="RESOURCE"):
        profile = Settings(_env_file=None, service_name="capacity", service_identity="ai-core", audio_temp_dir=tmp_path)
        AudioNormalizer(profile).normalize(AudioSource("too-long", source))
    assert list(tmp_path.iterdir()) == [source]
