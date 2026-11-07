from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest.mock import Mock

import pytest

from sme_meeting_ai.diarization import (
    DiarizationError, DiarizationErrorCategory, DiarizationRequest, DiarizationResult,
    DiarizationService, SpeakerHints, SpeakerTurn, TimedTranscriptSegment,
)


def request(segments=None, **kwargs):
    return DiarizationRequest(Path("audio.wav"), 3000, (
        TimedTranscriptSegment(9, 0, 1000), TimedTranscriptSegment(2, 1000, 2000),
    ) if segments is None else segments, **kwargs)


def test_success_preserves_overlap_order_hints_and_ambiguity():
    turns = (SpeakerTurn(0, 1000, "SPEAKER_01"), SpeakerTurn(1000, 2000, "SPEAKER_01"),
             SpeakerTurn(1000, 2000, "SPEAKER_02"))
    provider = Mock()
    provider.diarize.return_value = DiarizationResult(turns, ("SPEAKER_01", "SPEAKER_02"), "model")
    result = DiarizationService(provider).run(request(speaker_hints=SpeakerHints(min_speakers=1, max_speakers=3)))
    assert result.diagnostic_status == "completed" and result.model_id == "model"
    assert result.speaker_labels == ("SPEAKER_01", "SPEAKER_02") and result.raw_turns == turns
    assert [(x.ordinal, x.speaker_label) for x in result.assignments] == [(9, "SPEAKER_01"), (2, None)]
    provider.diarize.assert_called_once_with(Path("audio.wav"), num_speakers=None, min_speakers=1, max_speakers=3)
    with pytest.raises(FrozenInstanceError):
        result.model_id = "other"


def test_skipped_and_empty_speaker_result_are_distinct():
    provider = Mock()
    provider.diarize.return_value = DiarizationResult((), (), "model")
    service = DiarizationService(provider)
    skipped = service.run(request(()))
    assert skipped.diagnostic_status == "skipped" and skipped.model_id is None
    assert not skipped.speaker_labels and not skipped.raw_turns and not skipped.assignments
    provider.diarize.assert_not_called()
    completed = service.run(request())
    assert completed.diagnostic_status == "completed" and completed.model_id == "model"
    assert [a.speaker_label for a in completed.assignments] == [None, None]
    provider.diarize.assert_called_once_with(Path("audio.wav"), num_speakers=None, min_speakers=None, max_speakers=None)


@pytest.mark.parametrize("hints", [dict(num_speakers=0), dict(num_speakers=True), dict(max_speakers=1001),
    dict(num_speakers="2"), dict(min_speakers=3, max_speakers=2),
    dict(num_speakers=1, min_speakers=2), dict(num_speakers=4, max_speakers=3)])
def test_invalid_hints_are_sanitized(hints):
    with pytest.raises(DiarizationError) as error:
        SpeakerHints(**hints)
    assert error.value.category == DiarizationErrorCategory.VALIDATION


@pytest.mark.parametrize("hints", [SpeakerHints(num_speakers=2), SpeakerHints(min_speakers=2, max_speakers=4)])
def test_valid_hints_forwarded(hints):
    provider = Mock()
    provider.diarize.return_value = DiarizationResult((), (), "model")
    DiarizationService(provider).run(request(speaker_hints=hints))
    provider.diarize.assert_called_once_with(Path("audio.wav"), num_speakers=hints.num_speakers,
                                              min_speakers=hints.min_speakers, max_speakers=hints.max_speakers)


@pytest.mark.parametrize("duration,segments", [
    (0, ()), (-1, ()), (float("inf"), ()), (True, ()), (3000.0, ()),
    (3000, (TimedTranscriptSegment(1, 2999, 3001),)),
    (3000, (TimedTranscriptSegment(1, 0, 1), TimedTranscriptSegment(1, 1, 2))),
])
def test_invalid_request_fails_before_inference(duration, segments):
    provider = Mock()
    with pytest.raises(DiarizationError) as error:
        DiarizationService(provider).run(DiarizationRequest(Path("audio"), duration, segments))
    assert error.value.category == DiarizationErrorCategory.VALIDATION
    provider.diarize.assert_not_called()


@pytest.mark.parametrize("evidence", [
    DiarizationResult((SpeakerTurn(0, 3001, "SPEAKER_01"),), ("SPEAKER_01",), "model"),
    DiarizationResult((SpeakerTurn(0, 1, "SPEAKER_01"),), (), "model"),
    DiarizationResult((), ("SPEAKER_01",), "model"),
    DiarizationResult((SpeakerTurn(0, 1, "SPEAKER_02"),), ("SPEAKER_02",), "model"),
    DiarizationResult((), (), ""),
    None,
])
def test_malformed_provider_evidence_is_not_aligned(evidence):
    provider = Mock()
    provider.diarize.return_value = evidence
    result = DiarizationService(provider).run(request())
    assert result.diagnostic_status == "failed" and result.error_category == "malformed_output"
    assert result.model_id is None and not result.speaker_labels and not result.raw_turns and not result.assignments


@pytest.mark.parametrize("error,category", [(DiarizationError(DiarizationErrorCategory.TIMEOUT), "timeout"),
                                             (RuntimeError("private token URL"), "processing_failed")])
def test_provider_failures_are_sanitized(error, category):
    provider = Mock()
    provider.diarize.side_effect = error
    result = DiarizationService(provider).run(request())
    assert result.diagnostic_status == "failed" and result.error_category == category
    assert result.model_id is None and not result.assignments and not result.raw_turns and not result.speaker_labels
    assert "private" not in repr(result)
