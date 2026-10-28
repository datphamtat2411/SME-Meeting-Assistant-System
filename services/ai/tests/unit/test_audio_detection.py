import math
import struct
import traceback
import wave
from contextlib import contextmanager
from dataclasses import FrozenInstanceError
from fractions import Fraction

import numpy as np
import pytest

from sme_meeting_ai.audio import (
    AudioEvidenceDetector,
    AudioProcessingError,
    AudioSource,
    VadLabel,
)
from sme_meeting_ai.core.config import Settings


class FakeBackend:
    model_id = "silero-test"
    model_version = "5-test"
    model_sha256 = "a" * 64
    backend = "fake-onnx-cpu"
    frame_samples = 512
    max_concurrent_recordings = 1
    inference_threads = 1

    def __init__(self, probabilities=(0.1,), failure=None, after_infer=None):
        self.probabilities = probabilities
        self.failure = failure
        self.after_infer = after_infer
        self.streams = []
        self.closed = 0

    @contextmanager
    def open_stream(self, *, deadline):
        backend = self

        class Stream:
            def __init__(self):
                self.calls = []

            def infer(self, samples):
                self.calls.append(samples.copy())
                if backend.failure:
                    raise backend.failure
                if backend.after_infer:
                    backend.after_infer()
                return backend.probabilities[(len(self.calls) - 1) % len(backend.probabilities)]

        stream = Stream()
        self.streams.append(stream)
        try:
            yield stream
        finally:
            self.closed += 1


def write_wav(path, samples, *, channels=1, width=2, rate=16000):
    with wave.open(str(path), "wb") as output:
        output.setparams((channels, width, rate, 0, "NONE", "not compressed"))
        output.writeframes(np.asarray(samples, dtype="<i2").tobytes())


@pytest.fixture
def audio(tmp_path):
    path = tmp_path / "private-audio.wav"
    write_wav(path, [0] * 1031)
    work = tmp_path / "evidence"
    work.mkdir()
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", audio_temp_dir=work,
        _env_file=None,
    )
    return AudioSource("opaque-recording", path), settings, work


def assert_failure(call, category, work):
    with pytest.raises(AudioProcessingError) as caught:
        call()
    assert caught.value.category == category
    text = "".join(traceback.format_exception(caught.value))
    assert "private-" not in text
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None
    assert list(work.iterdir()) == []


def test_exact_timing_tail_uncertainty_provenance_and_ownership(audio):
    source, settings, work = audio
    original = source.path.read_bytes()
    backend = FakeBackend((0.1, 0.45, 0.9))
    with AudioEvidenceDetector(settings, backend).detect(source, 1031) as evidence:
        frames = list(evidence.iter_frames())
        assert list(evidence.iter_frames()) == frames
        assert evidence.source_id == source.source_id
        assert evidence.sample_count == 1031
        assert evidence.frame_count == 3
        assert evidence.duration == Fraction(1031, 16000)
        assert [(f.start_sample, f.end_sample) for f in frames] == [(0, 512), (512, 1024), (1024, 1031)]
        assert [(f.start_time, f.end_time) for f in frames] == [
            (Fraction(0), Fraction(512, 16000)),
            (Fraction(512, 16000), Fraction(1024, 16000)),
            (Fraction(1024, 16000), Fraction(1031, 16000)),
        ]
        assert [f.vad_label for f in frames] == [VadLabel.LIKELY_NON_SPEECH, VadLabel.UNCERTAIN, VadLabel.LIKELY_SPEECH]
        assert [f.vad_probability for f in frames] == [0.1, 0.45, 0.9]
        assert [f.padding_samples for f in frames] == [0, 0, 505]
        assert (evidence.likely_speech_frame_count, evidence.likely_non_speech_frame_count, evidence.uncertain_frame_count) == (1, 1, 1)
        provenance = evidence.provenance
        assert provenance.model_id == backend.model_id
        assert provenance.model_version == backend.model_version
        assert provenance.model_sha256 == backend.model_sha256
        assert provenance.backend == backend.backend
        assert provenance.detector_version
        assert provenance.effective_configuration["frame_samples"] == 512
        assert provenance.effective_configuration["speech_threshold"] == 0.6
        assert provenance.effective_configuration["non_speech_threshold"] == 0.35
        assert provenance.effective_configuration["evidence_max_bytes"] == settings.audio_evidence_max_bytes
        assert provenance.effective_configuration["max_concurrent_recordings"] == 1
        assert str(source.path) not in repr(provenance)
        with pytest.raises(TypeError):
            provenance.effective_configuration["frame_samples"] = 1
        with pytest.raises(FrozenInstanceError):
            frames[0].rms = 1
        artifact = next(work.rglob("*.bin"))
        assert artifact.stat().st_mode & 0o777 == 0o600
        assert artifact.parent.stat().st_mode & 0o777 == 0o700
    evidence.close()
    assert list(work.iterdir()) == []
    assert source.path.read_bytes() == original
    assert backend.closed == 1
    assert [len(frame) for frame in backend.streams[0].calls] == [512] * 3
    assert np.all(backend.streams[0].calls[-1][7:] == 0)
    with pytest.raises(AudioProcessingError, match="RESOURCE"):
        list(evidence.iter_frames())


