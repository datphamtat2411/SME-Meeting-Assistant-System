import copy
import math
import traceback
from dataclasses import FrozenInstanceError, fields, is_dataclass, replace
from fractions import Fraction
from pathlib import Path

import pytest

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import (
    AudioProbe, AudioProvenance, DetectionProvenance, EvidenceFrame,
    NormalizedAudioArtifact, SampleInterval, SpeechEnergyEvidence, VadLabel,
)
from sme_meeting_ai.audio.speech_map import SpeechMapBuilder
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import (
    PreprocessingAudioMetadata, PreprocessingProvenance, PreprocessingResult,
)
from sme_meeting_ai.transcription import (
    AsrCandidate, AsrChunkResult, AsrErrorCategory, AsrProvenance,
    AsrQualityMetadata, AsrSegment, AsrSegmentQuality, AsrTimelineSegment, AsrUsage,
    CoverageReason, CoverageState, SpeechAwareAsrChunkPlanner, assess_speech_coverage,
)


def settings(**overrides):
    return Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        **({"audio_asr_chunk_target_samples": 1024,
            "audio_asr_chunk_max_request_samples": 1536,
            "audio_asr_chunk_overlap_samples": 512,
            "audio_asr_chunk_boundary_search_samples": 0,
            "audio_speech_map_boundary_padding_samples": 0,
            "audio_speech_map_merge_gap_samples": 0} | overrides),
    )


@pytest.fixture
def handoff(monkeypatch, tmp_path):
    frames_by_id = {}
    replays = []

    def replay(evidence):
        replays.append(evidence.source_id)
        yield from frames_by_id[evidence.source_id]

    monkeypatch.setattr(SpeechEnergyEvidence, "iter_frames", replay)

    def make(labels=("speech",) * 4, *, configuration=None, tail=512):
        configuration = configuration or settings()
        source_id = f"recording-{len(frames_by_id)}"
        count = 512 * (len(labels) - 1) + tail
        probe = AudioProbe(source_id, "wav", "pcm_s16le", 16000, 1, None, None, 0)
        normalization = AudioProvenance(
            source_id, "1", "ffmpeg", "test",
            {"container": "wav", "codec": "pcm_s16le", "sample_format": "s16",
             "sample_rate_hz": 16000, "channels": 1}, {},
        )
        detection = DetectionProvenance(
            "test-vad", "5", "a" * 64, "test", "1",
            {"sample_rate_hz": 16000, "frame_samples": 512,
             "tail_padding": "model-only-zero-padding",
             "speech_threshold": 0.6, "non_speech_threshold": 0.35},
        )
        frames = []
        for index, label in enumerate(labels):
            probability, vad, rms = {
                "speech": (0.9, VadLabel.LIKELY_SPEECH, 0.1),
                "weak": (0.9, VadLabel.LIKELY_SPEECH, 0.0001),
                "silence": (0.1, VadLabel.LIKELY_NON_SPEECH, 0),
                "high": (0.1, VadLabel.LIKELY_NON_SPEECH, 0.1),
                "uncertain": (0.5, VadLabel.UNCERTAIN, 0.01),
            }[label]
            start, end = index * 512, min((index + 1) * 512, count)
            frames.append(EvidenceFrame(
                start, end, probability, vad, rms,
                20 * math.log10(rms) if rms else -math.inf, 512 - (end - start),
            ))
        frames_by_id[source_id] = frames
        audio = NormalizedAudioArtifact(
            tmp_path / "never-open-source.wav", source_id, probe, count, normalization, None,
        )
        evidence = SpeechEnergyEvidence(
            source_id, count, len(frames),
            sum(f.vad_label is VadLabel.LIKELY_SPEECH for f in frames),
            sum(f.vad_label is VadLabel.LIKELY_NON_SPEECH for f in frames),
            sum(f.vad_label is VadLabel.UNCERTAIN for f in frames),
            detection, tmp_path / "never-open-evidence.bin", None,
        )
        speech_map = SpeechMapBuilder(configuration).build(audio, evidence)
        preprocessing = PreprocessingResult(
            audio, PreprocessingAudioMetadata(probe, count), evidence, speech_map,
            speech_map.quality.warnings,
            PreprocessingProvenance("1", source_id, count, normalization, detection, speech_map.provenance),
        )
        plan = SpeechAwareAsrChunkPlanner(configuration).plan(preprocessing)
        replays.clear()
        return preprocessing, plan, configuration

    make.replays = replays
    make.frames = frames_by_id
    return make


