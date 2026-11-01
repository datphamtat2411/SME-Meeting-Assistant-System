"""Provider-aware OpenRouter Whisper adapter: one transport, no retries/fallbacks."""

import io
import json
import math
import re
import time
import unicodedata
import wave
from decimal import Decimal
from fractions import Fraction
from typing import Self

import httpx

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.transcription.asr import (
    AsrAudioChunk,
    AsrCandidate,
    AsrCapabilityStatus,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrProviderCapabilities,
    AsrQualityMetadata,
    AsrRoutingMode,
    AsrSegment,
    AsrSegmentQuality,
    AsrTimestampMode,
    AsrTranscriptionRequest,
    AsrUsage,
    AsrWord,
)

_ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions"
_MODEL = "openai/whisper-large-v3"
_LANGUAGE = "vi"
_MAX_UPLOAD_BYTES = 25_000_000
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_FINAL_END_TOLERANCE = Fraction(5, 1000)
_STATUS_CATEGORIES = {
    401: AsrErrorCategory.AUTHENTICATION,
    403: AsrErrorCategory.AUTHENTICATION,
    429: AsrErrorCategory.RATE_LIMIT,
    408: AsrErrorCategory.TIMEOUT,
    504: AsrErrorCategory.TIMEOUT,
    524: AsrErrorCategory.TIMEOUT,
    413: AsrErrorCategory.RESOURCE,
}


def _number(value: object) -> Fraction:
    # JSON floats are parsed as Decimal so decimal timestamps remain exact.
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise ValueError
    if isinstance(value, Decimal):
        # A short JSON value such as 1e999999999 must not expand into an enormous
        # Fraction numerator/denominator. Bound representation, without rounding.
        if (not value.is_finite() or abs(value.adjusted()) > 128
                or abs(value.as_tuple().exponent) > 128):
            raise ValueError
    elif abs(value) >= 10 ** 128:
        raise ValueError
    return Fraction(value)


def _optional_number(data: dict, key: str, *, lower=None, upper=None) -> Fraction | None:
    value = data.get(key)
    if value is None:
        return None
    number = _number(value)
    if (lower is not None and number < lower) or (upper is not None and number > upper):
        raise ValueError
    return number


def _quality_number(data: dict, key: str, *, lower=None, upper=None) -> float | None:
    number = _optional_number(data, key, lower=lower, upper=upper)
    if number is None:
        return None
    value = float(number)
    if not math.isfinite(value):
        raise ValueError
    return value


