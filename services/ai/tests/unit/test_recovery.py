import io
import wave
from dataclasses import FrozenInstanceError, replace
from fractions import Fraction

import pytest

from sme_meeting_ai.audio.models import NormalizedAudioArtifact, SampleInterval
from sme_meeting_ai.transcription import (
    AsrCandidate, AsrError, AsrErrorCategory, AsrProvenance,
    AsrQualityMetadata, AsrSegment, AsrUsage, CoverageState, RecoveryStopReason,
    assess_speech_coverage, plan_recovery_windows, recover_speech,
)
from sme_meeting_ai.transcription import recovery
from .test_coverage_validation import handoff, result, settings  # noqa: F401


def materialize(preprocessing):
    audio = preprocessing.normalized_artifact
    with wave.open(str(audio.path), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(b"\x01\x00" * audio.sample_count)


class Transcriber:
    def __init__(self, callback=None):
        self.calls = []
        self.callback = callback

    def transcribe(self, audio):
        self.calls.append(audio.chunk_id)
        with wave.open(io.BytesIO(audio.payload), "rb") as reader:
            assert reader.getnframes() * 2 + 44 == len(audio.payload)
        if self.callback:
            return self.callback(audio)
        return candidate(audio)

    def close(self):
        pytest.fail("recovery closed borrowed transcriber")


def candidate(audio, *, text="Nội dung phục hồi", segments=None):
    return AsrCandidate(
        text, (AsrSegment(Fraction(0), audio.duration, text),) if segments is None else segments,
        AsrQualityMetadata(), AsrUsage(), AsrProvenance("fake", "model"), audio.chunk_id,
    )


def baseline(plan):
    return tuple(result(chunk, ()) for chunk in plan.chunks)


def test_changed_windows_recover_speech_preserve_originals_and_borrow_ownership(handoff, monkeypatch, caplog):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    original = baseline(plan)
    before = preprocessing.normalized_artifact.path.read_bytes()
    monkeypatch.setattr(NormalizedAudioArtifact, "close", lambda *_: pytest.fail("closed audio"))
    transcriber = Transcriber()
    output = recover_speech(preprocessing, plan, original, transcriber, configuration)
    assert output.original_results == original
    assert all(a is b for a, b in zip(output.original_results, original, strict=True))
    assert output.initial_assessment.quality.covered_speech_samples == 0
    assert output.final_assessment.quality.covered_speech_samples == plan.sample_count
    assert output.final_assessment.unresolved_intervals == ()
    assert output.stop_reason is RecoveryStopReason.SUFFICIENT_COVERAGE
    assert all(a.covered_speech_delta >= 0 for a in output.attempts)
    assert any(a.covered_speech_delta > 0 for a in output.attempts)
    requests = [r.chunk.request_interval for r in output.recovered_results]
    assert not set(requests) & {c.request_interval for c in plan.chunks}
    assert len(requests) == len(set(requests))
    assert all(identity.startswith("recovery-") for identity in transcriber.calls)
    assert preprocessing.normalized_artifact.path.read_bytes() == before
    assert "Nội dung phục hồi" not in repr(output)
    assert not caplog.records
    with pytest.raises(FrozenInstanceError):
        output.stop_reason = RecoveryStopReason.NO_PROGRESS
    with pytest.raises(TypeError):
        output.provenance.effective_configuration["context_samples"] = 1


def test_persistent_omission_stops_without_claiming_nonempty_text_as_coverage(handoff):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    transcriber = Transcriber(lambda audio: candidate(audio, text="", segments=()))
    output = recover_speech(preprocessing, plan, baseline(plan), transcriber, configuration)
    assert len(output.attempts) == 1
    assert output.attempts[0].stop_reason is RecoveryStopReason.NO_PROGRESS
    assert output.stop_reason is RecoveryStopReason.NO_PROGRESS
    assert output.final_assessment.unresolved_intervals == (SampleInterval(0, 2048),)


@pytest.mark.parametrize("category", list(AsrErrorCategory))
def test_only_timeout_and_transport_are_retried_with_changed_context(handoff, category):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)

    def fail(audio):
        raise AsrError(category)

    output = recover_speech(preprocessing, plan, baseline(plan), Transcriber(fail), configuration)
    transient = category in (AsrErrorCategory.TIMEOUT, AsrErrorCategory.TRANSPORT)
    assert len(output.attempts) == (3 if transient else 1)
    assert all(a.failure is category for a in output.attempts)
    requests = [a.window.chunk.request_interval for a in output.attempts]
    assert len(requests) == len(set(requests))
    assert output.stop_reason is (RecoveryStopReason.REGION_ATTEMPT_LIMIT if transient
                                  else RecoveryStopReason.TERMINAL_FAILURE)
    assert output.final_assessment.unresolved_intervals == (SampleInterval(0, 2048),)


