#!/usr/bin/env python3
"""Validate fault targets before any operator-owned fault runner is invoked."""

from __future__ import annotations

from dataclasses import dataclass
import re
from types import MappingProxyType
from typing import Callable, Mapping
from uuid import UUID


class FaultScopeError(ValueError):
    """Fault target or action is outside the isolated run."""


_ACTIONS = frozenset({"start", "stop"})
_SERVICE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_CONTAINER = re.compile(r"[0-9a-f]{64}")


def _run_id(value: object) -> str:
    if not isinstance(value, str):
        raise FaultScopeError("canonical run UUID required")
    try:
        canonical = str(UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise FaultScopeError("canonical run UUID required") from error
    if canonical != value:
        raise FaultScopeError("canonical run UUID required")
    return canonical


@dataclass(frozen=True)
class FaultScope:
    """A command factory bound to verified container IDs from one run."""

    run_id: str
    containers: Mapping[str, str]

    def __post_init__(self) -> None:
        run_id = _run_id(self.run_id)
        if not isinstance(self.containers, Mapping) or not self.containers:
            raise FaultScopeError("verified run containers are required")
        copied = {}
        for service, container in self.containers.items():
            if (
                not isinstance(service, str)
                or _SERVICE.fullmatch(service) is None
                or not isinstance(container, str)
                or _CONTAINER.fullmatch(container) is None
            ):
                raise FaultScopeError("container identity is invalid")
            copied[service] = container
        if len(set(copied.values())) != len(copied):
            raise FaultScopeError("container identities must be unique")
        object.__setattr__(self, "run_id", run_id)
        object.__setattr__(self, "containers", MappingProxyType(copied))

    @property
    def project(self) -> str:
        return "pi05-" + self.run_id

    def command(self, action: str, service: str) -> tuple[str, str, str]:
        if action not in _ACTIONS:
            raise FaultScopeError("only bounded start/stop faults are permitted")
        if service not in self.containers:
            raise FaultScopeError("fault service is not owned by this run")
        # Container IDs came from the independently validated runtime snapshot;
        # never target a shared name, compose project, volume or network.
        return ("docker", action, self.containers[service])

    def apply(
        self, action: str, service: str, runner: Callable[[tuple[str, str, str]], object],
    ) -> object:
        if not callable(runner):
            raise FaultScopeError("fault runner is required")
        return runner(self.command(action, service))
