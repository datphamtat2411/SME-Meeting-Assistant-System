"""Standalone, legacy-first lexical safety gate for explicitly proposed edits.

Internal dependency: this module intentionally uses frozen ``correction_v6``
private parsing/application primitives, tokens, local validation, and integrity
checks. Changes to those primitives require the V6/V6.1 regression matrix. No
schema, provider, prompt, pipeline selection, or reconciliation metadata belongs
to this module. Public models and sanitized failures are the existing V6 models.

Policy/calibration (the synthetic offline matrix is in test_correction_v61.py):

* V6 local acceptance is authoritative. Only unsupported_lexical_change,
  unsafe_length_change, and unsafe_expansion can be reconsidered. All newly
  eligible edits recheck complete tokens, retained neighbors, protected content,
  and punctuation; both original V6 aggregate integrity gates remain mandatory.
* Comparison uses NFC/casefold, then NFD mark removal and Vietnamese d-stroke
  folding, exactly as V6. These comparison keys NEVER determine literal offsets
  or output normalization. Latin letters only, with at most 24 normalized
  letters per new comparison. Unicode combining marks stay with their tokens.
* Loanwords: let D be bounded Levenshtein distance, M the longer key length,
  and S the LCS length divided by M. Require min length 4, D <= 3, D/M <= .43,
  and length ratio >= .75. Then require either identical conservative spelling
  keys (ph/f, ck/k, qu/k, c/k/q, y/i), or ALL of: min length 6, shared prefix
  >= 2, S >= .57, identical nonempty vowel sequences, identical collapsed
  consonant/vowel patterns. The latter admits multiple consonant distortions
  without certifying their meaning. Bounds .43/.57 admit three changes and
  four retained letters out of seven; shorter words have a smaller edit budget.
  These are conjunctive safety features, not a universal language metric.
* Phrases: two or three positionally aligned tokens, at most two non-accent
  lexical changes. Each changed token independently needs V6 similarity or
  Vietnamese onset/rhyme evidence. Onset families retain V6 families and add
  the palatal/sibilant group ch/tr/s/x. Beyond V6, rhymes must be identical, or
  share their first two vowels and differ by at most one character (minimum
  rhyme length three). No aggregate score can conceal an unrelated token.
* Boundary repair: at most four source/three target tokens, one net boundary
  change, an unchanged token anchor, and exactly one aligned split/merge.
  Orthographic repairs preserve concatenated NFC/casefolded letters exactly.
  Genuine contraction additionally permits one epenthetic vowel or duplicated
  letter to disappear from a merged pair (5..24 letters), retaining two-letter
  prefix/suffix anchors. All other tokens are unchanged. Both paths require
  the whole target phrase in another ORIGINAL segment, with intact whitespace
  boundaries. Fillers, repeated speech, operators, names and IDs cannot vanish.
* Evidence lookup indexes only requested exact two/three-token phrases in one
  linear pass over original segments. At most two distinct owners per phrase
  suffice to prove independence. No fuzzy transcript search or whole-meeting
  alignment is performed. DP uses at most 25 cells per row and 24 rows, with
  distance capped at three. The inherited 4 MiB/8192/32/256/255 limits apply.

Safety limitation: text cannot establish what was spoken or the semantic
domain. A contextually wrong but lexically plausible LLM proposal can pass,
including in an unrelated conversation. Protected-operator/disfluency lists
are conservative safety inventories, not exhaustive semantic classifiers.
V6-accepted edits retain V6's existing limitations. No proposal means no change.
Unsupported classes include paraphrases, arbitrary insertions/deletions,
uncorroborated contractions, long phrase rewrites, and distant terminology.

Task 02 handoff: propose literal original spans with the unchanged four-field
vi-span-edits-v1 contract. Prefer isolated terminology tokens and local 2/3-token
phonetic repairs; boundary repairs need the evidence above. Do not propose
fluency edits, filler deletion, semantic rewrites, or unsupported name/ID changes.
Passing this gate means deterministic lexical/structural eligibility, NOT proof
that the replacement is true to audio. The caller owns semantic discovery.
"""

import math
import traceback
import unicodedata
from collections import Counter
from dataclasses import dataclass, field

from . import correction_v6 as _v6
from .correction import CorrectionErrorCategory
from .correction_edit_review import _begin_edit_review, _finish_edit_review
from .correction_v6 import (
    V6CorrectionProposal,
    V6EditCandidate,
    V6EditResult,
    V6FailureReason,
    V6ValidationError,
    V6ValidationFailure,
    _checked_candidates,
    _global_integrity,
    _original_segments,
    _patched_texts,
    _resolve,
    _tokens,
)
from .reconciliation import ReconciledSegment, TranscriptReconciliation