@pytest.mark.parametrize("probability,label", [
    (0.2, VadLabel.LIKELY_NON_SPEECH), (0.21, VadLabel.UNCERTAIN),
    (0.79, VadLabel.UNCERTAIN), (0.8, VadLabel.LIKELY_SPEECH),
])
def test_configured_probability_bands(audio, probability, label):
    source, settings, _ = audio
    settings = settings.model_copy(update={"audio_vad_non_speech_threshold": 0.2, "audio_vad_speech_threshold": 0.8})
    with AudioEvidenceDetector(settings, FakeBackend((probability,))).detect(source) as evidence:
        assert all(frame.vad_label == label for frame in evidence.iter_frames())


def test_energy_is_independent_of_speech_and_excludes_model_padding(audio):
    source, settings, _ = audio
    weak = [32, -32] * 256
    loud_noise = np.random.default_rng(3).integers(-30000, 30000, size=512).tolist()
    music = [int(20000 * math.sin(2 * math.pi * i / 32)) for i in range(512)]
    samples = [0] * 512 + weak + loud_noise + music + [-32768] * 7
    write_wav(source.path, samples)
    backend = FakeBackend((0.05, 0.95, 0.1, 0.4, 0.2))
    with AudioEvidenceDetector(settings, backend).detect(source) as evidence:
        frames = list(evidence.iter_frames())
        for frame, actual in zip(frames, [samples[i:i + 512] for i in range(0, len(samples), 512)], strict=True):
            rms = math.sqrt(sum((sample / 32768) ** 2 for sample in actual) / len(actual))
            assert frame.rms == pytest.approx(rms)
            if rms:
                assert frame.dbfs == pytest.approx(20 * math.log10(rms))
            else:
                assert frame.dbfs == -math.inf
        assert frames[1].vad_label == VadLabel.LIKELY_SPEECH
        assert frames[2].rms > frames[1].rms
        assert frames[2].vad_label == VadLabel.LIKELY_NON_SPEECH
        assert frames[3].vad_label == VadLabel.UNCERTAIN
        assert frames[-1].rms == 1
        assert frames[-1].dbfs == 0
        assert backend.streams[0].calls[-1][:7].tolist() == [-1] * 7


