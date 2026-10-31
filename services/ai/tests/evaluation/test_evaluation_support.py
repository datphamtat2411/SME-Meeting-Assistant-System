import copy
import hashlib
import json
import wave
from dataclasses import replace
from fractions import Fraction
from types import SimpleNamespace

import pytest

from sme_meeting_ai.audio import SampleInterval, SpeechMapBuilder, VadLabel
from sme_meeting_ai.audio.models import (
    AudioProvenance,
    DetectionProvenance,
    EvidenceFrame,
    NormalizedAudioArtifact,
    SpeechEnergyEvidence,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import PreprocessingProvenance

from .fixture_builder import build_control
from .support import (
    CONDITIONS,
    EvaluationError,
    Fixture,
    analyze_result,
    build_report,
    canonical_json,
    digest_json,
    evaluate_gates,
    intersect,
    load_manifest,
    merge,
    quality_metrics,
    require_pinned_model,
    subtract,
    verify_source,
    write_report,
)


def interval(start, end):
    return SampleInterval(start, end)


def fixture_dict():
    return {
        "fixture_id": "vi-boundary-regression-1",
        "path": "audio/opaque.wav",
        "source_sha256": "a" * 64,
        "kind": "recording",
        "language": "vi",
        "conditions": sorted(CONDITIONS),
        "annotation_version": "human-1",
        "annotation_origin": "independent-human",
        "sample_count": 1031,
        "labels": [
            {"start_sample": 0, "end_sample": 200, "label": "speech", "critical": True},
            {"start_sample": 200, "end_sample": 300, "label": "ambiguous"},
            {"start_sample": 300, "end_sample": 400, "label": "noise"},
            {"start_sample": 400, "end_sample": 500, "label": "music"},
            {"start_sample": 500, "end_sample": 600, "label": "silence"},
            {"start_sample": 600, "end_sample": 1031, "label": "speech", "material": True},
        ],
        "anchors": [
            {"start_sample": 0, "end_sample": 10, "pcm_sha256": "b" * 64},
            {"start_sample": 1021, "end_sample": 1031, "pcm_sha256": "c" * 64},
        ],
    }


def manifest_dict():
    return {
        "schema_version": 1,
        "dataset_id": "vietnamese-preprocessing",
        "dataset_version": "1",
        "privacy_approved": True,
        "legal_approved": True,
        "approval_version": "approval-1",
        "labeling_guideline_version": "guidelines-1",
        "long_audio_min_samples": 1000,
        "fixtures": [fixture_dict()],
        "quality_gates": [],
    }


def save_manifest(tmp_path, document):
    (tmp_path / "manifest.json").write_text(json.dumps(document))
    return load_manifest(tmp_path)


def test_manifest_preserves_independent_labels_and_raw_manifest_digest(tmp_path):
    manifest = save_manifest(tmp_path, manifest_dict())
    assert manifest.manifest_sha256 == hashlib.sha256((tmp_path / "manifest.json").read_bytes()).hexdigest()
    assert manifest.fixtures[0].annotation_origin == "independent-human"
    assert manifest.fixtures[0].labels[0].critical is True
    assert manifest.quality_gates == []


@pytest.mark.parametrize("damage", [
    "privacy", "legal", "vad-labels", "synthetic-speech", "english", "missing-condition",
    "missing-label", "gap", "overlap", "out-of-bounds", "float-time", "boolean-time",
    "duplicate-id", "traversal", "absolute-path", "missing-anchor", "bad-boundary",
    "short-long-audio", "sensitive-field", "unversioned-gate", "bad-digest",
])
def test_manifest_fails_closed(tmp_path, damage):
    document = manifest_dict()
    item = document["fixtures"][0]
    if damage in {"privacy", "legal"}:
        document[f"{damage}_approved"] = False
    elif damage == "vad-labels":
        item["annotation_origin"] = "vad-output"
    elif damage == "synthetic-speech":
        item["kind"] = "synthetic"
        item["annotation_origin"] = "synthetic-control"
    elif damage == "english":
        item["language"] = "en"
    elif damage == "missing-condition":
        item["conditions"].remove("weak-distant-speech")
    elif damage == "missing-label":
        item["labels"][2]["label"] = "silence"
    elif damage == "gap":
        item["labels"][1]["start_sample"] += 1
    elif damage == "overlap":
        item["labels"][1]["start_sample"] -= 1
    elif damage == "out-of-bounds":
        item["labels"][-1]["end_sample"] += 1
    elif damage in {"float-time", "boolean-time"}:
        item["labels"][0]["start_sample"] = 0.0 if damage == "float-time" else False
    elif damage == "duplicate-id":
        document["fixtures"].append(copy.deepcopy(item))
    elif damage in {"traversal", "absolute-path"}:
        item["path"] = "../private.wav" if damage == "traversal" else "/private.wav"
    elif damage == "missing-anchor":
        item["anchors"].pop()
    elif damage == "bad-boundary":
        item["labels"][0]["label"] = "silence"
        item["labels"][0].pop("critical")
    elif damage == "short-long-audio":
        document["long_audio_min_samples"] = 2000
    elif damage == "sensitive-field":
        item["transcript"] = "private meeting content"
    elif damage == "unversioned-gate":
        document["quality_gates"] = [{"metric": "coverage_rate", "minimum": {"numerator": 1, "denominator": 2}}]
    else:
        item["source_sha256"] = "not-a-digest"
    with pytest.raises(EvaluationError, match="manifest"):
        save_manifest(tmp_path, document)


def test_missing_manifest_and_duplicate_json_keys_are_rejected(tmp_path):
    with pytest.raises(EvaluationError):
        load_manifest(tmp_path)
    (tmp_path / "manifest.json").write_text('{"schema_version": 1, "schema_version": 1}')
    with pytest.raises(EvaluationError):
        load_manifest(tmp_path)


def test_source_digest_and_symlink_escape_are_rejected(tmp_path):
    source = tmp_path / "audio"
    source.mkdir()
    (source / "opaque.wav").write_bytes(b"source")
    item = fixture_dict()
    item["source_sha256"] = hashlib.sha256(b"source").hexdigest()
    fixture = Fixture.model_validate(item)
    assert verify_source(tmp_path, fixture) == source / "opaque.wav"
    (source / "opaque.wav").write_bytes(b"changed")
    with pytest.raises(EvaluationError, match="source"):
        verify_source(tmp_path, fixture)
    (source / "opaque.wav").unlink()
    (source / "opaque.wav").symlink_to(tmp_path.parent / "outside.wav")
    with pytest.raises(EvaluationError, match="source"):
        verify_source(tmp_path, fixture)


def test_interval_arithmetic_uses_half_open_samples():
    assert merge([interval(4, 8), interval(0, 4), interval(7, 10)]) == [interval(0, 10)]
    assert intersect([interval(0, 10)], [interval(10, 20)]) == []
    assert intersect([interval(0, 10)], [interval(3, 7)]) == [interval(3, 7)]
    assert subtract([interval(0, 20)], [interval(3, 7), interval(10, 25)]) == [interval(0, 3), interval(7, 10)]
    assert subtract([interval(0, 20)], []) == [interval(0, 20)]


def test_quality_exposes_missed_flags_false_positives_ambiguity_and_timing():
    fixture = Fixture.model_validate(fixture_dict())
    metrics = quality_metrics(fixture, [interval(20, 350), interval(450, 900)], [interval(100, 700)])
    assert metrics["confirmed_speech_samples"] == 631
    assert metrics["covered_speech_samples"] == 480
    assert metrics["missed_samples"] == 151
    assert metrics["largest_missed_samples"] == 131
    assert metrics["missed_regions"] == [
        {"start_sample": 0, "end_sample": 20, "critical": True, "material": False},
        {"start_sample": 900, "end_sample": 1031, "critical": False, "material": True},
    ]
    assert metrics["coverage_rate"] == {"numerator": 480, "denominator": 631}
    assert metrics["false_positive_samples"] == 200
    assert metrics["false_positive_rate"] == {"numerator": 2, "denominator": 3}
    assert metrics["false_positives_by_label"]["noise"]["samples"] == 50
    assert metrics["false_positives_by_label"]["music"]["samples"] == 50
    assert metrics["ambiguous_samples"] == 100
    assert metrics["uncertainty_by_label"]["speech"]["samples"] == 200
    assert metrics["uncertainty_by_label"]["ambiguous"]["samples"] == 100
    assert metrics["timing"][0]["onset_error_samples"] == 20
    assert metrics["timing"][0]["offset_error_samples"] == 150
    assert metrics["timing"][0]["onset_error_seconds"] == {"numerator": 1, "denominator": 800}
    assert metrics["timing"][1]["onset_error_samples"] == -150


def test_empty_predictions_and_no_speech_do_not_claim_perfect_coverage():
    fixture = Fixture.model_validate(fixture_dict())
    metrics = quality_metrics(fixture, [], [])
    assert metrics["missed_samples"] == 631
    assert metrics["timing"][0]["status"] == "MISSED"
    assert metrics["timing"][0]["onset_error_samples"] is None
    silence = fixture.model_copy(update={"labels": [fixture.labels[4].model_copy(update={"start_sample": 0, "end_sample": 1031})]})
    metrics = quality_metrics(silence, [interval(0, 1)], [])
    assert metrics["coverage_rate"] is None
    assert metrics["false_positive_rate"] == {"numerator": 1, "denominator": 1031}


def test_quality_gates_require_basis_and_never_default_to_pass(tmp_path):
    manifest = save_manifest(tmp_path, manifest_dict())
    metrics = quality_metrics(manifest.fixtures[0], [], [])
    assert evaluate_gates(manifest, metrics) == {"status": "UNESTABLISHED", "checks": []}
    document = manifest_dict()
    document["quality_gates"] = [{
        "metric": "coverage_rate", "minimum": {"numerator": 1, "denominator": 2},
        "basis_version": "reviewed-baseline-1",
    }]
    manifest = save_manifest(tmp_path, document)
    assert evaluate_gates(manifest, metrics)["status"] == "FAIL"
    metrics["coverage_rate"] = None
    assert evaluate_gates(manifest, metrics)["status"] == "UNESTABLISHED"
    metrics["coverage_rate"] = {"numerator": 1, "denominator": 2}
    assert evaluate_gates(manifest, metrics)["status"] == "PASS"


@pytest.mark.parametrize("kind", ["silence", "noise", "music", "long-audio"])
def test_synthetic_controls_are_deterministic_and_contain_no_speech(tmp_path, kind):
    first = build_control(tmp_path / "first.wav", kind, sample_count=1031)
    second = build_control(tmp_path / "second.wav", kind, sample_count=1031)
    assert (tmp_path / "first.wav").read_bytes() == (tmp_path / "second.wav").read_bytes()
    assert first["source_sha256"] == second["source_sha256"]
    assert first["annotation_origin"] == "synthetic-control"
    assert all(label["label"] != "speech" for label in first["labels"])
    assert first["anchors"][0]["start_sample"] == 0
    assert first["anchors"][-1]["end_sample"] == 1031
    with pytest.raises(EvaluationError):
        build_control(tmp_path / "speech.wav", "weak-distant-speech", sample_count=1031)


@pytest.fixture
def result_case(tmp_path):
    """Contract-only evidence; this is never used by the actual-model suite."""
    pcm = b"\0\0" * 512 + b"\x10\x27" * 519
    path = tmp_path / "normalized.wav"
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", ""))
        output.writeframes(pcm)
    item = fixture_dict()
    item["anchors"][0]["pcm_sha256"] = hashlib.sha256(pcm[:20]).hexdigest()
    item["anchors"][1]["pcm_sha256"] = hashlib.sha256(pcm[-20:]).hexdigest()
    document = manifest_dict()
    document["fixtures"] = [item]
    manifest = save_manifest(tmp_path, document)
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                        audio_speech_map_boundary_padding_samples=10, audio_speech_map_merge_gap_samples=0)
    normalization = AudioProvenance(item["fixture_id"], "1", "ffmpeg", "7.1", {}, {"temp_dir": "/private/work", "decoder_threads": 1})
    detection = DetectionProvenance("silero-vad", "5", "d" * 64, "onnxruntime-cpu", "1", {
        "sample_rate_hz": 16000, "frame_samples": 512, "tail_padding": "model-only-zero-padding",
        "speech_threshold": 0.6, "non_speech_threshold": 0.35,
    })
    frames = [
        EvidenceFrame(0, 512, 0.1, VadLabel.LIKELY_NON_SPEECH, 0, float("-inf"), 0),
        EvidenceFrame(512, 1024, 0.45, VadLabel.UNCERTAIN, 10000 / 32768, -10.308998699194358, 0),
        EvidenceFrame(1024, 1031, 0.1, VadLabel.LIKELY_NON_SPEECH, 10000 / 32768, -10.308998699194358, 505),
    ]
    # Use the real mapper with contract objects, without normalization or inference.
    audio = NormalizedAudioArtifact(path, item["fixture_id"], None, 1031, normalization, None)
    evidence = SpeechEnergyEvidence(item["fixture_id"], 1031, 3, 0, 2, 1, detection, path, None)
    object.__setattr__(evidence, "iter_frames", lambda: iter(frames))
    speech_map = SpeechMapBuilder(settings).build(audio, evidence)
    provenance = PreprocessingProvenance("1", item["fixture_id"], 1031, normalization, detection, speech_map.provenance)
    result = SimpleNamespace(normalized_artifact=audio, speech_evidence=evidence, speech_map=speech_map,
                             provenance=provenance, warnings=speech_map.quality.warnings)
    return manifest, result, frames


