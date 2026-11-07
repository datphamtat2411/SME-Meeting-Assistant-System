import wave
from unittest.mock import Mock

import pytest
from test_offline_transcription_pipeline import RAW, pipeline
from test_offline_transcription_pipeline import workflow as workflow

from sme_meeting_ai.demo.pipeline import DemoPipelineRunner as SharedDemoPipelineRunner, DemoProcessingError
from sme_meeting_ai.diarization import DiarizationResult, DiarizationService, SpeakerTurn
from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrUsage,
)
from sme_meeting_ai.transcription.correction import (
    CorrectionError,
    CorrectionErrorCategory,
)


def DemoPipelineRunner(pipeline, provider, **kwargs):
    return SharedDemoPipelineRunner(pipeline, DiarizationService(provider), **kwargs)


def test_real_offline_composition_corrects_once_then_adds_speakers(workflow):
    h = workflow()
    diarizer = Mock()
    diarizer.diarize.return_value = DiarizationResult(
        (SpeakerTurn(0, 128, "SPEAKER_01"), SpeakerTurn(128, 256, "SPEAKER_02")),
        ("SPEAKER_01", "SPEAKER_02"), "pinned",
    )
    result = DemoPipelineRunner(pipeline(h), diarizer, language="vi").run(h.source.path)
    assert [s.text for s in result.segments] == [text + "." for text in RAW]
    assert [(s.ordinal, s.startMs, s.endMs, s.speakerLabel) for s in result.segments] == [
        (0, 0, 128, "SPEAKER_01"), (1, 128, 256, "SPEAKER_02"),
    ]
    assert len(h.asr_calls) == 2 and h.correction_calls == 1
    assert list(h.work.iterdir()) == []
    assert h.source.path.exists()


def test_real_silence_outcome_is_successfully_empty_without_diarization(workflow):
    h = workflow(probability=0.0)
    original = h.preprocessing._normalizer._runner

    def silent_decode(argv, **limits):
        value = original(argv, **limits)
        if argv[0] == "ffmpeg" and "-version" not in argv:
            with wave.open(argv[-1], "wb") as stream:
                stream.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                stream.writeframes(b"\x00\x00" * 4096)
        return value

    h.preprocessing._normalizer._runner = silent_decode
    h.asr_callback = lambda audio: AsrCandidate(
        "", (), AsrQualityMetadata(), AsrUsage(),
        AsrProvenance("openrouter", "openai/whisper-large-v3"), audio.chunk_id,
    )
    diarizer = Mock()
    result = DemoPipelineRunner(pipeline(h), diarizer, language="vi").run(h.source.path)
    assert result.segments == () and result.diarization.status == "skipped"
    # The existing pipeline still executes its ASR/correction stages on quiet
    # recordings. Empty correction must be accepted using final speech coverage,
    # not reconciliation's whole-timeline gaps between transcript segments.
    assert h.asr_calls and h.correction_calls == 1
    diarizer.diarize.assert_not_called()
    assert list(h.work.iterdir()) == []


@pytest.mark.parametrize("stage", ["asr", "correction"])
def test_real_pipeline_failure_is_not_fabricated_as_a_transcript(workflow, stage):
    h = workflow()

    def fail(*args):
        if stage == "asr":
            raise AsrError(AsrErrorCategory.AUTHENTICATION)
        raise CorrectionError(CorrectionErrorCategory.AUTHENTICATION)

    if stage == "asr":
        h.asr_callback = fail
    else:
        h.correction_callback = fail
    diarizer = Mock()
    with pytest.raises(DemoProcessingError):
        DemoPipelineRunner(pipeline(h), diarizer, language="vi").run(h.source.path)
    diarizer.diarize.assert_not_called()
    assert list(h.work.iterdir()) == []
