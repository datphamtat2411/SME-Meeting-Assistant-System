import errno
import json
import os
import struct
import subprocess
import sys
import traceback
import wave
from fractions import Fraction
from pathlib import Path

import pytest

from sme_meeting_ai.audio import AudioNormalizer, AudioProcessingError, AudioSource
from sme_meeting_ai.audio.normalization import _SubprocessRunner
from sme_meeting_ai.core.config import Settings


def write_wav(path, samples=1600):
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(b"\0\0" * samples)


def probe_data(**overrides):
    stream = {
        "index": 0, "codec_type": "audio", "codec_name": "pcm_s16le",
        "sample_rate": "16000", "channels": 1, "channel_layout": "mono",
    }
    stream.update(overrides)
    return {"format": {"format_name": "wav", "duration": "0.1"}, "streams": [stream]}


class FakeRunner:
    def __init__(self, data=None, output=None, failure=None):
        self.data = data or probe_data()
        self.output = output
        self.failure = failure
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if "-version" in argv:
            return b"ffmpeg version 7.1-test Copyright\n"
        if Path(argv[0]).name == "ffprobe":
            return json.dumps(self.data).encode()
        if self.failure:
            raise self.failure
        if self.output is None:
            write_wav(Path(argv[-1]))
        else:
            Path(argv[-1]).write_bytes(self.output)
        return b""


@pytest.fixture
def setup_audio(tmp_path):
    source = tmp_path / "private-original.untrusted"
    write_wav(source)
    work = tmp_path / "work"
    work.mkdir()
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", audio_temp_dir=work,
        _env_file=None,
    )
    return AudioSource("opaque-source", source), settings, work


def test_artifact_exact_timeline_provenance_and_ownership(setup_audio):
    source, settings, work = setup_audio
    original = source.path.read_bytes()
    runner = FakeRunner()
    with AudioNormalizer(settings, runner=runner).normalize(source) as artifact:
        assert artifact.path.is_file()
        assert artifact.path.suffix == ".wav"
        assert artifact.path.stat().st_mode & 0o777 == 0o600
        assert artifact.path.parent.stat().st_mode & 0o777 == 0o700
        assert artifact.source_id == "opaque-source"
        assert artifact.sample_count == 1600
        assert artifact.duration == Fraction(1, 10)
        assert (artifact.start_sample, artifact.end_sample) == (0, 1600)
        assert (artifact.start_time, artifact.end_time) == (0, Fraction(1, 10))
        assert (artifact.sample_rate_hz, artifact.channels, artifact.sample_format) == (16000, 1, "s16")
        assert artifact.source_metadata.codec == "pcm_s16le"
        assert artifact.provenance.source_id == source.source_id
        assert artifact.provenance.normalizer_version
        assert artifact.provenance.decoder_version == "7.1-test"
        assert artifact.provenance.effective_configuration["max_output_bytes"] == 134217728
        assert artifact.provenance.target_format["sample_rate_hz"] == 16000
        path = artifact.path
    artifact.close()
    assert not path.exists()
    assert list(work.iterdir()) == []
    assert source.path.read_bytes() == original


def test_decoder_argv_and_environment_contract(setup_audio):
    source, settings, _ = setup_audio
    runner = FakeRunner()
    with AudioNormalizer(settings, runner=runner).normalize(source):
        pass
    argv, options = next(call for call in runner.calls if "-i" in call[0])
    assert "-nostdin" in argv and "-xerror" in argv
    assert argv[argv.index("-protocol_whitelist") + 1] == "file"
    assert argv[argv.index("-err_detect") + 1] == "explode"
    assert argv[argv.index("-ac") + 1] == "1"
    assert argv[argv.index("-ar") + 1] == "16000"
    assert argv[argv.index("-c:a") + 1] == "pcm_s16le"
    assert "aresample=16000:async=0,asetpts=N/SR/TB" in argv
    assert not {"-t", "-to", "-ss", "-fs", "-shortest"}.intersection(argv)
    assert options["timeout_seconds"] == settings.audio_decode_timeout_seconds
    assert options["pass_fds"]
    assert all(str(source.path) not in arg for arg in argv)


