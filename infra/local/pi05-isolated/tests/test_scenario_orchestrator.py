"""Offline tests for the ten-scenario fail-closed orchestration layer."""

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
from scenario_orchestrator import (  # noqa: E402
    SCENARIO_PLANS,
    OrchestrationContext,
    OrchestratorExecutor,
    ScenarioOrchestrator,
    ScenarioUnavailable,
)


def context(tmp_path):
    run_id = str(uuid4())
    proof_dir = tmp_path / "proofs"
    source_dir = tmp_path / "sources"
    proof_dir.mkdir(mode=0o700)
    source_dir.mkdir(mode=0o700)
    commit = "a" * 40
    generation = "generation-" + run_id
    collection = "collection-" + run_id
    environment = {
        "disposable": True,
        "environmentId": "offline-fixture",
        "coreBuild": commit,
        "aiBuild": commit,
        "flywayVersion": "V59",
        "tlsMode": "MTLS",
        "generationId": generation,
        "collectionName": collection,
    }
    return OrchestrationContext(
        run_id=run_id,
        commit=commit,
        generation=generation,
        collection=collection,
        environment=environment,
        proof_dir=proof_dir,
        source_dir=source_dir,
    )


def receipts(context, scenario):
    writer = ReceiptWriter(context.proof_dir, context.source_dir)
    digests = []
    for step, (component, outcome) in REQUIRED[scenario].items():
        digests.append(writer.write(
            Observation(
                run_id=context.run_id,
                request_id=str(uuid4()),
                step=step,
                component=component,
                observed_result=outcome,
                observed_at=datetime.now(UTC),
            ),
            {"boundary": component, "scenario": scenario},
        ))
    return digests


def test_plans_cover_exactly_all_live_scenarios_and_steps():
    assert set(SCENARIO_PLANS) == set(REQUIRED)
    for scenario, plan in SCENARIO_PLANS.items():
        assert tuple(plan) == tuple(REQUIRED[scenario])
        assert all(plan[step] == REQUIRED[scenario][step] for step in plan)


def test_missing_handler_fails_closed_for_every_scenario(tmp_path):
    context_value = context(tmp_path)
    orchestrator = ScenarioOrchestrator(context_value)

    for scenario in REQUIRED:
        with pytest.raises(ScenarioUnavailable):
            orchestrator.run(scenario)


def test_handler_receipts_are_assembled_without_orchestrator_writes(tmp_path):
    context_value = context(tmp_path)
    scenario = "room-notification"
    digests = receipts(context_value, scenario)
    before = sorted(context_value.proof_dir.iterdir())
    calls = []

    def handler(run_context, requirements):
        calls.append((run_context, requirements))
        return digests

    result = ScenarioOrchestrator(
        context_value, handlers={scenario: handler},
    ).run(scenario)

    assert result["status"] == "PASS"
    assert result["scenario"] == scenario
    assert sorted(context_value.proof_dir.iterdir()) == before
    assert calls[0][1] == SCENARIO_PLANS[scenario]


def test_handler_cannot_supply_a_bare_pass_or_wrong_receipt_count(tmp_path):
    context_value = context(tmp_path)
    scenario = "qdrant-outage"

    for value in ({"status": "PASS"}, []):
        with pytest.raises(ValueError):
            ScenarioOrchestrator(
                context_value, handlers={scenario: lambda *_, value=value: value},
            ).run(scenario)


def test_server_executor_binds_request_and_proof_context_before_running(tmp_path):
    context_value = context(tmp_path)
    scenario = "room-notification"
    digests = receipts(context_value, scenario)
    calls = []

    def handler(run_context, requirements):
        calls.append((run_context, requirements))
        return digests

    orchestrator = ScenarioOrchestrator(
        context_value, handlers={scenario: handler},
    )
    executor = OrchestratorExecutor(orchestrator)
    request = type(
        "Request",
        (),
        {
            "run_id": context_value.run_id,
            "commit": context_value.commit,
            "generation": context_value.generation,
            "collection": context_value.collection,
        },
    )()
    server_context = type(
        "Context", (), {"proof_dir": context_value.proof_dir}
    )()

    result = executor.execute(scenario, request, server_context)

    assert result["status"] == "PASS"
    assert len(calls) == 1

    request.run_id = str(uuid4())
    with pytest.raises(ScenarioUnavailable):
        executor.execute(scenario, request, server_context)