def _optional_identifier(data: dict, key: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or re.fullmatch(r"[a-zA-Z0-9_./: -]{1,256}", value) is None or not value.strip():
        raise ValueError
    return value


def _text(value: object) -> str:
    if (not isinstance(value, str) or any(
        unicodedata.category(c) in ("Cc", "Cf", "Cs") and c not in "\t\r\n" for c in value
    )):
        raise ValueError
    value.encode("utf-8", errors="strict")
    return unicodedata.normalize("NFC", value).strip()


def _tokens(data: dict, key: str) -> int | None:
    value = data.get(key)
    if value is not None and (type(value) is not int or not 0 <= value < 10 ** 128):
        raise ValueError
    return value


def _unique_properties(items):
    data = {}
    for key, value in items:
        if key in data:
            raise ValueError
        data[key] = value
    return data


def _reject_constant(_):
    raise ValueError


def _validate_wav(chunk: AsrAudioChunk) -> None:
    """Require normalized 16 kHz mono s16 PCM and exact physical duration."""
    try:
        payload = chunk.payload
        if len(payload) < 44 or int.from_bytes(payload[4:8], "little") != len(payload) - 8:
            raise ValueError
        with wave.open(io.BytesIO(payload), "rb") as reader:
            frames, rate = reader.getnframes(), reader.getframerate()
            frame_bytes = reader.getnchannels() * reader.getsampwidth()
            if (reader.getnchannels() != 1 or reader.getsampwidth() != 2
                    or rate != 16000 or reader.getcomptype() != "NONE" or frames <= 0
                    or Fraction(frames, 16000) != chunk.duration
                    or len(reader.readframes(frames + 1)) != frames * frame_bytes):
                raise ValueError
        return
    except (ValueError, EOFError, OSError, wave.Error):
        pass
    raise AsrError(AsrErrorCategory.VALIDATION)


class OpenRouterWhisperAdapter:
    """Own and reuse a bounded client, or borrow an injected test client.

    No raw audio, provider response, or candidate text is persisted or logged.
    The caller owns injected clients and must close them itself.
    """

    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self._settings = settings
        self._capabilities = AsrProviderCapabilities(
            gateway="openrouter", model=_MODEL, transport="https-multipart",
            audio_format="wav", response_format="verbose_json",
            timestamp_modes=(AsrTimestampMode.SEGMENT, AsrTimestampMode.SEGMENT_AND_WORD),
            segment_timestamp_status=AsrCapabilityStatus.DOCUMENTED,
            word_timestamp_status=AsrCapabilityStatus.DOCUMENTED,
            word_timestamps_route_dependent=True,
            effective_payload_limit=min(settings.audio_asr_max_payload_bytes, _MAX_UPLOAD_BYTES),
            routing_mode=AsrRoutingMode.ROUTED_UPSTREAM,
            capability_status=AsrCapabilityStatus.DOCUMENTED,
        )
        self._owns_client = client is None
        self._client = client if client is not None else httpx.Client(
            timeout=settings.audio_asr_timeout_seconds,
            trust_env=False,
            follow_redirects=False,
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=4),
        )

    @property
    def capabilities(self) -> AsrProviderCapabilities:
        return self._capabilities

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def transcribe(self, chunk: AsrAudioChunk) -> AsrCandidate:
        """Compatibility boundary for the existing segment-only execution layer."""
        return self.transcribe_request(AsrTranscriptionRequest(
            audio=chunk, timestamp_mode=AsrTimestampMode.SEGMENT,
        ))

    def transcribe_request(self, request: AsrTranscriptionRequest) -> AsrCandidate:
        """Make exactly one request after local validation; discard failure context."""
        try:
            return self._transcribe(request)
        except AsrError as error:
            category = error.category
        except httpx.TimeoutException:
            category = AsrErrorCategory.TIMEOUT
        except httpx.HTTPError:
            category = AsrErrorCategory.TRANSPORT
        except MemoryError:
            category = AsrErrorCategory.RESOURCE
        except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
            category = AsrErrorCategory.MALFORMED_OUTPUT
        # Outside every handler: no hidden request/response-bearing exception chain.
        raise AsrError(category)

    def _transcribe(self, request: AsrTranscriptionRequest) -> AsrCandidate:
        if not isinstance(request, AsrTranscriptionRequest):
            raise AsrError(AsrErrorCategory.VALIDATION)
        chunk = request.audio
        if (
            not isinstance(chunk, AsrAudioChunk)
            or not isinstance(chunk.chunk_id, str) or not chunk.chunk_id.strip()
            or not isinstance(chunk.payload, bytes) or not chunk.payload
            or not isinstance(chunk.duration, Fraction) or chunk.duration <= 0
        ):
            raise AsrError(AsrErrorCategory.VALIDATION)
        if len(chunk.payload) > self.capabilities.effective_payload_limit:
            raise AsrError(AsrErrorCategory.RESOURCE)
        _validate_wav(chunk)
        if (not isinstance(request.timestamp_mode, AsrTimestampMode)
                or request.timestamp_mode not in self.capabilities.timestamp_modes
                or self.capabilities.response_format != "verbose_json"):
            raise AsrError(AsrErrorCategory.VALIDATION)
        secret = self._settings.openrouter_api_key
        key = secret.get_secret_value() if secret is not None else ""
        if not key or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise AsrError(AsrErrorCategory.AUTHENTICATION)
        if (self._settings.audio_asr_model != _MODEL
                or self._settings.audio_asr_language != _LANGUAGE):
            raise AsrError(AsrErrorCategory.VALIDATION)
        granularities = ["segment"]
        if request.timestamp_mode is AsrTimestampMode.SEGMENT_AND_WORD:
            granularities.append("word")
        # httpx's multipart sequence preserves repeated non-file form parts.
        # OpenRouter dynamically selects the upstream; no routing controls are sent.
        parts = [
            ("file", ("chunk.wav", chunk.payload, "audio/wav")),
            ("model", (None, _MODEL)),
            ("language", (None, _LANGUAGE)),
            ("temperature", (None, format(self._settings.audio_asr_temperature, "g"))),
            ("response_format", (None, "verbose_json")),
            *[("timestamp_granularities[]", (None, value)) for value in granularities],
        ]
        deadline = time.monotonic() + self._settings.audio_asr_timeout_seconds
        with self._client.stream(
            "POST", _ENDPOINT,
            headers={"Authorization": f"Bearer {key}"},
            files=parts,
            timeout=self._settings.audio_asr_timeout_seconds,
            follow_redirects=False,
        ) as response:
            if not response.is_success:
                # Never read an error body or use raise_for_status diagnostics.
                raise AsrError(_STATUS_CATEGORIES.get(response.status_code, AsrErrorCategory.PROVIDER))
            body = bytearray()
            for part in response.iter_bytes():
                if time.monotonic() > deadline:
                    raise AsrError(AsrErrorCategory.TIMEOUT)
                if len(body) + len(part) > _MAX_RESPONSE_BYTES:
                    raise AsrError(AsrErrorCategory.RESOURCE)
                body.extend(part)
        data = json.loads(body, parse_float=Decimal, parse_constant=_reject_constant,
                          object_pairs_hook=_unique_properties)
        return self._normalize(data, chunk, request.timestamp_mode)

    def _normalize(
        self, data: object, chunk: AsrAudioChunk,
        timestamp_mode: AsrTimestampMode = AsrTimestampMode.SEGMENT,
    ) -> AsrCandidate:
        if not isinstance(data, dict) or not isinstance(data.get("segments"), list):
            raise ValueError
        if "error" in data or ("task" in data and data["task"] != "transcribe"):
            raise ValueError
        text = _text(data["text"])
        segments = []
        previous_end = Fraction(0)
        for index, item in enumerate(data["segments"]):
            if not isinstance(item, dict):
                raise ValueError
            start, end = _number(item["start"]), _number(item["end"])
            # Validate original ordering before any narrowly scoped end repair.
            if not previous_end <= start < end:
                raise ValueError
            if end > chunk.duration:
                if (index != len(data["segments"]) - 1
                        or end - chunk.duration > _FINAL_END_TOLERANCE):
                    raise ValueError
                end = chunk.duration
            if not previous_end <= start < end <= chunk.duration:
                raise ValueError
            segments.append(AsrSegment(
                start=start, end=end, text=_text(item["text"]),
                quality=AsrSegmentQuality(
                    confidence=_quality_number(item, "confidence", lower=0, upper=1),
                    average_log_probability=_quality_number(item, "avg_logprob", upper=0),
                    compression_ratio=_quality_number(item, "compression_ratio", lower=0),
                    no_speech_probability=_quality_number(item, "no_speech_prob", lower=0, upper=1),
                    temperature=_quality_number(item, "temperature", lower=0, upper=1),
                ),
            ))
            previous_end = end
        if bool(text) != any(segment.text for segment in segments):
            raise ValueError
        words = None
        if timestamp_mode is AsrTimestampMode.SEGMENT_AND_WORD:
            if not isinstance(data.get("words"), list):
                raise ValueError
            normalized_words = []
            previous_end = Fraction(0)
            for item in data["words"]:
                if not isinstance(item, dict):
                    raise ValueError
                start, end = _number(item["start"]), _number(item["end"])
                word_text = _text(item["word"])
                # Word timing is actual evidence, never synthesized/aligned from
                # segment text. The final-segment end tolerance does not apply.
                if not word_text or not previous_end <= start < end <= chunk.duration:
                    raise ValueError
                normalized_words.append(AsrWord(start=start, end=end, text=word_text))
                previous_end = end
            words = tuple(normalized_words)
            if bool(text) != bool(words):
                raise ValueError
        usage = data.get("usage")
        if usage is None:
            usage = {}
        if not isinstance(usage, dict):
            raise ValueError
        # STT usage is not the chat-completions schema. Never infer billing from
        # duration, chunk samples, tokens or price tables; zero is a real value.
        input_tokens = _tokens(usage, "input_tokens")
        output_tokens = _tokens(usage, "output_tokens")
        total_tokens = _tokens(usage, "total_tokens")
        if total_tokens is not None:
            if any(value is not None and value > total_tokens for value in (input_tokens, output_tokens)):
                raise ValueError
            if (input_tokens is not None and output_tokens is not None
                    and input_tokens + output_tokens != total_tokens):
                raise ValueError
        return AsrCandidate(
            text=text, segments=tuple(segments), chunk_id=chunk.chunk_id, words=words,
            quality=AsrQualityMetadata(
                confidence=_quality_number(data, "confidence", lower=0, upper=1),
                language=_optional_identifier(data, "language"),
                language_confidence=_quality_number(data, "language_probability", lower=0, upper=1),
                duration_seconds=_optional_number(data, "duration", lower=0),
            ),
            usage=AsrUsage(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                cost=_optional_number(usage, "cost", lower=0),
                audio_seconds=_optional_number(usage, "seconds", lower=0),
                reported=data.get("usage") is not None,
            ),
            provenance=AsrProvenance(
                provider="openrouter", requested_model=_MODEL,
                resolved_model=_optional_identifier(data, "model"),
                upstream_provider=_optional_identifier(data, "provider"),
                inference_config=(
                    ("language", self._settings.audio_asr_language),
                    ("temperature", self._settings.audio_asr_temperature),
                    ("response_format", "verbose_json"),
                    ("timestamp_granularity", timestamp_mode.value),
                ),
            ),
        )
