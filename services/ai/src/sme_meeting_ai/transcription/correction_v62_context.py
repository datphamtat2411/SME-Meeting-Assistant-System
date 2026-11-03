"""Narrow original-evidence injury semantics for the explicit V6.2 experiment.

This is a closed medical collocation/cue inventory, NOT an ASR-error replacement
dictionary or universal semantic classifier. LLM generation still selects the
candidate. Two distinct original injury-evidence families (at least one physical
injury family), a nearby cue, a preserved injury-action anchor and bounded lexical
remnants permit ONE weak component. Topic words alone cannot license a rewrite.

Index the original meeting once. Retain only first/last cue per family/segment,
and at most two distinct segment owners per global family. Those witnesses suffice
to exclude one contiguous candidate span without an edits-times-meeting scan.
New qualifiers, existing anatomy substitutions and literal repetition are excluded.
Contextual admission is review-bearing plausibility, never acoustic/medical proof.
"""

from dataclasses import dataclass, field

from . import correction_v6 as _v6
from . import correction_v61 as _v61

_CUES = {
    ("trật", "tay"): "joint", ("trật", "chân"): "joint", ("trật", "khớp"): "joint",
    ("bong", "gân"): "joint", ("gãy", "xương"): "fracture",
    ("rách", "cơ"): "tissue", ("đứt", "gân"): "tissue", ("vết", "thương"): "tissue",
    ("trầy", "xước"): "tissue", ("va", "chạm"): "impact", ("tai", "nạn"): "impact",
    ("chấn", "thương"): "impact", ("bệnh", "viện"): "care", ("bác", "sĩ"): "care",
}
_PHYSICAL_FAMILIES = frozenset(("joint", "fracture", "tissue"))
_OBJECTS = {
    "đứt": frozenset((("gân",), ("cơ",), ("dây", "chằng"))),
    "rách": frozenset((("gân",), ("cơ",), ("sụn",), ("dây", "chằng"))),
    "gãy": frozenset((("xương",),)), "trật": frozenset((("khớp",),)),
}
_ANATOMY = frozenset("tay chân đầu mắt mũi miệng tim gan phổi thận não da xương gân cơ khớp sụn mạch".split())


@dataclass(frozen=True, slots=True)
class _Cue:
    owner: int
    start: int
    end: int
    family: str

    def outside(self, patch) -> bool:
        return self.owner != patch.segment or self.end <= patch.start or self.start >= patch.end


@dataclass(frozen=True, slots=True)
class _InjuryContext:
    by_segment: tuple[dict[str, tuple[_Cue, ...]], ...] = field(repr=False)
    by_family: dict[str, tuple[_Cue, ...]] = field(repr=False)

    def evidence(self, patch) -> tuple[int, ...]:
        witnesses = []
        for family, owners in self.by_family.items():
            cue = next((cue for cue in owners if cue.owner != patch.segment), None)
            if cue is None:
                cue = next((cue for cue in self.by_segment[patch.segment].get(family, ()) if cue.outside(patch)), None)
            if cue is not None:
                witnesses.append(cue)
        families = {cue.family for cue in witnesses}
        if len(families) < 2 or not families.intersection(_PHYSICAL_FAMILIES):
            return ()
        nearby = next((cue for owner in range(max(0, patch.segment - 1), min(len(self.by_segment), patch.segment + 2))
                       for cues in self.by_segment[owner].values() for cue in cues if cue.outside(patch)), None)
        if nearby is None:
            return ()
        return tuple(sorted({nearby.owner, *(cue.owner for cue in witnesses)}))


def _build_injury_context(context: _v61._OriginalContext, originals) -> _InjuryContext:
    segments, families = [], {}
    for owner, (tokens, words) in enumerate(zip(context.tokens, context.words, strict=True)):
        observed = {}
        for start in range(len(words) - 1):
            family = _CUES.get(words[start:start + 2])
            if family is not None and _v61._plain_gap(originals[owner].text[tokens[start].end:tokens[start + 1].start]):
                cue = _Cue(owner, tokens[start].start, tokens[start + 1].end, family)
                observed[family] = (observed[family][0], cue) if family in observed else (cue,)
        segments.append(observed)
        for family, cues in observed.items():
            owners = families.setdefault(family, [])
            if len(owners) < 2:
                owners.append(cues[0])
    return _InjuryContext(tuple(segments), {family: tuple(owners) for family, owners in families.items()})


def _injury_repair_evidence(patch, segments, context, injury: _InjuryContext, near_token) -> tuple[int, ...]:
    source, target = _v6._tokens(patch.candidate.source), _v6._tokens(patch.candidate.replacement)
    if not (2 <= len(source) <= 4 and 1 <= len(target) <= 4 and 0 <= len(source) - len(target) <= 1):
        return ()
    a = tuple(_v6._fold(token.value) for token in source)
    b = tuple(_v6._fold(token.value) for token in target)
    if a[0] in _OBJECTS and b[0] == a[0]:
        anchor, a, b = a[0], a[1:], b[1:]
    else:
        before = next((token for token in reversed(context.tokens[patch.segment]) if token.end <= patch.start), None)
        # Whitespace only: punctuation cannot transfer the action to a new clause.
        if before is None or not _v61._plain_gap(segments[patch.segment].text[before.end:patch.start]):
            return ()
        anchor = _v6._fold(before.value)
    if (not a or not b or b not in _OBJECTS.get(anchor, ()) or len(set(a)) != len(a)
            or any(word in _ANATOMY for word in a)
            or any(_v61._latin_key(word) is None for word in (*a, *b))):
        return ()
    # The whole proposed object must not already be intact: do not drop a genuine
    # neighboring word merely to retain an already recognized anatomical noun.
    if any(a[start:start + len(b)] == b for start in range(len(a))):
        return ()
    if (sum(not any(near_token(word, other) for other in b) for word in a) > 1
            or sum(not any(near_token(word, other) for other in a) for word in b) > 1
            or not any(near_token(word, other) for word in a for other in b)):
        return ()
    return injury.evidence(patch)
