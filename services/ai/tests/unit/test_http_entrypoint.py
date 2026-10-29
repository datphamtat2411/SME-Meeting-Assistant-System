import asyncio
import signal
import ssl
from types import SimpleNamespace

import pytest

from sme_meeting_ai.api import __main__ as entrypoint
from sme_meeting_ai.core.config import ConfigurationError, Settings


@pytest.fixture
def selected(monkeypatch):
    settings = Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        http_host="0.0.0.0", http_port=9000, http_shutdown_timeout_seconds=12.5,
    )
    monkeypatch.setattr(entrypoint, "load_settings", lambda: settings)
    return settings


def test_configuration_failure_never_starts_server(monkeypatch, capsys):
    def fail():
        raise ConfigurationError("private-value")

    monkeypatch.setattr(entrypoint, "load_settings", fail)
    monkeypatch.setattr(entrypoint.uvicorn, "Server", lambda config: pytest.fail("started"))
    assert entrypoint.main() == 1
    assert capsys.readouterr().err == "http.configuration.failed\n"


def test_server_options_and_graceful_signal_restoration(selected, monkeypatch):
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}

    class Server:
        def __init__(self, config):
            self.started = True
            assert config.host == "0.0.0.0"
            assert config.port == 9000
            assert config.workers == 1
            assert config.reload is False
            assert config.access_log is False
            assert config.proxy_headers is False
            assert config.forwarded_allow_ips == []
            assert config.timeout_graceful_shutdown == 12.5
            assert config.lifespan == "on"
            assert config.log_level == "critical"
            assert config.app.state.settings is selected

        def handle_exit(self, signum, frame):
            self.should_exit = True

        def run(self):
            # Uvicorn replays captured signals after completing graceful shutdown.
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            assert self.should_exit

    monkeypatch.setattr(entrypoint.uvicorn, "Server", Server)
    assert entrypoint.main() == 0
    assert all(signal.getsignal(sig) == handler for sig, handler in previous.items())


@pytest.mark.parametrize("failure", [RuntimeError("private-value"), SystemExit(3)])
def test_runtime_startup_failures_are_sanitized(selected, monkeypatch, capsys, failure):
    def fail():
        raise failure

    server = SimpleNamespace(run=fail, handle_exit=lambda *args: None, started=False)
    monkeypatch.setattr(entrypoint.uvicorn, "Server", lambda config: server)
    assert entrypoint.main() == 1
    assert capsys.readouterr().err == "http.runtime.failed\n"


def test_unstarted_server_returns_nonzero(selected, monkeypatch, capsys):
    server = SimpleNamespace(run=lambda: None, handle_exit=lambda *args: None, started=False)
    monkeypatch.setattr(entrypoint.uvicorn, "Server", lambda config: server)
    assert entrypoint.main() == 1
    assert capsys.readouterr().err == "http.runtime.failed\n"


def test_production_tls_wiring_is_required_and_has_no_plaintext_listener(
    selected, monkeypatch, test_pki,
):
    selected.environment = "production"
    selected.tls_cert_file = test_pki / "server.crt"
    selected.tls_key_file = test_pki / "server.key"
    selected.tls_client_ca_file = test_pki / "ca.crt"

    class Server:
        started = True

        def __init__(self, config):
            from sme_meeting_ai.api.tls import MTLSIdentitySource, MTLSProtocol

            assert config.http is MTLSProtocol
            assert config.ws == "none"
            context = config.ssl_context_factory(config, None)
            assert context.verify_mode == ssl.CERT_REQUIRED
            assert isinstance(config.app.state.identity_source, MTLSIdentitySource)

        def handle_exit(self, *args):
            pass

        def run(self):
            pass

    monkeypatch.setattr(entrypoint.uvicorn, "Server", Server)
    assert entrypoint.main() == 0


@pytest.mark.parametrize("environment", ["production", "staging"])
def test_launcher_application_fails_closed_before_readiness(
    selected, monkeypatch, capsys, environment,
):
    selected.environment = environment

    class Server:
        started = False

        def __init__(self, config):
            self.app = config.app

        def handle_exit(self, *args):
            pass

        def run(self):
            async def startup():
                assert self.app.state.runtime.initialized is False
                async with self.app.router.lifespan_context(self.app):
                    pytest.fail("insecure startup")

            asyncio.run(startup())

    monkeypatch.setattr(entrypoint.uvicorn, "Server", Server)
    assert entrypoint.main() == 1
    assert capsys.readouterr().err == "http.runtime.failed\n"
