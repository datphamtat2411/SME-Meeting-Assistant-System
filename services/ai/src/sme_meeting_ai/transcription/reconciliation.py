"""Canonical evidence graph V2, with bounded monotonic source-path alignment.

Graph nodes are immutable observed segments. Relationships precede selection;
neither interval union nor selected wording becomes new alignment evidence.
All wording is borrowed privately. No inference, acoustic coverage assessment,
synthetic wording, segment slicing or timestamp expansion occurs here.
"""

import heapq
import math
import re
import traceback
import unicodedata
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from concurrent.futures import CancelledError
from dataclasses import dataclass, field, replace
from enum import StrEnum
from fractions import Fraction
from itertools import combinations
from types import MappingProxyType
from typing import Mapping

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.core.config import Settings

from .asr import AsrError, AsrErrorCategory, AsrProvenance, AsrSegmentQuality, AsrWord
from .boundary_alignment import (
    BoundaryAlignmentReport,
    BoundaryRisk,
    WordTimingObservation,
)
from .chunk_execution import AsrChunkResult, AsrTimelineSegment, _translate_candidate
from .chunk_planning import (
    AsrChunk,
    AsrChunkPlan,
    ChunkBoundaryReason,
    ChunkPlanningProvenance,
    validate_asr_chunk_plan,
)

_VERSION = "2"
_IDENTIFIER = re.compile(r"[a-zA-Z0-9_./:-]{1,256}\Z")
# Representation/work budgets, not empirical ASR accuracy thresholds. All fail
# closed, never truncate observations. Captured in effective configuration.
_MAX_NODES = 262144
_MAX_TEXT_CHARACTERS = 8388608
_MAX_TOKENS = 1048576
_MAX_ACTIVE = 256
_MAX_LOCAL_NODES = 256
_MAX_PATH_TOKENS = 8192
_MAX_CANDIDATES = 262144
_MAX_WORK = 16777216
_MAX_REFERENCES = 1048576
_PRESENTATION = frozenset(".,;:!?…\"'“”‘’()[]{}")
# These alone are not discriminating lexical anchors. Diacritics are retained.
_COMMON = frozenset("ừ vâng dạ ok ờ ạ uh um là và của có các cái một những thì mà với cho ở đã sẽ đang chúng ta tôi bạn này đó rồi đúng không được".split())


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


class OccurrenceRelationship(StrEnum):
    SAME_OCCURRENCE = "same-occurrence"
    PARTIAL_SUPPORT = "partial-support"
    CONFLICTING_HYPOTHESIS = "conflicting-hypothesis"
    DISTINCT_OCCURRENCE = "distinct-occurrence"
    AMBIGUOUS = "ambiguous"


@dataclass(frozen=True, slots=True)
class ReconciliationEvidenceIdentity:
    chunk_id: str
    segment_index: int
    interval: SampleInterval


@dataclass(frozen=True, slots=True)
class ReconciliationRelationship:
    """Text-free hyperedge between two ordered, intact source paths."""

    left: tuple[ReconciliationEvidenceIdentity, ...]
    right: tuple[ReconciliationEvidenceIdentity, ...]
    classification: OccurrenceRelationship


@dataclass(frozen=True, slots=True)
class ReconciliationObservations:
    raw_source_segment_count: int = 0
    canonical_segment_count: int = 0
    established_redundant_hypothesis_count: int = 0
    conflicting_hypothesis_count: int = 0
    ambiguous_occurrence_count: int = 0
    many_to_one_alignment_count: int = 0
    one_to_many_alignment_count: int = 0
    genuine_repetition_preservation_count: int = 0
    unresolved_interval_samples: int = 0
    temporal_candidate_count: int = 0
    lexical_comparison_count: int = 0


