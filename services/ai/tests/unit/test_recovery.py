"""T07 admission contracts: synthetic WAVs, real T05/T06, no external inference."""

import asyncio
import io
import traceback
import wave
from array import array
from concurrent.futures import CancelledError
from dataclasses import FrozenInstanceError, replace
from fractions import Fraction

import pytest

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import NormalizedAudioArtifact, SampleInterval
from sme_meeting_ai.transcription import (
    AsrCandidate,
    AsrChunkResult,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrUsage,
    CoveragePhase,
    RecoveryStopReason,
    assess_canonical_coverage,
    assess_speech_coverage,
    plan_recovery_windows,
    reconcile_transcript,
    recover_speech,
    recovery,
)
from sme_meeting_ai.transcription import (
    RecoveryAdmissionDecision as Decision,
)
from sme_meeting_ai.transcription import (
    RecoveryAdmissionReason as Reason,
)
from sme_meeting_ai.transcription.boundary_alignment import analyze_boundary_alignment

from .test_coverage_validation import handoff as handoff_fixture  # noqa: F401
from .test_coverage_validation import result as raw_result
from .test_coverage_validation import settings as raw_settings

PRIVATE = "private-rejected-hypothesis"
PROVENANCE = AsrProvenance("openrouter", "openai/whisper-large-v3", upstream_provider="Together",
                           inference_config=(("language", "vi"),))


def settings(**overrides):
    return raw_settings(**({"audio_asr_recovery_context_samples": 128} | overrides))


@pytest.fixture(name="handoff")
def _handoff(request):
    make = request.getfixturevalue("handoff_fixture")

    def handoff(*args, configuration=None, **kwargs):
        return make(*args, configuration=configuration or settings(), **kwargs)

    return handoff


def result(chunk, bounds=None, **kwargs):
    item = raw_result(chunk, bounds, **kwargs)
    return replace(item, candidate=replace(item.candidate, provenance=PROVENANCE))


def baseline(plan):
    return tuple(result(chunk, ()) for chunk in plan.chunks)


