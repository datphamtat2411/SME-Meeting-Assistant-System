"""Explicit opt-in composition for injected T02 processors; no registration."""

from dataclasses import dataclass, field
from threading import Event

from sme_meeting_ai.core.config import Settings

from .context import ContextLimits, ContextPlan, plan_context
from .contracts import ModelAdapter, ModelRequest, ModelResult, TaskSpec
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


def prepare_context(context: StageContext, task: TaskSpec, settings: Settings) -> PreparedContext:
    limits = ContextLimits.from_settings(settings)
    source = normalize_evidence(context, limits)
    plan = plan_context(source, task, limits, settings.meeting_intelligence_model, context.deadline, context.cancelled)
    return PreparedContext(plan, task, settings.meeting_intelligence_model, limits, context.deadline, context.cancelled)
