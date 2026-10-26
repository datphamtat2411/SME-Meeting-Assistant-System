import asyncio
import ssl

import pytest

from sme_meeting_ai.api.tls import MTLSIdentitySource, load_tls_context
from sme_meeting_ai.core.config import ConfigurationError, Settings


def test_arbitrary_scope_and_headers_cannot_mint_transport_identity():
    scope = {
        "type": "http", "scheme": "https",
        "client_cert": {"subjectAltName": [("URI", "urn:sme:service:core-api")]},
        "certificate_verified": True,
        "headers": [(b"x-service-identity", b"core-api"), (b"x-client-verified", b"true")],
    }
    assert asyncio.run(MTLSIdentitySource().identity_for(scope)) is None


def test_tls_context_requires_certificates_and_only_the_explicit_client_ca(test_pki):
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        tls_cert_file=test_pki / "server.crt", tls_key_file=test_pki / "server.key",
        tls_client_ca_file=test_pki / "ca.crt",
    )
    context = load_tls_context(settings)
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.minimum_version >= ssl.TLSVersion.TLSv1_2
    assert len(context.get_ca_certs()) == 1


def test_invalid_external_tls_material_is_sanitized(tmp_path):
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        tls_cert_file=tmp_path / "private-path", tls_key_file=tmp_path / "key",
        tls_client_ca_file=tmp_path / "ca",
    )
    with pytest.raises(ConfigurationError) as caught:
        load_tls_context(settings)
    assert str(caught.value) == "TLS configuration unavailable"
    assert caught.value.__context__ is None


def test_plain_local_runtime_has_no_tls_context():
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None)
    assert load_tls_context(settings) is None