@pytest.mark.parametrize("override,reason", [
    ({"audio_asr_recovery_max_attempts_per_region": 1}, RecoveryStopReason.REGION_ATTEMPT_LIMIT),
    ({"audio_asr_recovery_max_total_attempts": 1}, RecoveryStopReason.TOTAL_ATTEMPT_LIMIT),
    ({"audio_asr_recovery_max_request_samples_per_region": 1}, RecoveryStopReason.REGION_SAMPLE_LIMIT),
    ({"audio_asr_recovery_max_total_request_samples": 1}, RecoveryStopReason.TOTAL_SAMPLE_LIMIT),
    ({"audio_asr_recovery_max_wall_time_seconds": 1}, RecoveryStopReason.WALL_TIME_LIMIT),
])
def test_hard_budgets_keep_exact_unresolved_speech(handoff, override, reason):
    configuration = settings(**override)
    preprocessing, plan, _ = handoff(configuration=configuration)
    materialize(preprocessing)
    transcriber = Transcriber(lambda _: (_ for _ in ()).throw(AsrError(AsrErrorCategory.TIMEOUT)))
    output = recover_speech(preprocessing, plan, baseline(plan), transcriber, configuration)
    assert output.stop_reason is reason
    assert len(output.attempts) <= 1
    assert output.final_assessment.unresolved_intervals == (SampleInterval(0, 2048),)


def test_wall_time_is_reserved_before_each_provider_call(handoff, monkeypatch):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    clock = [0.0]
    monkeypatch.setattr(recovery.time, "monotonic", lambda: clock[0])

    def timeout(audio):
        clock[0] += 190
        raise AsrError(AsrErrorCategory.TIMEOUT)

    output = recover_speech(preprocessing, plan, baseline(plan), Transcriber(timeout), configuration)
    assert len(output.attempts) == 1
    assert output.stop_reason is RecoveryStopReason.WALL_TIME_LIMIT


def test_plan_is_deterministic_bounded_and_splits_without_core_gaps(handoff):
    preprocessing, plan, configuration = handoff(("speech",) * 10)
    assessment = assess_speech_coverage(preprocessing, plan, baseline(plan), configuration)
    first = plan_recovery_windows(assessment, plan, configuration)
    second = plan_recovery_windows(replace(assessment, regions=tuple(reversed(assessment.regions))), plan, configuration)
    assert first == second
    assert first.windows
    seen = {c.request_interval for c in plan.chunks}
    cores = sorted({w.chunk.core_interval for w in first.windows}, key=lambda i: i.start_sample)
    assert cores[0].start_sample == 0
    assert all(left.end_sample == right.start_sample for left, right in zip(cores, cores[1:]))
    for window in first.windows:
        chunk = window.chunk
        assert chunk.ordinal >= len(plan.chunks)
        assert chunk.chunk_id.startswith("recovery-")
        assert chunk.request_interval not in seen
        seen.add(chunk.request_interval)
        length = chunk.request_interval.end_sample - chunk.request_interval.start_sample
        assert length <= configuration.audio_asr_chunk_max_request_samples
        assert 44 + 2 * length <= configuration.audio_asr_max_payload_bytes
        assert window.target_region.interval.start_sample <= chunk.core_interval.start_sample
        assert chunk.core_interval.end_sample <= window.target_region.interval.end_sample


def test_recovery_and_attempt_order_are_independent_of_baseline_order(handoff):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    original = baseline(plan)
    first = recover_speech(preprocessing, plan, original, Transcriber(), configuration)
    second = recover_speech(preprocessing, plan, tuple(reversed(original)), Transcriber(), configuration)
    assert first.attempts == second.attempts
    assert first.final_assessment == second.final_assessment
    assert first.recovered_results == second.recovered_results


@pytest.mark.parametrize("label", ["silence", "uncertain", "weak"])
def test_acoustic_evidence_is_not_promoted_by_provider_success(handoff, label):
    preprocessing, plan, configuration = handoff((label,) * 4)
    materialize(preprocessing)
    transcriber = Transcriber()
    output = recover_speech(preprocessing, plan, baseline(plan), transcriber, configuration)
    assert output.final_assessment.quality.covered_speech_samples == 0
    if label == "silence":
        assert not transcriber.calls
        assert output.stop_reason is RecoveryStopReason.NO_ACTIONABLE_REGIONS
    else:
        assert output.final_assessment.unresolved_intervals == (SampleInterval(0, 2048),)
        assert output.stop_reason is RecoveryStopReason.NO_PROGRESS


