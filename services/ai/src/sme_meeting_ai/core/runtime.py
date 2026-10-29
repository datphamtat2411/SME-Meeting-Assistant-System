"""Lifecycle state for one HTTP application; no external dependencies."""

from dataclasses import dataclass


@dataclass(slots=True)
class RuntimeState:
    initialized: bool = False