V61_ENGINE_VERSION = "vi-context-validation-6.1"

_RECONSIDERABLE = frozenset(("unsupported_lexical_change", "unsafe_length_change", "unsafe_expansion"))
_MAX_LETTERS = 24
_VOWELS = frozenset("aeiouy")
_ONSETS = ("ngh", "ch", "gh", "gi", "kh", "ng", "nh", "ph", "th", "tr",
           "b", "c", "d", "g", "h", "k", "l", "m", "n", "p", "q", "r", "s", "t", "v", "x")
_ONSET_FAMILIES = (*_v6._ONSET_FAMILIES, ("ch", "tr", "s", "x"))
_CODAS = frozenset(("", "c", "ch", "m", "n", "ng", "nh", "p", "t"))
# Closed safety vocabulary: polarity, affirmation, quantities, time direction,
# modality/commitment, logical operators, and spoken hesitations. Accent-sensitive
# signatures prevent a new phonetic path from silently changing these operators.
_SPEECH_GUARDS = frozenset("""
    không chẳng chưa chả đừng chớ đâu có đúng vâng dạ ừ ờ à ạ ơ ừm ừh
    nha nhé nhỉ uh um uhm erm hmm yes no not never
    một hai ba bốn năm sáu bảy tám chín mười trăm nghìn ngàn triệu tỷ
    ít nhiều mọi mỗi cả đủ thiếu thừa hơn kém nhất tất
    trước sau đã sẽ đang từng còn hết mới vừa sắp luôn vẫn lại chỉ
    phải cần nên muốn định dám hứa quyết chắc đồng ý phản cam kết
    và hoặc hay nhưng nếu thì vì bởi trừ can cannot must may might
""".split())


def _bounded_distance(source: str, target: str, limit: int) -> int:
    """Banded edit distance; return limit + 1 beyond the finite work budget."""
    if max(len(source), len(target)) > _MAX_LETTERS or abs(len(source) - len(target)) > limit:
        return limit + 1
    previous = list(range(len(target) + 1))
    for row, char in enumerate(source, 1):
        current = [limit + 1] * (len(target) + 1)
        current[0] = row
        for column in range(max(1, row - limit), min(len(target), row + limit) + 1):
            current[column] = min(previous[column] + 1, current[column - 1] + 1,
                                  previous[column - 1] + (char != target[column - 1]))
        if min(current) > limit:
            return limit + 1
        previous = current
    return min(previous[-1], limit + 1)


def _shared_subsequence(source: str, target: str) -> int:
    """LCS length on already bounded Latin keys; two rows, no traceback table."""
    previous = [0] * (len(target) + 1)
    for char in source:
        current = [0]
        for column, other in enumerate(target, 1):
            current.append(previous[column - 1] + 1 if char == other
                           else max(previous[column], current[-1]))
        previous = current
    return previous[-1]


def _latin_key(word: str) -> str | None:
    original = unicodedata.normalize("NFC", word)
    if not original or any(not char.isalpha() or "LATIN" not in unicodedata.name(char, "") for char in original):
        return None
    key = _v6._lexical_key(original)
    return key if len(key) <= _MAX_LETTERS and key.isascii() and key.isalpha() else None


def _spelling_key(key: str) -> str:
    # General grapheme correspondences, never source/replacement word pairs.
    return key.replace("ph", "f").replace("ck", "k").replace("qu", "k").translate(
        str.maketrans({"c": "k", "q": "k", "y": "i"}),
    )


def _cv_pattern(key: str) -> str:
    pattern = []
    for char in key:
        kind = "v" if char in _VOWELS else "c"
        if not pattern or pattern[-1] != kind:
            pattern.append(kind)
    return "".join(pattern)


def _loanword_similar(source: str, target: str) -> bool:
    a, b = _latin_key(source), _latin_key(target)
    if a is None or b is None or min(len(a), len(b)) < 4:
        return False
    size = max(len(a), len(b))
    if min(len(a), len(b)) / size < 0.75:
        return False
    # A capped sentinel of four must never be interpreted as an allowed distance
    # on a long word whose proportional budget is larger than three.
    distance = _bounded_distance(a, b, 3)
    if distance > 3 or distance / size > 0.43:
        return False
    if _spelling_key(a) == _spelling_key(b):
        return True
    vowels = "".join(char for char in a if char in _VOWELS)
    return (min(len(a), len(b)) >= 6 and a[:2] == b[:2]
            and bool(vowels) and vowels == "".join(char for char in b if char in _VOWELS)
            and _cv_pattern(a) == _cv_pattern(b) and _shared_subsequence(a, b) / size >= 0.57)