def result(chunk, bounds=None, *, text="Nội dung cuộc họp", confidence=None):
    bounds = bounds if bounds is not None else ((chunk.request_interval.start_sample,
                                               chunk.request_interval.end_sample),)
    segments = tuple(AsrSegment(
        Fraction(start - chunk.request_interval.start_sample, 16000),
        Fraction(end - chunk.request_interval.start_sample, 16000), text,
        AsrSegmentQuality(confidence=confidence),
    ) for start, end in bounds)
    candidate = AsrCandidate(
        text if segments else "", segments, AsrQualityMetadata(), AsrUsage(),
        AsrProvenance("fake", "test-model"), chunk.chunk_id,
    )
    return AsrChunkResult(chunk, candidate, tuple(
        AsrTimelineSegment(segment, SampleInterval(*interval))
        for segment, interval in zip(segments, bounds, strict=True)
    ))


def states_at(assessment, start, end):
    return tuple(r for r in assessment.regions
                 if r.interval.start_sample < end and start < r.interval.end_sample)


def test_absolute_overlap_is_counted_once_with_duplicate_metadata(handoff):
    preprocessing, plan, configuration = handoff()
    results = tuple(result(c) for c in plan.chunks)
    assessment = assess_speech_coverage(preprocessing, plan, results, configuration)
    assert assessment.quality.likely_speech_samples == 2048
    assert assessment.quality.covered_speech_samples == 2048
    assert assessment.quality.covered_speech_rate == Fraction(1)
    assert assessment.quality.likely_speech_rate == Fraction(1)
    assert assessment.quality.duplicate_coverage_rate == Fraction(1, 4)
    assert assessment.quality.duplicate_coverage_samples == 512
    assert assessment.unresolved_intervals == ()
    assert all(r.state is CoverageState.COVERED for r in assessment.regions)
    assert sum(i.interval.end_sample - i.interval.start_sample
               for i in assessment.transcript_coverage) == 2048
    duplicate, = [i for i in assessment.transcript_coverage if i.duplicate_count]
    assert duplicate.interval == SampleInterval(768, 1280)
    assert duplicate.supporting_chunk_ids == ("chunk-000000", "chunk-000001")
    assert duplicate.evidence_count == 2 and duplicate.duplicate_count == 1
    assert duplicate.has_text_support
    # Identical context evidence produces a single interval, not two copies.
    same = tuple(result(c, ((800, 1000),)) for c in plan.chunks)
    mapped = assess_speech_coverage(preprocessing, plan, same, configuration)
    assert len(mapped.transcript_coverage) == 1
    assert mapped.transcript_coverage[0].interval == SampleInterval(800, 1000)
    assert handoff.replays == [preprocessing.provenance.source_id] * 2


def test_exact_missing_speech_and_one_sample_gap_are_never_inferred_from_success(handoff):
    preprocessing, plan, configuration = handoff(("speech",) * 2)
    evidence = result(plan.chunks[0], ((0, 400), (401, 700)))
    assessment = assess_speech_coverage(preprocessing, plan, (evidence,), configuration)
    assert assessment.unresolved_intervals == (SampleInterval(400, 401), SampleInterval(700, 1024))
    assert assessment.quality.covered_speech_samples == 699
    assert assessment.quality.unresolved_speech_samples == 325
    assert all(CoverageReason.MISSING_SPEECH in r.reasons for r in assessment.regions
               if r.state is CoverageState.UNRESOLVED_ERROR)


@pytest.mark.parametrize("kind", ["empty", "blank", "untimed"])
def test_success_text_or_timestamps_alone_are_not_verified_coverage(handoff, kind):
    preprocessing, plan, configuration = handoff(("speech",))
    evidence = result(plan.chunks[0], () if kind in ("empty", "untimed") else None,
                      text="   " if kind == "blank" else "private-candidate")
    if kind == "untimed":
        evidence = replace(evidence, candidate=replace(evidence.candidate, text="private-candidate"))
    assessment = assess_speech_coverage(preprocessing, plan, (evidence,), configuration)
    assert assessment.quality.covered_speech_samples == 0
    assert assessment.unresolved_intervals == (SampleInterval(0, 512),)


