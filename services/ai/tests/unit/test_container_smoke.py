import json
from types import SimpleNamespace

import container_smoke as smoke
import pytest


def test_smoke_diagnostics_keep_only_known_lifecycle_events():
    private = "private-key-and-transcript"
    logs = "\n".join([private, json.dumps({"event": "worker.startup.failed", "body": private}),
                      json.dumps({"event": private}), "Traceback (most recent call last):"])
    diagnostic = smoke.diagnostics(logs)
    assert private not in diagnostic
    assert "worker.startup.failed" in diagnostic and "traceback=True" in diagnostic


def test_negative_smoke_assertion_identifies_role_phase_exit_and_events(monkeypatch):
    def docker(operation, *args):
        return {"wait": "0", "logs": '{"event":"worker.started","secret":"never-print"}'}[operation]
    monkeypatch.setattr(smoke, "docker", docker)
    with pytest.raises(AssertionError) as caught:
        smoke.assert_exit("container", "sme-ai-worker", "provider", "1", {"worker.startup.failed"})
    message = str(caught.value)
    for expected in ("sme-ai-worker", "provider", "expected_exit=1", "actual_exit=0",
                     "worker.started", "worker.startup.failed"):
        assert expected in message
    assert "never-print" not in message


def test_docker_logs_collect_both_container_streams_without_printing(monkeypatch, capsys):
    monkeypatch.setattr(smoke.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        returncode=0, stdout='{"event":"worker.starting"}\n', stderr="http.runtime.failed\n",
    ))
    assert set(smoke.lifecycle_events(smoke.docker("logs", "container"))) == {
        "worker.starting", "http.runtime.failed",
    }
    assert capsys.readouterr().out == ""
