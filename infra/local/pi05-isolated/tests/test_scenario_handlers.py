"""Offline tests for action-plus-independent-observer scenario handlers."""

from __future__ import annotations

import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "services/ai/tests"))

from observation_receipts import Observation, ReceiptWriter  # noqa: E402
from pi05_live_contract import REQUIRED  # noqa: E402
from scenario_handlers import (  # noqa: E402
    ScenarioHandlerError,
    ScenarioHandlerRegistry,
    StepExecution,
    StepHandler,
)
from scenario_orchestrator import (  # noqa: E402
    OrchestrationContext,
    ScenarioOrchestrator,
)


def context(tmp_path):
    run_id = str(uuid4())
    proof = tmp_path / "proofs"
    sources = tmp_path / "sources"
    proof.mkdir(mode=0o700)
    sources.mkdir(mode=0o700)
    commit = "a" * 40
    generation = "generation-" + run_id
    collection = "collection-" + run_id
    return OrchestrationContext(
        run_id=run_id,
        commit=commit,
        generation=generation,
        collection=collection,
        environment={
            "disposable": True,
            "environmentId": "offline-fixture",
            "coreBuild": commit,
            "aiBuild": commit,
            "flywayVersion": "V59",
            "tlsMode": "MTLS",
            "generationId": generation,
            "collectionName": collection,
        },
        proof_dir=proof,
        source_dir=sources,
    )


def test_registry_rejects_incomplete_scenario_before_execution(tmp_path):
    scenario = "room-notification"
    with pytest.raises(ScenarioHandlerError):
        ScenarioHandlerRegistry({scenario: {}}).handlers()


def test_registry_can_explicitly_activate_l01_only(tmp_path):
    scenario = "full-pipeline"
    adapters = {
        scenario: {
            step: StepHandler(
                action=lambda _context: StepExecution(str(uuid4()), object()),
                observer=lambda *_: "a" * 64,
            )
            for step in REQUIRED[scenario]
        }
    }

    handlers = ScenarioHandlerRegistry(
        adapters, enabled_scenarios=(scenario,),
    ).handlers()

    assert set(handlers) == {scenario}


def test_registry_rejects_l01_activation_with_an_unrequested_scenario(tmp_path):
    with pytest.raises(ScenarioHandlerError):
        ScenarioHandlerRegistry(
            {"full-pipeline": {}, "room-notification": {}},
            enabled_scenarios=("full-pipeline",),
        ).handlers()


def test_registry_requires_both_action_and_observer_for_each_step(tmp_path):
    scenario = "room-notification"
    requirement = next(iter(REQUIRED[scenario].items()))
    with pytest.raises(ScenarioHandlerError):
        ScenarioHandlerRegistry({
            scenario: {
                requirement[0]: StepHandler(
                    action=lambda _context: StepExecution(str(uuid4()), object()),
                    observer=None,
                )
            }
        }).handlers()


def test_registered_handler_runs_actions_then_independent_observers(tmp_path):
    context_value = context(tmp_path)
    writer = ReceiptWriter(context_value.proof_dir, context_value.source_dir)
    calls = []
    all_adapters = {}
    for scenario_name, requirements in REQUIRED.items():
        adapters = {}
        for step in requirements:
            def action(_context, scenario_name=scenario_name, step=step):
                calls.append(("action", scenario_name, step))
                return StepExecution(str(uuid4()), object())

            def observer(
                _context, execution, requirement,
                scenario_name=scenario_name, step=step,
            ):
                calls.append(("observe", scenario_name, step, execution.request_id))
                return writer.write(
                    Observation(
                        run_id=context_value.run_id,
                        request_id=execution.request_id,
                        step=step,
                        component=requirement[0],
                        observed_result=requirement[1],
                        observed_at=datetime.now(UTC),
                    ),
                    {"boundary": requirement[0], "operation": step},
                )

            adapters[step] = StepHandler(action=action, observer=observer)
        all_adapters[scenario_name] = adapters

    handlers = ScenarioHandlerRegistry(all_adapters).handlers()
    scenario = "room-notification"
    result = ScenarioOrchestrator(context_value, handlers=handlers).run(scenario)

    assert result["status"] == "PASS"
    assert [item[0] for item in calls] == ["action", "observe"] * len(REQUIRED[scenario])
    assert len(list(context_value.proof_dir.iterdir())) == len(REQUIRED[scenario])


def test_handler_rejects_observer_without_content_addressed_receipt(tmp_path):
    context_value = context(tmp_path)
    scenario = "qdrant-outage"
    all_adapters = {}
    for scenario_name, requirements in REQUIRED.items():
        all_adapters[scenario_name] = {
            step: StepHandler(
                action=lambda _context: StepExecution(str(uuid4()), object()),
                observer=lambda *_: "not-a-digest",
            )
            for step in requirements
        }
    handler = ScenarioHandlerRegistry(all_adapters).handlers()[scenario]
    with pytest.raises(ScenarioHandlerError):
        handler(context_value, REQUIRED[scenario])
