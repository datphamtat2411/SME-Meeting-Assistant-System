"""Deterministic source-censorship regressions; invented Vietnamese observations.

These establish source/occurrence contracts, not the acoustic correctness of a
provider's hypotheses. Private recording wording is deliberately not a fixture.
"""

from dataclasses import replace

import pytest

from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.transcription import ReconciliationFlag, reconcile_transcript

from .test_reconciliation import plan, result, settings, with_words


@pytest.mark.parametrize("direction", ["start", "end"])
def test_unique_censored_fragment_borrows_complete_source_without_losing_timing(direction):
    approved = plan()
    if direction == "start":
        complete = result(approved.chunks[0], (60, 100, "Hôm nay kiểm thử Kubernetes API-v2"))
        fragment = result(approved.chunks[1], (80, 95, "Kubernetes API-v2"))
    else:
        fragment = result(approved.chunks[0], (95, 118, "Kiểm thử Kubernetes"))
        complete = result(approved.chunks[1], (90, 140, "Kiểm thử Kubernetes trước khi triển khai"))
    output = reconcile_transcript(approved, (complete, fragment), settings())
    segment, = output.segments
    assert (segment.text, segment.interval) == (complete.candidate.segments[0].text,
                                               complete.timeline_segments[0].interval)
    assert segment.selected_evidence_id.chunk_id == complete.chunk.chunk_id
    assert segment.alternative_evidence_ids[0].chunk_id == fragment.chunk.chunk_id
    assert segment.alternatives == (fragment.candidate.segments[0].text,)
    assert output.observations.established_redundant_hypothesis_count == 1
    assert output.observations.conflicting_hypothesis_count == 0
    assert output.relationships[0].classification.value == "same-occurrence"
    assert output == reconcile_transcript(approved, (fragment, complete), settings())


@pytest.mark.parametrize("long_on_left", [True, False])
def test_censored_long_hypothesis_covers_multiple_short_segments(long_on_left):
    approved = plan()
    if long_on_left:
        complete = result(approved.chunks[0], (60, 100, "Hôm nay triển khai API-v2 kiểm thử Kubernetes"))
        fragments = result(approved.chunks[1], (80, 88, "API-v2"), (88, 99, "kiểm thử Kubernetes"))
    else:
        fragments = result(approved.chunks[0], (90, 104, "Triển khai API-v2"), (104, 118, "kiểm thử Kubernetes"))
        complete = result(approved.chunks[1], (85, 145, "Triển khai API-v2 kiểm thử Kubernetes trước buổi họp"))
    output = reconcile_transcript(approved, (complete, fragments), settings())
    assert [(s.text, s.interval) for s in output.segments] == [
        (complete.candidate.segments[0].text, complete.timeline_segments[0].interval),
    ]
    assert output.observations.established_redundant_hypothesis_count == 2


def test_local_censored_alignment_does_not_consume_unrelated_overlapping_speech():
    approved = plan()
    inputs = (result(approved.chunks[0], (60, 90, "Khoan, cần thảo luận thêm"), (90, 118, "Kiểm thử Kubernetes")),
              result(approved.chunks[1], (85, 140, "Kiểm thử Kubernetes trước khi triển khai")))
    output = reconcile_transcript(approved, inputs, settings())
    assert [(s.text, s.interval) for s in output.segments] == [
        ("Khoan, cần thảo luận thêm", SampleInterval(60, 90)),
        ("Kiểm thử Kubernetes trước khi triển khai", SampleInterval(85, 140)),
    ]
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)


def test_unique_ordered_phrase_can_include_common_words_without_becoming_a_common_only_anchor():
    approved = plan()
    inputs = (result(approved.chunks[0], (90, 120, "Các cậu đang")),
              result(approved.chunks[1], (90, 140, "Các cậu đang còn kiểm thử")))
    output = reconcile_transcript(approved, inputs, settings())
    assert len(output.segments) == 1
    assert output.segments[0].text == "Các cậu đang còn kiểm thử"


def test_request_censored_tail_can_omit_a_function_word_but_keeps_the_full_observed_wording():
    approved = plan()
    complete = "Khi kiểm thử nó đã xong rồi, hệ thống nó đã ổn rồi"
    inputs = (result(approved.chunks[0], (60, 100, complete)),
              result(approved.chunks[1], (80, 95, "hệ thống đã ổn rồi")))
    output = reconcile_transcript(approved, inputs, settings())
    assert [(s.text, s.interval) for s in output.segments] == [(complete, SampleInterval(60, 100))]
    assert output.segments[0].alternatives == ("hệ thống đã ổn rồi",)


@pytest.mark.parametrize("complete,fragment", [
    ("Hệ thống chưa ổn rồi", "Hệ thống ổn rồi"),
    ("Hệ thống không ổn rồi", "Hệ thống ổn rồi"),
    ("Hệ thống Kubernetes ổn rồi", "Hệ thống ổn rồi"),
    ("Hệ thống nó ổn rồi, hệ thống nó ổn rồi", "hệ thống ổn rồi"),
])
def test_censored_partial_alignment_never_skips_negation_content_or_ambiguous_repetitions(complete, fragment):
    approved = plan()
    output = reconcile_transcript(approved, (result(approved.chunks[0], (60, 100, complete)),
                                             result(approved.chunks[1], (80, 95, fragment))), settings())
    assert len(output.segments) == 2


@pytest.mark.parametrize("kind", ["interior", "not-final", "one-sample-loss", "different-wording",
                                 "multiple-occurrences", "common-words", "same-request"])
