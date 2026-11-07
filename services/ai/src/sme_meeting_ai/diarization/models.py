"""Transient provider-independent speaker clustering evidence."""

import re
from dataclasses import dataclass
from enum import StrEnum


class DiarizationErrorCategory(StrEnum):
    CONFIGURATION = "configuration"
    AUTHENTICATION = "authentication"
    RATE_LIMIT = "rate_limit"
    TIMEOUT = "timeout"
    TRANSPORT = "transport"
    PROVIDER = "provider"
    MALFORMED_OUTPUT = "malformed_output"
    VALIDATION = "validation"
    INPUT_TOO_LARGE = "input_too_large"


class DiarizationError(Exception):
    """Category-only error without provider diagnostics or sensitive input."""

    def __init__(self, category: DiarizationErrorCategory):
        self.category = category
        super().__init__(category.value)


def _interval(start: int, end: int) -> None:
    if type(start) is not int or type(end) is not int or start < 0 or start >= end:
        raise DiarizationError(DiarizationErrorCategory.VALIDATION)


@dataclass(frozen=True, slots=True)
class SpeakerTurn:
    start_ms: int
    end_ms: int
    speaker_label: str

    def __post_init__(self) -> None:
        _interval(self.start_ms, self.end_ms)
        if not isinstance(self.speaker_label, str) or not re.fullmatch(r"SPEAKER_[0-9]{2,}", self.speaker_label):
            raise DiarizationError(DiarizationErrorCategory.VALIDATION)


@dataclass(frozen=True, slots=True)
class DiarizationResult:
    turns: tuple[SpeakerTurn, ...]
    speakers: tuple[str, ...]
    model_id: str

    def validate_duration(self, duration_ms: int) -> None:
        """Validate normalized turns against the independently established audio timeline."""
        if type(duration_ms) is not int or duration_ms < 0:
            raise DiarizationError(DiarizationErrorCategory.VALIDATION)
        if any(type(turn.start_ms) is not int or type(turn.end_ms) is not int
               or turn.start_ms < 0 or turn.start_ms >= turn.end_ms
               or turn.start_ms >= duration_ms or turn.end_ms > duration_ms for turn in self.turns):
            raise DiarizationError(DiarizationErrorCategory.MALFORMED_OUTPUT)


@dataclass(frozen=True, slots=True)
class TimedTranscriptSegment:
    ordinal: int
    start_ms: int
    end_ms: int

    def __post_init__(self) -> None:
        _interval(self.start_ms, self.end_ms)
        if type(self.ordinal) is not int or self.ordinal < 0:
            raise DiarizationError(DiarizationErrorCategory.VALIDATION)


@dataclass(frozen=True, slots=True)
class SpeakerAssignment:
    ordinal: int
    speaker_label: str | None
