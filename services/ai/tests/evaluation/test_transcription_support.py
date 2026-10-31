"""Offline arithmetic/contract controls, never Vietnamese audio ground truth."""

import copy
import hashlib
import json
import unicodedata
from fractions import Fraction

import pytest

from sme_meeting_ai.audio import SampleInterval

from .support import CONDITIONS, EvaluationError, Fixture, Manifest, canonical_json
from .test_evaluation_support import fixture_dict, manifest_dict, save_manifest
from .transcription_support import (
    ConfigurationMatrix,
    compute_text_metrics,
    compute_transcription_metrics,
    evaluate_transcription_gates,
    load_configuration,
    load_reference,
    require_transcription_manifest,
    validate_output_path,
)


def reference_document(fixture):
    return {
        "schema_version": 1, "fixture_id": fixture.fixture_id,
        "reference_version": "human-reference-1", "annotation_version": fixture.annotation_version,
        "origin": "independent-human", "language": "vi", "sample_count": fixture.sample_count,
        "segments": [
            {"start_sample": label.start_sample, "end_sample": label.end_sample,
             "label": label.label, "text": "Kubernetes API" if label.label == "speech" else ""}
            for label in fixture.labels
        ],
    }


def attach_reference(root, fixture):
    # Public, invented contract strings only; these are not audio annotations.
    document = reference_document(fixture)
    raw = canonical_json(document).encode()
    path = root / f"{fixture.fixture_id}.reference.json"
    path.write_bytes(raw)
    return Fixture.model_validate({**fixture.model_dump(), "reference": {
        "schema_version": 1, "path": path.name, "sha256": hashlib.sha256(raw).hexdigest(),
        "reference_version": "human-reference-1", "origin": "independent-human",
    }})


def transcription_manifest(root):
    document = manifest_dict()
    document["schema_version"] = 2
    document["fixtures"] = [attach_reference(root, Fixture.model_validate(fixture_dict())).model_dump()]
    return save_manifest(root, document)


def matrix_document():
    return {
        "schema_version": 1, "configuration_version": "contract-matrix-1",
        "baseline_variant": "short", "baseline_policies": [],
        "variants": [
            {"variant_id": "short", "version": "1", "target_samples": 512,
             "max_request_samples": 768, "overlap_samples": 128, "boundary_search_samples": 64},
            {"variant_id": "long", "version": "1", "target_samples": 1024,
             "max_request_samples": 1536, "overlap_samples": 256, "boundary_search_samples": 0},
        ],
    }


def test_unicode_vietnamese_technical_vocabulary_and_code_switching():
    text = "Tôi triển khai Kubernetes API v2, dùng C++ và C# lúc 10 giờ."
    metrics = compute_text_metrics(text, unicodedata.normalize("NFD", text.upper()))
    assert metrics["wer"] == metrics["cer"] == {"numerator": 0, "denominator": 1}
    assert compute_text_metrics("ma má mà mã mạ", "ma ma ma ma ma")["word_substitutions"] == 4
    assert compute_text_metrics("C++ C# v2.1", "C# C++ v2.2")["word_substitutions"] == 3
    assert text not in repr(metrics)


def test_edit_counts_tie_breaking_and_zero_denominators():
    metrics = compute_text_metrics("một hai", "hai một")
    assert (metrics["word_substitutions"], metrics["word_deletions"], metrics["word_insertions"]) == (2, 0, 0)
    assert compute_text_metrics("một hai", "một")["word_deletions"] == 1
    assert compute_text_metrics("một", "một hai")["word_insertions"] == 1
    for hypothesis in ("", "lời bịa"):
        empty = compute_text_metrics("", hypothesis)
        assert empty["wer"] is empty["cer"] is None
        assert empty["reference_words"] == empty["reference_characters"] == 0
    assert compute_text_metrics("ừ", "")["wer"] == {"numerator": 1, "denominator": 1}


