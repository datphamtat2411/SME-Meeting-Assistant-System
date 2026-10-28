import asyncio
import hashlib
import sys
import time
import traceback
from types import SimpleNamespace

import numpy as np
import pytest

from sme_meeting_ai.audio import AudioProcessingError, SileroVadBackend
from sme_meeting_ai.audio.vad import silero_vad_resource
from sme_meeting_ai.core.config import Settings


def node(name, dtype, shape):
    return SimpleNamespace(name=name, type=dtype, shape=shape)


class FakeSession:
    inputs = [node("input", "tensor(float)", [None, None]), node("state", "tensor(float)", [2, None, 128]), node("sr", "tensor(int64)", [])]
    outputs = [node("output", "tensor(float)", [None, 1]), node("stateN", "tensor(float)", [None, None, None])]

    def __init__(self):
        self.calls = []
        self.failure = None
        self.probability = np.array([[0.75]], dtype=np.float32)
        self.next_state = None

    def get_inputs(self):
        return self.inputs

    def get_outputs(self):
        return self.outputs

    def get_providers(self):
        return ["CPUExecutionProvider"]

    def disable_fallback(self):
        pass

    def run(self, outputs, feeds, run_options):
        self.calls.append({key: value.copy() for key, value in feeds.items()})
        if self.failure:
            raise self.failure
        return [self.probability, self.next_state if self.next_state is not None else feeds["state"] + 1]


@pytest.fixture
def model(tmp_path, monkeypatch):
    path = tmp_path / "private-model.onnx"
    path.write_bytes(b"deterministic-model-bytes")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        audio_vad_model_path=path, audio_vad_model_sha256=digest,
    )
    session = FakeSession()
    created = []

    def make_session(content, sess_options, providers):
        created.append((content, sess_options, providers))
        return session

    ort = SimpleNamespace(
        SessionOptions=SimpleNamespace, RunOptions=lambda: SimpleNamespace(terminate=False),
        ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"),
        InferenceSession=make_session,
        get_available_providers=lambda: ["CPUExecutionProvider"],
    )
    monkeypatch.setitem(sys.modules, "onnxruntime", ort)
    return settings, session, created, ort


def assert_failure(call, category):
    with pytest.raises(AudioProcessingError) as caught:
        call()
    assert caught.value.category == category
    assert "private-" not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None


def test_cpu_session_model_digest_contract_and_recording_state(model):
    settings, session, created, _ = model
    backend = SileroVadBackend.from_settings(settings)
    assert len(created) == 1
    content, options, providers = created[0]
    assert content == b"deterministic-model-bytes"
    assert providers == ["CPUExecutionProvider"]
    assert options.intra_op_num_threads == options.inter_op_num_threads == 1
    assert options.execution_mode == "sequential"
    assert backend.model_sha256 == settings.audio_vad_model_sha256
    assert backend.model_id == settings.audio_vad_model_id
    assert backend.model_version == settings.audio_vad_model_version
    assert backend.frame_samples == 512
    samples = np.linspace(-1, 1, 512, dtype=np.float32)
    for _ in range(2):
        with backend.open_stream(deadline=time.monotonic() + 30) as stream:
            assert stream.infer(samples) == 0.75
            assert stream.infer(samples) == 0.75
    assert len(created) == 1
    for first, second in (session.calls[:2], session.calls[2:]):
        assert first["input"].shape == (1, 576)
        assert first["input"].dtype == np.float32
        assert first["state"].shape == (2, 1, 128)
        assert np.all(first["state"] == 0)
        assert np.all(second["state"] == 1)
        assert np.all(first["input"][:, :64] == 0)
        np.testing.assert_array_equal(first["input"][0, 64:], samples)
        np.testing.assert_array_equal(second["input"][0, :64], samples[-64:])
        assert first["sr"].shape == ()
        assert first["sr"].dtype == np.int64
        assert first["sr"] == 16000
    backend.close()
    assert_failure(lambda: backend.open_stream(deadline=time.monotonic() + 30).__enter__(), "MODEL_UNAVAILABLE")


@pytest.mark.parametrize("kind,category", [
    ("unset", "MODEL_UNAVAILABLE"), ("missing", "MODEL_UNAVAILABLE"),
    ("digest", "MODEL_UNAVAILABLE"), ("oversize", "RESOURCE"),
    ("provider", "MODEL_UNAVAILABLE"), ("import", "MODEL_UNAVAILABLE"),
    ("invalid-model", "MODEL_UNAVAILABLE"),
])
def test_model_and_provider_failures_are_explicit_without_downloads(model, monkeypatch, kind, category):
    settings, _, created, ort = model
    if kind == "unset":
        settings = settings.model_copy(update={"audio_vad_model_path": None})
    elif kind == "missing":
        settings = settings.model_copy(update={"audio_vad_model_path": settings.audio_vad_model_path.with_name("private-missing")})
    elif kind == "digest":
        settings = settings.model_copy(update={"audio_vad_model_sha256": "0" * 64})
    elif kind == "oversize":
        settings = settings.model_copy(update={"audio_vad_model_max_bytes": 1})
    elif kind == "provider":
        ort.get_available_providers = lambda: []
    elif kind == "import":
        monkeypatch.setitem(sys.modules, "onnxruntime", None)
    else:
        def fail(*args, **kwargs):
            raise RuntimeError("private-model-error")
        ort.InferenceSession = fail
    assert_failure(lambda: SileroVadBackend.from_settings(settings), category)
    assert not created


