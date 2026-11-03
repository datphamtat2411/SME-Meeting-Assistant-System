"""T03 execution contracts; synthetic WAVs and borrowed fake V2 providers only."""

import traceback
import wave
from concurrent.futures import CancelledError
from dataclasses import FrozenInstanceError, replace
from fractions import Fraction

import pytest

from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrCapabilityStatus,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrProviderCapabilities,
    AsrQualityMetadata,
    AsrRoutingMode,
    AsrSegment,
    AsrTimestampMode,
    AsrUsage,
)
from sme_meeting_ai.transcription.asr_strategy import (
    AsrStrategy,
    AsrStrategyRunner,
    build_whole_file_plan,
)
from sme_meeting_ai.transcription.chunk_planning import (
    SpeechAwareAsrChunkPlanner,
    validate_asr_chunk_plan,
)

from .test_chunk_planning import result_factory as result_factory  # noqa: F401
from .test_chunk_planning import settings

PRIVATE = "sensitive-audio-text-provider-marker"
CAPABILITIES = AsrProviderCapabilities(
    "openrouter", "openai/whisper-large-v3", "https-multipart", "wav", "verbose_json",
    (AsrTimestampMode.SEGMENT,), AsrCapabilityStatus.DOCUMENTED,
    AsrCapabilityStatus.UNKNOWN, True, 25_000_000,
    AsrRoutingMode.ROUTED_UPSTREAM, AsrCapabilityStatus.DOCUMENTED,
)


class Provider:
    capabilities = CAPABILITIES

    def __init__(self, callback=None):
        self.calls = []
        self.callback = callback

    def transcribe_request(self, request):
        audio = request.audio
        self.calls.append((audio.chunk_id, audio.duration, request.timestamp_mode, len(audio.payload)))
        assert request.timestamp_mode is AsrTimestampMode.SEGMENT
        if self.callback:
            value = self.callback(audio, len(self.calls))
            if value is not None:
                return value
        return candidate(audio)

    def transcribe(self, audio):
        pytest.fail("V2 provider should receive explicit segment requests")


def candidate(audio, segments=None, *, cost=Fraction(1, 100), upstream="DeepInfra"):
    segments = segments if segments is not None else (
        AsrSegment(Fraction(0), audio.duration, "Xin chào Việt Nam"),
    )
    return AsrCandidate(
        " ".join(s.text for s in segments), tuple(segments), AsrQualityMetadata(language="vi"),
        AsrUsage(cost=cost, reported=cost is not None),
        AsrProvenance("openrouter", "openai/whisper-large-v3", "openai/whisper-large-v3",
                      upstream, (("language", "vi"), ("prompt", PRIVATE))), audio.chunk_id,
    )


