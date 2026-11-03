"""Invented numeric evidence tests. None of these records is release evidence."""

import hashlib
import json
import socket
from concurrent.futures import CancelledError
from copy import deepcopy
from dataclasses import replace
from fractions import Fraction

import pytest

from .asr_cutover import (
    REQUIRED_CONDITIONS,
    CaseRecord,
    CutoverPolicy,
    ReplayProvider,
    assemble_report,
    configuration_digest,
    evaluate_readiness,
    fixture_identity,
    pipeline_identity,
    pool_metrics,
    preflight_live,
    run_production_case,
    serialize_report,
)
from .support import EvaluationError, canonical_json, digest_json, load_manifest
from .test_transcription_runner import case as production_case_fixture
from .transcription_support import compute_text_metrics, load_configuration

__all__ = ["production_case_fixture"]


@pytest.fixture(autouse=True)
def offline_only(monkeypatch):
    monkeypatch.delenv("RUN_ASR_CUTOVER_LIVE", raising=False)
    monkeypatch.setattr(socket.socket, "connect", lambda *a: pytest.fail("network in offline contract"))


def numeric_case(mode="adaptive", **updates):
    text = compute_text_metrics("Đúng API C++ v2.1 đúng", "Đúng API C++ v2.1 đúng")
    value = {
        "fixture_identity": "a" * 64, "source_sha256": "b" * 64,
        "reference_sha256": "c" * 64, "annotation_sha256": "d" * 64,
        "configuration_identity": digest_json(mode), "pipeline_identity": "e" * 64,
        "normalization_identity": "f" * 64, "runtime_identity": "1" * 64,
        "strategy_mode": mode, "trial": 0, "evidence_mode": "approved-live",
        "conditions": sorted(REQUIRED_CONDITIONS), "sample_count": 16000, "human_speech_samples": 16000,
        "components": {"provider_contract": "2", "strategy": "adaptive-asr-v1",
                       "planner": "whole-file-v1" if mode == "adaptive" else "speech-aware-v2",
                       "alignment": None if mode == "adaptive" else "boundary-alignment-v2",
                       "reconciler": "2", "coverage": "2", "recovery": "2",
                       "correction": "1", "correction_prompt_identity": "2" * 64,
                       "correction_model_identity": "3" * 64},
        "metrics": {"text": text, "canonical_text": text, "confirmed_speech_samples": 16000, "supported_speech_samples": 16000,
                    "missing_speech": [], "missing_material": [], "missing_critical": [],
                    "silence_text_samples": 0, "noise_text_samples": 0, "music_text_samples": 0,
                    "unsupported_canonical_risk_samples": 0, "unresolved_speech_samples": 0,
                    "false_success": False},
        "recovery": {"attempts": 0, "accepted": 0, "rejected": 0, "failed": 0,
                     "support_gain_samples": 0, "prevented_regressions": 0, "requested_samples": 0},
        "resources": {"asr_calls": 1, "native_calls": int(mode == "adaptive"),
                      "chunked_calls": int(mode == "chunked"), "recovery_calls": 0,
                      "correction_calls": 1, "latency_ns": 100, "source_samples": 16000,
                      "max_payload_bytes": 32044, "peak_concurrent_asr": 1,
                      "process_peak_memory_bytes": 1000, "known_cost_subtotal": None,
                      "reported_cost": None, "unknown_cost_count": 2, "timeouts": 0, "resource_failures": 0},
        "provider_upstreams": ["DeepInfra"], "unknown_upstream_calls": 0,
        "publication_validation": "PASS", "execution_status": "PASS",
    }
    value.update(updates)
    return value


def approved_policy():
    return {
        "schema_version": 1, "approval_identity": "4" * 64, "approval_version": "reviewed-1",
        "manifest_sha256": "5" * 64, "configuration_matrix_sha256": "6" * 64,
        "reference_identity": digest_json([("a" * 64, "c" * 64, "d" * 64)]),
        "pipeline_identity": "e" * 64, "trials": 1, "maximum_recordings": 1,
        "maximum_source_samples": 16000, "maximum_asr_calls": 100,
        "maximum_case_asr_calls": 32, "maximum_payload_bytes": 25000000,
        "maximum_concurrent_asr": 1, "maximum_recovery_attempts": 24,
        "maximum_recovery_samples": 100000, "maximum_latency_ns": 1000,
        "maximum_process_memory_bytes": 10000,
        "maximum_wer_regression": {"numerator": 0, "denominator": 1},
        "maximum_cer_regression": {"numerator": 0, "denominator": 1},
        "maximum_hallucination_sample_regression": 0, "maximum_word_insertion_regression": 0,
        "fixture_conditions": {"a" * 64: sorted(REQUIRED_CONDITIONS)},
    }