def _syllable_parts(key: str) -> tuple[str, str] | None:
    onset = next((value for value in _ONSETS if key.startswith(value)), "")
    rhyme = key[len(onset):]
    stop = 0
    while stop < len(rhyme) and rhyme[stop] in _VOWELS:
        stop += 1
    return (onset, rhyme) if stop and rhyme[stop:] in _CODAS else None


def _syllable_similar(source: str, target: str) -> bool:
    a, b = _latin_key(source), _latin_key(target)
    if a is None or b is None or max(len(a), len(b)) > 12:
        return False
    if _v6._similar(source, target):
        return True
    first, second = _syllable_parts(a), _syllable_parts(b)
    if first is None or second is None:
        return False
    onset_a, rhyme_a = first
    onset_b, rhyme_b = second
    if onset_a != onset_b and not any(onset_a in family and onset_b in family for family in _ONSET_FAMILIES):
        return False
    return (rhyme_a == rhyme_b
            or (min(len(rhyme_a), len(rhyme_b)) >= 3 and rhyme_a[:2] == rhyme_b[:2]
                and all(char in _VOWELS for char in rhyme_a[:2])
                and _bounded_distance(rhyme_a, rhyme_b, 1) <= 1))


@dataclass(frozen=True, slots=True)
class _OriginalContext:
    tokens: tuple[tuple[_v6._Token, ...], ...] = field(repr=False)
    words: tuple[tuple[str, ...], ...] = field(repr=False)
    legacy_index: dict[tuple[str, str], list[tuple[int, int]]] = field(repr=False)
    phrase_owners: dict[tuple[str, ...], frozenset[int]] = field(repr=False)


def _plain_gap(gap: str) -> bool:
    return bool(gap) and all(char in " \t" for char in gap)


def _make_context(segments: tuple[ReconciledSegment, ...], edits: tuple[V6EditCandidate, ...]) -> _OriginalContext:
    tokens = tuple(_tokens(segment.text) for segment in segments)
    words = tuple(tuple(_v6._fold(token.value) for token in segment) for segment in tokens)
    wanted = set()
    for edit in edits:
        source, target = _tokens(edit.source), _tokens(edit.replacement)
        if len(source) <= 4 and 2 <= len(target) <= 3 and abs(len(source) - len(target)) == 1:
            wanted.add(tuple(_v6._fold(token.value) for token in target))
    owners: dict[tuple[str, ...], set[int]] = {phrase: set() for phrase in wanted}
    if wanted:
        for owner, segment_words in enumerate(words):
            for start in range(len(segment_words)):
                for length in (2, 3):
                    phrase = segment_words[start:start + length]
                    if len(phrase) != length or phrase not in owners or len(owners[phrase]) == 2:
                        continue
                    window = tokens[owner][start:start + length]
                    if all(_plain_gap(segments[owner].text[left.end:right.start])
                           for left, right in zip(window, window[1:])):
                        owners[phrase].add(owner)
    return _OriginalContext(tokens, words, _v6._context_index(words),
                            {phrase: frozenset(value) for phrase, value in owners.items()})


def _protected_signature(tokens: tuple[_v6._Token, ...]) -> tuple[str, ...]:
    return tuple(_v6._fold(token.value) for token in tokens
                 if _v6._name(token.value) or _v6._identifier(unicodedata.normalize("NFC", token.value)))


def _speech_signature(tokens: tuple[_v6._Token, ...]) -> tuple[str, ...]:
    return tuple(value for token in tokens if (value := _v6._fold(token.value)) in _SPEECH_GUARDS)


