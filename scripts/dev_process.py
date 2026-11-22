#!/usr/bin/env python3
"""Own only the development processes started by dev.sh."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


class ProcessError(RuntimeError):
    """A development process is unavailable or not owned by this state file."""


_SAFE_ENV = frozenset({
    "HOME",
    "JAVA_HOME",
    "LANG",
    "LC_ALL",
    "MAVEN_ARGS",
    "MAVEN_OPTS",
    "PATH",
    "USER",
    "VIRTUAL_ENV",
})


def _state_dir(path: Path) -> Path:
    path = path.absolute()
    if any(item.is_symlink() for item in (path, *path.parents)):
        raise ProcessError("development state directory cannot be symbolic")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ProcessError("development state directory must be private")
    return path


def _state_path(directory: Path, name: str) -> Path:
    if not name or "/" in name or name in {".", ".."}:
        raise ProcessError("development process name is invalid")
    return directory / f"{name}.json"


def _read_state(path: Path) -> dict | None:
    if not path.exists():
        return None
    if path.is_symlink() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise ProcessError("development process state is unsafe")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise ProcessError("development process state is unreadable") from error
    if not isinstance(value, dict):
        raise ProcessError("development process state is malformed")
    return value


def _proc_starttime(pid: int) -> str | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except (OSError, UnicodeError):
        return None
    closing = raw.rfind(")")
    if closing < 0:
        return None
    fields = raw[closing + 2:].split()
    if len(fields) <= 19 or fields[0] == "Z":
        return None
    return fields[19]


def _owned(state: dict | None) -> bool:
    if state is None:
        return False
    pid = state.get("pid")
    if type(pid) is not int or pid <= 1:
        return False
    if _proc_starttime(pid) != state.get("starttime"):
        return False
    try:
        return os.getpgid(pid) == state.get("pgid") == pid
    except OSError:
        return False


def _status(name: str, state: dict | None) -> dict[str, object]:
    running = _owned(state)
    return {
        "name": name,
        "running": running,
        "pid": state.get("pid") if running and state else None,
        "log": state.get("log") if state else None,
    }


def _safe_environment() -> dict[str, str]:
    return {
        name: value
        for name, value in os.environ.items()
        if name in _SAFE_ENV
    }


def start(directory: Path, name: str, cwd: Path, log: Path, command: list[str]) -> dict[str, object]:
    if not command or any(not item or "\x00" in item for item in command):
        raise ProcessError("development command is invalid")
    directory = _state_dir(directory)
    state_path = _state_path(directory, name)
    current = _read_state(state_path)
    if _owned(current):
        return _status(name, current)
    if state_path.exists():
        state_path.unlink()
    cwd = cwd.absolute()
    if not cwd.is_dir():
        raise ProcessError("development process directory is unavailable")
    log = log.absolute()
    log_parent = log.parent
    if any(item.is_symlink() for item in (log_parent, *log_parent.parents)):
        raise ProcessError("development log directory cannot be symbolic")
    log_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    log_parent.chmod(0o700)
    log_info = log_parent.stat()
    if log_info.st_uid != os.getuid() or log_info.st_mode & 0o077:
        raise ProcessError("development log directory must be private")
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    output = os.fdopen(fd, "a", encoding="utf-8", buffering=1)
    try:
        child = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=_safe_environment(),
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            close_fds=True,
            start_new_session=True,
            shell=False,
        )
        starttime = _proc_starttime(child.pid)
        if starttime is None:
            child.kill()
            child.wait(timeout=2)
            raise ProcessError("development process identity could not be recorded")
        state = {
            "name": name,
            "pid": child.pid,
            "pgid": child.pid,
            "starttime": starttime,
            "command": command,
            "log": str(log),
        }
        temporary = state_path.with_name(f".{state_path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, state_path)
        state_path.chmod(0o600)
        return _status(name, state)
    except BaseException:
        if "child" in locals() and _owned({
            "pid": child.pid,
            "pgid": child.pid,
            "starttime": _proc_starttime(child.pid),
        }):
            os.killpg(child.pid, signal.SIGTERM)
        raise
    finally:
        output.close()


def stop(directory: Path, name: str, timeout: float = 30.0) -> dict[str, object]:
    directory = _state_dir(directory)
    state_path = _state_path(directory, name)
    state = _read_state(state_path)
    if not _owned(state):
        if state_path.exists():
            state_path.unlink()
        return {"name": name, "running": False}
    assert state
    pid = state["pid"]
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and _owned(state):
        time.sleep(0.05)
    if _owned(state):
        os.killpg(pid, signal.SIGKILL)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and _owned(state):
            time.sleep(0.05)
    if _owned(state):
        raise ProcessError("owned development process did not stop")
    state_path.unlink(missing_ok=True)
    return {"name": name, "running": False}


def status(directory: Path, name: str) -> dict[str, object]:
    directory = _state_dir(directory)
    return _status(name, _read_state(_state_path(directory, name)))


def main() -> int:
    raw_arguments = sys.argv[1:]
    command: list[str] = []
    if "--" in raw_arguments:
        separator = raw_arguments.index("--")
        command = raw_arguments[separator + 1:]
        raw_arguments = raw_arguments[:separator]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "stop", "status"))
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--cwd", type=Path)
    parser.add_argument("--log", type=Path)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args(raw_arguments)
    try:
        if args.action == "start":
            if args.cwd is None or args.log is None:
                raise ProcessError("start requires cwd and log")
            result = start(args.state_dir, args.name, args.cwd, args.log, command)
        elif args.action == "stop":
            result = stop(args.state_dir, args.name, args.timeout)
        else:
            result = status(args.state_dir, args.name)
    except ProcessError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
