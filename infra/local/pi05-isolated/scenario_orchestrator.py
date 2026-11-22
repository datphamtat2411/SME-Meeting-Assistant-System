#!/usr/bin/env python3
"""Fail-closed orchestration contract for PI-05 L01 through L10.

The handlers supplied by a future live runner must perform the real service
operations and invoke independent observers.  This module only binds the ten
required step identities to the unchanged contract and assembles receipts that
already exist.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parents[3]
AI_TESTS = ROOT / "services" / "ai" / "tests"
if str(AI_TESTS) not in sys.path:
    sys.path.insert(0, str(AI_TESTS))

from pi05_live_contract import REQUIRED  # noqa: E402

from receipt_bundle import assemble  # noqa: E402


class ScenarioUnavailable(RuntimeError):
    """No approved real handler is available for the requested scenario."""


def _canonical_uuid(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("run ID must be a UUID")
    try:
        canonical = str(UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("run ID must be a UUID") from error
    if canonical != value:
        raise ValueError("run ID must be canonical")
    return canonical


def _private_directory(path: Path) -> None:
    path = Path(path)
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError("evidence directory cannot be symbolic")
    info = path.stat()
    if not path.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("evidence directory must be private")


def _scoped(value: object, run_id: str, label: str) -> str:
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is None
        or not any(token in value.lower() for token in (run_id, run_id.replace("-", "")))
    ):
        raise ValueError(f"{label} is not run scoped")
    return value


SCENARIO_PLANS = {
    scenario: dict(requirements) for scenario, requirements in REQUIRED.items()
}


@dataclass(frozen=True)
class OrchestrationContext:
    run_id: str
    commit: str
    generation: str
    collection: str
    environment: dict
    proof_dir: Path
    source_dir: Path

    def __post_init__(self) -> None:
        run_id = _canonical_uuid(self.run_id)
        if not isinstance(self.commit, str) or re.fullmatch(r"[0-9a-f]{40}", self.commit) is None:
            raise ValueError("source commit must be a lowercase 40-hex SHA")
        generation = _scoped(self.generation, run_id, "generation")
        collection = _scoped(self.collection, run_id, "collection")
        _private_directory(self.proof_dir)
        _private_directory(self.source_dir)
        if not isinstance(self.environment, dict):
            raise ValueError("observed environment metadata is required")
        environment = dict(self.environment)
        if (
            environment.get("disposable") is not True
            or environment.get("coreBuild") != self.commit
            or environment.get("aiBuild") != self.commit
            or environment.get("tlsMode") != "MTLS"
            or environment.get("generationId") != generation
            or environment.get("collectionName") != collection
        ):
            raise ValueError("environment does not match orchestration context")
        object.__setattr__(self, "run_id", run_id)
        object.__setattr__(self, "generation", generation)
        object.__setattr__(self, "collection", collection)
        object.__setattr__(self, "environment", environment)
        object.__setattr__(self, "proof_dir", Path(self.proof_dir))
        object.__setattr__(self, "source_dir", Path(self.source_dir))


Handler = Callable[[OrchestrationContext, dict[str, tuple[str, str]]], object]


class ScenarioOrchestrator:
    """Invoke only explicitly registered handlers and assemble verified proof."""

    def __init__(
        self,
        context: OrchestrationContext,
        *,
        handlers: Mapping[str, Handler] | None = None,
    ):
        self.context = context
        self.handlers = dict(handlers or {})

    def run(self, scenario: str) -> dict:
        if scenario not in SCENARIO_PLANS:
            raise ValueError("unknown PI-05 scenario")
        handler = self.handlers.get(scenario)
        if handler is None:
            raise ScenarioUnavailable
        if not callable(handler):
            raise ScenarioUnavailable
        digests = handler(self.context, SCENARIO_PLANS[scenario])
        if (
            not isinstance(digests, (list, tuple))
            or len(digests) != len(SCENARIO_PLANS[scenario])
            or len(set(digests)) != len(digests)
            or any(
                not isinstance(digest, str)
                or re.fullmatch(r"[0-9a-f]{64}", digest) is None
                for digest in digests
            )
        ):
            raise ValueError("scenario handler did not return independent receipt digests")
        return assemble(
            scenario=scenario,
            run_id=self.context.run_id,
            commit=self.context.commit,
            generation=self.context.generation,
            collection=self.context.collection,
            environment=self.context.environment,
            proof_dir=self.context.proof_dir,
            digests=list(digests),
        )


class OrchestratorExecutor:
    """Bind a prepared real orchestrator to the scenario-server protocol."""

    def __init__(self, orchestrator: ScenarioOrchestrator):
        if not isinstance(orchestrator, ScenarioOrchestrator):
            raise TypeError("A prepared scenario orchestrator is required")
        self.orchestrator = orchestrator

    def execute(self, scenario, request, context) -> dict:
        if (
            request.run_id != self.orchestrator.context.run_id
            or request.commit != self.orchestrator.context.commit
            or request.generation != self.orchestrator.context.generation
            or request.collection != self.orchestrator.context.collection
            or context.proof_dir != self.orchestrator.context.proof_dir
        ):
            raise ScenarioUnavailable
        return self.orchestrator.run(scenario)