def materialize(preprocessing):
    audio = preprocessing.normalized_artifact
    with wave.open(str(audio.path), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(array("h", (i % 32767 for i in range(audio.sample_count))).tobytes())


def candidate(audio, *, text="Nội dung phục hồi", segments=None):
    return AsrCandidate(
        text, (AsrSegment(Fraction(0), audio.duration, text),) if segments is None else tuple(segments),
        AsrQualityMetadata(language="vi"), AsrUsage(), PROVENANCE, audio.chunk_id,
    )


def observation(audio, request_start, occurrences):
    end = request_start + int(audio.duration * 16000)
    segments = tuple(AsrSegment(Fraction(a - request_start, 16000), Fraction(b - request_start, 16000), text)
                     for a, b, text in occurrences if request_start <= a < b <= end)
    return candidate(audio, text=" ".join(s.text for s in segments), segments=segments)


class Transcriber:
    def __init__(self, callback=None):
        self.calls = []
        self.callback = callback

    def transcribe(self, audio):
        with wave.open(io.BytesIO(audio.payload), "rb") as reader:
            assert reader.getnframes() * 2 + 44 == len(audio.payload)
            start = int.from_bytes(reader.readframes(1), "little", signed=True)
        self.calls.append((audio.chunk_id, start, int(audio.duration * 16000)))
        if self.callback:
            return self.callback(audio, start)
        # Intact synthetic occurrences; never synthesize a partial utterance at a
        # context edge, so later evidence can preserve exact accepted identities.
        return observation(audio, start, tuple((i, i + 512, "Nội dung phục hồi")
                                               for i in range(0, 8192, 512)))

    def close(self):
        pytest.fail("closed borrowed transcriber")


def state(preprocessing, plan, original, configuration, extra=()):
    canonical = reconcile_transcript(plan, (*original, *extra), configuration)
    final = assess_canonical_coverage(preprocessing, plan, original, extra, canonical, configuration)
    return canonical, final


def test_admission_accumulates_current_state_and_preserves_borrowed_baseline(handoff, monkeypatch, caplog):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    original = baseline(plan)
    before = preprocessing.normalized_artifact.path.read_bytes()
    monkeypatch.setattr(NormalizedAudioArtifact, "close", lambda *_: pytest.fail("closed audio"))
    provider = Transcriber()
    output = recover_speech(preprocessing, plan, original, provider, configuration)
    assert output.original_results == original
    assert all(a is b for a, b in zip(original, output.original_results, strict=True))
    assert output.initial_assessment.provenance.assessment_phase is CoveragePhase.PRE_CANONICAL
    assert output.initial_canonical_assessment.provenance.assessment_phase is CoveragePhase.FINAL_CANONICAL
    assert output.final_assessment.provenance.assessment_phase is CoveragePhase.FINAL_CANONICAL
    assert output.final_assessment.quality.likely_speech_with_canonical_text_samples == 2048
    assert output.final_assessment.unresolved_intervals == ()
    assert output.stop_reason is RecoveryStopReason.SUFFICIENT_COVERAGE
    assert len(output.recovered_results) == len(output.attempts) == 2
    assert all(a.admission is Decision.ACCEPTED and a.meaningful_progress for a in output.attempts)
    assert output.attempts[1].global_unresolved_speech_samples_before == 1024
    assert sum(a.new_canonical_supported_speech_samples for a in output.attempts) == 2048
    assert output.provenance.accepted_attempt_count == 2
    assert output.provenance.total_requested_samples == sum(c[2] for c in provider.calls)
    assert all(a.request_duration_ns >= 0 for a in output.attempts)
    assert preprocessing.normalized_artifact.path.read_bytes() == before
    assert "Nội dung phục hồi" not in repr(output)
    assert not caplog.records
    with pytest.raises(FrozenInstanceError):
        output.stop_reason = RecoveryStopReason.NO_PROGRESS
    with pytest.raises(TypeError):
        output.provenance.effective_configuration["context_samples"] = 1


def test_precanonical_planning_is_rejected_instead_of_v1_fallback(handoff):
    preprocessing, plan, configuration = handoff()
    assessment = assess_speech_coverage(preprocessing, plan, baseline(plan), configuration)
    with pytest.raises(AudioProcessingError):
        plan_recovery_windows(assessment, plan, configuration)


@pytest.mark.parametrize("label,eligible", [("speech", True), ("weak", True), ("uncertain", True),
                                           ("high", True), ("silence", False)])
def test_acoustic_missing_support_selection(handoff, label, eligible):
    preprocessing, plan, configuration = handoff((label,) * 4)
    _, final = state(preprocessing, plan, baseline(plan), configuration)
    planned = plan_recovery_windows(final, plan, configuration)
    assert bool(planned.target_regions) is eligible
    assert all(w.target_reason.value in {"missing-canonical-speech", "uncertain-missing-speech"}
               for w in planned.windows)


@pytest.mark.parametrize("label", ["speech", "silence"])
def test_clean_canonical_or_silence_hallucination_does_not_trigger_requests(handoff, label):
    preprocessing, plan, configuration = handoff((label,) * 4)
    materialize(preprocessing)
    original = tuple(result(c, ((c.core_interval.start_sample, c.core_interval.end_sample),)) for c in plan.chunks)
    provider = Transcriber()
    output = recover_speech(preprocessing, plan, original, provider, configuration)
    assert provider.calls == [] and output.recovered_results == ()
    assert output.stop_reason is RecoveryStopReason.NO_ACTIONABLE_REGIONS
    if label == "silence":
        assert output.final_assessment.quality.unsupported_canonical_text_samples == 2048
        assert output.final_assessment.unresolved_intervals


def test_priority_is_deterministic_and_not_duration_ranked(handoff):
    preprocessing, plan, configuration = handoff(("uncertain",) * 2 + ("speech",) * 4)
    _, final = state(preprocessing, plan, baseline(plan), configuration)
    first = plan_recovery_windows(final, plan, configuration)
    second = plan_recovery_windows(replace(final, regions=tuple(reversed(final.regions))), plan, configuration)
    assert first == second
    assert first.target_regions[0].interval.start_sample == 1024


def test_raw_only_final_evidence_remains_actionable(handoff):
    preprocessing, plan, configuration = handoff()
    _, final = state(preprocessing, plan, baseline(plan), configuration)
    region = final.regions[0]
    raw_only = replace(region, evidence=replace(region.evidence, has_raw_text_support=True,
                                               raw_asr_support_count=1))
    planned = plan_recovery_windows(replace(final, regions=(raw_only,)), plan, configuration)
    assert planned.windows[0].target_reason.value == "raw-only-speech-support"


def test_plan_preserves_exact_cores_source_limits_and_distinct_geometries(handoff):
    # This planning assertion needs all alternatives, independently of a local
    # pilot's smaller environment-level live request budget.
    preprocessing, plan, configuration = handoff(
        ("speech",) * 10, configuration=settings(audio_asr_recovery_max_total_attempts=16),
    )
    original = baseline(plan)
    report = analyze_boundary_alignment(plan, original)
    _, final = state(preprocessing, plan, original, configuration)
    planned = plan_recovery_windows(final, plan, configuration, boundary_alignment=report)
    cores = sorted({w.chunk.core_interval for w in planned.windows}, key=lambda i: i.start_sample)
    assert cores[0].start_sample == 0 and cores[-1].end_sample == 5120
    assert all(a.end_sample == b.start_sample for a, b in zip(cores, cores[1:]))
    bounds = {c.request_interval for c in plan.chunks}
    for w in planned.windows:
        assert w.planning.preprocessing.source_id == preprocessing.provenance.source_id
        assert w.chunk.request_interval not in bounds
        bounds.add(w.chunk.request_interval)
        assert 44 + 2 * w.chunk.request_interval.duration * 16000 <= configuration.audio_asr_max_payload_bytes
        assert w.chunk.request_interval.end_sample <= plan.sample_count
        assert w.chunk.ordinal >= len(plan.chunks)


@pytest.mark.parametrize("category", list(AsrErrorCategory))
def test_classified_failure_retry_and_accepted_evidence_isolation(handoff, category):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)

    def fail(audio, start):
        raise AsrError(category)

    provider = Transcriber(fail)
    output = recover_speech(preprocessing, plan, baseline(plan), provider, configuration)
    transient = category in (AsrErrorCategory.TIMEOUT, AsrErrorCategory.TRANSPORT)
    assert len(output.attempts) == (3 if transient else 1)
    assert all(a.failure is category and a.admission is Decision.FAILED and not a.meaningful_progress
               for a in output.attempts)
    assert output.recovered_results == ()
    assert output.provenance.failed_attempt_count == len(provider.calls)
    assert output.final_assessment.unresolved_intervals == (SampleInterval(0, 2048),)
    requests = [a.window.chunk.request_interval for a in output.attempts]
    assert len(requests) == len(set(requests))


