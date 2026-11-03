"""Synthetic private-dataset lifecycle; never uses real audio or inference."""

import hashlib
import json
import socket
import wave
from copy import deepcopy

import pytest

from sme_meeting_ai.audio import SampleInterval

from .asr_pilot_manifest import (
    load_pilot_manifest,
    sync_manifest,
    validate_pilot_manifest,
)
from .support import EvaluationError, canonical_json, load_manifest
from .test_evaluation_support import fixture_dict, manifest_dict
from .transcription_support import (
    compute_text_metrics,
    compute_transcription_metrics,
    require_transcription_manifest,
)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr(socket.socket, "connect", lambda *a: pytest.fail("network in pilot tests"))


@pytest.fixture
def corpus(tmp_path):
    root = tmp_path / "transcription"
    root.mkdir()
    (root / "audio").mkdir()
    (root / "references").mkdir()
    fixtures = []
    for index in range(6):
        item = fixture_dict()
        count = 1600 + index
        item.update(fixture_id=f"vi-example-{index}", path=f"audio/vi-example-{index}.wav",
                    conditions=["continuous-speech"], sample_count=count,
                    labels=[dict(start_sample=0, end_sample=count, label="speech", critical=index == 1)])
        pcm = (index + 1).to_bytes(2, "little") * count
        with wave.open(str(root / item["path"]), "wb") as output:
            output.setparams((1, 2, 16000, 0, "NONE", ""))
            output.writeframes(pcm)
        item["source_sha256"] = hashlib.sha256((root / item["path"]).read_bytes()).hexdigest()
        item["anchors"] = [dict(start_sample=start, end_sample=end,
                                pcm_sha256=hashlib.sha256(pcm[start * 2:end * 2]).hexdigest())
                           for start, end in ((0, 10), (count - 10, count))]
        fixtures.append(item)
    # Reviewed preprocessing coverage is independent of reference readiness.
    reviewed = manifest_dict()
    reviewed["fixtures"] = [*fixtures, fixture_dict()]
    source = tmp_path / "reviewed.json"
    source.write_text(canonical_json(reviewed))

    def reference(index):
        item = fixtures[index]
        doc = dict(schema_version=1, fixture_id=item["fixture_id"], reference_version="human-1",
                   annotation_version=item["annotation_version"], origin="independent-human", language="vi",
                   sample_count=item["sample_count"], segments=[{k: v for k, v in label.items()
                       if k in {"start_sample", "end_sample", "label"}} | {"text": "Xin chào API" if label["label"] == "speech" else ""}
                       for label in item["labels"]])
        path = root / "references" / f"{item['fixture_id']}.json"
        path.write_text(canonical_json(doc))
        return path

    reference(0)
    reference(1)
    return root, source, fixtures, reference


def test_p01_p04_p12_p13_p14_progressive_partial_manifest(corpus):
    root, source, _, reference = corpus
    first = sync_manifest(source, root)
    assert first["eligible_fixture_count"] == 2
    assert len(first["missing_human_references"]) == 5
    assert not (root / "manifest.json").exists()
    sync_manifest(source, root, write=True)
    original = (root / "manifest.json").read_bytes()
    manifest = validate_pilot_manifest(root)
    assert len(manifest.fixtures) == 2
    assert not manifest.privacy_approved and not manifest.legal_approved
    with pytest.raises(EvaluationError):
        require_transcription_manifest(manifest)
    with pytest.raises(EvaluationError):
        load_manifest(root)
    sync_manifest(source, root, write=True)
    assert (root / "manifest.json").read_bytes() == original
    assert sync_manifest(source, root)["manifest_sha256"] == manifest.manifest_sha256
    for count in (3, 4, 6):
        for index in range(2, count):
            reference(index)
        summary = sync_manifest(source, root, write=True)
        assert summary["eligible_fixture_count"] == count
        assert len(validate_pilot_manifest(root).fixtures) == count
        assert summary["manifest_sha256"] != manifest.manifest_sha256
    assert (root / f"manifest.{hashlib.sha256(original).hexdigest()}.json").read_bytes() == original


@pytest.mark.parametrize("damage", ["malformed", "gap", "overlap", "label", "count", "version", "empty", "nonspeech", "unknown"])
def test_p05_p09_invalid_present_reference_is_visible_and_atomic(corpus, damage):
    root, source, _, reference = corpus
    sync_manifest(source, root, write=True)
    before = (root / "manifest.json").read_bytes()
    path = reference(0)
    doc = json.loads(path.read_bytes())
    if damage == "malformed":
        path.write_text('{"PRIVATE-REFERENCE":')
    else:
        if damage == "gap":
            doc["segments"][0]["start_sample"] = 1
        elif damage == "overlap":
            doc["segments"].append(deepcopy(doc["segments"][0]))
        elif damage == "label":
            doc["segments"][0].update(label="silence", text="")
        elif damage == "count":
            doc["sample_count"] += 1
        elif damage == "version":
            doc["annotation_version"] = "wrong"
        elif damage == "empty":
            doc["segments"][0]["text"] = "  "
        elif damage == "nonspeech":
            doc["segments"][0]["label"] = "music"
        else:
            doc["fixture_id"] = "unknown"
        path.write_text(canonical_json(doc))
    with pytest.raises(EvaluationError) as caught:
        sync_manifest(source, root, write=True)
    assert "PRIVATE-REFERENCE" not in str(caught.value) and str(root) not in str(caught.value)
    assert (root / "manifest.json").read_bytes() == before