@pytest.mark.parametrize("data", [
    probe_data(codec_name="flac"), probe_data(sample_rate="NaN"),
    probe_data(channels=0), probe_data(index=-1),
    {"format": {"format_name": "ogg"}, "streams": [probe_data()["streams"][0]]},
    {"format": {"format_name": "wav"}, "streams": []},
    {"format": {"format_name": "wav"}, "streams": probe_data()["streams"] * 2},
    {"format": {"format_name": "wav"}, "streams": [
        *probe_data()["streams"], {"codec_type": "video", "codec_name": "h264"},
    ]},
    {"format": {"format_name": "wav", "duration": "NaN"}, "streams": probe_data()["streams"]},
])
def test_rejects_invalid_or_ambiguous_actual_streams(setup_audio, data):
    source, settings, work = setup_audio
    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings, runner=FakeRunner(data)).normalize(source)
    assert caught.value.category == "VALIDATION"
    assert list(work.iterdir()) == []


@pytest.mark.parametrize("kind", ["missing", "directory", "symlink", "fifo", "empty", "unreadable"])
def test_rejects_invalid_local_sources_before_subprocess(setup_audio, kind):
    source, settings, _ = setup_audio
    invalid = source.path.parent / "invalid"
    if kind == "directory":
        invalid.mkdir()
    elif kind == "symlink":
        invalid.symlink_to(source.path)
    elif kind == "fifo":
        os.mkfifo(invalid)
    elif kind in {"empty", "unreadable"}:
        invalid.write_bytes(b"" if kind == "empty" else b"private")
        if kind == "unreadable":
            invalid.chmod(0)
    runner = FakeRunner()
    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings, runner=runner).probe(AudioSource("opaque", invalid))
    assert caught.value.category == "VALIDATION"
    assert not runner.calls


@pytest.mark.parametrize("field,value,data", [
    ("audio_max_input_bytes", 1, None),
    ("audio_max_duration_seconds", 0.05, None),
    ("audio_max_duration_seconds", 0.05, {"format": {"format_name": "wav"}, "streams": probe_data()["streams"]}),
    ("audio_max_output_bytes", 64, None),
])
def test_limits_reject_instead_of_truncating(setup_audio, field, value, data):
    source, settings, work = setup_audio
    settings = settings.model_copy(update={field: value})
    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings, runner=FakeRunner(data)).normalize(source)
    assert caught.value.category == "RESOURCE"
    assert list(work.iterdir()) == []


@pytest.mark.parametrize("damage", ["empty", "garbage", "truncated", "odd", "wrong-rate", "trailing"])
def test_successful_decoder_with_invalid_wav_is_not_published(setup_audio, damage):
    source, settings, work = setup_audio
    data = source.path.read_bytes()
    if damage == "empty":
        data = b""
    elif damage == "garbage":
        data = b"private decoder payload"
    elif damage == "truncated":
        data = data[:-2]
    elif damage == "odd":
        data = data[:-1]
        data = data[:4] + struct.pack("<I", len(data) - 8) + data[8:40] + struct.pack("<I", len(data) - 44) + data[44:]
    elif damage == "wrong-rate":
        data = data[:24] + struct.pack("<I", 8000) + data[28:]
    else:
        data += b"extra"
    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings, runner=FakeRunner(output=data)).normalize(source)
    assert caught.value.category == "DECODING"
    assert list(work.iterdir()) == []