@pytest.mark.parametrize("override,reason", [
    ({"audio_asr_recovery_max_attempts_per_region": 1}, RecoveryStopReason.REGION_ATTEMPT_LIMIT),
    ({"audio_asr_recovery_max_total_attempts": 1}, RecoveryStopReason.TOTAL_ATTEMPT_LIMIT),
    ({"audio_asr_recovery_max_request_samples_per_region": 1}, RecoveryStopReason.REGION_SAMPLE_LIMIT),
    ({"audio_asr_recovery_max_total_request_samples": 1}, RecoveryStopReason.TOTAL_SAMPLE_LIMIT),
    ({"audio_asr_recovery_max_wall_time_seconds": 1}, RecoveryStopReason.WALL_TIME_LIMIT),
])
def test_hard_budgets_preserve_exact_unresolved_speech(handoff, override, reason):
    preprocessing, plan, configuration = handoff(configuration=settings(**override))
    materialize(preprocessing)
    provider = Transcriber(lambda *_: (_ for _ in ()).throw(AsrError(AsrErrorCategory.TIMEOUT)))
    output = recover_speech(preprocessing, plan, baseline(plan), provider, configuration)
    assert output.stop_reason is reason
    assert len(output.attempts) <= 1
    assert output.final_assessment.unresolved_intervals == (SampleInterval(0, 2048),)


def test_timeout_reservation_includes_all_elapsed_time(handoff, monkeypatch):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    clock = [0.0]
    monkeypatch.setattr(recovery.time, "monotonic", lambda: clock[0])

    def timeout(*_):
        clock[0] += 190
        raise AsrError(AsrErrorCategory.TIMEOUT)

    output = recover_speech(preprocessing, plan, baseline(plan), Transcriber(timeout), configuration)
    assert len(output.attempts) == 1 and output.stop_reason is RecoveryStopReason.WALL_TIME_LIMIT


