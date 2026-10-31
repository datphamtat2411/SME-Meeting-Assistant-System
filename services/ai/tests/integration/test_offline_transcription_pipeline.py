"""Deterministic composition tests: real processing stages, injected model providers."""

import asyncio
import json
import wave
from collections.abc import Mapping
from concurrent.futures import CancelledError
from contextlib import contextmanager
from dataclasses import FrozenInstanceError, fields, is_dataclass
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

import pytest

from sme_meeting_ai.audio import (
    AudioEvidenceDetector, AudioNormalizer, AudioProcessingError, AudioSource,
    NormalizedAudioArtifact, SampleInterval, SpeechEnergyEvidence, SpeechMapBuilder,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline import (
    AudioPreprocessingPipeline, OfflineTranscriptionPipeline,
    OfflineTranscriptionStage as Stage, OfflineTranscriptionStatus as Status,
    PreprocessingStage,
)
from sme_meeting_ai.transcription import chunk_execution, correction, coverage, reconciliation, recovery
from sme_meeting_ai.transcription.asr import (
    AsrCandidate, AsrError, AsrErrorCategory, AsrProvenance, AsrQualityMetadata,
    AsrSegment, AsrUsage,
)
from sme_meeting_ai.transcription.chunk_execution import AsrChunkResult
from sme_meeting_ai.transcription.chunk_planning import SpeechAwareAsrChunkPlanner
from sme_meeting_ai.transcription.correction import (
    CorrectionError, CorrectionErrorCategory, CorrectionProviderResponse,
)
from sme_meeting_ai.transcription.reconciliation import ReconciledSegment
from sme_meeting_ai.transcription.recovery import RecoveryStopReason

RAW = ("Dự án Alpha cần kiểm tra", "Nhóm Beta chuẩn bị báo cáo")
PRIVATE = "private-provider-diagnostic-and-prompt"


def walk(value):
    yield value
    if is_dataclass(value):
        for item in fields(value):
            yield from walk(getattr(value, item.name))
    elif isinstance(value, Mapping):
        for key, item in value.items():
            yield from walk(key)
            yield from walk(item)
    elif isinstance(value, (tuple, list)):
        for item in value:
            yield from walk(item)


def assert_safe(value):
    values = tuple(walk(value))
    assert not any(isinstance(item, (
        Path, NormalizedAudioArtifact, SpeechEnergyEvidence, AsrCandidate,
        AsrChunkResult, ReconciledSegment,
    )) for item in values)
    strings = " ".join(item for item in values if isinstance(item, str))
    assert PRIVATE not in strings
    assert not any(text in strings for text in RAW)


class Backend:
    model_id = "test-vad"
    model_version = "1"
    model_sha256 = "a" * 64
    backend = "injected"
    frame_samples = 512
    max_concurrent_recordings = 1
    inference_threads = 1

    def __init__(self, probability):
        self.probability = probability

    @contextmanager
    def open_stream(self, *, deadline):
        yield SimpleNamespace(infer=lambda samples: self.probability)


@pytest.fixture
def workflow(tmp_path, monkeypatch):
    resources = []

    def make(*, count=4096, probability=0.9, **overrides):
        root = tmp_path / f"run-{len(resources)}"
        root.mkdir()
        source = AudioSource("meeting-1", root / "private-original.media")
        source.path.write_bytes(b"original media remains recoverable")
        work = root / "work"
        work.mkdir()
        config = Settings(
            service_name="test-ai", service_identity="ai-core", _env_file=None,
            audio_temp_dir=work, audio_speech_map_boundary_padding_samples=0,
            audio_speech_map_merge_gap_samples=0, audio_asr_chunk_target_samples=2048,
            audio_asr_chunk_max_request_samples=2048, audio_asr_chunk_overlap_samples=0,
            audio_asr_chunk_boundary_search_samples=0, audio_asr_recovery_context_samples=128,
            transcript_correction_model=overrides.pop("transcript_correction_model", "test/corrector"),
            **overrides,
        )
        h = SimpleNamespace(
            source=source, work=work, settings=config, calls=[], asr_calls=[],
            correction_calls=0, artifacts=[], asr_callback=None, correction_callback=None,
            correction_ids=[],
        )
        resources.append(h)

        def runner(argv, **limits):
            if "-version" in argv:
                return b"ffmpeg version 7.1-test Copyright\n"
            if argv[0] == "ffprobe":
                return json.dumps({
                    "format": {"format_name": "wav", "duration": "0.256"},
                    "streams": [{"index": 0, "codec_type": "audio", "codec_name": "pcm_s16le",
                                 "sample_rate": "16000", "channels": 1, "channel_layout": "mono"}],
                }).encode()
            with wave.open(argv[-1], "wb") as output:
                output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                output.writeframes(b"\xa0\x0f" * count)
            return b""

        normalizer = AudioNormalizer(config, runner=runner)
        monkeypatch.setattr(normalizer, "_tool", lambda name: name)
        detector = AudioEvidenceDetector(config, Backend(probability))
        for obj, name in ((normalizer, "normalize"), (detector, "detect")):
            original = getattr(obj, name)

            def capture(*args, _original=original, **kwargs):
                artifact = _original(*args, **kwargs)
                h.artifacts.append(artifact)
                return artifact

            monkeypatch.setattr(obj, name, capture)
        h.preprocessing = AudioPreprocessingPipeline(normalizer, detector, SpeechMapBuilder(config))
        h.planner = SpeechAwareAsrChunkPlanner(config)

        class Transcriber:
            def transcribe(self, audio):
                h.asr_calls.append(audio.chunk_id)
                assert all(Path(a._temporary.name).exists() for a in h.artifacts[-2:])
                if h.asr_callback:
                    value = h.asr_callback(audio)
                    if value is not None:
                        return value
                text = RAW[int(audio.chunk_id[-6:]) % len(RAW)]
                return AsrCandidate(
                    text, (AsrSegment(Fraction(0), audio.duration, text),),
                    AsrQualityMetadata(confidence=0.95, language="vi"), AsrUsage(),
                    AsrProvenance("fake", "test/asr", inference_config=(
                        ("language", "vi"), ("temperature", 0.0), ("prompt", PRIVATE),
                    )), audio.chunk_id,
                )

            def close(self):
                pytest.fail("closed borrowed ASR provider")

        class Corrector:
            def complete(self, request):
                h.correction_calls += 1
                assert all(Path(a._temporary.name).exists() for a in h.artifacts[-2:])
                entries = json.loads(request.transcript_json)["segments"]
                h.correction_ids = [(e["segment_id"], e["ordinal"]) for e in entries]
                if h.correction_callback:
                    return h.correction_callback(request)
                for entry in entries:
                    entry["text"] += "."
                return CorrectionProviderResponse(
                    json.dumps({"segments": entries}, ensure_ascii=False),
                    "fake", request.model, "test/resolved-corrector",
                )

            def close(self):
                pytest.fail("closed borrowed correction provider")

        h.transcriber, h.corrector = Transcriber(), Corrector()
        return h

    yield make
    for h in resources:
        for artifact in reversed(h.artifacts):
            artifact._temporary.cleanup()


def pipeline(h):
    return OfflineTranscriptionPipeline(
        h.preprocessing, h.planner, h.transcriber, h.corrector, h.settings,
        pipeline_version="offline-test-1",
    )


def assert_released(h):
    assert list(h.work.iterdir()) == []
    assert h.source.path.read_bytes() == b"original media remains recoverable"


def spy_stages(h, monkeypatch):
    for obj, name, stage in (
        (h.preprocessing, "run", Stage.PREPROCESSING),
        (h.planner, "plan", Stage.CHUNK_PLANNING),
        (chunk_execution, "execute_asr_chunks", Stage.ASR),
        (recovery, "recover_speech", Stage.COVERAGE_RECOVERY),
        (reconciliation, "reconcile_transcript", Stage.RECONCILIATION),
        (correction, "correct_transcript", Stage.CORRECTION),
    ):
        original = getattr(obj, name)

        def call(*args, _original=original, _stage=stage, **kwargs):
            h.calls.append(_stage)
            return _original(*args, **kwargs)

        monkeypatch.setattr(obj, name, call)


def test_complete_order_timeline_quality_provenance_and_safe_immutable_evidence(workflow, monkeypatch, caplog):
    h = workflow()
    spy_stages(h, monkeypatch)
    assessments = []
    assess = coverage.assess_speech_coverage

    def assess_once(*args, **kwargs):
        assessments.append(True)
        return assess(*args, **kwargs)

    monkeypatch.setattr(coverage, "assess_speech_coverage", assess_once)
    monkeypatch.setattr(recovery, "assess_speech_coverage", assess_once)
    output = pipeline(h).run(h.source)
    assert output.status is Status.COMPLETED
    assert output.completed_stages == tuple(Stage) == tuple(h.calls)
    assert output.failure is None and output.warnings == ()
    assert output.result.source_id == h.source.source_id
    assert [s.interval for s in output.result.segments] == [SampleInterval(0, 2048), SampleInterval(2048, 4096)]
    assert [s.text for s in output.result.segments] == [text + "." for text in RAW]
    assert h.correction_ids == [("segment-000000", 0), ("segment-000001", 1)]
    assert output.result.segments[1].interval.start_time == Fraction(2048, 16000)
    assert output.result.quality.validated_segment_count == 2
    assert output.result.quality.changed_segment_count == 2
    assert output.evidence.coverage.quality.covered_speech_samples == 4096
    assert output.evidence.recovery.initial_assessment is output.evidence.recovery.final_assessment
    assert output.evidence.recovery.attempts == ()
    provenance = output.provenance
    assert provenance.pipeline_version == "offline-test-1"
    assert provenance.source_id == h.source.source_id and provenance.sample_rate_hz == 16000
    assert provenance.sample_count == 4096
    assert provenance.preprocessing == provenance.planning.preprocessing
    assert provenance.coverage == output.evidence.coverage.provenance
    assert provenance.recovery == output.evidence.recovery.provenance
    assert provenance.reconciliation == output.evidence.reconciliation.provenance
    assert provenance.correction == output.result.provenance
    assert output.evidence.provenance == provenance
    assert_safe(output.evidence)
    with pytest.raises(FrozenInstanceError):
        output.status = Status.FAILED
    with pytest.raises(TypeError):
        provenance.asr.effective_configuration["max_concurrent_chunks"] = 4
    assert h.asr_calls == ["chunk-000000", "chunk-000001"]
    assert h.correction_calls == 1
    assert assessments == [True]
    assert_released(h)
    assert not caplog.records


def test_warning_partial_asr_terminal_recovery_and_unresolved_survive_correction(workflow, caplog):
    h = workflow(probability=0.5)

    def fail(audio):
        if audio.chunk_id != "chunk-000000":
            raise AsrError(AsrErrorCategory.AUTHENTICATION)

    h.asr_callback = fail
    output = pipeline(h).run(h.source)
    assert output.status is Status.COMPLETED_WITH_WARNINGS
    assert output.completed_stages == tuple(Stage)
    assert output.evidence.recovery.stop_reason is RecoveryStopReason.TERMINAL_FAILURE
    assert len(output.evidence.recovery.attempts) == 1
    assert output.evidence.coverage.unresolved_intervals
    assert output.result.coverage == output.evidence.coverage
    assert output.evidence.reconciliation.unresolved_intervals == (SampleInterval(2048, 4096),)
    assert {w.stage for w in output.warnings} == {
        Stage.PREPROCESSING, Stage.ASR, Stage.COVERAGE_RECOVERY, Stage.RECONCILIATION, Stage.CORRECTION,
    }
    assert output.warnings == output.evidence.warnings
    assert_safe(output.evidence)
    assert_released(h)
    assert not caplog.records


def test_failed_baseline_remains_and_recovery_reaches_reconciliation(workflow):
    h = workflow()

    def fail_one(audio):
        if audio.chunk_id == "chunk-000001":
            raise AsrError(AsrErrorCategory.TIMEOUT)

    h.asr_callback = fail_one
    output = pipeline(h).run(h.source)
    assert output.status is Status.COMPLETED_WITH_WARNINGS
    assert output.evidence.recovery.initial_assessment.quality.failed_chunk_count == 1
    assert output.evidence.coverage.quality.covered_speech_samples == 4096
    assert output.evidence.coverage.unresolved_intervals == ()
    outcomes = output.evidence.reconciliation.chunk_outcomes
    assert outcomes[1].failure is AsrErrorCategory.TIMEOUT
    assert any(o.chunk_id.startswith("recovery-") for o in outcomes)
    assert any(any(identity.startswith("recovery-") for identity in s.source_chunk_ids)
               for s in output.result.segments)
    assert h.asr_calls.count("chunk-000000") == h.asr_calls.count("chunk-000001") == 1
    assert h.correction_calls == 1
    assert_released(h)


@pytest.mark.parametrize("stage", list(Stage))
def test_stage_failure_stops_downstream_preserves_prior_safe_evidence(workflow, monkeypatch, caplog, stage):
    h = workflow()
    targets = {
        Stage.PREPROCESSING: (h.preprocessing, "run"),
        Stage.CHUNK_PLANNING: (h.planner, "plan"),
        Stage.ASR: (chunk_execution, "execute_asr_chunks"),
        Stage.COVERAGE_RECOVERY: (recovery, "recover_speech"),
        Stage.RECONCILIATION: (reconciliation, "reconcile_transcript"),
        Stage.CORRECTION: (correction, "correct_transcript"),
    }

    def fail(*args, **kwargs):
        raise RuntimeError(PRIVATE)

    obj, name = targets[stage]
    monkeypatch.setattr(obj, name, fail)
    spy_stages(h, monkeypatch)
    output = pipeline(h).run(h.source)
    index = list(Stage).index(stage)
    assert output.status is Status.FAILED and output.result is None
    assert output.failure.stage is stage
    assert output.completed_stages == tuple(Stage)[:index]
    assert h.calls == list(Stage)[:index + 1]
    assert (output.evidence.audio_metadata is not None) == (index > 0)
    assert (output.evidence.chunk_plan is not None) == (index > 1)
    assert (output.evidence.asr is not None) == (index > 2)
    assert (output.evidence.recovery is not None) == (index > 3)
    assert (output.evidence.reconciliation is not None) == (index > 4)
    assert_safe(output)
    assert_released(h)
    assert not caplog.records


def test_partial_preprocessing_failure_preserves_validated_normalization(workflow, monkeypatch):
    h = workflow()

    def fail(*args, **kwargs):
        raise AudioProcessingError("INFERENCE")

    monkeypatch.setattr(h.preprocessing._detector, "detect", fail)
    output = pipeline(h).run(h.source)
    assert output.status is Status.FAILED
    assert output.failure.stage is Stage.PREPROCESSING
    assert output.failure.category == "INFERENCE"
    assert output.completed_stages == ()
    assert output.evidence.preprocessing_completed_stages == (PreprocessingStage.NORMALIZATION,)
    assert output.evidence.audio_metadata.sample_count == 4096
    assert output.provenance.preprocessing.normalization is not None
    assert output.provenance.preprocessing.detection is None
    assert not h.asr_calls and not h.correction_calls
    assert_safe(output)
    assert_released(h)


@pytest.mark.parametrize("error,category", [
    (AudioProcessingError("VALIDATION"), "VALIDATION"),
    (AsrError(AsrErrorCategory.TRANSPORT), "TRANSPORT"),
    (CorrectionError(CorrectionErrorCategory.AUTHENTICATION), "AUTHENTICATION"),
    (TimeoutError(PRIVATE), "TIMEOUT"), (OSError(PRIVATE), "RESOURCE"),
])
def test_known_operation_failures_are_category_only(workflow, monkeypatch, error, category):
    h = workflow()

    def fail(*args, **kwargs):
        raise error

    monkeypatch.setattr(recovery, "recover_speech", fail)
    output = pipeline(h).run(h.source)
    assert output.status is Status.FAILED
    assert output.failure.stage is Stage.COVERAGE_RECOVERY
    assert output.failure.category == category
    assert output.provenance.asr is not None
    assert_safe(output)
    assert_released(h)


@pytest.mark.parametrize("kind,category,attempts", [
    ("malformed", "MALFORMED_OUTPUT", 2), ("timeout", "TIMEOUT", 2),
    ("provider", "PROVIDER", 1), ("configuration", "CONFIGURATION", 0),
])
def test_correction_failure_is_bounded_and_never_promotes_asr(workflow, caplog, kind, category, attempts):
    h = workflow(**({"transcript_correction_model": None} if kind == "configuration" else {}))

    def fail(request):
        if kind == "timeout":
            raise CorrectionError(CorrectionErrorCategory.TIMEOUT)
        if kind == "provider":
            raise RuntimeError(PRIVATE)
        return CorrectionProviderResponse(PRIVATE, "fake", request.model)

    h.correction_callback = fail
    output = pipeline(h).run(h.source)
    assert output.status is Status.FAILED and output.result is None
    assert output.completed_stages == tuple(Stage)[:-1]
    assert output.failure.stage is Stage.CORRECTION
    assert output.failure.category == category and output.failure.attempts == attempts
    assert h.correction_calls == attempts
    assert output.provenance.correction is None
    assert output.evidence.reconciliation.segments
    assert_safe(output)
    assert_released(h)
    assert not caplog.records


def test_correction_failure_preserves_prior_warnings_and_unresolved_speech(workflow):
    h = workflow(probability=0.5)
    h.asr_callback = lambda audio: (_ for _ in ()).throw(AsrError(AsrErrorCategory.AUTHENTICATION))
    h.correction_callback = lambda request: (_ for _ in ()).throw(RuntimeError(PRIVATE))
    output = pipeline(h).run(h.source)
    assert output.status is Status.FAILED and output.result is None
    assert output.evidence.coverage.unresolved_intervals == (SampleInterval(0, 4096),)
    assert any(w.stage is Stage.PREPROCESSING for w in output.warnings)
    assert any(w.stage is Stage.COVERAGE_RECOVERY for w in output.warnings)
    assert_safe(output)
    assert_released(h)


@pytest.mark.parametrize("exception", [KeyboardInterrupt, asyncio.CancelledError, CancelledError])
@pytest.mark.parametrize("stage", ["asr", "correction"])
def test_cancellation_propagates_and_releases_owned_artifacts(workflow, exception, stage):
    h = workflow()
    cancellation = exception()

    def cancel(*args):
        raise cancellation

    if stage == "asr":
        h.asr_callback = cancel
    else:
        h.correction_callback = cancel
    with pytest.raises(exception) as caught:
        pipeline(h).run(h.source)
    assert caught.value is cancellation
    assert_released(h)


@pytest.mark.parametrize("cancel", [False, True])
def test_cleanup_errors_are_sanitized_and_do_not_mask_cancellation(workflow, monkeypatch, cancel, caplog):
    h = workflow()
    original = h.preprocessing.run

    def run(source):
        outcome = original(source)

        def bad_cleanup():
            raise OSError(PRIVATE)

        outcome._ownership.callback(bad_cleanup)
        return outcome

    monkeypatch.setattr(h.preprocessing, "run", run)
    if cancel:
        h.correction_callback = lambda request: (_ for _ in ()).throw(KeyboardInterrupt())
        with pytest.raises(KeyboardInterrupt):
            pipeline(h).run(h.source)
    else:
        output = pipeline(h).run(h.source)
        assert output.status is Status.FAILED
        assert output.failure.category == "RESOURCE"
        assert output.completed_stages == tuple(Stage)
        assert output.result is not None  # Validated correction survives cleanup failure.
        assert_safe(output.evidence)
    assert_released(h)
    assert not caplog.records


def test_empty_candidates_remain_unresolved_and_execution_is_deterministic(workflow):
    h = workflow(audio_asr_recovery_max_total_attempts=1)

    def empty(audio):
        return AsrCandidate("", (), AsrQualityMetadata(), AsrUsage(), AsrProvenance("fake", "test/asr"), audio.chunk_id)

    h.asr_callback = empty
    orchestrator = pipeline(h)
    first = orchestrator.run(h.source)
    first_calls = tuple(h.asr_calls)
    h.asr_calls.clear()
    second = orchestrator.run(h.source)
    assert first == second
    assert first_calls == tuple(h.asr_calls)
    assert len(first.evidence.recovery.attempts) == 1
    assert first.evidence.coverage.unresolved_intervals == (SampleInterval(0, 4096),)
    assert first.status is Status.COMPLETED_WITH_WARNINGS
    assert not first.result.segments
    assert first.warnings
    assert_released(h)


def test_settings_are_snapshotted_before_execution(workflow):
    h = workflow()
    orchestrator = pipeline(h)
    h.settings.transcript_correction_model = None
    h.settings.audio_asr_max_payload_bytes = 1
    output = orchestrator.run(h.source)
    assert output.status is Status.COMPLETED
    assert output.provenance.correction.requested_model == "test/corrector"
    assert_released(h)
