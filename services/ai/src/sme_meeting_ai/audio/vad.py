"""CPU Silero v5-compatible ONNX adapter; no model acquisition or job wiring."""

import hashlib
import math
import os
import stat
import threading
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import AbstractContextManager, asynccontextmanager, contextmanager
from typing import Protocol

import numpy as np
from numpy.typing import NDArray

from sme_meeting_ai.core.config import Settings

from .errors import AudioProcessingError


class VadStream(Protocol):
    """Fresh recurrent state per recording; accepts one padded float32 PCM frame."""

    def infer(self, samples: NDArray[np.float32]) -> float: ...


class VadBackend(Protocol):
    model_id: str
    model_version: str
    model_sha256: str
    backend: str
    frame_samples: int
    max_concurrent_recordings: int
    inference_threads: int

    def open_stream(self, *, deadline: float) -> AbstractContextManager[VadStream]: ...


def _compatible_node(node, name: str, dtype: str, shape: tuple[int, ...]) -> bool:
    return (
        node.name == name and node.type == dtype and len(node.shape) == len(shape)
        and all(actual is None or isinstance(actual, str) or actual == expected
                for actual, expected in zip(node.shape, shape, strict=True))
    )


class _SileroStream:
    def __init__(self, session, run_options, deadline: float):
        self._session = session
        self._options = run_options
        self._deadline = deadline
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, 64), dtype=np.float32)
        self._closed = False
        self._lock = threading.Lock()

    def infer(self, samples: NDArray[np.float32]) -> float:
        # A recording is sequential, even if a caller accidentally shares it.
        if not self._lock.acquire(blocking=False):
            raise AudioProcessingError("RESOURCE")
        category = None
        probability = None
        try:
            if self._closed:
                raise AudioProcessingError("INFERENCE")
            if time.monotonic() >= self._deadline:
                raise AudioProcessingError("TIMEOUT")
            if samples.shape != (512,) or samples.dtype != np.float32 or not np.isfinite(samples).all():
                raise AudioProcessingError("INFERENCE")
            data = np.concatenate((self._context, samples.reshape(1, 512)), axis=1)
            outputs = self._session.run(
                ["output", "stateN"],
                {"input": data, "state": self._state, "sr": np.array(16000, dtype=np.int64)},
                self._options,
            )
            if time.monotonic() >= self._deadline:
                raise AudioProcessingError("TIMEOUT")
            output, state = outputs
            if (
                output.shape != (1, 1) or output.dtype != np.float32
                or state.shape != (2, 1, 128) or state.dtype != np.float32
                or not np.isfinite(state).all()
            ):
                raise AudioProcessingError("INFERENCE")
            probability = float(output[0, 0])
            if not math.isfinite(probability) or not 0 <= probability <= 1:
                raise AudioProcessingError("INFERENCE")
            self._state = state.copy()
            self._context = samples[-64:].reshape(1, 64).copy()
        except AudioProcessingError as error:
            category = error.category
        except MemoryError:
            category = "RESOURCE"
        except Exception:
            category = "TIMEOUT" if time.monotonic() >= self._deadline else "INFERENCE"
        finally:
            self._lock.release()
        if category is not None:
            self._closed = True
            raise AudioProcessingError(category)
        return probability

    def close(self) -> None:
        self._closed = True
        self._options.terminate = True
        self._session = None