@pytest.mark.parametrize("field,reason", [
    ("audio_asr_recovery_max_request_samples_per_region", RecoveryStopReason.REGION_SAMPLE_LIMIT),
    ("audio_asr_recovery_max_total_request_samples", RecoveryStopReason.TOTAL_SAMPLE_LIMIT),
])
def test_sample_budgets_include_context_and_cannot_reset_after_admission(handoff, field, reason):
    preprocessing, plan, configuration = handoff(configuration=settings(**{field: 1500}))
    materialize(preprocessing)
    provider = Transcriber()
    output = recover_speech(preprocessing, plan, baseline(plan), provider, configuration)
    assert len(provider.calls) == 1
    assert output.stop_reason is reason
    assert output.provenance.total_requested_samples == provider.calls[0][2] == 1408
    assert output.final_assessment.unresolved_intervals == (SampleInterval(1024, 2048),)


@pytest.mark.parametrize("payload", [44, 45, 300])
def test_payload_bounds_precede_inference(handoff, payload):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    configuration = configuration.model_copy(update={"audio_asr_max_payload_bytes": payload})
    provider = Transcriber(lambda audio, _: candidate(audio, text="", segments=()))
    output = recover_speech(preprocessing, plan, baseline(plan), provider, configuration)
    assert all(44 + count * 2 <= payload for _, _, count in provider.calls)
    if payload < 46:
        assert not provider.calls and output.stop_reason is RecoveryStopReason.NO_DISTINCT_WINDOW
    assert output.final_assessment.unresolved_intervals == (SampleInterval(0, 2048),)


def test_one_sample_missing_speech_never_disappears(handoff):
    preprocessing, plan, configuration = handoff(("speech",), tail=1)
    materialize(preprocessing)
    provider = Transcriber()
    output = recover_speech(preprocessing, plan, baseline(plan), provider, configuration)
    assert not provider.calls and output.stop_reason is RecoveryStopReason.NO_DISTINCT_WINDOW
    assert output.final_assessment.unresolved_intervals == (SampleInterval(0, 1),)


@pytest.mark.parametrize("kind", ["empty", "redundant", "silence", "replacement", "malformed", "quality"])
def test_success_is_not_admission_and_rejected_text_is_private(handoff, caplog, kind):
    preprocessing, plan, configuration = handoff(("speech",) * 3 + ("silence",))
    materialize(preprocessing)
    original = (result(plan.chunks[0], ((0, 512),), text="Triển khai API mới kiểm thử"),
                *tuple(result(c, ()) for c in plan.chunks[1:]))

    def respond(audio, start):
        if kind == "empty":
            return candidate(audio, text="", segments=())
        if kind == "malformed":
            return candidate(audio, text=PRIVATE, segments=(AsrSegment(Fraction(-1), audio.duration, PRIVATE),))
        if kind == "quality":
            return replace(candidate(audio, text=PRIVATE), quality=AsrQualityMetadata(confidence=float("nan")))
        a, b, text = {"redundant": (0, 512, "Triển khai API mới kiểm thử"),
                      "silence": (1536, 2048, PRIVATE),
                      "replacement": (0, 512, PRIVATE)}[kind]
        return observation(audio, start, ((a, b, text),))

    provider = Transcriber(respond)
    output = recover_speech(preprocessing, plan, original, provider, configuration)
    assert not output.recovered_results
    assert all(not a.meaningful_progress and a.covered_speech_delta == 0 for a in output.attempts)
    assert all(a.admission is (Decision.FAILED if kind in {"quality", "malformed"} else Decision.REJECTED)
               for a in output.attempts)
    assert output.final_assessment == output.initial_canonical_assessment
    assert [s.text for s in output.accepted_reconciliation.segments] == ["Triển khai API mới kiểm thử"]
    assert PRIVATE not in repr(output) and not caplog.records


