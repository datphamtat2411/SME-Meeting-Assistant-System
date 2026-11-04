"""Pure segment-level attribution; raw simultaneous turns are never changed."""

from collections import defaultdict
from collections.abc import Iterable

from .models import SpeakerAssignment, SpeakerTurn, TimedTranscriptSegment


def align_speakers(
    transcript_segments: Iterable[TimedTranscriptSegment],
    diarization_turns: Iterable[SpeakerTurn],
) -> tuple[SpeakerAssignment, ...]:
    turns = tuple(diarization_turns)
    assignments = []
    for segment in transcript_segments:
        overlaps: dict[str, int] = defaultdict(int)
        for turn in turns:
            duration = min(segment.end_ms, turn.end_ms) - max(segment.start_ms, turn.start_ms)
            if duration > 0:
                overlaps[turn.speaker_label] += duration
        highest = max(overlaps.values(), default=0)
        winners = [label for label, duration in overlaps.items() if duration == highest]
        assignments.append(SpeakerAssignment(segment.ordinal, winners[0] if len(winners) == 1 else None))
    return tuple(assignments)
