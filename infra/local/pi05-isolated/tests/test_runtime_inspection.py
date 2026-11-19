"""Read-only isolation checks over synthetic, non-deployment Docker metadata."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path
import sys

import pytest

HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[2]
RUN_ID = "f07ae202-e358-48e6-8d88-a66f2cb88211"
PROJECT = "pi05-" + RUN_ID

preflight_spec = importlib.util.spec_from_file_location("preflight", HERE / "preflight.py")
preflight = importlib.util.module_from_spec(preflight_spec)
preflight_spec.loader.exec_module(preflight)
sys.modules["preflight"] = preflight
spec = importlib.util.spec_from_file_location("runtime_inspection", HERE / "runtime_inspection.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def snapshot(tmp_path):
    base = tmp_path / "runs"
    root = base / RUN_ID
    project = PROJECT
    image_ids = {image: "sha256:" + str(index) * 64 for index, image in enumerate(
        ("postgres:17", "rabbitmq:4.1-management", "rustfs/rustfs:1.0.3",
         "nginx:1.28-alpine", "qdrant/qdrant:v1.20.0", "alpine:3.22"), start=1
    )}

    def volume(name, destination):
        return {"Type": "volume", "Name": project + "_" + name,
                "Destination": destination, "Source": "/unit/volume", "RW": True}

    def bind(source, destination):
        return {"Type": "bind", "Name": "", "Destination": destination,
                "Source": str(source), "RW": False}

    repo = ROOT / "infra/local/secure-integration"
    tls = root / "pki"
    integration = project + "_integration"
    backend = project + "_storage-backend"
    definitions = {
        "postgres": ("postgres:17", 5432, [volume("postgres_data", "/var/lib/postgresql/data")],
                     [integration], "healthy"),
        "rabbitmq": ("rabbitmq:4.1-management", 5671, [
            volume("broker_data", "/var/lib/rabbitmq"),
            bind(repo / "rabbitmq.conf", "/etc/rabbitmq/rabbitmq.conf"),
            bind(repo / "enabled_plugins", "/etc/rabbitmq/enabled_plugins"),
            bind(tls / "broker-server", "/run/secrets/broker"),
        ], [integration], "healthy"),
        "storage": ("rustfs/rustfs:1.0.3", None, [
            volume("storage_data", "/data"),
            bind(tls / "storage-server", "/run/secrets/storage"),
        ], [backend], "healthy"),
        "storage-boundary": ("nginx:1.28-alpine", 9000, [
            bind(repo / "storage-boundary.conf", "/etc/nginx/storage-boundary.conf"),
            bind(tls / "storage-server", "/run/secrets/storage"),
        ], [integration, backend], None),
        "qdrant": ("qdrant/qdrant:v1.20.0", 6333, [
            volume("qdrant_data", "/qdrant/storage"),
            bind(tls / "qdrant-server", "/run/secrets/qdrant"),
        ], [integration], None),
        "storage-permissions": ("alpine:3.22", None, [volume("storage_data", "/data")], [], None),
        "qdrant-permissions": ("alpine:3.22", None, [volume("qdrant_data", "/data")], [], None),
    }
    containers = []
    for index, (service, (image, port, mounts, attached, health)) in enumerate(definitions.items(), start=1):
        containers.append({
            "id": f"{index:064x}",
            "project": project,
            "service": service,
            "image": image,
            "image_id": image_ids[image],
            "status": "exited" if service.endswith("-permissions") else "running",
            "exit_code": 0,
            "health": health,
            "ports": {f"{port}/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(50000 + index)}]}
                     if port else {},
            "mounts": mounts,
            "networks": {name: {} for name in attached},
        })
    networks = [
        {"name": project + "_" + name, "internal": True, "driver": "bridge",
         "project": project, "network": name,
         "containers": {
             item["id"]: {} for item in containers if project + "_" + name in item["networks"]
         }}
        for name in ("integration", "storage-backend")
    ]
    volumes = [
        {"name": project + "_" + name, "driver": "local", "scope": "local",
         "project": project, "volume": name,
         "users": [
             item["id"] for item in containers
             if any(mount["Type"] == "volume" and mount["Name"] == project + "_" + name
                    for mount in item["mounts"])
         ]}
        for name in ("postgres_data", "broker_data", "storage_data", "qdrant_data")
    ]
    return base, root, containers, networks, volumes, image_ids


def validate(data):
    base, root, containers, networks, volumes, image_ids = data
    return runtime.validate_topology(
        RUN_ID, root, containers, networks, volumes, image_ids, runs_base=base,
    )


def test_accepts_exact_owned_metadata_without_claiming_application_health(tmp_path):
    data = snapshot(tmp_path)
    ports = validate(data)
    assert set(ports) == {"postgres", "rabbitmq", "storage-boundary", "qdrant"}
    assert all(value.startswith("127.0.0.1:") for value in ports.values())


def test_inspection_returns_verified_container_ids(tmp_path, monkeypatch):
    base, root, containers, networks, volumes, image_ids = snapshot(tmp_path)
    monkeypatch.setattr(runtime, "_directory", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runtime.Path, "home", lambda: tmp_path)

    def docker(*args):
        if args[:2] == ("ps", "-aq"):
            filter_value = args[-1]
            if filter_value.startswith("label="):
                return "\n".join(item["id"] for item in containers)
            volume_name = filter_value.removeprefix("volume=")
            return "\n".join(next(item["users"] for item in volumes if item["name"] == volume_name))
        if args[:2] == ("image", "inspect"):
            return image_ids[args[-1]]
        raise AssertionError(args)

    def docker_json(*args):
        if args[0] == "inspect":
            return next(item for item in containers if item["id"] == args[-1])
        if args[:2] == ("network", "inspect"):
            return next(item for item in networks if item["name"] == args[-1])
        if args[:2] == ("volume", "inspect"):
            return dict(next(item for item in volumes if item["name"] == args[-1]))
        raise AssertionError(args)

    monkeypatch.setattr(runtime, "_docker", docker)
    monkeypatch.setattr(runtime, "_json_docker", docker_json)
    original = runtime.validate_topology
    monkeypatch.setattr(
        runtime,
        "validate_topology",
        lambda *args: original(*args, runs_base=base),
    )

    identifiers = runtime.inspect_container_ids(RUN_ID, root)

    assert identifiers == {item["service"]: item["id"] for item in containers}


def test_inspection_queries_network_members_and_all_volume_users(tmp_path, monkeypatch):
    base, root, containers, networks, volumes, image_ids = snapshot(tmp_path)
    monkeypatch.setattr(runtime, "_directory", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runtime.Path, "home", lambda: tmp_path)
    calls = []

    def docker(*args):
        calls.append(args)
        if args[:2] == ("ps", "-aq"):
            filter_value = args[-1]
            if filter_value.startswith("label="):
                return "\n".join(item["id"] for item in containers)
            volume_name = filter_value.removeprefix("volume=")
            return "\n".join(next(item["users"] for item in volumes if item["name"] == volume_name))
        if args[:2] == ("image", "inspect"):
            return image_ids[args[-1]]
        raise AssertionError(args)

    def docker_json(*args):
        if args[0] == "inspect":
            return next(item for item in containers if item["id"] == args[-1])
        if args[:2] == ("network", "inspect"):
            assert '"containers":{{json .Containers}}' in args[-2]
            return next(item for item in networks if item["name"] == args[-1])
        if args[:2] == ("volume", "inspect"):
            return dict(next(item for item in volumes if item["name"] == args[-1]))
        raise AssertionError(args)

    monkeypatch.setattr(runtime, "_docker", docker)
    monkeypatch.setattr(runtime, "_json_docker", docker_json)
    # The validator uses its production base; patch it only for this synthetic snapshot.
    original = runtime.validate_topology
    monkeypatch.setattr(runtime, "validate_topology",
                        lambda *args: original(*args, runs_base=base))
    assert set(runtime.inspect_topology(RUN_ID, root)) == {
        "postgres", "rabbitmq", "storage-boundary", "qdrant"
    }
    assert sum(args[-1].startswith("volume=") for args in calls) == 4


@pytest.mark.parametrize(
    "change",
    ["foreign-volume", "foreign-bind", "writable-bind", "extra-mount", "wildcard-port",
     "extra-port", "shared-port", "wrong-project", "duplicate-service", "wrong-image",
     "wrong-image-id", "unhealthy", "backend-leak", "foreign-network", "noninternal-network",
     "unlabelled-volume", "foreign-root", "permission-container-running",
     "malformed-service", "malformed-network", "normalized-duplicate-port",
     "foreign-network-member", "missing-network-member", "malformed-network-members",
     "foreign-volume-user", "missing-volume-user", "duplicate-volume-user"],
)
def test_rejects_unsafe_or_incomplete_metadata(tmp_path, change):
    data = list(copy.deepcopy(snapshot(tmp_path)))
    base, root, containers, networks, volumes, image_ids = data
    by_service = {item["service"]: item for item in containers}
    if change == "foreign-volume":
        by_service["postgres"]["mounts"][0]["Name"] = "sme-meeting-local_postgres_data"
    elif change == "foreign-bind":
        by_service["rabbitmq"]["mounts"][-1]["Source"] = "/home/dev/.local/share/sme-secure-integration-pki/broker-server"
    elif change == "writable-bind":
        by_service["rabbitmq"]["mounts"][-1]["RW"] = True
    elif change == "extra-mount":
        by_service["qdrant"]["mounts"].append({"Type": "bind", "Source": "/",
                                               "Destination": "/host", "RW": False})
    elif change == "wildcard-port":
        by_service["qdrant"]["ports"]["6333/tcp"][0]["HostIp"] = "0.0.0.0"
    elif change == "extra-port":
        by_service["rabbitmq"]["ports"]["5672/tcp"] = [{"HostIp": "127.0.0.1", "HostPort": "50088"}]
    elif change == "shared-port":
        by_service["postgres"]["ports"]["5432/tcp"][0]["HostPort"] = "5433"
    elif change == "wrong-project":
        by_service["qdrant"]["project"] = "sme-meeting-secure-integration"
    elif change == "duplicate-service":
        containers.append(copy.deepcopy(by_service["qdrant"]))
    elif change == "wrong-image":
        by_service["qdrant"]["image"] = "qdrant/qdrant:latest"
    elif change == "wrong-image-id":
        by_service["qdrant"]["image_id"] = "sha256:" + "a" * 64
    elif change == "unhealthy":
        by_service["rabbitmq"]["health"] = "unhealthy"
    elif change == "backend-leak":
        by_service["storage"]["networks"][PROJECT + "_integration"] = {}
    elif change == "foreign-network":
        by_service["qdrant"]["networks"]["bridge"] = {}
    elif change == "noninternal-network":
        networks[0]["internal"] = False
    elif change == "unlabelled-volume":
        volumes[0]["project"] = None
    elif change == "foreign-root":
        data[1] = tmp_path / "shared"
    elif change == "permission-container-running":
        by_service["qdrant-permissions"]["status"] = "running"
    elif change == "malformed-service":
        by_service["qdrant"]["service"] = []
    elif change == "malformed-network":
        networks[0]["network"] = []
    elif change == "normalized-duplicate-port":
        postgres_port = by_service["postgres"]["ports"]["5432/tcp"][0]["HostPort"]
        by_service["qdrant"]["ports"]["6333/tcp"][0]["HostPort"] = "0" + postgres_port
    elif change == "foreign-network-member":
        networks[0]["containers"]["f" * 64] = {}
    elif change == "missing-network-member":
        networks[0]["containers"].pop(by_service["qdrant"]["id"])
    elif change == "malformed-network-members":
        networks[0]["containers"] = []
    elif change == "foreign-volume-user":
        volumes[0]["users"].append("f" * 64)
    elif change == "missing-volume-user":
        volumes[0]["users"].clear()
    elif change == "duplicate-volume-user":
        volumes[0]["users"].append(volumes[0]["users"][0])
    with pytest.raises(preflight.Blocked):
        validate(data)