@pytest.mark.parametrize("wording", ["ừ", "vâng", "dạ", "Triển khai API mới"])
def test_genuine_distinct_repetitions_are_preserved(handoff, wording):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    original = (result(plan.chunks[0], ((0, 512),), text=wording),
                *tuple(result(c, ()) for c in plan.chunks[1:]))
    provider = Transcriber(lambda audio, start: observation(audio, start, ((1024, 1536, wording),)))
    output = recover_speech(preprocessing, plan, original, provider, configuration)
    assert output.recovered_results
    segments = output.accepted_reconciliation.segments
    assert [(s.text, s.interval) for s in segments] == [
        (wording, SampleInterval(0, 512)), (wording, SampleInterval(1024, 1536)),
    ]


def test_rejected_state_never_enters_subsequent_trial(handoff, monkeypatch):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    from sme_meeting_ai.transcription import reconciliation

    trials = []
    original_reconcile = reconciliation.reconcile_transcript

    def select(plan, results, settings, **kwargs):
        trials.append(tuple(r.chunk.chunk_id for r in results))
        return original_reconcile(plan, results, settings, **kwargs)

    monkeypatch.setattr(reconciliation, "reconcile_transcript", select)
    count = [0]

    def respond(audio, start):
        count[0] += 1
        if count[0] == 1:
            return candidate(audio, text="", segments=())
        return observation(audio, start, ((1536, 2048, "Xin chào Việt Nam"),))

    output = recover_speech(preprocessing, plan, baseline(plan), Transcriber(respond), configuration)
    assert output.attempts[0].admission is Decision.REJECTED
    assert output.attempts[1].admission is Decision.ACCEPTED
    assert all("recovery-000000" not in ids for ids in trials[2:])
    assert all(r.chunk.chunk_id != "recovery-000000" for r in output.recovered_results)


def test_blocked_and_seen_candidate_prefix_cannot_hide_later_recoverable_speech(handoff):
    preprocessing, plan, configuration = handoff(
        ("silence", "speech", "silence", "speech", "silence"),
        configuration=settings(audio_asr_recovery_max_total_attempts=3),
    )
    materialize(preprocessing)
    original = baseline(plan)
    _, final = state(preprocessing, plan, original, configuration)
    preview = plan_recovery_windows(final, plan, configuration)
    assert len(preview.windows) == 3
    assert {w.target_region.interval for w in preview.windows[:2]} == {
        SampleInterval(512, 1024), SampleInterval(1536, 2048),
    }
    provider = Transcriber(lambda audio, start: observation(
        audio, start, ((1536, 2048, "Phần lời nói được phục hồi"),),
    ))
    output = recover_speech(preprocessing, plan, original, provider, configuration)
    assert [a.window.target_region.interval for a in output.attempts] == [
        SampleInterval(512, 1024), SampleInterval(1536, 2048), SampleInterval(512, 1024),
    ]
    assert [a.admission for a in output.attempts] == [Decision.REJECTED, Decision.ACCEPTED, Decision.REJECTED]
    assert output.stop_reason is RecoveryStopReason.TOTAL_ATTEMPT_LIMIT
    assert output.final_assessment.quality.likely_speech_without_canonical_text_samples == 512
    assert [(s.interval, s.text) for s in output.accepted_reconciliation.segments] == [
        (SampleInterval(1536, 2048), "Phần lời nói được phục hồi"),
    ]
    assert len(provider.calls) == output.provenance.actual_attempt_count == 3
    assert len({a.window.chunk.request_interval for a in output.attempts}) == 3
    assert output.provenance.total_requested_samples == sum(count for _, _, count in provider.calls)


def test_distinct_target_gets_first_observation_before_rejecting_an_early_event_twice(handoff):
    preprocessing, plan, config = handoff(
        ("silence", "speech", "silence", "speech", "silence"),
        configuration=settings(audio_asr_recovery_max_total_attempts=2),
    )
    materialize(preprocessing)
    provider = Transcriber(lambda audio, start: observation(audio, start, ((1536, 2048, "Vâng"),)))
    output = recover_speech(preprocessing, plan, baseline(plan), provider, config)
    assert [a.admission for a in output.attempts] == [Decision.REJECTED, Decision.ACCEPTED]
    assert output.provenance.accepted_attempt_count == 1
    assert output.final_assessment.quality.likely_speech_without_canonical_text_samples == 512
    assert [(s.interval, s.text) for s in output.accepted_reconciliation.segments] == [
        (SampleInterval(1536, 2048), "Vâng"),
    ]
    assert len({a.window.target_region.interval for a in output.attempts}) == 2


