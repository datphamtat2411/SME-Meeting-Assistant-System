"""Explicit opt-in composition for injected T02 processors; no registration."""

from dataclasses import asdict, dataclass, field
from threading import Event

from sme_meeting_ai.core.config import Settings

from .context import ContextLimits, ContextPlan, plan_context
from .contracts import (
    ModelAdapter,
    ModelRequest,
    ModelResult,
    TaskSpec,
    digest,
    estimate_input_tokens,
    identifier,
    payload_for,
)
from .errors import check_authority, require
from .evidence import normalize_evidence
from .processor import StageContext


@dataclass(frozen=True)
class PreparedContext:
    plan: ContextPlan = field(repr=False)
    task: TaskSpec = field(repr=False)
    model: str
    limits: ContextLimits
    deadline: float
    cancelled: Event = field(repr=False)

    def request(self, window_index: int) -> ModelRequest:
        check_authority(self.deadline, self.cancelled)
        require(type(window_index) is int and 0 <= window_index < len(self.plan.windows), "INVALID_REFERENCE")
        return ModelRequest(self.model, self.task, self.plan.windows[window_index], self.limits.max_input_tokens,
                            self.limits.max_output_tokens, self.deadline, self.cancelled)

    def execute(self, adapter: ModelAdapter, window_index: int) -> ModelResult:
        result = adapter.complete(self.request(window_index))
        check_authority(self.deadline, self.cancelled)
        return result

    def derived_request(self, task: TaskSpec, evidence_json: str, level: str) -> ModelRequest:
        """Build a source-bound request for feature-owned derived evidence.

        The derived context deliberately has no transcript units or fabricated
        segment mappings. It carries the original source identity only; the
        feature must preserve canonical references inside ``evidence_json``.
        """
        check_authority(self.deadline, self.cancelled)
        require(isinstance(task, TaskSpec) and isinstance(evidence_json, str)
                and identifier(level), "CONFIGURATION")
        estimated = estimate_input_tokens(
            payload_for(self.model, task, evidence_json, self.limits.max_output_tokens)
        )
        require(estimated <= self.limits.max_input_tokens, "CONTEXT_BUDGET")
        derived = DerivedEvidenceContext(
            source=self.plan.source.identity,
            window_id="derived-" + digest([asdict(self.plan.source.identity), task.sha256, level, evidence_json])[:32],
            planning_version=self.plan.planning_version,
            task_sha256=task.sha256,
            configuration_sha256=self.plan.configuration_sha256,
            estimated_input_tokens=estimated,
            evidence_json=evidence_json,
        )
        return ModelRequest(self.model, task, derived, self.limits.max_input_tokens,
                            self.limits.max_output_tokens, self.deadline, self.cancelled)

    def execute_derived(self, adapter: ModelAdapter, task: TaskSpec,
                        evidence_json: str, level: str) -> ModelResult:
        result = adapter.complete(self.derived_request(task, evidence_json, level))
        check_authority(self.deadline, self.cancelled)
        return result


@dataclass(frozen=True)
class DerivedEvidenceContext:
    """Model input provenance for feature-owned evidence, not a source window."""

    source: object = field(repr=False)
    window_id: str
    planning_version: str
    task_sha256: str
    configuration_sha256: str
    estimated_input_tokens: int
    evidence_json: str = field(repr=False)
    units: tuple = field(default=(), repr=False)
    segment_ids: tuple[str, ...] = ()
    contains_entire_source: bool = False


def prepare_context(context: StageContext, task: TaskSpec, settings: Settings) -> PreparedContext:
    limits = ContextLimits.from_settings(settings)
    source = normalize_evidence(context, limits)
    plan = plan_context(source, task, limits, settings.meeting_intelligence_model, context.deadline, context.cancelled)
    return PreparedContext(plan, task, settings.meeting_intelligence_model, limits, context.deadline, context.cancelled)