def test_independent_coverage_hallucination_recovery_and_pipeline_denominators():
    fixture = Fixture.model_validate(fixture_dict())
    initial = [SampleInterval(0, 100)]
    final = [SampleInterval(0, 200), SampleInterval(300, 650), SampleInterval(600, 900)]
    metrics = compute_transcription_metrics(
        fixture, final, initial_supported=initial, unresolved=[SampleInterval(900, 1031)],
        pipeline_speech_samples=600, pipeline_unresolved_samples=100,
        pipeline_status="COMPLETED_WITH_WARNINGS", result_available=True,
    )
    assert metrics["covered_speech_samples"] == 500
    assert metrics["missed_samples"] == metrics["missed_material_samples"] == 131
    assert metrics["hallucinated_samples"] == 300
    assert metrics["hallucination_rate"] == {"numerator": 1, "denominator": 1}
    assert all(metrics["hallucination_by_label"][kind]["samples"] == 100 for kind in ("silence", "noise", "music"))
    assert metrics["initial_unresolved_speech_samples"] == 531
    assert metrics["recovered_speech_samples"] == 400
    assert metrics["recovery_success_rate"] == {"numerator": 400, "denominator": 531}
    assert metrics["unresolved_rate"] == {"numerator": 131, "denominator": 631}
    assert metrics["pipeline_unresolved_rate"] == {"numerator": 1, "denominator": 6}
    assert metrics["false_success"] is True
    assert compute_transcription_metrics(fixture, final)["recovery_success_rate"] is None
    assert compute_transcription_metrics(fixture, [SampleInterval(0, 1031)], initial_supported=[SampleInterval(0, 1031)])["recovery_success_rate"] is None


def test_coverage_cannot_be_inferred_from_correct_text_or_vad():
    fixture = Fixture.model_validate(fixture_dict())
    metrics = compute_transcription_metrics(fixture, [])
    metrics.update(compute_text_metrics("Kubernetes API", "Kubernetes API"))
    assert metrics["wer"]["numerator"] == 0
    assert metrics["missed_samples"] == 631


@pytest.mark.parametrize("damage", [
    "digest", "missing", "symlink", "parent-symlink", "duplicate-key", "version",
    "origin", "gap", "wrong-label", "empty-speech", "non-speech-text", "foreign-fixture", "surrogate",
])
def test_reference_loading_fails_closed_without_private_diagnostics(tmp_path, damage):
    fixture = attach_reference(tmp_path, Fixture.model_validate(fixture_dict()))
    path = tmp_path / fixture.reference.path
    document = reference_document(fixture)
    if damage == "missing":
        path.unlink()
    elif damage == "symlink":
        destination = tmp_path / "other.json"
        path.rename(destination)
        path.symlink_to(destination)
    elif damage == "parent-symlink":
        directory = tmp_path / "actual"
        directory.mkdir()
        path.rename(directory / path.name)
        (tmp_path / "alias").symlink_to(directory, target_is_directory=True)
        fixture = Fixture.model_validate({**fixture.model_dump(), "reference": {
            **fixture.reference.model_dump(), "path": "alias/" + path.name,
        }})
    else:
        if damage == "version":
            document["reference_version"] = "other"
        elif damage == "origin":
            document["origin"] = "asr-output"
        elif damage == "gap":
            document["segments"][1]["start_sample"] += 1
        elif damage == "wrong-label":
            document["segments"][1]["label"] = "silence"
        elif damage == "empty-speech":
            document["segments"][0]["text"] = " "
        elif damage == "non-speech-text":
            document["segments"][1]["text"] = "private-reference-marker"
        elif damage == "foreign-fixture":
            document["fixture_id"] = "other"
        elif damage == "surrogate":
            document["segments"][0]["text"] = "private-reference-marker\ud800"
        raw = canonical_json(document).encode()
        if damage == "duplicate-key":
            raw = raw.replace(b'"schema_version":1', b'"schema_version":1,"schema_version":1')
        path.write_bytes(raw)
        if damage != "digest":
            fixture = Fixture.model_validate({**fixture.model_dump(), "reference": {
                **fixture.reference.model_dump(), "sha256": hashlib.sha256(raw).hexdigest(),
            }})
        else:
            path.write_bytes(b"private-reference-marker")
    with pytest.raises(EvaluationError) as caught:
        load_reference(tmp_path, fixture)
    assert str(caught.value) == "evaluation reference invalid or unavailable"
    assert "private-reference-marker" not in repr(caught.value)


def test_versioned_reference_and_transcription_manifest_require_real_contract(tmp_path):
    manifest = transcription_manifest(tmp_path)
    require_transcription_manifest(manifest)
    reference = load_reference(tmp_path, manifest.fixtures[0])
    assert reference.sample_count == manifest.fixtures[0].sample_count
    assert "Kubernetes API" not in repr(reference)
    legacy = Manifest.model_validate(manifest_dict())
    with pytest.raises(EvaluationError):
        require_transcription_manifest(legacy)
    missing = manifest.model_copy(update={"fixtures": [manifest.fixtures[0].model_copy(update={"reference": None})]})
    with pytest.raises(EvaluationError):
        require_transcription_manifest(missing)


