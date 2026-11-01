import traceback
import unicodedata
from collections.abc import Mapping
from concurrent.futures import CancelledError
from dataclasses import FrozenInstanceError, fields, is_dataclass, replace
from fractions import Fraction

import pytest

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import (
    AudioProvenance,
    DetectionProvenance,
    SampleInterval,
    SpeechMapProvenance,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import PreprocessingProvenance
from sme_meeting_ai.transcription import (
    AsrCandidate,
    AsrChunk,
    AsrChunkPlan,
    AsrChunkResult,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrTimelineSegment,
    AsrUsage,
    AsrWord,
    ChunkBoundaryReason,
    ChunkPlanningProvenance,
    ReconciliationChunkState,
    ReconciliationFlag,
    reconcile_transcript,
)


def settings(**overrides):
    return Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                    **overrides)


def plan(count=2):
    size = count * 100
    detection = DetectionProvenance("vad", "1", "a" * 64, "fake", "1", {})
    preprocessing = PreprocessingProvenance(
        "1", "source", size, AudioProvenance("source", "1", "fake", "1", {}, {}),
        detection, SpeechMapProvenance("source", size, "1", detection, {}),
    )
    reasons = [ChunkBoundaryReason.TIMELINE_START] + [
        ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH
    ] * (count - 1) + [ChunkBoundaryReason.TIMELINE_END]
    chunks = tuple(AsrChunk(
        f"chunk-{i:06d}", i, SampleInterval(i * 100, (i + 1) * 100),
        SampleInterval(max(0, i * 100 - 20), min(size, (i + 1) * 100 + 20)),
        reasons[i], reasons[i + 1],
    ) for i in range(count))
    configuration = {
        "target_core_samples": 100, "max_request_samples": 140, "overlap_samples": 40,
        "boundary_search_samples": 0, "max_chunks": 4096, "max_timeline_samples": 230400000,
        "max_core_samples": 100, "left_context_samples": 20, "right_context_samples": 20,
        "minimum_progress_samples": 100,
    }
    return AsrChunkPlan("source", size, chunks,
                        ChunkPlanningProvenance("1", preprocessing, configuration))


def result(chunk, *segments, text=None, provenance=None):
    relative = tuple(AsrSegment(
        Fraction(start - chunk.request_interval.start_sample, 16000),
        Fraction(end - chunk.request_interval.start_sample, 16000), wording,
    ) for start, end, wording in segments)
    candidate = AsrCandidate(
        text if text is not None else " ".join(item.text for item in relative), relative,
        AsrQualityMetadata(), AsrUsage(), provenance or AsrProvenance("openrouter", "openai/whisper-large-v3"),
        chunk.chunk_id,
    )
    return AsrChunkResult(chunk, candidate, tuple(
        AsrTimelineSegment(segment, SampleInterval(start, end))
        for segment, (start, end, _) in zip(relative, segments, strict=True)
    ))


def test_exact_duplicate_uses_core_ownership_without_changing_source_timing():
    approved = plan()
    left = result(approved.chunks[0], (98, 118, "Xin chào API-v2!"))
    right = result(approved.chunks[1], (100, 119, "xin CHÀO API-v2!"))
    output = reconcile_transcript(approved, (left, right), settings())
    assert output.provisional is True
    assert output.source_id == "source" and output.sample_count == 200
    assert output.sample_rate_hz == 16000
    assert len(output.segments) == 1
    segment = output.segments[0]
    assert segment.text == right.candidate.segments[0].text
    assert segment.interval == SampleInterval(100, 119)
    assert segment.source_chunk_ids == ("chunk-000000", "chunk-000001")
    assert segment.flags == (ReconciliationFlag.DUPLICATE_OVERLAP,)
    assert output.unresolved_intervals == (SampleInterval(0, 100), SampleInterval(119, 200))


@pytest.mark.parametrize("wording", ["ừ ừ", "vâng, vâng", "Triển khai Kubernetes API-v2, OK!", "C++ != C#"])
def test_nonoverlapping_repetitions_are_preserved(wording):
    approved = plan()
    inputs = (result(approved.chunks[0], (80, 95, wording)),
              result(approved.chunks[1], (95, 115, wording)))
    output = reconcile_transcript(approved, inputs, settings())
    assert [s.text for s in output.segments] == [wording, wording]
    assert all(not s.flags for s in output.segments)


def test_unicode_normalization_is_comparison_only():
    approved = plan()
    original = unicodedata.normalize("NFD", "Xin chào, API!")
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (85, 105, original)),
        result(approved.chunks[1], (85, 105, "xin chào, API!")),
    ), settings())
    assert output.segments[0].text == original
    assert len(output.segments) == 1


