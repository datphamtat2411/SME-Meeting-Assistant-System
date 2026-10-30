"""Bounded Linux/POSIX FFmpeg decoding into privately owned PCM artifacts."""

import json
import math
import os
import re
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import sys
import time
import wave
from contextlib import contextmanager
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from types import MappingProxyType

from sme_meeting_ai.core.config import Settings

from .errors import AudioProcessingError
from .models import AudioProbe, AudioProvenance, AudioSource, NormalizedAudioArtifact

_RATE = 16000
_MEMORY_BYTES = 512 * 1024 * 1024
_STDOUT_BYTES = 256 * 1024
_STDERR_BYTES = 64 * 1024
_HEADER_BYTES = 4096
_NORMALIZER_VERSION = "1"
_FORMATS = "wav,mp3,mov,matroska,webm"
_PCM_CODECS = frozenset({
    "pcm_u8", "pcm_s8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_s64le",
    "pcm_f32le", "pcm_f64le",
})
# A trusted isolated launcher sets limits before exec, without preexec_fn (which
# can deadlock a multithreaded caller). No media data is interpreted by Python.
_LIMITED_EXEC = """
import os, resource, sys
try:
    memory, output, cpu = map(int, sys.argv[1:4])
    for kind, limit in (
        (resource.RLIMIT_AS, memory), (resource.RLIMIT_FSIZE, output),
        (resource.RLIMIT_CPU, cpu), (resource.RLIMIT_CORE, 0),
        (resource.RLIMIT_NOFILE, 64),
        # Keep thread stack reservations within the address-space budget on every host.
        (resource.RLIMIT_STACK, 8 * 1024 * 1024),
    ):
        resource.setrlimit(kind, (limit, limit))
    os.execv(sys.argv[4], sys.argv[4:])
except (OSError, ValueError):
    os._exit(125)
"""


def _data_chunk(path: Path) -> tuple[int, int] | None:
    """Read at most a small WAV header, including while FFmpeg is still writing."""
    with path.open("rb") as source:
        header = source.read(_HEADER_BYTES)
    if header[:4] != b"RIFF" or header[8:12] != b"WAVE":
        return None
    position = 12
    while position + 8 <= len(header):
        size = struct.unpack_from("<I", header, position + 4)[0]
        if header[position:position + 4] == b"data":
            return position + 8, size
        position += 8 + size + (size % 2)
    return None


def _check_output(path: Path | None, max_output_bytes: int, max_samples: int | None) -> None:
    if path is None or not path.exists():
        return
    size = path.stat().st_size
    if size > max_output_bytes:
        raise AudioProcessingError("RESOURCE")
    if max_samples is not None:
        data = _data_chunk(path)
        if data is not None and size - data[0] > max_samples * 2:
            raise AudioProcessingError("RESOURCE")


class _SubprocessRunner:
    """Drain bounded pipes, monitor disk growth, kill and reap the entire group."""

    def __call__(
        self, argv: list[str], *, timeout_seconds: float,
        output_path: Path | None = None, max_output_bytes: int = 1024 * 1024,
        max_samples: int | None = None, pass_fds: tuple[int, ...] = (),
    ) -> bytes:
        process = None
        category = None
        stdout = bytearray()
        stderr = bytearray()
        deadline = time.monotonic() + timeout_seconds
        try:
            process = subprocess.Popen(
                [sys.executable, "-I", "-c", _LIMITED_EXEC, str(_MEMORY_BYTES),
                 str(max_output_bytes), str(max(1, math.ceil(timeout_seconds))), *argv],
                shell=False, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={
                    "PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C",
                    "AV_LOG_FORCE_NOCOLOR": "1", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
                },
                start_new_session=True, close_fds=True, pass_fds=pass_fds,
            )
            with selectors.DefaultSelector() as selector:
                for pipe, buffer, limit in (
                    (process.stdout, stdout, _STDOUT_BYTES),
                    (process.stderr, stderr, _STDERR_BYTES),
                ):
                    os.set_blocking(pipe.fileno(), False)
                    selector.register(pipe, selectors.EVENT_READ, (buffer, limit))
                while selector.get_map() or process.poll() is None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise AudioProcessingError("TIMEOUT")
                    _check_output(output_path, max_output_bytes, max_samples)
                    for key, _ in selector.select(min(0.02, remaining)):
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        buffer, limit = key.data
                        if len(buffer) + len(chunk) > limit:
                            raise AudioProcessingError("RESOURCE")
                        buffer.extend(chunk)
            _check_output(output_path, max_output_bytes, max_samples)
            if process.returncode or stderr:
                resource_error = process.returncode in {125, -signal.SIGXFSZ, -signal.SIGXCPU, -signal.SIGKILL}
                resource_error |= any(marker in stderr for marker in (
                    b"No space left on device", b"Cannot allocate memory", b"File too large",
                    b"Resource temporarily unavailable", b"Memory allocation error",
                ))
                category = "RESOURCE" if resource_error else "DECODING"
        except AudioProcessingError as error:
            category = error.category
        except (OSError, subprocess.SubprocessError, ValueError):
            category = "RESOURCE"
        finally:
            if process is not None:
                # Also catches descendants retaining pipes after their parent exits.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                process.stdout.close()
                process.stderr.close()
        if category is not None:
            # Raising outside handlers deliberately discards input-bearing context.
            raise AudioProcessingError(category)
        return bytes(stdout)