def verification():
    return {"pipeline_identity": "e" * 64, "configuration_matrix_sha256": "6" * 64,
            "implementation": "PASS", "ci": "PASS", "publication": "PASS", "rollback": "PASS",
            "evidence_sha256": "7" * 64, "ci_commit": "8" * 40, "ci_run_id": 1}


def report_inputs():
    cases = [numeric_case("chunked"), numeric_case()]
    reviews = [{"case_sha256": digest_json(CaseRecord.model_validate(cases[1]).model_dump()), "gate": gate, "status": "PASS",
                "approval_identity": "4" * 64, "evidence_sha256": "9" * 64, "violations": 0}
               for gate in ("G07", "G08", "G09")]
    historical = {"manifest_sha256": "5" * 64, "reference_identity": approved_policy()["reference_identity"],
                  "model": "openai/whisper-large-v3", "language": "vi",
                  "normalization_version": "vi-nfc-casefold-technical-1",
                  "approval_identity": "4" * 64, "evidence_sha256": "0" * 64,
                  "source_revision": "a" * 40, "planner_version": "1",
                  "reconciler_version": "1", "recovery_version": "1",
                  "strategies": ["whole-file", "chunked-baseline", "chunked-recovery"]}
    current = cases[1]
    historical["cases"] = [{**{k: current[k] for k in ("fixture_identity", "source_sha256", "reference_sha256", "annotation_sha256", "normalization_identity", "runtime_identity", "trial", "metrics", "resources")}, "strategy_id": strategy}
                           for strategy in historical["strategies"]]
    for case in historical["cases"]:
        whole = case["strategy_id"] == "whole-file"
        case["resources"] = {**case["resources"], "correction_calls": 0, "unknown_cost_count": 1,
                             "native_calls": int(whole), "chunked_calls": int(not whole)}
    return cases, approved_policy(), verification(), reviews, historical


def make_report(**updates):
    cases, policy, verified, reviews, historical = report_inputs()
    return assemble_report(cases, policy, verified, reviews=reviews, historical=historical, **updates)


def authorize(report, policy):
    return {"report_sha256": report["report_sha256"], "policy_sha256": digest_json(policy),
            "approval_identity": policy["approval_identity"], "deployment_scope_identity": "b" * 64}


def test_r38_r43_exact_normalization_and_pooled_counts():
    a = compute_text_metrics("đ d C++ v2.1 đúng đúng", "d d C# v2.2 đúng")
    assert a["word_deletions"] == 1 and a["word_substitutions"] == 3
    b = compute_text_metrics("một hai ba bốn năm sáu bảy tám", "một hai ba bốn năm sáu bảy tám")
    pooled = pool_metrics([a, b])
    assert Fraction(**pooled["wer"]) == Fraction(4, 14)
    assert pooled["word_errors"] == sum(m["word_errors"] for m in (a, b))


def test_r58_complete_invented_approval_can_produce_go_candidate_only():
    report = make_report()
    assert set(report["quality_gate_status"]) == {f"G{i:02d}" for i in range(1, 13)}
    assert set(report["quality_gate_status"].values()) == {"PASS"}
    decision = evaluate_readiness(report, approved_policy(), authorize(report, approved_policy()))
    assert decision["production_decision"] == "GO"
    assert decision["deployment_performed"] is False


@pytest.mark.parametrize("gate", [f"G{i:02d}" for i in range(1, 13)])
@pytest.mark.parametrize("status", ["FAIL", "UNESTABLISHED", "UNAVAILABLE"])
def test_r57_tampered_gate_or_any_nonpass_cannot_authorize(gate, status):
    report = make_report()
    report["quality_gate_status"][gate] = status
    report["report_sha256"] = digest_json({k: v for k, v in report.items() if k != "report_sha256"})
    assert evaluate_readiness(report, approved_policy(), authorize(report, approved_policy()))["production_decision"] == "NO-GO"


