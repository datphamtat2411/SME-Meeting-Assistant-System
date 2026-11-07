"""Stable demo wire contract, independent of production worker contracts."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Count = Annotated[int, Field(ge=0, strict=True)]
SpeakerLabel = Annotated[str, Field(pattern=r"^SPEAKER_[0-9]{2,}$")]
Stage = Literal["queued", "transcription", "diarization", "completed", "failed"]


class DemoModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)


class SpeakerHints(DemoModel):
    num_speakers: int | None = Field(default=None, ge=1, le=1000, strict=True)
    min_speakers: int | None = Field(default=None, ge=1, le=1000, strict=True)
    max_speakers: int | None = Field(default=None, ge=1, le=1000, strict=True)

    @field_validator("num_speakers", "min_speakers", "max_speakers", mode="before")
    @classmethod
    def multipart_integer(cls, value):
        # Match Task 01 integer hints; never round floats or coerce booleans.
        if isinstance(value, str) and value.isascii() and value.isdecimal():
            return int(value)
        return value

    @model_validator(mode="after")
    def consistent(self) -> Self:
        low, high, exact = self.min_speakers, self.max_speakers, self.num_speakers
        if (low is not None and high is not None and low > high
                or exact is not None and low is not None and exact < low
                or exact is not None and high is not None and exact > high):
            raise ValueError("Invalid speaker hints")
        return self


class DemoSegment(DemoModel):
    ordinal: Count
    startMs: Count
    endMs: Count
    speakerLabel: SpeakerLabel | None = None
    text: str = Field(min_length=1, repr=False)


class DemoSpeaker(DemoModel):
    label: SpeakerLabel


class DemoTurn(DemoModel):
    startMs: Count
    endMs: Count
    speakerLabel: SpeakerLabel


class DemoDiarization(DemoModel):
    status: Literal["completed", "failed", "skipped"]
    errorCode: Literal[
        "CONFIGURATION", "AUTHENTICATION", "RATE_LIMIT", "TIMEOUT", "TRANSPORT",
        "PROVIDER", "MALFORMED_OUTPUT", "VALIDATION", "PROCESSING_FAILED",
    ] | None = None
    speakers: tuple[DemoSpeaker, ...] = ()
    turns: tuple[DemoTurn, ...] = ()


class DemoResult(DemoModel):
    durationMs: Count
    language: str
    segments: tuple[DemoSegment, ...] = Field(repr=False)
    diarization: DemoDiarization


class DemoJobError(DemoModel):
    code: Literal["PROCESSING_FAILED", "TIMEOUT", "SHUTDOWN"]
    message: str


class DemoJobAccepted(DemoModel):
    jobId: str
    status: Literal["queued"] = "queued"
    stage: Literal["queued"] = "queued"


class DemoJobStatus(DemoModel):
    jobId: str
    status: Literal["queued", "processing", "completed", "failed"]
    stage: Stage
    result: DemoResult | None = Field(default=None, repr=False)
    error: DemoJobError | None = None