def test_28_second_omission_after_silence_hallucination_is_not_silently_lost(handoff, caplog):
    configuration = settings(audio_asr_chunk_target_samples=320000,
                             audio_asr_chunk_max_request_samples=480000,
                             audio_asr_chunk_overlap_samples=80000)
    preprocessing, plan, _ = handoff(("silence",) * 32 + ("speech",) * 875,
                                    configuration=configuration)
    materialize(preprocessing)
    original = (result(plan.chunks[0], ((0, 512),), text="private-hallucination"),
                *tuple(result(c, ()) for c in plan.chunks[1:]))
    transcriber = Transcriber(lambda audio: candidate(audio, text="", segments=()))
    output = recover_speech(preprocessing, plan, original, transcriber, configuration)
    assert SampleInterval(16384, 16384 + 28 * 16000) in output.final_assessment.unresolved_intervals
    assert output.final_assessment.quality.unsupported_candidate_samples == 512
    assert output.final_assessment.quality.covered_speech_samples == 0
    assert all(r.state is not CoverageState.COVERED for r in output.final_assessment.regions)
    assert "private-hallucination" not in repr(output)
    assert not caplog.records


def test_sensitive_provider_diagnostics_and_malformed_candidates_remain_transient(handoff, caplog):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    transcriber = Transcriber(lambda audio: candidate(audio, text="private-candidate", segments=()))
    output = recover_speech(preprocessing, plan, baseline(plan), transcriber, configuration)
    assert output.attempts[0].failure is AsrErrorCategory.MALFORMED_OUTPUT
    assert output.recovered_results[0].candidate is None
    assert "private-candidate" not in repr(output)

    def fail(audio):
        raise RuntimeError("private-provider-diagnostics")

    output = recover_speech(preprocessing, plan, baseline(plan), Transcriber(fail), configuration)
    assert output.attempts[0].failure is AsrErrorCategory.PROVIDER
    assert "private-provider-diagnostics" not in repr(output)
    assert not caplog.records


@pytest.mark.parametrize("field,reason", [
    ("audio_asr_recovery_max_request_samples_per_region", RecoveryStopReason.REGION_SAMPLE_LIMIT),
    ("audio_asr_recovery_max_total_request_samples", RecoveryStopReason.TOTAL_SAMPLE_LIMIT),
])
def test_sample_budgets_include_successful_context_and_leave_exact_remainder(handoff, field, reason):
    configuration = settings(**{field: 1200})
    preprocessing, plan, _ = handoff(configuration=configuration)
    materialize(preprocessing)
    output = recover_speech(preprocessing, plan, baseline(plan), Transcriber(), configuration)
    assert len(output.attempts) == 1
    assert output.stop_reason is reason
    assert output.final_assessment.quality.covered_speech_samples == 1152
    assert output.final_assessment.unresolved_intervals == (SampleInterval(1152, 2048),)


def test_no_distinct_valid_audio_window_keeps_single_sample_speech(handoff):
    preprocessing, plan, configuration = handoff(("speech",), tail=1)
    materialize(preprocessing)
    transcriber = Transcriber()
    output = recover_speech(preprocessing, plan, baseline(plan), transcriber, configuration)
    assert not transcriber.calls
    assert output.stop_reason is RecoveryStopReason.NO_DISTINCT_WINDOW
    assert output.final_assessment.unresolved_intervals == (SampleInterval(0, 1),)


def test_payload_geometry_bounds_recovery_and_omitted_tail_remains_explicit(handoff):
    configuration = settings(audio_asr_max_payload_bytes=300)
    preprocessing, plan, _ = handoff(configuration=configuration)
    materialize(preprocessing)
    output = recover_speech(preprocessing, plan, baseline(plan), Transcriber(), configuration)
    assert output.stop_reason is RecoveryStopReason.REGION_ATTEMPT_LIMIT
    assert all(44 + 2 * (r.chunk.request_interval.end_sample - r.chunk.request_interval.start_sample)
               <= 300 for r in output.recovered_results)
    assert output.final_assessment.unresolved_intervals[-1].end_sample == 2048


def test_invalid_recovery_quality_is_malformed_terminal_evidence(handoff):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    transcriber = Transcriber(lambda audio: replace(candidate(audio), quality=AsrQualityMetadata(confidence=float("nan"))))
    output = recover_speech(preprocessing, plan, baseline(plan), transcriber, configuration)
    assert len(output.attempts) == 1
    assert output.attempts[0].failure is AsrErrorCategory.MALFORMED_OUTPUT
    assert output.stop_reason is RecoveryStopReason.TERMINAL_FAILURE
    assert output.final_assessment.unresolved_intervals == (SampleInterval(0, 2048),)