def prepare(result_factory, *, count=1000, provider=None, planner=None, **overrides):
    config = settings(**({"audio_asr_strategy_mode": "adaptive"} | overrides))
    result = result_factory(count)
    with wave.open(str(result.normalized_artifact.path), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes((PRIVATE.encode() * (count * 2 // len(PRIVATE) + 1))[:count * 2])
    provider = provider or Provider()
    runner = AsrStrategyRunner(provider, config)
    decision = runner.prepare(result, planner or SpeechAwareAsrChunkPlanner(config))
    return runner, result, provider, decision


@pytest.mark.parametrize("recovery_budget", [2, 3])
def test_decoder_rechecks_share_the_recording_envelope_with_recovery(result_factory, recovery_budget):
    seen = set()

    def respond(audio, _):
        first = audio.chunk_id not in seen
        seen.add(audio.chunk_id)
        text = ("Hãy subscribe cho kênh Ghiền Mì Gõ để không bỏ lỡ những video hấp dẫn" if first else
                "Nhóm xác nhận đầy đủ nội dung thời hạn triển khai và kết quả kiểm thử vào ngày mai")
        return candidate(audio, (AsrSegment(Fraction(0), audio.duration, text),))

    runner, result, provider, _ = prepare(
        result_factory, count=64000, provider=Provider(respond), audio_asr_strategy_mode="chunked",
        audio_asr_recovery_max_total_attempts=recovery_budget,
    )
    execution = runner.execute(result.normalized_artifact)
    assert len(execution.plan.chunks) == 2
    assert len(provider.calls) == 4
    recovered = runner.recover(result, execution)
    assert len(provider.calls) <= len(execution.plan.chunks) + recovery_budget
    assert runner.telemetry.total_actual_asr_calls == len(provider.calls)
    assert runner.telemetry.decoder_recheck_calls == 2
    assert runner.telemetry.resource_plan.supplemental_calls == recovery_budget
    assert runner.telemetry.resource_plan.maximum_calls == len(execution.plan.chunks) + recovery_budget
    assert len(recovered.attempts) <= recovery_budget - 2
    if recovery_budget == 2:
        assert not recovered.attempts and runner.telemetry.recovery_calls == 0


@pytest.mark.parametrize("mode,reason,strategy", [
    ("chunked", "adaptive-disabled", AsrStrategy.CHUNKED),
    ("adaptive", "native-eligible", AsrStrategy.WHOLE_FILE),
])
def test_default_and_adaptive_decisions_are_immutable_deterministic(result_factory, mode, reason, strategy):
    runner, result, provider, decision = prepare(result_factory, audio_asr_strategy_mode=mode)
    assert provider.calls == []
    assert decision.selected_strategy is strategy and decision.reason == reason
    assert decision.estimated_payload_bytes == 2044
    assert decision == runner.prepare(result, SpeechAwareAsrChunkPlanner(settings()))
    with pytest.raises(FrozenInstanceError):
        decision.reason = PRIVATE


@pytest.mark.parametrize("ceiling,reason", [(999, "native-sample-limit"), (1000, "native-eligible"),
                                          (1001, "native-eligible")])
def test_exact_sample_ceiling(result_factory, ceiling, reason):
    _, _, provider, decision = prepare(result_factory, audio_asr_native_max_samples=ceiling)
    assert decision.reason == reason and not provider.calls


@pytest.mark.parametrize("limit,reason", [(2043, "native-payload-limit"), (2044, "native-eligible")])
@pytest.mark.parametrize("provider_limit", [False, True])
def test_exact_serialized_payload_and_effective_limit(result_factory, limit, reason, provider_limit):
    provider = Provider()
    provider.capabilities = replace(CAPABILITIES, effective_payload_limit=limit if provider_limit else 25_000_000)
    runner, result, provider, decision = prepare(
        result_factory, provider=provider, audio_asr_max_payload_bytes=25_000_000 if provider_limit else limit,
        # T04 forced contexts must be feasible under this tiny upload limit.
        # Keep a preferred target larger than the effective core to exercise
        # resource-bound planning rather than weakening payload admission.
        audio_asr_chunk_target_samples=1024, audio_asr_chunk_max_request_samples=1536,
        audio_asr_chunk_overlap_samples=128, audio_asr_chunk_boundary_search_samples=0,
    )
    assert decision.reason == reason and decision.effective_payload_limit == limit
    execution = runner.execute(result.normalized_artifact)
    assert execution.selected_strategy.value == ("whole-file" if limit == 2044 else "chunked")
    if limit == 2043:
        assert all(call[1] < Fraction(1000, 16000) for call in provider.calls)
        assert runner.telemetry.native_attempts == 0
    assert runner._fallback_plan.provenance.effective_configuration["effective_payload_limit"] == limit
    assert all(call[3] <= limit for call in provider.calls)


@pytest.mark.parametrize("changes", [
    {"response_format": "json"}, {"timestamp_modes": ()}, {"model": "unapproved/model"},
    {"gateway": "other"}, {"segment_timestamp_status": AsrCapabilityStatus.UNKNOWN},
    {"routing_mode": "pinned"}, {"audio_format": "mp3"}, {"transport": "base64"},
    {"effective_payload_limit": True}, {"verified_duration_ceiling": Fraction(1, 100)},
    {"timestamp_modes": ("segment",)}, {"segment_timestamp_status": "documented"},
])
def test_incompatible_capabilities_select_chunked_before_calls(result_factory, changes):
    provider = Provider()
    provider.capabilities = replace(CAPABILITIES, **changes)
    if "verified_duration_ceiling" in changes:
        # A real provider ceiling below the configured forced context makes the
        # fallback infeasible too. Reject before any request, not just native.
        with pytest.raises(AsrError) as caught:
            prepare(result_factory, provider=provider)
        assert caught.value.category is AsrErrorCategory.RESOURCE and not provider.calls
        return
    _, _, provider, decision = prepare(result_factory, provider=provider)
    assert decision.reason == "unsupported-provider-capability" and not provider.calls


def test_missing_v2_and_unapproved_language(result_factory):
    class Legacy:
        def transcribe(self, audio):
            return candidate(audio)

    _, _, _, decision = prepare(result_factory, provider=Legacy())
    assert decision.reason == "missing-v2-contract"
    _, _, _, decision = prepare(result_factory, audio_asr_language="en")
    assert decision.reason == "unsupported-provider-capability"


def test_native_plan_truthful_geometry_and_provenance(result_factory):
    runner, result, provider, _ = prepare(
        result_factory, count=640000, audio_asr_chunk_target_samples=320000,
        audio_asr_chunk_max_request_samples=480000, audio_asr_chunk_overlap_samples=80000,
    )
    plan = runner.plan
    validate_asr_chunk_plan(plan)
    assert plan.provenance.planner_version == "whole-file-v1"
    assert plan.source_id == result.normalized_artifact.source_id and plan.sample_count == 640000
    assert plan.provenance.preprocessing == result.provenance
    assert len(plan.chunks) == 1
    chunk, = plan.chunks
    assert chunk.chunk_id == "chunk-000000" and chunk.ordinal == 0
    assert chunk.core_interval == chunk.request_interval
    assert (chunk.core_interval.start_sample, chunk.core_interval.end_sample) == (0, 640000)
    assert plan.provenance.effective_configuration["overlap_samples"] == 0
    execution = runner.execute(result.normalized_artifact)
    assert execution.plan is plan and len(execution.baseline) == len(provider.calls) == 1
    assert execution.telemetry.native_successes == 1


def test_off_grid_adjacent_long_paused_and_genuine_repeated_segments(result_factory):
    segments = (
        AsrSegment(Fraction(1, 32000), Fraction(1, 3), "Đồng ý, đồng ý"),
        AsrSegment(Fraction(1, 3), Fraction(25), "Đồng ý, đồng ý"),
        AsrSegment(Fraction(30), Fraction(40), "Triển khai API và báo cáo"),
    )
    provider = Provider(lambda audio, _: candidate(audio, segments))
    runner, result, _, _ = prepare(
        result_factory, count=640000, provider=provider, audio_asr_chunk_target_samples=320000,
        audio_asr_chunk_max_request_samples=480000, audio_asr_chunk_overlap_samples=80000,
    )
    execution = runner.execute(result.normalized_artifact)
    translated = execution.baseline[0].timeline_segments
    assert [t.segment for t in translated] == list(segments)
    assert [(t.interval.start_sample, t.interval.end_sample) for t in translated] == [
        (0, 5333), (5333, 400000), (480000, 640000),
    ]


@pytest.mark.parametrize("bounds", [
    ((1, 0),), ((-1, 1),), ((0, Fraction(1, 25)), (Fraction(1, 50), Fraction(1, 20))),
    ((0, 2),), None,
])
def test_malformed_native_timestamps_are_discarded_before_fallback(result_factory, bounds):
    def respond(audio, number):
        if number == 1:
            segments = () if bounds is None else tuple(
                AsrSegment(Fraction(a), Fraction(b), PRIVATE) for a, b in bounds
            )
            return replace(candidate(audio, segments), text=PRIVATE)

    runner, result, provider, _ = prepare(result_factory, provider=Provider(respond))
    execution = runner.execute(result.normalized_artifact)
    assert execution.selected_strategy is AsrStrategy.CHUNKED
    assert execution.telemetry.fallback_reason is AsrErrorCategory.MALFORMED_OUTPUT
    assert PRIVATE not in repr(execution) + repr(execution.telemetry)
    assert all(PRIVATE not in r.candidate.text for r in execution.baseline)
    assert len(provider.calls) == 1 + len(execution.plan.chunks)


@pytest.mark.parametrize("category", [AsrErrorCategory.TIMEOUT, AsrErrorCategory.TRANSPORT,
                                      AsrErrorCategory.PROVIDER, AsrErrorCategory.MALFORMED_OUTPUT])
def test_one_bounded_fallback_and_actual_accounting(result_factory, category, monkeypatch):
    clock = iter(range(0, 100000, 10))
    monkeypatch.setattr("sme_meeting_ai.transcription.asr_strategy.time.monotonic_ns", lambda: next(clock))

    def respond(audio, number):
        if number == 1:
            raise AsrError(category)

    runner, result, provider, _ = prepare(result_factory, provider=Provider(respond))
    execution = runner.execute(result.normalized_artifact)
    telemetry = execution.telemetry
    assert telemetry.native_attempts == telemetry.native_failures == 1
    assert telemetry.native_successes == 0 and telemetry.fallback_used
    assert telemetry.fallback_reason is category
    assert telemetry.chunked_baseline_calls == len(execution.plan.chunks)
    assert telemetry.recovery_calls == 0
    assert telemetry.total_actual_asr_calls == len(provider.calls)
    assert telemetry.reported_cost_call_count == len(provider.calls) - 1
    assert telemetry.reported_asr_cost is None
    assert telemetry.reported_cost_subtotal == Fraction(len(provider.calls) - 1, 100)
    assert telemetry.native_duration_ns > 0 and telemetry.chunked_duration_ns > 0
    assert telemetry.total_asr_duration_ns == telemetry.native_duration_ns + telemetry.chunked_duration_ns
    assert len({call[0] for call in provider.calls[1:]}) == len(provider.calls) - 1


@pytest.mark.parametrize("category", [AsrErrorCategory.AUTHENTICATION, AsrErrorCategory.VALIDATION,
                                      AsrErrorCategory.RATE_LIMIT, AsrErrorCategory.RESOURCE])
def test_terminal_native_failure_never_falls_back(result_factory, category):
    def respond(audio, number):
        raise AsrError(category)

    runner, result, provider, _ = prepare(result_factory, provider=Provider(respond))
    with pytest.raises(AsrError) as caught:
        runner.execute(result.normalized_artifact)
    assert caught.value.category is category
    assert len(provider.calls) == 1 and not runner.telemetry.fallback_used
    assert runner.telemetry.native_failures == 1


def test_failed_fallback_reports_actual_failure_and_retains_native_failure(result_factory):
    def respond(audio, number):
        raise AsrError(AsrErrorCategory.TIMEOUT if number == 1 else AsrErrorCategory.AUTHENTICATION)

    runner, result, provider, _ = prepare(result_factory, provider=Provider(respond))
    with pytest.raises(AsrError) as caught:
        runner.execute(result.normalized_artifact)
    assert caught.value.category is AsrErrorCategory.AUTHENTICATION
    assert runner.telemetry.selected_strategy is AsrStrategy.CHUNKED
    assert runner.telemetry.fallback_reason is AsrErrorCategory.TIMEOUT
    assert runner.telemetry.total_actual_asr_calls == len(provider.calls)


def test_preflight_budget_and_payload_geometry_never_spend_native_first(result_factory):
    provider = Provider()
    with pytest.raises(AsrError) as caught:
        prepare(result_factory, provider=provider, audio_asr_adaptive_max_total_calls=1)
    assert caught.value.category is AsrErrorCategory.RESOURCE and provider.calls == []
    # Construct the planner before applying an impossible effective request cap;
    # this exercises the strategy's public preflight error boundary, not __init__.
    with pytest.raises(AsrError) as caught:
        prepare(result_factory, provider=provider, planner=SpeechAwareAsrChunkPlanner(settings()),
                audio_asr_max_payload_bytes=45)
    assert caught.value.category is AsrErrorCategory.RESOURCE
    assert caught.value.__cause__ is caught.value.__context__ is None
    assert provider.calls == []


@pytest.mark.parametrize("allow_native", [False, True])
def test_budget_boundary_can_require_chunked_without_native_spend(result_factory, allow_native):
    # Budget the actual T04 plan, not the historical V1 chunk-count constant.
    config = settings()
    planned = SpeechAwareAsrChunkPlanner(config).plan(result_factory(1000))
    required = len(planned.chunks) + config.audio_asr_recovery_max_total_attempts
    budget = required + int(allow_native)
    runner, result, provider, decision = prepare(result_factory, audio_asr_adaptive_max_total_calls=budget)
    assert decision.reason == ("native-eligible" if allow_native else "chunked-required") and provider.calls == []
    execution = runner.execute(result.normalized_artifact)
    assert execution.telemetry.native_attempts == int(allow_native)
    assert execution.telemetry.total_actual_asr_calls <= budget


def test_provider_duration_ceiling_is_bound_before_chunk_planning(result_factory):
    provider = Provider()
    provider.capabilities = replace(CAPABILITIES, verified_duration_ceiling=Fraction(1, 16))
    runner, result, provider, decision = prepare(
        result_factory, count=2048, provider=provider, audio_asr_chunk_target_samples=1024,
        audio_asr_chunk_max_request_samples=1536, audio_asr_chunk_overlap_samples=128,
        audio_asr_chunk_boundary_search_samples=0,
    )
    assert decision.selected_strategy is AsrStrategy.CHUNKED and not provider.calls
    assert runner.plan.provenance.effective_configuration["provider_max_request_samples"] == 1000
    runner.execute(result.normalized_artifact)
    assert all(duration <= Fraction(1, 16) for _, duration, _, _ in provider.calls)


def test_unknown_provider_identifier_is_not_public_diagnostics(result_factory):
    runner, result, _, _ = prepare(result_factory, provider=Provider(
        lambda audio, _: candidate(audio, upstream=PRIVATE),
    ))
    telemetry = runner.execute(result.normalized_artifact).telemetry
    assert PRIVATE not in repr(telemetry)
    assert telemetry.provider_provenance[0][2].upstream_provider.startswith("sha256-")


def test_actual_payload_and_normalized_wav_are_validated_before_inference(result_factory):
    runner, result, provider, _ = prepare(result_factory)
    result.normalized_artifact.path.write_bytes(PRIVATE.encode())
    with pytest.raises(AsrError):
        runner.execute(result.normalized_artifact)
    assert provider.calls == []


def test_cancellation_and_sensitive_errors_never_trigger_extra_calls(result_factory, caplog):
    def cancel(audio, number):
        raise CancelledError()

    runner, result, provider, _ = prepare(result_factory, provider=Provider(cancel))
    with pytest.raises(CancelledError):
        runner.execute(result.normalized_artifact)
    assert len(provider.calls) == 1 and not runner.telemetry.fallback_used

    def fail(audio, number):
        raise RuntimeError(PRIVATE)

    runner, result, provider, _ = prepare(result_factory, provider=Provider(fail))
    with pytest.raises(AsrError) as caught:
        runner.execute(result.normalized_artifact)
    assert PRIVATE not in "".join(traceback.format_exception(caught.value))
    assert PRIVATE not in repr(runner.telemetry) and not caplog.records


@pytest.mark.parametrize("cost", [None, Fraction(0), Fraction(7, 1000)])
def test_native_reported_cost_and_routed_provenance(result_factory, cost):
    runner, result, _, _ = prepare(result_factory, provider=Provider(
        lambda audio, _: candidate(audio, cost=cost, upstream="Together"),
    ))
    telemetry = runner.execute(result.normalized_artifact).telemetry
    assert telemetry.total_actual_asr_calls == 1 and telemetry.recovery_calls == 0
    assert telemetry.reported_asr_cost == cost
    assert telemetry.reported_cost_call_count == int(cost is not None)
    assert telemetry.provider_provenance[0][2].upstream_provider == "Together"
    assert PRIVATE not in repr(telemetry)


def test_native_builder_enforces_eligibility(result_factory):
    config = settings(audio_asr_native_max_samples=999)
    with pytest.raises(Exception, match="VALIDATION|validation"):
        build_whole_file_plan(result_factory(1000), config, 2044)


@pytest.mark.parametrize("cost", [None, Fraction(7, 1000)])
def test_rejected_recovery_is_still_an_actual_routed_billed_request(result_factory, monkeypatch, cost):
    from sme_meeting_ai.transcription.coverage import CoveragePhase
    from sme_meeting_ai.transcription.recovery import RecoveryAdmissionDecision

    def respond(audio, number):
        if audio.chunk_id.startswith("chunk-"):
            return candidate(audio, (), cost=Fraction(0))
        return candidate(audio, (), cost=cost, upstream="Together")

    runner, result, provider, _ = prepare(
        result_factory, count=2048, provider=Provider(respond), audio_asr_native_max_samples=1,
        audio_asr_chunk_target_samples=1024, audio_asr_chunk_max_request_samples=1536,
        audio_asr_chunk_overlap_samples=128, audio_asr_chunk_boundary_search_samples=0,
        audio_asr_recovery_max_total_attempts=1,
    )
    # The fixture's real acoustic evidence is required by canonical assessment.
    execution = runner.execute(result.normalized_artifact)
    output = runner.recover(result, execution)
    assert output.final_assessment.provenance.assessment_phase is CoveragePhase.FINAL_CANONICAL
    assert output.recovered_results == ()
    assert output.attempts[0].admission is RecoveryAdmissionDecision.REJECTED
    telemetry = runner.telemetry
    assert telemetry.total_actual_asr_calls == len(provider.calls) == len(execution.baseline) + 1
    assert telemetry.recovery_calls == 1
    assert telemetry.reported_asr_cost == cost
    assert telemetry.reported_cost_call_count == len(execution.baseline) + int(cost is not None)
    assert telemetry.reported_cost_subtotal == (cost if cost is not None else Fraction(0))
    assert telemetry.provider_provenance[-1][2].upstream_provider == "Together"