@pytest.mark.parametrize("damage", ["reference", "policy", "baseline", "ci", "rollback", "deployment", "synthetic", "integrity", "review", "historical"])
def test_r39_r40_r42_r45_r56_r59_fail_closed(damage):
    cases, policy, verified, reviews, historical = report_inputs()
    if damage == "reference":
        cases[1]["reference_sha256"] = None
    elif damage == "policy":
        policy["maximum_wer_regression"] = None
    elif damage == "baseline":
        cases[0]["runtime_identity"] = "0" * 64
    elif damage in ("ci", "rollback"):
        verified[damage] = "UNAVAILABLE"
    elif damage == "synthetic":
        for case in cases:
            case["evidence_mode"] = "offline-contract"
    elif damage == "review":
        reviews = []
    elif damage == "historical":
        historical["recovery_version"] = "2"
    report = assemble_report(cases, policy, verified, reviews=reviews, historical=historical)
    approval = authorize(report, policy)
    if damage == "deployment":
        approval = None
    elif damage == "integrity":
        report["quality_metrics"]["independent_recordings"] = 99
    decision = evaluate_readiness(report, policy, approval)
    assert decision["production_decision"] == "NO-GO"
    if damage == "reference":
        assert report["quality_gate_status"]["G01"] == "UNAVAILABLE"
    if damage == "policy":
        assert report["quality_gate_status"]["G04"] == "UNESTABLISHED"


def test_r41_critical_and_material_loss_cannot_be_compensated_by_wer():
    cases, policy, verified, reviews, historical = report_inputs()
    cases[1]["metrics"].update(supported_speech_samples=15900,
                              missing_speech=[{"start_sample": 100, "end_sample": 200}],
                              missing_material=[{"start_sample": 100, "end_sample": 200}],
                              missing_critical=[{"start_sample": 100, "end_sample": 200}],
                              false_success=True)
    report = assemble_report(cases, policy, verified, reviews=reviews, historical=historical)
    assert report["quality_gate_status"]["G02"] == report["quality_gate_status"]["G03"] == "FAIL"
    assert report["quality_metrics"]["adaptive"]["text"]["wer"]["numerator"] == 0


def test_r44_r47_provider_confounding_and_unknown_cost_are_truthful():
    cases, policy, verified, reviews, historical = report_inputs()
    cases[0]["provider_upstreams"] = ["Together"]
    report = assemble_report(cases, policy, verified, reviews=reviews, historical=historical)
    assert report["regression_results"][0]["provider_confounded"] is True
    assert report["quality_metrics"]["adaptive"]["resources"]["reported_cost"] is None
    assert report["quality_metrics"]["adaptive"]["resources"]["unknown_cost_count"] == 2


def test_report_is_byte_stable_sorted_numeric_and_strictly_sanitized():
    report = make_report()
    assert serialize_report(report) == serialize_report(deepcopy(report))
    cases, policy, verified, reviews, historical = report_inputs()
    assert serialize_report(report) == serialize_report(assemble_report(list(reversed(cases)), policy, verified, reviews=list(reversed(reviews)), historical=historical))
    for location in ("raw_hypothesis", "private_filename", "credential", "provider_body"):
        injected = {**numeric_case(), location: "PRIVATE-MARKER"}
        with pytest.raises(EvaluationError) as caught:
            assemble_report([injected], policy, verified)
        assert "PRIVATE-MARKER" not in str(caught.value)


def test_invalid_metric_counts_cannot_be_signed_into_a_report():
    case = numeric_case()
    case["metrics"]["text"]["wer"] = {"numerator": 0, "denominator": 5}
    case["metrics"]["text"]["word_errors"] = 50
    with pytest.raises(ValueError):
        CaseRecord.model_validate(case)
    with pytest.raises(ValueError):
        CutoverPolicy.model_validate({**approved_policy(), "maximum_asr_calls": True})


def test_r29_replay_requires_approved_actual_request_geometry():
    from sme_meeting_ai.transcription.asr import (
        AsrAudioChunk,
        AsrCandidate,
        AsrProvenance,
        AsrQualityMetadata,
        AsrTimestampMode,
        AsrTranscriptionRequest,
        AsrUsage,
    )
    payload = b"invented replay audio"
    response = AsrCandidate("", (), AsrQualityMetadata(), AsrUsage(), AsrProvenance("openrouter", "openai/whisper-large-v3"), "chunk-000000")
    key = (hashlib.sha256(payload).hexdigest(), Fraction(1), AsrTimestampMode.SEGMENT)
    replay = ReplayProvider({key: response}, approval_identity="a" * 64)
    request = AsrTranscriptionRequest(AsrAudioChunk("chunk-000000", payload, Fraction(1)))
    assert replay.transcribe_request(request) is response
    with pytest.raises(EvaluationError):
        replay.transcribe_request(AsrTranscriptionRequest(AsrAudioChunk("chunk-000000", payload + b"changed", Fraction(1))))