def test_boundary_crossing_partial_support_never_stitches_or_expands_timing():
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (70, 115, "Chúng ta triển khai API-v2")),
        result(approved.chunks[1], (90, 150, "triển khai API-v2 vào ngày mai.")),
    ), settings())
    # V1 asserted synthetic stitching. Preserve its no-core-cutting intent using
    # intact observed wording and intervals, with explicit partial uncertainty.
    assert [(s.text, s.interval) for s in output.segments] == [
        ("Chúng ta triển khai API-v2", SampleInterval(70, 115)),
        ("triển khai API-v2 vào ngày mai.", SampleInterval(90, 150)),
    ]
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)
    assert output.relationships[0].classification.value == "partial-support"


@pytest.mark.parametrize("left,right", [
    ("Tôi đồng ý", "ý kiến khác"),
    ("vâng vâng", "vâng vâng tiếp tục"),
    ("a b a b", "a b rồi tiếp"),
    ("Giá là 10 triệu", "Giá là 20 triệu"),
    ("Dùng C++ hôm nay", "Dùng C# hôm nay"),
])
def test_overlap_without_established_occurrence_preserves_both_candidates(left, right):
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (85, 110, left)),
        result(approved.chunks[1], (95, 140, right)),
    ), settings())
    # V1 treated any pairwise overlap as a conflict and expanded timestamps.
    # Neither is occurrence proof; keep all original evidence instead.
    assert [s.text for s in output.segments] == [left, right]
    assert [s.interval for s in output.segments] == [SampleInterval(85, 110), SampleInterval(95, 140)]
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)


def test_minimum_shared_tokens_changes_only_partial_alignment():
    approved = plan()
    inputs = (result(approved.chunks[0], (80, 115, "mở dự án")),
              result(approved.chunks[1], (90, 130, "dự án mới")))
    merged = reconcile_transcript(approved, inputs, settings())
    ambiguous = reconcile_transcript(
        approved, inputs, settings(audio_asr_reconciliation_min_shared_tokens=3),
    )
    # Minimum anchors classify support, never authorize stitching.
    assert len(merged.segments) == len(ambiguous.segments) == 2
    assert merged.relationships[0].classification.value == "partial-support"
    assert ambiguous.relationships[0].classification.value == "ambiguous"


def test_missing_failed_empty_and_malformed_chunks_never_fabricate_text():
    approved = plan(5)
    malformed = result(approved.chunks[3], (300, 310, "private candidate"))
    malformed = replace(malformed, timeline_segments=())
    output = reconcile_transcript(approved, (
        AsrChunkResult(approved.chunks[1], failure=AsrErrorCategory.TIMEOUT),
        result(approved.chunks[2]), malformed,
        result(approved.chunks[4], (410, 420, "có lời")),
    ), settings())
    assert [item.state for item in output.chunk_outcomes] == [
        ReconciliationChunkState.MISSING, ReconciliationChunkState.FAILED,
        ReconciliationChunkState.EMPTY, ReconciliationChunkState.MALFORMED,
        ReconciliationChunkState.CANDIDATE_EVIDENCE,
    ]
    assert [o.core_interval for o in output.chunk_outcomes] == [c.core_interval for c in approved.chunks]
    assert output.chunk_outcomes[1].failure is AsrErrorCategory.TIMEOUT
    assert output.chunk_outcomes[3].failure is AsrErrorCategory.MALFORMED_OUTPUT
    assert output.unresolved_intervals == (SampleInterval(0, 410), SampleInterval(420, 500))
    assert [s.text for s in output.segments] == ["có lời"]


@pytest.mark.parametrize("mutation", [
    lambda r: replace(r, candidate=replace(r.candidate, chunk_id="wrong")),
    lambda r: replace(r, candidate=replace(r.candidate, text="unlocated", segments=())),
    lambda r: replace(r, failure=AsrErrorCategory.TIMEOUT),
    lambda r: replace(r, failure="private failure"),
    lambda r: replace(r, timeline_segments=(replace(r.timeline_segments[0], interval=SampleInterval(1, 2)),)),
    lambda r: replace(r, candidate=replace(r.candidate, segments=(replace(r.candidate.segments[0], start=Fraction(1, 32000)),))),
])
def test_malformed_candidate_is_isolated_to_its_chunk(mutation):
    approved = plan()
    output = reconcile_transcript(approved, (
        mutation(result(approved.chunks[0], (10, 20, "private evidence"))),
        result(approved.chunks[1], (130, 140, "hợp lệ")),
    ), settings())
    assert output.chunk_outcomes[0].state is ReconciliationChunkState.MALFORMED
    assert [s.text for s in output.segments] == ["hợp lệ"]


def test_empty_segment_does_not_bridge_an_unsupported_gap():
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (10, 20, "lời đầu"), (20, 80, "  "), (80, 90, "lời sau")),
    ), settings())
    assert [s.interval for s in output.segments] == [SampleInterval(10, 20), SampleInterval(80, 90)]
    assert SampleInterval(20, 80) in output.unresolved_intervals