def _safety_rejection(
    patch: _v6._ResolvedEdit, segments: tuple[ReconciledSegment, ...], context: _OriginalContext,
    source: tuple[_v6._Token, ...], target: tuple[_v6._Token, ...],
) -> str | None:
    """Recheck checks V6 may not have reached before its lexical/count return."""
    original = context.tokens[patch.segment]
    if any(token.start < patch.start < token.end or token.start < patch.end < token.end for token in original):
        return "partial_token"
    edit = patch.candidate
    if (_v6._NUMBERS.findall(_v6._fold(edit.source)) != _v6._NUMBERS.findall(_v6._fold(edit.replacement))
            or _protected_signature(source) != _protected_signature(target)
            or _speech_signature(source) != _speech_signature(target)):
        return "protected_token"
    # Also forbid moving protected tokens relative to their neighbors in a
    # same-count phrase, even if their multiset/ordered signature is preserved.
    if len(source) == len(target):
        for left, right in zip(source, target, strict=True):
            if _v6._fold(left.value) == _v6._fold(right.value):
                continue
            if (_protected_signature((left,)) or _protected_signature((right,))
                    or _speech_signature((left,)) or _speech_signature((right,))):
                return "protected_token"
    before = next((token for token in reversed(original) if token.end <= patch.start), None)
    after = next((token for token in original if token.start >= patch.end), None)
    start, end = before.start if before else patch.start, after.end if after else patch.end
    text = segments[patch.segment].text
    window = text[start:patch.start] + edit.replacement + text[patch.end:end]
    if _v6._NUMBERS.findall(_v6._fold(text[start:end])) != _v6._NUMBERS.findall(_v6._fold(window)):
        return "protected_token"
    expected = ([before.value] if before else []) + [token.value for token in target] + ([after.value] if after else [])
    if tuple(_v6._fold(token.value) for token in _tokens(window)) != tuple(_v6._fold(value) for value in expected):
        return "partial_token"
    return None


def _gaps(text: str, tokens: tuple[_v6._Token, ...]) -> tuple[str, ...]:
    return (text[:tokens[0].start], *(text[left.end:right.start] for left, right in zip(tokens, tokens[1:])),
            text[tokens[-1].end:])


def _punctuation_preserved(
    edit: V6EditCandidate, source: tuple[_v6._Token, ...], target: tuple[_v6._Token, ...],
) -> bool:
    a, b = _gaps(edit.source, source), _gaps(edit.replacement, target)
    if not all(_plain_gap(gap) for gap in (*a[1:-1], *b[1:-1])):
        return False
    return a == b if len(source) == len(target) else a[0] == b[0] and a[-1] == b[-1]


def _phrase_similar(source: tuple[_v6._Token, ...], target: tuple[_v6._Token, ...]) -> bool:
    if len(source) != len(target) or not 2 <= len(source) <= 3:
        return False
    changes = 0
    for left, right in zip(source, target, strict=True):
        if _v6._lexical_key(left.value) == _v6._lexical_key(right.value):
            continue
        changes += 1
        if changes > 2 or not _syllable_similar(left.value, right.value):
            return False
    return True


def _merge_similar(left: str, right: str, target: str, *, orthographic: bool) -> bool:
    a, b, merged = _latin_key(left), _latin_key(right), _latin_key(target)
    if a is None or b is None or merged is None or min(len(a), len(b)) < 2:
        return False
    joined = a + b
    if len(joined) > _MAX_LETTERS:
        return False
    if orthographic:
        return _v6._fold(left + right) == _v6._fold(target)
    if (min(len(joined), len(merged)) < 5 or len(joined) != len(merged) + 1
            or joined[:2] != merged[:2] or joined[-2:] != merged[-2:]
            or _bounded_distance(joined, merged, 1) != 1):
        return False
    # Permit one epenthetic vowel or duplicated grapheme, never an arbitrary
    # removed word. Prefix/suffix anchors remain independent requirements.
    position = next((index for index, (a, b) in enumerate(zip(joined, merged)) if a != b), len(merged))
    removed = joined[position]
    duplicated = ((position > 0 and joined[position - 1] == removed)
                  or (position + 1 < len(joined) and joined[position + 1] == removed))
    return (removed in _VOWELS or duplicated) and joined[:position] + joined[position + 1:] == merged


def _one_merge_alignment(
    larger: tuple[_v6._Token, ...], smaller: tuple[_v6._Token, ...], *, orthographic: bool,
) -> bool:
    # At most three positions; all tokens except the merged pair are unchanged
    # anchors. No beam search, skipped-word alignment, or recursive contraction.
    if len(larger) != len(smaller) + 1 or len(smaller) < 2:
        return False
    for index in range(len(larger) - 1):
        before = zip(larger[:index], smaller[:index], strict=True)
        after = zip(larger[index + 2:], smaller[index + 1:], strict=True)
        if (all(_v6._fold(a.value) == _v6._fold(b.value) for a, b in before)
                and all(_v6._fold(a.value) == _v6._fold(b.value) for a, b in after)
                and _merge_similar(larger[index].value, larger[index + 1].value,
                                   smaller[index].value, orthographic=orthographic)):
            return True
    return False


