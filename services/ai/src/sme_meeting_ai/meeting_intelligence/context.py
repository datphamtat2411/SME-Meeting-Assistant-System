"""Deterministic complete-source planning, not feature-specific synthesis."""

import json
from dataclasses import asdict, dataclass, field
from threading import Event

from sme_meeting_ai.core.config import Settings

from .contracts import (
    TaskSpec,
    canonical_json,
    digest,
    estimate_input_tokens,
    payload_for,
)
from .errors import IntelligenceError, check_authority, require
from .evidence import EvidenceSource, EvidenceUnit, SourceIdentity

PLANNING_VERSION = "evidence-context-v1"


@dataclass(frozen=True)
class ContextLimits:
    context_window_tokens: int
    max_input_tokens: int
    max_output_tokens: int
    overlap_units: int
    max_windows: int
    max_total_context_tokens: int
    max_source_bytes: int
    max_evidence_units: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "ContextLimits":
        return cls(**{key: getattr(settings, f"meeting_intelligence_{key}") for key in cls.__dataclass_fields__})

    @property
    def sha256(self):
        return digest(asdict(self))


@dataclass(frozen=True)
class ContextWindow:
    window_id: str
    index: int
    source: SourceIdentity
    planning_version: str
    task_sha256: str
    configuration_sha256: str
    units: tuple[EvidenceUnit, ...] = field(repr=False)
    segment_ids: tuple[str, ...]
    estimated_input_tokens: int
    contains_entire_source: bool
    evidence_json: str = field(repr=False)

    def references(self) -> list[dict]:
        return [{"segment_id": u.segment_id, "ordinal": u.ordinal,
                 "char_start": u.char_start, "char_end": u.char_end} for u in self.units]


@dataclass(frozen=True)
class ContextPlan:
    source: EvidenceSource = field(repr=False)
    windows: tuple[ContextWindow, ...] = field(repr=False)
    planning_version: str
    configuration_sha256: str
    task_sha256: str
    model: str
    complete: bool
    total_estimated_input_tokens: int

    def to_json(self) -> str:
        """Sensitive local plan/provenance; never an observability log payload."""
        return canonical_json({**self.source.provenance(), "planning_version": self.planning_version,
            "configuration_sha256": self.configuration_sha256, "task_sha256": self.task_sha256,
            "model": self.model, "complete_source_coverage": self.complete,
            "total_estimated_input_tokens": self.total_estimated_input_tokens,
            "windows": [{"window_id": w.window_id, "index": w.index,
                "contains_entire_source": w.contains_entire_source, "references": w.references(),
                "estimated_input_tokens": w.estimated_input_tokens} for w in self.windows]})