def test_approved_recovery_shaped_results_are_order_independent():
    approved = plan()
    recovery = replace(approved.chunks[0], chunk_id="recovery-000001", ordinal=2,
                       core_interval=SampleInterval(85, 115), request_interval=SampleInterval(80, 120))
    inputs = (result(approved.chunks[0], (85, 110, "đồng ý")),
              result(approved.chunks[1], (100, 115, "khác biệt")),
              result(recovery, (90, 112, "đồng ý")))
    output = reconcile_transcript(approved, inputs, settings())
    assert output == reconcile_transcript(approved, tuple(reversed(inputs)), settings())
    assert any(s.source_chunk_ids == ("chunk-000000", "recovery-000001") for s in output.segments)
    assert any(s.text == "khác biệt" for s in output.segments)
    assert len(output.chunk_outcomes) == 3


def test_overlap_union_cannot_erase_nonoverlapping_same_chunk_repetitions():
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (80, 90, "vâng"), (105, 115, "vâng")),
        result(approved.chunks[1], (85, 110, "vâng")),
    ), settings())
    # V2 also preserves the uncertain neighboring hypothesis, rather than
    # greedily consuming it into one of the same-chunk repetitions.
    assert len(output.segments) == 3
    assert [s.text for s in output.segments] == ["vâng"] * 3


def test_transitive_overlap_cannot_erase_nonoverlapping_repetitions_across_chunks():
    approved = plan()
    recovery = replace(approved.chunks[0], chunk_id="recovery-000001", ordinal=2,
                       core_interval=SampleInterval(80, 120), request_interval=SampleInterval(80, 120))
    inputs = (result(approved.chunks[0], (80, 90, "vâng")),
              result(recovery, (85, 110, "vâng")),
              result(approved.chunks[1], (105, 115, "vâng")))
    output = reconcile_transcript(approved, inputs, settings())
    assert len(output.segments) == 3
    assert [s.text for s in output.segments] == ["vâng"] * 3
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)
    assert output == reconcile_transcript(approved, tuple(reversed(inputs)), settings())


def test_partial_chain_retains_all_intact_sources_without_synthetic_nodes():
    approved = plan()
    recovery = replace(approved.chunks[1], chunk_id="recovery-000001", ordinal=2,
                       core_interval=SampleInterval(120, 155), request_interval=SampleInterval(120, 160))
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (70, 105, "bắt đầu triển khai")),
        result(approved.chunks[1], (95, 135, "triển khai dự án")),
        result(recovery, (125, 155, "dự án ngày mai")),
    ), settings())
    assert [s.text for s in output.segments] == [
        "bắt đầu triển khai", "triển khai dự án", "dự án ngày mai",
    ]
    assert [s.interval for s in output.segments] == [
        SampleInterval(70, 105), SampleInterval(95, 135), SampleInterval(125, 155),
    ]


def test_later_unrelated_evidence_cannot_turn_partial_chain_into_a_clean_group():
    approved = plan()
    recovery = replace(approved.chunks[0], chunk_id="recovery-000001", ordinal=2,
                       core_interval=SampleInterval(85, 115), request_interval=SampleInterval(80, 150))
    another = replace(recovery, chunk_id="recovery-000002", ordinal=3)
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (70, 115, "bắt đầu triển khai")),
        result(approved.chunks[1], (80, 140, "triển khai dự án")),
        result(recovery, (90, 120, "cần thảo luận")),
        result(another, (95, 125, "chưa thống nhất")),
    ), settings())
    # Replace V1's fabricated-alternative assertion with source-only retention.
    assert {s.text for s in output.segments} == {
        "bắt đầu triển khai", "triển khai dự án", "cần thảo luận", "chưa thống nhất",
    }
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)


def test_multiple_possible_alignments_preserve_all_repeated_units():
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (80, 90, "vâng"), (100, 110, "vâng")),
        result(approved.chunks[1], (85, 105, "vâng")),
    ), settings())
    assert len(output.segments) >= 2
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)


@pytest.mark.parametrize("kind", ["plan", "duplicate", "foreign", "bounds", "settings"])
def test_invalid_global_handoffs_fail_with_sanitized_context(kind):
    approved = plan()
    item = result(approved.chunks[0], (10, 20, "private-input"))
    inputs = (item,)
    configuration = settings()
    if kind == "plan":
        approved = replace(approved, source_id="private-input")
    elif kind == "duplicate":
        inputs = (item, item)
    elif kind == "foreign":
        inputs = (replace(item, chunk=replace(item.chunk, chunk_id="private-input")),)
    elif kind == "bounds":
        inputs = (replace(item, chunk=replace(item.chunk, chunk_id="recovery-000001", ordinal=2,
                                             request_interval=SampleInterval(0, 201))),)
    else:
        configuration = configuration.model_copy(update={"audio_asr_reconciliation_min_shared_tokens": True})
    with pytest.raises(AudioProcessingError) as caught:
        reconcile_transcript(approved, inputs, configuration)
    assert "private-input" not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None and caught.value.__cause__ is None


