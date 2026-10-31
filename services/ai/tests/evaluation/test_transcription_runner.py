"""Offline injected evidence tests; no assets, credentials, subprocesses or network."""

import hashlib
import json
import math
import wave
from contextlib import ExitStack
from dataclasses import replace
from fractions import Fraction
from types import SimpleNamespace

import pytest
from pydantic import SecretStr

from sme_meeting_ai.audio import SpeechMapBuilder, VadLabel
from sme_meeting_ai.audio.models import (
    AudioProbe,
    AudioProvenance,
    DetectionProvenance,
    EvidenceFrame,
    NormalizedAudioArtifact,
    SpeechEnergyEvidence,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import (
    PreprocessingAudioMetadata,
    PreprocessingOutcome,
    PreprocessingProvenance,
    PreprocessingResult,
    PreprocessingStage,
    PreprocessingStatus,
)
from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrUsage,
)
from sme_meeting_ai.transcription.correction import (
    CorrectionProviderResponse,
    CorrectionUsage,
)

from .support import EvaluationError, Fixture, Manifest, canonical_json
from .test_evaluation_support import fixture_dict, manifest_dict
from .test_transcription_support import attach_reference, matrix_document
from .transcription_runner import (
    build_transcription_report,
    require_live_evaluation,
    run_configuration_matrix,
    run_transcription_case,
)
from .transcription_support import ConfigurationMatrix


class Clock:
    def __init__(self):
        self.value = 0

    def __call__(self):
        self.value += 1000
        return self.value


