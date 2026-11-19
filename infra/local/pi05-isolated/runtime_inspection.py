#!/usr/bin/env python3
"""Read-only Docker ownership check for an already started PI-05 foundation.

No container environment, credentials, messages, or business records are read.
Passing this check is not service readiness, isolation certification, live
acceptance evidence, or authorization to start, stop, migrate, or inject faults.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

from preflight import Blocked, _directory, _no_symlinks, _run_id

ROOT = Path(__file__).resolve().parents[3]
REPO_INFRA = ROOT / "infra/local/secure-integration"
IMAGES = {
    "postgres": "postgres:17",
    "rabbitmq": "rabbitmq:4.1-management",
    "storage": "rustfs/rustfs:1.0.3",
    "storage-boundary": "nginx:1.28-alpine",
    "qdrant": "qdrant/qdrant:v1.20.0",
    "storage-permissions": "alpine:3.22",
    "qdrant-permissions": "alpine:3.22",
}
PORTS = {"postgres": 5432, "rabbitmq": 5671, "storage-boundary": 9000, "qdrant": 6333}
SHARED_PORTS = {5433, 5671, 8000, 8443, 9000, 9443}
VOLUMES = {"postgres_data", "broker_data", "storage_data", "qdrant_data"}
NETWORKS = {"integration", "storage-backend"}


def _expected_mounts(project: str, root: Path) -> dict[str, set[tuple]]:
    def volume(name: str, target: str) -> tuple:
        return ("volume", project + "_" + name, target, True)

    def bind(source: Path, target: str) -> tuple:
        return ("bind", str(source), target, False)

    pki = root / "pki"
    return {
        "postgres": {volume("postgres_data", "/var/lib/postgresql/data")},
        "rabbitmq": {
            volume("broker_data", "/var/lib/rabbitmq"),
            bind(REPO_INFRA / "rabbitmq.conf", "/etc/rabbitmq/rabbitmq.conf"),
            bind(REPO_INFRA / "enabled_plugins", "/etc/rabbitmq/enabled_plugins"),
            bind(pki / "broker-server", "/run/secrets/broker"),
        },
        "storage-permissions": {volume("storage_data", "/data")},
        "storage": {
            volume("storage_data", "/data"),
            bind(pki / "storage-server", "/run/secrets/storage"),
        },
        "storage-boundary": {
            bind(REPO_INFRA / "storage-boundary.conf", "/etc/nginx/storage-boundary.conf"),
            bind(pki / "storage-server", "/run/secrets/storage"),
        },
        "qdrant-permissions": {volume("qdrant_data", "/data")},
        "qdrant": {
            volume("qdrant_data", "/qdrant/storage"),
            bind(pki / "qdrant-server", "/run/secrets/qdrant"),
        },
    }


def _mounts(value: object) -> set[tuple]:
    if not isinstance(value, list):
        raise Blocked("Container mounts are unavailable")
    found = set()
    for item in value:
        if not isinstance(item, dict) or item.get("Type") not in {"bind", "volume"}:
            raise Blocked("Unexpected container mount")
        name = item.get("Name") if item["Type"] == "volume" else item.get("Source")
        target, writable = item.get("Destination"), item.get("RW")
        if not isinstance(name, str) or not isinstance(target, str) or type(writable) is not bool:
            raise Blocked("Invalid container mount metadata")
        found.add((item["Type"], name, target, writable))
    if len(found) != len(value):
        raise Blocked("Duplicate container mount metadata")
    return found


def validate_topology(
    run_id: str, root: Path, containers: list, networks: list, volumes: list,
    image_ids: dict, *, runs_base: Path | None = None,
) -> dict[str, str]:
    """Validate an ownership snapshot; does not contact services or read secrets."""
    project = "pi05-" + _run_id(run_id)
    root = Path(os.path.abspath(root))
    base = Path(os.path.abspath(runs_base or Path.home() / ".local/share/sme-pi05/runs"))
    if root != base / run_id:
        raise Blocked("Run directory does not match the project UUID")
    _no_symlinks(root)
    if not isinstance(containers, list) or len(containers) != len(IMAGES):
        raise Blocked("Expected project containers are missing or duplicated")
    if not isinstance(image_ids, dict) or set(image_ids) != set(IMAGES.values()):
        raise Blocked("Expected image metadata is missing")
    if any(not isinstance(value, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None
           for value in image_ids.values()):
        raise Blocked("Image identity is invalid")

    expected_mounts = _expected_mounts(project, root)
    expected_networks = {
        "postgres": {"integration"}, "rabbitmq": {"integration"},
        "storage": {"storage-backend"}, "storage-boundary": NETWORKS,
        "qdrant": {"integration"}, "storage-permissions": set(), "qdrant-permissions": set(),
    }
    by_service = {}
    ids = set()
    ports: dict[str, str] = {}
    used_ports = set()
    for container in containers:
        if not isinstance(container, dict):
            raise Blocked("Invalid container metadata")
        service, identifier = container.get("service"), container.get("id")
        if (not isinstance(service, str) or service not in IMAGES or service in by_service
                or container.get("project") != project):
            raise Blocked("Unexpected project container")
        if (not isinstance(identifier, str) or re.fullmatch(r"[0-9a-f]{64}", identifier) is None
                or identifier in ids):
            raise Blocked("Invalid or repeated container identity")
        ids.add(identifier)
        by_service[service] = container
        image = IMAGES[service]
        if container.get("image") != image or container.get("image_id") != image_ids[image]:
            raise Blocked("Container image does not match the expected local image")
        if service.endswith("-permissions"):
            if container.get("status") != "exited" or container.get("exit_code") != 0:
                raise Blocked("Volume permission initialization has not completed")
        elif container.get("status") != "running":
            raise Blocked("A required container is not running")
        if service in {"postgres", "rabbitmq", "storage"} and container.get("health") != "healthy":
            raise Blocked("A required container health check is not healthy")
        if _mounts(container.get("mounts")) != expected_mounts[service]:
            raise Blocked("Container mounts are not exactly the isolated run mounts")
        attached = container.get("networks")
        if not isinstance(attached, dict) or set(attached) != {
            project + "_" + name for name in expected_networks[service]
        }:
            raise Blocked("Container network membership is not isolated")
        port_map = container.get("ports") or {}
        if not isinstance(port_map, dict):
            raise Blocked("Container port metadata is invalid")
        published = {key: value for key, value in port_map.items() if value}
        if service not in PORTS:
            if published:
                raise Blocked("An internal service has a published port")
            continue
        target = str(PORTS[service]) + "/tcp"
        if set(published) != {target} or not isinstance(published[target], list) or len(published[target]) != 1:
            raise Blocked("Unexpected host port bindings")
        binding = published[target][0]
        host_port = binding.get("HostPort") if isinstance(binding, dict) else None
        if (not isinstance(binding, dict) or binding.get("HostIp") != "127.0.0.1"
                or not isinstance(host_port, str) or not host_port.isascii()
                or not host_port.isdecimal() or not 1 <= int(host_port) <= 65535
                or int(host_port) in SHARED_PORTS or int(host_port) in used_ports):
            raise Blocked("Host port is not a distinct, non-shared loopback binding")
        used_ports.add(int(host_port))
        ports[service] = "127.0.0.1:" + host_port

    if not isinstance(networks, list) or len(networks) != len(NETWORKS):
        raise Blocked("Expected project networks are missing or duplicated")
    network_names = set()
    for network in networks:
        if not isinstance(network, dict):
            raise Blocked("Invalid network metadata")
        name = network.get("network")
        if (not isinstance(name, str) or name not in NETWORKS or name in network_names
                or network.get("project") != project
                or network.get("name") != project + "_" + name
                or network.get("internal") is not True or network.get("driver") != "bridge"):
            raise Blocked("Project network is not a labeled internal bridge")
        members = network.get("containers")
        expected = {
            by_service[service]["id"] for service, attached in expected_networks.items()
            if name in attached
        }
        if not isinstance(members, dict) or set(members) != expected:
            raise Blocked("Project network has unexpected or missing container members")
        network_names.add(name)

    if not isinstance(volumes, list) or len(volumes) != len(VOLUMES):
        raise Blocked("Expected project volumes are missing or duplicated")
    volume_names = set()
    for volume in volumes:
        if not isinstance(volume, dict):
            raise Blocked("Invalid volume metadata")
        name = volume.get("volume")
        if (not isinstance(name, str) or name not in VOLUMES or name in volume_names
                or volume.get("project") != project
                or volume.get("name") != project + "_" + name
                or volume.get("driver") != "local" or volume.get("scope") != "local"):
            raise Blocked("Project volume is not separately owned and labeled")
        users = volume.get("users")
        expected = {
            by_service[service]["id"] for service, mounts in expected_mounts.items()
            if any(item[0] == "volume" and item[1] == project + "_" + name for item in mounts)
        }
        if (not isinstance(users, list) or any(not isinstance(item, str) for item in users)
                or len(users) != len(set(users)) or set(users) != expected):
            raise Blocked("Project volume has unexpected or missing container users")
        volume_names.add(name)
    return ports


def _docker(*args: str) -> str:
    try:
        return subprocess.check_output(
            ["docker", *args], text=True, stderr=subprocess.DEVNULL, timeout=20,
        ).strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise Blocked("Docker metadata inspection is unavailable") from error


def _json_docker(*args: str) -> dict:
    try:
        value = json.loads(_docker(*args))
    except (ValueError, TypeError) as error:
        raise Blocked("Docker returned invalid metadata") from error
    if not isinstance(value, dict):
        raise Blocked("Docker returned invalid metadata")
    return value


def _inspect_verified(
    run_id: str,
    root: Path,
    *,
    runs_base: Path | None = None,
) -> tuple[dict[str, str], dict[str, str]]:
    project = "pi05-" + _run_id(run_id)
    _directory(root, private=True)
    identifiers = _docker(
        "ps", "-aq", "--no-trunc", "--filter", "label=com.docker.compose.project=" + project,
    ).splitlines()
    if any(re.fullmatch(r"[0-9a-f]{64}", value) is None for value in identifiers):
        raise Blocked("Docker returned invalid container identifiers")
    container_format = (
        '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
        '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
        '"image":{{json .Config.Image}},"image_id":{{json .Image}},'
        '"status":{{json .State.Status}},"exit_code":{{.State.ExitCode}},'
        '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},'
        '"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}},'
        '"networks":{{json .NetworkSettings.Networks}}}'
    )
    containers = [
        _json_docker("inspect", "--type", "container", "--format", container_format, identifier)
        for identifier in identifiers
    ]
    network_format = (
        '{"name":{{json .Name}},"internal":{{json .Internal}},"driver":{{json .Driver}},'
        '"project":{{json (index .Labels "com.docker.compose.project")}},'
        '"network":{{json (index .Labels "com.docker.compose.network")}},'
        '"containers":{{json .Containers}}}'
    )
    networks = [
        _json_docker("network", "inspect", "--format", network_format, project + "_" + name)
        for name in sorted(NETWORKS)
    ]
    volume_format = (
        '{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},'
        '"project":{{json (index .Labels "com.docker.compose.project")}},'
        '"volume":{{json (index .Labels "com.docker.compose.volume")}}}'
    )
    volumes = [
        _json_docker("volume", "inspect", "--format", volume_format, project + "_" + name)
        for name in sorted(VOLUMES)
    ]
    for volume in volumes:
        name = volume.get("name")
        if not isinstance(name, str) or name not in {project + "_" + value for value in VOLUMES}:
            raise Blocked("Docker returned an invalid project volume name")
        volume["users"] = _docker(
            "ps", "-aq", "--no-trunc", "--filter", "volume=" + name,
        ).splitlines()
    image_ids = {image: _docker("image", "inspect", "--format", "{{.Id}}", image)
                 for image in set(IMAGES.values())}
    if runs_base is None:
        ports = validate_topology(
            run_id,
            root,
            containers,
            networks,
            volumes,
            image_ids,
        )
    else:
        ports = validate_topology(
            run_id,
            root,
            containers,
            networks,
            volumes,
            image_ids,
            runs_base=runs_base,
        )
    container_ids = {
        container["service"]: container["id"]
        for container in containers
    }
    return ports, container_ids


def inspect_topology(
    run_id: str,
    root: Path,
    *,
    runs_base: Path | None = None,
) -> dict[str, str]:
    """Return verified loopback ports for the complete running foundation."""
    ports, _container_ids = _inspect_verified(run_id, root, runs_base=runs_base)
    return ports


def inspect_container_ids(
    run_id: str,
    root: Path,
    *,
    runs_base: Path | None = None,
) -> dict[str, str]:
    """Return verified infrastructure container IDs from one metadata snapshot."""
    _ports, container_ids = _inspect_verified(run_id, root, runs_base=runs_base)
    return container_ids


def inspect_container_state(
    run_id: str,
    root: Path,
    service: str,
    *,
    container_id: str,
) -> dict[str, str | int | None]:
    """Read one previously verified run-owned container after a fault.

    The complete topology validator intentionally requires required services to
    be running, so it cannot be used after a deliberate stop.  This narrower
    read is safe only with the container ID captured from a prior complete
    validation and re-checks the immutable Docker project/service/image labels.
    """
    project = "pi05-" + _run_id(run_id)
    _directory(root, private=True)
    if (
        not isinstance(service, str)
        or service not in IMAGES
        or not isinstance(container_id, str)
        or re.fullmatch(r"[0-9a-f]{64}", container_id) is None
    ):
        raise Blocked("Fault container identity is invalid")
    state_format = (
        '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
        '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
        '"image":{{json .Config.Image}},"status":{{json .State.Status}},'
        '"exit_code":{{.State.ExitCode}}}'
    )
    value = _json_docker(
        "inspect", "--type", "container", "--format", state_format, container_id,
    )
    if (
        value.get("id") != container_id
        or value.get("project") != project
        or value.get("service") != service
        or value.get("image") != IMAGES[service]
        or not isinstance(value.get("status"), str)
        or value.get("status") not in {"created", "running", "paused", "restarting", "removing", "exited", "dead"}
        or type(value.get("exit_code")) is not int
    ):
        raise Blocked("Fault container metadata is not run-owned")
    return {
        "id": value["id"],
        "service": value["service"],
        "status": value["status"],
        "exit_code": value["exit_code"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--runs-base", type=Path)
    args = parser.parse_args()
    try:
        ports = inspect_topology(args.run_id, args.run_root, runs_base=args.runs_base)
    except Blocked as error:
        print("BLOCKED:", error)
        return 1
    print("PASS: Docker ownership metadata only; live service and security checks remain required")
    for service, endpoint in sorted(ports.items()):
        print(service + " " + endpoint)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
