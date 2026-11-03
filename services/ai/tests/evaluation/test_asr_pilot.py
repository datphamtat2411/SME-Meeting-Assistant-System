"""Pilot scope, production-entry reuse and report isolation with injected providers."""

import json
import socket

import pytest
from pydantic import SecretStr

from .asr_cutover import CaseRecord, evaluate_readiness, run_production_case
from .asr_pilot import (
    approval_draft,
    compare_scope,
    preflight_pilot,
    run_live_pilot,
    run_pilot,
    serialize_pilot_report,
)
from .asr_pilot_manifest import sync_manifest, validate_pilot_manifest
from .support import EvaluationError, canonical_json
from .test_asr_cutover import approved_policy
from .test_asr_pilot_manifest import corpus
from .test_transcription_runner import case
from .transcription_support import load_configuration

__all__ = ["corpus", "case"]


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.delenv("RUN_ASR_PILOT_LIVE", raising=False)
    monkeypatch.delenv("RUN_OPENROUTER_LIVE_EVALUATION", raising=False)
    monkeypatch.setattr(socket.socket, "connect", lambda *a: pytest.fail("network in pilot test"))


def controls(corpus, case, tmp_path):
    root, source, _, _ = corpus
    sync_manifest(source, root, write=True)
    manifest_path = root / "manifest.json"
    doc = json.loads(manifest_path.read_bytes())
    doc.update(privacy_approved=True, legal_approved=True, approval_version="reviewed-pilot-1")
    manifest_path.write_text(canonical_json(doc))
    h = case()
    settings = h.settings.model_copy(update={"openrouter_api_key": SecretStr("fake-key"),
        "audio_asr_chunk_max_chunks": 2, "audio_asr_recovery_max_total_attempts": 1})
    model = tmp_path / "model.onnx"
    model.write_bytes(b"invented-not-loaded")
    import hashlib

    settings.audio_vad_model_path = model
    settings.audio_vad_model_sha256 = hashlib.sha256(model.read_bytes()).hexdigest()
    config = tmp_path / "config.json"
    config.write_text(canonical_json(dict(schema_version=1, configuration_version="pilot-1", baseline_variant="baseline",
        variants=[dict(variant_id="baseline", version="1", target_samples=4096, max_request_samples=4096,
                       overlap_samples=0, boundary_search_samples=0)])))
    draft = approval_draft(root, config, settings, max_asr_calls=16)
    assert draft["approved"] is False
    draft.update(approved=True, approval_version="owner-reviewed-1", approval_evidence_sha256="e" * 64)
    approval = tmp_path / "approval.json"
    approval.write_text(canonical_json(draft))
    results = tmp_path / "results"
    results.mkdir()
    return root, config, approval, results / "report.json", settings, h


@pytest.mark.parametrize("damage", ["opt-in", "router-opt-in", "approval", "privacy", "key", "correction", "vad", "budget", "existing", "alias", "expansion", "reference"])
def test_p16_p21_preflight_never_constructs_providers(corpus, case, tmp_path, monkeypatch, damage):
    root, config, approval, output, settings, h = controls(corpus, case, tmp_path)
    monkeypatch.setenv("RUN_ASR_PILOT_LIVE", "1")
    monkeypatch.setenv("RUN_OPENROUTER_LIVE_EVALUATION", "1")
    budget = 16
    if damage == "opt-in":
        monkeypatch.delenv("RUN_ASR_PILOT_LIVE")
    elif damage == "router-opt-in":
        monkeypatch.delenv("RUN_OPENROUTER_LIVE_EVALUATION")
    elif damage == "approval":
        doc = json.loads(approval.read_bytes())
        doc["approved"] = False
        approval.write_text(canonical_json(doc))
    elif damage == "privacy":
        path = root / "manifest.json"
        doc = json.loads(path.read_bytes())
        doc["privacy_approved"] = False
        path.write_text(canonical_json(doc))
    elif damage == "key":
        settings.openrouter_api_key = None
    elif damage == "correction":
        settings.transcript_correction_model = None
    elif damage == "vad":
        settings.audio_vad_model_path.unlink()
    elif damage == "budget":
        budget = 1
    elif damage == "existing":
        output.write_text("preserve")
    elif damage == "alias":
        output = root / "references/vi-example-0.json"
    elif damage == "expansion":
        corpus[3](2)
        sync_manifest(corpus[1], root, write=True)
    else:
        (root / "references/vi-example-0.json").write_text("PRIVATE-BROKEN-REFERENCE")
    constructed = []
    def forbidden(*args):
        constructed.append(True)
        pytest.fail("provider constructed before preflight")
    with pytest.raises(EvaluationError) as caught:
        run_live_pilot(root, config, approval, output, budget, settings, provider_factory=forbidden)
    assert not constructed and h.calls == []
    assert str(root) not in str(caught.value) and "PRIVATE" not in str(caught.value)


def test_valid_preflight_is_local_only_and_new_files_do_not_expand_scope(corpus, case, tmp_path, monkeypatch):
    root, config, approval, output, settings, h = controls(corpus, case, tmp_path)
    monkeypatch.setenv("RUN_ASR_PILOT_LIVE", "1")
    monkeypatch.setenv("RUN_OPENROUTER_LIVE_EVALUATION", "1")
    corpus[3](2)  # Not in the approved persistent manifest yet.
    manifest, _, policy, _, maximum = preflight_pilot(root, config, approval, output, 16, settings)
    assert len(manifest.fixtures) == 2 and maximum == 16 and policy.trials == 1
    assert h.calls == [] and not output.exists()


