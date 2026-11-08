import hashlib
import json
import logging
import os
import stat
import wave
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.diarization.models import (
    DiarizationError,
    DiarizationErrorCategory,
    DiarizationResult,
    SpeakerTurn,
)

from . import diarization_smoke as smoke


@pytest.fixture
def settings():
    return Settings(service_name="smoke-test", service_identity="ai-core", _env_file=None,
                    diarization_worker_provider_approved=True, REPLICATE_API_TOKEN="test-private-token")


@pytest.fixture
def inputs(tmp_path):
    audio = tmp_path / "private-source.wav"
    with wave.open(str(audio), "wb") as output:
        output.setparams((1, 2, 8000, 0, "NONE", ""))
        output.writeframes(b"\0\0" * 8000)
    return smoke.Inputs(audio, hashlib.sha256(audio.read_bytes()).hexdigest(), tmp_path / "run", 2)


def result(settings, turns=(), speakers=()):
    return DiarizationResult(tuple(SpeakerTurn(start, end, f"SPEAKER_{label:02d}")
                                   for start, end, label in turns),
                             tuple(f"SPEAKER_{label:02d}" for label in speakers),
                             settings.diarization_model)


class FakeProvider:
    def __init__(self, outcome):
        self.outcome = outcome
        self.calls = []

    def diarize(self, path, **hints):
        self.calls.append((Path(path), Path(path).read_bytes(), hints))
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def execute(inputs, settings, provider, **kwargs):
    return smoke.run(inputs, settings, live_opt_in=kwargs.get("live_opt_in", True),
                     authorize_upload=kwargs.get("authorize_upload", True),
                     max_provider_calls=kwargs.get("max_provider_calls", 1),
                     provider_factory=lambda _settings: provider)


def test_preflight_checks_real_audio_and_never_constructs_a_provider(inputs, settings, monkeypatch, capsys):
    monkeypatch.setattr(smoke, "load_settings", lambda **kw: settings if kw == {"env_file": None} else None)
    monkeypatch.setattr(smoke, "ReplicateDiarizationAdapter", lambda *_: pytest.fail("provider created"))
    assert smoke.main(["preflight", "--audio", str(inputs.audio), "--expected-sha256", inputs.expected_sha256,
                       "--output", str(inputs.output), "--expected-speakers", "2"]) == 0
    observation = json.loads(capsys.readouterr().out)
    assert observation["audio_sha256"] == inputs.expected_sha256
    assert observation["audio_duration_ms"] == 1000
    assert observation["expected_speaker_count"] == 2
    assert observation["provider_calls"] == 0
    assert not inputs.output.exists()


@pytest.mark.parametrize("damage", ["missing", "empty", "unsupported", "digest", "large", "directory", "symlink"])
def test_invalid_sources_fail_preflight(inputs, settings, damage):
    if damage == "missing":
        inputs = replace(inputs, audio=inputs.audio.parent / "missing.wav")
    elif damage == "empty":
        inputs.audio.write_bytes(b"")
    elif damage == "unsupported":
        inputs.audio.write_bytes(b"not audio")
        inputs = replace(inputs, expected_sha256=hashlib.sha256(b"not audio").hexdigest())
    elif damage == "digest":
        inputs = replace(inputs, expected_sha256="a" * 64)
    elif damage == "large":
        with inputs.audio.open("wb") as audio:
            audio.truncate(100_000_001)
    elif damage == "directory":
        inputs = replace(inputs, audio=inputs.audio.parent)
    else:
        alias = inputs.audio.parent / "link.wav"
        alias.symlink_to(inputs.audio)
        inputs = replace(inputs, audio=alias)
    with pytest.raises(smoke.SmokeError):
        smoke.preflight(inputs, settings)
    assert not inputs.output.exists()


@pytest.mark.parametrize("duration", [None, 0, -1, 3601])
def test_invalid_or_excess_duration_is_rejected(inputs, settings, monkeypatch, duration):
    from fractions import Fraction

    monkeypatch.setattr(smoke.AudioNormalizer, "probe", lambda *_: SimpleNamespace(
        declared_duration=None if duration is None else Fraction(duration), container="wav", codec="pcm_s16le"))
    with pytest.raises(smoke.SmokeError):
        smoke.preflight(inputs, settings)


