"""Trusted V6 composition into the canonical correction/publication contract.

Generation owns bounded requests; the sparse engine alone owns edit safety. This
bridge owns metadata mapping and observational accounting, never speech recovery,
lexical acceptance, provider lifecycle, persistence, or publication.
"""

import math
import traceback
from collections.abc import Callable
from concurrent.futures import CancelledError

from sme_meeting_ai.core.config import Settings

from .asr import AsrProvenance
from .chunk_planning import AsrChunk, ChunkBoundaryReason, ChunkPlanningProvenance
from .correction import (
    _IDENTIFIER,
    CorrectedSegment,
    CorrectionError,
    CorrectionErrorCategory,
    CorrectionProvenance,
    TranscriptCorrectionFailure,
    TranscriptCorrectionOutcome,
    TranscriptCorrectionQuality,
    TranscriptCorrectionResult,
    TranscriptCorrectionStatus,
    _character_count,
    _handoff,
    _overlap_words,
    _require,
    _valid_interval,
    _warnings,
    _words,
)
from .correction_v6 import V6EditResult, V6ValidationError, apply_v6_edits
from .correction_v6_generation import (
    CORRECTION_V6_SCHEMA_NAME,
    V6_PROMPT_VERSION,
    V6CorrectionProvider,
    V6GenerationOutcome,
    V6GenerationResult,
    generate_v6_proposal,
)
from .coverage import (
    CoveragePhase,
    CoverageProvenance,
    CoverageQuality,
    CoverageReason,
    CoverageRegion,
    CoverageState,
    SpeechCoverageAssessment,
    TranscriptCoverageInterval,
)
from .reconciliation import ReconciliationProvenance, TranscriptReconciliation

_VERSION = "5"


def _trusted_handoff(reconciliation: TranscriptReconciliation, coverage: SpeechCoverageAssessment) -> None:
    """Preserve V5's handoff checks and bind supplied source references/provenance.

    Upstream owns coverage and reconciliation algorithms. Only their immutable
    identities/bounds are checked here; no evidence or missing metadata is rebuilt.
    """
    _handoff(reconciliation, coverage)
    count = reconciliation.sample_count
    provenance, assessment = reconciliation.provenance, coverage.provenance
    _require(isinstance(provenance, ReconciliationProvenance)
             and isinstance(assessment, CoverageProvenance) and isinstance(coverage.quality, CoverageQuality)
             and isinstance(provenance.planning, ChunkPlanningProvenance)
             and type(coverage.sample_count) is int)
    planning = provenance.planning
    _require(all(type(rate) is int and rate == 16000 for rate in (
        reconciliation.sample_rate_hz, coverage.sample_rate_hz, provenance.sample_rate_hz,
        assessment.sample_rate_hz, planning.sample_rate_hz, planning.preprocessing.sample_rate_hz,
    )))
    _require(planning.preprocessing.source_id == reconciliation.source_id
             and type(planning.preprocessing.sample_count) is int
             and planning.preprocessing.sample_count == count
             and isinstance(assessment.assessment_phase, CoveragePhase))
    chunks, ordinals = {}, set()
    for chunk in provenance.source_chunks:
        _require(isinstance(chunk, AsrChunk) and type(chunk.chunk_id) is str
                 and bool(_IDENTIFIER.fullmatch(chunk.chunk_id)) and chunk.chunk_id not in chunks
                 and type(chunk.ordinal) is int and chunk.ordinal >= 0 and chunk.ordinal not in ordinals)
        _require(_valid_interval(chunk.core_interval, count) and _valid_interval(chunk.request_interval, count)
                 and chunk.request_interval.start_sample <= chunk.core_interval.start_sample
                 and chunk.core_interval.end_sample <= chunk.request_interval.end_sample
                 and isinstance(chunk.start_boundary_reason, ChunkBoundaryReason)
                 and isinstance(chunk.end_boundary_reason, ChunkBoundaryReason))
        chunks[chunk.chunk_id] = chunk
        ordinals.add(chunk.ordinal)
    for segment in reconciliation.segments:
        _require(type(segment.segment_id) is str
                 and len(set(segment.source_chunk_ids)) == len(segment.source_chunk_ids)
                 and all(identity in chunks for identity in segment.source_chunk_ids))
    for source in (provenance.asr, assessment.asr):
        seen = set()
        for identity, model in source:
            _require(identity in chunks and identity not in seen and isinstance(model, AsrProvenance))
            seen.add(identity)
    # V2 final coverage was calculated from this exact admitted canonical snapshot.
    # Older handoffs accepted by V5 need not have canonical-phase ASR provenance.
    if assessment.assessment_phase is CoveragePhase.FINAL_CANONICAL:
        _require(assessment.asr == provenance.asr)
    for items, model in ((coverage.regions, CoverageRegion),
                         (coverage.transcript_coverage, TranscriptCoverageInterval)):
        previous = (-1, -1)
        for item in items:
            _require(isinstance(item, model) and _valid_interval(item.interval, count))
            key = (item.interval.start_sample, item.interval.end_sample)
            _require(key >= previous and all(identity in chunks for identity in item.supporting_chunk_ids))
            previous = key
            if isinstance(item, CoverageRegion):
                _require(isinstance(item.state, CoverageState)
                         and all(isinstance(reason, CoverageReason) for reason in item.reasons)
                         and all(identity in chunks for identity in item.error_chunk_ids))