def test_output_probe_is_independently_validated(setup_audio):
    source, settings, work = setup_audio
    runner = FakeRunner()
    original_call = runner.__call__

    def call(argv, **kwargs):
        result = original_call(argv, **kwargs)
        if Path(argv[0]).name == "ffprobe" and len(runner.calls) > 1:
            return json.dumps(probe_data(sample_rate="8000")).encode()
        return result

    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings, runner=call).normalize(source)
    assert caught.value.category == "DECODING"
    assert list(work.iterdir()) == []


def test_declared_duration_does_not_determine_sample_count(setup_audio):
    source, settings, _ = setup_audio
    data = probe_data()
    data["format"]["duration"] = "3.25"
    with AudioNormalizer(settings, runner=FakeRunner(data)).normalize(source) as artifact:
        assert artifact.duration == Fraction(1, 10)
        assert artifact.source_metadata.declared_duration == Fraction(13, 4)


@pytest.mark.parametrize("category", ["DECODING", "TIMEOUT", "RESOURCE"])
def test_failures_cleanup_and_errors_are_sanitized(setup_audio, category, caplog):
    source, settings, work = setup_audio
    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings, runner=FakeRunner(failure=AudioProcessingError(category))).normalize(source)
    text = "".join(traceback.format_exception(caught.value)) + caplog.text
    assert str(source.path) not in text
    assert "private decoder" not in text
    assert caught.value.__context__ is None
    assert list(work.iterdir()) == []


def test_temporary_storage_failure_is_sanitized(setup_audio):
    source, settings, _ = setup_audio
    settings = settings.model_copy(update={"audio_temp_dir": source.path / "private-missing"})
    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings, runner=FakeRunner()).normalize(source)
    assert caught.value.category == "RESOURCE"
    assert caught.value.__context__ is None
    assert "private-missing" not in "".join(traceback.format_exception(caught.value))


def test_missing_decoder_tools_are_explicit_and_sanitized(setup_audio, monkeypatch):
    source, settings, work = setup_audio
    monkeypatch.setattr("sme_meeting_ai.audio.normalization.shutil.which", lambda *args, **kwargs: None)
    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings).normalize(source)
    assert caught.value.category == "RESOURCE"
    assert caught.value.__context__ is None
    assert list(work.iterdir()) == []


def test_artifact_context_cleans_up_after_consumer_error(setup_audio):
    source, settings, work = setup_audio
    with pytest.raises(RuntimeError):
        with AudioNormalizer(settings, runner=FakeRunner()).normalize(source):
            raise RuntimeError("consumer failed")
    assert list(work.iterdir()) == []


def test_changed_source_is_not_published(setup_audio):
    source, settings, work = setup_audio
    runner = FakeRunner()

    def change_source(argv, **kwargs):
        result = runner(argv, **kwargs)
        if "-i" in argv:
            source.path.write_bytes(b"changed source")
        return result

    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings, runner=change_source).normalize(source)
    assert caught.value.category == "VALIDATION"
    assert list(work.iterdir()) == []


def test_invalid_probe_json_is_sanitized(setup_audio):
    source, settings, work = setup_audio
    # Keep the payload literal out of the source line displayed in the traceback.
    payload = b"private-invalid-json"
    with pytest.raises(AudioProcessingError) as caught:
        AudioNormalizer(settings, runner=lambda *args, **kwargs: payload).normalize(source)
    assert caught.value.category == "VALIDATION"
    assert payload.decode() not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None
    assert list(work.iterdir()) == []


def run_child(code, **kwargs):
    return _SubprocessRunner()(
        [sys.executable, "-c", code], timeout_seconds=kwargs.pop("timeout_seconds", 2),
        **kwargs,
    )


