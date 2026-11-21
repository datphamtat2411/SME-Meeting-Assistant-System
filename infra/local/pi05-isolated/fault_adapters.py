#!/usr/bin/env python3
"""Run-owned fault adapters with no shell and no shared-resource targeting."""

from __future__ import annotations

import os
import re
import subprocess
from collections.abc import Callable

from fault_scope import FaultScope, FaultScopeError


class FaultAdapterError(RuntimeError):
    """A bounded fault could not be applied safely."""


_CONTAINER = re.compile(r"[0-9a-f]{64}\Z")
_SAFE_PATH = "/usr/local/bin:/usr/bin:/bin"


class FaultAdapter:
    """Delegate only the exact start/stop tuple created by FaultScope."""

    def __init__(self, scope: FaultScope, runner: Callable[[tuple[str, str, str]], object]):
        if not isinstance(scope, FaultScope) or not callable(runner):
            raise FaultAdapterError("A run-owned fault scope and runner are required")
        self.scope = scope
        self.runner = runner

    def _apply(self, action: str, service: str) -> object:
        try:
            return self.scope.apply(action, service, self.runner)
        except FaultAdapterError:
            raise
        except (FaultScopeError, Exception) as error:
            raise FaultAdapterError("Run-owned fault application failed") from error

    def stop(self, service: str) -> object:
        return self._apply("stop", service)

    def start(self, service: str) -> object:
        return self._apply("start", service)

    def restart(self, service: str) -> tuple[object, object]:
        stopped = self.stop(service)
        started = self.start(service)
        return stopped, started


class DockerFaultRunner:
    """Execute only a validated Docker container start/stop command."""

    def __init__(self, *, binary: str = "docker", timeout: float = 30.0):
        if (
            not isinstance(binary, str)
            or not binary
            or "\x00" in binary
            or binary not in {"docker", "/usr/bin/docker", "/usr/local/bin/docker"}
            or type(timeout) not in (int, float)
            or not 0 < timeout <= 600
        ):
            raise FaultAdapterError("Docker fault runner configuration is invalid")
        self.binary = binary
        self.timeout = float(timeout)

    def __call__(self, command: tuple[str, str, str]) -> None:
        if (
            not isinstance(command, tuple)
            or len(command) != 3
            or command[0] != "docker"
            or command[1] not in {"start", "stop"}
            or _CONTAINER.fullmatch(command[2] or "") is None
        ):
            raise FaultAdapterError("Fault command is outside the bounded Docker scope")
        try:
            subprocess.run(
                [self.binary, command[1], command[2]],
                check=True,
                shell=False,
                close_fds=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                capture_output=False,
                timeout=self.timeout,
                env={
                    "PATH": _SAFE_PATH,
                    "HOME": os.path.expanduser("~"),
                    "LC_ALL": "C",
                    "LANG": "C",
                },
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise FaultAdapterError("Docker fault command failed") from error