@pytest.fixture
def case(tmp_path):
    def make(*, count=4096, speech=True, omission=False, hallucination=False,
             correction_failure=False, recover=True, **overrides):
        item = fixture_dict()
        item.update(fixture_id="contract-case", path="contract.wav", sample_count=count,
                    conditions=["continuous-speech", "historical-regression"] if speech else ["silence"],
                    labels=[{"start_sample": 0, "end_sample": count,
                             "label": "speech" if speech else "silence", "material": speech}])
        if not speech:
            item.update(kind="synthetic", language="none", annotation_origin="synthetic-control")
        pcm = b"\xa0\x0f" * count if speech else b"\0\0" * count
        path = tmp_path / item["path"]
        with wave.open(str(path), "wb") as writer:
            writer.setparams((1, 2, 16000, 0, "NONE", ""))
            writer.writeframes(pcm)
        item["source_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        item["anchors"] = [
            {"start_sample": 0, "end_sample": 10, "pcm_sha256": hashlib.sha256(pcm[:20]).hexdigest()},
            {"start_sample": count - 10, "end_sample": count, "pcm_sha256": hashlib.sha256(pcm[-20:]).hexdigest()},
        ]
        fixture = Fixture.model_validate(item)
        if speech:
            fixture = attach_reference(tmp_path, fixture)
        # A separate contract case supplies condition coverage. Neither case is
        # a real recording or a claim of human-reviewed Vietnamese quality.
        cover = attach_reference(tmp_path, Fixture.model_validate(fixture_dict()))
        document = manifest_dict()
        document.update(schema_version=2, fixtures=[fixture.model_dump(), cover.model_dump()])
        manifest = Manifest.model_validate(document)
        settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                            **{"audio_speech_map_boundary_padding_samples": 0,
                               "audio_speech_map_merge_gap_samples": 0,
                               "audio_asr_chunk_target_samples": count,
                               "audio_asr_chunk_max_request_samples": count,
                               "audio_asr_chunk_overlap_samples": 0,
                               "audio_asr_chunk_boundary_search_samples": 0,
                               "audio_asr_recovery_context_samples": 128,
                               "audio_asr_timeout_seconds": 1,
                               "transcript_correction_model": "test/correction", **overrides})
        h = SimpleNamespace(manifest=manifest, fixture=fixture, root=tmp_path, settings=settings,
                            calls=[], closes=0, preprocessing_calls=0)

        class Preprocessor:
            def run(self, source):
                h.preprocessing_calls += 1
                normalization = AudioProvenance(source.source_id, "contract-1", "injected", "1", {
                    "container": "wav", "codec": "pcm_s16le", "sample_format": "s16",
                    "sample_rate_hz": 16000, "channels": 1,
                }, {"decoder_threads": 1})
                probe = AudioProbe(source.source_id, "wav", "pcm_s16le", 16000, 1, "mono", Fraction(count, 16000), 0)
                audio = NormalizedAudioArtifact(path, source.source_id, probe, count, normalization, None)
                detection = DetectionProvenance("contract-vad", "1", "d" * 64, "onnxruntime-cpu", "1", {
                    "sample_rate_hz": 16000, "frame_samples": 512, "tail_padding": "model-only-zero-padding",
                    "speech_threshold": 0.6, "non_speech_threshold": 0.35,
                })
                probability, label = (0.9, VadLabel.LIKELY_SPEECH) if speech else (0.1, VadLabel.LIKELY_NON_SPEECH)
                rms = 4000 / 32768 if speech else 0
                frames = [EvidenceFrame(start, min(start + 512, count), probability, label, rms,
                                        20 * math.log10(rms) if rms else -math.inf,
                                        512 - min(512, count - start)) for start in range(0, count, 512)]
                evidence = SpeechEnergyEvidence(source.source_id, count, len(frames),
                                                len(frames) if speech else 0, 0 if speech else len(frames),
                                                0, detection, path, None)
                object.__setattr__(evidence, "iter_frames", lambda: iter(frames))
                speech_map = SpeechMapBuilder(settings).build(audio, evidence)
                provenance = PreprocessingProvenance("1", source.source_id, count, normalization, detection, speech_map.provenance)
                metadata = PreprocessingAudioMetadata(probe, count)
                result = PreprocessingResult(audio, metadata, evidence, speech_map, speech_map.quality.warnings, provenance)
                ownership = ExitStack()
                ownership.callback(lambda: setattr(h, "closes", h.closes + 1))
                return PreprocessingOutcome(PreprocessingStatus.COMPLETED, tuple(PreprocessingStage), result,
                                            None, metadata, provenance, (), ownership)

        class Asr:
            def transcribe(self, chunk):
                h.calls.append(chunk.chunk_id)
                if chunk.chunk_id.startswith("recovery-") and not recover:
                    raise AsrError(AsrErrorCategory.AUTHENTICATION)
                empty = (not speech and not hallucination) or (omission and chunk.chunk_id.startswith("chunk-"))
                ordinal = int(chunk.chunk_id[-6:])
                text = "" if empty else "Kubernetes API" + (f" v{ordinal + 1}" if ordinal else "")
                segments = () if empty else (AsrSegment(Fraction(0), chunk.duration, text),)
                return AsrCandidate(text, segments, AsrQualityMetadata(), AsrUsage(cost=Fraction(1, 10)),
                                    AsrProvenance("injected", "test/asr", "test/resolved", inference_config=(("prompt", "private-prompt-marker"),)), chunk.chunk_id)

        class Corrector:
            def complete(self, request):
                if correction_failure:
                    return CorrectionProviderResponse("private-response-marker", "injected", request.model)
                return CorrectionProviderResponse(request.transcript_json, "injected", request.model,
                                                  "test/resolved-correction", CorrectionUsage(cost=Fraction(1, 5)))

        h.preprocessing, h.asr, h.corrector = Preprocessor(), Asr(), Corrector()
        return h
    return make


def invoke(h, **kwargs):
    return run_transcription_case(h.manifest, h.fixture, h.root, h.preprocessing, h.asr, h.corrector,
                                  h.settings, expected_model_sha256="d" * 64, clock=Clock(),
                                  evidence_mode="offline-contract", **kwargs)


def test_stages_end_to_end_telemetry_and_private_text_are_numeric_only(case, caplog):
    h = case()
    record = invoke(h)
    stages = {item["stage"]: item for item in record["stages"]}
    assert set(stages) == {"preprocessing", "chunk_planning", "baseline_asr", "recovery", "reconciliation", "correction", "end_to_end"}
    assert stages["end_to_end"]["pipeline_status"] == "COMPLETED"
    assert stages["end_to_end"]["metrics"]["missed_material_samples"] == 0
    assert stages["end_to_end"]["metrics"]["wer"]["numerator"] == 0
    assert h.closes == h.preprocessing_calls == 2
    assert record["evidence_mode"] == "offline-contract"
    assert record["telemetry"]["cost"] == {"numerator": 3, "denominator": 5}
    assert all(type(call["duration_ns"]) is int for call in record["telemetry"]["calls"])
    rendered = canonical_json(record) + caplog.text
    for sensitive in ("Kubernetes API", "private-prompt-marker", str(h.root), "contract.wav", "transcript_json"):
        assert sensitive not in rendered
    assert "timestamps" not in rendered


