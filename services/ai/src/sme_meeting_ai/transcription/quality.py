"""Text-free quality evidence, separate from coverage/admission decisions.

VAD/energy and ASR hypotheses are fallible observations, not human annotations.
This projection never changes a timestamp, drops a gap, executes inference, or
claims word completeness. Frame RMS ranges are not sample-local speech labels.
"""

from dataclasses import dataclass, field
from enum import StrEnum

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.audio.speech_map import _validate_contracts, _validate_frame
from sme_meeting_ai.pipeline.models import PreprocessingResult

from .coverage import CoveragePhase, SpeechCoverageAssessment
from .reconciliation import OccurrenceRelationship, TranscriptReconciliation


class AcousticGapKind(StrEnum):
    VAD_SUSPECTED_SPEECH = "vad-suspected-speech"
    ACOUSTIC_DISAGREEMENT = "acoustic-disagreement"


@dataclass(frozen=True)
class GapAcousticEvidence:
    interval: SampleInterval
    context_interval: SampleInterval
    classification: AcousticGapKind
    vad_probability_min: float
    vad_probability_max: float
    rms_min: float
    rms_max: float
    context_vad_probability_min: float
    context_vad_probability_max: float
    context_rms_min: float
    context_rms_max: float
    timestamp_boundary_adjacent: bool


@dataclass(frozen=True)
class TranscriptQualitySummary:
    source_sample_count: int
    canonical_timestamp_support_samples: int
    suspected_speech_samples: int
    uncertain_acoustic_samples: int
    ambiguous_canonical_samples: int
    conflicting_canonical_samples: int
    suspected_gaps: tuple[GapAcousticEvidence, ...]
    lexical_disagreement_intervals: tuple[SampleInterval, ...]
    vad_frame_samples: int
    vad_speech_threshold: float
    energy_floor_dbfs: float
    # No independent word/audio reference enters this stage. Neither agreement
    # nor a provider's own word timestamps can promote either of these fields.
    lexical_completeness: str = field(default="unverified", init=False)
    word_omissions_verified: bool = field(default=False, init=False)
    summary_version: str = field(default="quality-evidence-v1", init=False)

    @property
    def lexical_disagreement_samples(self) -> int:
        return sum(i.end_sample - i.start_sample for i in self.lexical_disagreement_intervals)


def _union(intervals):
    result = []
    for interval in sorted(intervals, key=lambda i: (i.start_sample, i.end_sample)):
        if result and interval.start_sample <= result[-1].end_sample:
            result[-1] = SampleInterval(result[-1].start_sample, max(result[-1].end_sample, interval.end_sample))
        else:
            result.append(interval)
    return tuple(result)


def _require(condition):
    if not condition:
        raise AudioProcessingError("VALIDATION")


@dataclass
class _FrameRange:
    probability_min: float = 1
    probability_max: float = 0
    rms_min: float = 1
    rms_max: float = 0
    observed: bool = False

    def add(self, frame):
        self.probability_min = min(self.probability_min, frame.vad_probability)
        self.probability_max = max(self.probability_max, frame.vad_probability)
        self.rms_min = min(self.rms_min, frame.rms)
        self.rms_max = max(self.rms_max, frame.rms)
        self.observed = True