def _content_overlap(source: tuple[str, ...], corrected: tuple[str, ...], source_size: int) -> float:
    # Match the canonical field's long-content measurement convention, without
    # V5's throwing acceptance gate or per-segment/full-rewrite restrictions.
    if len(source) < 8 or source_size < 32:
        return 1.0
    shared = sum((_overlap_words(source) & _overlap_words(corrected)).values())
    return shared / max(len(source), len(corrected), 1)


def _quality(reconciliation: TranscriptReconciliation, texts: tuple[str, ...]) -> TranscriptCorrectionQuality:
    source_words, corrected_words, ratios, overlaps = [], [], [], []
    source_characters = corrected_characters = changed = 0
    for source, text in zip(reconciliation.segments, texts, strict=True):
        a, b = _words(source.text), _words(text)
        source_size, corrected_size = _character_count(source.text), _character_count(text)
        source_characters += source_size
        corrected_characters += corrected_size
        source_words.extend(a)
        corrected_words.extend(b)
        changed += source.text != text
        ratios.append(corrected_size / source_size if source_size else 1.0)
        overlaps.append(_content_overlap(a, b, source_size))
    overlap = _content_overlap(tuple(source_words), tuple(corrected_words), source_characters)
    return TranscriptCorrectionQuality(
        len(texts), changed, source_characters, corrected_characters, len(source_words), len(corrected_words),
        len(texts), corrected_characters / source_characters if source_characters else 1.0,
        len(corrected_words) / len(source_words) if source_words else 1.0,
        min(ratios, default=1.0), max(ratios, default=1.0), min([overlap, *overlaps]),
    )


def _result(
    reconciliation: TranscriptReconciliation, coverage: SpeechCoverageAssessment,
    generation: V6GenerationResult, edits: V6EditResult,
    *, correction_version: str = _VERSION, correction_mode: str = "v6_edits",
    validator_version: str | None = None,
) -> TranscriptCorrectionResult:
    _require(isinstance(edits, V6EditResult) and len(edits.texts) == len(reconciliation.segments)
             and all(type(text) is str for text in edits.texts)
             and type(edits.rejected_segment_count) is int
             and 0 <= edits.rejected_segment_count <= len(reconciliation.segments))
    contextual_count = getattr(edits, "contextual_edit_count", 0) if correction_mode == "v62_edits" else 0
    _require(type(contextual_count) is int and 0 <= contextual_count <= edits.accepted_edit_count)
    corrected = tuple(CorrectedSegment(
        segment_id=source.segment_id, ordinal=source.ordinal, interval=source.interval,
        text=text, source_chunk_ids=source.source_chunk_ids, flags=source.flags,
    ) for source, text in zip(reconciliation.segments, edits.texts, strict=True))
    _require(len(corrected) == len(reconciliation.segments) and all(
        isinstance(final, CorrectedSegment) and final.segment_id == source.segment_id
        and final.ordinal == source.ordinal and final.interval == source.interval
        and final.source_chunk_ids == source.source_chunk_ids and final.flags == source.flags and final.text == text
        for source, final, text in zip(reconciliation.segments, corrected, edits.texts, strict=True)
    ))
    quality = _quality(reconciliation, edits.texts)
    _require(quality.segment_count == quality.validated_segment_count == len(corrected) and all(math.isfinite(value)
             for value in (quality.character_ratio, quality.word_ratio, quality.minimum_segment_character_ratio,
                           quality.maximum_segment_character_ratio, quality.minimum_content_overlap)))
    provenance = CorrectionProvenance(
        correction_version=correction_version, prompt_version=generation.prompt_version, provider=generation.provider,
        requested_model=generation.requested_model, resolved_model=generation.resolved_model,
        effective_configuration={**generation.effective_configuration, "correction_mode": correction_mode,
                                  "schema_name": generation.schema_name,
                                  **({"validator_version": validator_version} if validator_version is not None else {}),
                                  **({"contextual_edit_count": contextual_count} if correction_mode == "v62_edits" else {})},
        attempts=generation.attempts, usage=generation.usage, rejected_segment_count=edits.rejected_segment_count,
        proposed_edit_count=edits.proposed_edit_count, accepted_edit_count=edits.accepted_edit_count,
        rejected_edit_count=edits.rejected_edit_count, rejection_reason_counts=edits.rejection_reason_counts,
    )
    return TranscriptCorrectionResult(reconciliation.source_id, reconciliation.sample_count, corrected, coverage,
                                      reconciliation.unresolved_intervals, quality, provenance)