class SileroVadBackend:
    """One worker-owned session; bounded streams never share recurrent/context state."""

    backend = "onnxruntime-cpu"
    frame_samples = 512
    inference_threads = 1

    def __init__(self, settings: Settings, session, ort, digest: str):
        self.model_id = settings.audio_vad_model_id
        self.model_version = settings.audio_vad_model_version
        self.model_sha256 = digest
        self.max_concurrent_recordings = settings.audio_vad_max_concurrent_recordings
        self._session = session
        self._ort = ort
        self._slots = threading.BoundedSemaphore(self.max_concurrent_recordings)
        self._lock = threading.Lock()
        self._streams: set[_SileroStream] = set()

    @classmethod
    def from_settings(cls, settings: Settings) -> "SileroVadBackend":
        category = None
        descriptor = None
        try:
            path = settings.audio_vad_model_path
            if path is None:
                raise AudioProcessingError("MODEL_UNAVAILABLE")
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or not before.st_mode & 0o444 or before.st_size <= 0:
                raise AudioProcessingError("MODEL_UNAVAILABLE")
            if before.st_size > settings.audio_vad_model_max_bytes:
                raise AudioProcessingError("RESOURCE")
            # Load verified bytes, not a path that could change between hashing and
            # session construction. External-tensor models are intentionally unsupported.
            with os.fdopen(descriptor, "rb") as model:
                descriptor = None
                content = model.read(settings.audio_vad_model_max_bytes + 1)
                after = os.fstat(model.fileno())
            if len(content) > settings.audio_vad_model_max_bytes:
                raise AudioProcessingError("RESOURCE")
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(content) != before.st_size:
                raise AudioProcessingError("MODEL_UNAVAILABLE")
            digest = hashlib.sha256(content).hexdigest()
            if settings.audio_vad_model_sha256 is not None and digest != settings.audio_vad_model_sha256:
                raise AudioProcessingError("MODEL_UNAVAILABLE")

            import onnxruntime as ort

            if "CPUExecutionProvider" not in ort.get_available_providers():
                raise AudioProcessingError("MODEL_UNAVAILABLE")
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            options.log_severity_level = 4
            session = ort.InferenceSession(content, sess_options=options, providers=["CPUExecutionProvider"])
            session.disable_fallback()
            inputs = {node.name: node for node in session.get_inputs()}
            outputs = {node.name: node for node in session.get_outputs()}
            expected_inputs = {"input": ("tensor(float)", (1, 576)), "state": ("tensor(float)", (2, 1, 128)), "sr": ("tensor(int64)", ())}
            expected_outputs = {"output": ("tensor(float)", (1, 1)), "stateN": ("tensor(float)", (2, 1, 128))}
            for actual, expected in ((inputs, expected_inputs), (outputs, expected_outputs)):
                if actual.keys() != expected.keys() or any(
                    not _compatible_node(actual[name], name, dtype, shape)
                    for name, (dtype, shape) in expected.items()
                ):
                    raise AudioProcessingError("MODEL_UNAVAILABLE")
            if session.get_providers() != ["CPUExecutionProvider"]:
                raise AudioProcessingError("MODEL_UNAVAILABLE")
            return cls(settings, session, ort, digest)
        except AudioProcessingError as error:
            category = error.category
        except MemoryError:
            category = "RESOURCE"
        except Exception:
            category = "MODEL_UNAVAILABLE"
        finally:
            if descriptor is not None:
                os.close(descriptor)
        raise AudioProcessingError(category)

    @contextmanager
    def open_stream(self, *, deadline: float) -> Iterator[VadStream]:
        if not math.isfinite(deadline) or time.monotonic() >= deadline:
            raise AudioProcessingError("TIMEOUT")
        if not self._slots.acquire(blocking=False):
            raise AudioProcessingError("RESOURCE")
        stream = None
        timer = None
        category = None
        try:
            try:
                with self._lock:
                    if self._session is None:
                        raise AudioProcessingError("MODEL_UNAVAILABLE")
                    options = self._ort.RunOptions()
                    options.log_severity_level = 4
                    stream = _SileroStream(self._session, options, deadline)
                    self._streams.add(stream)
                # One watchdog per recording interrupts in-flight ORT calls;
                # no per-frame threads, queues, or background inference.
                timer = threading.Timer(max(0, deadline - time.monotonic()), lambda: setattr(options, "terminate", True))
                timer.daemon = True
                timer.start()
            except AudioProcessingError as error:
                category = error.category
            except (MemoryError, OSError):
                category = "RESOURCE"
            except Exception:
                category = "INFERENCE"
            if category is not None:
                raise AudioProcessingError(category)
            # infer() owns provider-error sanitization. Let body exceptions pass
            # through unchanged: contextlib would chain any replacement exception
            # to the original thrown into this generator, even outside a handler.
            yield stream
        finally:
            if timer is not None:
                timer.cancel()
                if timer.ident is not None:
                    timer.join()
            if stream is not None:
                stream.close()
                with self._lock:
                    self._streams.discard(stream)
            self._slots.release()

    def close(self) -> None:
        with self._lock:
            self._session = None
            for stream in self._streams:
                stream.close()


@asynccontextmanager
async def silero_vad_resource(settings: Settings) -> AsyncIterator[SileroVadBackend]:
    """Inject with a zero-argument factory into WorkerRuntime.resource_factories."""
    backend = SileroVadBackend.from_settings(settings)
    try:
        yield backend
    finally:
        backend.close()
