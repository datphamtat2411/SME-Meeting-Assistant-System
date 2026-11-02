"""Actual acoustic geometry and spending authorization, without model calls."""

from dataclasses import FrozenInstanceError
from fractions import Fraction

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.transcription.asr import AsrAudioChunk, AsrError, AsrErrorCategory
from sme_meeting_ai.transcription.asr_strategy import AsrStrategyRunner
from sme_meeting_ai.transcription.chunk_planning import SpeechAwareAsrChunkPlanner

from .test_asr_strategy import Provider, prepare
from .test_chunk_planning import result_factory as result_factory  # noqa: F401


@pytest.mark.parametrize("approved", [20, 42, 43, 256])
def test_long_recording_uses_actual_27_chunk_plan_and_fails_before_spending(result_factory, approved):
    config = Settings(_env_file=None, service_name="test-ai", service_identity="ai-core",
                      audio_asr_max_total_calls=approved)
    preprocessing = result_factory(8476374)
    provider = Provider()
    runner = AsrStrategyRunner(provider, config)
    planner = SpeechAwareAsrChunkPlanner(config)
    if approved < 43:
        with pytest.raises(AsrError) as caught:
            runner.prepare(preprocessing, planner)
        assert caught.value.category is AsrErrorCategory.RESOURCE
    else:
        runner.prepare(preprocessing, planner)
        assert len(runner.plan.chunks) == 27
        assert runner.plan.chunks[-1].core_interval.end_sample == 8476374
    envelope = runner.telemetry.resource_plan
    assert envelope.baseline_calls == 27
    assert envelope.supplemental_calls == 16
    assert envelope.native_calls == 0
    assert envelope.maximum_calls == 43
    assert envelope.authorized_calls == approved
    assert envelope.source_sample_count == 8476374
    assert envelope.maximum_request_samples == 480000
    assert envelope.effective_payload_limit == 25000000
    assert provider.calls == []
    with pytest.raises(FrozenInstanceError):
        envelope.authorized_calls = 999


@pytest.mark.parametrize("mode", ["chunked", "adaptive"])
def test_common_ceiling_applies_in_both_modes_before_any_request(result_factory, mode):
    provider = Provider()
    with pytest.raises(AsrError) as caught:
        prepare(result_factory, provider=provider, audio_asr_strategy_mode=mode,
                audio_asr_max_total_calls=1)
    assert caught.value.category is AsrErrorCategory.RESOURCE
    assert provider.calls == []


def test_baseline_requirement_is_not_the_configured_maximum_chunk_capacity(result_factory):
    runner, _, provider, _ = prepare(
        result_factory, audio_asr_strategy_mode="chunked", audio_asr_chunk_max_chunks=4096,
        audio_asr_recovery_max_total_attempts=2, audio_asr_max_total_calls=3,
    )
    assert runner.telemetry.resource_plan.baseline_calls == 1
    assert runner.telemetry.resource_plan.maximum_calls == 3
    assert not provider.calls


def test_failed_calls_consume_authorization_and_atomic_guard_prevents_overrun(result_factory):
    def fail(*_):
        raise AsrError(AsrErrorCategory.PROVIDER)

    runner, _, provider, _ = prepare(
        result_factory, provider=Provider(fail), audio_asr_strategy_mode="chunked",
        audio_asr_recovery_max_total_attempts=1, audio_asr_max_total_calls=2,
    )
    audio = AsrAudioChunk("chunk-000000", b"synthetic fake-provider payload", Fraction(1))
    for _ in range(2):
        with pytest.raises(AsrError) as caught:
            runner._bridge.transcribe(audio)
        assert caught.value.category is AsrErrorCategory.PROVIDER
    with pytest.raises(AsrError) as caught:
        runner._bridge.transcribe(audio)
    assert caught.value.category is AsrErrorCategory.RESOURCE
    assert len(provider.calls) == runner.telemetry.total_actual_asr_calls == 2


@pytest.mark.parametrize("value", [True, 0, -1, 1.5, 65794])
def test_authorization_is_a_bounded_strict_integer(value):
    with pytest.raises(ValueError):
        Settings(_env_file=None, service_name="test-ai", service_identity="ai-core",
                 audio_asr_max_total_calls=value)
