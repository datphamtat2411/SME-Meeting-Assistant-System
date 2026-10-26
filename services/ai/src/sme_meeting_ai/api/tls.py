"""Direct mTLS: attest only the verified peer on this Uvicorn connection."""

import re
import ssl
from contextvars import ContextVar
from datetime import UTC, datetime

from starlette.types import Scope
from uvicorn.protocols.http.h11_impl import H11Protocol

from sme_meeting_ai.core.config import (
    SERVICE_IDENTITY_PATTERN,
    ConfigurationError,
    Settings,
)

from .security import VerifiedServiceIdentity

_connection: ContextVar[ssl.SSLObject | None] = ContextVar("verified_tls_connection", default=None)
_SERVICE_URI_PREFIX = "urn:sme:service:"


def load_tls_context(settings: Settings) -> ssl.SSLContext | None:
    """Validate external TLS material before any listener can become ready."""
    paths = (settings.tls_cert_file, settings.tls_key_file, settings.tls_client_ca_file)
    if all(path is None for path in paths):
        return None
    try:
        if any(path is None for path in paths):
            raise ValueError("Incomplete TLS configuration")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.verify_mode = ssl.CERT_REQUIRED
        context.load_cert_chain(settings.tls_cert_file, settings.tls_key_file)
        # Do not load public/system CAs for internal client authentication.
        context.load_verify_locations(cafile=settings.tls_client_ca_file)
        context.set_alpn_protocols(["http/1.1"])
        return context
    except (OSError, ValueError, TypeError):
        pass
    raise ConfigurationError("TLS configuration unavailable")


class MTLSProtocol(H11Protocol):
    """Bind the real SSL transport to each ASGI task, never to client input.

    Keep this narrow integration covered by real TLS/keepalive tests when
    updating the locked Uvicorn version. WebSocket upgrades are disabled.
    """

    def connection_made(self, transport):
        super().connection_made(transport)
        connection = transport.get_extra_info("ssl_object")
        app = self.app

        async def verified_request(scope, receive, send):
            token = _connection.set(connection)
            try:
                await app(scope, receive, send)
            finally:
                _connection.reset(token)

        self.app = verified_request


class MTLSIdentitySource:
    async def identity_for(self, scope: Scope) -> VerifiedServiceIdentity | None:
        connection = _connection.get()
        if (
            not isinstance(connection, ssl.SSLObject)
            or connection.context.verify_mode != ssl.CERT_REQUIRED
            or scope.get("scheme") != "https"
        ):
            return None
        # OpenSSL has already checked the chain, certificate validity and client
        # purpose at handshake. Recheck expiry for long-lived connections.
        certificate = connection.getpeercert()
        if not certificate:
            return None
        identities = [
            value.removeprefix(_SERVICE_URI_PREFIX)
            for kind, value in certificate.get("subjectAltName", ())
            if kind == "URI" and value.startswith(_SERVICE_URI_PREFIX)
        ]
        if len(identities) != 1 or re.fullmatch(SERVICE_IDENTITY_PATTERN, identities[0]) is None:
            return None
        expires_at = datetime.fromtimestamp(ssl.cert_time_to_seconds(certificate["notAfter"]), UTC)
        if expires_at <= datetime.now(UTC):
            return None
        return VerifiedServiceIdentity(
            principal=identities[0], certificate_verified=True,
            request_scope=scope, expires_at=expires_at,
        )