def _boundary_rejection(
    patch: _v6._ResolvedEdit, source: tuple[_v6._Token, ...], target: tuple[_v6._Token, ...],
    context: _OriginalContext, legacy_reason: str,
) -> str | None:
    contracting = len(source) > len(target)
    invalid = "unsafe_phrase_contraction" if contracting else legacy_reason
    source_words = tuple(_v6._fold(token.value) for token in source)
    target_words = tuple(_v6._fold(token.value) for token in target)
    if len(set(source_words)) != len(source_words) or len(set(target_words)) != len(target_words):
        return invalid
    if not (len(source) <= 4 and 2 <= len(target) <= 3 and abs(len(source) - len(target)) == 1):
        return invalid
    orthographic = "".join(source_words) == "".join(target_words)
    if contracting:
        aligned = _one_merge_alignment(source, target, orthographic=orthographic)
    else:
        aligned = orthographic and _one_merge_alignment(target, source, orthographic=True)
    if not aligned:
        return invalid
    if not any(owner != patch.segment for owner in context.phrase_owners.get(target_words, ())):
        return "insufficient_context_evidence"
    return None


def _local_rejection(
    patch: _v6._ResolvedEdit, segments: tuple[ReconciledSegment, ...], context: _OriginalContext,
    minimum: float, maximum: float,
) -> str | None:
    legacy_reason = _v6._local_rejection(patch, segments, context.tokens, context.words,
                                         context.legacy_index, minimum, maximum)
    if legacy_reason not in _RECONSIDERABLE:
        return legacy_reason
    edit = patch.candidate
    source, target = _tokens(edit.source), _tokens(edit.replacement)
    reason = _safety_rejection(patch, segments, context, source, target)
    if reason is not None:
        return reason
    if not source or not target or len(source) > 4 or len(target) > 3:
        return legacy_reason
    if not _punctuation_preserved(edit, source, target):
        return "unsupported_phrase_alignment"
    if len(source) == len(target):
        if len(source) == 1:
            if not (_syllable_similar(source[0].value, target[0].value)
                    or _loanword_similar(source[0].value, target[0].value)):
                return "insufficient_lexical_similarity"
        elif not _phrase_similar(source, target):
            return "unsupported_phrase_alignment"
    else:
        reason = _boundary_rejection(patch, source, target, context, legacy_reason)
        if reason is not None:
            return reason
    a, b = _v6._character_count(edit.source), _v6._character_count(edit.replacement)
    if not _v6._length_is_safe(_v6._global_words(edit.source), _v6._global_words(edit.replacement),
                              a, b, minimum, maximum):
        return "unsafe_expansion" if b > a else "unsafe_length_change"
    return None


def _apply(
    reconciliation: TranscriptReconciliation, proposal: V6CorrectionProposal, minimum: float, maximum: float,
    *, local_rejection=None,
) -> V6EditResult:
    _v6._require(type(minimum) in (int, float) and math.isfinite(minimum) and 0 < minimum <= 1
                 and type(maximum) in (int, float) and math.isfinite(maximum) and maximum >= 1,
                 CorrectionErrorCategory.VALIDATION, V6FailureReason.INVALID_LIMITS)
    segments = _original_segments(reconciliation)
    _v6._require(type(proposal) is V6CorrectionProposal,
                 CorrectionErrorCategory.VALIDATION, V6FailureReason.INVALID_PROPOSAL)
    edits = _checked_candidates(proposal.edits, segments)
    _begin_edit_review(proposal)
    resolved, rejected = _resolve(segments, edits)
    _global_integrity(segments, _patched_texts(segments, resolved), minimum, maximum, final=False)
    accepted = []
    if resolved:
        context = _make_context(segments, edits)
        for patch in resolved:
            reason = (local_rejection or _local_rejection)(patch, segments, context, minimum, maximum)
            if reason is None:
                accepted.append(patch)
            else:
                rejected[patch.index] = reason
    texts = _patched_texts(segments, accepted)
    _global_integrity(segments, texts, minimum, maximum, final=True)
    _finish_edit_review(len(edits), rejected)
    return V6EditResult(texts, len(edits), len(accepted), len(rejected),
                        len({edits[index].segment_id for index in rejected}), Counter(rejected.values()))


def apply_v61_edits(
    reconciliation: TranscriptReconciliation, proposal: V6CorrectionProposal, *,
    min_text_ratio: float = 0.65, max_text_ratio: float = 1.5,
) -> V6EditResult:
    """Validate explicit original-anchored edits, with sanitized V6 failure semantics.

    V6-accepted local edits remain eligible. Newly eligible patches have bounded
    lexical/phonetic evidence, never a claim of semantic or acoustic correctness.
    All evidence comes from the immutable original reconciliation. Global or
    structural failures raise V6ValidationError; no partial result escapes.
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