@pytest.mark.parametrize("missing", [False, True])
def test_failed_or_missing_chunk_preserves_neighboring_success(handoff, missing):
    preprocessing, plan, configuration = handoff(("speech",) * 6)
    results = [result(plan.chunks[0]), result(plan.chunks[2])]
    if not missing:
        results.append(AsrChunkResult(plan.chunks[1], failure=AsrErrorCategory.TIMEOUT))
    assessment = assess_speech_coverage(preprocessing, plan, tuple(results), configuration)
    assert assessment.unresolved_intervals == (SampleInterval(768, 2304),)
    assert assessment.quality.failed_chunk_count == (0 if missing else 1)
    assert assessment.quality.missing_chunk_count == (1 if missing else 0)
    assert assessment.quality.failed_chunk_rate == (Fraction(0) if missing else Fraction(1, 3))
    expected = CoverageReason.MISSING_CHUNK_RESULT if missing else CoverageReason.FAILED_CHUNK
    assert all(expected in r.reasons for r in states_at(assessment, 768, 2304))
    assert all(r.error_chunk_ids == ("chunk-000001",) for r in states_at(assessment, 768, 2304))
    assert states_at(assessment, 0, 768)[0].state is CoverageState.COVERED
    assert states_at(assessment, 2304, 3072)[0].state is CoverageState.COVERED


@pytest.mark.parametrize("text", [
    "Cảm ơn các bạn đã theo dõi và đăng ký kênh.",
    "Hẹn gặp lại các bạn trong buổi họp tiếp theo.",
])
@pytest.mark.parametrize("confidence", [None, 0.01])
def test_legitimate_vietnamese_wording_and_confidence_alone_remain_supported(handoff, text, confidence):
    preprocessing, plan, configuration = handoff(("speech",))
    evidence = result(plan.chunks[0], text=text, confidence=confidence)
    assessment = assess_speech_coverage(preprocessing, plan, (evidence,), configuration)
    assert assessment.quality.covered_speech_samples == 512
    assert assessment.regions[0].state is CoverageState.COVERED
    assert (CoverageReason.LOW_CONFIDENCE in assessment.regions[0].reasons) == (confidence is not None)
    assert evidence.candidate.text == text
    assert text not in repr(assessment)


def test_silence_hallucination_then_omitted_speech_keeps_both_neighbors_visible(handoff, caplog):
    preprocessing, plan, configuration = handoff(("silence", "silence", "speech", "speech"))
    first = result(plan.chunks[0], ((0, 512),), text="private-silence-hallucination")
    second = result(plan.chunks[1], ())
    assessment = assess_speech_coverage(preprocessing, plan, (first, second), configuration)
    suspicious = states_at(assessment, 0, 512)
    assert suspicious and all(r.state is CoverageState.SUSPICIOUS for r in suspicious)
    assert CoverageReason.UNSUPPORTED_CANDIDATE in suspicious[0].reasons
    omitted = states_at(assessment, 1024, 2048)
    assert omitted and all(r.state is CoverageState.UNRESOLVED_ERROR for r in omitted)
    assert all(CoverageReason.NEIGHBORING_GAP in r.reasons for r in omitted)
    assert assessment.unresolved_intervals == (SampleInterval(0, 512), SampleInterval(1024, 2048))
    assert assessment.quality.unsupported_candidate_samples == 512
    assert assessment.quality.unsupported_candidate_rate == Fraction(1, 4)
    assert assessment.quality.likely_speech_samples == 1024
    assert first.candidate.text == "private-silence-hallucination"
    assert not caplog.records


@pytest.mark.parametrize("label,reason", [
    ("uncertain", CoverageReason.UNCERTAIN_VAD),
    ("high", CoverageReason.HIGH_ENERGY_NON_SPEECH),
    ("weak", CoverageReason.WEAK_SPEECH),
])
def test_fallible_acoustic_disagreement_stays_suspicious_and_actionable(handoff, label, reason):
    preprocessing, plan, configuration = handoff((label,))
    assessment = assess_speech_coverage(preprocessing, plan, (result(plan.chunks[0]),), configuration)
    assert assessment.regions[0].state is CoverageState.SUSPICIOUS
    assert reason in assessment.regions[0].reasons
    assert assessment.quality.covered_speech_samples == 0
    assert assessment.unresolved_intervals == (SampleInterval(0, 512),)
    assert assessment.regions[0].uncertain_samples == (0 if label == "weak" else 512)


