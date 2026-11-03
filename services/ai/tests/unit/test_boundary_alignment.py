from dataclasses import FrozenInstanceError, replace
from fractions import Fraction

import pytest

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrUsage,
    AsrWord,
)
from sme_meeting_ai.transcription.boundary_alignment import (
    BoundaryRisk,
    analyze_boundary_alignment,
)
from sme_meeting_ai.transcription.chunk_execution import (
    AsrChunkResult,
    _translate_candidate,
)
from sme_meeting_ai.transcription.chunk_planning import SpeechAwareAsrChunkPlanner

from .test_chunk_planning import result_factory as result_factory
from .test_chunk_planning import settings

TEXT = "Hello anh Hiếu nha! Hello anh Hiếu nha! private-transcript"


def evidence(chunk, bounds=None):
    request = chunk.request_interval
    bounds = bounds or ((request.start_sample, request.end_sample),)
    segments = tuple(AsrSegment(Fraction(a - request.start_sample, 16000),
                                Fraction(b - request.start_sample, 16000), TEXT) for a, b in bounds)
    candidate = AsrCandidate(TEXT, segments, AsrQualityMetadata(), AsrUsage(),
                             AsrProvenance("fake", "test/asr"), chunk.chunk_id)
    return AsrChunkResult(chunk, candidate, _translate_candidate(candidate, chunk))


def test_crossing_overlap_repetitions_and_segment_only_evidence_are_read_only(result_factory):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory())
    results = tuple(evidence(c) for c in plan.chunks)
    candidates = tuple(r.candidate for r in results)
    report = analyze_boundary_alignment(plan, results)
    assert report == analyze_boundary_alignment(plan, results)
    assert len(report.boundaries) == len(plan.chunks) - 1
    for boundary in report.boundaries:
        assert boundary.boundary_risk is BoundaryRisk.FORCED_CONTINUOUS_SPEECH
        assert boundary.left_evidence_count == boundary.right_evidence_count == 1
        assert boundary.segments_crossing_boundary == 2
        assert boundary.overlapping_evidence_samples == 8000
        assert boundary.requires_reconciliation_review
        assert boundary.left_context_samples == boundary.right_context_samples == 4000
    assert tuple(r.candidate for r in results) == candidates
    assert all(r.candidate is original and r.candidate.text == TEXT for r, original in zip(results, candidates))
    assert all(len(r.timeline_segments) == 1 and r.candidate.words is None for r in results)
    assert report.metrics.total_core_samples == plan.sample_count
    assert report.metrics.total_context_samples == report.metrics.total_requested_samples - plan.sample_count
    assert report.metrics.boundary_crossing_segment_count == len(results)
    assert TEXT not in repr(report) and "private-cuoc-hop" not in repr(report)
    assert all(s.crosses_core_boundary and s.word_timing.value == "unavailable" for s in report.segment_supports)
    assert all(s.core_owned_interval == c.core_interval for s, c in zip(report.segment_supports, plan.chunks))
    with pytest.raises(FrozenInstanceError):
        report.boundaries[0].boundary_sample = 0


def test_natural_boundaries_and_union_metrics(result_factory):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory(speech=()))
    report = analyze_boundary_alignment(plan, tuple(evidence(c) for c in plan.chunks))
    assert all(b.boundary_risk is BoundaryRisk.NATURAL_CANDIDATE for b in report.boundaries)
    assert report.metrics.natural_boundary_count == len(plan.chunks) - 1
    assert report.metrics.forced_boundary_count == report.metrics.incomplete_boundary_count == 0
    assert report.metrics.total_adjacent_overlap_samples == 3200 * len(report.boundaries)
    assert report.metrics.boundary_overlap_evidence_samples == report.metrics.total_adjacent_overlap_samples


def test_multiple_real_utterances_are_preserved_and_endpoints_are_not_crossings(result_factory):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory())
    first = plan.chunks[0]
    boundary = first.core_interval.end_sample
    left = evidence(first, ((0, boundary - 1), (boundary - 1, boundary)))
    report = analyze_boundary_alignment(plan, (left, *map(evidence, plan.chunks[1:])))
    assert len(left.candidate.segments) == 2
    assert [s.text for s in left.candidate.segments] == [TEXT, TEXT]
    assert report.boundaries[0].segments_crossing_boundary == 1
    assert report.boundaries[0].segments_ending_near_boundary == 2


