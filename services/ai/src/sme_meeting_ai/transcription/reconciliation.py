"""Deterministic, provisional wording reconciliation on the absolute 16 kHz timeline.

Candidates are borrowed transiently. This module neither assesses speech coverage
nor repairs gaps, and core ownership never authorizes cutting source wording.
"""

import math
import re
import unicodedata
from dataclasses import dataclass, field, replace
from enum import StrEnum
from types import MappingProxyType
from typing import Mapping

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.core.config import Settings

from .asr import AsrError, AsrErrorCategory, AsrProvenance
from .chunk_execution import AsrChunkResult, AsrTimelineSegment, _translate_candidate
from .chunk_planning import (
    AsrChunk, AsrChunkPlan, ChunkBoundaryReason, ChunkPlanningProvenance,
    validate_asr_chunk_plan,
)

_VERSION = "1"
_IDENTIFIER = re.compile(r"[a-zA-Z0-9_./:-]{1,256}\Z")


class ReconciliationFlag(StrEnum):
    DUPLICATE_OVERLAP = "duplicate-overlap"
    CONFLICTING_OVERLAP = "conflicting-overlap"
    UNRESOLVED_BOUNDARY = "unresolved-boundary"


class ReconciliationChunkState(StrEnum):
    CANDIDATE_EVIDENCE = "candidate-evidence"
    MISSING = "missing"
    FAILED = "failed"
    EMPTY = "empty"
    MALFORMED = "malformed"


@dataclass(frozen=True, slots=True)
class ReconciledSegment:
    """Derived provisional wording; alternatives remain sensitive transient text."""

    interval: SampleInterval
    text: str = field(repr=False)
    source_chunk_ids: tuple[str, ...]
    flags: tuple[ReconciliationFlag, ...] = ()
    alternatives: tuple[str, ...] = field(default=(), repr=False)
    # Assigned only after final chronological ordering; provisional merge units
    # deliberately carry no externally usable identity.
    segment_id: str = ""
    ordinal: int = -1

    def __post_init__(self) -> None:
        for name in ("source_chunk_ids", "flags", "alternatives"):
            object.__setattr__(self, name, tuple(getattr(self, name)))


@dataclass(frozen=True, slots=True)
class ReconciliationChunkOutcome:
    chunk_id: str
    core_interval: SampleInterval
    state: ReconciliationChunkState
    failure: AsrErrorCategory | None = None


@dataclass(frozen=True)
class ReconciliationProvenance:
    reconciler_version: str
    planning: ChunkPlanningProvenance
    effective_configuration: Mapping[str, int]
    asr: tuple[tuple[str, AsrProvenance], ...]
    # Capture supplied recovery bounds as well as the baseline plan's bounds.
    source_chunks: tuple[AsrChunk, ...]
    sample_rate_hz: int = field(default=16000, init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "planning", replace(self.planning))
        object.__setattr__(self, "effective_configuration", MappingProxyType(dict(self.effective_configuration)))
        object.__setattr__(self, "asr", tuple(self.asr))
        object.__setattr__(self, "source_chunks", tuple(self.source_chunks))


@dataclass(frozen=True)
class TranscriptReconciliation:
    source_id: str
    sample_count: int
    segments: tuple[ReconciledSegment, ...]
    chunk_outcomes: tuple[ReconciliationChunkOutcome, ...]
    # Complement of non-empty reconciled evidence, not inferred missing speech.
    unresolved_intervals: tuple[SampleInterval, ...]
    provenance: ReconciliationProvenance
    provisional: bool = field(default=True, init=False)
    sample_rate_hz: int = field(default=16000, init=False)

    def __post_init__(self) -> None:
        for name in ("segments", "chunk_outcomes", "unresolved_intervals"):
            object.__setattr__(self, name, tuple(getattr(self, name)))