def test_r62_live_preflight_requires_separate_authorization_before_asset_access(tmp_path):
    from sme_meeting_ai.core.config import Settings
    settings = Settings(_env_file=None, service_name="test-ai", service_identity="ai-core")
    with pytest.raises(EvaluationError) as caught:
        preflight_live(tmp_path, tmp_path / "config", tmp_path / "policy", tmp_path / "output", 1, settings)
    assert str(tmp_path) not in str(caught.value)
    assert json.loads(serialize_report(make_report()))["release_decision"] == "NO-GO"


@pytest.mark.parametrize("retry", [False, True])
def test_real_entry_coordination_runs_once_and_projects_only_numeric_evidence(
    production_case_fixture, monkeypatch, caplog, retry,
):
    from sme_meeting_ai.transcription import correction

    h = production_case_fixture()
    requests, provenance = [], []
    complete = h.corrector.complete
    correct = correction.correct_transcript

    def observed_complete(request):
        requests.append(request)
        response = complete(request)
        if retry and len(requests) == 1:
            response = replace(response, text="private-response-marker")
        return replace(response, usage=correction.CorrectionUsage(211, 29, 240, Fraction(2, 5), 5))

    def observed_correct(*args, **kwargs):
        outcome = correct(*args, **kwargs)
        if outcome.result is not None:
            provenance.append(outcome.result.provenance)
        return outcome

    monkeypatch.setattr(h.corrector, "complete", observed_complete)
    monkeypatch.setattr(correction, "correct_transcript", observed_correct)
    row = run_production_case(h.manifest, h.fixture, h.root, h.preprocessing, h.asr, h.corrector, h.settings)
    assert row["execution_status"] == row["publication_validation"] == "PASS"
    assert h.preprocessing_calls == h.closes == 1
    assert row["resources"]["asr_calls"] == len(h.calls) == 1
    assert len(provenance) == 1  # One correction operation; retries are actual provider invocations.
    p = provenance[0]
    assert row["resources"]["correction_calls"] == len(requests) == p.attempts == 1 + int(retry)
    # V5 provenance describes its accepted response; evaluation must independently
    # count and charge every invocation, including a rejected response before retry.
    assert p.usage == correction.CorrectionUsage(211, 29, 240, Fraction(2, 5), 5)
    assert row["resources"]["unknown_cost_count"] == 0
    assert Fraction(**row["resources"]["reported_cost"]) == Fraction(1, 10) + len(requests) * Fraction(2, 5)
    assert row["resources"]["reported_cost"] == row["resources"]["known_cost_subtotal"]
    assert all(request == requests[0] for request in requests)
    assert set(json.loads(requests[0].transcript_json)) == {"sample_rate_hz", "segments"}
    assert row["metrics"]["text"]["wer"]["numerator"] == 0
    assert row["components"]["coverage"] == row["components"]["recovery"] == "2"
    assert row["components"]["correction"] == p.correction_version == "4"
    assert row["components"]["correction_prompt_identity"] == digest_json(p.prompt_version)
    rendered = canonical_json(row) + caplog.text
    for secret in ("Kubernetes API", "private-prompt-marker", "private-response-marker", str(h.root), h.fixture.path):
        assert secret not in rendered


def test_missing_approved_reference_prevents_all_execution(production_case_fixture):
    h = production_case_fixture()
    (h.root / h.fixture.reference.path).unlink()
    row = run_production_case(h.manifest, h.fixture, h.root, h.preprocessing, h.asr, h.corrector, h.settings)
    assert row["execution_status"] == "UNAVAILABLE" and row["metrics"] is None
    assert h.preprocessing_calls == 0 and h.calls == []


def live_controls(h, tmp_path):
    from .test_asr_strategy_comparison import live_assets

    root, config, output = live_assets(h, tmp_path)
    h.settings = h.settings.model_copy(update={"audio_asr_chunk_max_chunks": 2,
                                             "audio_asr_recovery_max_total_attempts": 1,
                                             "audio_asr_recovery_max_total_request_samples": 100000})
    matrix = json.loads(config.read_text())
    matrix["variants"] = [v for v in matrix["variants"] if v["variant_id"] == matrix["baseline_variant"]]
    config.write_text(canonical_json(matrix))
    manifest = load_manifest(root)
    identities = [(fixture_identity(f), f.reference.sha256 if f.reference else None,
                   digest_json(f.model_dump(include={"labels", "sample_count", "annotation_version", "annotation_origin", "anchors"})))
                  for f in manifest.fixtures]
    policy = {**approved_policy(), "manifest_sha256": manifest.manifest_sha256,
              "configuration_matrix_sha256": configuration_digest(load_configuration(config), h.settings),
              "pipeline_identity": pipeline_identity(), "reference_identity": digest_json(sorted(identities)),
              "maximum_recordings": len(manifest.fixtures), "maximum_source_samples": 1000000,
              "maximum_asr_calls": 1000, "maximum_recovery_samples": 100000,
              "fixture_conditions": {i[0]: sorted(REQUIRED_CONDITIONS) for i in identities}}
    path = config.parent / "policy.json"
    path.write_text(canonical_json(policy))
    return root, config, path, output