def test_uncertain_without_asr_is_unresolved_and_protection_is_not_speech(handoff):
    configuration = settings(audio_speech_map_boundary_padding_samples=512)
    preprocessing, plan, configuration = handoff(
        ("silence", "speech", "uncertain"), configuration=configuration,
    )
    results = tuple(result(c, ()) for c in plan.chunks)
    assessment = assess_speech_coverage(preprocessing, plan, results, configuration)
    assert assessment.quality.likely_speech_samples == 512
    assert assessment.unresolved_intervals == (SampleInterval(512, 1536),)
    protected = states_at(assessment, 0, 512)[0]
    assert protected.state is CoverageState.SUSPICIOUS
    assert CoverageReason.PROTECTED_ONLY in protected.reasons
    assert protected.protected_samples == 512 and protected.likely_speech_samples == 0


@pytest.mark.parametrize("threshold,tolerated", [(0, False), (511, False), (512, True)])
def test_only_explicit_flanked_map_artifact_is_tolerated(handoff, threshold, tolerated):
    configuration = settings(audio_asr_coverage_max_tolerated_speech_map_gap_samples=threshold)
    preprocessing, plan, configuration = handoff(
        ("speech", "silence", "speech"), configuration=configuration,
    )
    results = tuple(result(c) for c in plan.chunks)
    assessment = assess_speech_coverage(preprocessing, plan, results, configuration)
    gap_regions = states_at(assessment, 512, 1024)
    assert gap_regions and all(r.state is CoverageState.SUSPICIOUS for r in gap_regions)
    assert all((CoverageReason.TOLERATED_MAP_ARTIFACT in r.reasons) == tolerated for r in gap_regions)
    assert assessment.unresolved_intervals == (() if tolerated else (SampleInterval(512, 1024),))
    assert assessment.quality.tolerated_map_artifact_samples == (512 if tolerated else 0)
    assert assessment.quality.covered_speech_samples == 1024


def test_uncertain_map_gap_and_edge_silence_cannot_be_tolerated(handoff):
    configuration = settings(audio_asr_coverage_max_tolerated_speech_map_gap_samples=2048)
    preprocessing, plan, configuration = handoff(
        ("silence", "speech", "uncertain", "speech"), configuration=configuration,
    )
    assessment = assess_speech_coverage(
        preprocessing, plan, tuple(result(c) for c in plan.chunks), configuration,
    )
    assert assessment.unresolved_intervals == (SampleInterval(0, 512), SampleInterval(1024, 1536))
    assert assessment.quality.tolerated_map_artifact_samples == 0


def altered(value, **changes):
    duplicate = copy.copy(value)
    for key, item in changes.items():
        object.__setattr__(duplicate, key, item)
    return duplicate


@pytest.mark.parametrize("damage", ["outside", "mismatch", "fractional", "reversed", "nan-confidence"])
def test_malformed_timestamp_evidence_isolated_without_clipping(handoff, damage):
    preprocessing, plan, configuration = handoff()
    first, second = (result(c) for c in plan.chunks)
    timeline = first.timeline_segments[0]
    if damage == "outside":
        timeline = replace(timeline, interval=SampleInterval(0, 1281))
    elif damage == "mismatch":
        timeline = replace(timeline, interval=SampleInterval(1, 1280))
    elif damage == "fractional":
        timeline = replace(timeline, interval=altered(timeline.interval, end_sample=1279.5))
    elif damage == "reversed":
        timeline = replace(timeline, interval=altered(timeline.interval, start_sample=1280))
    else:
        segment = replace(timeline.segment, quality=AsrSegmentQuality(confidence=math.nan))
        first = replace(first, candidate=replace(first.candidate, segments=(segment,)))
        timeline = replace(timeline, segment=segment)
    first = replace(first, timeline_segments=(timeline,))
    assessment = assess_speech_coverage(preprocessing, plan, (first, second), configuration)
    assert assessment.quality.malformed_chunk_count == 1
    assert assessment.unresolved_intervals == (SampleInterval(0, 1280),)
    assert all(CoverageReason.MALFORMED_CHUNK in r.reasons for r in states_at(assessment, 0, 1280))
    assert states_at(assessment, 1280, 2048)[0].state is CoverageState.COVERED
    assert all(i.supporting_chunk_ids == (second.chunk.chunk_id,) for i in assessment.transcript_coverage)


