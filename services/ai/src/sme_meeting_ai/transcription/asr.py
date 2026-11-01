"""Provider-neutral, transient ASR evidence; candidates are never verified transcripts."""

from dataclasses import dataclass, field
from enum import StrEnum
from fractions import Fraction
from typing import Protocol


class AsrErrorCategory(StrEnum):
    VALIDATION = "validation"
    RESOURCE = "resource"
    PROVIDER = "provider"
    TRANSPORT = "transport"
    TIMEOUT = "timeout"
    AUTHENTICATION = "authentication"
    RATE_LIMIT = "rate_limit"
    MALFORMED_OUTPUT = "malformed_output"


class AsrError(Exception):
    """Category-only failure, without provider diagnostics or sensitive context."""

    def __init__(self, category: AsrErrorCategory):
        self.category = category
        super().__init__(category.value)


class AsrTimestampMode(StrEnum):
    SEGMENT = "segment"
    SEGMENT_AND_WORD = "segment-and-word"


class AsrRoutingMode(StrEnum):
    ROUTED_UPSTREAM = "routed-upstream"


class AsrCapabilityStatus(StrEnum):
    DOCUMENTED = "documented"
    LIVE_VERIFIED = "live-verified"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class AsrProviderCapabilities:
    """Transport eligibility and evidence status, not a completeness guarantee.

    None for the verified duration ceiling means unknown, never unlimited.
    Documented timestamp support may still depend on the selected upstream.
    """

    gateway: str
    model: str
    transport: str
    audio_format: str
    response_format: str
    timestamp_modes: tuple[AsrTimestampMode, ...]
    segment_timestamp_status: AsrCapabilityStatus
    word_timestamp_status: AsrCapabilityStatus
    word_timestamps_route_dependent: bool
    effective_payload_limit: int
    routing_mode: AsrRoutingMode
    desired_upstream: str | None
    capability_status: AsrCapabilityStatus
    verified_duration_ceiling: Fraction | None = None
    upstream_pin_supported: bool = field(default=False, init=False)

    def can_guarantee_upstream(self, upstream: str) -> bool:
        """Fail closed: V2 represents no enforceable upstream pinning mechanism.

        Neither a desired upstream nor a post-response observation can authorize
        strict upstream disclosure. A future mechanism needs its own capability
        gate and transport enforcement before this contract can claim support.
        """
        return False


@dataclass(frozen=True, slots=True)
class AsrAudioChunk:
    """Already-materialized audio, with an exact duration in seconds.

    Payloads are transient. The transcriber validates type, duration, and its
    configured byte limit before sending anything to a provider.
    """

    chunk_id: str = field(repr=False)
    payload: bytes = field(repr=False)
    duration: Fraction


@dataclass(frozen=True, slots=True)
class AsrTranscriptionRequest:
    audio: AsrAudioChunk = field(repr=False)
    timestamp_mode: AsrTimestampMode = AsrTimestampMode.SEGMENT


@dataclass(frozen=True, slots=True)
class AsrSegmentQuality:
    confidence: float | None = None
    average_log_probability: float | None = None
    compression_ratio: float | None = None
    no_speech_probability: float | None = None
    temperature: float | None = None


@dataclass(frozen=True, slots=True)
class AsrQualityMetadata:
    confidence: float | None = None
    language: str | None = None
    language_confidence: float | None = None
    # Provider's optional verbose duration, not sample-derived or billing usage.
    duration_seconds: Fraction | None = None


@dataclass(frozen=True, slots=True)
class AsrSegment:
    """Unverified text with validated, chunk-relative timing in exact seconds."""

    start: Fraction
    end: Fraction
    text: str = field(repr=False)
    quality: AsrSegmentQuality = field(default_factory=AsrSegmentQuality)


@dataclass(frozen=True, slots=True)
class AsrWord:
    """Provider-reported provisional timing, not independently forced alignment."""

    start: Fraction
    end: Fraction
    text: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class AsrUsage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    cost: Fraction | None = None
    audio_seconds: Fraction | None = None
    reported: bool = False


@dataclass(frozen=True, slots=True)
class AsrProvenance:
    provider: str
    requested_model: str
    resolved_model: str | None = None
    upstream_provider: str | None = None
    inference_config: tuple[tuple[str, str | float], ...] = ()


@dataclass(frozen=True, slots=True)
class AsrCandidate:
    """Provisional evidence only; empty text proves neither silence nor coverage.

    This transient record must not be persisted or logged as a raw transcript.
    """

    text: str = field(repr=False)
    segments: tuple[AsrSegment, ...]
    quality: AsrQualityMetadata
    usage: AsrUsage
    provenance: AsrProvenance
    chunk_id: str = field(repr=False)
    words: tuple[AsrWord, ...] | None = field(default=None, repr=False)


class AsrTranscriber(Protocol):
    def transcribe(self, chunk: AsrAudioChunk) -> AsrCandidate:
        """Return normalized, timestamped provisional evidence or an AsrError."""
        ...


class AsrTranscriberV2(Protocol):
    @property
    def capabilities(self) -> AsrProviderCapabilities:
        ...

    def transcribe_request(self, request: AsrTranscriptionRequest) -> AsrCandidate:
        """Return the requested evidence without silent timestamp downgrades."""
        ...