def test_output_is_immutable_sensitive_repr_free_and_retains_no_candidates(caplog):
    approved = plan()
    inputs = (result(approved.chunks[0], (85, 110, "private-primary"), text="private-raw"),
              result(approved.chunks[1], (95, 140, "private-alternative")))
    output = reconcile_transcript(approved, inputs, settings())
    for secret in ("private-primary", "private-raw", "private-alternative"):
        assert secret not in repr(output)
        assert secret not in repr(output.segments[0])
        assert secret not in caplog.text

    def assert_derived(value):
        assert not isinstance(value, (AsrCandidate, AsrSegment, AsrChunkResult))
        if is_dataclass(value):
            for item in fields(value):
                assert_derived(getattr(value, item.name))
        elif isinstance(value, Mapping):
            for item in value.values():
                assert_derived(item)
        elif isinstance(value, tuple):
            for item in value:
                assert_derived(item)

    assert_derived(output)
    with pytest.raises(FrozenInstanceError):
        output.segments[0].text = "changed"
    with pytest.raises(TypeError):
        output.provenance.effective_configuration["min_shared_tokens"] = 10
    assert output.provenance.reconciler_version == "2"
    assert output.provenance.planning == approved.provenance
    assert output.provenance.effective_configuration["min_shared_tokens"] == 2
    assert [identity for identity, _ in output.provenance.asr] == [c.chunk_id for c in approved.chunks]


def test_safe_provenance_drops_unapproved_inference_fields():
    approved = plan()
    metadata = AsrProvenance("openrouter", "openai/whisper-large-v3", inference_config=(
        ("prompt", "private-prompt"), ("language", "vi"), ("temperature", 0.0),
    ))
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (10, 20, "lời nói"), provenance=metadata),
    ), settings())
    assert output.provenance.asr[0][1].inference_config == (("language", "vi"), ("temperature", 0.0))
    assert "private-prompt" not in repr(output)


def test_result_limit_includes_only_configured_recovery_attempts():
    approved = plan(1)
    approved = replace(approved, provenance=replace(approved.provenance, effective_configuration={
        **approved.provenance.effective_configuration, "max_chunks": 1,
    }))
    recovery = replace(approved.chunks[0], chunk_id="recovery-000001", ordinal=1,
                       core_interval=SampleInterval(10, 20), request_interval=SampleInterval(5, 25))
    inputs = (result(approved.chunks[0], (0, 10, "lời gốc")), result(recovery, (10, 20, "phục hồi")))
    configuration = settings(audio_asr_recovery_max_total_attempts=1)
    assert len(reconcile_transcript(approved, inputs, configuration).chunk_outcomes) == 2
    extra = replace(recovery, chunk_id="recovery-000002", ordinal=2)
    with pytest.raises(AudioProcessingError):
        reconcile_transcript(approved, (*inputs, result(extra)), configuration)


def test_segment_identities_are_deterministic_server_owned_and_chronological():
    approved = plan()
    inputs = (result(approved.chunks[0], (80, 90, "lời đầu")),
              result(approved.chunks[1], (120, 130, "lời sau")))
    output = reconcile_transcript(approved, tuple(reversed(inputs)), settings())
    assert [(s.segment_id, s.ordinal) for s in output.segments] == [
        ("segment-000000", 0), ("segment-000001", 1),
    ]
    assert output == reconcile_transcript(approved, inputs, settings())


def test_whole_file_preserves_same_request_repetition_without_boundary_report():
    approved = plan(1)
    count = approved.sample_count
    approved = replace(approved, provenance=replace(approved.provenance, planner_version="whole-file-v1",
        effective_configuration={
            "target_core_samples": count, "max_request_samples": count, "overlap_samples": 0,
            "boundary_search_samples": 0, "max_chunks": 1, "max_core_samples": count,
            "left_context_samples": 0, "right_context_samples": 0, "minimum_progress_samples": count,
            "max_timeline_samples": 230400000, "native_max_samples": count,
            "effective_payload_limit": 44 + count * 2, "expected_wav_bytes": 44 + count * 2,
        }))
    inputs = (result(approved.chunks[0], (0, 20, "Vâng."), (20, 40, "Vâng.")),)
    output = reconcile_transcript(approved, inputs, settings())
    assert [(s.text, s.interval) for s in output.segments] == [
        (t.segment.text, t.interval) for t in inputs[0].timeline_segments
    ]
    assert not output.relationships and all(not s.flags for s in output.segments)
    assert output.observations.genuine_repetition_preservation_count == 2


@pytest.mark.parametrize("wording", ["ừ", "vâng", "dạ", "ok", "vâng vâng", "đúng rồi đúng rồi", "chúng ta"])
def test_common_or_repeated_anchors_cannot_establish_duplicate_identity(wording):
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (90, 110, wording)),
        result(approved.chunks[1], (90, 110, wording)),
    ), settings())
    assert len(output.segments) == 2
    assert output.observations.established_redundant_hypothesis_count == 0
    assert output.observations.ambiguous_occurrence_count == 2
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)