class _Planner:
    def __init__(self, source, task, limits, model, deadline, cancelled):
        self.source, self.task, self.limits, self.model = source, task, limits, model
        self.deadline, self.cancelled = deadline, cancelled
        self.configuration_sha256 = digest({"limits": asdict(limits), "model": model,
                                            "planning_version": PLANNING_VERSION})
        header = json.loads(source.metadata_json)
        self.header = {k: header.get(k) for k in ("languageCode", "status", "durationMs")}
        self.speaker_index = {s.cluster_id: s for s in source.speakers}

    def check(self):
        check_authority(self.deadline, self.cancelled)

    def window(self, units, index):
        self.check()
        boundaries = [(u.segment_id, u.char_start, u.char_end) for u in units]
        window_id = "window-" + digest([asdict(self.source.identity), PLANNING_VERSION,
            self.configuration_sha256, self.task.sha256, index, boundaries])[:32]
        complete = (len(units) == len(self.source.segments)
                    and all(u.segment_id == s.segment_id and u.char_start == 0 and u.char_end == len(s.text)
                            for u, s in zip(units, self.source.segments)))
        starts = [u.start_ms for u in units if u.start_ms is not None]
        ends = [u.end_ms for u in units if u.end_ms is not None]
        timing_known = all(u.start_ms is not None and u.end_ms is not None for u in units)
        coverage = []
        for region in self.source.coverage:
            self.check()
            if not timing_known or (region.start_ms < max(ends) and region.end_ms > min(starts)):
                coverage.append(asdict(region))
        clusters = dict.fromkeys(u.speaker_cluster_id for u in units if u.speaker_cluster_id is not None)
        speakers = [{"cluster_id": key, "label": self.speaker_index[key].label,
                     "anonymous": self.speaker_index[key].user_id is None} for key in clusters]
        content = canonical_json({
            "data_classification": "untrusted_transcript_evidence", "source": asdict(self.source.identity),
            "planning_version": PLANNING_VERSION, "window_id": window_id, "window_index": index,
            "contains_entire_source": complete, "source_evidence_coverage": "complete_in_plan",
            "transcript_metadata": self.header, "source_quality_flags": self.source.quality_flags,
            "source_has_usable_evidence": self.source.has_usable_evidence,
            "source_coverage_region_count": len(self.source.coverage), "relevant_coverage": coverage,
            "speakers": speakers, "evidence": [u.to_dict() for u in units],
            "offset_convention": "half-open Unicode code points; timing belongs to original segment",
        })
        estimated = estimate_input_tokens(payload_for(self.model, self.task, content, self.limits.max_output_tokens))
        return ContextWindow(window_id, index, self.source.identity, PLANNING_VERSION,
            self.task.sha256, self.configuration_sha256, tuple(units), tuple(dict.fromkeys(u.segment_id for u in units)),
            estimated, complete, content)

    def units(self):
        count = 0
        for segment in self.source.segments:
            self.check()
            whole = self.source.resolve(segment.segment_id)
            if (len(segment.text) <= self.limits.max_input_tokens
                    and self.window([whole], self.limits.max_windows).estimated_input_tokens <= self.limits.max_input_tokens):
                count += 1
                require(count <= self.limits.max_evidence_units, "CONTEXT_BUDGET")
                yield whole
                continue
            require(bool(segment.text), "CONTEXT_BUDGET")
            cursor = 0
            while cursor < len(segment.text):
                self.check()
                # A code point consumes at least one encoded byte. This upper bound
                # avoids repeated whole-segment copies in the binary search.
                low, high, best = cursor + 1, min(len(segment.text), cursor + self.limits.max_input_tokens), None
                while low <= high:
                    self.check()
                    middle = (low + high) // 2
                    unit = self.source.resolve(segment.segment_id, cursor, middle)
                    if self.window([unit], self.limits.max_windows).estimated_input_tokens <= self.limits.max_input_tokens:
                        best, low = unit, middle + 1
                    else:
                        high = middle - 1
                require(best is not None, "CONTEXT_BUDGET")
                count += 1
                require(count <= self.limits.max_evidence_units, "CONTEXT_BUDGET")
                yield best
                cursor = best.char_end

    def plan(self):
        windows, pending, total, new_count = [], [], 0, 0

        def emit():
            nonlocal total
            self.check()
            require(len(windows) < self.limits.max_windows, "CONTEXT_BUDGET")
            window = self.window(pending, len(windows))
            require(window.estimated_input_tokens <= self.limits.max_input_tokens, "CONTEXT_BUDGET")
            total += window.estimated_input_tokens
            require(total <= self.limits.max_total_context_tokens, "CONTEXT_BUDGET")
            windows.append(window)

        for unit in self.units():
            self.check()
            if pending and self.window([*pending, unit], len(windows)).estimated_input_tokens > self.limits.max_input_tokens:
                if new_count:
                    emit()
                    pending = pending[-self.limits.overlap_units:] if self.limits.overlap_units else []
                # Overlap is best effort, never displaces new evidence or stalls progress.
                while pending and self.window([*pending, unit], len(windows)).estimated_input_tokens > self.limits.max_input_tokens:
                    pending.pop(0)
                new_count = 0
            pending.append(unit)
            new_count += 1
        if new_count:
            emit()
        self.check()
        return ContextPlan(self.source, tuple(windows), PLANNING_VERSION, self.configuration_sha256,
                           self.task.sha256, self.model, True, total)


def plan_context(source: EvidenceSource, task: TaskSpec, limits: ContextLimits, model: str,
                 deadline: float, cancelled: Event) -> ContextPlan:
    category = "CONFIGURATION"
    try:
        require(limits.max_input_tokens + limits.max_output_tokens <= limits.context_window_tokens, "CONFIGURATION")
        return _Planner(source, task, limits, model, deadline, cancelled).plan()
    except IntelligenceError as error:
        category = error.category
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError, OverflowError):
        pass
    except MemoryError:
        category = "RESOURCE"
    raise IntelligenceError(category)