@pytest.mark.parametrize("kind", ["missing", "failure", "empty", "remote"])
def test_missing_boundary_support_is_explicitly_incomplete(result_factory, kind):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory())
    results = list(map(evidence, plan.chunks))
    if kind == "missing":
        results.pop(1)
    elif kind == "failure":
        results[1] = AsrChunkResult(plan.chunks[1], failure=AsrErrorCategory.TIMEOUT)
    elif kind == "empty":
        candidate = replace(results[1].candidate, text="", segments=())
        results[1] = AsrChunkResult(plan.chunks[1], candidate, ())
    else:
        c = plan.chunks[1]
        results[1] = evidence(c, ((c.core_interval.end_sample - 10, c.core_interval.end_sample),))
    report = analyze_boundary_alignment(plan, tuple(results))
    assert report.boundaries[0].boundary_risk is BoundaryRisk.INCOMPLETE_EVIDENCE
    assert report.boundaries[0].right_evidence_count == 0
    assert report.boundaries[0].requires_reconciliation_review
    assert report.metrics.incomplete_boundary_count >= 1


@pytest.mark.parametrize("kind", ["out-of-range", "chronology", "translation", "identity", "duplicate"])
def test_invalid_timeline_is_rejected_without_clipping_or_synthesis(result_factory, kind):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory())
    results = list(map(evidence, plan.chunks))
    first = results[0]
    if kind == "out-of-range":
        segment = replace(first.candidate.segments[0], end=Fraction(999))
        results[0] = replace(first, candidate=replace(first.candidate, segments=(segment,)))
    elif kind == "chronology":
        results[0] = replace(first, candidate=replace(first.candidate, segments=first.candidate.segments * 2))
    elif kind == "translation":
        item = replace(first.timeline_segments[0], interval=SampleInterval(0, 1))
        results[0] = replace(first, timeline_segments=(item,))
    elif kind == "identity":
        results[0] = replace(first, chunk=replace(first.chunk, ordinal=9))
    else:
        results.append(first)
    with pytest.raises(AudioProcessingError) as caught:
        analyze_boundary_alignment(plan, tuple(results))
    assert caught.value.__context__ is None and TEXT not in str(caught.value)


def test_native_plan_is_not_a_v2_alignment_input(result_factory):
    from sme_meeting_ai.transcription.asr_strategy import build_whole_file_plan

    plan = build_whole_file_plan(result_factory(1000), settings(), 2044)
    with pytest.raises(AudioProcessingError):
        analyze_boundary_alignment(plan, tuple(map(evidence, plan.chunks)))


def test_optional_provider_words_are_observations_without_retiming(result_factory):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory())
    results = list(map(evidence, plan.chunks))
    first = results[0]
    word = AsrWord(Fraction(0), Fraction(1, 10), "private-word")
    results[0] = replace(first, candidate=replace(first.candidate, words=(word,)))
    report = analyze_boundary_alignment(plan, tuple(results))
    assert report.segment_supports[0].word_timing.value == "provider-reported"
    assert report.segment_supports[0].interval == first.timeline_segments[0].interval
    assert "private-word" not in repr(report)
    results[0] = replace(first, candidate=replace(first.candidate, words=(replace(word, end=Fraction(999)),)))
    with pytest.raises(AudioProcessingError):
        analyze_boundary_alignment(plan, tuple(results))


def test_union_overlap_metrics_do_not_count_shared_positions_twice(result_factory):
    config = settings(audio_asr_chunk_target_samples=2048, audio_asr_chunk_max_request_samples=10000,
                      audio_asr_chunk_overlap_samples=6000, audio_asr_chunk_boundary_search_samples=512)
    plan = SpeechAwareAsrChunkPlanner(config).plan(result_factory(20000))
    report = analyze_boundary_alignment(plan, tuple(map(evidence, plan.chunks)))
    intersections = set()
    for left, right in zip(plan.chunks, plan.chunks[1:]):
        intersections.update(range(right.request_interval.start_sample, left.request_interval.end_sample))
    assert report.metrics.total_adjacent_overlap_samples == len(intersections)
    assert report.metrics.boundary_overlap_evidence_samples == len(intersections)
    assert report.metrics.total_context_samples > len(intersections)
