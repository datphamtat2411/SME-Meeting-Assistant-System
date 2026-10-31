"""Synchronous OpenRouter Whisper compatibility adapter, with no retries."""

import json
import math
import re
import time
import unicodedata
from decimal import Decimal
from fractions import Fraction
from typing import Self

import httpx

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.transcription.asr import (
    AsrAudioChunk,
    AsrCandidate,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrSegmentQuality,
    AsrUsage,
)

_ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions"
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
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
    if isinstance(value, Decimal) and not value.is_finite():
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
    if not isinstance(value, str):
        raise ValueError
    return unicodedata.normalize("NFC", value).strip()


def _tokens(data: dict, key: str) -> int | None:
    value = data.get(key)
    if value is not None and (type(value) is not int or value < 0):
        raise ValueError
    return value


class OpenRouterWhisperAdapter:
    """Own and reuse a bounded client, or borrow an injected test client.

    No raw audio, provider response, or candidate text is persisted or logged.
    The caller owns injected clients and must close them itself.
    """

    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self._settings = settings
        self._owns_client = client is None
        self._client = client if client is not None else httpx.Client(
            timeout=settings.audio_asr_timeout_seconds,
            trust_env=False,
            follow_redirects=False,
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def transcribe(self, chunk: AsrAudioChunk) -> AsrCandidate:
        """Make exactly one request after local validation; discard failure context."""
        try:
            return self._transcribe(chunk)
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

    def _transcribe(self, chunk: AsrAudioChunk) -> AsrCandidate:
        if (
            not isinstance(chunk, AsrAudioChunk)
            or not isinstance(chunk.chunk_id, str) or not chunk.chunk_id.strip()
            or not isinstance(chunk.payload, bytes) or not chunk.payload
            or not isinstance(chunk.duration, Fraction) or chunk.duration <= 0
        ):
            raise AsrError(AsrErrorCategory.VALIDATION)
        if len(chunk.payload) > self._settings.audio_asr_max_payload_bytes:
            raise AsrError(AsrErrorCategory.RESOURCE)
        secret = self._settings.openrouter_api_key
        key = secret.get_secret_value() if secret is not None else ""
        if not key or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise AsrError(AsrErrorCategory.AUTHENTICATION)
        deadline = time.monotonic() + self._settings.audio_asr_timeout_seconds
        with self._client.stream(
            "POST", _ENDPOINT,
            headers={"Authorization": f"Bearer {key}"},
            data={
                "model": self._settings.audio_asr_model,
                "language": self._settings.audio_asr_language,
                "temperature": format(self._settings.audio_asr_temperature, "g"),
                "response_format": "verbose_json",
                "timestamp_granularities[]": "segment",
            },
            files={"file": ("chunk.wav", chunk.payload, "audio/wav")},
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
        data = json.loads(body, parse_float=Decimal, parse_constant=Decimal)
        return self._normalize(data, chunk)

    def _normalize(self, data: object, chunk: AsrAudioChunk) -> AsrCandidate:
        if not isinstance(data, dict) or not isinstance(data.get("segments"), list):
            raise ValueError
        text = _text(data["text"])
        segments = []
        previous_end = Fraction(0)
        for item in data["segments"]:
            if not isinstance(item, dict):
                raise ValueError
            start, end = _number(item["start"]), _number(item["end"])
            if not previous_end <= start < end <= chunk.duration:
                raise ValueError
            segments.append(AsrSegment(
                start=start, end=end, text=_text(item["text"]),
                quality=AsrSegmentQuality(
                    confidence=_quality_number(item, "confidence", lower=0, upper=1),
                    average_log_probability=_quality_number(item, "avg_logprob"),
                    compression_ratio=_quality_number(item, "compression_ratio", lower=0),
                    no_speech_probability=_quality_number(item, "no_speech_prob", lower=0, upper=1),
                    temperature=_quality_number(item, "temperature", lower=0, upper=1),
                ),
            ))
            previous_end = end
        if text and not segments:
            raise ValueError
        usage = data.get("usage")
        if usage is None:
            usage = {}
        if not isinstance(usage, dict):
            raise ValueError
        audio_seconds = _optional_number(usage, "audio_seconds", lower=0)
        if audio_seconds is None:
            audio_seconds = _optional_number(data, "duration", lower=0)
        return AsrCandidate(
            text=text, segments=tuple(segments), chunk_id=chunk.chunk_id,
            quality=AsrQualityMetadata(
                confidence=_quality_number(data, "confidence", lower=0, upper=1),
                language=_optional_identifier(data, "language"),
                language_confidence=_quality_number(data, "language_probability", lower=0, upper=1),
            ),
            usage=AsrUsage(
                input_tokens=_tokens(usage, "prompt_tokens"),
                output_tokens=_tokens(usage, "completion_tokens"),
                total_tokens=_tokens(usage, "total_tokens"),
                cost=_optional_number(usage, "cost", lower=0),
                audio_seconds=audio_seconds,
            ),
            provenance=AsrProvenance(
                provider="openrouter", requested_model=self._settings.audio_asr_model,
                resolved_model=_optional_identifier(data, "model"),
                upstream_provider=_optional_identifier(data, "provider"),
                inference_config=(
                    ("language", self._settings.audio_asr_language),
                    ("temperature", self._settings.audio_asr_temperature),
                    ("response_format", "verbose_json"),
                    ("timestamp_granularity", "segment"),
                ),
            ),
        )
