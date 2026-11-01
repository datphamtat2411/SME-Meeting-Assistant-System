from dataclasses import FrozenInstanceError, fields, replace
from fractions import Fraction

import httpx
import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
from sme_meeting_ai.transcription import (
    AsrAudioChunk,
    AsrCandidate,
    AsrCapabilityStatus,
    AsrProvenance,
    AsrProviderCapabilities,
    AsrQualityMetadata,
    AsrRoutingMode,
    AsrTimestampMode,
    AsrTranscriberV2,
    AsrTranscriptionRequest,
    AsrUsage,
    AsrWord,
)


def settings(**overrides):
    return Settings(service_name="test-ai", service_identity="ai-core", _env_file=None, **overrides)


def test_openrouter_capabilities_are_immutable_documented_not_live_verified():
    config = settings(audio_asr_max_payload_bytes=26_214_400)
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("network I/O"))) as client:
        adapter: AsrTranscriberV2 = OpenRouterWhisperAdapter(config, client)
        capabilities = adapter.capabilities
        assert isinstance(capabilities, AsrProviderCapabilities)
        assert capabilities.gateway == "openrouter"
        assert capabilities.model == "openai/whisper-large-v3"
        assert capabilities.transport == "https-multipart"
        assert capabilities.audio_format == "wav"
        assert capabilities.response_format == "verbose_json"
        assert capabilities.timestamp_modes == (
            AsrTimestampMode.SEGMENT, AsrTimestampMode.SEGMENT_AND_WORD,
        )
        assert capabilities.segment_timestamp_status is AsrCapabilityStatus.DOCUMENTED
        assert capabilities.word_timestamp_status is AsrCapabilityStatus.DOCUMENTED
        assert capabilities.word_timestamps_route_dependent is True
        assert capabilities.capability_status is AsrCapabilityStatus.DOCUMENTED
        assert capabilities.effective_payload_limit == 25_000_000
        assert capabilities.verified_duration_ceiling is None  # Unknown, not unlimited.
        with pytest.raises(FrozenInstanceError):
            capabilities.model = "another-model"
        assert adapter.capabilities is capabilities


def test_dynamic_routing_has_no_upstream_preference_or_strict_provider_gate():
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("network I/O"))) as client:
        capabilities = OpenRouterWhisperAdapter(settings(), client).capabilities
        assert capabilities.gateway == "openrouter"
        assert capabilities.routing_mode is AsrRoutingMode.ROUTED_UPSTREAM
        assert not hasattr(capabilities, "desired_upstream")
        assert not hasattr(capabilities, "upstream_pin_supported")
        assert not hasattr(capabilities, "can_guarantee_upstream")


def test_capability_limit_respects_smaller_configured_bound():
    with httpx.Client(transport=httpx.MockTransport(lambda _: pytest.fail("network I/O"))) as client:
        capabilities = OpenRouterWhisperAdapter(
            settings(audio_asr_max_payload_bytes=4096), client,
        ).capabilities
    assert capabilities.effective_payload_limit == 4096


def test_request_word_and_candidate_contracts_are_additive_immutable_and_private():
    audio = AsrAudioChunk("private-identity", b"private-audio", Fraction(2))
    request = AsrTranscriptionRequest(audio)
    word = AsrWord(Fraction(1, 32000), Fraction(1, 2), "riêng tư riêng tư")
    assert request.audio is audio
    assert request.timestamp_mode is AsrTimestampMode.SEGMENT
    assert [item.name for item in fields(AsrWord)] == ["start", "end", "text"]
    # Existing positional candidate construction remains valid.
    candidate = AsrCandidate("private-transcript", (), AsrQualityMetadata(), AsrUsage(),
                             AsrProvenance("openrouter", "openai/whisper-large-v3"), "private-identity")
    assert candidate.words is None
    with_words = replace(candidate, words=(word,))
    assert with_words.words == (word,)
    for obj in (request, word, candidate, with_words):
        for marker in ("private-audio", "private-transcript", "private-identity", word.text):
            assert marker not in repr(obj)
    for obj, name, value in (
        (request, "timestamp_mode", AsrTimestampMode.SEGMENT_AND_WORD),
        (word, "text", "changed"), (with_words, "words", ()),
    ):
        with pytest.raises(FrozenInstanceError):
            setattr(obj, name, value)