@pytest.mark.parametrize("sample_count", [0, 1, 512, 16000])
def test_silence_is_a_valid_complete_result(audio, sample_count):
    source, settings, _ = audio
    write_wav(source.path, [0] * sample_count)
    with AudioEvidenceDetector(settings, FakeBackend()).detect(source) as evidence:
        assert evidence.sample_count == sample_count
        assert evidence.likely_speech_frame_count == 0
        assert evidence.uncertain_frame_count == 0
        assert evidence.frame_count == (sample_count + 511) // 512
        assert all(f.rms == 0 and f.dbfs == -math.inf for f in evidence.iter_frames())


def test_state_is_sequential_within_recording_and_fresh_between_recordings(audio):
    source, settings, _ = audio
    backend = FakeBackend((0.1, 0.45, 0.9))
    detector = AudioEvidenceDetector(settings, backend)
    for _ in range(2):
        with detector.detect(source) as evidence:
            assert [f.vad_probability for f in evidence.iter_frames()] == [0.1, 0.45, 0.9]
    assert len(backend.streams) == backend.closed == 2


@pytest.mark.parametrize("damage", ["garbage", "truncated", "odd", "trailing", "wrong-rate", "stereo", "wrong-width", "bad-align", "bad-byte-rate"])
def test_invalid_wav_is_independently_rejected(audio, damage):
    source, settings, work = audio
    data = bytearray(source.path.read_bytes())
    if damage == "garbage":
        data = b"private-invalid-media"
    elif damage == "truncated":
        data = data[:-2]
    elif damage == "odd":
        data = data[:-1]
        struct.pack_into("<I", data, 4, len(data) - 8)
        struct.pack_into("<I", data, 40, len(data) - 44)
    elif damage == "trailing":
        data += b"private-extra"
    else:
        offset, value = {"wrong-rate": (24, 8000), "stereo": (22, 2), "wrong-width": (34, 8), "bad-align": (32, 1), "bad-byte-rate": (28, 1)}[damage]
        struct.pack_into("<I" if offset in (24, 28) else "<H", data, offset, value)
    source.path.write_bytes(data)
    backend = FakeBackend()
    assert_failure(lambda: AudioEvidenceDetector(settings, backend).detect(source), "VALIDATION", work)
    assert not backend.streams


@pytest.mark.parametrize("expected", [1030, 1032, -1, True, 1031.0])
def test_expected_count_is_exact_and_validated(audio, expected):
    source, settings, work = audio
    assert_failure(lambda: AudioEvidenceDetector(settings, FakeBackend()).detect(source, expected), "VALIDATION", work)


@pytest.mark.parametrize("probability", [float("nan"), float("inf"), -0.1, 1.1, True, "0.9", None])
def test_invalid_probability_fails_without_partial_evidence(audio, probability):
    source, settings, work = audio
    backend = FakeBackend((0.1, probability))
    assert_failure(lambda: AudioEvidenceDetector(settings, backend).detect(source), "INFERENCE", work)
    assert backend.closed == 1


def test_provider_exception_is_sanitized_and_partial_storage_removed(audio):
    source, settings, work = audio
    backend = FakeBackend(failure=RuntimeError("private-provider-payload"))
    assert_failure(lambda: AudioEvidenceDetector(settings, backend).detect(source), "INFERENCE", work)
    assert backend.closed == 1


def test_deadline_expires_during_inference_without_publishing(audio, monkeypatch):
    source, settings, work = audio
    now = [10.0]
    monkeypatch.setattr("sme_meeting_ai.audio.detection.time.monotonic", lambda: now[0])
    backend = FakeBackend(after_infer=lambda: now.__setitem__(0, 10000))
    assert_failure(lambda: AudioEvidenceDetector(settings, backend).detect(source), "TIMEOUT", work)
    assert backend.closed == 1


@pytest.mark.parametrize("field,value", [
    ("audio_max_input_bytes", 10), ("audio_max_duration_seconds", 0.01),
    ("audio_evidence_max_bytes", 1),
])
def test_limits_fail_without_returning_truncated_evidence(audio, field, value):
    source, settings, work = audio
    settings = settings.model_copy(update={field: value})
    assert_failure(lambda: AudioEvidenceDetector(settings, FakeBackend()).detect(source), "RESOURCE", work)