@pytest.mark.parametrize("damage", ["opt-in", "credentials", "approval", "reference", "policy", "configuration",
                                    "budget", "output", "source", "model", "model-identity"])
def test_live_preflight_invalid_assets_policy_and_budgets_never_infer(production_case_fixture, tmp_path, monkeypatch, damage):
    h = production_case_fixture(count=1031)
    root, config, policy_path, output = live_controls(h, tmp_path)
    monkeypatch.setenv("RUN_ASR_CUTOVER_LIVE", "1")
    monkeypatch.setenv("RUN_OPENROUTER_LIVE_EVALUATION", "1")
    budget = 100
    if damage == "opt-in":
        monkeypatch.delenv("RUN_ASR_CUTOVER_LIVE")
    elif damage == "credentials":
        h.settings.openrouter_api_key = None
    elif damage == "approval":
        document = json.loads((root / "manifest.json").read_text())
        document["privacy_approved"] = False
        (root / "manifest.json").write_text(canonical_json(document))
    elif damage == "reference":
        (root / h.fixture.reference.path).unlink()
    elif damage == "policy":
        document = json.loads(policy_path.read_text())
        document["maximum_cer_regression"] = None
        policy_path.write_text(canonical_json(document))
    elif damage == "configuration":
        config.write_text("{}")
    elif damage == "budget":
        budget = 1
    elif damage == "output":
        output = root / "unsafe-output.json"
    elif damage == "source":
        (root / h.fixture.path).write_bytes(b"wrong source")
    elif damage == "model":
        h.settings.audio_vad_model_sha256 = "0" * 64
    else:
        h.settings.audio_asr_model = "unapproved/model"
    with pytest.raises(EvaluationError) as caught:
        preflight_live(root, config, policy_path, output, budget, h.settings)
    assert str(tmp_path) not in str(caught.value)
    assert h.calls == [] and h.preprocessing_calls == 0
    assert not output.exists()


def test_valid_live_preflight_is_local_only_and_bounds_entire_scope(production_case_fixture, tmp_path, monkeypatch):
    h = production_case_fixture(count=1031)
    root, config, policy, output = live_controls(h, tmp_path)
    monkeypatch.setenv("RUN_ASR_CUTOVER_LIVE", "1")
    monkeypatch.setenv("RUN_OPENROUTER_LIVE_EVALUATION", "1")
    manifest, _, _, _, budget = preflight_live(root, config, policy, output, 100, h.settings)
    assert budget == len(manifest.fixtures) * 2 * (2 + 1 + 1)
    assert h.calls == [] and h.preprocessing_calls == 0 and not output.exists()


def test_sensitive_hypotheses_and_provider_prompts_never_enter_reports(production_case_fixture, caplog):
    h = production_case_fixture()
    original = h.asr.transcribe
    def observed(audio):
        candidate = original(audio)
        marker = "PRIVATE-SYNTHETIC-TRANSCRIPT-MARKER"
        return replace(candidate, text=marker, segments=tuple(replace(s, text=marker) for s in candidate.segments))
    h.asr.transcribe = observed
    row = run_production_case(h.manifest, h.fixture, h.root, h.preprocessing, h.asr, h.corrector, h.settings)
    assert row["execution_status"] == "PASS"
    assert "PRIVATE-SYNTHETIC-TRANSCRIPT-MARKER" not in canonical_json(row) + caplog.text
    assert row["metrics"]["text"]["word_errors"] > 0


def test_coordinator_cancellation_is_not_converted_to_failed_metrics(production_case_fixture):
    h = production_case_fixture()
    cancellation = CancelledError()
    def cancel(audio):
        raise cancellation
    h.asr.transcribe = cancel
    with pytest.raises(CancelledError) as caught:
        run_production_case(h.manifest, h.fixture, h.root, h.preprocessing, h.asr, h.corrector, h.settings)
    assert caught.value is cancellation and h.closes == 1


def test_replay_alone_cannot_establish_live_resource_quality():
    cases, policy, verified, reviews, historical = report_inputs()
    for case in cases:
        case["evidence_mode"] = "approved-replay"
    report = assemble_report(cases, policy, verified, reviews=reviews, historical=historical)
    assert report["quality_gate_status"]["G10"] == "UNAVAILABLE"
