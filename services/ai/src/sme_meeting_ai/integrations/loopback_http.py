"""Process-local HTTPS routing that preserves the logical TLS origin."""

from __future__ import annotations

from collections.abc import Iterable

import httpcore
from httpx._transports.default import AsyncHTTPTransport, HTTPTransport


def _validate_route(connect_host: str, server_hostname: str) -> None:
    if connect_host != "127.0.0.1" or server_hostname != "core-api.internal":
        raise ValueError("Invalid isolated Core API route")


class _LoopbackSyncBackend(httpcore.SyncBackend):
    def __init__(self, connect_host: str, server_hostname: str):
        _validate_route(connect_host, server_hostname)
        self._connect_host = connect_host
        self._server_hostname = server_hostname
        self._backend = httpcore.SyncBackend()

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[tuple] | None = None,
    ):
        if host != self._server_hostname:
            raise ValueError("Core API route changed its TLS identity")
        return self._backend.connect_tcp(
            self._connect_host,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    def connect_unix_socket(self, path: str, timeout: float | None = None, socket_options=None):
        raise ValueError("Core API route cannot use a Unix socket")

    def sleep(self, seconds: float) -> None:
        return self._backend.sleep(seconds)


class _LoopbackAsyncBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, connect_host: str, server_hostname: str):
        _validate_route(connect_host, server_hostname)
        self._connect_host = connect_host
        self._server_hostname = server_hostname
        self._backend = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[tuple] | None = None,
    ):
        if host != self._server_hostname:
            raise ValueError("Core API route changed its TLS identity")
        return await self._backend.connect_tcp(
            self._connect_host,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    async def connect_unix_socket(self, path: str, timeout: float | None = None, socket_options=None):
        raise ValueError("Core API route cannot use a Unix socket")

    async def sleep(self, seconds: float) -> None:
        await self._backend.sleep(seconds)


class LoopbackHTTPTransport(HTTPTransport):
    """Synchronous HTTPX transport with loopback-only destination routing."""

    def __init__(self, *, connect_host: str, server_hostname: str, **kwargs):
        _validate_route(connect_host, server_hostname)
        super().__init__(**kwargs)
        if not isinstance(self._pool, httpcore.ConnectionPool):
            raise ValueError("Core API loopback transport cannot use a proxy")
        self._pool._network_backend = _LoopbackSyncBackend(connect_host, server_hostname)


class LoopbackAsyncHTTPTransport(AsyncHTTPTransport):
    """Asynchronous HTTPX transport with loopback-only destination routing."""

    def __init__(self, *, connect_host: str, server_hostname: str, **kwargs):
        _validate_route(connect_host, server_hostname)
        super().__init__(**kwargs)
        if not isinstance(self._pool, httpcore.AsyncConnectionPool):
            raise ValueError("Core API loopback transport cannot use a proxy")
        self._pool._network_backend = _LoopbackAsyncBackend(connect_host, server_hostname)


__all__ = ["LoopbackAsyncHTTPTransport", "LoopbackHTTPTransport"]