def test_gates_are_independent_explicit_and_regression_is_mandatory(tmp_path):
    manifest = transcription_manifest(tmp_path)
    fixture = manifest.fixtures[0]
    stages = {"end_to_end": {"metrics": {
        **compute_transcription_metrics(fixture, [], pipeline_status="COMPLETED", result_available=True),
        **compute_text_metrics("đúng", "đúng"),
    }, "status": "PASS"}}
    gates = evaluate_transcription_gates(manifest, fixture, stages)
    assert gates["status"] == "FAIL"
    assert any(check["metric"] == "missed_material_samples" and check["status"] == "FAIL" for check in gates["checks"])
    assert evaluate_transcription_gates(manifest, fixture, {})["status"] == "UNAVAILABLE"
    doc = manifest.model_dump(exclude={"manifest_sha256"})
    doc["transcription_quality_gates"] = [{
        "stage": "end_to_end", "metric": "wer", "maximum": {"numerator": 0, "denominator": 1},
        "basis_version": "reviewed-1",
    }]
    manifest = Manifest.model_validate(doc)
    checks = evaluate_transcription_gates(manifest, fixture, stages)["checks"]
    assert next(c for c in checks if c["metric"] == "wer")["status"] == "PASS"
    stages["end_to_end"]["metrics"]["wer"] = None
    assert next(c for c in evaluate_transcription_gates(manifest, fixture, stages)["checks"] if c["metric"] == "wer")["status"] == "UNESTABLISHED"


def test_unapproved_gate_and_configuration_policies_are_not_invented(tmp_path):
    document = matrix_document()
    path = tmp_path / "config.json"
    path.write_text(json.dumps(document))
    matrix = load_configuration(path)
    assert matrix.baseline_variant == "short"
    assert matrix.baseline_policies == []
    for mutate in ("duplicate", "geometry", "baseline", "secret", "unversioned-policy"):
        bad = copy.deepcopy(document)
        if mutate == "duplicate":
            bad["variants"].append(copy.deepcopy(bad["variants"][0]))
        elif mutate == "geometry":
            bad["variants"][0]["overlap_samples"] = 1000
        elif mutate == "baseline":
            bad["baseline_variant"] = "missing"
        elif mutate == "secret":
            bad["variants"][0]["api_key"] = "private-key"
        else:
            bad["baseline_policies"] = [{"stage": "end_to_end", "metric": "wer", "direction": "lower", "maximum_regression": {"numerator": 0, "denominator": 1}}]
        path.write_text(json.dumps(bad))
        with pytest.raises(EvaluationError):
            load_configuration(path)
    assert ConfigurationMatrix.model_validate(document).variants[0].target_samples == 512


@pytest.mark.parametrize("relative", ["../reference.json", "/reference.json", "alias\\reference.json", "a:reference.json"])
def test_reference_descriptor_rejects_paths(relative):
    document = fixture_dict()
    document["reference"] = {"schema_version": 1, "path": relative, "sha256": "d" * 64,
                             "reference_version": "1", "origin": "independent-human"}
    with pytest.raises(ValueError):
        Fixture.model_validate(document)


def test_output_must_not_alias_or_sit_beside_private_sources_or_models(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    models = tmp_path / "models"
    models.mkdir()
    model = models / "model.onnx"
    model.write_bytes(b"model")
    output = tmp_path / "report.json"
    validate_output_path(output, assets, [model])
    for path in (assets / "report.json", models / "report.json", model):
        with pytest.raises(EvaluationError):
            validate_output_path(path, assets, [model])
    output.hardlink_to(model)
    with pytest.raises(EvaluationError):
        validate_output_path(output, assets, [model])


def test_legacy_manifest_condition_coverage_remains_compatible(tmp_path):
    document = manifest_dict()
    document["fixtures"][0]["conditions"] = sorted(CONDITIONS - {"soft-speech", "technical-vocabulary", "code-switching"})
    assert save_manifest(tmp_path, document).schema_version == 1
    document["schema_version"] = 2
    with pytest.raises(EvaluationError):
        save_manifest(tmp_path, document)


def test_text_error_rates_can_exceed_one_without_clipping():
    metrics = compute_text_metrics("API", "API v2 Kubernetes deploy")
    assert Fraction(**metrics["wer"]) == 3
