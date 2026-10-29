"""Fail-closed internal security backed exclusively by a trusted mTLS adapter.

No HTTP credential or forwarding-header parser is provided here. The deployment
must inject an in-process identity source at application construction. An ASGI
TLS adapter must verify the client chain and certificate validity, derive the
canonical principal from its authenticated certificate identity, and bind the
attestation to the current request scope. It must never infer verification from
headers, a bearer/user token, client address, or an arbitrary scope identity field.

An ingress-backed adapter has the same contract: identity forwarding must be
protected, stripped of client overrides, and impossible to bypass via direct
access. Merely placing a proxy in front of this application does not satisfy it.
TLS and ingress deployment are intentionally outside this module.
"""

import logging
import re
from collections.abc import Callable, Coroutine, Mapping, Set
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any, Protocol

from fastapi import HTTPException, Request
from starlette.types import Scope

from sme_meeting_ai.core.config import SERVICE_IDENTITY_PATTERN
from sme_meeting_ai.observability import log_event

logger = logging.getLogger("sme_meeting_ai.security")
OperationPolicy = Mapping[str, Set[str]]


@dataclass(frozen=True)
class VerifiedServiceIdentity:
    """Request-local certificate attestation, minted only by the trusted source.

    expires_at must not outlive the verified certificate or ingress attestation.
    A cached identity from another request is never accepted.
    """

    principal: str
    certificate_verified: bool
    request_scope: Scope = field(repr=False, compare=False)
    expires_at: datetime


class TrustedIdentitySource(Protocol):
    """Trusted ASGI integration; return None when no verified peer is present.

    Implementations must enforce the trust contract in this module's docstring.
    Only application wiring can supply this source; HTTP input cannot select it.
    """

    async def identity_for(self, scope: Scope) -> VerifiedServiceIdentity | None: ...


def identity_source_available(source: TrustedIdentitySource | None) -> bool:
    return callable(getattr(source, "identity_for", None))


def snapshot_policy(policy: OperationPolicy | None) -> OperationPolicy:
    """Copy explicit grants so external mutation cannot expand permissions."""
    return MappingProxyType({
        operation: frozenset(callers) for operation, callers in (policy or {}).items()
    })


def _valid_identity(identity: object, scope: Scope) -> bool:
    return (
        isinstance(identity, VerifiedServiceIdentity)
        and identity.certificate_verified is True
        and identity.request_scope is scope
        and isinstance(identity.principal, str)
        and len(identity.principal) <= 63
        and re.fullmatch(SERVICE_IDENTITY_PATTERN, identity.principal) is not None
        and isinstance(identity.expires_at, datetime)
        and identity.expires_at.tzinfo is not None
        and identity.expires_at.utcoffset() is not None
        and identity.expires_at > datetime.now(UTC)
    )


def require_internal_operation(
    operation: str,
) -> Callable[[Request], Coroutine[Any, Any, VerifiedServiceIdentity]]:
    """Require a verified caller and an exact, code-defined operation grant."""

    async def authorize(request: Request) -> VerifiedServiceIdentity:
        source = request.app.state.identity_source
        if not identity_source_available(source):
            log_event(logger, logging.ERROR, "security.integration_unavailable")
            raise HTTPException(503)

        unavailable = False
        try:
            identity = await source.identity_for(request.scope)
        except Exception:
            # Discard adapter errors before raising; never retain secret context.
            unavailable = True
        if unavailable:
            log_event(logger, logging.ERROR, "security.integration_unavailable")
            raise HTTPException(503)

        if not _valid_identity(identity, request.scope):
            log_event(logger, logging.WARNING, "security.authentication_failed")
            raise HTTPException(401)

        allowed = request.app.state.operation_policy.get(operation, frozenset())
        if (
            not operation or operation == "*"
            or identity.principal != "core-api"
            or identity.principal not in request.app.state.settings.internal_allowed_callers
            or identity.principal not in allowed
        ):
            log_event(logger, logging.WARNING, "security.authorization_denied")
            raise HTTPException(403)

        log_event(logger, logging.INFO, "security.access_granted")
        return identity

    return authorize