def test_repetition_in_nonoverlap_is_weak_and_context_duplicates_are_not_repetition(handoff):
    preprocessing, plan, configuration = handoff()
    text = "Chúng ta thống nhất nội dung này"
    results = (result(plan.chunks[0], ((0, 512),), text=text),
               result(plan.chunks[1], ((1536, 2048),), text=text))
    assessment = assess_speech_coverage(preprocessing, plan, results, configuration)
    supported = [r for r in assessment.regions if r.evidence_count]
    assert all(r.state is CoverageState.COVERED for r in supported)
    assert all(CoverageReason.REPEATED_NON_OVERLAP_TEXT in r.reasons for r in supported)
    duplicates = tuple(result(c, ((800, 1000),), text=text) for c in plan.chunks)
    mapped = assess_speech_coverage(preprocessing, plan, duplicates, configuration)
    assert all(CoverageReason.REPEATED_NON_OVERLAP_TEXT not in r.reasons for r in mapped.regions)
    short = tuple(result(c, bounds, text="Vâng") for c, bounds in zip(
        plan.chunks, (((0, 512),), ((1536, 2048),)), strict=True,
    ))
    mapped = assess_speech_coverage(preprocessing, plan, short, configuration)
    assert all(CoverageReason.REPEATED_NON_OVERLAP_TEXT not in r.reasons for r in mapped.regions)


@pytest.mark.parametrize("damage", [
    "source", "count", "rate", "provenance", "duplicate", "foreign", "geometry", "settings",
    "result-ordinal", "result-bound-type",
])
def test_invalid_global_handoffs_fail_closed_and_sanitized(handoff, damage):
    preprocessing, plan, configuration = handoff()
    results = tuple(result(c) for c in plan.chunks)
    if damage == "source":
        plan = replace(plan, source_id="private-other")
    elif damage == "count":
        preprocessing = replace(preprocessing, audio_metadata=replace(preprocessing.audio_metadata, sample_count=1))
    elif damage == "rate":
        preprocessing = replace(preprocessing, audio_metadata=altered(preprocessing.audio_metadata, sample_rate_hz=8000))
    elif damage == "provenance":
        preprocessing = replace(preprocessing, provenance=replace(preprocessing.provenance, pipeline_version="private-other"))
    elif damage == "duplicate":
        results += (results[0],)
    elif damage == "foreign":
        results = (replace(results[0], chunk=replace(results[0].chunk, chunk_id="private-other")),)
    elif damage == "geometry":
        results = (replace(results[0], chunk=replace(results[0].chunk, request_interval=SampleInterval(0, 1))),)
    elif damage == "result-ordinal":
        results = (replace(results[0], chunk=replace(results[0].chunk, ordinal=False)),)
    elif damage == "result-bound-type":
        results = (replace(results[0], chunk=replace(results[0].chunk, request_interval=altered(
            results[0].chunk.request_interval, start_sample=0.0,
        ))),)
    else:
        configuration = configuration.model_copy(update={"audio_asr_coverage_repetition_min_chars": True})
    with pytest.raises(AudioProcessingError) as caught:
        assess_speech_coverage(preprocessing, plan, results, configuration)
    assert caught.value.category == "VALIDATION"
    assert caught.value.__context__ is None and caught.value.__cause__ is None
    assert "private-" not in "".join(traceback.format_exception(caught.value))
    assert handoff.replays == []


@pytest.mark.parametrize("damage", ["truncated", "invalid", "resource"])
def test_bad_evidence_replay_never_publishes_partial_assessment(handoff, monkeypatch, damage):
    preprocessing, plan, configuration = handoff()
    source_id = preprocessing.provenance.source_id
    if damage == "truncated":
        handoff.frames[source_id].pop()
    elif damage == "invalid":
        handoff.frames[source_id][0] = replace(handoff.frames[source_id][0], start_sample=1)
    else:
        def broken(evidence):
            raise OSError("private-path")
        monkeypatch.setattr(SpeechEnergyEvidence, "iter_frames", broken)
    with pytest.raises(AudioProcessingError) as caught:
        assess_speech_coverage(preprocessing, plan, tuple(result(c) for c in plan.chunks), configuration)
    assert caught.value.category == ("RESOURCE" if damage == "resource" else "VALIDATION")
    assert caught.value.__context__ is None
    assert "private-" not in "".join(traceback.format_exception(caught.value))