def test_duration_rounding_only_extends_to_the_next_millisecond(inputs, settings):
    with wave.open(str(inputs.audio), "wb") as output:
        output.setparams((1, 2, 8000, 0, "NONE", ""))
        output.writeframes(b"\0\0" * 8001)
    inputs = replace(inputs, expected_sha256=hashlib.sha256(inputs.audio.read_bytes()).hexdigest())
    checked = smoke.preflight(inputs, settings)
    assert checked.audio_duration_ms == 1001
    smoke.analyze_result(result(settings, [(0, 1001, 1)], [1]), 1001)
    with pytest.raises(smoke.SmokeError):
        smoke.analyze_result(result(settings, [(0, 1002, 1)], [1]), 1001)


@pytest.mark.parametrize("damage", ["repository", "existing_dir", "existing_file", "source", "symlink_parent", "writable_parent"])
def test_unsafe_or_existing_output_is_rejected(inputs, settings, damage):
    if damage == "repository":
        output = smoke.REPOSITORY / "should-not-be-created"
    elif damage == "existing_dir":
        output = inputs.output
        output.mkdir()
    elif damage == "existing_file":
        output = inputs.audio.parent / "report.json"
        output.write_text("original")
    elif damage == "source":
        output = inputs.audio
    elif damage == "symlink_parent":
        alias = inputs.audio.parent / "parent-link"
        alias.symlink_to(inputs.audio.parent, target_is_directory=True)
        output = alias / "run"
    else:
        parent = inputs.audio.parent / "shared"
        parent.mkdir(mode=0o777)
        parent.chmod(0o777)
        output = parent / "run"
    with pytest.raises(smoke.SmokeError):
        smoke.preflight(replace(inputs, output=output), settings)
    assert inputs.audio.exists()
    if damage == "existing_file":
        assert output.read_text() == "original"


@pytest.mark.parametrize("missing", ["live", "permission", "budget", "approval", "token", "disabled"])
def test_run_is_fail_closed_before_provider_or_output(inputs, settings, missing):
    provider = FakeProvider(result(settings))
    kwargs = {}
    if missing == "live":
        kwargs["live_opt_in"] = False
    elif missing == "permission":
        kwargs["authorize_upload"] = False
    elif missing == "budget":
        kwargs["max_provider_calls"] = 2
    elif missing == "approval":
        settings.diarization_worker_provider_approved = False
    elif missing == "token":
        settings.replicate_api_token = None
    else:
        settings.diarization_enabled = False
    with pytest.raises(smoke.SmokeError):
        execute(inputs, settings, provider, **kwargs)
    assert not provider.calls and not inputs.output.exists()


@pytest.mark.parametrize(("turns", "speakers", "durations", "counts", "covered", "overlap"), [
    ([(0, 200, 1), (400, 600, 1)], [1], [400], [2], 400, 0),
    ([(0, 300, 1), (300, 500, 2)], [1, 2], [300, 200], [1, 1], 500, 0),
    ([(0, 400, 1), (200, 600, 2)], [1, 2], [400, 400], [1, 1], 600, 200),
    ([(0, 400, 1), (100, 500, 1), (300, 600, 2)], [1, 2], [500, 300], [2, 1], 600, 200),
    ([(0, 400, 1), (100, 400, 1)], [1], [400], [2], 400, 0),
    ([], [], [], [], 0, 0),
])
def test_half_open_interval_metrics(settings, turns, speakers, durations, counts, covered, overlap):
    analysis = smoke.analyze_result(result(settings, turns, speakers), 1000)
    metrics = analysis["metrics"]
    labels = [f"SPEAKER_{i:02d}" for i in speakers]
    assert metrics["audio_duration_ms"] == 1000
    assert metrics["speaker_count"] == len(speakers) and metrics["turn_count"] == len(turns)
    assert metrics["speaker_duration_ms"] == dict(zip(labels, durations, strict=True))
    assert metrics["speaker_turn_counts"] == dict(zip(labels, counts, strict=True))
    assert metrics["speech_union_duration_ms"] == covered
    assert metrics["uncovered_duration_ms"] == 1000 - covered
    assert metrics["overlap_duration_ms"] == overlap
    assert analysis["structural_status"] == ("VALID" if turns else "VALID_EMPTY")
    assert len(analysis["turns"]) == len(turns)


def test_three_speaker_overlap_is_counted_once(settings):
    evidence = result(settings, [(0, 700, 1), (100, 800, 2), (200, 500, 3)], [1, 2, 3])
    metrics = smoke.analyze_result(evidence, 1000)["metrics"]
    assert metrics["speech_union_duration_ms"] == 800
    assert metrics["overlap_duration_ms"] == 600