def test_changed_context_recovery_reduces_independently_labeled_loss(case):
    h = case(omission=True)
    record = invoke(h)
    stages = {item["stage"]: item for item in record["stages"]}
    assert stages["baseline_asr"]["metrics"]["missed_samples"] == h.fixture.sample_count
    assert stages["recovery"]["metrics"]["recovery_success_rate"] == {"numerator": 1, "denominator": 1}
    assert stages["end_to_end"]["metrics"]["missed_samples"] == 0
    assert record["recovery"]["attempts"]
    assert all(item["request_interval"] != record["chunks"][0]["request_interval"] for item in record["recovery"]["attempts"])


def test_silent_speech_loss_28_second_contract_never_reports_false_success_as_pass(case):
    h = case(count=28 * 16000, omission=True, recover=False)
    record = invoke(h)
    final = next(s for s in record["stages"] if s["stage"] == "end_to_end")
    assert final["pipeline_status"] == "COMPLETED_WITH_WARNINGS"
    assert final["metrics"]["missed_material_samples"] == 28 * 16000
    assert final["metrics"]["false_success"] is True
    assert record["quality_gates"]["status"] == record["status"] == "FAIL"
    assert record["evidence_mode"] == "offline-contract"


def test_confirmed_silence_hallucination_is_not_coverage_or_an_empty_reference_pass(case):
    h = case(speech=False, hallucination=True)
    final = next(s for s in invoke(h)["stages"] if s["stage"] == "end_to_end")
    assert final["metrics"]["coverage_rate"] is final["metrics"]["wer"] is None
    assert final["metrics"]["hallucinated_samples"] == h.fixture.sample_count
    assert final["metrics"]["hallucination_rate"] == {"numerator": 1, "denominator": 1}


def test_correction_failure_has_no_raw_asr_fallback(case, caplog):
    h = case(correction_failure=True)
    record = invoke(h)
    stages = {item["stage"]: item for item in record["stages"]}
    assert stages["baseline_asr"]["metrics"]["wer"]["numerator"] == 0
    assert stages["correction"]["status"] == stages["end_to_end"]["status"] == "FAIL"
    assert stages["correction"]["metrics"] is stages["end_to_end"]["metrics"] is None
    assert record["status"] == "FAIL"
    assert "private-response-marker" not in canonical_json(record) + caplog.text


def test_missing_reference_remains_unavailable_without_calling_any_stage(case):
    h = case()
    (h.root / h.fixture.reference.path).unlink()
    record = invoke(h)
    assert record["status"] == record["quality_gates"]["status"] == "UNAVAILABLE"
    assert h.preprocessing_calls == 0 and not h.calls


def test_fixed_clock_report_matrix_is_canonical_and_preserves_boundary_evidence(case):
    h = case()
    matrix = ConfigurationMatrix.model_validate(matrix_document())
    def run():
        return run_configuration_matrix(h.manifest, h.root, matrix, lambda settings: (h.preprocessing, h.asr, h.corrector),
                                        h.settings, expected_model_sha256="d" * 64,
                                        clock=Clock(), evidence_mode="offline-contract", fixtures=[h.fixture])
    records = run()
    assert canonical_json(records) == canonical_json(run())
    assert len({r["case_configuration_id"] for r in records}) == 2
    assert all(r["chunks"][-1]["core_interval"]["end_sample"] == h.fixture.sample_count for r in records)
    assert any(c["end_boundary_reason"] == "forced-continuous-speech" for r in records for c in r["chunks"])
    assert all(c["request_interval"]["start_sample"] <= c["core_interval"]["start_sample"] for r in records for c in r["chunks"])
    # A subset cannot stand in for the whole approved matrix.
    with pytest.raises(EvaluationError):
        build_transcription_report(h.manifest, matrix, records)


def test_reports_weight_metrics_baselines_and_unavailable_cases_explicitly(case):
    h = case()
    matrix = ConfigurationMatrix.model_validate({**matrix_document(), "variants": matrix_document()["variants"][:1]})
    records = run_configuration_matrix(h.manifest, h.root, matrix, lambda settings: (h.preprocessing, h.asr, h.corrector),
                                        h.settings, expected_model_sha256="d" * 64, clock=Clock(), evidence_mode="offline-contract")
    report = build_transcription_report(h.manifest, matrix, records)
    assert report["quality_gate_status"] == "UNAVAILABLE"  # Coverage-only contract fixture has no source.
    assert report["aggregates"]["all"]["case_count"] == 2
    assert report["aggregates"]["all"]["unavailable_count"] == 1
    compatible = build_transcription_report(h.manifest, matrix, list(reversed(records)), baseline=report)
    assert any(c["status"] == "COMPARABLE" for c in compatible["baseline_comparisons"])
    assert compatible["regressions"] == []
    changed = json.loads(canonical_json(report))
    changed["dataset"]["dataset_version"] = "different"
    incompatible = build_transcription_report(h.manifest, matrix, records, baseline=changed)
    assert all(c["status"] == "INCOMPATIBLE" for c in incompatible["baseline_comparisons"])
    assert "Kubernetes API" not in canonical_json(compatible)


