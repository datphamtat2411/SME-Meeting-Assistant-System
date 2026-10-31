import traceback
import unicodedata
from collections.abc import Mapping
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
        AsrQualityMetadata(), AsrUsage(), provenance or AsrProvenance("fake", "model"),
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


def test_boundary_crossing_speech_stitches_source_words_without_core_cutting():
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (70, 115, "Chúng ta triển khai API-v2")),
        result(approved.chunks[1], (90, 150, "triển khai API-v2 vào ngày mai.")),
    ), settings())
    segment, = output.segments
    assert segment.text == "Chúng ta triển khai API-v2 vào ngày mai."
    assert segment.interval == SampleInterval(70, 150)
    assert ReconciliationFlag.UNRESOLVED_BOUNDARY in segment.flags
    assert segment.source_chunk_ids == ("chunk-000000", "chunk-000001")


@pytest.mark.parametrize("left,right", [
    ("Tôi đồng ý", "ý kiến khác"),
    ("vâng vâng", "vâng vâng tiếp tục"),
    ("a b a b", "a b rồi tiếp"),
    ("Giá là 10 triệu", "Giá là 20 triệu"),
    ("Dùng C++ hôm nay", "Dùng C# hôm nay"),
])
def test_short_repeated_or_conflicting_alignments_preserve_alternatives(left, right):
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (85, 110, left)),
        result(approved.chunks[1], (95, 140, right)),
    ), settings())
    segment, = output.segments
    assert {segment.text, *segment.alternatives} == {left, right}
    assert ReconciliationFlag.CONFLICTING_OVERLAP in segment.flags
    assert segment.interval == SampleInterval(85, 140)
    assert len(segment.source_chunk_ids) == 2


def test_minimum_shared_tokens_changes_only_partial_alignment():
    approved = plan()
    inputs = (result(approved.chunks[0], (80, 115, "mở dự án")),
              result(approved.chunks[1], (90, 130, "dự án mới")))
    merged = reconcile_transcript(approved, inputs, settings())
    ambiguous = reconcile_transcript(
        approved, inputs, settings(audio_asr_reconciliation_min_shared_tokens=3),
    )
    assert merged.segments[0].text == "mở dự án mới"
    assert ReconciliationFlag.CONFLICTING_OVERLAP in ambiguous.segments[0].flags


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
    assert output.segments[0].source_chunk_ids == ("chunk-000000", "chunk-000001", "recovery-000001")
    assert len(output.chunk_outcomes) == 3


def test_overlap_union_cannot_erase_nonoverlapping_same_chunk_repetitions():
    approved = plan()
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (80, 90, "vâng"), (105, 115, "vâng")),
        result(approved.chunks[1], (85, 110, "vâng")),
    ), settings())
    assert len(output.segments) == 2
    assert [s.text for s in output.segments] == ["vâng", "vâng"]


def test_transitive_overlap_cannot_erase_nonoverlapping_repetitions_across_chunks():
    approved = plan()
    recovery = replace(approved.chunks[0], chunk_id="recovery-1", ordinal=2,
                       core_interval=SampleInterval(80, 120), request_interval=SampleInterval(80, 120))
    inputs = (result(approved.chunks[0], (80, 90, "vâng")),
              result(recovery, (85, 110, "vâng")),
              result(approved.chunks[1], (105, 115, "vâng")))
    output = reconcile_transcript(approved, inputs, settings())
    assert len(output.segments) == 2
    assert [s.text for s in output.segments] == ["vâng", "vâng"]
    assert all(ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags for s in output.segments)
    assert output == reconcile_transcript(approved, tuple(reversed(inputs)), settings())


def test_stitch_chain_uses_observed_source_overlap_and_retains_all_sources():
    approved = plan()
    recovery = replace(approved.chunks[1], chunk_id="recovery-1", ordinal=2,
                       core_interval=SampleInterval(120, 155), request_interval=SampleInterval(120, 160))
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (70, 105, "bắt đầu triển khai")),
        result(approved.chunks[1], (95, 135, "triển khai dự án")),
        result(recovery, (125, 155, "dự án ngày mai")),
    ), settings())
    segment, = output.segments
    assert segment.text == "bắt đầu triển khai dự án ngày mai"
    assert segment.interval == SampleInterval(70, 155)
    assert segment.source_chunk_ids == ("chunk-000000", "chunk-000001", "recovery-1")


def test_later_conflicts_keep_previously_stitched_alternatives():
    approved = plan()
    recovery = replace(approved.chunks[0], chunk_id="recovery-1", ordinal=2,
                       core_interval=SampleInterval(85, 115), request_interval=SampleInterval(80, 150))
    another = replace(recovery, chunk_id="recovery-2", ordinal=3)
    output = reconcile_transcript(approved, (
        result(approved.chunks[0], (70, 115, "bắt đầu triển khai")),
        result(approved.chunks[1], (80, 140, "triển khai dự án")),
        result(recovery, (90, 120, "cần thảo luận")),
        result(another, (95, 125, "chưa thống nhất")),
    ), settings())
    segment, = output.segments
    assert "bắt đầu triển khai dự án" in (segment.text, *segment.alternatives)
    assert {"cần thảo luận", "chưa thống nhất"} <= {segment.text, *segment.alternatives}


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
        inputs = (replace(item, chunk=replace(item.chunk, chunk_id="recovery-1", ordinal=2,
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
    assert output.provenance.reconciler_version == "1"
    assert output.provenance.planning == approved.provenance
    assert output.provenance.effective_configuration["min_shared_tokens"] == 2
    assert [identity for identity, _ in output.provenance.asr] == [c.chunk_id for c in approved.chunks]


def test_safe_provenance_drops_unapproved_inference_fields():
    approved = plan()
    metadata = AsrProvenance("fake", "model", inference_config=(
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
    recovery = replace(approved.chunks[0], chunk_id="recovery-1", ordinal=1,
                       core_interval=SampleInterval(10, 20), request_interval=SampleInterval(5, 25))
    inputs = (result(approved.chunks[0], (0, 10, "lời gốc")), result(recovery, (10, 20, "phục hồi")))
    configuration = settings(audio_asr_recovery_max_total_attempts=1)
    assert len(reconcile_transcript(approved, inputs, configuration).chunk_outcomes) == 2
    extra = replace(recovery, chunk_id="recovery-2", ordinal=2)
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