@dataclass(frozen=True, slots=True)
class ReconciledSegment:
    """Derived provisional wording; alternatives remain sensitive transient text."""

    interval: SampleInterval
    text: str = field(repr=False)
    source_chunk_ids: tuple[str, ...]
    flags: tuple[ReconciliationFlag, ...] = ()
    alternatives: tuple[str, ...] = field(default=(), repr=False)
    # Assigned only after final chronological ordering.
    segment_id: str = ""
    ordinal: int = -1
    selected_evidence_id: ReconciliationEvidenceIdentity | None = None
    supporting_evidence_ids: tuple[ReconciliationEvidenceIdentity, ...] = ()
    alternative_evidence_ids: tuple[ReconciliationEvidenceIdentity, ...] = ()

    def __post_init__(self) -> None:
        for name in ("source_chunk_ids", "flags", "alternatives", "supporting_evidence_ids", "alternative_evidence_ids"):
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
    observations: ReconciliationObservations = field(default_factory=ReconciliationObservations)
    relationships: tuple[ReconciliationRelationship, ...] = ()
    provisional: bool = field(default=True, init=False)
    sample_rate_hz: int = field(default=16000, init=False)

    def __post_init__(self) -> None:
        for name in ("segments", "chunk_outcomes", "unresolved_intervals", "relationships"):
            object.__setattr__(self, name, tuple(getattr(self, name)))