def test_live_evaluation_requires_opt_in_and_explicit_credentials(monkeypatch):
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                        OPENROUTER_API_KEY=None, transcript_correction_model="test/corrector")
    monkeypatch.delenv("RUN_OPENROUTER_LIVE_EVALUATION", raising=False)
    with pytest.raises(EvaluationError):
        require_live_evaluation(settings)
    monkeypatch.setenv("RUN_OPENROUTER_LIVE_EVALUATION", "1")
    with pytest.raises(EvaluationError):
        require_live_evaluation(settings)
    require_live_evaluation(settings.model_copy(update={"openrouter_api_key": SecretStr("contract-secret")}))


def test_unknown_provider_cost_keeps_total_null_and_known_subtotal_exact(case):
    h = case()
    original = h.corrector.complete
    h.corrector.complete = lambda request: replace(original(request), usage=CorrectionUsage())
    telemetry = invoke(h)["telemetry"]
    assert telemetry["cost"] is None
    assert telemetry["reported_cost_call_count"] == 2
    assert telemetry["reported_cost_subtotal"] == {"numerator": 1, "denominator": 5}


def test_baseline_policy_uses_only_explicit_tolerance_and_compatible_identity(case):
    h = case()
    document = matrix_document()
    document["variants"] = document["variants"][:1]
    document["baseline_policies"] = [{
        "stage": "end_to_end", "metric": "wer", "direction": "lower",
        "maximum_regression": {"numerator": 0, "denominator": 1}, "basis_version": "reviewed-1",
    }]
    matrix = ConfigurationMatrix.model_validate(document)
    records = run_configuration_matrix(h.manifest, h.root, matrix, lambda settings: (h.preprocessing, h.asr, h.corrector),
                                       h.settings, expected_model_sha256="d" * 64, clock=Clock(), evidence_mode="offline-contract")
    baseline = build_transcription_report(h.manifest, matrix, records)
    changed = json.loads(canonical_json(records))
    final = next(s for s in changed[0]["stages"] if s["stage"] == "end_to_end")
    before = Fraction(**final["metrics"]["wer"])
    final["metrics"]["wer"] = {"numerator": (before + 1).numerator, "denominator": (before + 1).denominator}
    report = build_transcription_report(h.manifest, matrix, changed, baseline=baseline)
    assert report["quality_gate_status"] == "FAIL"
    assert len(report["regressions"]) == 1
    assert report["regressions"][0]["delta"] == {"numerator": 1, "denominator": 1}
    # Unknown baseline fields never become durable strings in the new report.
    baseline["private-diagnostic"] = "private-baseline-marker"
    baseline["results"][0]["identity"]["reference_sha256"] = "e" * 64
    report = build_transcription_report(h.manifest, matrix, changed, baseline=baseline)
    assert report["regressions"] == []
    assert "private-baseline-marker" not in canonical_json(report)


def test_stage_aggregate_pools_edit_counts_instead_of_averaging_rates(case):
    h = case()
    matrix = ConfigurationMatrix.model_validate({**matrix_document(), "variants": matrix_document()["variants"][:1]})
    records = run_configuration_matrix(h.manifest, h.root, matrix, lambda settings: (h.preprocessing, h.asr, h.corrector),
                                       h.settings, expected_model_sha256="d" * 64, clock=Clock(), evidence_mode="offline-contract")
    modified = json.loads(canonical_json(records))
    for index, record in enumerate(modified):
        stage = next(s for s in record["stages"] if s["stage"] == "end_to_end")
        stage["metrics"] = {"word_errors": 1 if index == 0 else 0, "reference_words": 2 if index == 0 else 8}
    report = build_transcription_report(h.manifest, matrix, modified)
    assert report["aggregates"]["all"]["stages"]["end_to_end"]["metrics"]["wer"] == {"numerator": 1, "denominator": 10}