@pytest.mark.parametrize("contract", [
    "input-name", "input-type", "input-rank", "input-width", "state-shape", "sr-type", "output-name", "output-type", "output-shape", "state-output-shape", "non-cpu",
])
def test_rejects_incompatible_model_contract_before_inference(model, contract):
    settings, session, _, _ = model
    session.inputs = [node(n.name, n.type, list(n.shape)) for n in session.inputs]
    session.outputs = [node(n.name, n.type, list(n.shape)) for n in session.outputs]
    if contract == "non-cpu":
        session.get_providers = lambda: ["CUDAExecutionProvider"]
    elif contract == "input-name":
        session.inputs[0].name = "private-wrong-input"
    elif contract == "input-type":
        session.inputs[0].type = "tensor(double)"
    elif contract == "input-rank":
        session.inputs[0].shape = [512]
    elif contract == "input-width":
        session.inputs[0].shape = [1, 512]
    elif contract == "state-shape":
        session.inputs[1].shape = [2, 1, 64]
    elif contract == "sr-type":
        session.inputs[2].type = "tensor(float)"
    elif contract == "output-name":
        session.outputs[0].name = "private-other-output"
    elif contract == "output-type":
        session.outputs[0].type = "tensor(double)"
    elif contract == "output-shape":
        session.outputs[0].shape = [1, 2]
    else:
        session.outputs[1].shape = [2, 1, 64]
    assert_failure(lambda: SileroVadBackend.from_settings(settings), "MODEL_UNAVAILABLE")
    assert not session.calls


@pytest.mark.parametrize("invalid", ["nan", "inf", "negative", "over", "shape", "state-nan", "state-shape", "exception"])
def test_invalid_inference_output_is_sanitized_and_releases_capacity(model, invalid):
    settings, session, _, _ = model
    backend = SileroVadBackend.from_settings(settings)
    if invalid in ("nan", "inf", "negative", "over"):
        value = {"nan": np.nan, "inf": np.inf, "negative": -0.1, "over": 1.1}[invalid]
        session.probability = np.array([[value]], dtype=np.float32)
    elif invalid == "shape":
        session.probability = np.array([0.5, 0.6], dtype=np.float32)
    elif invalid == "state-nan":
        session.next_state = np.full((2, 1, 128), np.nan, dtype=np.float32)
    elif invalid == "state-shape":
        session.next_state = np.zeros((2, 1, 64), dtype=np.float32)
    else:
        session.failure = RuntimeError("private-provider-payload")

    def run():
        with backend.open_stream(deadline=time.monotonic() + 30) as stream:
            stream.infer(np.zeros(512, dtype=np.float32))

    assert_failure(run, "INFERENCE")
    session.failure = None
    session.next_state = None
    session.probability = np.array([[0.75]], dtype=np.float32)
    run()
    backend.close()


def test_concurrency_limit_rejects_without_sharing_state(model):
    settings, _, _, _ = model
    backend = SileroVadBackend.from_settings(settings)
    with backend.open_stream(deadline=time.monotonic() + 30):
        assert_failure(lambda: backend.open_stream(deadline=time.monotonic() + 30).__enter__(), "RESOURCE")
    with backend.open_stream(deadline=time.monotonic() + 30):
        pass
    backend.close()


def test_two_recordings_have_independent_simultaneous_recurrent_state(model):
    settings, session, _, _ = model
    settings = settings.model_copy(update={"audio_vad_max_concurrent_recordings": 2})
    backend = SileroVadBackend.from_settings(settings)
    samples = np.ones(512, dtype=np.float32)
    with backend.open_stream(deadline=time.monotonic() + 30) as first:
        first.infer(samples)
        with backend.open_stream(deadline=time.monotonic() + 30) as second:
            second.infer(-samples)
            first.infer(samples)
            second.infer(-samples)
    assert [int(call["state"][0, 0, 0]) for call in session.calls] == [0, 0, 1, 1]
    assert np.all(session.calls[2]["input"][0, :64] == 1)
    assert np.all(session.calls[3]["input"][0, :64] == -1)
    backend.close()


def test_inflight_deadline_terminates_onnx_and_discards_stream(model):
    settings, session, _, _ = model
    backend = SileroVadBackend.from_settings(settings)

    def blocked(outputs, feeds, run_options):
        limit = time.monotonic() + 2
        while not run_options.terminate and time.monotonic() < limit:
            time.sleep(0.001)
        assert run_options.terminate
        raise RuntimeError("private-terminated-provider")

    session.run = blocked

    def run():
        with backend.open_stream(deadline=time.monotonic() + 0.02) as stream:
            stream.infer(np.zeros(512, dtype=np.float32))

    assert_failure(run, "TIMEOUT")
    backend.close()


def test_worker_owned_factory_loads_once_and_closes_without_entrypoint_wiring(model):
    settings, _, created, _ = model

    async def use_resource():
        async with silero_vad_resource(settings) as backend:
            assert len(created) == 1
            with backend.open_stream(deadline=time.monotonic() + 30):
                pass
        assert_failure(lambda: backend.open_stream(deadline=time.monotonic() + 30).__enter__(), "MODEL_UNAVAILABLE")

    asyncio.run(use_resource())