@pytest.mark.parametrize("parts", [
    ("Chúng ta sẽ triển khai API mới", "và kiểm thử hệ thống."),
    ("Chúng ta sẽ triển khai", "API mới và kiểm thử", "hệ thống."),
])
@pytest.mark.parametrize("long_on_left", [True, False])
def test_unique_complete_monotonic_long_short_paths(parts, long_on_left):
    approved = plan()
    full = " ".join(parts)
    long_chunk, short_chunk = approved.chunks if long_on_left else tuple(reversed(approved.chunks))
    step = 30 // len(parts)
    inputs = (result(long_chunk, (85, 115, full)), result(short_chunk, *(
        (85 + i * step, 85 + (i + 1) * step, text) for i, text in enumerate(parts)
    )))
    output = reconcile_transcript(approved, inputs, settings())
    assert " ".join(s.text for s in output.segments) == full
    observed = {(t.segment.text, t.interval) for r in inputs for t in r.timeline_segments}
    assert all((s.text, s.interval) in observed for s in output.segments)
    assert all(len(s.source_chunk_ids) == 2 and s.supporting_evidence_ids for s in output.segments)
    assert output.observations.raw_source_segment_count == len(parts) + 1
    assert output.observations.canonical_segment_count == len(output.segments)
    assert output.observations.established_redundant_hypothesis_count == len(observed) - len(output.segments)
    assert output.observations.one_to_many_alignment_count == int(long_on_left)
    assert output.observations.many_to_one_alignment_count == int(not long_on_left)
    assert output == reconcile_transcript(approved, tuple(reversed(inputs)), settings())


def test_short_path_can_be_selected_without_concatenating_its_segments():
    approved = plan()
    inputs = (result(approved.chunks[0], (98, 118, "Triển khai API mới kiểm thử Kubernetes")),
              result(approved.chunks[1], (98, 108, "Triển khai API mới"), (108, 118, "kiểm thử Kubernetes")))
    output = reconcile_transcript(approved, inputs, settings())
    assert [s.text for s in output.segments] == ["Triển khai API mới", "kiểm thử Kubernetes"]
    assert [s.interval for s in output.segments] == [SampleInterval(98, 108), SampleInterval(108, 118)]


def test_additional_material_and_ambiguous_repeated_subsequence_are_not_erased():
    approved = plan()
    for full, short in (
        ("Chúng ta kiểm tra API, sau đó triển khai bản mới.", "Chúng ta kiểm tra API."),
        ("Hello anh Hiếu nha! Hello anh Hiếu nha!", "Hello anh Hiếu nha!"),
    ):
        output = reconcile_transcript(approved, (
            result(approved.chunks[0], (85, 115, full)), result(approved.chunks[1], (90, 110, short)),
        ), settings())
        assert {s.text for s in output.segments} == {full, short}
        assert output.observations.established_redundant_hypothesis_count == 0


def test_short_observation_cannot_choose_between_multiple_long_hypotheses():
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (85, 115, "Triển khai API-v2")),
        result(approved.chunks[1], (85, 100, "Triển khai API-v2 vào sáng mai"),
               (100, 115, "Triển khai API-v2 và kiểm thử Kubernetes")),
    ), settings())
    assert len(output.segments) == 3
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)


def test_nontransitive_established_edges_require_complete_group_consistency():
    approved = plan()
    recovery = replace(approved.chunks[0], chunk_id="recovery-000001", ordinal=2,
                       core_interval=SampleInterval(80, 120), request_interval=SampleInterval(80, 120))
    wording = "Hello anh Hiếu nha!"
    inputs = (result(approved.chunks[0], (80, 90, wording)), result(recovery, (85, 110, wording)),
              result(approved.chunks[1], (105, 115, wording)))
    output = reconcile_transcript(approved, inputs, settings())
    assert len(output.segments) == 3
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)
    assert output.observations.established_redundant_hypothesis_count == 0


@pytest.mark.parametrize("left,right", [
    ("Giá là 10 triệu", "Giá là 20 triệu"),
    ("Dùng C++ hôm nay", "Dùng C# hôm nay"),
    ("Triển khai API-v2 với Kubernetes JWT OAuth", "Triển khai API-v3 với Kubernetes JWT OAuth"),
])
def test_anchored_substitution_same_observed_envelope_is_one_conflicting_occurrence(left, right):
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (85, 110, left)), result(approved.chunks[1], (85, 110, right)),
    ), settings())
    segment, = output.segments
    assert segment.text == left and segment.alternatives == (right,)
    assert segment.interval == SampleInterval(85, 110)
    assert ReconciliationFlag.CONFLICTING_OVERLAP in segment.flags
    assert segment.alternative_evidence_ids[0].chunk_id == approved.chunks[1].chunk_id
    assert output.observations.conflicting_hypothesis_count == 1


