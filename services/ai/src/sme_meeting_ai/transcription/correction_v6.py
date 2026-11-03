"""Deterministic sparse ASR correction; no provider, audio, or pipeline ownership.

All offsets refer to immutable original text. A proposal-wide projection is
checked before local rejection, and only independently safe patches are applied.
Text is transient and excluded from representations, diagnostics, and metadata.
"""

import json
import math
import re
import traceback
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType

from .correction import CorrectionErrorCategory
from .reconciliation import ReconciledSegment, TranscriptReconciliation

CORRECTION_V6_SCHEMA_NAME = "vi-span-edits-v1"
CORRECTION_V6_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "segment_id": {"type": "string"},
                    "source": {"type": "string"},
                    "replacement": {"type": "string"},
                    "occurrence": {"type": "integer", "minimum": 0},
                },
                "required": ["segment_id", "source", "replacement", "occurrence"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["edits"],
    "additionalProperties": False,
}

_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_MAX_EDITS = 8192
_MAX_SEGMENT_EDITS = 32
_MAX_SPAN_CHARACTERS = 256
_MAX_OCCURRENCE = 255
_EDIT_FIELDS = frozenset(("segment_id", "source", "replacement", "occurrence"))
_CATEGORIES = frozenset((CorrectionErrorCategory.MALFORMED_OUTPUT,
                         CorrectionErrorCategory.SUSPICIOUS_OUTPUT,
                         CorrectionErrorCategory.VALIDATION, CorrectionErrorCategory.RESOURCE))
_ONSET_FAMILIES = (("gi", "d", "r"), ("ch", "tr"), ("s", "x"),
                   ("l", "n"), ("ngh", "ng"), ("c", "k"))
_NUMBERS = re.compile(r"[+\-−]?\d+(?:[.,:/\-]\d+)*%?")


class V6FailureReason(StrEnum):
    """Fixed diagnostic codes, never data supplied by a model or transcript."""

    INVALID_JSON = "invalid_json"
    DUPLICATE_KEY = "duplicate_key"
    INVALID_STRUCTURE = "invalid_structure"
    INVALID_FIELD = "invalid_field"
    UNKNOWN_SEGMENT = "unknown_segment"
    INVALID_UNICODE = "invalid_unicode"
    UNSAFE_CONTROL = "unsafe_control"
    RESPONSE_SIZE = "response_size"
    EDIT_COUNT = "edit_count"
    SEGMENT_EDIT_COUNT = "segment_edit_count"
    FIELD_LENGTH = "field_length"
    OCCURRENCE_LIMIT = "occurrence_limit"
    INVALID_RECONCILIATION = "invalid_reconciliation"
    INVALID_PROPOSAL = "invalid_proposal"
    INVALID_LIMITS = "invalid_limits"
    PROPOSAL_INTEGRITY = "proposal_integrity"
    FINAL_INTEGRITY = "final_integrity"
    RESOURCE_EXHAUSTED = "resource_exhausted"


@dataclass(frozen=True, slots=True)
class V6ValidationFailure:
    category: CorrectionErrorCategory
    reason: V6FailureReason

    def __post_init__(self) -> None:
        if (not isinstance(self.category, CorrectionErrorCategory) or self.category not in _CATEGORIES
                or not isinstance(self.reason, V6FailureReason)):
            raise ValueError("Invalid V6 failure")


class V6ValidationError(Exception):
    """Sanitized public failure; category values follow the existing contract."""

    def __init__(self, failure: V6ValidationFailure):
        self.failure = failure
        super().__init__(f"{failure.category.value}:{failure.reason.value}")

    @property
    def category(self) -> CorrectionErrorCategory:
        return self.failure.category

    @property
    def reason(self) -> V6FailureReason:
        return self.failure.reason


@dataclass(frozen=True, slots=True)
class V6EditCandidate:
    segment_id: str = field(repr=False)
    source: str = field(repr=False)
    replacement: str = field(repr=False)
    occurrence: int