def test_result_records_uncertainty_regression_evidence_and_safe_provenance(result_case, tmp_path):
    manifest, result, _ = result_case
    record = analyze_result(manifest, manifest.fixtures[0], result, expected_model_sha256="d" * 64)
    assert record["metrics"]["missed_samples"] == 631
    assert record["metrics"]["missed_uncertain_samples"] == 431
    assert record["metrics"]["missed_likely_non_speech_samples"] == 207
    assert record["evidence"]["high_energy_non_speech_samples"] == 7
    assert record["integrity"]["frame_coverage_samples"] == 1031
    assert record["integrity"]["tail_padding_samples"] == 505
    assert record["quality_gates"]["status"] == "UNESTABLISHED"
    assert record["provenance"]["decoder_version"] == "7.1"
    report = build_report(manifest, [record])
    output = tmp_path / "result.json"
    write_report(output, report)
    first = output.read_bytes()
    assert json.loads(first)["schema_version"] == 1
    assert b"private" not in first and b"normalized.wav" not in first and b"audio/" not in first
    assert b"Infinity" not in first and b"NaN" not in first
    write_report(output, build_report(manifest, [record]))
    assert output.read_bytes() == first
    assert record["evaluation_id"] == analyze_result(manifest, manifest.fixtures[0], result, expected_model_sha256="d" * 64)["evaluation_id"]
    result.provenance = replace(result.provenance, pipeline_version="2")
    changed = analyze_result(manifest, manifest.fixtures[0], result, expected_model_sha256="d" * 64)
    assert changed["evaluation_id"] != record["evaluation_id"]
    with pytest.raises(EvaluationError, match="incomplete"):
        build_report(manifest, [])
    assert digest_json({"b": 1, "a": 2}) == digest_json({"a": 2, "b": 1})
    assert canonical_json({"time": {"numerator": 1, "denominator": 16000}})


