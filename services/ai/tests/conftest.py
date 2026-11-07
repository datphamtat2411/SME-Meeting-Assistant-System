import ipaddress
import socket

import pytest
from tls_support import create_test_pki


@pytest.fixture(autouse=True)
def block_external_network(request, monkeypatch):
    """Mandatory tests may use local test servers, but never external services."""
    if request.node.get_closest_marker("live_provider") or request.node.get_closest_marker("live_infrastructure"):
        return
    connect = socket.socket.connect
    connect_ex = socket.socket.connect_ex

    def check(sock, address):
        if sock.family not in (socket.AF_INET, socket.AF_INET6):
            return
        host = address[0]
        try:
            local = ipaddress.ip_address(host).is_loopback
        except ValueError:
            local = host.lower() == "localhost"
        if not local:
            raise AssertionError("External network access is forbidden in mandatory tests")

    def guarded_connect(sock, address):
        check(sock, address)
        return connect(sock, address)

    def guarded_connect_ex(sock, address):
        check(sock, address)
        return connect_ex(sock, address)

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", guarded_connect_ex)


@pytest.fixture(scope="session")
def test_pki(tmp_path_factory):
    return create_test_pki(tmp_path_factory.mktemp("test-pki"))
