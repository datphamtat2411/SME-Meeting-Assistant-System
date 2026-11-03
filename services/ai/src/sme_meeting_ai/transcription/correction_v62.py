"""Experimental, legacy-first bounded phrase policy; explicitly selected as V6.2.

V6.1 acceptance remains authoritative. New paths re-run its protected-content,
neighbor and punctuation gates and the same local length/whole-meeting integrity
checks. There is no ASR-error replacement table or additional LLM call. The
context-priority path uses an explicit, closed injury cue/collocation inventory.

New eligibility:
* Up to four aligned tokens and two non-accent lexical changes, each independently
  near-phonetic. One inserted/deleted vowel also qualifies when onset/coda remain
  exact and the shorter vowel sequence is preserved (two to four Latin letters).
* One adjacent merge within three/four source and two/three target tokens. Every
  other token is an unchanged anchor. No independent exact second occurrence is
  needed for a literal merge, or loss of at most two epenthetic vowels/duplicate
  letters with consonants, two-letter edges and bounded distance preserved.
* A distorted syllable pair may merge if the originals differ in tone but share
  their lexical key, and the target differs from BOTH literal originals while
  independently matching each. Exact repetitions and simple word deletion fail.
* Strong ORIGINAL injury context can outweigh one distorted component in a short
  anatomical collocation. The injury action stays anchored; two distinct evidence
  families outside the candidate (including a nearby cue) are required. Existing
  anatomy, protected speech and unsupported new qualifiers cannot be rewritten.

This is bounded contextual plausibility, not universal semantics or acoustic
proof. Contextual admissions remain review-bearing, even when no edits were
rejected. Production selection stays separate and private review records the
actual basis and original evidence segment identities.
"""

import traceback
from dataclasses import dataclass

from . import correction_v6 as _v6
from . import correction_v61 as _v61
from .correction import CorrectionErrorCategory
from .correction_edit_review import _mark_context_acceptance
from .correction_v6 import (
    V6CorrectionProposal,
    V6EditResult,
    V6FailureReason,
    V6ValidationError,
    V6ValidationFailure,
)
from .correction_v62_context import _build_injury_context, _injury_repair_evidence
from .reconciliation import TranscriptReconciliation

V62_ENGINE_VERSION = "vi-context-validation-6.2.1"
_RECONSIDERABLE = frozenset((
    "unsupported_lexical_change", "unsupported_phrase_alignment", "insufficient_lexical_similarity",
    "insufficient_context_evidence", "unsafe_phrase_contraction",
))


@dataclass(frozen=True, slots=True)
class _V62EditResult(V6EditResult):
    contextual_edit_count: int = 0

    def __post_init__(self):
        V6EditResult.__post_init__(self)
        if type(self.contextual_edit_count) is not int or not 0 <= self.contextual_edit_count <= self.accepted_edit_count:
            raise ValueError("Invalid contextual edit count")


def _near_token(source: str, target: str) -> bool:
    if _v61._syllable_similar(source, target) or _v61._loanword_similar(source, target):
        return True
    a, b = _v61._latin_key(source), _v61._latin_key(target)
    if a is None or b is None or not 2 <= min(len(a), len(b)) < max(len(a), len(b)) <= 4:
        return False
    first, second = _v61._syllable_parts(a), _v61._syllable_parts(b)
    if first is None or second is None or not first[0] or first[0] != second[0]:
        return False
    # With the same onset, only one vowel may appear/disappear; coda stays exact.
    rhyme_a, rhyme_b = first[1], second[1]
    vowels_a = "".join(c for c in rhyme_a if c in _v61._VOWELS)
    vowels_b = "".join(c for c in rhyme_b if c in _v61._VOWELS)
    return (rhyme_a[len(vowels_a):] == rhyme_b[len(vowels_b):]
            and abs(len(vowels_a) - len(vowels_b)) == 1
            and _v61._bounded_distance(vowels_a, vowels_b, 1) == 1)


