"""Deterministic composition tests: real processing stages, injected model providers."""

import asyncio
import json
import math
import wave
from collections.abc import Mapping
from concurrent.futures import CancelledError
from contextlib import contextmanager
from dataclasses import FrozenInstanceError, fields, is_dataclass, replace
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from sme_meeting_ai.audio import (
    AudioEvidenceDetector,
    AudioNormalizer,
    AudioProcessingError,
    AudioSource,
    NormalizedAudioArtifact,
    SampleInterval,
    SpeechEnergyEvidence,
    SpeechMapBuilder,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline import (
    AudioPreprocessingPipeline,
    OfflineTranscriptionPipeline,
    PreprocessingStage,
)
from sme_meeting_ai.pipeline import (
    OfflineTranscriptionStage as Stage,
)
from sme_meeting_ai.pipeline import (
    OfflineTranscriptionStatus as Status,
)
from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
from sme_meeting_ai.transcription import (
    chunk_execution,
    correction,
    coverage,
    reconciliation,
    recovery,
)
from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrCapabilityStatus,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrProviderCapabilities,
    AsrQualityMetadata,
    AsrRoutingMode,
    AsrSegment,
    AsrTimestampMode,
    AsrUsage,
)
from sme_meeting_ai.transcription.chunk_execution import AsrChunkResult
from sme_meeting_ai.transcription.chunk_planning import SpeechAwareAsrChunkPlanner
from sme_meeting_ai.transcription.correction import (
    CorrectionError,
    CorrectionErrorCategory,
    CorrectionProviderResponse,
)
from sme_meeting_ai.transcription.reconciliation import (
    ReconciledSegment,
    ReconciliationFlag,
)
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

    def make(*, count=4096, probability=0.9, source_id="meeting-1", **overrides):
        root = tmp_path / f"run-{len(resources)}"
        root.mkdir()
        source = AudioSource(source_id, root / "private-original.media")
        source.path.write_bytes(b"original media remains recoverable")
        work = root / "work"
        work.mkdir()
        config = Settings(
            service_name="test-ai", service_identity="ai-core", _env_file=None,
            audio_temp_dir=work, audio_speech_map_boundary_padding_samples=0,
            audio_speech_map_merge_gap_samples=0, audio_asr_chunk_target_samples=2048,
            audio_asr_chunk_max_request_samples=2304, audio_asr_chunk_overlap_samples=256,
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
                ordinal = int(audio.chunk_id[-6:])
                left = 128 if audio.chunk_id.startswith("chunk-") and ordinal else 0
                right = 128 if audio.chunk_id.startswith("chunk-") and (ordinal + 1) * 2048 < count else 0
                return AsrCandidate(
                    text, (AsrSegment(Fraction(left, 16000), audio.duration - Fraction(right, 16000), text),),
                    AsrQualityMetadata(confidence=0.95, language="vi"), AsrUsage(),
                    AsrProvenance("openrouter", "openai/whisper-large-v3", inference_config=(
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
                entries = [{k: entry[k] for k in ("segment_id", "ordinal", "text")} for entry in entries]
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


def test_pipeline_budget_failure_explains_required_calls_without_partial_dispatch(workflow):
    h = workflow(audio_asr_max_total_calls=1)
    output = pipeline(h).run(h.source)
    assert output.status is Status.FAILED
    assert output.failure.stage is Stage.CHUNK_PLANNING
    assert output.failure.category == "RESOURCE"
    assert not h.asr_calls and not h.correction_calls
    envelope = output.provenance.strategy.resource_plan
    assert envelope.baseline_calls == 2 and envelope.maximum_calls == 18
    assert envelope.authorized_calls == 1
    assert_released(h)


def test_success_exposes_temporal_support_and_unverified_lexical_completeness(workflow):
    h = workflow()
    output = pipeline(h).run(h.source)
    summary = output.evidence.quality_summary
    assert summary.canonical_timestamp_support_samples == 4096
    assert summary.suspected_speech_samples == 0
    assert summary.lexical_completeness == "unverified"
    assert summary.word_omissions_verified is False
    assert_safe(summary)
    assert output.evidence.warning_summary == ()


def test_warning_summary_unions_overlapping_records_but_retains_phase_and_details():
    from sme_meeting_ai.pipeline.offline_transcription import (
        OfflineTranscriptionWarning,
        summarize_warnings,
    )

    detailed = (
        OfflineTranscriptionWarning(Stage.COVERAGE_RECOVERY, "missing-speech", SampleInterval(0, 512), phase="initial"),
        OfflineTranscriptionWarning(Stage.COVERAGE_RECOVERY, "missing-speech", SampleInterval(0, 512), phase="final"),
        OfflineTranscriptionWarning(Stage.COVERAGE_RECOVERY, "missing-speech", SampleInterval(256, 768), phase="final"),
    )
    summaries = summarize_warnings(detailed)
    final, = [s for s in summaries if s.phase == "final"]
    assert final.record_count == 2
    assert final.intervals == (SampleInterval(0, 768),)
    assert final.interval_samples == 768
    assert sum(s.record_count for s in summaries) == len(detailed)


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
    # V2 retains Recovery's provisional calculation separately from publication.
    assert output.evidence.recovery.initial_assessment is output.evidence.recovery.pre_canonical_final_assessment
    assert output.evidence.recovery.final_assessment is output.evidence.coverage is output.result.coverage
    assert output.evidence.coverage.provenance.assessment_phase.value == "final-canonical"
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
    assert provenance.planning.planner_version == "speech-aware-v5"
    alignment = output.evidence.asr.boundary_alignment
    assert len(alignment.boundaries) == 1
    assert alignment.metrics.planned_chunk_count == 2
    assert alignment.metrics.total_core_samples == 4096
    assert alignment.metrics.total_requested_samples == 4352
    assert alignment.metrics.total_adjacent_overlap_samples == 256
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


def test_middle_chunk_final_tick_jitter_survives_correction_handoff(workflow, monkeypatch):
    h = workflow(count=8192)
    planned = {}
    original_plan = h.planner.plan

    def capture_plan(*args, **kwargs):
        plan = original_plan(*args, **kwargs)
        planned.update((c.chunk_id, c) for c in plan.chunks)
        return plan

    monkeypatch.setattr(h.planner, "plan", capture_plan)
    wording = "Phần lời nói ở giữa phải được giữ nguyên"
    seen = []
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("unexpected network"))) as client:
        adapter = OpenRouterWhisperAdapter(h.settings, client)

        def respond(audio):
            if audio.chunk_id != "chunk-000001":
                return None
            chunk = planned[audio.chunk_id]
            start = Fraction(chunk.core_interval.start_sample - chunk.request_interval.start_sample, 16000)
            end = Fraction(math.ceil(audio.duration * 50), 50) - Fraction(1, 1000000)
            assert end - audio.duration > Fraction(5, 1000)
            return adapter._normalize({"text": wording, "segments": [{
                "start": Decimal(start.numerator) / Decimal(start.denominator),
                "end": Decimal(end.numerator) / Decimal(end.denominator), "text": wording,
            }]}, audio)

        def correction_request(request):
            entries = json.loads(request.transcript_json)["segments"]
            seen.extend(e["text"] for e in entries)
            return CorrectionProviderResponse(json.dumps({"segments": [
                {k: e[k] for k in ("segment_id", "ordinal", "text")} for e in entries
            ]}), "fake", request.model)

        h.asr_callback = respond
        h.correction_callback = correction_request
        outcome = pipeline(h).run(h.source)
    assert outcome.failure is None
    assert outcome.evidence.asr.chunk_outcomes[1].failure is None
    assert wording in seen
    assert wording in [s.text for s in outcome.result.segments]
    assert outcome.provenance.asr.effective_configuration["final_timestamp_policy"] == "next-whisper-20ms-tick-v2"
    assert_released(h)


def test_failed_baseline_remains_and_recovery_reaches_reconciliation(workflow):
    h = workflow()

    def fail_one(audio):
        if audio.chunk_id == "chunk-000001":
            raise AsrError(AsrErrorCategory.TIMEOUT)

    h.asr_callback = fail_one
    output = pipeline(h).run(h.source)
    assert output.status is Status.COMPLETED_WITH_WARNINGS
    assert output.evidence.recovery.initial_assessment.quality.failed_chunk_count == 1
    # Only an admitted alternative can resolve the final canonical omission.
    assert output.evidence.recovery.pre_canonical_final_assessment.provenance.assessment_phase.value == "pre-canonical"
    assert output.evidence.coverage.quality.canonical_text_supported_samples == 4096
    assert output.evidence.coverage.quality.ambiguous_canonical_samples == 0
    assert not output.evidence.coverage.unresolved_intervals
    assert any(a.admission.value == "accepted" for a in output.evidence.recovery.attempts)
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
    if stage is Stage.RECONCILIATION:
        # Baseline selection is speculative work inside coverage/recovery. The
        # public reconciliation stage is committed only with final accepted state.
        index = list(Stage).index(Stage.COVERAGE_RECOVERY)
    assert output.status is Status.FAILED and output.result is None
    assert output.failure.stage is (Stage.COVERAGE_RECOVERY if stage is Stage.RECONCILIATION else stage)
    assert output.completed_stages == tuple(Stage)[:index]
    assert h.calls == (list(Stage)[:index + 1] + [Stage.RECONCILIATION]
                       if stage is Stage.RECONCILIATION else list(Stage)[:index + 1])
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
        return AsrCandidate("", (), AsrQualityMetadata(), AsrUsage(),
                            AsrProvenance("openrouter", "openai/whisper-large-v3"), audio.chunk_id)

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


def enable_v2(h, monkeypatch):
    capabilities = AsrProviderCapabilities(
        "openrouter", "openai/whisper-large-v3", "https-multipart", "wav", "verbose_json",
        (AsrTimestampMode.SEGMENT,), AsrCapabilityStatus.DOCUMENTED, AsrCapabilityStatus.UNKNOWN,
        True, 25_000_000, AsrRoutingMode.ROUTED_UPSTREAM, AsrCapabilityStatus.DOCUMENTED,
    )
    monkeypatch.setattr(h.transcriber, "capabilities", capabilities, raising=False)
    original = h.transcriber.transcribe

    def transcribe_request(request):
        assert request.timestamp_mode is AsrTimestampMode.SEGMENT
        value = original(request.audio)
        return replace(value, provenance=replace(value.provenance, provider="openrouter",
                       requested_model="openai/whisper-large-v3"))

    monkeypatch.setattr(h.transcriber, "transcribe_request", transcribe_request, raising=False)


def test_native_preserves_segments_skips_recovery_and_retains_uncertainty(workflow, monkeypatch, caplog):
    h = workflow(audio_asr_strategy_mode="adaptive", probability=0.5)
    enable_v2(h, monkeypatch)

    def native(audio):
        segments = (
            AsrSegment(Fraction(1, 32000), Fraction(1, 16), "Đồng ý, đồng ý"),
            AsrSegment(Fraction(1, 16), Fraction(1, 8), "Đồng ý, đồng ý"),
        )
        return AsrCandidate("Đồng ý, đồng ý", segments, AsrQualityMetadata(), AsrUsage(cost=Fraction(1, 100)),
                            AsrProvenance("openrouter", "openai/whisper-large-v3", upstream_provider="DeepInfra"),
                            audio.chunk_id)

    h.asr_callback = native
    monkeypatch.setattr(recovery, "recover_speech", lambda *a: pytest.fail("native Recovery invoked"))
    output = pipeline(h).run(h.source)
    assert output.status is Status.COMPLETED_WITH_WARNINGS and output.completed_stages == tuple(Stage)
    assert len(output.evidence.chunk_plan.chunks) == len(h.asr_calls) == 1
    assert output.provenance.planning.planner_version == "whole-file-v1"
    assert output.evidence.asr.boundary_alignment is None
    assert "adaptive-asr-v1" in output.provenance.pipeline_version
    r = output.evidence.recovery
    assert r.stop_reason.value == "skipped-by-asr-strategy" and r.attempts == ()
    assert r.initial_assessment is r.pre_canonical_final_assessment
    assert r.final_assessment is output.evidence.coverage is output.result.coverage
    assert r.initial_assessment.provenance.assessment_phase.value == "pre-canonical"
    assert r.final_assessment.provenance.assessment_phase.value == "final-canonical"
    assert r.provenance.recovery_version == "2"
    assert output.evidence.coverage.unresolved_intervals
    assert [s.interval for s in output.result.segments] == [SampleInterval(0, 1000), SampleInterval(1000, 2000)]
    assert [s.text for s in output.result.segments] == ["Đồng ý, đồng ý."] * 2
    assert all(s.source_chunk_ids == ("chunk-000000",) for s in output.result.segments)
    assert h.correction_ids == [("segment-000000", 0), ("segment-000001", 1)]
    telemetry = output.provenance.strategy
    assert telemetry.total_actual_asr_calls == telemetry.native_successes == 1
    assert telemetry.recovery_calls == 0 and telemetry.reported_asr_cost == Fraction(1, 100)
    assert_safe(output.evidence)
    assert_released(h)
    assert not caplog.records


def test_chunked_planning_captures_effective_provider_limit_before_execution(workflow, monkeypatch):
    h = workflow()
    enable_v2(h, monkeypatch)
    limit = 44 + 2304 * 2
    monkeypatch.setattr(h.transcriber, "capabilities", replace(h.transcriber.capabilities,
                       effective_payload_limit=limit))
    output = pipeline(h).run(h.source)
    assert output.failure is None
    assert output.provenance.planning.effective_configuration["effective_payload_limit"] == limit
    assert h.asr_calls == [c.chunk_id for c in output.evidence.chunk_plan.chunks]
    assert output.evidence.recovery.provenance.planning == output.provenance.planning
    assert_safe(output.evidence.asr.boundary_alignment)
    assert_released(h)


def test_infeasible_chunked_payload_fails_before_any_provider_call(workflow, monkeypatch, caplog):
    h = workflow()
    enable_v2(h, monkeypatch)
    monkeypatch.setattr(h.transcriber, "capabilities", replace(h.transcriber.capabilities,
                       effective_payload_limit=44))
    output = pipeline(h).run(h.source)
    assert output.status is Status.FAILED and output.failure.stage is Stage.CHUNK_PLANNING
    assert h.asr_calls == [] and h.correction_calls == 0
    assert_safe(output)
    assert_released(h)
    assert not caplog.records


@pytest.mark.parametrize("fallback", [False, True])
def test_adaptive_single_preprocessing_and_exact_resource_ownership(workflow, monkeypatch, fallback):
    from sme_meeting_ai.pipeline.models import PreprocessingOutcome

    h = workflow(audio_asr_strategy_mode="adaptive")
    enable_v2(h, monkeypatch)
    runs, closes = [], []
    run, close = h.preprocessing.run, PreprocessingOutcome.close

    def preprocess(source):
        runs.append(True)
        return run(source)

    def cleanup(outcome):
        closes.append(True)
        close(outcome)

    monkeypatch.setattr(h.preprocessing, "run", preprocess)
    monkeypatch.setattr(PreprocessingOutcome, "close", cleanup)

    def respond(audio):
        if fallback and len(h.asr_calls) == 1:
            raise TimeoutError(PRIVATE)

    h.asr_callback = respond
    output = pipeline(h).run(h.source)
    assert output.failure is None and runs == closes == [True]
    telemetry = output.provenance.strategy
    assert telemetry.fallback_used is fallback
    assert telemetry.native_attempts == 1
    assert telemetry.chunked_baseline_calls == (2 if fallback else 0)
    assert telemetry.total_actual_asr_calls == len(h.asr_calls) == (3 if fallback else 1)
    assert_released(h)


@pytest.mark.parametrize("exception", [KeyboardInterrupt, asyncio.CancelledError, CancelledError])
def test_native_cancellation_releases_audio_without_fallback(workflow, monkeypatch, exception):
    h = workflow(audio_asr_strategy_mode="adaptive")
    enable_v2(h, monkeypatch)
    h.asr_callback = lambda audio: (_ for _ in ()).throw(exception())
    with pytest.raises(exception):
        pipeline(h).run(h.source)
    assert len(h.asr_calls) == 1
    assert_released(h)


def test_adaptive_chunked_recovery_actual_calls_and_budget_preflight(workflow, monkeypatch):
    h = workflow(audio_asr_strategy_mode="adaptive", audio_asr_native_max_samples=1,
                 audio_asr_recovery_max_total_attempts=1)
    enable_v2(h, monkeypatch)

    def respond(audio):
        if audio.chunk_id == "chunk-000001":
            raise AsrError(AsrErrorCategory.TIMEOUT)
        text = RAW[0]
        return AsrCandidate(text, (AsrSegment(Fraction(0), audio.duration, text),),
                            AsrQualityMetadata(), AsrUsage(
                                cost=Fraction(2, 100) if audio.chunk_id.startswith("recovery-") else Fraction(0),
                                reported=True,
                            ), AsrProvenance("openrouter", "openai/whisper-large-v3"), audio.chunk_id)

    h.asr_callback = respond
    output = pipeline(h).run(h.source)
    assert output.failure is None
    t = output.provenance.strategy
    assert t.native_attempts == 0 and t.chunked_baseline_calls == 2 and t.recovery_calls == 1
    assert t.total_actual_asr_calls == len(h.asr_calls) == 3
    assert t.reported_cost_call_count == 2 and t.reported_cost_subtotal == Fraction(2, 100)
    assert t.reported_asr_cost is None and t.native_duration_ns == 0
    assert t.total_asr_duration_ns >= t.chunked_duration_ns > 0
    h = workflow(audio_asr_strategy_mode="adaptive", audio_asr_adaptive_max_total_calls=2)
    enable_v2(h, monkeypatch)
    output = pipeline(h).run(h.source)
    assert output.status is Status.FAILED and output.failure.category == "RESOURCE"
    assert not h.asr_calls and not h.correction_calls
    assert_released(h)


@pytest.mark.parametrize("category", [AsrErrorCategory.AUTHENTICATION, AsrErrorCategory.VALIDATION,
                                      AsrErrorCategory.RATE_LIMIT, AsrErrorCategory.TIMEOUT])
def test_failed_adaptive_execution_keeps_sanitized_attempt_metadata(workflow, monkeypatch, caplog, category):
    h = workflow(audio_asr_strategy_mode="adaptive")
    enable_v2(h, monkeypatch)

    def fail(audio):
        if len(h.asr_calls) == 1:
            raise AsrError(category)
        raise RuntimeError(PRIVATE)

    h.asr_callback = fail
    output = pipeline(h).run(h.source)
    assert output.status is Status.FAILED and output.failure.stage is Stage.ASR
    t = output.provenance.strategy
    assert t.native_attempts == t.native_failures == 1 and t.native_failure is category
    assert t.fallback_used is (category is AsrErrorCategory.TIMEOUT)
    assert t.total_actual_asr_calls == len(h.asr_calls) == (3 if t.fallback_used else 1)
    assert output.failure.category == ("PROVIDER" if t.fallback_used else category.value.upper())
    assert not h.correction_calls
    assert_safe(output)
    assert_released(h)
    assert not caplog.records


def test_empty_native_success_is_not_silence_or_fabricated_coverage(workflow, monkeypatch):
    h = workflow(audio_asr_strategy_mode="adaptive")
    enable_v2(h, monkeypatch)
    h.asr_callback = lambda audio: AsrCandidate("", (), AsrQualityMetadata(), AsrUsage(),
                                               AsrProvenance("openrouter", "openai/whisper-large-v3"),
                                               audio.chunk_id)
    monkeypatch.setattr(recovery, "recover_speech", lambda *a: pytest.fail("native Recovery invoked"))
    output = pipeline(h).run(h.source)
    assert output.failure is None and output.result.segments == ()
    assert output.evidence.coverage.quality.covered_speech_samples == 0
    assert output.evidence.coverage.unresolved_intervals == (SampleInterval(0, 4096),)
    assert output.evidence.recovery.attempts == () and len(h.asr_calls) == 1
    assert output.provenance.strategy.native_successes == 1
    assert_released(h)


@pytest.mark.parametrize("mode", ["chunked", "adaptive"])
def test_unchanged_worker_accepts_strategy_outcome_and_rejects_corruption(workflow, monkeypatch, mode):
    from sme_meeting_ai.workers.transcription import (
        ResultValidationError,
        map_result,
        validate_result_bytes,
    )

    media = "22222222-2222-4222-8222-222222222222"
    h = workflow(source_id=media, audio_asr_strategy_mode=mode)
    enable_v2(h, monkeypatch)
    output = pipeline(h).run(h.source)
    ids = dict(job_id="11111111-1111-4111-8111-111111111111", media_id=media,
               source_revision="a" * 64, producer_id="33333333-3333-4333-8333-333333333333")
    envelope = validate_result_bytes(map_result(output, h.settings, **ids))
    assert envelope.correctionProof.contextScope == "WHOLE_MEETING"
    assert envelope.sampleCount == 4096
    assert [s.text for s in envelope.segments] == [s.text for s in output.result.segments]
    corruptions = [
        None, replace(output, result=None, status=Status.FAILED,
                      failure=SimpleNamespace(stage=Stage.CORRECTION)),
        replace(output, provenance=replace(output.provenance, source_id="different")),
        replace(output, provenance=replace(output.provenance, correction=None)),
        replace(output, evidence=replace(output.evidence, coverage=None)),
        replace(output, result=replace(output.result, segments=())),
        replace(output, result=replace(output.result, segments=(replace(output.result.segments[0], ordinal=4),))),
        replace(output, result=replace(output.result, sample_count=1)),
    ]
    for corrupt in corruptions:
        with pytest.raises(ResultValidationError):
            map_result(corrupt, h.settings, **ids)
    assert_released(h)


@pytest.mark.parametrize("recovery_needed", [False, True])
def test_v2_pipeline_reuses_accepted_snapshot_and_existing_boundary_report(workflow, monkeypatch, recovery_needed):
    h = workflow(audio_asr_recovery_max_total_attempts=1)
    if recovery_needed:
        def fail(audio):
            if audio.chunk_id == "chunk-000001":
                raise AsrError(AsrErrorCategory.TIMEOUT)
        h.asr_callback = fail
    invocations = []
    original = reconciliation.reconcile_transcript

    def reconcile(plan, results, settings, *, boundary_alignment=None):
        assert boundary_alignment is not None
        invocations.append((tuple(r.chunk.chunk_id for r in results), boundary_alignment))
        return original(plan, results, settings, boundary_alignment=boundary_alignment)

    monkeypatch.setattr(reconciliation, "reconcile_transcript", reconcile)
    output = pipeline(h).run(h.source)
    assert output.failure is None and len(invocations) == (2 if recovery_needed else 1)
    assert output.provenance.reconciliation.reconciler_version == "2"
    ids, report = invocations[-1]
    assert report is output.evidence.asr.boundary_alignment
    assert len(ids) == len(set(ids)) == len(h.asr_calls) == (3 if recovery_needed else 2)
    assert_released(h)


@pytest.mark.parametrize("flag", list(ReconciliationFlag))
def test_canonical_uncertainty_v2_publishes_with_conservative_coverage(workflow, flag):
    from sme_meeting_ai.workers.transcription import (
        map_result,
        validate_result_bytes,
    )

    media = "22222222-2222-4222-8222-222222222222"
    h = workflow(source_id=media, audio_asr_recovery_max_total_attempts=1)

    def observed(audio):
        # Baseline observations share an actual source interval around the core
        # boundary. Recovery remains a separate source, using real request bounds.
        ordinal = int(audio.chunk_id[-6:])
        offset = 0 if ordinal == 0 else 1920
        start, end = (1920, 2176) if audio.chunk_id.startswith("chunk-") else (offset, offset + 128)
        relative_start, relative_end = Fraction(start - offset, 16000), Fraction(end - offset, 16000)
        if relative_end > audio.duration:
            relative_end = audio.duration
        text = "Triển khai API-v2 với Kubernetes"
        if audio.chunk_id == "chunk-000001":
            if flag is ReconciliationFlag.CONFLICTING_OVERLAP:
                text = "Triển khai API-v3 với Kubernetes"
            elif flag is ReconciliationFlag.UNRESOLVED_BOUNDARY:
                text = "Báo cáo doanh thu hôm nay"
        return AsrCandidate(text, (AsrSegment(relative_start, relative_end, text),),
                            AsrQualityMetadata(), AsrUsage(),
                            AsrProvenance("openrouter", "openai/whisper-large-v3"), audio.chunk_id)

    h.asr_callback = observed
    output = pipeline(h).run(h.source)
    assert output.failure is None
    assert output.provenance.reconciliation.reconciler_version == "2"
    occurrence = [s for s in output.result.segments if s.interval == SampleInterval(1920, 2176)]
    if flag is ReconciliationFlag.UNRESOLVED_BOUNDARY:
        assert len(occurrence) == 2  # uncertainty retains both independent candidates
    else:
        assert len(occurrence) == 1 and len(occurrence[0].source_chunk_ids) == 2
    assert all(flag in s.flags for s in occurrence)
    assessment = output.evidence.coverage
    original_states = tuple(r.state for r in assessment.regions)
    affected_regions = [i for i, r in enumerate(assessment.regions)
                         if r.state.value == "SUSPICIOUS" and r.interval.start_sample < 2176
                        and 1920 < r.interval.end_sample]
    assert affected_regions
    raw = map_result(output, h.settings,
        job_id="11111111-1111-4111-8111-111111111111", media_id=media,
        source_revision="a" * 64, producer_id="33333333-3333-4333-8333-333333333333")
    envelope = validate_result_bytes(raw)
    assert len(envelope.segments) == len(output.result.segments)
    assert envelope.pipelineStatus == "COMPLETED_WITH_WARNINGS"
    # Existing worker conservatively maps unresolved evidence-risk intersections
    # to UNRESOLVED; this does not assert missing words or confirmed hallucination.
    assert all(envelope.segments[s.ordinal].qualityStatus == "UNRESOLVED" for s in occurrence)
    assert all(envelope.coverage[i].coverageStatus == "SUSPICIOUS" for i in affected_regions)
    assert any(w.stage == "RECONCILIATION" and w.code == flag.value for w in envelope.warnings)
    assert [(s.ordinal, s.text) for s in envelope.segments] == [(s.ordinal, s.text) for s in output.result.segments]
    assert [(r.startMs, r.endMs) for r in envelope.coverage] == [
        (r.interval.start_sample * 1000 // 16000, (r.interval.end_sample * 1000 + 15999) // 16000)
        for r in assessment.regions
    ]
    assert output.evidence.coverage is output.result.coverage is assessment
    assert tuple(r.state for r in assessment.regions) == original_states
    assert output.provenance.coverage == assessment.provenance
    assert len(h.asr_calls) == 3 and h.correction_calls == 1
    assert_released(h)


@pytest.mark.parametrize("mode", ["chunked", "adaptive"])
def test_v2_final_assessment_once_after_selection_before_correction_and_consistent_publication(workflow, monkeypatch, mode):
    h = workflow(audio_asr_strategy_mode=mode, probability=0.5)
    enable_v2(h, monkeypatch)
    calls = []
    original_reconcile = reconciliation.reconcile_transcript
    original_final = coverage.assess_canonical_coverage
    original_correct = correction.correct_transcript

    def select(*args, **kwargs):
        calls.append("selection")
        return original_reconcile(*args, **kwargs)

    def assess(*args, **kwargs):
        assert calls == ["selection"]
        calls.append("final")
        return original_final(*args, **kwargs)

    def correct(canonical, assessment, *args, **kwargs):
        assert calls == ["selection", "final"]
        assert assessment.provenance.assessment_phase.value == "final-canonical"
        calls.append("correction")
        return original_correct(canonical, assessment, *args, **kwargs)

    monkeypatch.setattr(reconciliation, "reconcile_transcript", select)
    monkeypatch.setattr(coverage, "assess_canonical_coverage", assess)
    monkeypatch.setattr(correction, "correct_transcript", correct)
    output = pipeline(h).run(h.source)
    assert output.failure is None
    assert calls == ["selection", "final", "correction"]
    assert output.evidence.coverage is output.evidence.recovery.final_assessment is output.result.coverage
    assert output.provenance.coverage is output.evidence.coverage.provenance
    assert output.evidence.recovery.pre_canonical_final_assessment.provenance.assessment_phase.value == "pre-canonical"
    assert {w.phase for w in output.warnings if w.stage is Stage.COVERAGE_RECOVERY} >= {"initial", "final"}
    assert output.provenance.strategy.total_actual_asr_calls == len(h.asr_calls)
    assert_safe(output.evidence)
    assert_released(h)


@pytest.mark.parametrize("cancel", [False, True])
def test_v2_final_assessment_failure_or_cancellation_preserves_cleanup(workflow, monkeypatch, cancel):
    h = workflow()

    def fail(*args, **kwargs):
        if cancel:
            raise CancelledError(PRIVATE)
        raise AudioProcessingError("VALIDATION")

    monkeypatch.setattr(coverage, "assess_canonical_coverage", fail)
    if cancel:
        with pytest.raises(CancelledError):
            pipeline(h).run(h.source)
    else:
        output = pipeline(h).run(h.source)
        assert output.status is Status.FAILED
        assert output.failure.stage is Stage.COVERAGE_RECOVERY
        assert output.failure.category == "VALIDATION"
        assert_safe(output)
    assert h.correction_calls == 0
    assert_released(h)


@pytest.mark.parametrize("admit", [False, True])
def test_t07_worker_publication_uses_only_admitted_canonical_evidence(workflow, admit):
    from sme_meeting_ai.workers.transcription import map_result, validate_result_bytes

    media = "22222222-2222-4222-8222-222222222222"
    h = workflow(source_id=media, audio_asr_recovery_max_total_attempts=1)

    def respond(audio):
        if audio.chunk_id == "chunk-000001":
            raise AsrError(AsrErrorCategory.TIMEOUT)
        if not admit and audio.chunk_id == "chunk-000000":
            return AsrCandidate(
                RAW[0], (AsrSegment(Fraction(896, 16000), Fraction(1024, 16000), RAW[0]),),
                AsrQualityMetadata(), AsrUsage(), AsrProvenance("openrouter", "openai/whisper-large-v3"), audio.chunk_id,
            )
        if audio.chunk_id.startswith("recovery-"):
            text = RAW[1] if admit else RAW[0]
            return AsrCandidate(
                text, (AsrSegment(Fraction(0 if admit else 896, 16000),
                                  audio.duration if admit else Fraction(1024, 16000), text),),
                AsrQualityMetadata(), AsrUsage(cost=Fraction(3, 100), reported=True),
                AsrProvenance("openrouter", "openai/whisper-large-v3", upstream_provider="Together"), audio.chunk_id,
            )

    h.asr_callback = respond
    output = pipeline(h).run(h.source)
    assert output.failure is None
    evidence = output.evidence.recovery
    assert evidence.provenance.accepted_attempt_count == int(admit)
    assert evidence.provenance.rejected_attempt_count == int(not admit)
    assert evidence.provenance.actual_attempt_count == 1
    assert evidence.attempts[0].meaningful_progress is admit
    assert evidence.final_assessment is output.evidence.coverage is output.result.coverage
    assert output.provenance.strategy.recovery_calls == 1
    raw = map_result(output, h.settings, job_id="11111111-1111-4111-8111-111111111111", media_id=media,
                     source_revision="a" * 64, producer_id="33333333-3333-4333-8333-333333333333")
    envelope = validate_result_bytes(raw)
    assert any(r.recovered for r in envelope.coverage) is admit
    assert len(output.result.segments) == (2 if admit else 1)
    assert h.asr_calls == ["chunk-000000", "chunk-000001", "recovery-000000"]
    assert_released(h)


def test_t07_trial_resource_exhaustion_blocks_completed_publication(workflow, monkeypatch):
    h = workflow(audio_asr_recovery_max_total_attempts=1)
    h.asr_callback = lambda audio: (AsrCandidate("", (), AsrQualityMetadata(), AsrUsage(),
        AsrProvenance("openrouter", "openai/whisper-large-v3"), audio.chunk_id)
        if audio.chunk_id.startswith("chunk-") else None)
    original = coverage.assess_canonical_coverage

    def limited(preprocessing, plan, baseline, extra, *args):
        if extra:
            raise AudioProcessingError("RESOURCE")
        return original(preprocessing, plan, baseline, extra, *args)

    monkeypatch.setattr(coverage, "assess_canonical_coverage", limited)
    output = pipeline(h).run(h.source)
    assert output.status is Status.FAILED and output.result is None
    assert output.failure.stage is Stage.COVERAGE_RECOVERY and output.failure.category == "RESOURCE"
    assert output.evidence.recovery.provenance.failed_attempt_count == 1
    assert output.evidence.recovery.attempts[0].admission_reason.value == "resource-limit"
    assert h.correction_calls == 0
    assert_released(h)
