"""Explicit opt-in composition for injected T02 processors; no registration."""

from dataclasses import asdict, dataclass, field, replace
from threading import Event
from typing import Callable

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
    reasoning_effort: str
    limits: ContextLimits
    deadline: float
    cancelled: Event = field(repr=False)
    budget: "InferenceBudget" = field(repr=False)
    provider_attempts: object | None = field(default=None, repr=False)

    def request(self, window_index: int) -> ModelRequest:
        check_authority(self.deadline, self.cancelled)
        require(type(window_index) is int and 0 <= window_index < len(self.plan.windows), "INVALID_REFERENCE")
        return ModelRequest(self.model, self.reasoning_effort, self.task, self.plan.windows[window_index],
                            self.limits.max_input_tokens, self.limits.max_output_tokens,
                            self.deadline, self.cancelled, self.provider_attempts)

    def execute(self, adapter: ModelAdapter, window_index: int) -> ModelResult:
        return self.execute_request(adapter, self.request(window_index))

    def execute_request(self, adapter: ModelAdapter, request: ModelRequest) -> ModelResult:
        self.budget.begin(request)
        self.budget.reserve(request)
        result = adapter.complete(replace(request, retry_budget=self.budget))
        check_authority(self.deadline, self.cancelled)
        return result

    def plan_extraction(self, maximum_calls: int, follow_up: TaskSpec | None = None) -> None:
        self.plan_requests((self.request(w.index) for w in self.plan.windows), maximum_calls, follow_up)

    def plan_requests(self, requests, maximum_calls: int, follow_up: TaskSpec | None = None) -> None:
        work = tuple(CallCapacity.for_request(request) for request in requests)
        # The exact derived input is unavailable until the preceding model
        # responds. Hold one call, its output ceiling, and fixed prompt/schema
        # overhead now. Replace that floor with actual requests before spending.
        tail = CallCapacity()
        if follow_up is not None:
            tail = CallCapacity(1, estimate_input_tokens(payload_for(
                self.model, self.reasoning_effort, follow_up, "", self.limits.max_output_tokens,
            )), self.limits.max_output_tokens)
        require(len(work) + tail.calls <= maximum_calls, "CONTEXT_BUDGET")
        self.budget.plan(work, tail)

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
            payload_for(self.model, self.reasoning_effort, task, evidence_json, self.limits.max_output_tokens)
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
        return ModelRequest(self.model, self.reasoning_effort, task, derived, self.limits.max_input_tokens,
                            self.limits.max_output_tokens, self.deadline, self.cancelled,
                            self.provider_attempts)

    def execute_derived(self, adapter: ModelAdapter, task: TaskSpec,
                        evidence_json: str, level: str) -> ModelResult:
        request = self.derived_request(task, evidence_json, level)
        return self.execute_request(adapter, request)


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


@dataclass(frozen=True)
class CallCapacity:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0

    @classmethod
    def for_request(cls, request: ModelRequest) -> "CallCapacity":
        return cls(1, request.window.estimated_input_tokens, request.output_budget)

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def __add__(self, other: "CallCapacity") -> "CallCapacity":
        return CallCapacity(self.calls + other.calls, self.input_tokens + other.input_tokens,
                            self.output_tokens + other.output_tokens)


@dataclass
class InferenceBudget:
    """Reserve estimated input plus the full visible/reasoning completion ceiling."""

    maximum_tokens: int
    reserved_tokens: int = 0
    check_execution: Callable[[CallCapacity], None] | None = field(default=None, repr=False)
    _requests: tuple[CallCapacity, ...] = field(default=(), init=False, repr=False)
    _follow_up: CallCapacity = field(default_factory=CallCapacity, init=False, repr=False)

    @property
    def pending_work(self) -> CallCapacity:
        return sum(self._requests, self._follow_up)

    def _check(self, needed: CallCapacity) -> None:
        require(self.reserved_tokens + needed.tokens <= self.maximum_tokens, "CONTEXT_BUDGET")
        if self.check_execution is not None:
            self.check_execution(needed)

    def plan(self, requests: tuple[CallCapacity, ...], follow_up: CallCapacity = CallCapacity()) -> None:
        self._check(sum(requests, follow_up))
        self._requests, self._follow_up = requests, follow_up

    def begin(self, request: ModelRequest) -> None:
        if self._requests:
            require(CallCapacity.for_request(request) == self._requests[0], "CONFIGURATION")
            self._requests = self._requests[1:]

    def reserve(self, request: ModelRequest) -> int:
        work = CallCapacity.for_request(request)
        require(type(work.tokens) is int and work.tokens > 0, "CONTEXT_BUDGET")
        self._check(work + self.pending_work)
        self.reserved_tokens += work.tokens
        return work.tokens


def prepare_context(context: StageContext, task: TaskSpec, settings: Settings) -> PreparedContext:
    limits = ContextLimits.from_settings(settings)
    source = normalize_evidence(context, limits)
    plan = plan_context(source, task, limits, settings.meeting_intelligence_model,
                        settings.meeting_intelligence_reasoning_effort,
                        context.deadline, context.cancelled)
    return PreparedContext(plan, task, settings.meeting_intelligence_model,
                           settings.meeting_intelligence_reasoning_effort, limits,
                           context.deadline, context.cancelled,
                            InferenceBudget(limits.max_total_inference_tokens,
                                check_execution=getattr(context.provider_attempts, "check_capacity", None)),
                           context.provider_attempts)