def test_concurrent_unrelated_speech_and_distinct_technical_terms_are_not_duplicates():
    approved = plan()
    for left, right in (("Báo cáo doanh thu", "Kiểm thử Kubernetes"), ("C++", "C#"),
                        ("API-v2", "API-v3"), ("ma", "má")):
        output = reconcile_transcript(approved, (
            result(approved.chunks[0], (85, 110, left)), result(approved.chunks[1], (85, 110, right)),
        ), settings())
        assert len(output.segments) == 2
        assert output.observations.established_redundant_hypothesis_count == 0


def with_words(item, *words):
    return replace(item, candidate=replace(item.candidate, words=tuple(
        AsrWord(Fraction(start - item.chunk.request_interval.start_sample, 16000),
                Fraction(end - item.chunk.request_interval.start_sample, 16000), text)
        for start, end, text in words
    )))


def test_actual_word_timing_can_disambiguate_short_evidence_without_retiming():
    approved = plan()
    inputs = (with_words(result(approved.chunks[0], (85, 110, "Vâng.")), (95, 100, "Vâng")),
              with_words(result(approved.chunks[1], (90, 115, "vâng")), (95, 100, "vâng")))
    output = reconcile_transcript(approved, inputs, settings())
    assert len(output.segments) == 1
    assert output.segments[0].interval in (SampleInterval(85, 110), SampleInterval(90, 115))
    assert output.segments[0].interval != SampleInterval(95, 100)
    malformed = with_words(inputs[0], (70, 80, "Vâng"))
    output = reconcile_transcript(approved, (malformed, inputs[1]), settings())
    assert output.chunk_outcomes[0].state is ReconciliationChunkState.MALFORMED
    contradictory = with_words(inputs[1], (105, 110, "vâng"))
    assert len(reconcile_transcript(approved, (inputs[0], contradictory), settings()).segments) == 2


def test_recovery_has_no_priority_and_failed_recovery_preserves_baseline_and_repetition():
    approved = plan()
    recovery = replace(approved.chunks[0], chunk_id="recovery-000001", ordinal=2)
    baseline = result(approved.chunks[0], (10, 30, "Dùng C++ hôm nay"), (60, 80, "Dùng C++ hôm nay"))
    competing = result(recovery, (10, 30, "Dùng C# hôm nay"), (60, 80, "Dùng C++ hôm nay"))
    output = reconcile_transcript(approved, (baseline, competing), settings())
    assert [s.text for s in output.segments] == ["Dùng C++ hôm nay"] * 2
    assert output.segments[0].alternatives == ("Dùng C# hôm nay",)
    output = reconcile_transcript(approved, (baseline, AsrChunkResult(recovery, failure=AsrErrorCategory.TIMEOUT)), settings())
    assert len(output.segments) == 2


def test_unresolved_union_is_exact_with_concurrent_intervals():
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (10, 30, "một lời"), (80, 110, "lời khác")),
        result(approved.chunks[1], (90, 120, "độc lập"), (150, 160, "kết thúc")),
    ), settings())
    assert output.unresolved_intervals == (SampleInterval(0, 10), SampleInterval(30, 80),
                                           SampleInterval(120, 150), SampleInterval(160, 200))
    assert output.observations.unresolved_interval_samples == 130


def test_distant_long_meeting_evidence_has_no_global_lexical_comparisons(monkeypatch):
    from sme_meeting_ai.transcription import reconciliation as engine

    approved = plan(1000)
    comparisons = []
    original = engine._align_paths

    def observe(*args, **kwargs):
        comparisons.append(True)
        return original(*args, **kwargs)

    monkeypatch.setattr(engine, "_align_paths", observe)
    output = reconcile_transcript(approved, tuple(
        result(chunk, (chunk.core_interval.start_sample + 30, chunk.core_interval.end_sample - 30,
                       "Triển khai API-v2 Kubernetes")) for chunk in approved.chunks
    ), settings())
    assert len(output.segments) == 1000 and comparisons == []
    assert output.observations.temporal_candidate_count == output.observations.lexical_comparison_count == 0


@pytest.mark.parametrize("failure", ["resource", "cancel"])
def test_bounded_work_and_cancellation_release_private_failure_frames(monkeypatch, failure):
    from sme_meeting_ai.transcription import reconciliation as engine

    approved = plan()
    inputs = (result(approved.chunks[0], (85, 110, "private-evidence")),
              result(approved.chunks[1], (85, 110, "private-evidence")))
    if failure == "resource":
        monkeypatch.setattr(engine, "_MAX_CANDIDATES", 0)
    else:
        def cancel(*args):
            private_text = "private-evidence"
            raise CancelledError(private_text)
        monkeypatch.setattr(engine, "_align_paths", cancel)
    with pytest.raises(AudioProcessingError if failure == "resource" else CancelledError) as caught:
        reconcile_transcript(approved, inputs, settings())
    assert "private-evidence" not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__context__ is None and caught.value.__cause__ is None
    frames = list(traceback.walk_tb(caught.value.__traceback__))
    assert not any(frame.f_locals.get("evidence") for frame, _ in frames)
    assert not any(frame.f_locals.get("results") for frame, _ in frames)
    if failure == "resource":
        assert caught.value.category == "RESOURCE"


