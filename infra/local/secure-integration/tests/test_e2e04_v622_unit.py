"""Offline safeguards for production-composed deterministic V6.2.2 acceptance."""

import json
from contextlib import ExitStack
from uuid import uuid4

import httpx
import pytest
import test_worker_e2e04 as e2e
from e2e04_v622_composition import (
    MODEL,
    SYNTHETIC_KEY,
    controlled_v622_boundaries,
)

from sme_meeting_ai.audio import (
    AudioEvidenceDetector,
    AudioNormalizer,
    AudioSource,
    SpeechMapBuilder,
)
from sme_meeting_ai.audio.vad import SileroVadBackend
from sme_meeting_ai.core.config import Environment, Settings
from sme_meeting_ai.pipeline import (
    AudioPreprocessingPipeline,
    OfflineTranscriptionPipeline,
)
from sme_meeting_ai.providers.openrouter_instruction_llm_v62 import (
    OpenRouterInstructionLlmV62Adapter,
)
from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
from sme_meeting_ai.transcription.chunk_planning import SpeechAwareAsrChunkPlanner


@pytest.fixture(autouse=True)
def isolate_ai_environment(monkeypatch):
    import os

    for name in tuple(os.environ):
        if name.startswith("AI_") or name == "OPENROUTER_API_KEY":
            monkeypatch.delenv(name)


def configuration(tmp_path, **updates):
    return Settings(service_name="v622-unit", service_identity="ai-worker", environment="test",
                    audio_temp_dir=tmp_path, OPENROUTER_API_KEY=SYNTHETIC_KEY,
                    transcript_correction_mode="v62_edits", transcript_correction_model=MODEL,
                    _env_file=None, **updates)


@pytest.mark.parametrize("environment", [Environment.DEVELOPMENT, Environment.STAGING, Environment.PRODUCTION])
def test_v622_controls_are_test_environment_only(tmp_path, environment):
    original_client, original_vad = httpx.Client, SileroVadBackend.from_settings
    settings = configuration(tmp_path).model_copy(update={"environment": environment})
    with pytest.raises(ValueError, match="test environment"):
        with controlled_v622_boundaries(settings, case="sparse"):
            pytest.fail("non-test controls activated")
    assert httpx.Client is original_client and SileroVadBackend.from_settings == original_vad


def test_v622_controls_require_synthetic_credentials_and_correct_selector(tmp_path):
    settings = configuration(tmp_path)
    for update in ({"openrouter_api_key": None}, {"transcript_correction_mode": "v5_full"},
                   {"transcript_correction_model": "unapproved/model"}):
        with pytest.raises(ValueError, match="fixture configuration"):
            with controlled_v622_boundaries(settings.model_copy(update=update), case="sparse"):
                pytest.fail("invalid fixture activated")


def test_v622_transport_denies_other_destinations_and_bounds_requests(tmp_path):
    settings = configuration(tmp_path)
    with controlled_v622_boundaries(settings, case="empty") as state:
        with httpx.Client() as client:
            for target in ("https://example.invalid/", "https://other.invalid/api/v1/chat/completions"):
                with pytest.raises(AssertionError, match="fixture destination"):
                    client.post(target)
            body = {"model": MODEL, "messages": [{"content": "not-the-pinned-prompt"}]}
            with pytest.raises(AssertionError):
                client.post("https://openrouter.ai/api/v1/chat/completions", json=body)
    assert state["asrRequests"] == state["correctionRequests"] == 0


