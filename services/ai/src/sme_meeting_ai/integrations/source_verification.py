"""Synchronous mTLS adapter for Core-authoritative retrieval freshness checks."""

from __future__ import annotations

import ssl
from datetime import datetime
from uuid import uuid4

import httpx
from pydantic import ValidationError

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.rag.retrieval_contracts import (
    SourceVerification,
    SourceVerificationRequest,
)

from .core_api import strict_json


class CoreSourceVerificationError(RuntimeError):
    """Safe, provider-facing failure without exposing HTTP response details."""

    def __init__(self, category: str = "SOURCE_VERIFICATION_UNAVAILABLE"):
        self.category = category
        super().__init__(category)


class CoreSourceVerificationProvider:
    """Verify source identity/revision against Core, never against Qdrant metadata."""

    provider_id = "core-mtls"
    _MAX_RESPONSE_BYTES = 64 * 1024
    _PATH = "/internal/v1/worker/knowledge-indexing/source-verification"

    def __init__(self, settings: Settings, *, client: httpx.Client | None = None):
        self.settings = settings
        self._owned = client is None
        if client is not None:
            self.http = client
            return
        if not all((settings.core_api_base_url, settings.core_api_server_ca_file,
                    settings.core_api_client_cert_file, settings.core_api_client_key_file)):
            raise CoreSourceVerificationError("SOURCE_VERIFICATION_UNAVAILABLE")
        try:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_verify_locations(cafile=str(settings.core_api_server_ca_file))
            context.load_cert_chain(
                str(settings.core_api_client_cert_file), str(settings.core_api_client_key_file)
            )
            self.http = httpx.Client(verify=context, trust_env=False, follow_redirects=False)
        except Exception as error:
            raise CoreSourceVerificationError("SOURCE_VERIFICATION_UNAVAILABLE") from error

    def verify(
        self,
        requests: tuple[SourceVerificationRequest, ...] | list[SourceVerificationRequest],
        *,
        now: datetime,
        timeout_seconds: float,
    ) -> tuple[SourceVerification, ...]:
        del now
        request_tuple = tuple(requests)
        if not request_tuple or len(request_tuple) > 256 or timeout_seconds <= 0:
            raise CoreSourceVerificationError("SOURCE_VERIFICATION_INCOMPLETE")
        body = {
            "contractVersion": "1.0",
            "requests": [request.model_dump(mode="json", by_alias=True) for request in request_tuple],
        }
        try:
            response = self.http.post(
                (self.settings.core_api_base_url or "https://core.invalid") + self._PATH,
                json=body,
                headers={"X-Request-Id": str(uuid4())},
                timeout=timeout_seconds,
            )
            if response.status_code != 200:
                raise CoreSourceVerificationError("SOURCE_VERIFICATION_UNAVAILABLE")
            if "no-store" not in {
                value.strip() for value in response.headers.get("cache-control", "").lower().split(",")
            }:
                raise CoreSourceVerificationError("SOURCE_VERIFICATION_UNAVAILABLE")
            if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise CoreSourceVerificationError("SOURCE_VERIFICATION_UNAVAILABLE")
            raw = response.content
            if len(raw) > self._MAX_RESPONSE_BYTES:
                raise CoreSourceVerificationError("SOURCE_VERIFICATION_INCOMPLETE")
            envelope = strict_json(raw, self._MAX_RESPONSE_BYTES)
            if not isinstance(envelope, dict) or envelope.get("success") is not True:
                raise CoreSourceVerificationError("SOURCE_VERIFICATION_UNAVAILABLE")
            data = envelope.get("data")
            if not isinstance(data, dict) or data.get("contractVersion") != "1.0":
                raise CoreSourceVerificationError("SOURCE_VERIFICATION_INCOMPLETE")
            records = data.get("records")
            if not isinstance(records, list) or len(records) != len(request_tuple):
                raise CoreSourceVerificationError("SOURCE_VERIFICATION_INCOMPLETE")
            return tuple(SourceVerification.model_validate(record) for record in records)
        except CoreSourceVerificationError:
            raise
        except (httpx.HTTPError, TimeoutError, ValueError, TypeError, KeyError, RecursionError, ValidationError) as error:
            raise CoreSourceVerificationError("SOURCE_VERIFICATION_UNAVAILABLE") from error

    def close(self) -> None:
        if self._owned:
            self.http.close()
