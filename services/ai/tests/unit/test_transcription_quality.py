"""Text-free evidence, not an acoustic ground-truth or word-completeness oracle."""

from dataclasses import FrozenInstanceError, replace
from fractions import Fraction

import pytest

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.transcription import AsrWord, reconcile_transcript
from sme_meeting_ai.transcription.quality import summarize_transcript_quality

from .test_coverage_validation import canonical_result, final_assessment
from .test_coverage_validation import handoff as handoff  # noqa: F401


def summary(preprocessing, plan, results, config):
    canonical = reconcile_transcript(plan, results, config)
    coverage = final_assessment(preprocessing, plan, results, config, canonical=canonical)
    return coverage, summarize_transcript_quality(preprocessing, coverage, canonical)


@pytest.mark.parametrize("label,kind,rms", [
    ("speech", "vad-suspected-speech", 0.1),
    ("weak", "acoustic-disagreement", 0.0001),
])
def test_one_sample_gap_retains_weak_or_short_speech_and_frame_context(handoff, label, kind, rms):
    preprocessing, plan, config = handoff((label, "silence"))
    raw = (canonical_result(plan.chunks[0], ((0, 511),), text="Vâng"),)
    coverage, quality = summary(preprocessing, plan, raw, config)
    gap, = quality.suspected_gaps
    assert gap.interval == SampleInterval(511, 512)
    assert gap.classification == kind
    assert gap.vad_probability_min == gap.vad_probability_max == 0.9
    assert gap.rms_min == gap.rms_max == rms
    assert gap.context_vad_probability_min == 0.1
    assert gap.context_vad_probability_max == 0.9
    assert gap.context_rms_min == 0
    assert gap.timestamp_boundary_adjacent
    assert quality.suspected_speech_samples == coverage.quality.likely_speech_without_canonical_text_samples == 1
    assert quality.lexical_completeness == "unverified"
    assert quality.word_omissions_verified is False
    assert "Vâng" not in repr(quality)
    with pytest.raises(FrozenInstanceError):
        gap.rms_min = 0


def test_music_silence_resume_separates_acoustic_uncertainty_from_missing_words(handoff):
    preprocessing, plan, config = handoff(("speech", "high", "silence", "weak", "speech"))
    raw = tuple(canonical_result(c, ()) for c in plan.chunks)
    coverage, quality = summary(preprocessing, plan, raw, config)
    assert [g.interval for g in quality.suspected_gaps] == [SampleInterval(0, 512), SampleInterval(1536, 2560)]
    assert quality.suspected_speech_samples == 1536
    assert quality.uncertain_acoustic_samples == coverage.quality.uncertain_acoustic_samples
    assert quality.canonical_timestamp_support_samples == 0
    assert quality.word_omissions_verified is False
    assert quality.suspected_gaps[-1].classification == "acoustic-disagreement"


def test_covered_segment_with_internal_omission_is_unverified_even_with_word_timestamps(handoff):
    preprocessing, plan, config = handoff(("speech",))
    # Hypothetical audio has "Triển khai ngay"; one self-consistent ASR result
    # omits "ngay". Its own word timestamps cannot independently expose that.
    item = canonical_result(plan.chunks[0], text="Triển khai")
    item = replace(item, candidate=replace(item.candidate, words=(
        AsrWord(Fraction(0), Fraction(256, 16000), "Triển"),
        AsrWord(Fraction(256, 16000), Fraction(512, 16000), "khai"),
    )))
    _, quality = summary(preprocessing, plan, (item,), config)
    assert quality.suspected_gaps == ()
    assert quality.canonical_timestamp_support_samples == 512
    assert quality.lexical_completeness == "unverified"
    assert quality.lexical_disagreement_intervals == ()
    assert quality.word_omissions_verified is False


def test_existing_overlap_can_flag_lexical_omission_risk_with_zero_missing_samples(handoff):
    preprocessing, plan, config = handoff()
    # Independent chunk observations disagree inside fully covered timestamps.
    raw = (canonical_result(plan.chunks[0], text="Triển khai API Kubernetes"),
           canonical_result(plan.chunks[1], text="Triển khai API mới Kubernetes"))
    coverage, quality = summary(preprocessing, plan, raw, config)
    assert coverage.quality.likely_speech_without_canonical_text_samples == 0
    assert quality.lexical_disagreement_intervals == (SampleInterval(0, 2048),)
    assert quality.lexical_disagreement_samples == 2048
    assert quality.suspected_gaps == ()
    assert quality.word_omissions_verified is False
    assert quality.lexical_completeness == "unverified"
    assert coverage.quality.ambiguous_canonical_samples > 0


def test_identical_boundary_hypotheses_are_not_reported_as_lexical_disagreement(handoff):
    preprocessing, plan, config = handoff()
    raw = tuple(canonical_result(c, ((800, 1000),), text="Triển khai API Kubernetes") for c in plan.chunks)
    _, quality = summary(preprocessing, plan, raw, config)
    assert quality.lexical_disagreement_intervals == ()


def test_quality_summary_requires_actual_final_canonical_evidence(handoff):
    from sme_meeting_ai.transcription import assess_speech_coverage

    preprocessing, plan, config = handoff()
    raw = tuple(canonical_result(c) for c in plan.chunks)
    provisional = assess_speech_coverage(preprocessing, plan, raw, config)
    canonical = reconcile_transcript(plan, raw, config)
    with pytest.raises(AudioProcessingError):
        summarize_transcript_quality(preprocessing, provisional, canonical)


def test_censored_reconciliation_preserves_one_sample_missing_interval(handoff):
    from .test_reconciliation import result

    preprocessing, plan, config = handoff()
    raw = (result(plan.chunks[0], (700, 1100, "Hôm nay kiểm thử API Kubernetes"),
                  (1101, 1150, "Tiếp tục cuộc họp")),
           result(plan.chunks[1], (768, 1099, "API Kubernetes")))
    canonical = reconcile_transcript(plan, raw, config)
    assert len(canonical.segments) == 2
    coverage = final_assessment(preprocessing, plan, raw, config, canonical=canonical)
    quality = summarize_transcript_quality(preprocessing, coverage, canonical)
    assert SampleInterval(1100, 1101) in tuple(g.interval for g in quality.suspected_gaps)
    assert quality.suspected_speech_samples == 1599
    assert quality.word_omissions_verified is False


def test_music_silence_resumption_and_hallucination_evidence_survive_partial_alignment(handoff):
    from .test_asr_recheck import BOILERPLATE
    from .test_reconciliation import result

    preprocessing, plan, config = handoff(("high", "silence", "speech", "speech", "speech", "speech"))
    wording = "Hôm nay kiểm thử API Kubernetes"
    raw = (result(plan.chunks[0], (0, 512, BOILERPLATE)),
           result(plan.chunks[1], (1500, 2200, wording)),
           result(plan.chunks[2], (1792, 2100, "API Kubernetes"), (2400, 2600, wording)))
    canonical = reconcile_transcript(plan, raw, config)
    assert [(s.text, s.interval) for s in canonical.segments] == [
        (BOILERPLATE, SampleInterval(0, 512)),
        (wording, SampleInterval(1500, 2200)), (wording, SampleInterval(2400, 2600)),
    ]
    coverage = final_assessment(preprocessing, plan, raw, config, canonical=canonical)
    quality = summarize_transcript_quality(preprocessing, coverage, canonical)
    assert coverage.quality.unsupported_canonical_text_samples == 512
    assert quality.suspected_speech_samples == 1148
    assert quality.word_omissions_verified is False
