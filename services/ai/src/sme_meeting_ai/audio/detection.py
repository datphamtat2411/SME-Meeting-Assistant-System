"""Read-only PCM evidence detection with sample-exact timing and bounded storage."""

import math
import os
import stat
import struct
import time
from contextlib import contextmanager
from fractions import Fraction
from numbers import Real
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from sme_meeting_ai.core.config import Settings

from .errors import AudioProcessingError
from .models import (
    _EVIDENCE_HEADER,
    _EVIDENCE_LABELS,
    _EVIDENCE_RECORD,
    AudioSource,
    DetectionProvenance,
    SpeechEnergyEvidence,
    VadLabel,
)
from .vad import VadBackend

_RATE = 16000
_DETECTOR_VERSION = "1"


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise AudioProcessingError("TIMEOUT")


@contextmanager
def _open_pcm(source: AudioSource, max_bytes: int):
    descriptor = None
    category = None
    try:
        if not isinstance(source.source_id, str) or not source.source_id or len(source.source_id) > 1024:
            raise AudioProcessingError("VALIDATION")
        descriptor = os.open(source.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or not before.st_mode & 0o444 or before.st_size <= 0:
            raise AudioProcessingError("VALIDATION")
        if before.st_size > max_bytes:
            raise AudioProcessingError("RESOURCE")
    except AudioProcessingError as error:
        category = error.category
    except (OSError, TypeError, ValueError, AttributeError):
        category = "VALIDATION"
    if category is not None:
        if descriptor is not None:
            os.close(descriptor)
        raise AudioProcessingError(category)
    try:
        yield descriptor, before.st_size
        after = os.fstat(descriptor)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise AudioProcessingError("VALIDATION")
    finally:
        os.close(descriptor)


def _wav_layout(descriptor: int, size: int, deadline: float) -> tuple[int, int]:
    """Validate RIFF chunks without decoding or reading unbounded metadata/audio."""
    header = os.read(descriptor, 12)
    if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE" or struct.unpack_from("<I", header, 4)[0] + 8 != size:
        raise AudioProcessingError("VALIDATION")
    position = 12
    format_seen = False
    data = None
    while position < size:
        _check_deadline(deadline)
        if size - position < 8:
            raise AudioProcessingError("VALIDATION")
        os.lseek(descriptor, position, os.SEEK_SET)
        chunk_header = os.read(descriptor, 8)
        if len(chunk_header) != 8:
            raise AudioProcessingError("VALIDATION")
        kind, length = struct.unpack("<4sI", chunk_header)
        end = position + 8 + length
        padded_end = end + length % 2
        if padded_end > size:
            raise AudioProcessingError("VALIDATION")
        if kind == b"fmt ":
            if format_seen or length not in (16, 18):
                raise AudioProcessingError("VALIDATION")
            fmt = os.read(descriptor, length)
            if len(fmt) != length or struct.unpack("<HHIIHH", fmt[:16]) != (1, 1, _RATE, _RATE * 2, 2, 16) or (length == 18 and fmt[16:] != b"\0\0"):
                raise AudioProcessingError("VALIDATION")
            format_seen = True
        elif kind == b"data":
            if not format_seen or data is not None or length % 2:
                raise AudioProcessingError("VALIDATION")
            data = (position + 8, length // 2)
        position = padded_end
    if not format_seen or data is None:
        raise AudioProcessingError("VALIDATION")
    return data


def _write_record(descriptor: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        written = os.write(descriptor, data[offset:])
        if written <= 0:
            raise AudioProcessingError("RESOURCE")
        offset += written


class AudioEvidenceDetector:
    """Independent VAD and energy evidence; never trims, merges, or rewrites audio."""

    def __init__(self, settings: Settings, vad_backend: VadBackend):
        self._settings = settings
        self._vad = vad_backend

    def detect(self, source: AudioSource, expected_sample_count: int | None = None) -> SpeechEnergyEvidence:
        temporary = None
        result = None
        category = None
        deadline = time.monotonic() + self._settings.audio_vad_timeout_seconds
        try:
            if expected_sample_count is not None and (type(expected_sample_count) is not int or expected_sample_count < 0):
                raise AudioProcessingError("VALIDATION")
            if self._vad.frame_samples != self._settings.audio_vad_frame_samples:
                raise AudioProcessingError("MODEL_UNAVAILABLE")
            with _open_pcm(source, self._settings.audio_max_input_bytes) as (descriptor, size):
                data_offset, sample_count = _wav_layout(descriptor, size, deadline)
                if expected_sample_count is not None and sample_count != expected_sample_count:
                    raise AudioProcessingError("VALIDATION")
                if Fraction(sample_count, _RATE) > Fraction(str(self._settings.audio_max_duration_seconds)):
                    raise AudioProcessingError("RESOURCE")
                frame_samples = self._settings.audio_vad_frame_samples
                frame_count = (sample_count + frame_samples - 1) // frame_samples
                storage_bytes = len(_EVIDENCE_HEADER) + frame_count * _EVIDENCE_RECORD.size
                if storage_bytes > self._settings.audio_evidence_max_bytes:
                    raise AudioProcessingError("RESOURCE")
                temporary = TemporaryDirectory(prefix="sme-evidence-", dir=self._settings.audio_temp_dir)
                path = Path(temporary.name) / "frames.bin"
                output = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    _write_record(output, _EVIDENCE_HEADER)
                    counts = self._detect_frames(descriptor, data_offset, sample_count, output, deadline)
                finally:
                    os.close(output)
                _check_deadline(deadline)
            # Publish only after the read-only source's identity and complete
            # sample coverage have been checked and all inference state is closed.
            result = SpeechEnergyEvidence(
                source_id=source.source_id, sample_count=sample_count, frame_count=frame_count,
                likely_speech_frame_count=counts[VadLabel.LIKELY_SPEECH],
                likely_non_speech_frame_count=counts[VadLabel.LIKELY_NON_SPEECH],
                uncertain_frame_count=counts[VadLabel.UNCERTAIN],
                provenance=self._provenance(), _path=path, _temporary=temporary,
            )
        except AudioProcessingError as error:
            category = error.category
        except (OSError, MemoryError):
            category = "RESOURCE"
        except Exception:
            category = "INFERENCE"
        finally:
            if result is None and temporary is not None:
                try:
                    temporary.cleanup()
                except OSError:
                    category = "RESOURCE"
        if category is not None:
            raise AudioProcessingError(category)
        return result

    def _detect_frames(self, descriptor: int, data_offset: int, sample_count: int, output: int, deadline: float) -> dict[VadLabel, int]:
        counts = dict.fromkeys(VadLabel, 0)
        os.lseek(descriptor, data_offset, os.SEEK_SET)
        with self._vad.open_stream(deadline=deadline) as stream:
            start = 0
            while start < sample_count:
                _check_deadline(deadline)
                count = min(self._settings.audio_vad_frame_samples, sample_count - start)
                pcm = os.read(descriptor, count * 2)
                if len(pcm) != count * 2:
                    raise AudioProcessingError("VALIDATION")
                samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / np.float32(32768)
                # Compute energy from real samples before any model-only padding.
                energy_samples = samples.astype(np.float64)
                rms = float(np.sqrt(np.mean(energy_samples * energy_samples)))
                dbfs = 20 * math.log10(rms) if rms else -math.inf
                padding = self._settings.audio_vad_frame_samples - count
                if padding:
                    samples = np.pad(samples, (0, padding))
                probability = stream.infer(samples)
                _check_deadline(deadline)
                if isinstance(probability, bool) or not isinstance(probability, Real) or not math.isfinite(probability) or not 0 <= probability <= 1:
                    raise AudioProcessingError("INFERENCE")
                if probability >= self._settings.audio_vad_speech_threshold:
                    label = VadLabel.LIKELY_SPEECH
                elif probability <= self._settings.audio_vad_non_speech_threshold:
                    label = VadLabel.LIKELY_NON_SPEECH
                else:
                    label = VadLabel.UNCERTAIN
                # No energy threshold influences VAD probability or classification.
                _write_record(output, _EVIDENCE_RECORD.pack(start, start + count, probability, rms, dbfs, _EVIDENCE_LABELS.index(label), padding))
                counts[label] += 1
                start += count
        return counts

    def _provenance(self) -> DetectionProvenance:
        settings = self._settings
        return DetectionProvenance(
            model_id=self._vad.model_id, model_version=self._vad.model_version,
            model_sha256=self._vad.model_sha256, backend=self._vad.backend,
            detector_version=_DETECTOR_VERSION,
            effective_configuration={
                "sample_rate_hz": _RATE,
                "frame_samples": settings.audio_vad_frame_samples,
                "tail_padding": "model-only-zero-padding",
                "speech_threshold": settings.audio_vad_speech_threshold,
                "non_speech_threshold": settings.audio_vad_non_speech_threshold,
                "timeout_seconds": settings.audio_vad_timeout_seconds,
                "model_max_bytes": settings.audio_vad_model_max_bytes,
                "evidence_max_bytes": settings.audio_evidence_max_bytes,
                "max_input_bytes": settings.audio_max_input_bytes,
                "max_duration_seconds": settings.audio_max_duration_seconds,
                "max_concurrent_recordings": self._vad.max_concurrent_recordings,
                "inference_threads": self._vad.inference_threads,
                "storage_version": 1,
            },
        )