def _require(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("VALIDATION")


def _configuration(settings: Settings) -> dict[str, int]:
    _require(isinstance(settings, Settings))
    minimum = settings.audio_asr_reconciliation_min_shared_tokens
    _require(type(minimum) is int and 2 <= minimum <= 64)
    return {"min_shared_tokens": minimum}


def _valid_interval(interval: SampleInterval, sample_count: int) -> bool:
    return (
        isinstance(interval, SampleInterval)
        and type(interval.start_sample) is int and type(interval.end_sample) is int
        and 0 <= interval.start_sample < interval.end_sample <= sample_count
    )


def _handoff(plan: AsrChunkPlan, results: tuple[AsrChunkResult, ...], settings: Settings) -> tuple[AsrChunk, ...]:
    validate_asr_chunk_plan(plan)
    _require(isinstance(results, tuple))
    maximum = settings.audio_asr_recovery_max_total_attempts
    _require(type(maximum) is int and 1 <= maximum <= 256)
    _require(len(results) <= len(plan.chunks) + maximum)
    planned = {chunk.chunk_id: chunk for chunk in plan.chunks}
    seen, ordinals = set(), {chunk.ordinal for chunk in plan.chunks}
    recovery = []
    for item in results:
        _require(isinstance(item, AsrChunkResult) and isinstance(item.chunk, AsrChunk))
        chunk = item.chunk
        _require(isinstance(chunk.chunk_id, str) and bool(_IDENTIFIER.fullmatch(chunk.chunk_id)))
        _require(chunk.chunk_id not in seen and type(chunk.ordinal) is int)
        _require(all(_valid_interval(i, plan.sample_count)
                     for i in (chunk.core_interval, chunk.request_interval)))
        if chunk.chunk_id in planned:
            _require(chunk == planned[chunk.chunk_id])
        else:
            # The caller supplies approved recovery windows in the same shape;
            # they cannot impersonate a planned chunk or change its boundaries.
            _require(chunk.ordinal >= len(plan.chunks) and chunk.ordinal not in ordinals)
            _require(chunk.request_interval.start_sample <= chunk.core_interval.start_sample
                     and chunk.core_interval.end_sample <= chunk.request_interval.end_sample)
            _require(isinstance(chunk.start_boundary_reason, ChunkBoundaryReason)
                     and isinstance(chunk.end_boundary_reason, ChunkBoundaryReason))
            ordinals.add(chunk.ordinal)
            recovery.append(chunk)
        seen.add(chunk.chunk_id)
    _require(len(recovery) <= maximum)
    return (*plan.chunks, *sorted(recovery, key=lambda c: (c.ordinal, c.chunk_id)))


def _safe_provenance(value: AsrProvenance) -> AsrProvenance:
    _require(isinstance(value, AsrProvenance))
    for identifier in (value.provider, value.requested_model):
        _require(isinstance(identifier, str) and bool(_IDENTIFIER.fullmatch(identifier)))
    for identifier in (value.resolved_model, value.upstream_provider):
        _require(identifier is None or (isinstance(identifier, str) and bool(_IDENTIFIER.fullmatch(identifier))))
    _require(isinstance(value.inference_config, tuple))
    safe = {}
    for pair in value.inference_config:
        _require(isinstance(pair, tuple) and len(pair) == 2 and isinstance(pair[0], str))
        key, item = pair
        # Never copy arbitrary prompt/provider metadata into derived output.
        if key == "language":
            _require(isinstance(item, str) and bool(re.fullmatch(r"[a-zA-Z-]{1,16}", item)))
            _require(key not in safe)
            safe[key] = item
        elif key == "temperature":
            _require(type(item) in (int, float) and math.isfinite(item) and 0 <= item <= 1)
            _require(key not in safe)
            safe[key] = item
    return replace(value, inference_config=tuple(sorted(safe.items())))


@dataclass(frozen=True, slots=True)
class _Token:
    value: str = field(repr=False)
    end: int
    word: bool


def _word(character: str) -> bool:
    return character == "_" or unicodedata.category(character)[0] in "LNM"


def _tokens(text: str) -> tuple[_Token, ...]:
    """Unicode-aware tokens with offsets into unchanged source text.

    Punctuation is comparison evidence too (e.g. C++ versus C#). Normalizing
    individual word runs retains combining accents and original output spelling.
    """
    output = []
    position = 0
    while position < len(text):
        if text[position].isspace():
            position += 1
            continue
        start = position
        word = _word(text[position])
        position += 1
        if word:
            while position < len(text) and _word(text[position]):
                position += 1
        value = unicodedata.normalize("NFC", text[start:position]).casefold()
        output.append(_Token(value, position, word))
    return tuple(output)


@dataclass(frozen=True, slots=True)
class _Evidence:
    chunk: AsrChunk
    segment_index: int
    interval: SampleInterval
    text: str = field(repr=False)
    tokens: tuple[_Token, ...] = field(repr=False)


def _evidence_key(item: _Evidence) -> tuple[int, int, str, int]:
    return (item.interval.start_sample, item.interval.end_sample,
            item.chunk.chunk_id, item.segment_index)


def _owner_key(item: _Evidence) -> tuple[int, int, str, int]:
    core, interval = item.chunk.core_interval, item.interval
    owned = max(0, min(core.end_sample, interval.end_sample) - max(core.start_sample, interval.start_sample))
    return (-owned, item.chunk.ordinal, item.chunk.chunk_id, item.segment_index)


def _collect(chunks, results):
    by_id = {item.chunk.chunk_id: item for item in results}
    outcomes, evidence, provenance = [], [], []
    for chunk in chunks:
        item = by_id.get(chunk.chunk_id)
        state, failure = ReconciliationChunkState.MISSING, None
        if item is not None:
            state, failure = ReconciliationChunkState.MALFORMED, AsrErrorCategory.MALFORMED_OUTPUT
            if item.failure is not None:
                if (isinstance(item.failure, AsrErrorCategory) and item.candidate is None
                        and item.timeline_segments == ()):
                    failure = item.failure
                    if failure is not AsrErrorCategory.MALFORMED_OUTPUT:
                        state = ReconciliationChunkState.FAILED
            else:
                try:
                    translated = _translate_candidate(item.candidate, chunk)
                    _require(isinstance(item.timeline_segments, tuple))
                    _require(all(isinstance(t, AsrTimelineSegment)
                                 and _valid_interval(t.interval, chunk.request_interval.end_sample)
                                 for t in item.timeline_segments))
                    _require(translated == item.timeline_segments)
                    safe = _safe_provenance(item.candidate.provenance)
                    local = [
                        _Evidence(chunk, index, timeline.interval, timeline.segment.text,
                                  _tokens(timeline.segment.text))
                        for index, timeline in enumerate(translated) if timeline.segment.text.strip()
                    ]
                    evidence.extend(local)
                    provenance.append((chunk.chunk_id, safe))
                    state = (ReconciliationChunkState.CANDIDATE_EVIDENCE if local
                             else ReconciliationChunkState.EMPTY)
                    failure = None
                except (AsrError, AudioProcessingError, AttributeError, TypeError, ValueError, OverflowError):
                    pass
        outcomes.append(ReconciliationChunkOutcome(chunk.chunk_id, chunk.core_interval, state, failure))
    return tuple(outcomes), sorted(evidence, key=_evidence_key), tuple(provenance)


def _overlap(left: SampleInterval, right: SampleInterval) -> bool:
    return max(left.start_sample, right.start_sample) < min(left.end_sample, right.end_sample)


def _values(tokens: tuple[_Token, ...]) -> tuple[str, ...]:
    return tuple(t.value for t in tokens)


def _shared(left: tuple[_Token, ...], right: tuple[_Token, ...], minimum: int) -> int:
    """Require a unique, nontrivial suffix/prefix alignment, never fuzzy text."""
    a, b = _values(left), _values(right)
    matches = []
    for size in range(1, min(len(a), len(b))):
        run = a[-size:]
        if run != b[:size]:
            continue
        words = [t.value for t in right[:size] if t.word]
        if len(words) < minimum or len(set(words)) < 2:
            continue
        if any(sum(values[i:i + size] == run for i in range(len(values) - size + 1)) != 1
               for values in (a, b)):
            continue
        matches.append(size)
    return matches[0] if len(matches) == 1 else 0


@dataclass(frozen=True, slots=True)
class _Unit:
    segment: ReconciledSegment
    evidence: tuple[_Evidence, ...] = field(repr=False)


def _flags(*groups) -> tuple[ReconciliationFlag, ...]:
    combined = {flag for group in groups for flag in group}
    return tuple(flag for flag in ReconciliationFlag if flag in combined)


def _stitch_size(unit: _Unit, item: _Evidence, minimum: int) -> int:
    previous, anchor = unit.segment, unit.evidence[-1]
    # A synthetic union must never become timing support for another alignment.
    if (ReconciliationFlag.CONFLICTING_OVERLAP in previous.flags
            or not _overlap(anchor.interval, item.interval)
            or anchor.interval.start_sample > item.interval.start_sample
            or previous.interval.end_sample >= item.interval.end_sample):
        return 0
    shared = _shared(_tokens(previous.text), item.tokens, minimum)
    return shared if shared == _shared(anchor.tokens, item.tokens, minimum) else 0


def _merge(unit: _Unit, item: _Evidence, minimum: int) -> _Unit:
    previous = unit.segment
    all_evidence = (*unit.evidence, item)
    sources = tuple(sorted({e.chunk.chunk_id for e in all_evidence}))
    values = _values(item.tokens)
    if (ReconciliationFlag.CONFLICTING_OVERLAP not in previous.flags
            and ReconciliationFlag.UNRESOLVED_BOUNDARY not in previous.flags
            and all(_values(e.tokens) == values and _overlap(e.interval, item.interval)
                    for e in unit.evidence)):
        owner = min(all_evidence, key=_owner_key)
        return _Unit(ReconciledSegment(
            owner.interval, owner.text, sources,
            _flags(previous.flags, (ReconciliationFlag.DUPLICATE_OVERLAP,)),
        ), all_evidence)

    shared = _stitch_size(unit, item, minimum)
    interval = SampleInterval(
        min(e.interval.start_sample for e in all_evidence),
        max(e.interval.end_sample for e in all_evidence),
    )
    if shared:
        # Slice only at an observed textual alignment, never at a core timestamp.
        tail = item.text[item.tokens[shared - 1].end:]
        text = previous.text.rstrip() + tail
        return _Unit(ReconciledSegment(
            interval, text, sources,
            _flags(previous.flags, (ReconciliationFlag.DUPLICATE_OVERLAP,
                                    ReconciliationFlag.UNRESOLVED_BOUNDARY)),
        ), all_evidence)

    owner = min(all_evidence, key=_owner_key)
    texts = dict.fromkeys(e.text for e in all_evidence)
    # Keep any already-derived stitch as an alternative when new evidence conflicts.
    texts.update(dict.fromkeys(previous.alternatives))
    texts[previous.text] = None
    alternatives = tuple(text for text in texts if text != owner.text)
    return _Unit(ReconciledSegment(
        interval, owner.text, sources,
        _flags(previous.flags, (ReconciliationFlag.CONFLICTING_OVERLAP,)), alternatives,
    ), all_evidence)


def _resolve(evidence: list[_Evidence], minimum: int) -> tuple[ReconciledSegment, ...]:
    units = []
    for item in evidence:
        overlapping, eligible = [], []
        for index, unit in enumerate(units):
            if not any(_overlap(e.interval, item.interval) for e in unit.evidence):
                continue
            overlapping.append(index)
            if any(e.chunk.chunk_id == item.chunk.chunk_id for e in unit.evidence):
                continue
            # Duplicate/conflict grouping requires real pairwise overlap. Only
            # an observed suffix/prefix stitch can extend a chain beyond that.
            if (all(_overlap(e.interval, item.interval) for e in unit.evidence)
                    or _stitch_size(unit, item, minimum)):
                eligible.append(index)
        if len(eligible) == len(overlapping) == 1:
            index = eligible[0]
            units[index] = _merge(units[index], item, minimum)
        else:
            # Multiple possible alignments cannot authorize deleting a repetition.
            flags = (ReconciliationFlag.UNRESOLVED_BOUNDARY,) if overlapping else ()
            for index in overlapping:
                unit = units[index]
                units[index] = replace(unit, segment=replace(
                    unit.segment, flags=_flags(unit.segment.flags, flags),
                ))
            units.append(_Unit(ReconciledSegment(
                item.interval, item.text, (item.chunk.chunk_id,), flags,
            ), (item,)))
    return tuple(unit.segment for unit in sorted(units, key=lambda u: (
        u.segment.interval.start_sample, u.segment.interval.end_sample,
        u.segment.source_chunk_ids, _evidence_key(u.evidence[0]),
    )))


def _unresolved(sample_count: int, segments: tuple[ReconciledSegment, ...]) -> tuple[SampleInterval, ...]:
    intervals = []
    position = 0
    for segment in segments:
        if position < segment.interval.start_sample:
            intervals.append(SampleInterval(position, segment.interval.start_sample))
        position = max(position, segment.interval.end_sample)
    if position < sample_count:
        intervals.append(SampleInterval(position, sample_count))
    return tuple(intervals)


def reconcile_transcript(
    plan: AsrChunkPlan, results: tuple[AsrChunkResult, ...], settings: Settings,
) -> TranscriptReconciliation:
    """Reconcile borrowed evidence, including caller-approved recovery windows.

    Baseline chunks must match the plan exactly. Additional recovery chunks use
    distinct stable IDs/ordinals and supplied absolute core/request bounds on the
    same source timeline. This call never schedules or derives recovery windows.
    No raw candidates, provider payloads, or inferred word timestamps are returned.
    """
    category = "VALIDATION"
    try:
        configuration = _configuration(settings)
        chunks = _handoff(plan, results, settings)
        outcomes, evidence, asr = _collect(chunks, results)
        segments = _resolve(evidence, configuration["min_shared_tokens"])
        segments = tuple(replace(segment, segment_id=f"segment-{ordinal:06d}", ordinal=ordinal)
                         for ordinal, segment in enumerate(segments))
        return TranscriptReconciliation(
            plan.source_id, plan.sample_count, segments, outcomes,
            _unresolved(plan.sample_count, segments),
            ReconciliationProvenance(_VERSION, plan.provenance, configuration, asr, chunks),
        )
    except AudioProcessingError as error:
        category = error.category
    except MemoryError:
        category = "RESOURCE"
    except (AttributeError, TypeError, ValueError, KeyError, OverflowError):
        pass
    # Raise outside handlers so input-bearing exceptions cannot become context.
    raise AudioProcessingError(category)