@pytest.mark.parametrize("damage", ["bounds", "reference", "order", "labels", "model", "model_secret", "type"])
def test_invalid_results_are_rejected_without_changing_domain_contract(settings, damage):
    good = result(settings, [(0, 100, 1), (200, 300, 2)], [1, 2])
    if damage == "bounds":
        bad = replace(good, turns=(SpeakerTurn(0, 1001, "SPEAKER_01"),))
    elif damage == "reference":
        bad = replace(good, speakers=("SPEAKER_01",))
    elif damage == "order":
        bad = replace(good, turns=tuple(reversed(good.turns)))
    elif damage == "labels":
        bad = replace(good, speakers=("SPEAKER_02", "SPEAKER_01"))
    elif damage == "model":
        bad = replace(good, model_id="")
    elif damage == "model_secret":
        bad = replace(good, model_id="r8_secret")
    else:
        bad = {"turns": "private raw payload"}
    with pytest.raises(smoke.SmokeError, match="malformed_output"):
        smoke.analyze_result(bad, 1000)


def test_success_artifacts_are_private_traceable_and_require_human_review(inputs, settings):
    evidence = result(settings, [(0, 400, 1), (200, 600, 2)], [1, 2])
    provider = FakeProvider(evidence)
    report = execute(inputs, settings, provider)
    assert len(provider.calls) == 1
    snapshot, uploaded, hints = provider.calls[0]
    assert uploaded == inputs.audio.read_bytes() and not snapshot.exists()
    assert hints == {}  # Expected count is review metadata, never a provider hint.
    assert report["audio"]["sha256"] == inputs.expected_sha256
    assert report["model_id"] == settings.diarization_model
    assert report["configuration"]["speaker_hints"] == {"num_speakers": None, "min_speakers": None, "max_speakers": None}
    assert report["configuration_sha256"] == smoke.digest_json(report["configuration"])
    assert report["execution"]["provider_kind"] == "injected"
    assert report["execution"]["provider_calls"] == 1
    assert report["execution"]["prediction_count"] is None
    assert report["speaker_quality_status"] == "NOT_ESTABLISHED"
    assert report["production_readiness"] == "NOT_ASSESSED"
    assert report["manual_review_status"] == "PENDING"
    assert report["annotation_checks"] == "UNAVAILABLE"
    assert json.loads((inputs.output / "report.json").read_text()) == report
    timeline = (inputs.output / "timeline.tsv").read_text()
    assert "00:00.000\t00:00.400\tSPEAKER_01\t0.400" in timeline
    assert "00:00.200\t00:00.600\tSPEAKER_02\t0.400" in timeline
    review = (inputs.output / "manual-review.md").read_text()
    assert inputs.expected_sha256 in review and "NOT COMPLETED" in review
    assert "DER/JER" in review and "SPEAKER_02" not in review
    assert stat.S_IMODE(inputs.output.stat().st_mode) == 0o700
    assert all(stat.S_IMODE(p.stat().st_mode) == 0o600 for p in inputs.output.iterdir())
    serialized = (inputs.output / "report.json").read_text() + timeline + review
    for private in ("test-private-token", str(inputs.audio), inputs.audio.name):
        assert private not in serialized
    assert "der_score" not in serialized.lower() and "jer_score" not in serialized.lower()
    with pytest.raises(smoke.SmokeError):
        execute(inputs, settings, provider)
    assert len(provider.calls) == 1


def test_canonical_serialization_is_stable_for_equivalent_evidence(settings):
    evidence = result(settings, [(0, 200, 1)], [1])
    first = smoke.analyze_result(evidence, 1000)
    second = smoke.analyze_result(result(settings, [(0, 200, 1)], [1]), 1000)
    assert smoke.canonical_json(first) == smoke.canonical_json(second)
    assert smoke.canonical_json({"b": 2, "a": 1}) == smoke.canonical_json({"a": 1, "b": 2})


def test_canonical_report_is_stable_when_evidence_and_observations_are_equivalent(inputs, settings):
    checked = smoke.preflight(inputs, settings)
    analysis = smoke.analyze_result(result(settings, [(0, 200, 1)], [1]), checked.audio_duration_ms)
    first = smoke._report(inputs, checked, settings, "injected")
    second = smoke._report(inputs, checked, settings, "injected")
    first.update(analysis)
    second.update(analysis)
    assert smoke.canonical_json(first) == smoke.canonical_json(second)
    assert first["source_revision"] is None or len(first["source_revision"]) in (40, 64)
    assert first["audio"]["duration_basis"] == "ffprobe_container_metadata_ceil_ms"