@pytest.mark.parametrize("case", ["sparse", "empty"])
def test_v622_real_pipeline_and_transport_restore_without_private_diagnostics(tmp_path, case, capsys):
    settings = configuration(tmp_path)
    path = tmp_path / "source.wav"
    path.write_bytes(e2e.synthetic_wav())
    client_type, vad_factory = httpx.Client, SileroVadBackend.from_settings
    with controlled_v622_boundaries(settings, case=case) as state, ExitStack() as resources:
        vad = SileroVadBackend.from_settings(settings)
        transcriber = resources.enter_context(OpenRouterWhisperAdapter(settings))
        corrector = resources.enter_context(OpenRouterInstructionLlmV62Adapter(settings))
        pipeline = OfflineTranscriptionPipeline(
            AudioPreprocessingPipeline(AudioNormalizer(settings), AudioEvidenceDetector(settings, vad), SpeechMapBuilder(settings)),
            SpeechAwareAsrChunkPlanner(settings), transcriber, corrector, settings, correction_mode="v62_edits")
        outcome = pipeline.run(AudioSource(str(uuid4()), path))
        assert outcome.failure is None
        provenance = outcome.provenance.correction
        assert provenance.attempts == state["asrRequests"] == state["correctionRequests"] == 1
        assert (provenance.proposed_edit_count, provenance.accepted_edit_count, provenance.rejected_edit_count) == (
            (2, 1, 1) if case == "sparse" else (0, 0, 0))
        assert "JWT" in outcome.result.segments[0].text
        assert ("trầy xước" in outcome.result.segments[0].text) == (case == "sparse")
        with pytest.raises(AssertionError, match="request bound"):
            corrector._client.post("https://openrouter.ai/api/v1/chat/completions", json={})
    assert httpx.Client is client_type and SileroVadBackend.from_settings == vad_factory
    diagnostics = capsys.readouterr().out
    assert SYNTHETIC_KEY not in diagnostics and "chày chuỗi" not in diagnostics
    assert "trầy xước" not in diagnostics and "messages" not in diagnostics
    records = [json.loads(line.split(" ", 1)[1]) for line in diagnostics.splitlines()
               if line.startswith("E2E04_V622_PROVIDER ")]
    assert [item["boundary"] for item in records] == ["asr", "correction"]


def test_v622_controls_restore_after_interruption(tmp_path):
    original = httpx.Client
    with pytest.raises(RuntimeError, match="synthetic interruption"):
        with controlled_v622_boundaries(configuration(tmp_path), case="empty"):
            assert httpx.Client is not original
            raise RuntimeError("synthetic interruption")
    assert httpx.Client is original


def test_campaign_ledger_observes_tests_outside_secure_directory_with_isolated_environment(tmp_path, monkeypatch):
    import importlib.util
    import os
    from types import SimpleNamespace

    spec = importlib.util.spec_from_file_location("v622_ledger_regression", e2e.ROOT / "infra/local/secure-integration/tests/conftest.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    destination = tmp_path / "sanitized-ledger.md"
    monkeypatch.setenv("V622_ACCEPTANCE_LEDGER", str(destination))
    manager = pytest.PytestPluginManager()
    module.pytest_configure(SimpleNamespace(pluginmanager=manager))
    with monkeypatch.context() as isolated:
        isolated.setattr(os, "environ", {})
        for phase in ("setup", "call", "teardown"):
            manager.hook.pytest_runtest_logreport(report=SimpleNamespace(
                nodeid="services/ai/tests/integration/outside.py::test_example", when=phase, outcome="passed"))
        manager.hook.pytest_sessionfinish(session=None, exitstatus=0)
    text = destination.read_text(encoding="utf-8")
    assert "outside.py::test_example" in text and "passed calls=1; failed calls=0; skips=0" in text
    assert "V6.2.2 OFFLINE CORE INTEGRATION VERIFIED" not in text


def test_v622_java_worker_compatibility():
    """The same command covers actual generated bytes, old V1 bytes and tampering."""
    import os
    import subprocess
    import xml.etree.ElementTree as xml
    from pathlib import Path

    result = subprocess.run(
        ["mvn", "-q", "-Dtest=V62WorkerCompatibilityTests,CorrectedTranscriptTests", "test"],
        cwd=e2e.ROOT / "services/api", capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr
    counts = {}
    for name in ("V62WorkerCompatibilityTests", "CorrectedTranscriptTests"):
        path = e2e.ROOT / "services/api/target/surefire-reports" / (
            "TEST-com.sme.meetingassistant.api.media.worker." + name + ".xml")
        report = xml.parse(path).getroot()
        counts[name] = {key: int(report.attrib[key]) for key in ("tests", "failures", "errors", "skipped")}
        assert counts[name]["tests"] > 0
        assert all(counts[name][key] == 0 for key in ("failures", "errors", "skipped"))
    print("V622_JAVA_COMPATIBILITY " + json.dumps(counts, separators=(",", ":")), flush=True)
    if destination := os.environ.get("V622_ACCEPTANCE_LEDGER"):
        with Path(destination).open("a", encoding="utf-8") as ledger:
            ledger.write("\nJava compatibility actual results: `" + json.dumps(counts, separators=(",", ":")) + "`\n")
