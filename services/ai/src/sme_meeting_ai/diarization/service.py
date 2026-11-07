"""Provider-independent offline diarization and transcript attribution."""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

from .alignment import align_speakers
from .models import (
    DiarizationError,
    DiarizationErrorCategory,
    DiarizationResult,
    SpeakerAssignment,
    SpeakerTurn,
    TimedTranscriptSegment,
)


@dataclass(frozen=True, slots=True)
class SpeakerHints:
    num_speakers: int | None = None
    min_speakers: int | None = None
    max_speakers: int | None = None

    def __post_init__(self) -> None:
        exact, low, high = self.num_speakers, self.min_speakers, self.max_speakers
        if (any(v is not None and (type(v) is not int or not 1 <= v <= 1000) for v in (exact, low, high))
                or low is not None and high is not None and low > high
                or exact is not None and low is not None and exact < low
                or exact is not None and high is not None and exact > high):
            raise DiarizationError(DiarizationErrorCategory.VALIDATION)


@dataclass(frozen=True, slots=True)
class DiarizationRequest:
    audio_path: str | Path
    duration_ms: int
    timed_segments: tuple[TimedTranscriptSegment, ...]
    speaker_hints: SpeakerHints = field(default_factory=SpeakerHints)

    def __post_init__(self) -> None:
        if (not isinstance(self.audio_path, (str, Path)) or not str(self.audio_path)
                or type(self.duration_ms) is not int or self.duration_ms <= 0
                or not isinstance(self.timed_segments, tuple)
                or not isinstance(self.speaker_hints, SpeakerHints)):
            raise DiarizationError(DiarizationErrorCategory.VALIDATION)
        ordinals = set()
        for segment in self.timed_segments:
            if (not isinstance(segment, TimedTranscriptSegment)
                    or type(segment.ordinal) is not int or segment.ordinal < 0
                    or type(segment.start_ms) is not int or type(segment.end_ms) is not int
                    or not 0 <= segment.start_ms < segment.end_ms <= self.duration_ms
                    or segment.ordinal in ordinals):
                raise DiarizationError(DiarizationErrorCategory.VALIDATION)
            ordinals.add(segment.ordinal)


@dataclass(frozen=True, slots=True)
class DiarizationResponse:
    diagnostic_status: Literal["completed", "skipped", "failed"]
    model_id: str | None = None
    speaker_labels: tuple[str, ...] = ()
    raw_turns: tuple[SpeakerTurn, ...] = ()
    assignments: tuple[SpeakerAssignment, ...] = ()
    error_category: str | None = None


class DiarizationProvider(Protocol):
    def diarize(self, audio_path: str | Path, *, num_speakers: int | None = None,
                min_speakers: int | None = None, max_speakers: int | None = None) -> DiarizationResult: ...


def _validate_evidence(evidence: DiarizationResult, duration_ms: int) -> None:
    if (not isinstance(evidence, DiarizationResult)
            or not isinstance(evidence.model_id, str)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*(?::[A-Za-z0-9_.-]+)?", evidence.model_id)
            or not isinstance(evidence.speakers, tuple) or not isinstance(evidence.turns, tuple)
            or len(evidence.speakers) > 1000
            or evidence.speakers != tuple(f"SPEAKER_{i:02d}" for i in range(1, len(evidence.speakers) + 1))
            or any(not isinstance(turn, SpeakerTurn) for turn in evidence.turns)
            or {turn.speaker_label for turn in evidence.turns} != set(evidence.speakers)):
        raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)
    evidence.validate_duration(duration_ms)


class DiarizationService:
    def __init__(self, provider: DiarizationProvider):
        self._provider = provider

    def run(self, request: DiarizationRequest) -> DiarizationResponse:
        if not isinstance(request, DiarizationRequest):
            raise DiarizationError(DiarizationErrorCategory.VALIDATION)
        if not request.timed_segments:
            return DiarizationResponse("skipped")
        hints = request.speaker_hints
        try:
            evidence = self._provider.diarize(request.audio_path, num_speakers=hints.num_speakers,
                                               min_speakers=hints.min_speakers, max_speakers=hints.max_speakers)
            _validate_evidence(evidence, request.duration_ms)
            assignments = align_speakers(request.timed_segments, evidence.turns)
            return DiarizationResponse("completed", evidence.model_id, evidence.speakers, evidence.turns, assignments)
        except DiarizationError as error:
            return DiarizationResponse("failed", error_category=error.category.value)
        except Exception:
            return DiarizationResponse("failed", error_category="processing_failed")