@pytest.mark.parametrize(("failure", "category"), [
    (DiarizationError(DiarizationErrorCategory.TIMEOUT), "timeout"),
    (RuntimeError("private-token https://private.example secret-payload"), "processing_failed"),
])
def test_provider_failures_are_sanitized_and_do_not_create_review_artifacts(inputs, settings, failure, category):
    provider = FakeProvider(failure)
    report = execute(inputs, settings, provider)
    assert report["execution"]["status"] == "FAILED"
    assert report["execution"]["failure_category"] == category
    assert report["structural_status"] == "NOT_EVALUATED"
    assert report["turns"] is None and report["metrics"] is None
    assert sorted(p.name for p in inputs.output.iterdir()) == ["report.json"]
    assert json.loads((inputs.output / "report.json").read_text()) == report
    serialized = (inputs.output / "report.json").read_text()
    for private in ("private-token", "https://private.example", "secret-payload", str(inputs.audio)):
        assert private not in serialized


def test_http_client_request_logging_is_suppressed_during_inference(inputs, settings, caplog):
    class LoggingProvider(FakeProvider):
        def diarize(self, path, **hints):
            logging.getLogger("httpx").info("signed URL https://secret.example/private")
            return super().diarize(path, **hints)

    provider = LoggingProvider(result(settings))
    logger = logging.getLogger("httpx")
    original = logger.disabled
    with caplog.at_level(logging.INFO, logger="httpx"):
        execute(inputs, settings, provider)
    assert "secret.example" not in caplog.text
    assert logger.disabled == original


def test_invalid_provider_evidence_is_not_published_as_valid(inputs, settings):
    provider = FakeProvider(result(settings, [(0, 1001, 1)], [1]))
    report = execute(inputs, settings, provider)
    assert report["execution"]["status"] == "COMPLETED"
    assert report["execution"]["failure_category"] == "malformed_output"
    assert report["structural_status"] == "INVALID"
    assert report["turns"] is None and report["metrics"] is None
    assert sorted(p.name for p in inputs.output.iterdir()) == ["report.json"]


def test_changed_inference_snapshot_is_not_published_as_valid(inputs, settings):
    class AlteringProvider(FakeProvider):
        def diarize(self, path, **hints):
            result = super().diarize(path, **hints)
            Path(path).write_bytes(b"changed snapshot")
            return result

    provider = AlteringProvider(result(settings))
    report = execute(inputs, settings, provider)
    assert report["execution"]["status"] == "COMPLETED"
    assert report["execution"]["failure_category"] == "source_integrity"
    assert report["structural_status"] == "NOT_EVALUATED"
    assert sorted(p.name for p in inputs.output.iterdir()) == ["report.json"]


def test_changed_source_is_never_uploaded(inputs, settings, monkeypatch):
    provider = FakeProvider(result(settings))
    actual_preflight = smoke.preflight

    def change_after_preflight(*args):
        checked = actual_preflight(*args)
        inputs.audio.write_bytes(b"changed after hashing")
        return checked

    monkeypatch.setattr(smoke, "preflight", change_after_preflight)
    report = execute(inputs, settings, provider)
    assert not provider.calls
    assert report["execution"]["provider_calls"] == 0
    assert report["execution"]["failure_category"] == "source_integrity"


def test_no_implicit_dotenv_and_cli_live_flag_is_required(inputs, settings, monkeypatch, capsys):
    monkeypatch.chdir(inputs.audio.parent)
    (inputs.audio.parent / ".env").write_text("AI_RUN_REPLICATE_LIVE=1\nREPLICATE_API_TOKEN=private\n")
    monkeypatch.delenv("AI_RUN_REPLICATE_LIVE", raising=False)
    monkeypatch.setenv("AI_SERVICE_NAME", "smoke-test")
    monkeypatch.setenv("AI_SERVICE_IDENTITY", "ai-core")
    monkeypatch.delenv("REPLICATE_API_TOKEN", raising=False)
    loaded = smoke.load_settings(env_file=None)
    assert loaded.replicate_api_token is None
    monkeypatch.setattr(smoke, "load_settings", lambda **_: settings)
    monkeypatch.setattr(smoke, "ReplicateDiarizationAdapter", lambda *_: pytest.fail("provider created"))
    assert smoke.main(["run", "--audio", str(inputs.audio), "--expected-sha256", inputs.expected_sha256,
                       "--output", str(inputs.output), "--max-provider-calls", "1",
                       "--authorize-external-upload"]) != 0
    assert "private" not in capsys.readouterr().err
    assert not inputs.output.exists()


def test_output_permissions_remain_private_under_permissive_umask(inputs, settings):
    provider = FakeProvider(result(settings))
    old = os.umask(0)
    try:
        execute(inputs, settings, provider)
    finally:
        os.umask(old)
    assert stat.S_IMODE(inputs.output.stat().st_mode) == 0o700
    assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in inputs.output.iterdir())
