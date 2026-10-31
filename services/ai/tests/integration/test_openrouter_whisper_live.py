"""Explicit compatibility probe using transient generated audio only."""

import io
import os
import wave
from fractions import Fraction

import pytest

from sme_meeting_ai.core.config import load_settings
from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
from sme_meeting_ai.transcription import AsrAudioChunk

pytestmark = pytest.mark.live_provider


def test_openrouter_verbose_segment_compatibility():
    if os.environ.get("RUN_OPENROUTER_LIVE_ASR") != "1":
        pytest.skip("Explicit live provider opt-in is required")
    settings = load_settings()
    if settings.openrouter_api_key is None or not settings.openrouter_api_key.get_secret_value().strip():
        pytest.skip("Local OpenRouter credentials are required")
    audio = io.BytesIO()
    with wave.open(audio, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * 32000)
    chunk = AsrAudioChunk("generated-live-probe", audio.getvalue(), Fraction(2))
    with OpenRouterWhisperAdapter(settings) as adapter:
        candidate = adapter.transcribe(chunk)
    # Silence and any recognized text are provisional: neither proves completeness.
    assert isinstance(candidate.text, str)
    assert candidate.provenance.provider == "openrouter"
    assert candidate.chunk_id == chunk.chunk_id
    assert not candidate.text or candidate.segments
    previous_end = Fraction(0)
    for segment in candidate.segments:
        assert isinstance(segment.start, Fraction)
        assert isinstance(segment.end, Fraction)
        assert previous_end <= segment.start < segment.end <= chunk.duration
        previous_end = segment.end
