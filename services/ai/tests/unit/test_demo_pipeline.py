from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.core.config import ConfigurationError, Settings
from sme_meeting_ai.demo.models import SpeakerHints
from sme_meeting_ai.demo.pipeline import (
    DemoPipelineRunner,
    DemoProcessingError,
    build_demo_runner,
    processing_budget_seconds,
)
from sme_meeting_ai.diarization import (
    DiarizationError,
    DiarizationErrorCategory,
    DiarizationResult,
    SpeakerTurn,
    align_speakers,
)
from sme_meeting_ai.pipeline.offline_transcription import (
    OfflineReconciliationEvidence,
    OfflineReconciliationSegment,
    OfflineTranscriptionEvidence,
    OfflineTranscriptionFailure,
    OfflineTranscriptionOutcome,
    OfflineTranscriptionProvenance,
    OfflineTranscriptionStage,
    OfflineTranscriptionStatus,
)
from sme_meeting_ai.transcription.correction import (
    CorrectedSegment,
    TranscriptCorrectionResult,
)

PRIVATE = "private-provider-body-token-and-transcript"


def outcome(source_id, segments=None):
    if segments is None:
        segments = (
            CorrectedSegment("segment-a", 2, SampleInterval(16001, 32001), "Bản đã sửa dấu.", (), ()),
            CorrectedSegment("segment-b", 7, SampleInterval(48000, 64000), "Giữ nguyên câu này!", (), ()),
            CorrectedSegment("segment-c", 11, SampleInterval(80000, 96000), "Không có người nói.", (), ()),
        )
    provenance = OfflineTranscriptionProvenance("test", source_id, 100001)
    correction = TranscriptCorrectionResult(source_id, 100001, segments, None, (), None, None)
    reconciled = tuple(OfflineReconciliationSegment(s.segment_id, s.ordinal, s.interval, (), ()) for s in segments)
    evidence = OfflineTranscriptionEvidence(
        source_id, SimpleNamespace(sample_count=100001), None, (), None, None, None,
        None, None, None, OfflineReconciliationEvidence((), reconciled, (), None), (), provenance,
    )
    return OfflineTranscriptionOutcome(
        OfflineTranscriptionStatus.COMPLETED, tuple(OfflineTranscriptionStage), correction,
        None, evidence, (), provenance,
    )


def components(tmp_path, *, turns=(), segments=None):
    path = tmp_path / "original.wav"
    path.write_bytes(b"original recording")
    pipeline = Mock()
    pipeline.run.side_effect = lambda source: outcome(source.source_id, segments)
    diarizer = Mock()
    diarizer.diarize.return_value = DiarizationResult(tuple(turns), ("SPEAKER_00", "SPEAKER_01"), "pinned")
    return path, pipeline, diarizer


def test_corrected_text_absolute_rounding_ordinals_and_alignment_share_one_timeline(tmp_path, monkeypatch):
    turns = (
        SpeakerTurn(1000, 1500, "SPEAKER_00"),
        SpeakerTurn(1500, 2001, "SPEAKER_00"),
        SpeakerTurn(1200, 1600, "SPEAKER_01"),
        SpeakerTurn(3000, 4000, "SPEAKER_01"),
    )
    path, pipeline, diarizer = components(tmp_path, turns=turns)
    observed = []

    def align(segments, evidence):
        observed.extend(segments)
        return align_speakers(segments, evidence)

    monkeypatch.setattr("sme_meeting_ai.demo.pipeline.align_speakers", align)
    stages = []
    result = DemoPipelineRunner(pipeline, diarizer, language="vi").run(
        path, hints=SpeakerHints(min_speakers=1, max_speakers=3), on_stage=stages.append,
    )
    assert stages == ["transcription", "diarization"]
    assert result.durationMs == 6251
    assert result.language == "vi"
    assert [(s.ordinal, s.startMs, s.endMs) for s in result.segments] == [
        (2, 1000, 2001), (7, 3000, 4000), (11, 5000, 6000),
    ]
    assert [(s.ordinal, s.start_ms, s.end_ms) for s in observed] == [
        (s.ordinal, s.startMs, s.endMs) for s in result.segments
    ]
    assert [s.text for s in result.segments] == [s.text for s in outcome("x").result.segments]
    assert [s.speakerLabel for s in result.segments] == ["SPEAKER_00", "SPEAKER_01", None]
    assert [(t.startMs, t.endMs, t.speakerLabel) for t in result.diarization.turns] == [
        (t.start_ms, t.end_ms, t.speaker_label) for t in turns
    ]
    assert [s.label for s in result.diarization.speakers] == ["SPEAKER_00", "SPEAKER_01"]
    source = pipeline.run.call_args.args[0]
    assert source.path == path and source.source_id
    diarizer.diarize.assert_called_once_with(path, num_speakers=None, min_speakers=1, max_speakers=3)
    assert "text" not in repr(result)


