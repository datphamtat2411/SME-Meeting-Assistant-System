"""Offline contract tests for the explicit real-service L01 adapter boundary."""

from __future__ import annotations

import sys
from pathlib import Path
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "services/ai/tests"))

from l01_adapter import (
    STEPS,
    L01Adapter,
    L01Handle,
)
from pi05_live_contract import REQUIRED
from scenario_handlers import ScenarioHandlerError, StepExecution
from scenario_orchestrator import OrchestrationContext


def context(tmp_path: Path) -> OrchestrationContext:
    run_id = str(uuid4())
    proof_dir = tmp_path / "proofs"
    source_dir = tmp_path / "observation-sources"
    proof_dir.mkdir(mode=0o700)
    source_dir.mkdir(mode=0o700)
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
        proof_dir=proof_dir,
        source_dir=source_dir,
    )


class FakeOperations:
    def __init__(self):
        self.calls: list[tuple[str, str]] = []
        self.invalid_digest = False

    def action(self, step, _context, _state, request_id):
        self.calls.append(("action", step))
        return L01Handle(step, request_id, {"stepOrdinal": STEPS.index(step)})

    def observe(self, step, _context, _state, _execution, _requirement):
        self.calls.append(("observe", step))
        if self.invalid_digest:
            return "not-a-digest"
        return f"{len(self.calls):064x}"


def test_l01_runs_each_real_action_then_its_independent_observer_in_order(tmp_path):
    context_value = context(tmp_path)
    operations = FakeOperations()
    adapter = L01Adapter(context_value, operations)
    handlers = adapter.step_handlers()

    for step, requirement in REQUIRED["full-pipeline"].items():
        execution = handlers[step].action(context_value)
        assert isinstance(execution, StepExecution)
        assert handlers[step].observer(context_value, execution, requirement)

    assert operations.calls == [
        item
        for step in STEPS
        for item in (("action", step), ("observe", step))
    ]


def test_l01_rejects_out_of_order_or_cross_run_action(tmp_path):
    context_value = context(tmp_path)
    adapter = L01Adapter(context_value, FakeOperations())

    with pytest.raises(ScenarioHandlerError):
        adapter._action("transcript-current", context_value)

    first = adapter.step_handlers()["meeting-record"].action(context_value)
    assert isinstance(first, StepExecution)
    with pytest.raises(ScenarioHandlerError):
        adapter.step_handlers()["meeting-record"].action(context_value)

    foreign_root = tmp_path / "foreign"
    foreign_root.mkdir()
    foreign = context(foreign_root)
    with pytest.raises(ScenarioHandlerError):
        adapter.step_handlers()["meeting-record"].action(foreign)


def test_l01_rejects_mismatched_action_handle_and_invalid_observer_digest(tmp_path):
    context_value = context(tmp_path)
    operations = FakeOperations()
    adapter = L01Adapter(context_value, operations)
    request_id = str(uuid4())
    execution = StepExecution(
        request_id,
        L01Handle("meeting-record", request_id, {}),
    )

    with pytest.raises(ScenarioHandlerError):
        adapter._observe(
            "source-media-verified",
            context_value,
            execution,
            REQUIRED["full-pipeline"]["source-media-verified"],
        )

    valid = adapter.step_handlers()["meeting-record"].action(context_value)
    operations.invalid_digest = True
    with pytest.raises(ScenarioHandlerError):
        adapter.step_handlers()["meeting-record"].observer(
            context_value,
            valid,
            REQUIRED["full-pipeline"]["meeting-record"],
        )
