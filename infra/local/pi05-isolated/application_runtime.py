#!/usr/bin/env python3
"""Explicit application-process wiring for one isolated PI-05 run.

This module selects no shared configuration and performs no implicit startup.
The caller supplies the already reviewed, run-specific environment for Core,
AI HTTP, and each capability worker; the existing RunSupervisor owns their
independent lifecycles.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from process_supervisor import ProcessSpec, RunSupervisor, SupervisorError


class RuntimeWiringError(RuntimeError):
    """Application process wiring is incomplete or unsafe."""


_PROCESS_NAMES = (
    "ai-http",
    "core",
    "transcription-worker",
    "mi-worker",
    "knowledge-worker",
)
_DANGEROUS_COMMANDS = frozenset({"sh", "bash", "dash", "zsh", "fish", "cmd", "powershell"})
_DEFAULT_ENV_NAMES = frozenset({
    "PATH", "HOME", "LANG", "LC_ALL", "PI05_RUN_ID", "PI05_RUN_ROOT",
})
_DANGEROUS_ENV_NAMES = frozenset({
    "BASH_ENV", "CDPATH", "ENV", "LD_LIBRARY_PATH", "LD_PRELOAD",
    "PYTHONINSPECT", "PYTHONPATH", "PYTHONSTARTUP",
})


def _private_directory(path: Path, label: str, *, private: bool = True) -> Path:
    path = Path(path).absolute()
    for item in (path, *path.parents):
        if item.is_symlink():
            raise RuntimeWiringError(f"{label} cannot be symbolic")
    try:
        info = path.stat()
    except OSError as error:
        raise RuntimeWiringError(f"{label} is unavailable") from error
    prohibited = 0o077 if private else 0o022
    if not path.is_dir() or info.st_uid != os.getuid() or info.st_mode & prohibited:
        qualifier = "private" if private else "owner-controlled"
        raise RuntimeWiringError(f"{label} must be {qualifier}")
    return path


def _command(value: object) -> tuple[str, ...]:
    if (
        not isinstance(value, tuple)
        or not value
            or any(type(item) is not str or not item or "\x00" in item for item in value)
            or Path(value[0]).name in _DANGEROUS_COMMANDS
            or any(re.search(r"(?i)(?:password|passwd|secret|token|authorization)\s*=", item)
                   for item in value)
    ):
        raise RuntimeWiringError("Application command must be a bounded no-shell vector")
    return value


def _environment(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        raise RuntimeWiringError("Application environment must be a mapping")
    result = {}
    for name, setting in value.items():
        if (
            type(name) is not str
            or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) is None
            or name in _DEFAULT_ENV_NAMES
            or name in _DANGEROUS_ENV_NAMES
            or type(setting) is not str
            or "\x00" in setting
        ):
            raise RuntimeWiringError("Application environment contains an unsafe setting")
        result[name] = setting
    return result


@dataclass(frozen=True)
class ApplicationCommands:
    core: tuple[str, ...] = ("mvn", "-q", "-DskipTests", "spring-boot:run")
    ai_http: tuple[str, ...] = (sys.executable, "-m", "sme_meeting_ai.api")
    transcription_worker: tuple[str, ...] = (
        sys.executable, "-m", "sme_meeting_ai.workers",
    )
    mi_worker: tuple[str, ...] = (
        sys.executable, "-m", "sme_meeting_ai.workers",
    )
    knowledge_worker: tuple[str, ...] = (
        sys.executable, "-m", "sme_meeting_ai.workers",
    )

    def __post_init__(self) -> None:
        _command(self.core)
        _command(self.ai_http)
        _command(self.transcription_worker)
        _command(self.mi_worker)
        _command(self.knowledge_worker)

    def as_mapping(self) -> dict[str, tuple[str, ...]]:
        return {
            "core": self.core,
            "ai-http": self.ai_http,
            "transcription-worker": self.transcription_worker,
            "mi-worker": self.mi_worker,
            "knowledge-worker": self.knowledge_worker,
        }


class ApplicationRuntime:
    """Build and own exactly the five application processes for one run."""

    def __init__(
        self,
        run_id: str,
        root: Path,
        *,
        source_root: Path,
        runs_base: Path | None = None,
        commands: Mapping[str, tuple[str, ...]] | ApplicationCommands | None = None,
    ):
        try:
            self.supervisor = RunSupervisor(
                run_id,
                root,
                runs_base=runs_base,
                source_root=source_root,
            )
        except SupervisorError as error:
            raise RuntimeWiringError("Run-owned supervisor could not be configured") from error
        self.run_id = self.supervisor.run_id
        self.root = self.supervisor.root
        self.source_root = self.supervisor.source_root
        _private_directory(
            self.source_root / "services" / "api", "Core source directory", private=False
        )
        _private_directory(
            self.source_root / "services" / "ai", "AI source directory", private=False
        )

        if commands is None:
            selected = ApplicationCommands().as_mapping()
        elif isinstance(commands, ApplicationCommands):
            selected = commands.as_mapping()
        elif isinstance(commands, Mapping):
            if set(commands) != set(_PROCESS_NAMES):
                raise RuntimeWiringError("All five application commands are required")
            selected = {name: _command(value) for name, value in commands.items()}
        else:
            raise RuntimeWiringError("Application commands are invalid")
        self.commands = dict(selected)

    def specs(self, environments: Mapping[str, Mapping[str, str]]) -> tuple[ProcessSpec, ...]:
        if not isinstance(environments, Mapping) or set(environments) != set(_PROCESS_NAMES):
            raise RuntimeWiringError(
                "Core, AI HTTP, transcription, MI and Knowledge environments are all required",
            )
        safe = {name: _environment(environments[name]) for name in _PROCESS_NAMES}
        return (
            ProcessSpec(
                name="ai-http",
                command=self.commands["ai-http"],
                cwd=self.source_root / "services" / "ai",
                env=safe["ai-http"],
            ),
            ProcessSpec(
                name="core",
                command=self.commands["core"],
                cwd=self.source_root / "services" / "api",
                env=safe["core"],
            ),
            ProcessSpec(
                name="transcription-worker",
                command=self.commands["transcription-worker"],
                cwd=self.source_root / "services" / "ai",
                env=safe["transcription-worker"],
            ),
            ProcessSpec(
                name="mi-worker",
                command=self.commands["mi-worker"],
                cwd=self.source_root / "services" / "ai",
                env=safe["mi-worker"],
            ),
            ProcessSpec(
                name="knowledge-worker",
                command=self.commands["knowledge-worker"],
                cwd=self.source_root / "services" / "ai",
                env=safe["knowledge-worker"],
            ),
        )

    def start_all(self, environments: Mapping[str, Mapping[str, str]]) -> list[dict]:
        started: list[dict] = []
        try:
            for spec in self.specs(environments):
                started.append(self.supervisor.start(spec))
            return started
        except (SupervisorError, OSError) as error:
            self.stop_all()
            raise RuntimeWiringError("Isolated application startup failed") from error

    def status(self, name: str) -> dict:
        try:
            if name not in _PROCESS_NAMES:
                raise RuntimeWiringError("Unknown isolated application process")
            return self.supervisor.status(name)
        except SupervisorError as error:
            raise RuntimeWiringError("Application process status unavailable") from error

    def stop(self, name: str) -> dict:
        """Stop one process only when its recorded identity is still owned."""
        try:
            if name not in _PROCESS_NAMES:
                raise RuntimeWiringError("Unknown isolated application process")
            return self.supervisor.stop(name)
        except SupervisorError as error:
            raise RuntimeWiringError("Application process shutdown failed") from error

    def restart(
        self,
        name: str,
        environments: Mapping[str, Mapping[str, str]],
    ) -> dict:
        """Replace one owned process with the same reviewed process spec."""
        if name not in _PROCESS_NAMES:
            raise RuntimeWiringError("Unknown isolated application process")
        try:
            specs = self.specs(environments)
            selected = next(spec for spec in specs if spec.name == name)
            self.supervisor.stop(name)
            return self.supervisor.start(selected)
        except (StopIteration, SupervisorError, OSError) as error:
            raise RuntimeWiringError("Isolated application restart failed") from error

    def stop_all(self) -> list[dict]:
        results = []
        for name in (
            "knowledge-worker", "mi-worker", "transcription-worker", "core", "ai-http",
        ):
            try:
                results.append(self.supervisor.stop(name))
            except SupervisorError as error:
                raise RuntimeWiringError("Isolated application shutdown failed") from error
        return results