def test_detected_boundary_speech_is_protected_and_clipped_exactly(result_case):
    manifest, result, frames = result_case
    for index, frame in enumerate(frames):
        frames[index] = replace(frame, vad_probability=0.9, vad_label=VadLabel.LIKELY_SPEECH)
    evidence = replace(result.speech_evidence, likely_speech_frame_count=3,
                       likely_non_speech_frame_count=0, uncertain_frame_count=0)
    object.__setattr__(evidence, "iter_frames", lambda: iter(frames))
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                        audio_speech_map_boundary_padding_samples=10, audio_speech_map_merge_gap_samples=0)
    result.speech_evidence = evidence
    result.speech_map = SpeechMapBuilder(settings).build(result.normalized_artifact, evidence)
    result.provenance = replace(result.provenance, speech_map=result.speech_map.provenance)
    result.warnings = result.speech_map.quality.warnings
    record = analyze_result(manifest, manifest.fixtures[0], result, expected_model_sha256="d" * 64)
    assert record["evidence"]["protected_intervals"] == [{"start_sample": 0, "end_sample": 1031}]
    assert record["metrics"]["missed_samples"] == 0
    assert record["metrics"]["false_positive_samples"] == 300
    assert record["integrity"]["boundary_protection_verified"] is True


@pytest.mark.parametrize("damage", ["model", "sample-count", "anchor", "missing-frame", "frame-gap", "padding", "hidden-uncertainty", "bounds", "protection", "provenance"])
def test_integrity_violations_fail_without_quality_thresholds(result_case, damage):
    manifest, result, frames = result_case
    fixture = manifest.fixtures[0]
    if damage == "model":
        expected = "e" * 64
    else:
        expected = "d" * 64
    if damage == "sample-count":
        fixture = fixture.model_copy(update={"sample_count": 1032})
    elif damage == "anchor":
        fixture = fixture.model_copy(update={"anchors": [fixture.anchors[0].model_copy(update={"pcm_sha256": "e" * 64}), fixture.anchors[1]]})
    elif damage == "missing-frame":
        frames.pop()
    elif damage == "frame-gap":
        frames[1] = replace(frames[1], start_sample=513)
    elif damage == "padding":
        frames[-1] = replace(frames[-1], padding_samples=0)
    elif damage == "hidden-uncertainty":
        result.speech_map = replace(result.speech_map, uncertain_intervals=())
    elif damage == "bounds":
        result.speech_map = replace(result.speech_map, speech_intervals=(interval(1000, 1032),))
    elif damage == "protection":
        result.speech_map = replace(result.speech_map, speech_intervals=(interval(0, 512),), protected_intervals=(interval(1, 512),))
    elif damage == "provenance":
        result.provenance = replace(result.provenance, detection=replace(result.provenance.detection, detector_version="other"))
    with pytest.raises(EvaluationError):
        analyze_result(manifest, fixture, result, expected_model_sha256=expected)


