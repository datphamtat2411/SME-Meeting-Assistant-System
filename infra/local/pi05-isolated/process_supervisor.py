#!/usr/bin/env python3
"""Run-owned, scrubbed process lifecycle support for the isolated PI-05 run.

This module starts only explicitly supplied argument vectors.  It never invokes
a shell, inherits the agent/developer environment, prints environment values,
or signals a PID whose command and start identity no longer match the recorded
process.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
from typing import Mapping
from uuid import UUID, uuid4


_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_DANGEROUS_ENV = frozenset({
    "BASH_ENV", "CDPATH", "ENV", "LD_LIBRARY_PATH", "LD_PRELOAD",
    "PYTHONINSPECT", "PYTHONPATH", "PYTHONSTARTUP",
})
_BUILTIN_ENV = frozenset({"HOME", "LANG", "LC_ALL", "PATH", "PI05_RUN_ID", "PI05_RUN_ROOT"})
_SECRET_ARG = re.compile(r"(?i)(?:password|passwd|secret|token|authorization)\s*=")
_DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin"


class SupervisorError(RuntimeError):
    """Sanitized supervisor configuration or ownership failure."""


def _run_id(value: str) -> str:
    try:
        canonical = str(UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise SupervisorError("canonical run UUID required") from error
    if canonical != value:
        raise SupervisorError("canonical run UUID required")
    return canonical


def _no_symlink(path: Path) -> None:
    for item in (path, *path.parents):
        if item.is_symlink():
            raise SupervisorError("symbolic paths are not allowed")


def _private_directory(path: Path) -> Path:
    path = Path(path)
    _no_symlink(path)
    try:
        info = path.stat()
    except OSError as error:
        raise SupervisorError("run directory is unavailable") from error
    if not path.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SupervisorError("run directory must be private and owner-controlled")
    return path


def _owned_directory(path: Path) -> Path:
    path = Path(path)
    _no_symlink(path)
    try:
        info = path.stat()
    except OSError as error:
        raise SupervisorError("source directory is unavailable") from error
    if not path.is_dir() or info.st_uid != os.getuid():
        raise SupervisorError("source directory must be owner-controlled")
    return path


def _private_file(path: Path) -> None:
    _no_symlink(path)
    info = path.stat()
    if (
        not path.is_file()
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
        or info.st_mode & 0o077
    ):
        raise SupervisorError("supervisor state file is unsafe")


def _proc_starttime(pid: int) -> str | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except (OSError, UnicodeError):
        return None
    closing = raw.rfind(")")
    if closing < 0:
        return None
    fields = raw[closing + 2:].split()
    # The suffix starts at field 3 (state); field 22 is index 19.
    if len(fields) <= 19 or fields[0] == "Z":
        return None
    return fields[19]


def _proc_command(pid: int) -> tuple[str, ...] | None:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return None
    if not raw:
        return None
    return tuple(os.fsdecode(item) for item in raw.split(b"\0") if item)


@dataclass(frozen=True)
class ProcessSpec:
    name: str
    command: tuple[str, ...]
    cwd: Path
    env: Mapping[str, str]


class RunSupervisor:
    """Own and supervise only processes launched for one UUID-scoped run."""

    def __init__(
        self,
        run_id: str,
        root: Path,
        *,
        runs_base: Path | None = None,
        source_root: Path | None = None,
        safe_path: str = _DEFAULT_PATH,
    ):
        self.run_id = _run_id(run_id)
        self.root = Path(root).absolute()
        base = Path(runs_base or Path.home() / ".local/share/sme-pi05/runs").absolute()
        if self.root != base / self.run_id:
            raise SupervisorError("run root is not UUID scoped")
        _private_directory(self.root)
        self.source_root = Path(source_root or Path.cwd()).absolute()
        _owned_directory(self.source_root)
        if not isinstance(safe_path, str) or not safe_path or "\0" in safe_path:
            raise SupervisorError("safe PATH is invalid")
        self.safe_path = safe_path
        self.state_dir = self.root / "process-state"
        self.log_dir = self.root / "process-logs"
        self.home_dir = self.root / "process-home"
        for directory in (self.state_dir, self.log_dir, self.home_dir):
            directory.mkdir(mode=0o700, exist_ok=True)
            _private_directory(directory)
        for directory in (self.state_dir, self.log_dir, self.home_dir):
            directory.chmod(0o700)

    def _spec(self, spec: ProcessSpec) -> tuple[str, ...]:
        if not isinstance(spec, ProcessSpec) or _NAME.fullmatch(spec.name) is None:
            raise SupervisorError("process name is invalid")
        if (
            not isinstance(spec.command, tuple)
            or not spec.command
            or any(type(item) is not str or not item or "\0" in item for item in spec.command)
            or any(_SECRET_ARG.search(item) for item in spec.command)
        ):
            raise SupervisorError("process command must be a bounded argument vector")
        cwd = Path(spec.cwd).absolute()
        _no_symlink(cwd)
        if not cwd.is_dir() or not (cwd == self.root or cwd.is_relative_to(self.root)
                                    or cwd == self.source_root
                                    or cwd.is_relative_to(self.source_root)):
            raise SupervisorError("process working directory is outside the run/source roots")
        if not isinstance(spec.env, Mapping):
            raise SupervisorError("process environment must be a mapping")
        for name, value in spec.env.items():
            if (
                type(name) is not str
                or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
                or name in _DANGEROUS_ENV
                or name in _BUILTIN_ENV
                or type(value) is not str
                or "\0" in value
            ):
                raise SupervisorError("process environment contains an unsafe setting")
        return spec.command

    def _state_path(self, name: str) -> Path:
        return self.state_dir / f"{name}.json"

    def _read_state(self, name: str) -> dict | None:
        path = self._state_path(name)
        if path.is_symlink():
            raise SupervisorError("process state is symbolic")
        if not path.exists():
            return None
        _private_file(path)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as error:
            raise SupervisorError("process state is unreadable") from error
        if not isinstance(value, dict):
            raise SupervisorError("process state is malformed")
        return value

    @staticmethod
    def _owned(state: dict) -> bool:
        pid = state.get("pid")
        if type(pid) is not int or pid <= 1:
            return False
        if _proc_starttime(pid) != state.get("starttime"):
            return False
        if _proc_command(pid) != tuple(state.get("command", ())):
            return False
        try:
            return os.getpgid(pid) == state.get("pgid") == pid
        except OSError:
            return False

    def status(self, name: str) -> dict:
        if _NAME.fullmatch(name or "") is None:
            raise SupervisorError("process name is invalid")
        state = self._read_state(name)
        if state is None:
            return {"name": name, "running": False}
        running = self._owned(state)
        return {
            "name": name,
            "running": running,
            "pid": state.get("pid") if running else None,
            "log": state.get("log"),
        }

    def _write_state(self, name: str, state: dict) -> None:
        destination = self._state_path(name)
        temporary = self.state_dir / f".{name}.{uuid4().hex}.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(state, output, sort_keys=True, separators=(",", ":"))
                output.write("\n")
            os.replace(temporary, destination)
            destination.chmod(0o600)
        except BaseException:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            raise

    def start(self, spec: ProcessSpec) -> dict:
        command = self._spec(spec)
        current = self.status(spec.name)
        if current["running"]:
            raise SupervisorError("process is already running")

        instance = uuid4().hex
        log_path = self.log_dir / f"{spec.name}-{instance}.log"
        fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        log = os.fdopen(fd, "w", encoding="utf-8", buffering=1)
        environment = {
            "PATH": self.safe_path,
            "HOME": str(self.home_dir),
            "LC_ALL": "C",
            "LANG": "C",
            "PI05_RUN_ID": self.run_id,
            "PI05_RUN_ROOT": str(self.root),
        }
        environment.update(dict(spec.env))
        try:
            child = subprocess.Popen(
                command,
                cwd=str(Path(spec.cwd).absolute()),
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                close_fds=True,
                start_new_session=True,
                shell=False,
            )
            starttime = _proc_starttime(child.pid)
            if starttime is None and child.poll() is None:
                child.kill()
                child.wait(timeout=2)
                raise SupervisorError("started process identity could not be recorded")
            try:
                pgid = os.getpgid(child.pid)
            except ProcessLookupError:
                pgid = None
            state = {
                "name": spec.name,
                "pid": child.pid,
                "pgid": child.pid if pgid == child.pid else None,
                "starttime": starttime,
                "command": list(command),
                "commandSha256": hashlib.sha256(
                    json.dumps(command, separators=(",", ":")).encode()
                ).hexdigest(),
                "log": str(log_path),
                "startedAt": time.time(),
            }
            try:
                self._write_state(spec.name, state)
            except BaseException:
                if self._owned(state):
                    os.killpg(child.pid, signal.SIGTERM)
                raise
            return dict(state)
        except (OSError, subprocess.SubprocessError) as error:
            raise SupervisorError("process could not be started") from error
        finally:
            log.close()

    def wait(self, name: str, *, timeout: float = 60.0) -> dict:
        if type(timeout) not in (int, float) or not 0 < timeout <= 14400:
            raise SupervisorError("wait timeout is invalid")
        deadline = time.monotonic() + float(timeout)
        while time.monotonic() < deadline:
            result = self.status(name)
            if not result["running"]:
                return result
            time.sleep(0.02)
        raise SupervisorError("process did not stop before the timeout")

    def stop(self, name: str, *, timeout: float = 30.0) -> dict:
        if _NAME.fullmatch(name or "") is None:
            raise SupervisorError("process name is invalid")
        if type(timeout) not in (int, float) or not 0 < timeout <= 600:
            raise SupervisorError("shutdown timeout is invalid")
        state = self._read_state(name)
        if state is None or not self._owned(state):
            return {"name": name, "running": False}
        pid = state["pid"]
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            return {"name": name, "running": False}
        deadline = time.monotonic() + float(timeout)
        while time.monotonic() < deadline:
            if not self._owned(state):
                return {"name": name, "running": False}
            time.sleep(0.02)
        if self._owned(state):
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            kill_deadline = time.monotonic() + 2
            while time.monotonic() < kill_deadline and self._owned(state):
                time.sleep(0.02)
        if self._owned(state):
            raise SupervisorError("owned process did not stop")
        return {"name": name, "running": False}