@dataclass(frozen=True, slots=True)
class V6CorrectionProposal:
    edits: tuple[V6EditCandidate, ...] = field(repr=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "edits", tuple(self.edits))


@dataclass(frozen=True, slots=True)
class V6EditResult:
    texts: tuple[str, ...] = field(repr=False)
    proposed_edit_count: int
    accepted_edit_count: int
    rejected_edit_count: int
    rejected_segment_count: int
    rejection_reason_counts: Mapping[str, int]

    def __post_init__(self) -> None:
        object.__setattr__(self, "texts", tuple(self.texts))
        object.__setattr__(self, "rejection_reason_counts",
                           MappingProxyType(dict(sorted(self.rejection_reason_counts.items()))))


def _fail(category: CorrectionErrorCategory, reason: V6FailureReason) -> None:
    raise V6ValidationError(V6ValidationFailure(category, reason))


def _require(condition: bool, category: CorrectionErrorCategory, reason: V6FailureReason) -> None:
    if not condition:
        _fail(category, reason)


def _safe_unicode(text: str, category: CorrectionErrorCategory) -> int:
    try:
        size = len(text.encode("utf-8"))
    except UnicodeError:
        _fail(category, V6FailureReason.INVALID_UNICODE)
    # Whitespace used in ordinary transcripts/JSON is allowed, but control and
    # format characters (including hidden bidi instructions) are not speech.
    _require(not any(unicodedata.category(char) in ("Cc", "Cf") and char not in "\t\n\r"
                     for char in text), category, V6FailureReason.UNSAFE_CONTROL)
    return size


def _original_segments(reconciliation: TranscriptReconciliation) -> tuple[ReconciledSegment, ...]:
    """Check the text/identity boundary, without taking ownership of provenance.

    Timing, coverage and evidence validation belong to the upstream reconciler;
    this engine accepts its validated result and never copies or edits metadata.
    """
    category, reason = CorrectionErrorCategory.VALIDATION, V6FailureReason.INVALID_RECONCILIATION
    _require(isinstance(reconciliation, TranscriptReconciliation), category, reason)
    _require(isinstance(reconciliation.segments, tuple), category, reason)
    for index, segment in enumerate(reconciliation.segments):
        _require(isinstance(segment, ReconciledSegment), category, reason)
        _require(type(segment.ordinal) is int and segment.ordinal == index
                 and type(segment.segment_id) is str and segment.segment_id == f"segment-{index:06d}"
                 and type(segment.text) is str, category, reason)
        _safe_unicode(segment.text, category)
    return reconciliation.segments


def _checked_candidates(
    edits: tuple[V6EditCandidate, ...], segments: tuple[ReconciledSegment, ...],
) -> tuple[V6EditCandidate, ...]:
    malformed, resource = CorrectionErrorCategory.MALFORMED_OUTPUT, CorrectionErrorCategory.RESOURCE
    _require(len(edits) <= _MAX_EDITS, resource, V6FailureReason.EDIT_COUNT)
    known = {segment.segment_id for segment in segments}
    per_segment: Counter[str] = Counter()
    for edit in edits:
        _require(type(edit) is V6EditCandidate, malformed, V6FailureReason.INVALID_FIELD)
        for value in (edit.segment_id, edit.source, edit.replacement):
            _require(type(value) is str and bool(value), malformed, V6FailureReason.INVALID_FIELD)
            _safe_unicode(value, malformed)
        _require(edit.segment_id in known, malformed, V6FailureReason.UNKNOWN_SEGMENT)
        _require(len(edit.source) <= _MAX_SPAN_CHARACTERS and len(edit.replacement) <= _MAX_SPAN_CHARACTERS,
                 resource, V6FailureReason.FIELD_LENGTH)
        _require(type(edit.occurrence) is int and edit.occurrence >= 0,
                 malformed, V6FailureReason.INVALID_FIELD)
        _require(edit.occurrence <= _MAX_OCCURRENCE, resource, V6FailureReason.OCCURRENCE_LIMIT)
        per_segment[edit.segment_id] += 1
        _require(per_segment[edit.segment_id] <= _MAX_SEGMENT_EDITS,
                 resource, V6FailureReason.SEGMENT_EDIT_COUNT)
    return edits