def test_missing_source_or_temp_storage_are_explicit(audio):
    source, settings, work = audio
    missing_source = AudioSource("opaque", source.path.with_name("private-missing"))
    assert_failure(lambda: AudioEvidenceDetector(settings, FakeBackend()).detect(missing_source), "VALIDATION", work)
    settings = settings.model_copy(update={"audio_temp_dir": work / "private-missing"})
    assert_failure(lambda: AudioEvidenceDetector(settings, FakeBackend()).detect(source), "RESOURCE", work)


def test_bounded_reads_and_replay_storage_for_long_audio(audio, monkeypatch):
    source, settings, work = audio
    # A sparse PCM fixture represents one hour without allocating the audio in RAM.
    count = 16000 * 3600
    write_wav(source.path, [])
    with source.path.open("r+b") as output:
        output.seek(4)
        output.write(struct.pack("<I", 36 + count * 2))
        output.seek(40)
        output.write(struct.pack("<I", count * 2))
        output.truncate(44 + count * 2)

    class ConstantStreamBackend(FakeBackend):
        @contextmanager
        def open_stream(self, *, deadline):
            class Stream:
                def infer(self, samples):
                    assert samples.shape == (512,)
                    return 0.1
            yield Stream()

    import sme_meeting_ai.audio.detection as detection

    original_read = detection.os.read
    reads = []

    def bounded_read(fd, size):
        assert 0 < size <= 1024
        reads.append(size)
        return original_read(fd, size)

    monkeypatch.setattr(detection.os, "read", bounded_read)
    with AudioEvidenceDetector(settings, ConstantStreamBackend()).detect(source) as evidence:
        assert evidence.sample_count == count
        assert evidence.frame_count == 112500
        assert sum(1 for _ in evidence.iter_frames()) == 112500
        assert sum(1 for _ in evidence.iter_frames()) == 112500
        assert next(work.rglob("*.bin")).stat().st_size < 64 * evidence.frame_count
        assert len(reads) >= evidence.frame_count
        assert "frames" not in vars(evidence)
    assert list(work.iterdir()) == []


def test_storage_write_failure_is_sanitized_and_cleaned(audio, monkeypatch):
    source, settings, work = audio
    import sme_meeting_ai.audio.detection as detection

    def full(*args):
        raise OSError("private-disk-full")

    monkeypatch.setattr(detection.os, "write", full)
    assert_failure(lambda: AudioEvidenceDetector(settings, FakeBackend()).detect(source), "RESOURCE", work)


def test_partial_evidence_write_failure_removes_previous_records(audio, monkeypatch):
    source, settings, work = audio
    import sme_meeting_ai.audio.detection as detection

    write = detection.os.write
    calls = [0]

    def full_after_first_frame(fd, data):
        calls[0] += 1
        if calls[0] > 2:
            raise OSError("private-disk-full")
        return write(fd, data)

    monkeypatch.setattr(detection.os, "write", full_after_first_frame)
    backend = FakeBackend()
    assert_failure(lambda: AudioEvidenceDetector(settings, backend).detect(source), "RESOURCE", work)
    assert backend.closed == 1


def test_mutated_source_is_rejected_without_publishing_evidence(audio):
    source, settings, work = audio

    def mutate():
        with source.path.open("ab") as output:
            output.write(b"\0\0")

    backend = FakeBackend(after_infer=mutate)
    assert_failure(lambda: AudioEvidenceDetector(settings, backend).detect(source), "VALIDATION", work)


def test_backend_frame_contract_must_match_settings(audio):
    source, settings, work = audio
    backend = FakeBackend()
    backend.frame_samples = 256
    assert_failure(lambda: AudioEvidenceDetector(settings, backend).detect(source), "MODEL_UNAVAILABLE", work)
    assert not backend.streams