def test_large_sample_timing_is_exact():
    sample = 2**53 + 1
    assert Fraction(sample, 16000) * 16000 == sample
    assert intersect([interval(sample, sample + 10)], [interval(sample + 3, sample + 4)]) == [interval(sample + 3, sample + 4)]


def test_model_evaluation_requires_explicit_existing_pinned_model(tmp_path):
    settings = Settings(service_name="test-ai", service_identity="ai-core", _env_file=None,
                        audio_vad_model_path=None, audio_vad_model_sha256=None)
    with pytest.raises(EvaluationError, match="model"):
        require_pinned_model(settings)
    model = tmp_path / "model.onnx"
    model.write_bytes(b"externally provisioned model")
    settings.audio_vad_model_path = model
    with pytest.raises(EvaluationError, match="model"):
        require_pinned_model(settings)
    settings.audio_vad_model_sha256 = "a" * 64
    with pytest.raises(EvaluationError, match="model"):
        require_pinned_model(settings)
    settings.audio_vad_model_sha256 = hashlib.sha256(model.read_bytes()).hexdigest()
    require_pinned_model(settings)


def test_transcription_gate_contract_requires_basis_and_independent_metric_bounds(tmp_path):
    document = manifest_dict()
    document["transcription_quality_gates"] = [{
        "stage": "end_to_end", "metric": "wer", "maximum": {"numerator": 3, "denominator": 2},
        "basis_version": "reviewed-1",
    }]
    assert save_manifest(tmp_path, document).transcription_quality_gates[0].metric == "wer"
    document["transcription_quality_gates"][0].pop("basis_version")
    with pytest.raises(EvaluationError):
        save_manifest(tmp_path, document)