def test_deterministic_immutable_exact_tail_and_text_free_outputs(handoff, monkeypatch):
    preprocessing, plan, configuration = handoff(("speech",) * 4, tail=17)
    text = "private-raw-candidate-never-retained"
    results = tuple(result(c, text=text) for c in plan.chunks)

    def forbidden(*args, **kwargs):
        pytest.fail("assessment accessed or closed source artifacts")

    monkeypatch.setattr(Path, "open", forbidden)
    monkeypatch.setattr(NormalizedAudioArtifact, "close", forbidden)
    monkeypatch.setattr(SpeechEnergyEvidence, "close", forbidden)
    assessment = assess_speech_coverage(preprocessing, plan, results, configuration)
    assert assess_speech_coverage(preprocessing, plan, tuple(reversed(results)), configuration) == assessment
    assert assessment.quality.covered_speech_samples == 1553
    assert assessment.quality.suspicious_speech_samples + assessment.quality.unresolved_speech_samples == 0
    assert assessment.sample_rate_hz == 16000
    assert assessment.provenance.planning == plan.provenance
    assert assessment.provenance.effective_configuration["repetition_min_chars"] == 16
    with pytest.raises(FrozenInstanceError):
        assessment.sample_count = 1
    with pytest.raises(FrozenInstanceError):
        assessment.regions[0].state = CoverageState.SUSPICIOUS
    with pytest.raises(TypeError):
        assessment.provenance.effective_configuration["repetition_min_chars"] = 1
    with pytest.raises(TypeError):
        assessment.provenance.planning.preprocessing.normalization.target_format["channels"] = 2
    configuration.audio_asr_coverage_repetition_min_chars = 32
    assert assessment.provenance.effective_configuration["repetition_min_chars"] == 16

    def inspect(value):
        assert text not in repr(value)
        if is_dataclass(value):
            assert not {"text", "candidate", "segment"} & {f.name for f in fields(value)}
            for f in fields(value):
                inspect(getattr(value, f.name))
        elif isinstance(value, tuple):
            for item in value:
                inspect(item)

    inspect(assessment)
    assert all(r.interval.end_sample <= 1553 for r in assessment.regions)


def test_all_silence_has_no_fabricated_coverage_or_recovery_work(handoff):
    preprocessing, plan, configuration = handoff(("silence",) * 2)
    assessment = assess_speech_coverage(
        preprocessing, plan, tuple(result(c, ()) for c in plan.chunks), configuration,
    )
    assert assessment.regions == () and assessment.transcript_coverage == ()
    assert assessment.unresolved_intervals == ()
    assert assessment.quality.likely_speech_samples == 0
    assert assessment.quality.covered_speech_rate == 0
    assert assessment.quality.likely_speech_rate == 0


def test_enabled_map_gap_tolerance_never_hides_missing_speech(handoff):
    configuration = settings(audio_asr_coverage_max_tolerated_speech_map_gap_samples=2048)
    preprocessing, plan, configuration = handoff(("speech",) * 2, configuration=configuration)
    assessment = assess_speech_coverage(
        preprocessing, plan, (result(plan.chunks[0], ((0, 400), (401, 1024))),), configuration,
    )
    assert assessment.unresolved_intervals == (SampleInterval(400, 401),)
    assert assessment.quality.tolerated_map_artifact_samples == 0


def test_map_merged_silence_is_not_verified_by_timestamps(handoff):
    configuration = settings(audio_speech_map_merge_gap_samples=512)
    preprocessing, plan, configuration = handoff(
        ("speech", "silence", "speech"), configuration=configuration,
    )
    assert preprocessing.speech_map.speech_intervals == (SampleInterval(0, 1536),)
    assessment = assess_speech_coverage(
        preprocessing, plan, tuple(result(c) for c in plan.chunks), configuration,
    )
    assert assessment.quality.covered_speech_samples == 1024
    assert assessment.quality.suspicious_speech_samples == 512
    assert assessment.unresolved_intervals == (SampleInterval(512, 1024),)
    assert all(r.state is CoverageState.SUSPICIOUS for r in states_at(assessment, 512, 1024))