def test_equal_simultaneous_speaker_overlap_is_unknown(tmp_path):
    path, pipeline, diarizer = components(tmp_path, turns=(
        SpeakerTurn(0, 6000, "SPEAKER_00"), SpeakerTurn(0, 6000, "SPEAKER_01"),
    ))
    result = DemoPipelineRunner(pipeline, diarizer, language="vi").run(path)
    assert all(s.speakerLabel is None for s in result.segments)
    assert len(result.diarization.turns) == 2


@pytest.mark.parametrize("error,code", [
    (DiarizationError(DiarizationErrorCategory.TIMEOUT), "TIMEOUT"),
    (DiarizationError(DiarizationErrorCategory.AUTHENTICATION), "AUTHENTICATION"),
    (RuntimeError(PRIVATE), "PROCESSING_FAILED"),
])
def test_diarization_failure_preserves_corrected_transcript(tmp_path, error, code, caplog):
    path, pipeline, diarizer = components(tmp_path)
    diarizer.diarize.side_effect = error
    result = DemoPipelineRunner(pipeline, diarizer, language="vi").run(path)
    assert result.diarization.status == "failed"
    assert result.diarization.errorCode == code
    assert not result.diarization.turns and not result.diarization.speakers
    assert [s.text for s in result.segments] == [s.text for s in outcome("x").result.segments]
    assert all(s.speakerLabel is None for s in result.segments)
    assert PRIVATE not in result.model_dump_json() + caplog.text
    assert pipeline.run.call_count == 1


def test_successful_empty_transcript_skips_enrichment(tmp_path):
    path, pipeline, diarizer = components(tmp_path, segments=())
    result = DemoPipelineRunner(pipeline, diarizer, language="vi").run(path)
    assert result.segments == () and result.durationMs == 6251
    assert result.diarization.status == "skipped"
    assert result.diarization.errorCode is None
    diarizer.diarize.assert_not_called()


@pytest.mark.parametrize("stage", [OfflineTranscriptionStage.ASR, OfflineTranscriptionStage.CORRECTION])
def test_failed_transcription_never_calls_diarizer(tmp_path, stage):
    path, pipeline, diarizer = components(tmp_path)
    pipeline.run.side_effect = lambda source: replace(
        outcome(source.source_id), status=OfflineTranscriptionStatus.FAILED, result=None,
        completed_stages=(), failure=OfflineTranscriptionFailure(stage, "AUTHENTICATION"),
    )
    with pytest.raises(DemoProcessingError) as error:
        DemoPipelineRunner(pipeline, diarizer, language="vi").run(path)
    assert error.value.code == "PROCESSING_FAILED" and error.value.stage == "transcription"
    diarizer.diarize.assert_not_called()


@pytest.mark.parametrize("mutation", ["source", "interval", "order", "blank"])
def test_invalid_corrected_evidence_cannot_publish_text(tmp_path, mutation):
    path, pipeline, diarizer = components(tmp_path)

    def invalid(source):
        item = outcome(source.source_id)
        segments = item.result.segments
        if mutation == "source":
            return replace(item, result=replace(item.result, source_id="another-source"))
        if mutation == "interval":
            segments = (replace(segments[0], interval=SampleInterval(0, 16000)), *segments[1:])
        elif mutation == "order":
            segments = tuple(reversed(segments))
        elif mutation == "blank":
            segments = (replace(segments[0], text=" "), *segments[1:])
        return replace(item, result=replace(item.result, segments=segments))

    pipeline.run.side_effect = invalid
    with pytest.raises(DemoProcessingError):
        DemoPipelineRunner(pipeline, diarizer, language="vi").run(path)
    diarizer.diarize.assert_not_called()


def test_cooperative_deadline_before_and_after_transcription_and_diarization(tmp_path):
    path, pipeline, diarizer = components(tmp_path)
    clock = Mock(return_value=0)
    runner = DemoPipelineRunner(pipeline, diarizer, language="vi", clock=clock)
    clock.return_value = 11
    with pytest.raises(DemoProcessingError, match="TIMEOUT"):
        runner.run(path, deadline=10)
    pipeline.run.assert_not_called()
    clock.return_value = 0

    def slow_transcription(source):
        clock.return_value = 11
        return outcome(source.source_id)

    pipeline.run.side_effect = slow_transcription
    with pytest.raises(DemoProcessingError, match="TIMEOUT"):
        runner.run(path, deadline=10)
    diarizer.diarize.assert_not_called()
    pipeline.run.side_effect = lambda source: outcome(source.source_id)
    clock.return_value = 0

    def slow_diarization(*args, **kwargs):
        clock.return_value = 11
        return DiarizationResult((), (), "pinned")

    diarizer.diarize.side_effect = slow_diarization
    result = runner.run(path, deadline=10)
    assert result.segments and result.diarization.errorCode == "TIMEOUT"


