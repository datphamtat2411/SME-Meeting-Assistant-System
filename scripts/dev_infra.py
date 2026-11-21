#!/usr/bin/env python3
"""Read-only ownership checks for the normal development Compose projects.

This helper reads only Docker labels and lifecycle metadata.  It never reads
container environments, mounts, volume contents, or application logs.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


class InfrastructureError(RuntimeError):
    """The expected development resource is missing or not owned."""


def _docker(*arguments: str) -> str:
    try:
        return subprocess.check_output(
            ["docker", *arguments],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=20,
        ).strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise InfrastructureError("Docker metadata inspection is unavailable") from error


def _json_docker(*arguments: str) -> dict:
    try:
        value = json.loads(_docker(*arguments))
    except (TypeError, ValueError) as error:
        raise InfrastructureError("Docker returned invalid ownership metadata") from error
    if not isinstance(value, dict):
        raise InfrastructureError("Docker returned invalid ownership metadata")
    return value


_CONTAINER_FORMAT = (
    '{"id":{{json .Id}},'
    '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
    '"status":{{json .State.Status}},'
    '"health":{{with (index .State "Health")}}{{json .Status}}{{else}}"none"{{end}},'
    '"user":{{json .Config.User}}}'
)
_VOLUME_FORMAT = (
    '{"name":{{json .Name}},'
    '"project":{{json (index .Labels "com.docker.compose.project")}},'
    '"volume":{{json (index .Labels "com.docker.compose.volume")}},'
    '"driver":{{json .Driver}},'
    '"scope":{{json .Scope}}}'
)


def container_snapshot(project: str) -> list[dict]:
    identifiers = _docker(
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        "label=com.docker.compose.project=" + project,
    ).splitlines()
    result = []
    for identifier in identifiers:
        if not identifier or any(char not in "0123456789abcdef" for char in identifier):
            raise InfrastructureError("Docker returned an invalid container identity")
        value = _json_docker("inspect", "--type", "container", "--format", _CONTAINER_FORMAT, identifier)
        if value.get("id") != identifier:
            raise InfrastructureError("Docker container identity changed during inspection")
        result.append(value)
    return result


def volume_snapshot(name: str) -> dict:
    values = _docker("volume", "inspect", "--format", _VOLUME_FORMAT, name).splitlines()
    if len(values) != 1:
        raise InfrastructureError("Expected development volume is unavailable")
    value = _json_docker("volume", "inspect", "--format", _VOLUME_FORMAT, name)
    if value.get("name") != name:
        raise InfrastructureError("Docker returned an unexpected development volume")
    return value


def _validate_project(
    project: str,
    services: tuple[str, ...],
    volumes: tuple[str, ...],
    healthy: frozenset[str],
    forbidden_running: frozenset[str],
) -> list[dict]:
    if not project or not services or len(set(services)) != len(services):
        raise InfrastructureError("Development Compose ownership contract is invalid")
    containers = container_snapshot(project)
    by_service: dict[str, dict] = {}
    for container in containers:
        if container.get("project") != project:
            raise InfrastructureError("Development container belongs to another Compose project")
        service = container.get("service")
        if not isinstance(service, str) or service in by_service:
            raise InfrastructureError("Development Compose service identity is invalid")
        by_service[service] = container
        if service in forbidden_running and container.get("status") == "running":
            raise InfrastructureError("A forbidden privileged helper is running")

    for service in services:
        container = by_service.get(service)
        if container is None:
            raise InfrastructureError(f"Development service is missing: {service}")
        if container.get("status") != "running":
            raise InfrastructureError(f"Development service is not running: {service}")
        if service in healthy and container.get("health") != "healthy":
            raise InfrastructureError(f"Development service is not healthy: {service}")

    for volume_name in volumes:
        volume = volume_snapshot(project + "_" + volume_name)
        if (
            volume.get("project") != project
            or volume.get("volume") != volume_name
            or volume.get("driver") != "local"
            or volume.get("scope") != "local"
        ):
            raise InfrastructureError("Development volume is not owned by its Compose project")
    return containers


def _safe_state_path(path: Path) -> Path:
    path = path.absolute()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    info = path.parent.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise InfrastructureError("Development ownership state directory must be private")
    if path.exists() and (
        path.is_symlink()
        or path.stat().st_uid != os.getuid()
        or path.stat().st_mode & 0o077
    ):
        raise InfrastructureError("Development ownership state is unsafe")
    return path


def _snapshot_lines(project: str) -> list[str]:
    return [
        f"{item.get('service')}\t{item.get('status')}"
        for item in container_snapshot(project)
        if isinstance(item.get("service"), str)
    ]


def _read_before(path: Path) -> set[str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise InfrastructureError("Development ownership snapshot is unreadable") from error
    return {
        line.split("\t", 1)[0]
        for line in lines
        if "\t" in line and line.split("\t", 1)[1] == "running"
    }


def assert_startable(state_path: Path, project: str, services: tuple[str, ...]) -> None:
    containers = container_snapshot(project)
    owned = set(owned_services(state_path, project))
    for service in services:
        matches = [item for item in containers if item.get("service") == service]
        if len(matches) > 1:
            raise InfrastructureError(f"Development service is duplicated: {service}")
        if matches and matches[0].get("status") != "running" and service not in owned:
            raise InfrastructureError(
                f"Development service exists but is not owned by dev.sh: {service}"
            )


def record_owned(
    state_path: Path,
    project: str,
    services: tuple[str, ...],
    before_path: Path,
) -> None:
    state_path = _safe_state_path(state_path)
    before = _read_before(before_path)
    current = {
        item.get("service")
        for item in container_snapshot(project)
        if item.get("status") == "running" and isinstance(item.get("service"), str)
    }
    owned = current.difference(before).intersection(services)
    state: dict = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as error:
            raise InfrastructureError("Development ownership state is malformed") from error
        if not isinstance(state, dict):
            raise InfrastructureError("Development ownership state is malformed")
    projects = state.setdefault("projects", {})
    if not isinstance(projects, dict):
        raise InfrastructureError("Development ownership state is malformed")
    prior = projects.get(project, {})
    if not isinstance(prior, dict):
        raise InfrastructureError("Development ownership state is malformed")
    prior_services = prior.get("services", [])
    if not isinstance(prior_services, list) or any(not isinstance(item, str) for item in prior_services):
        raise InfrastructureError("Development ownership state is malformed")
    projects[project] = {
        "services": sorted(set(prior_services).union(owned)),
    }
    temporary = state_path.with_name(f".{state_path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, state_path)


def owned_services(state_path: Path, project: str) -> list[str]:
    state_path = _safe_state_path(state_path)
    if not state_path.exists():
        return []
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(state, dict):
            raise InfrastructureError("Development ownership state is malformed")
        projects = state.get("projects")
        if not isinstance(projects, dict):
            raise InfrastructureError("Development ownership state is malformed")
        project_state = projects.get(project)
        if project_state is None:
            return []
        if not isinstance(project_state, dict):
            raise InfrastructureError("Development ownership state is malformed")
        services = project_state["services"]
    except InfrastructureError:
        raise
    except (KeyError, OSError, TypeError, UnicodeError, ValueError) as error:
        raise InfrastructureError("Development ownership state is malformed") from error
    if not isinstance(services, list) or any(not isinstance(item, str) for item in services):
        raise InfrastructureError("Development ownership state is malformed")
    return sorted(set(services))


def clear_project(state_path: Path, project: str) -> None:
    state_path = _safe_state_path(state_path)
    if not state_path.exists():
        return
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        projects = state.get("projects")
        if isinstance(projects, dict):
            projects.pop(project, None)
            if projects:
                state["projects"] = projects
                state_path.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="utf-8")
                state_path.chmod(0o600)
            else:
                state_path.unlink()
    except (OSError, TypeError, UnicodeError, ValueError) as error:
        raise InfrastructureError("Development ownership state is malformed") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)

    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("--project", required=True)

    verify = subparsers.add_parser("verify")
    verify.add_argument("--project", required=True)
    verify.add_argument("--services", required=True)
    verify.add_argument("--volumes", required=True)
    verify.add_argument("--healthy", default="")
    verify.add_argument("--forbid-running", default="")

    record = subparsers.add_parser("record")
    record.add_argument("--state-file", required=True, type=Path)
    record.add_argument("--project", required=True)
    record.add_argument("--services", required=True)
    record.add_argument("--before", required=True, type=Path)

    startable = subparsers.add_parser("assert-startable")
    startable.add_argument("--state-file", required=True, type=Path)
    startable.add_argument("--project", required=True)
    startable.add_argument("--services", required=True)

    owned = subparsers.add_parser("owned")
    owned.add_argument("--state-file", required=True, type=Path)
    owned.add_argument("--project", required=True)

    clear = subparsers.add_parser("clear")
    clear.add_argument("--state-file", required=True, type=Path)
    clear.add_argument("--project", required=True)

    args = parser.parse_args()
    try:
        if args.action == "snapshot":
            print("\n".join(_snapshot_lines(args.project)))
        elif args.action == "verify":
            services = tuple(item for item in args.services.split(",") if item)
            volumes = tuple(item for item in args.volumes.split(",") if item)
            healthy = frozenset(item for item in args.healthy.split(",") if item)
            forbidden = frozenset(item for item in args.forbid_running.split(",") if item)
            _validate_project(args.project, services, volumes, healthy, forbidden)
            print("PASS: development Compose ownership and readiness verified")
        elif args.action == "record":
            services = tuple(item for item in args.services.split(",") if item)
            record_owned(args.state_file, args.project, services, args.before)
        elif args.action == "assert-startable":
            services = tuple(item for item in args.services.split(",") if item)
            assert_startable(args.state_file, args.project, services)
        elif args.action == "owned":
            print("\n".join(owned_services(args.state_file, args.project)))
        else:
            clear_project(args.state_file, args.project)
    except InfrastructureError as error:
        print("BLOCKED:", error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