@pytest.mark.parametrize("damage", ["source", "reference", "samples", "anchor", "duplicate", "independence", "minimum", "symlink"])
def test_p06_p07_p08_integrity_and_independent_minimum(corpus, damage):
    root, source, _, _ = corpus
    sync_manifest(source, root, write=True)
    path = root / "manifest.json"
    doc = json.loads(path.read_bytes())
    item = doc["fixtures"][0]
    if damage == "source":
        (root / item["path"]).write_bytes(b"wrong")
    elif damage == "reference":
        (root / item["reference"]["path"]).write_text("{}")
    elif damage == "samples":
        item["sample_count"] += 1
        item["labels"][-1]["end_sample"] += 1
        item["anchors"][-1]["end_sample"] += 1
    elif damage == "anchor":
        item["anchors"][0]["pcm_sha256"] = "0" * 64
    elif damage == "duplicate":
        doc["fixtures"].append(deepcopy(item))
    elif damage == "independence":
        doc["fixtures"][1]["source_sha256"] = item["source_sha256"]
    elif damage == "minimum":
        doc["fixtures"] = [item]
    else:
        audio = root / item["path"]
        saved = audio.with_suffix(".saved")
        audio.rename(saved)
        audio.symlink_to(saved)
    path.write_text(canonical_json(doc))
    with pytest.raises(EvaluationError):
        validate_pilot_manifest(root)


def test_p10_preserves_authoritative_five_region_annotation(corpus):
    root, source, fixtures, reference = corpus
    item = fixtures[1]
    item.update(fixture_id="vi-speech-pause-resume-01", sample_count=1125471,
                conditions=["historical-regression"], annotation_version="human-reviewed-1",
                labels=[dict(start_sample=a, end_sample=b, label=label, critical=critical)
                        for a, b, label, critical in [(0, 430400, "speech", False),
                            (430400, 518704, "music", False), (518704, 576497, "silence", False),
                            (576497, 962400, "speech", True), (962400, 1125471, "speech", False)]])
    pcm = b"\x02\x00" * item["sample_count"]
    with wave.open(str(root / item["path"]), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", ""))
        output.writeframes(pcm)
    item["source_sha256"] = hashlib.sha256((root / item["path"]).read_bytes()).hexdigest()
    item["anchors"][-1].update(start_sample=item["sample_count"] - 10, end_sample=item["sample_count"])
    doc = json.loads(source.read_bytes())
    doc["fixtures"][1] = item
    source.write_text(canonical_json(doc))
    (root / "references/vi-example-1.json").unlink()
    reference(1)
    sync_manifest(source, root, write=True)
    fixture = next(f for f in load_pilot_manifest(root).fixtures if f.fixture_id == item["fixture_id"])
    assert len(fixture.labels) == 5
    assert fixture.labels[3].model_dump() == dict(start_sample=576497, end_sample=962400,
                                                label="speech", critical=True, material=False)
    missing = compute_transcription_metrics(fixture, [SampleInterval(0, 430400), SampleInterval(962400, 1125471)])
    assert missing["missed_critical_samples"] == 962400 - 576497
    covered = compute_transcription_metrics(fixture, [SampleInterval(0, fixture.sample_count)])
    assert covered["missed_critical_samples"] == 0
    assert compute_text_metrics("Xin chào", "Nội dung khác")["word_errors"] > 0


def test_p11_reference_correction_resets_approval_and_snapshots(corpus):
    root, source, _, _ = corpus
    sync_manifest(source, root, write=True)
    path = root / "manifest.json"
    doc = json.loads(path.read_bytes())
    doc.update(privacy_approved=True, legal_approved=True, approval_version="owner-reviewed-1")
    path.write_text(canonical_json(doc))
    approved = validate_pilot_manifest(root, require_approval=True)
    sync_manifest(source, root, write=True)
    assert load_pilot_manifest(root).privacy_approved
    ref = root / approved.fixtures[0].reference.path
    ref.write_bytes(ref.read_bytes() + b"\n")
    sync_manifest(source, root, write=True)
    updated = load_pilot_manifest(root)
    assert updated.manifest_sha256 != approved.manifest_sha256
    assert not updated.privacy_approved and not updated.legal_approved
    assert updated.fixtures[0].reference.sha256 != approved.fixtures[0].reference.sha256


def test_p20_sync_rejects_aliases_and_symlink_escapes(corpus):
    root, source, _, _ = corpus
    with pytest.raises(EvaluationError):
        sync_manifest(source, root, output=source, write=True)
    (root / "manifest.json").symlink_to(source)
    with pytest.raises(EvaluationError):
        sync_manifest(source, root, write=True)


def test_sync_cli_and_validate_are_sanitized(corpus, capsys):
    from .asr_pilot_manifest import main

    root, source, _, _ = corpus
    assert main(["sync", "--preprocessing-manifest", str(source), "--transcription-root", str(root), "--write"]) == 0
    assert main(["validate", "--transcription-root", str(root)]) == 0
    output = capsys.readouterr().out
    assert "Xin" not in output and str(root) not in output
    assert '"full_cutover_ready":false' in output
