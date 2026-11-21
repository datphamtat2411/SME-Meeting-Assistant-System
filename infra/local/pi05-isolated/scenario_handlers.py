#!/usr/bin/env python3
"""Action-plus-observer handlers for the ten PI-05 live scenarios.

The registry deliberately contains no default actions.  A live run must
register every operation against a real service and every independently
captured observation before the orchestrator can assemble evidence.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from uuid import UUID

from scenario_orchestrator import OrchestrationContext


class ScenarioHandlerError(RuntimeError):
    """A scenario handler is incomplete or did not return independent proof."""


@dataclass(frozen=True)
class StepExecution:
    request_id: str
    opaque_result: object

    def __post_init__(self) -> None:
        if not isinstance(self.request_id, str):
            raise ScenarioHandlerError("Step execution request ID is required")
        try:
            canonical = str(UUID(self.request_id))
        except (ValueError, TypeError, AttributeError) as error:
            raise ScenarioHandlerError("Step execution request ID is invalid") from error
        if canonical != self.request_id:
            raise ScenarioHandlerError("Step execution request ID is not canonical")
        if self.opaque_result is None:
            raise ScenarioHandlerError("Step action did not return an execution handle")


@dataclass(frozen=True)
class StepHandler:
    action: Callable[[OrchestrationContext], StepExecution]
    observer: Callable[
        [OrchestrationContext, StepExecution, tuple[str, str]], str
    ]


_DIGEST = re.compile(r"[0-9a-f]{64}\Z")


class ScenarioHandlerRegistry:
    def __init__(
        self,
        adapters: Mapping[str, Mapping[str, StepHandler]],
        *,
        enabled_scenarios: Iterable[str] | None = None,
    ):
        if not isinstance(adapters, Mapping):
            raise ScenarioHandlerError("Scenario adapters are required")
        if enabled_scenarios is None:
            selected = None
        else:
            if isinstance(enabled_scenarios, (str, bytes)):
                raise ScenarioHandlerError("Enabled scenarios must be an explicit collection")
            try:
                selected = tuple(enabled_scenarios)
            except TypeError as error:
                raise ScenarioHandlerError("Enabled scenarios are invalid") from error
            if (
                not selected
                or len(set(selected)) != len(selected)
                or any(not isinstance(scenario, str) for scenario in selected)
            ):
                raise ScenarioHandlerError("Enabled scenarios are invalid")
        self.adapters = {
            scenario: dict(steps)
            for scenario, steps in adapters.items()
        }
        self.enabled_scenarios = selected

    def handlers(self) -> dict[str, Callable]:
        # Import here so this module remains usable as a contract layer without
        # duplicating the required scenario map.
        from scenario_orchestrator import SCENARIO_PLANS

        scenarios = (
            tuple(SCENARIO_PLANS)
            if self.enabled_scenarios is None
            else self.enabled_scenarios
        )
        if any(scenario not in SCENARIO_PLANS for scenario in scenarios):
            raise ScenarioHandlerError("Enabled scenario is not a PI-05 scenario")
        if set(self.adapters) != set(scenarios):
            if self.enabled_scenarios is None:
                raise ScenarioHandlerError("All ten PI-05 scenario adapters are required")
            raise ScenarioHandlerError("Adapters do not match the explicitly enabled scenarios")
        for scenario in scenarios:
            requirements = SCENARIO_PLANS[scenario]
            steps = self.adapters.get(scenario)
            if not isinstance(steps, Mapping) or set(steps) != set(requirements):
                raise ScenarioHandlerError(
                    f"Scenario {scenario} does not have an exact step adapter set"
                )
            for step, adapter in steps.items():
                if (
                    not isinstance(adapter, StepHandler)
                    or not callable(adapter.action)
                    or not callable(adapter.observer)
                ):
                    raise ScenarioHandlerError(
                        f"Scenario {scenario} step {step} lacks action and observer"
                    )

        return {
            scenario: self._handler(scenario)
            for scenario in scenarios
        }

    def _handler(self, scenario: str):
        def execute(
            context: OrchestrationContext,
            requirements: dict[str, tuple[str, str]],
        ) -> list[str]:
            adapters = self.adapters[scenario]
            from scenario_orchestrator import SCENARIO_PLANS

            if requirements != SCENARIO_PLANS[scenario]:
                raise ScenarioHandlerError("Scenario requirements were changed")
            digests = []
            request_ids = set()
            for step, requirement in requirements.items():
                adapter = adapters[step]
                try:
                    execution = adapter.action(context)
                    if not isinstance(execution, StepExecution):
                        raise ScenarioHandlerError("Step action returned no execution record")
                    if execution.request_id in request_ids:
                        raise ScenarioHandlerError("Step request IDs must be unique")
                    request_ids.add(execution.request_id)
                    digest = adapter.observer(context, execution, requirement)
                except ScenarioHandlerError:
                    raise
                except Exception as error:
                    raise ScenarioHandlerError("Scenario step execution failed") from error
                if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
                    raise ScenarioHandlerError(
                        "Scenario step observer did not return a content-addressed receipt"
                    )
                digests.append(digest)
            if len(digests) != len(requirements) or len(set(digests)) != len(digests):
                raise ScenarioHandlerError("Scenario receipts are incomplete or repeated")
            return digests

        return execute