def _merge_supported(left: str, right: str, target: str) -> bool:
    a, b, merged = (_v61._latin_key(value) for value in (left, right, target))
    if a is None or b is None or merged is None or min(len(a), len(b)) < 2 or len(a + b) > 18:
        return False
    if _v6._fold(left) == _v6._fold(right):
        return False  # Genuine exact repetition must not disappear.
    if _v6._fold(left + right) == _v6._fold(target):
        return True
    if (a == b and _v6._fold(target) not in (_v6._fold(left), _v6._fold(right))
            and _v61._syllable_similar(left, target) and _v61._syllable_similar(right, target)):
        return True
    joined = a + b
    def consonants(value):
        return "".join(c for c in value if c not in _v61._VOWELS)

    return (len(merged) >= 5 and 1 <= len(joined) - len(merged) <= 2
            and joined[:2] == merged[:2] and joined[-2:] == merged[-2:]
            and consonants(joined) == consonants(merged)
            and _v61._bounded_distance(joined, merged, 2) <= 2)


def _anchored_merge(source, target) -> bool:
    if not (3 <= len(source) <= 4 and len(target) == len(source) - 1):
        return False
    for index in range(len(target)):
        if (all(_v6._fold(a.value) == _v6._fold(b.value)
                for a, b in zip(source[:index], target[:index], strict=True))
                and all(_v6._fold(a.value) == _v6._fold(b.value)
                        for a, b in zip(source[index + 2:], target[index + 1:], strict=True))
                and _merge_supported(source[index].value, source[index + 1].value, target[index].value)):
            return True
    return False


def _local_rejection(patch, segments, context, minimum, maximum):
    reason = _v61._local_rejection(patch, segments, context, minimum, maximum)
    if reason not in _RECONSIDERABLE:
        return reason
    edit = patch.candidate
    source, target = _v6._tokens(edit.source), _v6._tokens(edit.replacement)
    if not source or not target or max(len(source), len(target)) > 4:
        return reason
    if (protected := _v61._safety_rejection(patch, segments, context, source, target)) is not None:
        return protected
    if not _v61._punctuation_preserved(edit, source, target):
        return reason
    if len(source) == len(target):
        changes = [(a.value, b.value) for a, b in zip(source, target, strict=True)
                   if _v6._lexical_key(a.value) != _v6._lexical_key(b.value)]
        supported = len(changes) <= 2 and all(_near_token(a, b) for a, b in changes)
    else:
        supported = _anchored_merge(source, target)
    if not supported:
        return reason
    if not _v6._length_is_safe(_v6._global_words(edit.source), _v6._global_words(edit.replacement),
                               _v6._character_count(edit.source), _v6._character_count(edit.replacement), minimum, maximum):
        return "unsafe_expansion" if len(edit.replacement) > len(edit.source) else "unsafe_length_change"
    return None


def _apply_with_context(reconciliation, proposal, minimum, maximum):
    injury_context = None
    contextual = set()

    def decide(patch, segments, context, lower, upper):
        nonlocal injury_context
        reason = _local_rejection(patch, segments, context, lower, upper)
        if reason not in _RECONSIDERABLE:
            return reason
        edit = patch.candidate
        source, target = _v6._tokens(edit.source), _v6._tokens(edit.replacement)
        if not source or not target or max(len(source), len(target)) > 4:
            return reason
        if (protected := _v61._safety_rejection(patch, segments, context, source, target)) is not None:
            return protected
        if not _v61._punctuation_preserved(edit, source, target):
            return reason
        if injury_context is None:
            injury_context = _build_injury_context(context, segments)
        evidence = _injury_repair_evidence(patch, segments, context, injury_context, _near_token)
        if not evidence or not _v6._length_is_safe(
            _v6._global_words(edit.source), _v6._global_words(edit.replacement),
            _v6._character_count(edit.source), _v6._character_count(edit.replacement), lower, upper,
        ):
            return reason
        contextual.add(patch.index)
        _mark_context_acceptance(patch.index, tuple(segments[owner].segment_id for owner in evidence))
        return None

    result = _v61._apply(reconciliation, proposal, minimum, maximum, local_rejection=decide)
    return _V62EditResult(result.texts, result.proposed_edit_count, result.accepted_edit_count,
                          result.rejected_edit_count, result.rejected_segment_count, result.rejection_reason_counts,
                          len(contextual))


def apply_v62_edits(
    reconciliation: TranscriptReconciliation, proposal: V6CorrectionProposal, *,
    min_text_ratio: float = 0.65, max_text_ratio: float = 1.5,
) -> V6EditResult:
    """Use the same sparse contracts/global gates with the explicit new local policy."""
    failure = V6ValidationFailure(CorrectionErrorCategory.VALIDATION, V6FailureReason.INVALID_PROPOSAL)
    try:
        return _apply_with_context(reconciliation, proposal, min_text_ratio, max_text_ratio)
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