def _json_pairs(items: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in items:
        _safe_unicode(key, CorrectionErrorCategory.MALFORMED_OUTPUT)
        _require(key not in result, CorrectionErrorCategory.MALFORMED_OUTPUT, V6FailureReason.DUPLICATE_KEY)
        result[key] = value
    return result


def _invalid_number(_value: str) -> None:
    # No contract field accepts floats, nonfinite constants, or exponential
    # numeric forms. Reject them at decoding, rather than coercing to integers.
    _fail(CorrectionErrorCategory.MALFORMED_OUTPUT, V6FailureReason.INVALID_FIELD)


def _check_json_nesting(text: str) -> None:
    """The exact contract permits only object -> array -> edit object nesting.

    Reject deeper structures before decoding, independently of the interpreter's
    recursion limit. Quoted/escaped brackets are data; JSON syntax is still
    validated exclusively by the strict decoder below.
    """
    depth, quoted, escaped = 0, False, False
    for char in text:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            _require(depth <= 3, CorrectionErrorCategory.MALFORMED_OUTPUT, V6FailureReason.INVALID_STRUCTURE)
        elif char in "]}":
            depth -= 1


def _parse_response(response_text: str, segments: tuple[ReconciledSegment, ...]) -> V6CorrectionProposal:
    malformed = CorrectionErrorCategory.MALFORMED_OUTPUT
    _require(type(response_text) is str, malformed, V6FailureReason.INVALID_STRUCTURE)
    _require(len(response_text) <= _MAX_RESPONSE_BYTES,
             CorrectionErrorCategory.RESOURCE, V6FailureReason.RESPONSE_SIZE)
    # Check byte size before scanning controls or parsing JSON; never truncate.
    try:
        size = len(response_text.encode("utf-8"))
    except UnicodeError:
        _fail(malformed, V6FailureReason.INVALID_UNICODE)
    _require(size <= _MAX_RESPONSE_BYTES, CorrectionErrorCategory.RESOURCE, V6FailureReason.RESPONSE_SIZE)
    _check_json_nesting(response_text)
    data = json.loads(response_text, object_pairs_hook=_json_pairs,
                      parse_constant=_invalid_number, parse_float=_invalid_number)
    _require(type(data) is dict and set(data) == {"edits"}, malformed, V6FailureReason.INVALID_STRUCTURE)
    entries = data["edits"]
    _require(type(entries) is list, malformed, V6FailureReason.INVALID_STRUCTURE)
    _require(len(entries) <= _MAX_EDITS, CorrectionErrorCategory.RESOURCE, V6FailureReason.EDIT_COUNT)
    edits = []
    for entry in entries:
        _require(type(entry) is dict and set(entry) == _EDIT_FIELDS, malformed, V6FailureReason.INVALID_FIELD)
        edits.append(V6EditCandidate(entry["segment_id"], entry["source"],
                                     entry["replacement"], entry["occurrence"]))
    return V6CorrectionProposal(_checked_candidates(tuple(edits), segments))


def parse_v6_proposal(
    response_text: str, reconciliation: TranscriptReconciliation,
) -> V6CorrectionProposal:
    """Parse the exact sparse contract, or raise a sanitized V6ValidationError.

    Structural/resource errors reject the response, including empty fields and
    foreign identities. A valid empty edit array is a successful no-edit proposal.
    """
    failure = V6ValidationFailure(CorrectionErrorCategory.VALIDATION, V6FailureReason.INVALID_PROPOSAL)
    try:
        return _parse_response(response_text, _original_segments(reconciliation))
    except V6ValidationError as error:
        failure = error.failure
        traceback.clear_frames(error.__traceback__)
    except (MemoryError, RecursionError) as error:
        failure = V6ValidationFailure(CorrectionErrorCategory.RESOURCE, V6FailureReason.RESOURCE_EXHAUSTED)
        traceback.clear_frames(error.__traceback__)
    except (ValueError, OverflowError) as error:
        failure = V6ValidationFailure(CorrectionErrorCategory.MALFORMED_OUTPUT, V6FailureReason.INVALID_JSON)
        traceback.clear_frames(error.__traceback__)
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
    finally:
        response_text = reconciliation = None
    # Raising outside handlers removes even the hidden context of JSON errors,
    # which otherwise retain raw response documents and arbitrary diagnostics.
    raise V6ValidationError(failure) from None


def _fold(text: str) -> str:
    return unicodedata.normalize("NFC", text).casefold()


def _lexical_key(text: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFD", _fold(text))
                   if unicodedata.category(char) != "Mn").replace("đ", "d")


def _word_character(char: str) -> bool:
    return char == "_" or unicodedata.category(char)[0] in "LNM"


@dataclass(frozen=True, slots=True)
class _Token:
    value: str = field(repr=False)
    start: int
    end: int


def _tokens(text: str) -> tuple[_Token, ...]:
    """Tokenize original code points without normalizing literal patch offsets.

    Combining marks stay attached; common technical punctuation stays inside
    identifiers (C++, C#, API-v2, dotted versions, paths and snake_case).
    """
    output = []
    position = 0
    while position < len(text):
        if not _word_character(text[position]):
            position += 1
            continue
        start = position
        position += 1
        while position < len(text):
            if _word_character(text[position]):
                position += 1
            elif text[position] in "-./:@" and position + 1 < len(text) and _word_character(text[position + 1]):
                position += 1
            else:
                break
        while position < len(text) and text[position] in "+#%":
            position += 1
        value = text[start:position]
        if any(unicodedata.category(char)[0] in "LN" for char in value):
            output.append(_Token(value, start, position))
    return tuple(output)


@dataclass(frozen=True, slots=True)
class _ResolvedEdit:
    index: int
    segment: int
    start: int
    end: int
    candidate: V6EditCandidate = field(repr=False)


def _resolve(
    segments: tuple[ReconciledSegment, ...], edits: tuple[V6EditCandidate, ...],
) -> tuple[list[_ResolvedEdit], dict[int, str]]:
    by_id = {segment.segment_id: index for index, segment in enumerate(segments)}
    resolved, rejected = [], {}
    for index, edit in enumerate(edits):
        owner = by_id[edit.segment_id]
        text, position = segments[owner].text, -1
        search_start = 0
        for _ in range(edit.occurrence + 1):
            position = text.find(edit.source, search_start)
            if position < 0:
                break
            search_start = position + len(edit.source)
        if position < 0:
            rejected[index] = "unresolvable_span"
        else:
            resolved.append(_ResolvedEdit(index, owner, position, search_start, edit))

    grouped: dict[int, list[_ResolvedEdit]] = defaultdict(list)
    for patch in resolved:
        grouped[patch.segment].append(patch)
    for patches in grouped.values():
        ordered = sorted(patches, key=lambda patch: (patch.start, patch.end, patch.index))
        for index, left in enumerate(ordered):
            for right in ordered[index + 1:]:
                if right.start >= left.end:
                    break
                rejected[left.index] = rejected[right.index] = "overlap_conflict"
    return [patch for patch in resolved if patch.index not in rejected], rejected


def _patched_texts(segments: tuple[ReconciledSegment, ...], patches: list[_ResolvedEdit]) -> tuple[str, ...]:
    grouped: dict[int, list[_ResolvedEdit]] = defaultdict(list)
    for patch in patches:
        grouped[patch.segment].append(patch)
    texts = [segment.text for segment in segments]
    for owner, edits in grouped.items():
        for patch in sorted(edits, key=lambda patch: patch.start, reverse=True):
            texts[owner] = texts[owner][:patch.start] + patch.candidate.replacement + texts[owner][patch.end:]
    return tuple(texts)


def _character_count(text: str) -> int:
    return sum(not char.isspace() for char in _fold(text))


def _global_words(text: str) -> tuple[str, ...]:
    # Match V5's aggregate word and accent-insensitive multiset semantics. These
    # comparison tokens do not determine literal source positions or identifier
    # boundaries, which are handled independently by _tokens.
    return tuple(re.findall(r"[^\W_]+", _fold(text)))


def _length_is_safe(source_words, target_words, source_characters, target_characters, minimum, maximum) -> bool:
    if bool(source_words) != bool(target_words):
        return False
    word_ratio = len(target_words) / len(source_words) if source_words else 1.0
    if not minimum <= word_ratio <= maximum:
        return False
    if source_characters >= 16:
        return minimum <= target_characters / source_characters <= maximum
    # Keep V5's short-speech principle: punctuation/case can change presentation,
    # but speech length still obeys both bounds, with a finite punctuation cap.
    source_letters, target_letters = sum(map(len, source_words)), sum(map(len, target_words))
    content_ratio = target_letters / source_letters if source_letters else 1.0
    return (minimum <= content_ratio <= maximum
            and target_characters <= max(16, source_characters * maximum))


def _global_integrity(
    segments: tuple[ReconciledSegment, ...], texts: tuple[str, ...], minimum: float, maximum: float,
    *, final: bool,
) -> None:
    category = CorrectionErrorCategory.SUSPICIOUS_OUTPUT
    reason = V6FailureReason.FINAL_INTEGRITY if final else V6FailureReason.PROPOSAL_INTEGRITY
    _require(len(texts) == len(segments), category, reason)
    source_words, target_words = [], []
    source_characters = target_characters = 0
    for segment, text in zip(segments, texts, strict=True):
        _require(type(text) is str, category, reason)
        _safe_unicode(text, category)
        original, corrected = _global_words(segment.text), _global_words(text)
        if final:
            _require(bool(original) or not corrected, category, reason)
        source_words.extend(original)
        target_words.extend(corrected)
        source_characters += _character_count(segment.text)
        target_characters += _character_count(text)
    _require(_length_is_safe(source_words, target_words, source_characters, target_characters, minimum, maximum),
             category, reason)
    if len(source_words) >= 8 and source_characters >= 32:
        source_counts = Counter(_lexical_key(word) for word in source_words)
        target_counts = Counter(_lexical_key(word) for word in target_words)
        shared = sum((source_counts & target_counts).values())
        _require(shared / max(len(source_words), len(target_words), 1) >= 0.5, category, reason)


def _one_character_edit(source: str, target: str) -> bool:
    if abs(len(source) - len(target)) > 1:
        return False
    position = 0
    while position < min(len(source), len(target)) and source[position] == target[position]:
        position += 1
    if len(source) == len(target):
        return source[position + 1:] == target[position + 1:]
    if len(source) > len(target):
        return source[position + 1:] == target[position:]
    return source[position:] == target[position + 1:]


def _similar(source: str, target: str) -> bool:
    source, target = _lexical_key(source), _lexical_key(target)
    if source == target:
        return True
    if min(len(source), len(target)) >= 3 and _one_character_edit(source, target):
        return True
    for family in _ONSET_FAMILIES:
        # Longest-first onset extraction avoids treating "gi" as a one-letter
        # onset or "ngh" as "ng". An empty rhyme is not phonetic evidence.
        a = next((onset for onset in family if source.startswith(onset)), None)
        b = next((onset for onset in family if target.startswith(onset)), None)
        if a is not None and b is not None and a != b and source[len(a):] and source[len(a):] == target[len(b):]:
            return True
    return False


def _name(word: str) -> bool:
    word = unicodedata.normalize("NFC", word)
    # Casing is evidence of a protected name, not proof of an entity. Protecting
    # sentence-initial capitalized words too is a deliberate text-only fallback.
    return word[:1].isupper() and any(char.islower() for char in word[1:])


def _identifier(word: str) -> bool:
    word = unicodedata.normalize("NFC", word)
    return (any(not char.isalpha() for char in word)
            or (word.isupper() and len(word) > 1)
            or any(char.isupper() for char in word[1:]))


def _context_index(words: tuple[tuple[str, ...], ...]) -> dict[tuple[str, str], list[tuple[int, int]]]:
    index: dict[tuple[str, str], list[tuple[int, int]]] = defaultdict(list)
    for owner, segment_words in enumerate(words):
        for start in range(len(segment_words) - 1):
            index[segment_words[start:start + 2]].append((owner, start))
    return index


def _corroborated(
    owner: int, token_index: int, replacement: str, tokens: tuple[tuple[_Token, ...], ...],
    words: tuple[tuple[str, ...], ...], context: dict[tuple[str, str], list[tuple[int, int]]],
) -> bool:
    original = tokens[owner]
    left, right = token_index, token_index + 1
    if _name(original[token_index].value):
        while left and _name(original[left - 1].value):
            left -= 1
        while right < len(original) and _name(original[right].value):
            right += 1
    if right - left > 1:
        # Match the whole neighboring original name, with only this token's
        # proposed spelling. Neither other proposals nor same-segment repetition
        # can become independent corroboration.
        phrase = list(words[owner][left:right])
        phrase[token_index - left] = _fold(replacement)
        phrases = [tuple(phrase)]
    else:
        phrases = []
        if token_index:
            phrases.append((words[owner][token_index - 1], _fold(replacement)))
        if token_index + 1 < len(original):
            phrases.append((_fold(replacement), words[owner][token_index + 1]))
    return any(
        other != owner and words[other][start:start + len(phrase)] == phrase
        for phrase in phrases
        for other, start in context.get(phrase[:2], ())
    )


def _local_rejection(
    patch: _ResolvedEdit, segments: tuple[ReconciledSegment, ...],
    tokens: tuple[tuple[_Token, ...], ...], words: tuple[tuple[str, ...], ...],
    context: dict[tuple[str, str], list[tuple[int, int]]], minimum: float, maximum: float,
) -> str | None:
    original = tokens[patch.segment]
    if any(token.start < patch.start < token.end or token.start < patch.end < token.end for token in original):
        return "partial_token"
    edit = patch.candidate
    if edit.source == edit.replacement:
        return "noop_edit"
    source, target = _tokens(edit.source), _tokens(edit.replacement)
    # Numeric signs, separators and percentages have meaning even when they are
    # outside the ordinary lexical word; case/Unicode changes leave them intact.
    if _NUMBERS.findall(_fold(edit.source)) != _NUMBERS.findall(_fold(edit.replacement)):
        return "protected_token"
    if len(target) > len(source):
        return "unsafe_expansion"
    if len(target) < len(source):
        return "unsafe_length_change"
    if not source or len(source) > 8:
        return "unsupported_lexical_change"

    covered = [(index, token) for index, token in enumerate(original)
               if patch.start <= token.start and token.end <= patch.end]
    # Check the retained neighboring tokens as well: deleting boundary whitespace
    # or attaching technical punctuation must not fuse two original words/IDs.
    before = next((token for token in reversed(original) if token.end <= patch.start), None)
    after = next((token for token in original if token.start >= patch.end), None)
    start = before.start if before else patch.start
    end = after.end if after else patch.end
    original_text = segments[patch.segment].text
    window = original_text[start:patch.start] + edit.replacement + original_text[patch.end:end]
    if _NUMBERS.findall(_fold(original_text[start:end])) != _NUMBERS.findall(_fold(window)):
        return "protected_token"
    expected = ([before.value] if before else []) + [token.value for token in target] + ([after.value] if after else [])
    if tuple(_fold(token.value) for token in _tokens(window)) != tuple(_fold(value) for value in expected):
        return "partial_token"

    changes = 0
    for (token_index, token), replacement in zip(covered, target, strict=True):
        if _fold(token.value) == _fold(replacement.value):
            continue
        if any(char.isdigit() for char in token.value + replacement.value):
            return "protected_token"
        if (_name(token.value) or _identifier(token.value) or _identifier(replacement.value)) and not _corroborated(
            patch.segment, token_index, replacement.value, tokens, words, context,
        ):
            return "protected_token"
        if _lexical_key(token.value) != _lexical_key(replacement.value):
            changes += 1
            if changes > 1 or not _similar(token.value, replacement.value):
                return "unsupported_lexical_change"
    source_words, target_words = _global_words(edit.source), _global_words(edit.replacement)
    a, b = _character_count(edit.source), _character_count(edit.replacement)
    if not _length_is_safe(source_words, target_words, a, b, minimum, maximum):
        return "unsafe_expansion" if b > a else "unsafe_length_change"
    return None


def _apply(
    reconciliation: TranscriptReconciliation, proposal: V6CorrectionProposal, minimum: float, maximum: float,
) -> V6EditResult:
    _require(type(minimum) in (int, float) and math.isfinite(minimum) and 0 < minimum <= 1
             and type(maximum) in (int, float) and math.isfinite(maximum) and maximum >= 1,
             CorrectionErrorCategory.VALIDATION, V6FailureReason.INVALID_LIMITS)
    segments = _original_segments(reconciliation)
    _require(type(proposal) is V6CorrectionProposal, CorrectionErrorCategory.VALIDATION, V6FailureReason.INVALID_PROPOSAL)
    edits = _checked_candidates(proposal.edits, segments)
    resolved, rejected = _resolve(segments, edits)
    _global_integrity(segments, _patched_texts(segments, resolved), minimum, maximum, final=False)

    accepted = []
    if resolved:
        tokens = tuple(_tokens(segment.text) for segment in segments)
        words = tuple(tuple(_fold(token.value) for token in segment_tokens) for segment_tokens in tokens)
        context = _context_index(words)
        for patch in resolved:
            reason = _local_rejection(patch, segments, tokens, words, context, minimum, maximum)
            if reason is None:
                accepted.append(patch)
            else:
                rejected[patch.index] = reason
    texts = _patched_texts(segments, accepted)
    _global_integrity(segments, texts, minimum, maximum, final=True)
    return V6EditResult(texts, len(edits), len(accepted), len(rejected),
                        len({edits[index].segment_id for index in rejected}), Counter(rejected.values()))


def apply_v6_edits(
    reconciliation: TranscriptReconciliation, proposal: V6CorrectionProposal, *,
    min_text_ratio: float = 0.65, max_text_ratio: float = 1.5,
) -> V6EditResult:
    """Apply independent, original-anchored patches with two global safety gates.

    Limits must be finite, with 0 < minimum <= 1 <= maximum. Results contain only
    immutable text/statistics; no server-owned segment metadata is reconstructed.
    Structural, resource and global failures raise V6ValidationError without a
    partial result. Linguistic/span failures are counted and rejected locally.
    """
    failure = V6ValidationFailure(CorrectionErrorCategory.VALIDATION, V6FailureReason.INVALID_PROPOSAL)
    try:
        return _apply(reconciliation, proposal, min_text_ratio, max_text_ratio)
    except V6ValidationError as error:
        failure = error.failure
        traceback.clear_frames(error.__traceback__)
    except (MemoryError, RecursionError) as error:
        failure = V6ValidationFailure(CorrectionErrorCategory.RESOURCE, V6FailureReason.RESOURCE_EXHAUSTED)
        traceback.clear_frames(error.__traceback__)
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
    finally:
        reconciliation = proposal = min_text_ratio = max_text_ratio = None
    raise V6ValidationError(failure) from None