def test_internal_evidence_identity_is_immutable_bounded_and_text_independent():
    from sme_meeting_ai.transcription.reconciliation import _collect

    approved = plan()
    chunk = approved.chunks[0]
    _, first, _ = _collect(approved.chunks, (result(chunk, (10, 20, "private-A")),))
    _, second, _ = _collect(approved.chunks, (result(chunk, (10, 20, "private-B")),))
    assert first[0].identity == second[0].identity
    assert "private-A" not in repr(first[0])
    with pytest.raises(FrozenInstanceError):
        first[0].text = "changed"


@pytest.mark.parametrize("natural", [False, True])
def test_actual_t04_contract_is_read_only_context_not_deletion_proof(natural):
    from sme_meeting_ai.transcription.boundary_alignment import (
        BoundaryAlignmentMetrics,
        BoundaryAlignmentReport,
        BoundaryEvidence,
        BoundaryRisk,
        BoundarySegmentSupport,
        WordTimingObservation,
    )

    approved = plan()
    reason = (ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE if natural
              else ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH)
    approved = replace(approved, chunks=(replace(approved.chunks[0], end_boundary_reason=reason),
                                         replace(approved.chunks[1], start_boundary_reason=reason)))
    metrics = BoundaryAlignmentMetrics(**{
        f.name: (approved.provenance.planner_version if f.name == "planner_version" else
                 approved.sample_count if f.name == "source_sample_count" else
                 2 if f.name == "planned_chunk_count" else 0)
        for f in fields(BoundaryAlignmentMetrics)
    })
    inputs = tuple(result(chunk, (85, 115, "Triển khai Kubernetes API-v2")) for chunk in approved.chunks)
    supports = tuple(BoundarySegmentSupport(
        chunk.chunk_id, 0, SampleInterval(85, 115), chunk.request_interval, chunk.core_interval,
        SampleInterval(max(85, chunk.core_interval.start_sample), min(115, chunk.core_interval.end_sample)),
        True, WordTimingObservation.UNAVAILABLE,
    ) for chunk in approved.chunks)
    boundary = BoundaryEvidence(100, "chunk-000000", "chunk-000001", reason, 20, 20,
                                BoundaryRisk.NATURAL_CANDIDATE if natural else BoundaryRisk.FORCED_CONTINUOUS_SPEECH,
                                1, 1, 2, 2, 30, True)
    report = BoundaryAlignmentReport("boundary-alignment-v2", (boundary,), supports, metrics)
    output = reconcile_transcript(approved, inputs, settings(), boundary_alignment=report)
    assert len(output.segments) == 1
    assert (ReconciliationFlag.UNRESOLVED_BOUNDARY in output.segments[0].flags) is (not natural)
    assert report.segment_supports == supports
    unrelated = (inputs[0], result(approved.chunks[1], (85, 115, "Báo cáo doanh thu")))
    output = reconcile_transcript(approved, unrelated, settings(), boundary_alignment=report)
    assert len(output.segments) == 2  # Safe boundary metadata is not lexical proof.
    with pytest.raises(AudioProcessingError):
        reconcile_transcript(approved, inputs, settings(), boundary_alignment=replace(report,
            metrics=replace(metrics, source_sample_count=201)))


def test_displaced_complete_hypotheses_do_not_identify_a_repeated_occurrence():
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (10, 100, "Triển khai API-v2 Kubernetes")),
        result(approved.chunks[1], (90, 190, "Triển khai API-v2 Kubernetes")),
    ), settings())
    assert len(output.segments) == 2
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)


def test_pairwise_established_chain_cannot_authorize_incompatible_group():
    approved = plan()
    supplemental = replace(approved.chunks[0], chunk_id="recovery-000001", ordinal=2,
                           core_interval=SampleInterval(80, 120), request_interval=SampleInterval(80, 120))
    wording = "Hello anh Hiếu nha!"
    inputs = (result(approved.chunks[0], (80, 102, wording)),
              result(approved.chunks[1], (100, 119, wording)), result(supplemental, (90, 112, wording)))
    output = reconcile_transcript(approved, inputs, settings())
    assert len(output.segments) == 3
    assert all(r.classification.value == "ambiguous" for r in output.relationships)
    assert output.observations.established_redundant_hypothesis_count == 0


