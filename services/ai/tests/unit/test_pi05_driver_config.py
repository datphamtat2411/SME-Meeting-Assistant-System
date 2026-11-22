"""PI-05 driver configuration is bounded and never starts live work in unit tests."""

import pytest
from integration import test_pi05_live as driver


@pytest.fixture
def configured_driver(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_RUN_PI05_LIVE", "1")
    monkeypatch.setenv("AI_PI05_ENVIRONMENT_KIND", "DISPOSABLE")
    monkeypatch.setenv("AI_PI05_HARNESS_URL", "https://localhost:12345")
    monkeypatch.setenv("AI_PI05_EVIDENCE_DIR", str(tmp_path))
    monkeypatch.setenv("AI_PI05_PROOF_DIR", str(tmp_path))
    monkeypatch.delenv("AI_PI05_SCENARIO_TIMEOUT_SECONDS", raising=False)
    for name in ("AI_PI05_CA_FILE", "AI_PI05_CERT_FILE", "AI_PI05_KEY_FILE"):
        path = tmp_path / name
        path.write_text("unit-only placeholder")
        monkeypatch.setenv(name, str(path))

    calls = []
    monkeypatch.setattr(driver.httpx, "Client", lambda **kwargs: calls.append(kwargs) or object())
    return calls


def test_default_scenario_timeout_preserves_existing_behavior(configured_driver):
    driver._client()
    assert configured_driver[0]["timeout"] == 60
    assert configured_driver[0]["trust_env"] is False
    assert configured_driver[0]["follow_redirects"] is False


@pytest.mark.parametrize("timeout", ["60", "900", "14400"])
def test_scenario_timeout_can_be_bounded_for_real_processing(configured_driver, monkeypatch, timeout):
    monkeypatch.setenv("AI_PI05_SCENARIO_TIMEOUT_SECONDS", timeout)
    driver._client()
    assert configured_driver[0]["timeout"] == int(timeout)


@pytest.mark.parametrize("timeout", ["", "0", "59", "14401", "-1", "1.5", "nan", "1e3", " 900", "９００"])
def test_invalid_scenario_timeout_fails_before_client_creation(configured_driver, monkeypatch, timeout):
    monkeypatch.setenv("AI_PI05_SCENARIO_TIMEOUT_SECONDS", timeout)
    with pytest.raises(pytest.fail.Exception, match="scenario timeout"):
        driver._client()
    assert not configured_driver