@pytest.mark.parametrize("mode", ["v5_full", "v62_edits"])
def test_construction_reuses_configured_ai_components_without_worker_services(monkeypatch, mode):
    closed = []
    selected = Settings(
        _env_file=None, service_name="test", service_identity="ai-core",
        OPENROUTER_API_KEY="test-key", transcript_correction_model="approved/model",
        transcript_correction_mode=mode,
    )
    monkeypatch.setattr("sme_meeting_ai.audio.vad.SileroVadBackend.from_settings",
                        lambda settings: SimpleNamespace(close=lambda: closed.append("vad")))

    class Provider:
        def __init__(self, settings):
            assert settings.transcript_correction_model == "approved/model"

        def __enter__(self):
            return self

        def __exit__(self, *args):
            closed.append(type(self).__name__)

    class V5(Provider):
        pass

    class V62(Provider):
        pass

    monkeypatch.setattr("sme_meeting_ai.providers.openrouter_whisper.OpenRouterWhisperAdapter", Provider)
    monkeypatch.setattr("sme_meeting_ai.providers.openrouter_instruction_llm.OpenRouterInstructionLlmAdapter", V5)
    monkeypatch.setattr("sme_meeting_ai.providers.openrouter_instruction_llm_v62.OpenRouterInstructionLlmV62Adapter", V62)
    for name in ("core_api.CoreApiClient", "object_storage.ObjectStorage", "messaging.RabbitConsumer"):
        monkeypatch.setattr(f"sme_meeting_ai.integrations.{name}", Mock(side_effect=AssertionError("infrastructure used")))
    runner = build_demo_runner(selected)
    assert runner._pipeline._correction_mode == mode
    assert type(runner._pipeline._correction_provider) is (V5 if mode == "v5_full" else V62)
    assert runner._pipeline.effective_settings == selected
    runner.close()
    assert closed == ["V5" if mode == "v5_full" else "V62", "Provider", "vad"]
    assert processing_budget_seconds(selected) > (
        selected.audio_asr_max_total_calls * selected.audio_asr_timeout_seconds
        + selected.diarization_timeout_seconds
    )


def test_failed_construction_closes_resources_and_sanitizes_errors(monkeypatch):
    selected = Settings(_env_file=None, service_name="test", service_identity="ai-core",
                        OPENROUTER_API_KEY="test-key", transcript_correction_model="approved/model")
    closed = []
    monkeypatch.setattr("sme_meeting_ai.audio.vad.SileroVadBackend.from_settings",
                        lambda settings: SimpleNamespace(close=lambda: closed.append("vad")))
    monkeypatch.setattr("sme_meeting_ai.providers.openrouter_whisper.OpenRouterWhisperAdapter",
                        Mock(side_effect=RuntimeError(PRIVATE)))
    with pytest.raises(ConfigurationError) as error:
        build_demo_runner(selected)
    assert PRIVATE not in str(error.value)
    assert error.value.__context__ is None and closed == ["vad"]


@pytest.mark.parametrize("field,value", [
    ("demo_max_upload_bytes", 0), ("demo_max_upload_bytes", 100000001),
    ("demo_max_concurrent_jobs", 0), ("demo_max_concurrent_jobs", 5),
    ("demo_max_queued_jobs", -1), ("demo_max_queued_jobs", 17),
    ("demo_max_retained_jobs", 0), ("demo_max_retained_jobs", 129),
    ("demo_result_ttl_seconds", float("inf")),
    ("demo_web_origin", "http://public.example:5173"),
    ("demo_web_origin", "http://localhost:5173/path"),
    ("demo_web_origin", "http://localhost"),
])
def test_demo_resource_configuration_is_bounded_and_local(field, value):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, service_name="test", service_identity="ai-core", **{field: value})


def test_demo_rejects_repository_temp_directory_and_excess_vad_concurrency():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, service_name="test", service_identity="ai-core",
                 demo_enabled=True, audio_temp_dir=".")
    with pytest.raises(ValidationError):
        Settings(_env_file=None, service_name="test", service_identity="ai-core",
                 demo_enabled=True, demo_max_concurrent_jobs=2)