def test_region_sample_exhaustion_does_not_hide_a_later_window_that_fits(handoff):
    preprocessing, plan, configuration = handoff(
        ("silence", "speech", "silence", "speech"), tail=128,
        configuration=settings(audio_asr_recovery_max_total_attempts=1,
                               audio_asr_recovery_max_request_samples_per_region=512),
    )
    materialize(preprocessing)
    provider = Transcriber(lambda audio, start: observation(
        audio, start, ((1536, 1664, "Tiếp tục cuộc họp"),),
    ))
    output = recover_speech(preprocessing, plan, baseline(plan), provider, configuration)
    assert len(provider.calls) == len(output.attempts) == 1
    attempt, = output.attempts
    assert attempt.window.target_region.interval == SampleInterval(1536, 1664)
    assert attempt.admission is Decision.ACCEPTED
    assert attempt.requested_samples <= 512
    assert output.stop_reason is RecoveryStopReason.TOTAL_ATTEMPT_LIMIT
    assert output.final_assessment.quality.likely_speech_without_canonical_text_samples == 512


def test_long_omission_and_silence_hallucination_remain_separate(handoff):
    configuration = settings(audio_asr_chunk_target_samples=320000,
                             audio_asr_chunk_max_request_samples=480000,
                             audio_asr_chunk_overlap_samples=80000)
    preprocessing, plan, _ = handoff(("silence",) * 32 + ("speech",) * 875, configuration=configuration)
    materialize(preprocessing)
    original = (result(plan.chunks[0], ((0, 512),), text=PRIVATE),
                *tuple(result(c, ()) for c in plan.chunks[1:]))
    output = recover_speech(preprocessing, plan, original,
                            Transcriber(lambda a, _: candidate(a, text="", segments=())), configuration)
    assert SampleInterval(16384, 16384 + 28 * 16000) in output.final_assessment.unresolved_intervals
    assert output.final_assessment.quality.unsupported_canonical_text_samples == 512
    assert output.final_assessment.quality.likely_speech_without_canonical_text_samples == 28 * 16000
    assert len(output.attempts) <= configuration.audio_asr_recovery_max_total_attempts


@pytest.mark.parametrize("exception", [CancelledError, asyncio.CancelledError, KeyboardInterrupt])
def test_cancellation_stops_submissions_and_sanitizes_frames(handoff, exception):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    cancelled = exception(PRIVATE)

    def cancel(*_):
        raise cancelled

    provider = Transcriber(cancel)
    with pytest.raises(exception) as caught:
        recover_speech(preprocessing, plan, baseline(plan), provider, configuration)
    assert caught.value is cancelled and len(provider.calls) == 1
    assert PRIVATE not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__cause__ is caught.value.__context__ is None


def test_deterministic_decisions_and_results(handoff):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    original = baseline(plan)
    first = recover_speech(preprocessing, plan, original, Transcriber(), configuration)
    second = recover_speech(preprocessing, plan, tuple(reversed(original)), Transcriber(), configuration)
    assert first.attempts == second.attempts
    assert first.final_assessment == second.final_assessment
    assert first.recovered_results == second.recovered_results
    assert first.accepted_reconciliation == second.accepted_reconciliation


@pytest.mark.parametrize("mutation", ["delete", "replace", "retime", "collapse"])
def test_gate_rejects_loss_of_traceable_canonical_occurrences(handoff, mutation):
    preprocessing, plan, configuration = handoff()
    original = (result(plan.chunks[0], ((0, 256), (256, 512)), text="vâng"),
                *tuple(result(c, ()) for c in plan.chunks[1:]))
    current, final = state(preprocessing, plan, original, configuration)
    segments = current.segments
    if mutation in {"delete", "collapse"}:
        trial = replace(current, segments=segments[:1])
    elif mutation == "replace":
        trial = replace(current, segments=(replace(segments[0], text=PRIVATE), *segments[1:]))
    else:
        trial = replace(current, segments=(replace(segments[0], interval=SampleInterval(0, 255)), *segments[1:]))
    reason, _ = recovery._admission(current, final, trial, final, "recovery-000000", SampleInterval(512, 1024))
    assert reason is Reason.CANONICAL_REGRESSION


