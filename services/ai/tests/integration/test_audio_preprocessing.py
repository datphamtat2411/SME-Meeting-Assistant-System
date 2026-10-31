import hashlib
import math
import struct
import subprocess
import wave
from fractions import Fraction

import pytest

from sme_meeting_ai.audio import AudioNormalizer, AudioProcessingError, AudioSource
from sme_meeting_ai.core.config import Settings


@pytest.fixture
def audio(tmp_path):
    # Distinct stereo channels make selecting either channel observably wrong.
    rate = 48000
    frames = bytearray()
    for index in range(rate):
        tone = int(12000 * math.sin(2 * math.pi * 400 * index / rate)) if rate // 4 <= index < rate * 3 // 4 else 0
        frames.extend(struct.pack("<hh", tone, 0))
    source = tmp_path / "source.wav"
    with wave.open(str(source), "wb") as output:
        output.setparams((2, 2, rate, 0, "NONE", ""))
        output.writeframes(frames)
    work = tmp_path / "work"
    work.mkdir()
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", audio_temp_dir=work,
        _env_file=None,
    )
    return source, settings, work


def encode(source, target, *options):
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source), *options, str(target)],
        check=True, capture_output=True, timeout=20,
    )


@pytest.mark.parametrize("extension,options,codec", [
    ("wav", ["-c:a", "pcm_s24le"], "pcm_s24le"),
    ("mp3", ["-c:a", "libmp3lame"], "mp3"),
    ("m4a", ["-c:a", "aac"], "aac"),
    ("mp4", ["-c:a", "aac"], "aac"),
    ("webm", ["-c:a", "libopus"], "opus"),
    ("mka", ["-c:a", "libopus"], "opus"),
])
def test_real_supported_formats_with_misleading_extensions(audio, extension, options, codec):
    source, settings, work = audio
    encoded = source.parent / f"encoded.{extension}"
    encode(source, encoded, *options)
    misleading = encoded.with_suffix(".not-media")
    encoded.rename(misleading)
    original = hashlib.sha256(misleading.read_bytes()).digest()
    normalizer = AudioNormalizer(settings)
    probe = normalizer.probe(AudioSource("source-id", misleading))
    assert probe.codec == codec and probe.channels == 2 and probe.sample_rate_hz == 48000
    with normalizer.normalize(AudioSource("source-id", misleading)) as artifact:
        with wave.open(str(artifact.path), "rb") as decoded:
            assert (decoded.getnchannels(), decoded.getsampwidth(), decoded.getframerate()) == (1, 2, 16000)
            pcm = decoded.readframes(decoded.getnframes())
            assert len(pcm) // 2 == artifact.sample_count
        assert artifact.duration == Fraction(artifact.sample_count, 16000)
        assert artifact.start_sample == 0 and artifact.end_sample == artifact.sample_count
        # Codec padding is retained; duration is never forced to the declared duration.
        assert 16000 <= artifact.sample_count < 17500
        samples = struct.unpack(f"<{len(pcm) // 2}h", pcm)
        assert max(abs(value) for value in samples[:2000]) < 10
        assert max(abs(value) for value in samples[-2000:]) < 10
        assert 5000 < max(abs(value) for value in samples[5000:10000]) < 7500
    assert hashlib.sha256(misleading.read_bytes()).digest() == original
    assert list(work.iterdir()) == []


def test_silence_is_complete_and_resampling_is_sample_accurate(audio):
    source, settings, work = audio
    # A non-integral duration checks that duration is based on the PCM frame count.
    with wave.open(str(source), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", ""))
        output.writeframes(b"\0\0" * 16037)
    with AudioNormalizer(settings).normalize(AudioSource("silent-source", source)) as artifact:
        assert artifact.sample_count == 16037
        assert artifact.duration == Fraction(16037, 16000)
        with wave.open(str(artifact.path), "rb") as decoded:
            assert decoded.readframes(16038) == b"\0\0" * 16037
    assert list(work.iterdir()) == []


def test_wav_downmix_preserves_full_timeline_and_original(audio):
    source, settings, _ = audio
    original = source.read_bytes()
    with AudioNormalizer(settings).normalize(AudioSource("stereo", source)) as artifact:
        assert artifact.sample_count == 16000
        assert artifact.duration == 1
    assert source.read_bytes() == original


@pytest.mark.parametrize("kind", ["malformed", "truncated", "unsupported", "video", "multiple-audio"])
def test_real_invalid_sources_fail_and_cleanup(audio, kind, caplog):
    source, settings, work = audio
    candidate = source.parent / "private-media.wav"
    if kind == "malformed":
        candidate.write_bytes(b"private-media-payload")
    elif kind == "truncated":
        candidate.write_bytes(source.read_bytes()[:-10000])
    elif kind == "unsupported":
        candidate = candidate.with_suffix(".flac")
        encode(source, candidate, "-c:a", "flac")
    elif kind == "multiple-audio":
        candidate = candidate.with_suffix(".mka")
        encode(source, candidate, "-map", "0:a", "-map", "0:a", "-c:a", "libopus")
    else:
        candidate = candidate.with_suffix(".mp4")
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
            "color=size=16x16:rate=1:duration=1", "-i", str(source),
            "-c:v", "mpeg4", "-c:a", "aac", str(candidate),
        ], check=True, capture_output=True, timeout=20)
    original = candidate.read_bytes()
    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings).normalize(AudioSource("opaque", candidate))
    assert caught.value.category in {"VALIDATION", "DECODING"}
    assert str(candidate) not in str(caught.value) + caplog.text
    assert "private-media-payload" not in str(caught.value) + caplog.text
    assert caught.value.__context__ is None
    assert candidate.read_bytes() == original
    assert list(work.iterdir()) == []
