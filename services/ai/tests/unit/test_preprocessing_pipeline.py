import json
import math
import struct
import traceback
import wave
from contextlib import contextmanager
from dataclasses import FrozenInstanceError, replace
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

import pytest

from sme_meeting_ai.audio import (
    AudioErrorCategory,
    AudioEvidenceDetector,
    AudioNormalizer,
    AudioProcessingError,
    AudioSource,
    NormalizedAudioArtifact,
    SampleInterval,
    SpeechEnergyEvidence,
    SpeechMapBuilder,
    SpeechMapWarning,
    VadLabel,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline import (
    AudioPreprocessingPipeline,
    PreprocessingStage,
    PreprocessingStatus,
)


class Backend:
    model_id = "silero-test"
    model_version = "5-test"
    model_sha256 = "a" * 64
    backend = "injected-test-backend"
    frame_samples = 512
    max_concurrent_recordings = 1
    inference_threads = 1

    def __init__(self, probabilities):
        self.probabilities = probabilities
        self.closed = 0

    @contextmanager
    def open_stream(self, *, deadline):
        assert math.isfinite(deadline)
        probabilities = iter(self.probabilities)
        try:
            yield SimpleNamespace(infer=lambda samples: next(probabilities))
        finally:
            self.closed += 1


@pytest.fixture
def workflow(tmp_path, monkeypatch):
    resources = []

    def make(probabilities=(0.1, 0.9, 0.9), samples=None):
        source = AudioSource("recording-1", tmp_path / "private-cuoc-hop.media")
        source.path.write_bytes(b"original meeting media must remain recoverable")
        work = tmp_path / f"work-{len(resources)}"
        work.mkdir()
        settings = Settings(
            service_name="test-ai", service_identity="ai-core", _env_file=None,
            audio_temp_dir=work, audio_speech_map_boundary_padding_samples=10,
            audio_speech_map_merge_gap_samples=0,
        )
        if samples is None:
            samples = [0] * 512 + [4000] * 519

        def runner(argv, **limits):
            assert limits["timeout_seconds"] > 0
            if "-version" in argv:
                return b"ffmpeg version 7.1-test Copyright\n"
            if argv[0] == "ffprobe":
                original = argv[-1].startswith("/proc/self/fd/")
                return json.dumps({
                    "format": {"format_name": "wav", "duration": "0.1"},
                    "streams": [{
                        "index": 0, "codec_type": "audio", "codec_name": "pcm_s16le",
                        "sample_rate": "48000" if original else "16000",
                        "channels": 2 if original else 1,
                        "channel_layout": "stereo" if original else "mono",
                    }],
                }).encode()
            with wave.open(argv[-1], "wb") as output:
                output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                output.writeframes(struct.pack(f"<{len(samples)}h", *samples))
            return b""

        backend = Backend(probabilities)
        normalizer = AudioNormalizer(settings, runner=runner)
        monkeypatch.setattr(normalizer, "_tool", lambda name: name)
        detector = AudioEvidenceDetector(settings, backend)
        mapper = SpeechMapBuilder(settings)
        h = SimpleNamespace(
            source=source, settings=settings, work=work, backend=backend,
            normalizer=normalizer, detector=detector, mapper=mapper,
            calls=[], artifacts=[], samples=samples,
        )
        normalize, detect, build = normalizer.normalize, detector.detect, mapper.build

        def normalize_spy(source):
            h.calls.append(("normalization", source))
            artifact = normalize(source)
            h.artifacts.append(artifact)
            resources.append(artifact)
            return artifact

        def detect_spy(source, *, expected_sample_count):
            h.calls.append(("detection", source, expected_sample_count))
            evidence = detect(source, expected_sample_count=expected_sample_count)
            h.artifacts.append(evidence)
            resources.append(evidence)
            return evidence

        def build_spy(audio, evidence):
            h.calls.append(("speech_map", audio, evidence))
            return build(audio, evidence)

        monkeypatch.setattr(normalizer, "normalize", normalize_spy)
        monkeypatch.setattr(detector, "detect", detect_spy)
        monkeypatch.setattr(mapper, "build", build_spy)
        h.pipeline = AudioPreprocessingPipeline(normalizer, detector, mapper, pipeline_version="test-2")
        return h

    yield make
    for artifact in reversed(resources):
        artifact._temporary.cleanup()


def test_order_normalized_handoff_exact_complete_audio_and_provenance(workflow):
    h = workflow()
    original = h.source.path.read_bytes()
    with h.pipeline.run(h.source) as outcome:
        assert outcome.status == PreprocessingStatus.COMPLETED
        assert outcome.completed_stages == tuple(PreprocessingStage)
        assert outcome.failure is None
        assert outcome.partial_artifacts == ()
        result = outcome.result
        audio, evidence = h.artifacts
        assert h.calls == [
            ("normalization", h.source),
            ("detection", AudioSource(h.source.source_id, audio.path), 1031),
            ("speech_map", audio, evidence),
        ]
        assert audio.path != h.source.path
        assert result.normalized_artifact is audio
        assert result.speech_evidence is evidence
        with wave.open(str(audio.path), "rb") as decoded:
            assert decoded.readframes(1032) == struct.pack("<1031h", *h.samples)
        metadata = result.audio_metadata
        assert metadata.source_metadata == audio.source_metadata
        assert (metadata.source_metadata.sample_rate_hz, metadata.source_metadata.channels) == (48000, 2)
        assert (metadata.sample_count, metadata.sample_rate_hz, metadata.channels, metadata.sample_format) == (1031, 16000, 1, "s16")
        assert metadata.duration == Fraction(1031, 16000)
        assert (metadata.start_sample, metadata.end_sample) == (0, 1031)
        assert (metadata.start_time, metadata.end_time) == (Fraction(0), metadata.duration)
        assert outcome.audio_metadata == metadata
        assert result.speech_map.speech_intervals == (SampleInterval(512, 1031),)
        assert result.speech_map.protected_intervals == (SampleInterval(502, 1031),)
        assert result.speech_map.speech_intervals[0].start_time == Fraction(512, 16000)
        frames = list(evidence.iter_frames())
        assert list(evidence.iter_frames()) == frames
        assert frames[-1].end_sample == 1031
        assert frames[-1].padding_samples == 505
        provenance = result.provenance
        assert outcome.provenance == provenance
        assert (provenance.pipeline_version, provenance.source_id) == ("test-2", h.source.source_id)
        assert (provenance.sample_count, provenance.sample_rate_hz) == (1031, 16000)
        assert provenance.normalization == audio.provenance
        assert provenance.normalization.decoder_version == "7.1-test"
        assert provenance.detection == evidence.provenance
        assert provenance.detection.model_sha256 == h.backend.model_sha256
        assert provenance.detection.backend == h.backend.backend
        assert provenance.speech_map == result.speech_map.provenance
        assert provenance.effective_configuration["normalization"]["decode_timeout_seconds"] == h.settings.audio_decode_timeout_seconds
        assert provenance.effective_configuration["detection"]["speech_threshold"] == h.settings.audio_vad_speech_threshold
        assert provenance.effective_configuration["detection"]["evidence_max_bytes"] == h.settings.audio_evidence_max_bytes
        assert provenance.effective_configuration["speech_map"]["boundary_padding_samples"] == 10
        with pytest.raises(TypeError):
            provenance.effective_configuration["detection"]["speech_threshold"] = 0
        with pytest.raises(FrozenInstanceError):
            outcome.status = PreprocessingStatus.FAILED
    outcome.close()
    assert not audio.path.exists()
    assert not evidence._path.exists()
    assert list(h.work.iterdir()) == []
    assert h.source.path.read_bytes() == original
    assert h.backend.closed == 1


def test_valid_silence_is_success_with_empty_map(workflow):
    h = workflow((0.1, 0.1, 0.1), [0] * 1031)
    with h.pipeline.run(h.source) as outcome:
        assert outcome.status == PreprocessingStatus.COMPLETED
        assert outcome.result.warnings == ()
        assert outcome.result.speech_map.speech_intervals == ()
        assert outcome.result.speech_map.protected_intervals == ()
        assert outcome.result.speech_map.uncertain_intervals == ()
        assert outcome.result.speech_evidence.likely_non_speech_frame_count == 3


def test_uncertainty_and_high_energy_non_speech_remain_warnings(workflow):
    h = workflow((0.1, 0.45, 0.1), [0] * 512 + [10000] * 519)
    with h.pipeline.run(h.source) as outcome:
        assert outcome.status == PreprocessingStatus.COMPLETED_WITH_WARNINGS
        result = outcome.result
        assert result.warnings == result.speech_map.quality.warnings
        assert result.warnings == (
            SpeechMapWarning.UNCERTAIN_VAD,
            SpeechMapWarning.VAD_ENERGY_DISAGREEMENT,
            SpeechMapWarning.HIGH_ENERGY_NON_SPEECH,
        )
        assert result.speech_map.speech_intervals == ()
        assert result.speech_map.uncertain_intervals == (SampleInterval(512, 1031),)
        assert [frame.vad_label for frame in result.speech_evidence.iter_frames()] == [
            VadLabel.LIKELY_NON_SPEECH, VadLabel.UNCERTAIN, VadLabel.LIKELY_NON_SPEECH,
        ]


@pytest.mark.parametrize("stage", list(PreprocessingStage))
@pytest.mark.parametrize("category", list(AudioErrorCategory))
def test_stage_failures_preserve_category_partial_metadata_and_ownership(
    workflow, monkeypatch, stage, category,
):
    h = workflow()
    target, method = {
        PreprocessingStage.NORMALIZATION: (h.normalizer, "normalize"),
        PreprocessingStage.DETECTION: (h.detector, "detect"),
        PreprocessingStage.SPEECH_MAP: (h.mapper, "build"),
    }[stage]

    def fail(*args, **kwargs):
        h.calls.append((stage.value,))
        raise AudioProcessingError(category)

    monkeypatch.setattr(target, method, fail)
    completed = tuple(PreprocessingStage)[:list(PreprocessingStage).index(stage)]
    with h.pipeline.run(h.source) as outcome:
        assert outcome.status == PreprocessingStatus.FAILED
        assert outcome.result is None
        assert outcome.failure.stage == stage
        assert outcome.failure.category == category
        assert outcome.completed_stages == completed
        assert [call[0] for call in h.calls] == [item.value for item in (*completed, stage)]
        assert outcome.partial_artifacts == tuple(h.artifacts)
        assert all(artifact._temporary is not None for artifact in outcome.partial_artifacts)
        assert outcome.audio_metadata is not None if completed else outcome.audio_metadata is None
        assert (outcome.provenance.normalization is not None) == bool(completed)
        assert (outcome.provenance.detection is not None) == (len(completed) == 2)
        assert outcome.provenance.speech_map is None
        assert "private-" not in repr(outcome)
    assert list(h.work.iterdir()) == []
    assert h.source.path.exists()


@pytest.mark.parametrize("stage,exception,category", [
    (PreprocessingStage.NORMALIZATION, RuntimeError, "DECODING"),
    (PreprocessingStage.DETECTION, RuntimeError, "INFERENCE"),
    (PreprocessingStage.SPEECH_MAP, RuntimeError, "VALIDATION"),
    (PreprocessingStage.NORMALIZATION, OSError, "RESOURCE"),
    (PreprocessingStage.DETECTION, MemoryError, "RESOURCE"),
    (PreprocessingStage.SPEECH_MAP, TimeoutError, "TIMEOUT"),
])
def test_unexpected_exceptions_are_sanitized(workflow, monkeypatch, stage, exception, category):
    h = workflow()
    target, method = {
        PreprocessingStage.NORMALIZATION: (h.normalizer, "normalize"),
        PreprocessingStage.DETECTION: (h.detector, "detect"),
        PreprocessingStage.SPEECH_MAP: (h.mapper, "build"),
    }[stage]

    def fail(*args, **kwargs):
        raise exception(f"{h.source.path}: secret provider payload, stderr, token")

    monkeypatch.setattr(target, method, fail)
    with h.pipeline.run(h.source) as outcome:
        assert outcome.result is None
        assert outcome.failure.stage == stage
        assert outcome.failure.category == category
        assert set(vars(outcome.failure)) == {"stage", "category"}
        assert "private-" not in repr(outcome)
        assert "secret" not in repr(outcome)


@pytest.mark.parametrize("mutation", [
    lambda a: replace(a, source_id="other"),
    lambda a: replace(a, source_metadata=replace(a.source_metadata, source_id="other")),
    lambda a: replace(a, provenance=replace(a.provenance, source_id="other")),
    lambda a: replace(a, sample_count=-1),
    lambda a: replace(a, sample_count=True),
    lambda a: replace(a, provenance=replace(a.provenance, decoder_version="")),
    lambda a: replace(a, provenance=replace(a.provenance, target_format={"sample_rate_hz": 8000})),
])
def test_normalization_contract_failure_stops_detection(workflow, monkeypatch, mutation):
    h = workflow()
    normalize = h.normalizer.normalize
    monkeypatch.setattr(h.normalizer, "normalize", lambda source: mutation(normalize(source)))
    with h.pipeline.run(h.source) as outcome:
        assert outcome.failure.stage == PreprocessingStage.NORMALIZATION
        assert outcome.failure.category == "VALIDATION"
        assert outcome.completed_stages == ()
        assert outcome.result is None
        assert len(outcome.partial_artifacts) == 1
        assert len(h.calls) == 1
    assert list(h.work.iterdir()) == []


@pytest.mark.parametrize("mutation", [
    lambda e: replace(e, source_id="other"),
    lambda e: replace(e, sample_count=1032),
    lambda e: replace(e, frame_count=4),
    lambda e: replace(e, likely_speech_frame_count=0),
    lambda e: replace(e, provenance=replace(e.provenance, model_id="")),
    lambda e: replace(e, provenance=replace(e.provenance, effective_configuration={})),
])
def test_detection_contract_failure_stops_mapping(workflow, monkeypatch, mutation):
    h = workflow()
    detect = h.detector.detect
    monkeypatch.setattr(h.detector, "detect", lambda *a, **kw: mutation(detect(*a, **kw)))
    with h.pipeline.run(h.source) as outcome:
        assert outcome.failure.stage == PreprocessingStage.DETECTION
        assert outcome.failure.category == "VALIDATION"
        assert outcome.completed_stages == (PreprocessingStage.NORMALIZATION,)
        assert outcome.result is None
        assert len(outcome.partial_artifacts) == 2
        assert len(h.calls) == 2
    assert list(h.work.iterdir()) == []


@pytest.mark.parametrize("damage", ["truncate", "trailing", "missing", "frame-counts"])
def test_evidence_replay_failure_never_publishes_success(workflow, monkeypatch, damage):
    h = workflow()
    build = h.mapper.build

    def damaged_build(audio, evidence):
        if damage == "truncate":
            evidence._path.write_bytes(evidence._path.read_bytes()[:-1])
        elif damage == "trailing":
            evidence._path.write_bytes(evidence._path.read_bytes() + b"extra")
        elif damage == "missing":
            evidence._path.unlink()
        else:
            evidence = replace(evidence, likely_speech_frame_count=1, likely_non_speech_frame_count=2)
        return build(audio, evidence)

    monkeypatch.setattr(h.mapper, "build", damaged_build)
    with h.pipeline.run(h.source) as outcome:
        assert outcome.status == PreprocessingStatus.FAILED
        assert outcome.result is None
        assert outcome.failure.stage == PreprocessingStage.SPEECH_MAP
        assert outcome.failure.category == ("VALIDATION" if damage == "frame-counts" else "RESOURCE")
        assert len(outcome.partial_artifacts) == 2
    assert list(h.work.iterdir()) == []


@pytest.mark.parametrize("mutation", [
    lambda m: None,
    lambda m: replace(m, provenance=replace(m.provenance, source_id="other")),
    lambda m: replace(m, provenance=replace(m.provenance, sample_count=999)),
    lambda m: replace(m, provenance=replace(m.provenance, mapper_version="")),
    lambda m: replace(m, provenance=replace(m.provenance, detector_provenance=replace(m.provenance.detector_provenance, model_id="other"))),
    lambda m: replace(m, speech_intervals=(SampleInterval(512, 1032),)),
    lambda m: replace(m, uncertain_intervals=(SampleInterval(500, 600), SampleInterval(400, 450))),
    lambda m: replace(m, protected_intervals=()),
    lambda m: replace(m, quality=replace(m.quality, frame_count=4)),
    lambda m: replace(m, quality=replace(m.quality, weak_speech_frame_count=-1)),
    lambda m: replace(m, quality=replace(m.quality, vad_energy_disagreement_frame_count=1)),
])
def test_malformed_map_outputs_fail_final_contract(workflow, monkeypatch, mutation):
    h = workflow()
    build = h.mapper.build
    monkeypatch.setattr(h.mapper, "build", lambda *args: mutation(build(*args)))
    with h.pipeline.run(h.source) as outcome:
        assert outcome.status == PreprocessingStatus.FAILED
        assert outcome.result is None
        assert outcome.failure.stage == PreprocessingStage.SPEECH_MAP
        assert outcome.failure.category == "VALIDATION"
        assert outcome.completed_stages == (PreprocessingStage.NORMALIZATION, PreprocessingStage.DETECTION)
        assert outcome.provenance.speech_map is None


@pytest.mark.parametrize("failed", [False, True])
def test_cleanup_closes_evidence_before_audio_even_after_failure(workflow, monkeypatch, failed):
    h = workflow()
    closed = []
    for artifact_type in (NormalizedAudioArtifact, SpeechEnergyEvidence):
        close = artifact_type.close

        def tracked_close(artifact, close=close):
            closed.append(type(artifact))
            close(artifact)

        monkeypatch.setattr(artifact_type, "close", tracked_close)
    if failed:
        def fail(*args):
            raise AudioProcessingError("INFERENCE")
        monkeypatch.setattr(h.mapper, "build", fail)
    with h.pipeline.run(h.source):
        assert closed == []
    assert closed == [SpeechEnergyEvidence, NormalizedAudioArtifact]
    assert list(h.work.iterdir()) == []


def test_cleanup_error_is_sanitized_resource_and_other_artifacts_still_close(workflow, monkeypatch):
    h = workflow()
    outcome = h.pipeline.run(h.source)
    close = SpeechEnergyEvidence.close

    def bad_close(evidence):
        close(evidence)
        raise OSError(f"{h.source.path}: provider payload")

    monkeypatch.setattr(SpeechEnergyEvidence, "close", bad_close)
    with pytest.raises(AudioProcessingError) as caught:
        outcome.close()
    assert caught.value.category == "RESOURCE"
    assert caught.value.__context__ is None
    assert "private-" not in "".join(traceback.format_exception(caught.value))
    assert list(h.work.iterdir()) == []
    assert h.source.path.exists()


def test_context_body_failure_and_interrupted_stage_release_resources(workflow, monkeypatch):
    h = workflow()
    with pytest.raises(RuntimeError, match="caller"):
        with h.pipeline.run(h.source):
            raise RuntimeError("caller")
    assert list(h.work.iterdir()) == []

    def interrupted(*args):
        raise KeyboardInterrupt

    monkeypatch.setattr(h.mapper, "build", interrupted)
    with pytest.raises(KeyboardInterrupt):
        h.pipeline.run(h.source)
    assert list(h.work.iterdir()) == []


def test_artifact_alias_to_original_is_resource_failure_and_original_is_preserved(workflow, monkeypatch):
    h = workflow()
    original = h.source.path.read_bytes()
    normalize = h.normalizer.normalize
    monkeypatch.setattr(h.normalizer, "normalize", lambda s: replace(normalize(s), path=s.path))
    with h.pipeline.run(h.source) as outcome:
        assert outcome.result is None
        assert outcome.failure.stage == PreprocessingStage.NORMALIZATION
        assert outcome.failure.category == "RESOURCE"
        assert len(h.calls) == 1
    assert list(h.work.iterdir()) == []
    assert h.source.path.read_bytes() == original