@pytest.mark.parametrize("kind", ["ambiguity", "conflict", "partial-long", "many-to-one"])
def test_real_t05_trial_cannot_damage_protected_speech_to_fill_a_gap(handoff, kind):
    preprocessing, plan, configuration = handoff()
    text = "Triển khai API mới kiểm thử Kubernetes"
    original = (result(plan.chunks[0], ((256, 768),), text=text),
                *tuple(result(c, ()) for c in plan.chunks[1:]))
    current, before = state(preprocessing, plan, original, configuration)
    extra_chunk = replace(plan.chunks[0], chunk_id="recovery-000000", ordinal=len(plan.chunks),
                          core_interval=SampleInterval(0, 1024), request_interval=SampleInterval(0, 1408))
    if kind == "conflict":
        extra = result(extra_chunk, ((256, 768),), text="Triển khai API cũ kiểm thử Kubernetes")
    elif kind == "ambiguity":
        extra = result(extra_chunk, ((512, 1024),), text=text)
    elif kind == "partial-long":
        extra = result(extra_chunk, ((256, 768),), text="API mới kiểm thử")
    else:
        first = result(extra_chunk, ((256, 512),), text="Triển khai API mới")
        second = result(extra_chunk, ((512, 768),), text="kiểm thử Kubernetes")
        segments = (*first.candidate.segments, *second.candidate.segments)
        from sme_meeting_ai.transcription.chunk_execution import _translate_candidate

        value = replace(first.candidate, text=text, segments=segments)
        extra = AsrChunkResult(extra_chunk, value, _translate_candidate(value, extra_chunk))
    trial, after = state(preprocessing, plan, original, configuration, (extra,))
    reason, metrics = recovery._admission(current, before, trial, after, extra.chunk.chunk_id,
                                          SampleInterval(0, 1408))
    assert reason not in {Reason.NEW_SUPPORTED_SPEECH, Reason.RESOLVED_CANONICAL_AMBIGUITY}
    if kind == "many-to-one":
        assert trial.observations.one_to_many_alignment_count == 1
    if kind == "conflict":
        assert metrics["new_conflict_samples"] > 0


def test_no_unproven_ambiguity_reduction_from_identical_observation(handoff):
    preprocessing, plan, configuration = handoff()
    original = tuple(result(c, ((800, 1000),), text="vâng") for c in plan.chunks)
    current, before = state(preprocessing, plan, original, configuration)
    chunk = replace(plan.chunks[0], chunk_id="recovery-000000", ordinal=len(plan.chunks),
                    core_interval=SampleInterval(800, 1000), request_interval=SampleInterval(672, 1128))
    extra = result(chunk, ((800, 1000),), text="vâng")
    trial, after = state(preprocessing, plan, original, configuration, (extra,))
    reason, metrics = recovery._admission(current, before, trial, after, chunk.chunk_id, chunk.core_interval)
    assert reason is not Reason.RESOLVED_CANONICAL_AMBIGUITY
    assert metrics["resolved_ambiguity_samples"] == 0


def test_trial_resource_failure_keeps_current_snapshot_and_never_publishes_candidate(handoff, monkeypatch):
    preprocessing, plan, configuration = handoff()
    materialize(preprocessing)
    from sme_meeting_ai.transcription import reconciliation

    original = reconciliation.reconcile_transcript

    def limited(plan, results, settings, **kwargs):
        if any(r.chunk.chunk_id.startswith("recovery-") for r in results):
            raise AudioProcessingError("RESOURCE")
        return original(plan, results, settings, **kwargs)

    monkeypatch.setattr(reconciliation, "reconcile_transcript", limited)
    output = recover_speech(preprocessing, plan, baseline(plan), Transcriber(), configuration)
    assert output.recovered_results == () and len(output.attempts) == 1
    assert output.attempts[0].admission is Decision.FAILED
    assert output.attempts[0].admission_reason is Reason.RESOURCE_LIMIT
    assert output.final_assessment is output.initial_canonical_assessment
    assert output.stop_reason is RecoveryStopReason.TERMINAL_FAILURE
