"""Pure segment-level attribution; raw simultaneous turns are never changed."""

from collections import defaultdict
from collections.abc import Iterable
from fractions import Fraction
from numbers import Number

from .models import SpeakerAssignment, SpeakerTurn, TimedTranscriptSegment


def _ratio(value: float, name: str) -> Fraction:
    if isinstance(value, bool) or not isinstance(value, Number) or isinstance(value, complex):
        raise TypeError(f"{name} must be a finite numeric ratio")
    try:
        ratio = Fraction(str(value))
    except (ValueError, ZeroDivisionError) as exc:
        raise ValueError(f"{name} must be a finite numeric ratio") from exc
    if not 0 <= ratio <= 1:
        raise ValueError(f"{name} must be between 0 and 1")
    return ratio


def align_speakers(
    transcript_segments: Iterable[TimedTranscriptSegment],
    diarization_turns: Iterable[SpeakerTurn],
    *,
    min_coverage_ratio: float = 0.50,
    min_dominance_margin_ratio: float = 0.15,
) -> tuple[SpeakerAssignment, ...]:
    """Attribute segments only when unique speaker coverage meets both thresholds."""
    coverage_threshold = _ratio(min_coverage_ratio, "min_coverage_ratio")
    margin_threshold = _ratio(min_dominance_margin_ratio, "min_dominance_margin_ratio")
    turns = tuple(diarization_turns)
    assignments = []
    for segment in transcript_segments:
        intervals: dict[str, list[tuple[int, int]]] = defaultdict(list)
        for turn in turns:
            start = max(segment.start_ms, turn.start_ms)
            end = min(segment.end_ms, turn.end_ms)
            if start < end:
                intervals[turn.speaker_label].append((start, end))

        overlaps = {}
        for label, speaker_intervals in intervals.items():
            ordered = sorted(speaker_intervals)
            start, end = ordered[0]
            coverage = 0
            for next_start, next_end in ordered[1:]:
                if next_start <= end:
                    end = max(end, next_end)
                else:
                    coverage += end - start
                    start, end = next_start, next_end
            overlaps[label] = coverage + end - start

        ranked = sorted(overlaps.values(), reverse=True)
        winner = None
        duration = segment.end_ms - segment.start_ms
        if duration > 0 and ranked:
            highest = ranked[0]
            runner_up = ranked[1] if len(ranked) > 1 else 0
            if (highest > runner_up
                    and highest >= coverage_threshold * duration
                    and highest - runner_up >= margin_threshold * duration):
                winner = next(label for label, coverage in overlaps.items() if coverage == highest)
        assignments.append(SpeakerAssignment(segment.ordinal, winner))
    return tuple(assignments)