def _require(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("VALIDATION")


def _configuration(settings: Settings) -> dict[str, int]:
    _require(isinstance(settings, Settings))
    minimum = settings.audio_asr_reconciliation_min_shared_tokens
    _require(type(minimum) is int and 2 <= minimum <= 64)
    return {"min_shared_tokens": minimum, "max_nodes": _MAX_NODES,
            "max_text_characters": _MAX_TEXT_CHARACTERS, "max_tokens": _MAX_TOKENS,
            "max_active": _MAX_ACTIVE, "max_local_nodes": _MAX_LOCAL_NODES,
            "max_path_tokens": _MAX_PATH_TOKENS, "max_candidates": _MAX_CANDIDATES,
            "max_alignment_work": _MAX_WORK, "max_evidence_references": _MAX_REFERENCES}


def _resource(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("RESOURCE")


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
            _require(len(plan.chunks) <= chunk.ordinal < len(plan.chunks) + maximum and chunk.ordinal not in ordinals)
            _require(chunk.request_interval.start_sample <= chunk.core_interval.start_sample
                     and chunk.core_interval.end_sample <= chunk.request_interval.end_sample)
            _require(isinstance(chunk.start_boundary_reason, ChunkBoundaryReason)
                      and isinstance(chunk.end_boundary_reason, ChunkBoundaryReason))
            from .recovery import _configuration as recovery_configuration
            from .recovery import _validate_recovery_chunk

            _validate_recovery_chunk(chunk, plan.sample_count, recovery_configuration(settings))
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
    word: bool


def _word(character: str) -> bool:
    return character == "_" or unicodedata.category(character)[0] in "LNM"


def _tokens(text: str) -> tuple[_Token, ...]:
    """Comparison only; technical punctuation stays attached to identifiers.

    C++, C#, API-v2, OAuth, dotted versions and slash identifiers stay distinct.
    Standalone symbols remain comparison tokens; sentence punctuation is retained
    here but is presentation-only in lexical path comparison.
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
            while position < len(text):
                if _word(text[position]):
                    position += 1
                elif (text[position] in "-./" and position + 1 < len(text)
                      and _word(text[position + 1])):
                    position += 1
                else:
                    break
            while position < len(text) and text[position] in "+#":
                position += 1
        value = unicodedata.normalize("NFC", text[start:position]).casefold()
        _resource(len(output) < _MAX_TOKENS)
        output.append(_Token(value, word))
    return tuple(output)


@dataclass(frozen=True, slots=True)
class _Evidence:
    chunk: AsrChunk
    segment_index: int
    interval: SampleInterval
    text: str = field(repr=False)
    tokens: tuple[_Token, ...] = field(repr=False)
    quality: AsrSegmentQuality
    # Actual provider word intervals only, never inferred token positions.
    timed_words: tuple[tuple[str, SampleInterval], ...] = field(default=(), repr=False)

    @property
    def identity(self) -> ReconciliationEvidenceIdentity:
        return ReconciliationEvidenceIdentity(self.chunk.chunk_id, self.segment_index, self.interval)


def _evidence_key(item: _Evidence) -> tuple[int, int, str, int]:
    return (item.interval.start_sample, item.interval.end_sample,
            item.chunk.chunk_id, item.segment_index)


def _lexical(tokens):
    return tuple(t.value for t in tokens if t.word or t.value not in _PRESENTATION)


def _quality(value):
    _require(isinstance(value, AsrSegmentQuality))
    for name in ("confidence", "average_log_probability", "compression_ratio", "no_speech_probability", "temperature"):
        item = getattr(value, name)
        _require(item is None or (type(item) in (int, float) and math.isfinite(item)))
    for name in ("confidence", "no_speech_probability", "temperature"):
        item = getattr(value, name)
        _require(item is None or 0 <= item <= 1)
    _require(value.compression_ratio is None or value.compression_ratio >= 0)
    return value


def _words(candidate, chunk):
    words = candidate.words
    if words is None:
        return ()
    _require(isinstance(words, tuple))
    _resource(len(words) <= _MAX_TOKENS)
    output, previous, previous_sample, segment_index, characters = [], Fraction(0), 0, 0, 0
    for word in words:
        _require(isinstance(word, AsrWord) and isinstance(word.text, str)
                 and isinstance(word.start, Fraction) and isinstance(word.end, Fraction)
                 and previous <= word.start < word.end <= chunk.request_interval.duration)
        start, end = round(word.start * 16000), round(word.end * 16000)
        _require(previous_sample <= start < end <= chunk.request_interval.end_sample - chunk.request_interval.start_sample)
        characters += len(word.text)
        _resource(characters <= _MAX_TEXT_CHARACTERS)
        while segment_index < len(candidate.segments) and candidate.segments[segment_index].end <= word.start:
            segment_index += 1
        _require(segment_index < len(candidate.segments)
                 and candidate.segments[segment_index].start <= word.start
                 and word.end <= candidate.segments[segment_index].end)
        output.append((word, SampleInterval(chunk.request_interval.start_sample + start,
                                            chunk.request_interval.start_sample + end)))
        previous, previous_sample = word.end, end
    return tuple(output)


def _collect(chunks, results):
    by_id = {item.chunk.chunk_id: item for item in results}
    outcomes, evidence, provenance = [], [], []
    characters = token_count = observed_count = 0
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
                    if item.candidate is not None and isinstance(item.candidate.segments, tuple):
                        observed_count += len(item.candidate.segments)
                        _resource(observed_count <= _MAX_NODES)
                    translated = _translate_candidate(item.candidate, chunk)
                    _require(isinstance(item.timeline_segments, tuple))
                    _require(all(isinstance(t, AsrTimelineSegment)
                                 and _valid_interval(t.interval, chunk.request_interval.end_sample)
                                 for t in item.timeline_segments))
                    _require(translated == item.timeline_segments)
                    safe = _safe_provenance(item.candidate.provenance)
                    words = _words(item.candidate, chunk)
                    characters += sum(len(word.text) for word, _ in words)
                    _resource(characters <= _MAX_TEXT_CHARACTERS)
                    local = []
                    word_index = 0
                    for index, timeline in enumerate(translated):
                        segment = timeline.segment
                        quality = _quality(segment.quality)
                        characters += len(segment.text)
                        _resource(characters <= _MAX_TEXT_CHARACTERS)
                        tokens = _tokens(segment.text)
                        token_count += len(tokens)
                        _resource(token_count <= _MAX_TOKENS)
                        timed = []
                        while word_index < len(words) and words[word_index][0].end <= segment.start:
                            word_index += 1
                        scan = word_index
                        while scan < len(words) and words[scan][0].start < segment.end:
                            word, interval = words[scan]
                            if segment.start <= word.start and word.end <= segment.end:
                                values = _lexical(_tokens(word.text))
                                token_count += len(values)
                                _resource(token_count <= _MAX_TOKENS)
                                # One provider word is not divided into invented timings.
                                if len(values) == 1:
                                    timed.append((values[0], interval))
                            scan += 1
                        if tuple(value for value, _ in timed) != _lexical(tokens):
                            timed = []
                        if segment.text.strip():
                            local.append(_Evidence(chunk, index, timeline.interval, segment.text,
                                                   tokens, quality, tuple(timed)))
                    evidence.extend(local)
                    provenance.append((chunk.chunk_id, safe))
                    state = (ReconciliationChunkState.CANDIDATE_EVIDENCE if local
                             else ReconciliationChunkState.EMPTY)
                    failure = None
                except AudioProcessingError as error:
                    if error.category == "RESOURCE":
                        raise
                    traceback.clear_frames(error.__traceback__)
                except (AsrError, AttributeError, TypeError, ValueError, OverflowError) as error:
                    traceback.clear_frames(error.__traceback__)
        outcomes.append(ReconciliationChunkOutcome(chunk.chunk_id, chunk.core_interval, state, failure))
    return tuple(outcomes), sorted(evidence, key=_evidence_key), tuple(provenance)


def _overlap(left: SampleInterval, right: SampleInterval) -> bool:
    return max(left.start_sample, right.start_sample) < min(left.end_sample, right.end_sample)


def _flags(*groups) -> tuple[ReconciliationFlag, ...]:
    combined = {flag for group in groups for flag in group}
    return tuple(flag for flag in ReconciliationFlag if flag in combined)


@dataclass(slots=True)
class _Work:
    remaining: int = _MAX_WORK
    candidates: int = 0
    comparisons: int = 0
    references: int = 0

    def spend(self, count):
        self.remaining -= count
        _resource(self.remaining >= 0)

    def retain(self, count):
        self.references += count
        _resource(self.references <= _MAX_REFERENCES)


@dataclass(frozen=True, slots=True)
class _Edge:
    left: tuple[int, ...]
    right: tuple[int, ...]
    kind: OccurrenceRelationship


_ESTABLISHED = frozenset((OccurrenceRelationship.SAME_OCCURRENCE, OccurrenceRelationship.CONFLICTING_HYPOTHESIS))


def _components(adjacency):
    seen = set()
    for root in sorted(adjacency):
        if root in seen:
            continue
        seen.add(root)
        pending, group = [root], []
        while pending:
            node = pending.pop()
            group.append(node)
            _resource(len(group) <= _MAX_LOCAL_NODES)
            for other in sorted(adjacency[node]):
                if other not in seen:
                    seen.add(other)
                    pending.append(other)
        yield tuple(sorted(group))


def _candidate_regions(evidence, work):
    """Sweep exact half-open intervals, then index local source-pair regions.

    Connected overlap components are only work regions, NEVER occurrence groups.
    Same-request observations are not compared to each other.
    """
    heap, active, pairs = [], {}, defaultdict(list)
    for index, item in enumerate(evidence):
        while heap and heap[0][0] <= item.interval.start_sample:
            _, expired = heapq.heappop(heap)
            active.pop(expired)
        _resource(len(active) < _MAX_ACTIVE)
        for other, previous in active.items():
            if previous.chunk.chunk_id == item.chunk.chunk_id:
                continue
            work.candidates += 1
            _resource(work.candidates <= _MAX_CANDIDATES)
            a, b = sorted((other, index), key=lambda n: (evidence[n].chunk.ordinal, evidence[n].chunk.chunk_id))
            pairs[(evidence[a].chunk.chunk_id, evidence[b].chunk.chunk_id)].append((a, b))
        active[index] = item
        heapq.heappush(heap, (item.interval.end_sample, index))
    for pair in sorted(pairs):
        adjacency = defaultdict(set)
        for a, b in pairs[pair]:
            adjacency[a].add(b)
            adjacency[b].add(a)
        for group in _components(adjacency):
            left = tuple(n for n in group if evidence[n].chunk.chunk_id == pair[0])
            right = tuple(n for n in group if evidence[n].chunk.chunk_id == pair[1])
            yield left, right


def _path_values(path, work):
    values, spans = [], []
    for item in path:
        local = _lexical(item.tokens)
        spans.append((len(values), len(values) + len(local), item.interval))
        values.extend(local)
    _resource(len(values) <= _MAX_PATH_TOKENS)
    work.spend(len(values) + len(path))
    return tuple(values), spans


def _monotonic_temporal_support(a, b):
    """Match actual segment intervals for corresponding token *indices* only.

    Indices are lexical assignments, not timestamps. A long segment can support
    several short ones, provided each mapped pair actually overlaps in time.
    """
    i = j = 0
    while i < len(a) and j < len(b):
        start_a, end_a, interval_a = a[i]
        start_b, end_b, interval_b = b[j]
        if max(start_a, start_b) < min(end_a, end_b) and not _overlap(interval_a, interval_b):
            return False
        if end_a <= end_b:
            i += 1
        else:
            j += 1
    return True


def _envelope(path):
    return (path[0].interval.start_sample, path[-1].interval.end_sample)


def _mutual_centers(left, right):
    # Exact integer geometry, not word timing or an accuracy/confidence score.
    # A small intersection between otherwise displaced complete hypotheses does
    # not identify an occurrence. No center timestamp is created or emitted.
    a, b = _envelope(left), _envelope(right)
    return 2 * a[0] <= b[0] + b[1] < 2 * a[1] and 2 * b[0] <= a[0] + a[1] < 2 * b[1]


def _align_paths(left, right, minimum, work):
    """Unique, monotonic exact anchors; no unrestricted fuzzy text merging.

    Complete equal streams map position-to-position. Substitution conflicts are
    admitted only for isolated single-token disagreements between equal flanks,
    with an identical observed source envelope. All other partial correspondences
    are nondestructive. Repeated/noninformative anchors cannot prove identity.
    """
    work.comparisons += 1
    a, spans_a = _path_values(left, work)
    b, spans_b = _path_values(right, work)
    count_a, count_b = Counter(a), Counter(b)
    positions_b = {value: i for i, value in enumerate(b) if count_b[value] == 1}
    anchors = [(i, positions_b[value]) for i, value in enumerate(a)
               if count_a[value] == count_b[value] == 1 and value not in _COMMON
               and value in positions_b and any(_word(c) for c in value)]
    unique = (len(anchors) >= minimum
              and all(x[1] < y[1] for x, y in zip(anchors, anchors[1:])))
    actual_a = tuple(word for item in left for word in item.timed_words)
    actual_b = tuple(word for item in right for word in item.timed_words)
    words_agree = bool(actual_a) and actual_a == actual_b and len(actual_a) == len(a) == len(b)
    if a == b and a:
        if (len(actual_a) == len(actual_b) == len(a)
                and any(not _overlap(x[1], y[1]) for x, y in zip(actual_a, actual_b, strict=True))):
            return OccurrenceRelationship.AMBIGUOUS
        if not words_agree and not _mutual_centers(left, right):
            return OccurrenceRelationship.AMBIGUOUS
        if (unique or words_agree) and _monotonic_temporal_support(spans_a, spans_b):
            return OccurrenceRelationship.SAME_OCCURRENCE
        return OccurrenceRelationship.AMBIGUOUS
    if not unique:
        return OccurrenceRelationship.AMBIGUOUS if set(a) & set(b) else OccurrenceRelationship.DISTINCT_OCCURRENCE
    if (len(a) == len(b) and a and a[0] == b[0] and a[-1] == b[-1]
            and _envelope(left) == _envelope(right)
            and all(i > 0 and i + 1 < len(a) and a[i - 1] == b[i - 1] and a[i + 1] == b[i + 1]
                    for i in range(len(a)) if a[i] != b[i])
            and _monotonic_temporal_support(spans_a, spans_b)):
        return OccurrenceRelationship.CONFLICTING_HYPOTHESIS
    return OccurrenceRelationship.PARTIAL_SUPPORT


def _boundary_context(plan, results, evidence, report):
    if report is None:
        return {}
    _require(isinstance(report, BoundaryAlignmentReport) and report.alignment_version == "boundary-alignment-v2")
    _require(report.metrics.source_sample_count == plan.sample_count
             and report.metrics.planned_chunk_count == len(plan.chunks)
             and report.metrics.planner_version == plan.provenance.planner_version)
    _require(isinstance(report.boundaries, tuple) and len(report.boundaries) == len(plan.chunks) - 1)
    _require(isinstance(report.segment_supports, tuple))
    chunks = {c.chunk_id: c for c in plan.chunks}
    actual = {(r.chunk.chunk_id, i): t.interval for r in results if r.chunk.chunk_id in chunks
              for i, t in enumerate(r.timeline_segments)}
    _require(len(report.segment_supports) == len(actual))
    seen = set()
    boundary_samples = tuple(c.core_interval.end_sample for c in plan.chunks[:-1])
    for support in report.segment_supports:
        key = (support.chunk_id, support.segment_ordinal)
        _require(key not in seen and key in actual and support.chunk_id in chunks)
        chunk = chunks[support.chunk_id]
        _require(support.interval == actual[key] and support.request_interval == chunk.request_interval
                 and support.core_interval == chunk.core_interval and isinstance(support.word_timing, WordTimingObservation))
        a, b = max(support.interval.start_sample, chunk.core_interval.start_sample), min(
            support.interval.end_sample, chunk.core_interval.end_sample,
        )
        crossing = bisect_right(boundary_samples, support.interval.start_sample) < bisect_left(
            boundary_samples, support.interval.end_sample,
        )
        _require(support.core_owned_interval == (SampleInterval(a, b) if a < b else None)
                 and type(support.crosses_core_boundary) is bool and support.crosses_core_boundary is crossing)
        seen.add(key)
    risks = defaultdict(list)
    for boundary, left, right in zip(report.boundaries, plan.chunks[:-1], plan.chunks[1:], strict=True):
        _require(boundary.left_chunk_id == left.chunk_id and boundary.right_chunk_id == right.chunk_id
                 and boundary.boundary_sample == left.core_interval.end_sample
                 and boundary.boundary_reason is left.end_boundary_reason
                 and isinstance(boundary.boundary_risk, BoundaryRisk))
        _require(boundary.boundary_risk is not BoundaryRisk.NATURAL_CANDIDATE
                 or boundary.boundary_reason in (
                     ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE, ChunkBoundaryReason.SPEECH_RESUMPTION,
                 ))
        risk = {BoundaryRisk.NATURAL_CANDIDATE: 0, BoundaryRisk.FORCED_CONTINUOUS_SPEECH: 1,
                BoundaryRisk.INCOMPLETE_EVIDENCE: 2}[boundary.boundary_risk]
        risks[left.chunk_id].append((boundary.boundary_sample, risk))
        risks[right.chunk_id].append((boundary.boundary_sample, risk))
    # Only cross-core observations borrow a boundary's risk. Safe metadata can
    # rank an established representation but cannot create a lexical relationship.
    crossing = {(s.chunk_id, s.segment_ordinal) for s in report.segment_supports if s.crosses_core_boundary}
    return {i: max((risk for sample, risk in risks[item.chunk.chunk_id]
                    if item.interval.start_sample < sample < item.interval.end_sample), default=0)
            for i, item in enumerate(evidence)
            if (item.chunk.chunk_id, item.segment_index) in crossing}


def _intersection_length(a, b):
    return max(0, min(a.end_sample, b.end_sample) - max(a.start_sample, b.start_sample))


def _select_path(paths, evidence, boundary_risk, work):
    """Rank complete representations only after occurrence consistency passes."""
    values = {path: tuple(value for n in path for value in _lexical(evidence[n].tokens)) for path in paths}
    support = Counter(values.values())  # one vote per independent source request
    # Unknown quality does not lose to a known number. Only mutually available,
    # comparable provider fields participate; no invented aggregate confidence.
    fields = [name for name in ("confidence", "average_log_probability", "no_speech_probability")
              if all(getattr(evidence[n].quality, name) is not None for path in paths for n in path)]

    def rank(path):
        work.spend(sum(len(other) for other in paths) * len(path))
        compatible = sum(_intersection_length(evidence[n].interval, evidence[m].interval)
                         for n in path for other in paths for m in other if other != path)
        owned = sum(_intersection_length(evidence[n].interval, evidence[n].chunk.core_interval) for n in path)
        quality = tuple((1 if name == "no_speech_probability" else -1)
                        * sum(getattr(evidence[n].quality, name) for n in path) / len(path) for name in fields)
        return (-len(values[path]), -support[values[path]], -compatible, -owned,
                max(boundary_risk.get(n, 0) for n in path), quality, len(path),
                tuple((evidence[n].chunk.ordinal, evidence[n].chunk.chunk_id, evidence[n].segment_index) for n in path))

    return min(paths, key=rank)


def _canonical_graph(evidence, minimum, boundary_risk, work):
    edges = [_Edge(left, right, _align_paths(tuple(evidence[n] for n in left),
                                           tuple(evidence[n] for n in right), minimum, work))
             for left, right in _candidate_regions(evidence, work)]
    identities = tuple(item.identity for item in evidence)
    adjacency, established = defaultdict(set), {}
    uncertain = {n for n, risk in boundary_risk.items() if risk}
    identity_uncertain = set()
    for edge in edges:
        nodes = (*edge.left, *edge.right)
        if edge.kind in _ESTABLISHED:
            established[(edge.left, edge.right)] = edge.kind
            for node in nodes:
                adjacency[nodes[0]].add(node)
                adjacency[node].add(nodes[0])
        else:
            uncertain.update(nodes)
            identity_uncertain.update(nodes)
    groups, rejected = [], set()
    for group in _components(adjacency):
        by_source = defaultdict(list)
        for n in group:
            by_source[evidence[n].chunk.chunk_id].append(n)
        paths = tuple(sorted((tuple(nodes) for nodes in by_source.values()),
                             key=lambda p: (evidence[p[0]].chunk.ordinal, evidence[p[0]].chunk.chunk_id)))
        work.spend(len(paths) ** 2)
        # Complete pairwise path agreement is mandatory. A union-find/overlap
        # component alone never becomes a canonical occurrence group.
        if all((a, b) in established for a, b in combinations(paths, 2)):
            groups.append((group, paths))
        else:
            rejected.update(group)
            uncertain.update(group)
            identity_uncertain.update(group)

    selected, consumed = [], set()
    redundant = conflicting = many = one = 0
    for group, paths in groups:
        chosen = _select_path(paths, evidence, boundary_risk, work)
        consumed.update(group)
        conflict = any(established[(a, b)] is OccurrenceRelationship.CONFLICTING_HYPOTHESIS
                       for a, b in combinations(paths, 2))
        flag = ReconciliationFlag.CONFLICTING_OVERLAP if conflict else ReconciliationFlag.DUPLICATE_OVERLAP
        alternatives = tuple(n for path in paths if path != chosen for n in path)
        for path in paths:
            if path != chosen:
                if tuple(_lexical(evidence[n].tokens) for n in path) == tuple(_lexical(evidence[n].tokens) for n in chosen):
                    redundant += len(path)
                elif tuple(v for n in path for v in _lexical(evidence[n].tokens)) == tuple(
                        v for n in chosen for v in _lexical(evidence[n].tokens)):
                    redundant += len(path)
                else:
                    conflicting += len(path)
        for a, b in combinations(paths, 2):
            one += int(len(a) == 1 and len(b) > 1)
            many += int(len(a) > 1 and len(b) == 1)
        for n in chosen:
            work.retain(len(group) + len(alternatives))
            item = evidence[n]
            flags = _flags((flag,), (ReconciliationFlag.UNRESOLVED_BOUNDARY,) if set(group) & uncertain else ())
            selected.append(ReconciledSegment(
                item.interval, item.text, tuple(sorted({evidence[m].chunk.chunk_id for m in group})), flags,
                tuple(dict.fromkeys(evidence[m].text for m in alternatives if evidence[m].text != item.text)),
                selected_evidence_id=identities[n],
                supporting_evidence_ids=tuple(identities[m] for m in group),
                alternative_evidence_ids=tuple(identities[m] for m in alternatives),
            ))
    for n, item in enumerate(evidence):
        if n not in consumed:
            work.retain(1)
            selected.append(ReconciledSegment(
                item.interval, item.text, (item.chunk.chunk_id,),
                (ReconciliationFlag.UNRESOLVED_BOUNDARY,) if n in uncertain else (),
                selected_evidence_id=identities[n], supporting_evidence_ids=(identities[n],),
            ))
    work.retain(sum(len(edge.left) + len(edge.right) for edge in edges))
    relationships = tuple(ReconciliationRelationship(
        tuple(identities[n] for n in edge.left), tuple(identities[n] for n in edge.right),
        OccurrenceRelationship.AMBIGUOUS if rejected.intersection((*edge.left, *edge.right)) else edge.kind,
    ) for edge in edges)
    selected.sort(key=lambda s: (s.interval.start_sample, s.interval.end_sample,
                                 s.source_chunk_ids, s.selected_evidence_id.segment_index))
    return tuple(selected), relationships, redundant, conflicting, len(identity_uncertain), many, one


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
    *, boundary_alignment: BoundaryAlignmentReport | None = None,
) -> TranscriptReconciliation:
    """Reconcile borrowed evidence, including caller-approved recovery windows.

    Baseline chunks must match the plan exactly. Additional recovery chunks use
    distinct stable IDs/ordinals and supplied absolute core/request bounds on the
    same source timeline. This call never schedules or derives recovery windows.
    No raw candidates, provider payloads, or inferred word timestamps are returned.
    """
    category = "VALIDATION"
    evidence = None
    cancellation = None
    try:
        configuration = _configuration(settings)
        chunks = _handoff(plan, results, settings)
        outcomes, evidence, asr = _collect(chunks, results)
        _require(all(p.provider == "openrouter" and p.requested_model == settings.audio_asr_model
                     == "openai/whisper-large-v3" and all(key != "language" or value == settings.audio_asr_language
                                                         for key, value in p.inference_config) for _, p in asr))
        boundary_risk = _boundary_context(plan, results, evidence, boundary_alignment)
        work = _Work()
        segments, relationships, redundant, conflicts, ambiguous, many, one = _canonical_graph(
            evidence, configuration["min_shared_tokens"], boundary_risk, work,
        )
        segments = tuple(replace(segment, segment_id=f"segment-{ordinal:06d}", ordinal=ordinal)
                         for ordinal, segment in enumerate(segments))
        unresolved = _unresolved(plan.sample_count, segments)
        repetitions = defaultdict(list)
        for segment in segments:
            repetitions[_lexical(_tokens(segment.text))].append(segment.interval)
        # Protected chronological repetition observations, not verified speech.
        preserved = 0
        for intervals in repetitions.values():
            earliest_end = min(i.end_sample for i in intervals)
            latest_start = max(i.start_sample for i in intervals)
            preserved += sum(i.start_sample >= earliest_end or i.end_sample <= latest_start for i in intervals)
        valid_ids = {o.chunk_id for o in outcomes if o.state in (
            ReconciliationChunkState.CANDIDATE_EVIDENCE, ReconciliationChunkState.EMPTY,
        )}
        observations = ReconciliationObservations(
            sum(len(r.timeline_segments) for r in results if r.chunk.chunk_id in valid_ids), len(segments),
            redundant, conflicts, ambiguous, many, one, preserved,
            sum(i.end_sample - i.start_sample for i in unresolved), work.candidates, work.comparisons,
        )
        return TranscriptReconciliation(
            plan.source_id, plan.sample_count, segments, outcomes,
            unresolved,
            ReconciliationProvenance(_VERSION, plan.provenance, configuration, asr, chunks),
            observations, relationships,
        )
    except AudioProcessingError as error:
        category = error.category
        traceback.clear_frames(error.__traceback__)
    except MemoryError as error:
        category = "RESOURCE"
        traceback.clear_frames(error.__traceback__)
    except (AttributeError, TypeError, ValueError, KeyError, OverflowError) as error:
        traceback.clear_frames(error.__traceback__)
    except BaseException as error:
        if not isinstance(error, Exception) or isinstance(error, CancelledError):
            cancellation = error
        traceback.clear_frames(error.__traceback__)
        error.args = ()
        error.__cause__ = error.__context__ = None
    finally:
        # The public failure/cancellation frame must not retain borrowed source
        # results or derived sensitive graph/segment locals in its traceback.
        results = evidence = boundary_alignment = None
        segments = segment = repetitions = relationships = settings = None
    if cancellation is not None:
        raise cancellation.with_traceback(None)
    # Raise outside handlers so input-bearing exceptions cannot become context.
    raise AudioProcessingError(category)