@pytest.mark.parametrize("kind", ["gateway", "model", "sample-count", "recovery-id", "recovery-geometry"])
def test_global_provenance_and_recovery_contract_contradictions_fail_closed(kind):
    approved = plan()
    item = result(approved.chunks[0], (10, 20, "private-input"))
    if kind == "gateway":
        item = replace(item, candidate=replace(item.candidate, provenance=AsrProvenance("other", "openai/whisper-large-v3")))
    elif kind == "model":
        item = replace(item, candidate=replace(item.candidate, provenance=AsrProvenance("openrouter", "other")))
    elif kind == "sample-count":
        approved = replace(approved, sample_count=201)
    else:
        chunk = replace(approved.chunks[0], ordinal=2,
                        chunk_id="foreign" if kind == "recovery-id" else "recovery-000001")
        if kind == "recovery-geometry":
            chunk = replace(chunk, core_interval=SampleInterval(0, 100), request_interval=SampleInterval(10, 100))
        item = replace(item, chunk=chunk)
    with pytest.raises(AudioProcessingError) as caught:
        reconcile_transcript(approved, (item,), settings())
    assert caught.value.category == "VALIDATION"
    assert "private-input" not in "".join(traceback.format_exception(caught.value))


def test_reconciliation_never_initiates_provider_or_chunk_execution(monkeypatch):
    import httpx

    from sme_meeting_ai.transcription import chunk_execution

    def forbidden(*args, **kwargs):
        pytest.fail("additional inference attempted")

    monkeypatch.setattr(httpx.Client, "send", forbidden)
    monkeypatch.setattr(chunk_execution, "execute_asr_chunks", forbidden)
    monkeypatch.setattr(chunk_execution, "execute_asr_windows", forbidden)
    approved = plan()
    output = reconcile_transcript(approved, (result(approved.chunks[0], (10, 20, "Triển khai API")),), settings())
    assert output.segments[0].text == "Triển khai API"


def test_quality_is_validated_and_unknown_quality_is_not_zero_confidence():
    from sme_meeting_ai.transcription import AsrSegmentQuality

    approved = plan()
    inputs = tuple(result(chunk, (85, 115, "Triển khai API-v2")) for chunk in approved.chunks)

    def quality(item, value):
        source = replace(item.candidate.segments[0], quality=AsrSegmentQuality(confidence=value))
        return replace(item, candidate=replace(item.candidate, segments=(source,)),
                       timeline_segments=(replace(item.timeline_segments[0], segment=source),))

    output = reconcile_transcript(approved, (inputs[0], quality(inputs[1], 0.99)), settings())
    assert output.segments[0].selected_evidence_id.chunk_id == approved.chunks[0].chunk_id
    output = reconcile_transcript(approved, (quality(inputs[0], 0.5), quality(inputs[1], 0.99)), settings())
    assert output.segments[0].selected_evidence_id.chunk_id == approved.chunks[1].chunk_id
    output = reconcile_transcript(approved, (inputs[0], quality(inputs[1], float("nan"))), settings())
    assert output.chunk_outcomes[1].state is ReconciliationChunkState.MALFORMED


@pytest.mark.parametrize("bound", [
    "_MAX_NODES", "_MAX_TEXT_CHARACTERS", "_MAX_TOKENS", "_MAX_ACTIVE",
    "_MAX_LOCAL_NODES", "_MAX_PATH_TOKENS", "_MAX_REFERENCES",
])
def test_each_intermediate_representation_budget_fails_closed(monkeypatch, bound):
    from sme_meeting_ai.transcription import reconciliation as engine

    approved = plan()
    inputs = tuple(result(chunk, (85, 115, "private evidence")) for chunk in approved.chunks)
    monkeypatch.setattr(engine, bound, 0)
    with pytest.raises(AudioProcessingError) as caught:
        reconcile_transcript(approved, inputs, settings())
    assert caught.value.category == "RESOURCE"
    assert caught.value.__context__ is None
    assert "private evidence" not in repr(caught.value)


def test_alignment_work_budget_is_enforced_before_selection(monkeypatch):
    from sme_meeting_ai.transcription import reconciliation as engine

    work_type = engine._Work
    monkeypatch.setattr(engine, "_Work", lambda: work_type(remaining=0))
    approved = plan()
    with pytest.raises(AudioProcessingError) as caught:
        reconcile_transcript(approved, tuple(result(chunk, (85, 115, "private evidence"))
                                             for chunk in approved.chunks), settings())
    assert caught.value.category == "RESOURCE"


def test_many_local_boundaries_have_linear_candidate_and_alignment_counts():
    approved = plan(128)
    inputs = []
    for chunk in approved.chunks:
        boundaries = []
        if chunk.ordinal:
            boundaries.append(chunk.core_interval.start_sample)
        if chunk.ordinal + 1 < len(approved.chunks):
            boundaries.append(chunk.core_interval.end_sample)
        inputs.append(result(chunk, *((b - 5, b + 5, f"Triển khai API-v2 Kubernetes {b}") for b in boundaries)))
    output = reconcile_transcript(approved, tuple(inputs), settings())
    assert len(output.segments) == 127
    assert output.observations.raw_source_segment_count == 254
    assert output.observations.established_redundant_hypothesis_count == 127
    assert output.observations.temporal_candidate_count == output.observations.lexical_comparison_count == 127