@contextmanager
def _open_source(source: AudioSource, max_bytes: int):
    descriptor = None
    category = None
    try:
        if not isinstance(source.source_id, str) or not source.source_id or len(source.source_id) > 1024:
            raise AudioProcessingError("VALIDATION")
        # Pin a regular inode, reject symlinks, and never block opening a FIFO.
        descriptor = os.open(source.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o444 or info.st_size <= 0:
            raise AudioProcessingError("VALIDATION")
        if info.st_size > max_bytes:
            raise AudioProcessingError("RESOURCE")
    except AudioProcessingError as error:
        category = error.category
    except (OSError, TypeError, ValueError):
        category = "VALIDATION"
    if category is not None:
        if descriptor is not None:
            os.close(descriptor)
        raise AudioProcessingError(category)
    try:
        yield descriptor
        after = os.fstat(descriptor)
        if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
            raise AudioProcessingError("VALIDATION")
    finally:
        os.close(descriptor)


def _duration(value) -> Fraction | None:
    if value in (None, "N/A"):
        return None
    if isinstance(value, bool):
        raise ValueError
    duration = Fraction(str(value))
    if duration < 0:
        raise ValueError
    return duration


def _integer(value, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]+", str(value)):
        raise ValueError
    number = int(value)
    if not minimum <= number <= maximum:
        raise ValueError
    return number


class AudioNormalizer:
    """Decode validated local media; the caller owns each returned artifact."""

    def __init__(self, settings: Settings, runner=None):
        self._settings = settings
        self._runner = runner if runner is not None else _SubprocessRunner()

    @staticmethod
    def _tool(name: str) -> str:
        # Never resolve an executable from source-controlled environment values.
        executable = shutil.which(name, path="/usr/bin:/bin")
        if executable is None:
            raise AudioProcessingError("RESOURCE")
        return executable

    def _probe(self, source_id: str, path: str, pass_fds=(), *, output=False) -> AudioProbe:
        category = "DECODING" if output else "VALIDATION"
        try:
            raw = self._runner([
                self._tool("ffprobe"), "-v", "error", "-max_alloc", "67108864",
                "-protocol_whitelist", "file", "-format_whitelist", _FORMATS,
                "-show_entries",
                "format=format_name,duration:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration",
                "-of", "json", path,
            ], timeout_seconds=self._settings.audio_probe_timeout_seconds, pass_fds=pass_fds)
            data = json.loads(raw)
            streams = data["streams"]
            if not isinstance(streams, list) or len(streams) != 1:
                raise ValueError
            stream = streams[0]
            container = data["format"]["format_name"]
            codec = stream["codec_name"]
            if stream["codec_type"] != "audio":
                raise ValueError
            supported = (
                container == "wav" and codec in _PCM_CODECS
                or container == "mp3" and codec == "mp3"
                or container == "mov,mp4,m4a,3gp,3g2,mj2" and codec == "aac"
                or container == "matroska,webm" and codec == "opus"
            )
            if not supported:
                raise ValueError
            declared = _duration(data["format"].get("duration"))
            stream_duration = _duration(stream.get("duration"))
            durations = [value for value in (declared, stream_duration) if value is not None]
            if not output and any(value > Fraction(str(self._settings.audio_max_duration_seconds)) for value in durations):
                raise AudioProcessingError("RESOURCE")
            layout = stream.get("channel_layout")
            if layout is not None and (not isinstance(layout, str) or len(layout) > 256):
                raise ValueError
            return AudioProbe(
                source_id=source_id, container=container, codec=codec,
                sample_rate_hz=_integer(stream["sample_rate"], 1, 768000),
                channels=_integer(stream["channels"], 1, 64), channel_layout=layout,
                declared_duration=declared if declared is not None else stream_duration,
                stream_index=_integer(stream["index"], 0, 65535),
            )
        except AudioProcessingError as error:
            category = error.category if error.category != "DECODING" else category
        except (ValueError, KeyError, TypeError, OverflowError, RecursionError):
            pass
        raise AudioProcessingError(category)

    def probe(self, source: AudioSource) -> AudioProbe:
        with _open_source(source, self._settings.audio_max_input_bytes) as descriptor:
            return self._probe(source.source_id, f"/proc/self/fd/{descriptor}", (descriptor,))

    def _sample_count(self, path: Path, max_samples: int) -> int:
        category = "DECODING"
        try:
            _check_output(path, self._settings.audio_max_output_bytes, max_samples)
            size = path.stat().st_size
            with path.open("rb") as source:
                header = source.read(12)
            if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
                raise ValueError
            if struct.unpack_from("<I", header, 4)[0] + 8 != size:
                raise ValueError
            data = _data_chunk(path)
            if data is None or data[1] % 2 or data[0] + data[1] != size:
                raise ValueError
            count = 0
            with wave.open(str(path), "rb") as decoded:
                if (decoded.getnchannels(), decoded.getsampwidth(), decoded.getframerate(), decoded.getcomptype()) != (1, 2, _RATE, "NONE"):
                    raise ValueError
                while chunk := decoded.readframes(32768):
                    if len(chunk) % 2:
                        raise ValueError
                    count += len(chunk) // 2
                    if count > max_samples:
                        raise AudioProcessingError("RESOURCE")
                if count <= 0 or count != decoded.getnframes() or count * 2 != data[1]:
                    raise ValueError
            return count
        except AudioProcessingError as error:
            category = error.category
        except (ValueError, EOFError, wave.Error, struct.error):
            pass
        except OSError:
            category = "RESOURCE"
        raise AudioProcessingError(category)

    def normalize(self, source: AudioSource) -> NormalizedAudioArtifact:
        temporary = None
        artifact = None
        category = None
        succeeded = False
        try:
            with _open_source(source, self._settings.audio_max_input_bytes) as descriptor:
                metadata = self._probe(source.source_id, f"/proc/self/fd/{descriptor}", (descriptor,))
                version_output = self._runner(
                    [self._tool("ffmpeg"), "-version"],
                    timeout_seconds=self._settings.audio_probe_timeout_seconds,
                )
                version = re.match(rb"ffmpeg version ([a-zA-Z0-9.+_~:-]{1,128})(?:\s|$)", version_output)
                if version is None:
                    raise AudioProcessingError("RESOURCE")
                temporary = TemporaryDirectory(prefix="ai-audio-", dir=self._settings.audio_temp_dir)
                partial_path = Path(temporary.name) / "normalized.part"
                fd = os.open(partial_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(fd)
                max_samples = int(Fraction(str(self._settings.audio_max_duration_seconds)) * _RATE)
                max_bytes = min(self._settings.audio_max_output_bytes, max_samples * 2 + _HEADER_BYTES)
                self._runner([
                    self._tool("ffmpeg"), "-nostdin", "-v", "error", "-y", "-xerror",
                    "-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1",
                    "-protocol_whitelist", "file", "-format_whitelist", _FORMATS,
                    "-err_detect", "explode", "-i", f"/proc/self/fd/{descriptor}",
                    "-map", f"0:{metadata.stream_index}", "-map_metadata", "-1",
                    "-vn", "-sn", "-dn", "-ac", "1", "-ar", str(_RATE),
                    "-af", "aresample=16000:async=0,asetpts=N/SR/TB",
                    "-c:a", "pcm_s16le", "-threads", "1", "-fflags", "+bitexact",
                    "-flags:a", "+bitexact", "-f", "wav", str(partial_path),
                ], timeout_seconds=self._settings.audio_decode_timeout_seconds,
                    pass_fds=(descriptor,), output_path=partial_path,
                    max_output_bytes=max_bytes, max_samples=max_samples)
                sample_count = self._sample_count(partial_path, max_samples)
                output_metadata = self._probe(source.source_id, str(partial_path), output=True)
                if (output_metadata.container, output_metadata.codec, output_metadata.sample_rate_hz, output_metadata.channels) != ("wav", "pcm_s16le", _RATE, 1):
                    raise AudioProcessingError("DECODING")
                published = partial_path.with_suffix(".wav")
                partial_path.rename(published)
                provenance = AudioProvenance(
                    source_id=source.source_id, normalizer_version=_NORMALIZER_VERSION,
                    decoder="ffmpeg", decoder_version=version[1].decode("ascii"),
                    target_format=MappingProxyType({
                        "container": "wav", "codec": "pcm_s16le", "sample_format": "s16",
                        "sample_rate_hz": _RATE, "channels": 1,
                    }),
                    effective_configuration=MappingProxyType({
                        "max_input_bytes": self._settings.audio_max_input_bytes,
                        "max_duration_seconds": self._settings.audio_max_duration_seconds,
                        "max_output_bytes": self._settings.audio_max_output_bytes,
                        "probe_timeout_seconds": self._settings.audio_probe_timeout_seconds,
                        "decode_timeout_seconds": self._settings.audio_decode_timeout_seconds,
                        "temp_dir": str(self._settings.audio_temp_dir),
                        "subprocess_memory_bytes": _MEMORY_BYTES,
                        "subprocess_stdout_bytes": _STDOUT_BYTES,
                        "subprocess_stderr_bytes": _STDERR_BYTES,
                        "decoder_threads": 1, "protocol_whitelist": "file",
                    }),
                )
                artifact = NormalizedAudioArtifact(
                    path=published, source_id=source.source_id, source_metadata=metadata,
                    sample_count=sample_count, provenance=provenance, _temporary=temporary,
                )
            # Source stability is checked by _open_source before ownership transfers.
            succeeded = True
            return artifact
        except AudioProcessingError as error:
            category = error.category
        except (OSError, MemoryError):
            category = "RESOURCE"
        finally:
            if not succeeded and temporary is not None:
                try:
                    temporary.cleanup()
                except OSError:
                    category = "RESOURCE"
        raise AudioProcessingError(category)