@pytest.mark.parametrize("code,category", [
    ("import sys; sys.stderr.write('private-path payload'); sys.exit(1)", "DECODING"),
    ("import sys; sys.stderr.write('private-path payload')", "DECODING"),
    ("import time; time.sleep(10)", "TIMEOUT"),
    ("import os; os.write(1, b'x'*300000)", "RESOURCE"),
    ("import os; os.write(2, b'x'*300000)", "RESOURCE"),
    ("import sys; sys.stderr.write('No space left on device: private-path'); sys.exit(1)", "RESOURCE"),
])
def test_real_runner_bounds_failures_without_sensitive_context(code, category):
    with pytest.raises(AudioProcessingError) as caught:
        run_child(code, timeout_seconds=0.3)
    assert caught.value.category == category
    text = "".join(traceback.format_exception(caught.value))
    assert "private-path" not in str(caught.value)
    assert caught.value.__context__ is None
    assert "CalledProcessError" not in text


def test_runner_controlled_environment_and_child_resource_limits(monkeypatch):
    monkeypatch.setenv("PRIVATE_MEDIA_SECRET", "private-payload")
    popen = subprocess.Popen
    calls = []

    def record(*args, **kwargs):
        calls.append(kwargs)
        return popen(*args, **kwargs)

    monkeypatch.setattr("sme_meeting_ai.audio.normalization.subprocess.Popen", record)
    code = (
        "import os,resource,json; print(json.dumps({'secret':os.getenv('PRIVATE_MEDIA_SECRET'),"
        "'memory':resource.getrlimit(resource.RLIMIT_AS)[0],"
        "'core':resource.getrlimit(resource.RLIMIT_CORE)[0]}))"
    )
    result = json.loads(run_child(code))
    assert result == {"secret": None, "memory": 536870912, "core": 0}
    assert calls[0]["shell"] is False
    assert calls[0]["start_new_session"] is True
    assert "preexec_fn" not in calls[0]
    assert calls[0]["env"]["OPENBLAS_NUM_THREADS"] == "1"


def test_runner_kills_and_reaps_process_group_on_timeout(tmp_path):
    pidfile = tmp_path / "pids"
    code = (
        "import os,time; from pathlib import Path; child=os.fork(); "
        f"Path({str(pidfile)!r} + str(os.getpid())).write_text(str(os.getpid())); "
        "time.sleep(10)"
    )
    with pytest.raises(AudioProcessingError) as caught:
        run_child(code, timeout_seconds=0.3)
    assert caught.value.category == "TIMEOUT"
    pids = [int(path.read_text()) for path in tmp_path.iterdir()]
    assert len(pids) == 2
    for pid in pids:
        status = Path(f"/proc/{pid}/stat")
        assert not status.exists() or status.read_text().split()[2] == "Z"
    with pytest.raises(ChildProcessError):
        os.waitpid(pids[0], os.WNOHANG)


@pytest.mark.parametrize("limit_kind", ["output", "duration"])
def test_runner_enforces_growing_file_limits(tmp_path, limit_kind):
    output = tmp_path / "partial.wav"
    code = (
        "import wave,time; "
        f"w=wave.open({str(output)!r}, 'wb'); w.setparams((1,2,16000,0,'NONE','')); "
        "w.writeframes(b'\\0\\0'*10000); time.sleep(10)"
    )
    with pytest.raises(AudioProcessingError) as caught:
        run_child(code, output_path=output, max_output_bytes=1024 if limit_kind == "output" else 30000,
                  max_samples=100 if limit_kind == "duration" else 16000)
    assert caught.value.category == "RESOURCE"


@pytest.mark.parametrize("number", [errno.ENOENT, errno.ENOSPC, errno.ENOMEM, errno.EACCES])
def test_runner_spawn_failures_are_sanitized(monkeypatch, number):
    def fail(*args, **kwargs):
        raise OSError(number, "private raw OS failure", "/private/media")

    monkeypatch.setattr("sme_meeting_ai.audio.normalization.subprocess.Popen", fail)
    with pytest.raises(AudioProcessingError) as caught:
        run_child("pass")
    assert caught.value.category == "RESOURCE"
    assert caught.value.__context__ is None
    assert "private" not in "".join(traceback.format_exception(caught.value))