def test_text_containment_alone_never_authorizes_deletion(kind):
    approved = plan()
    full = "Triển khai API-v2 kiểm thử Kubernetes"
    complete = result(approved.chunks[1], (85, 115, full))
    fragment = result(approved.chunks[0], (90, 110, "Triển khai API-v2"))
    if kind == "interior":
        fragment = result(approved.chunks[0], (90, 95, "Triển khai API-v2"))
    elif kind == "not-final":
        fragment = result(approved.chunks[0], (90, 110, "Triển khai API-v2"), (110, 118, "Tôi chưa đồng ý"))
    elif kind == "one-sample-loss":
        fragment = result(approved.chunks[0], (90, 116, "Triển khai API-v2"))
    elif kind == "different-wording":
        fragment = result(approved.chunks[0], (90, 110, "Triển khai API-v3"))
    elif kind == "multiple-occurrences":
        complete = result(approved.chunks[1], (85, 115, "Triển khai API-v2 rồi triển khai API-v2"))
    elif kind == "common-words":
        complete = result(approved.chunks[1], (85, 115, "Đúng rồi đúng rồi tiếp tục"))
        fragment = result(approved.chunks[0], (90, 110, "Đúng rồi"))
    else:
        # Separate source observations are mandatory, even with matching wording.
        complete = result(approved.chunks[0], (60, 90, full), (90, 115, "Triển khai API-v2"))
        fragment = None
    inputs = (complete, fragment) if fragment else (complete,)
    output = reconcile_transcript(approved, inputs, settings())
    assert len(output.segments) == sum(len(item.timeline_segments) for item in inputs)
    assert output.observations.established_redundant_hypothesis_count == 0


def test_contradictory_actual_word_times_preserve_concurrent_matching_fragment():
    approved = plan()
    complete = with_words(result(approved.chunks[0], (60, 100, "Kiểm thử API Kubernetes")),
                          (60, 65, "Kiểm"), (65, 70, "thử"), (70, 75, "API"), (75, 79, "Kubernetes"))
    fragment = with_words(result(approved.chunks[1], (80, 95, "API Kubernetes")),
                          (80, 85, "API"), (85, 90, "Kubernetes"))
    output = reconcile_transcript(approved, (complete, fragment), settings())
    assert len(output.segments) == 2
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)


def test_interruption_false_start_and_self_correction_preserve_every_observed_word():
    approved = plan()
    inputs = (result(approved.chunks[0], (60, 100, "Tôi định triển khai, à không, kiểm thử trước")),
              result(approved.chunks[1], (80, 95, "Khoan, chưa triển khai"), (95, 110, "Kiểm thử trước")))
    output = reconcile_transcript(approved, inputs, settings())
    assert {(s.text, s.interval) for s in output.segments} == {
        (t.segment.text, t.interval) for item in inputs for t in item.timeline_segments
    }


def test_distinct_repetitions_next_to_censored_duplicate_are_preserved():
    approved = plan()
    wording = "Kiểm thử API Kubernetes"
    inputs = (result(approved.chunks[0], (50, 65, wording), (70, 95, wording)),
              result(approved.chunks[1], (80, 90, "API Kubernetes"), (130, 145, wording)))
    output = reconcile_transcript(approved, inputs, settings())
    assert [(s.text, s.interval) for s in output.segments] == [
        (wording, SampleInterval(50, 65)), (wording, SampleInterval(70, 95)),
        (wording, SampleInterval(130, 145)),
    ]


def test_request_edge_replay_cannot_be_proved_from_repeated_wording_and_a_partial_witness():
    approved = plan()
    inputs = (result(approved.chunks[0],
                     (50, 90, "Khi kiểm thử đã xong rồi, kiểm thử đã ổn rồi"),
                     (90, 120, "Kiểm thử xong rồi, kiểm thử đã ổn rồi")),
              result(approved.chunks[1], (80, 95, "Kiểm thử ổn rồi"), (115, 140, "Chuyển sang bước tiếp theo")))
    output = reconcile_transcript(approved, inputs, settings())
    assert len(output.segments) == 4
    assert output.observations.established_redundant_hypothesis_count == 0
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)


def test_partial_three_source_group_needs_one_complete_temporal_representation():
    approved = plan()
    extra = replace(approved.chunks[0], chunk_id="recovery-000000", ordinal=2,
                    core_interval=SampleInterval(85, 120), request_interval=SampleInterval(85, 150))
    inputs = (result(approved.chunks[0], (70, 110, "Kiểm thử API Kubernetes")),
              result(approved.chunks[1], (80, 115, "Kiểm thử API Kubernetes")),
              result(extra, (85, 95, "API Kubernetes")))
    output = reconcile_transcript(approved, inputs, settings())
    # Both complete observations cover the fragment; neither covers the other.
    assert len(output.segments) == 3
    assert output.observations.established_redundant_hypothesis_count == 0


def test_many_censored_boundaries_remain_local_and_keep_chronological_repetition():
    approved = plan(128)
    inputs = []
    for chunk in approved.chunks:
        segments = []
        if chunk.ordinal:
            start = chunk.request_interval.start_sample
            segments.append((start, start + 10, f"API-v2 Kubernetes {chunk.ordinal}"))
        if chunk.ordinal + 1 < len(approved.chunks):
            end = chunk.core_interval.end_sample
            segments.append((end - 30, end, f"Kiểm thử API-v2 Kubernetes {chunk.ordinal + 1}"))
        inputs.append(result(chunk, *segments))
    output = reconcile_transcript(approved, tuple(inputs), settings())
    assert len(output.segments) == 127
    assert output.observations.established_redundant_hypothesis_count == 127
    assert output.observations.temporal_candidate_count == output.observations.lexical_comparison_count == 127
    assert output == reconcile_transcript(approved, tuple(reversed(inputs)), settings())