def _gap_acoustics(preprocessing, gaps, frame_samples):
    """One bounded replay for all gaps and one real VAD frame of local context.

    A frame intersecting a gap contributes its measured values without inventing
    sub-frame acoustic resolution. Context is evidence only, never support.
    """
    count = preprocessing.normalized_artifact.sample_count
    contexts = tuple(SampleInterval(max(0, i.start_sample - frame_samples),
                                    min(count, i.end_sample + frame_samples)) for i in gaps)
    inside, around = [_FrameRange() for _ in gaps], [_FrameRange() for _ in gaps]
    if gaps:
        audio, evidence = preprocessing.normalized_artifact, preprocessing.speech_evidence
        contract = _validate_contracts(audio, evidence)
        position = observed = pending = 0
        active = []
        for frame in evidence.iter_frames():
            _require(observed < evidence.frame_count)
            _validate_frame(frame, position, count, *contract)
            position, observed = frame.end_sample, observed + 1
            while pending < len(contexts) and contexts[pending].start_sample < frame.end_sample:
                active.append(pending)
                pending += 1
            active = [index for index in active if contexts[index].end_sample > frame.start_sample]
            for index in active:
                around[index].add(frame)
                gap = gaps[index]
                if gap.start_sample < frame.end_sample and frame.start_sample < gap.end_sample:
                    inside[index].add(frame)
        _require(position == count and observed == evidence.frame_count
                 and all(value.observed for value in (*inside, *around)))
    return tuple(zip(contexts, inside, around, strict=True))


def summarize_transcript_quality(
    preprocessing: PreprocessingResult,
    coverage: SpeechCoverageAssessment,
    reconciliation: TranscriptReconciliation,
) -> TranscriptQualitySummary:
    """Borrow a final admitted snapshot; publish numeric/enum evidence only.

    Hypothesis disagreement can expose internal omission risk with zero temporal
    gaps. It cannot determine which wording is correct. A lone hypothesis has no
    independent lexical check and remains explicitly unverified.
    """
    _require(isinstance(coverage, SpeechCoverageAssessment)
             and coverage.provenance.assessment_phase is CoveragePhase.FINAL_CANONICAL
             and isinstance(reconciliation, TranscriptReconciliation)
             and coverage.source_id == reconciliation.source_id == preprocessing.provenance.source_id
             and coverage.sample_count == reconciliation.sample_count == preprocessing.normalized_artifact.sample_count
             and coverage.provenance.planning == reconciliation.provenance.planning)
    quality = coverage.quality
    _require(all(type(value) is int for value in (
        quality.canonical_text_supported_samples, quality.likely_speech_without_canonical_text_samples,
        quality.ambiguous_canonical_samples, quality.conflicting_canonical_samples,
    )))
    frame_samples, speech_threshold, _ = _validate_contracts(
        preprocessing.normalized_artifact, preprocessing.speech_evidence,
    )
    floor = preprocessing.speech_map.provenance.effective_configuration["energy_floor_dbfs"]
    gaps = _union(r.interval for r in coverage.regions
                  if r.likely_speech_samples and not r.evidence.has_canonical_text_support)
    _require(sum(i.end_sample - i.start_sample for i in gaps)
             == quality.likely_speech_without_canonical_text_samples)
    starts = {s.interval.start_sample for s in reconciliation.segments}
    ends = {s.interval.end_sample for s in reconciliation.segments}
    observations = _gap_acoustics(preprocessing, gaps, frame_samples)
    evidence = tuple(GapAcousticEvidence(
        gap, context,
        (AcousticGapKind.ACOUSTIC_DISAGREEMENT
         if within.probability_min < speech_threshold or within.rms_min < 10 ** (floor / 20)
         else AcousticGapKind.VAD_SUSPECTED_SPEECH),
        within.probability_min, within.probability_max, within.rms_min, within.rms_max,
        nearby.probability_min, nearby.probability_max, nearby.rms_min, nearby.rms_max,
        gap.start_sample in ends or gap.end_sample in starts,
    ) for gap, (context, within, nearby) in zip(gaps, observations, strict=True))
    lexical = _union(identity.interval for relation in reconciliation.relationships
                     if relation.classification in (OccurrenceRelationship.PARTIAL_SUPPORT,
                                                    OccurrenceRelationship.CONFLICTING_HYPOTHESIS)
                     for identity in (*relation.left, *relation.right))
    return TranscriptQualitySummary(
        coverage.sample_count, quality.canonical_text_supported_samples,
        quality.likely_speech_without_canonical_text_samples, quality.uncertain_acoustic_samples,
        quality.ambiguous_canonical_samples, quality.conflicting_canonical_samples,
        evidence, lexical, frame_samples, speech_threshold, floor,
    )