def test_p22_p23_p25_p26_real_pipeline_modes_report_and_privacy(case, tmp_path, monkeypatch):
    h = case()
    # Two distinct generated sources, same reference text, real coordinator.
    first = h.fixture.model_dump()
    second = h.fixture.model_dump()
    second.update(fixture_id="another-independent-source", path="second.wav")
    raw = bytearray((h.root / first["path"]).read_bytes())
    raw[44:46] = b"\x01\x00"
    (h.root / second["path"]).write_bytes(raw)
    import hashlib

    second["source_sha256"] = hashlib.sha256(raw).hexdigest()
    second["anchors"][0]["pcm_sha256"] = hashlib.sha256(raw[44:64]).hexdigest()
    reference = json.loads((h.root / first["reference"]["path"]).read_bytes())
    reference["fixture_id"] = second["fixture_id"]
    (h.root / "second.json").write_text(canonical_json(reference))
    second["reference"]["path"] = "second.json"
    second["reference"]["sha256"] = hashlib.sha256((h.root / "second.json").read_bytes()).hexdigest()
    doc = h.manifest.model_dump(exclude={"manifest_sha256"})
    doc["fixtures"] = [first, second]
    (h.root / "manifest.json").write_text(canonical_json(doc))
    manifest = validate_pilot_manifest(h.root)
    config = tmp_path / "matrix.json"
    config.write_text(canonical_json(dict(schema_version=1, configuration_version="pilot-1", baseline_variant="baseline",
        variants=[dict(variant_id="baseline", version="1", target_samples=4096, max_request_samples=4096,
                       overlap_samples=0, boundary_search_samples=0)])))
    # Harness preprocesses the source path it receives, without reference hints.
    original = h.preprocessing.run
    def preprocess(source):
        outcome = original(source)
        object.__setattr__(outcome.result.normalized_artifact, "path", source.path)
        return outcome
    h.preprocessing.run = preprocess
    seen = []
    def factory(settings, resources):
        seen.append(settings.audio_asr_strategy_mode)
        return h.preprocessing, h.asr, h.corrector
    report = run_pilot(manifest, h.root, load_configuration(config), h.settings, factory, max_asr_calls=100)
    assert seen == ["chunked", "adaptive"]
    assert len(report["cases"]) == h.preprocessing_calls == 4
    assert all(c["evidence_mode"] == "pilot-offline" for c in report["cases"])
    assert all(c["execution_status"] == "PASS" for c in report["cases"])
    for row in report["cases"]:
        with pytest.raises(ValueError):
            CaseRecord.model_validate(row)
    assert report["production_readiness"] == "NOT_ASSESSED" and report["deployment_authorized"] is False
    assert report["comparison"]["status"] == "PAIRED_COMPLETE"
    assert report["aggregates"]["chunked"]["text"]["reference_words"] > 0
    assert evaluate_readiness(report, approved_policy())["production_decision"] == "NO-GO"
    rendered = serialize_pilot_report(report).decode()
    for secret in ("Kubernetes API", "private-prompt-marker", str(h.root), "fake-key"):
        assert secret not in rendered
    # Exercise the complete authorized path as well, with injected providers only.
    h.settings.openrouter_api_key = SecretStr("fake-key")
    h.settings.audio_asr_chunk_max_chunks = 2
    h.settings.audio_asr_recovery_max_total_attempts = 1
    model = tmp_path / "pinned-model.onnx"
    model.write_bytes(b"synthetic-model-not-loaded")
    h.settings.audio_vad_model_path = model
    h.settings.audio_vad_model_sha256 = hashlib.sha256(model.read_bytes()).hexdigest()
    draft = approval_draft(h.root, config, h.settings, max_asr_calls=16)
    draft.update(approved=True, approval_version="synthetic-review", approval_evidence_sha256="e" * 64)
    approval_path = tmp_path / "pilot-approval.json"
    approval_path.write_text(canonical_json(draft))
    output = tmp_path.parent / f"{tmp_path.name}-pilot-report.json"
    monkeypatch.setenv("RUN_ASR_PILOT_LIVE", "1")
    monkeypatch.setenv("RUN_OPENROUTER_LIVE_EVALUATION", "1")
    monkeypatch.delenv("RUN_ASR_CUTOVER_LIVE", raising=False)
    live = run_live_pilot(h.root, config, approval_path, output, 16, h.settings, provider_factory=factory)
    assert output.read_bytes() == serialize_pilot_report(live)
    assert all(c["evidence_mode"] == "pilot-live" for c in live["cases"])
    assert all(c["execution_status"] == "PASS" for c in live["cases"])
    report["deployment_authorized"] = True
    with pytest.raises(EvaluationError):
        serialize_pilot_report(report)


def test_p24_scope_comparison_never_claims_changed_corpus_is_comparable():
    a = {"dataset": {"fixture_identities": {"a": "1" * 64, "b": "2" * 64}}}
    b = {"dataset": {"fixture_identities": {"a": "1" * 64, "b": "2" * 64, "c": "3" * 64}}}
    result = compare_scope(a, b)
    assert result["aggregate_comparable"] is False and result["added"] == ["c"]
    assert result["matched"] == ["a", "b"]


def test_pilot_opt_in_does_not_authorize_full_cutover(case, monkeypatch):
    h = case()
    h.settings.openrouter_api_key = SecretStr("fake-key")
    monkeypatch.setenv("RUN_ASR_PILOT_LIVE", "1")
    monkeypatch.setenv("RUN_OPENROUTER_LIVE_EVALUATION", "1")
    monkeypatch.delenv("RUN_ASR_CUTOVER_LIVE", raising=False)
    with pytest.raises(EvaluationError):
        run_production_case(h.manifest, h.fixture, h.root, h.preprocessing, h.asr, h.corrector,
                            h.settings, evidence_mode="approved-live", authorized_live=True)
    assert h.calls == [] and h.preprocessing_calls == 0