def correct_transcript_v6(
    reconciliation: TranscriptReconciliation, coverage: SpeechCoverageAssessment,
    provider: V6CorrectionProvider, settings: Settings,
) -> TranscriptCorrectionOutcome:
    """Compose generation once and Task 01 once; never retry or publish ASR fallback.

    Only final engine texts enter the canonical result. Locally rejected edits
    warn; structural/global failures are terminal and keep no partial correction.
    """
    return _correct_span_transcript(
        reconciliation, coverage, provider, settings,
        generate=generate_v6_proposal, apply=apply_v6_edits, prompt_version=V6_PROMPT_VERSION,
    )


def _correct_span_transcript(
    reconciliation: TranscriptReconciliation, coverage: SpeechCoverageAssessment,
    provider: V6CorrectionProvider, settings: Settings,
    *, generate: Callable, apply: Callable, prompt_version: str,
    correction_version: str = _VERSION, correction_mode: str = "v6_edits", validator_version: str | None = None,
) -> TranscriptCorrectionOutcome:
    """Shared trusted construction/failure semantics; callers pin both algorithms."""
    attempts = 0
    category, reason = CorrectionErrorCategory.VALIDATION, "invalid_reconciliation"
    try:
        _trusted_handoff(reconciliation, coverage)
        reason = "invalid_correction_result"
        generation = generate(reconciliation, provider, settings)
        _require(isinstance(generation, V6GenerationOutcome))
        if generation.failure is not None:
            failure = generation.failure
            return TranscriptCorrectionOutcome(TranscriptCorrectionStatus.FAILED, failure=TranscriptCorrectionFailure(
                failure.category, failure.attempts, failure.reason.value,
            ))
        accepted = generation.result
        _require(isinstance(accepted, V6GenerationResult))
        attempts = accepted.attempts
        _require(type(attempts) is int and 1 <= attempts <= 3
                  and accepted.prompt_version == prompt_version and accepted.schema_name == CORRECTION_V6_SCHEMA_NAME)
        edits = apply(
            reconciliation, accepted.proposal,
            min_text_ratio=settings.transcript_correction_min_text_ratio,
            max_text_ratio=settings.transcript_correction_max_text_ratio,
        )
        result = _result(
            reconciliation, coverage, accepted, edits, correction_version=correction_version,
            correction_mode=correction_mode, validator_version=validator_version,
        )
        has_warnings = (_warnings(reconciliation, coverage) or edits.rejected_edit_count > 0
                        or (correction_mode == "v62_edits"
                            and result.provenance.effective_configuration["contextual_edit_count"] > 0))
        status = (TranscriptCorrectionStatus.COMPLETED_WITH_WARNINGS if has_warnings
                  else TranscriptCorrectionStatus.COMPLETED)
        return TranscriptCorrectionOutcome(status, result)
    except V6ValidationError as error:
        category, reason = error.category, error.reason.value
        traceback.clear_frames(error.__traceback__)
    except CorrectionError as error:
        category = error.category
        traceback.clear_frames(error.__traceback__)
    except CancelledError:
        raise
    except (MemoryError, RecursionError) as error:
        category, reason = CorrectionErrorCategory.RESOURCE, "resource_exhausted"
        traceback.clear_frames(error.__traceback__)
    except Exception as error:
        category, reason = CorrectionErrorCategory.RESOURCE, "resource_exhausted"
        traceback.clear_frames(error.__traceback__)
    finally:
        # Do not retain candidate-bearing inputs/proposals in cancellation frames.
        reconciliation = coverage = provider = settings = generation = accepted = edits = result = None
    return TranscriptCorrectionOutcome(TranscriptCorrectionStatus.FAILED, failure=TranscriptCorrectionFailure(
        category, attempts, reason,
    ))
