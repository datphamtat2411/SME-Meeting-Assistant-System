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
