import copy
import hashlib
import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import pytest

from sme_meeting_ai.diarization.contract import (
    MAX_RESULT_BYTES,
    ContractValidationError,
    DiarizationResultEnvelope,
    ValidationContext,
    serialize_result,
    validate_result,
)
from sme_meeting_ai.diarization.models import SpeakerAssignment, SpeakerTurn
from sme_meeting_ai.diarization.service import DiarizationResponse

FIXTURES = json.loads((Path(__file__).resolve().parents[4] / "contracts"
                       / "DIARIZATION_RESULT_V1.fixtures.json").read_text())


def change(root, pointer, value=None, *, remove=False):
    parts = pointer.lstrip("/").split("/")
    for part in parts[:-1]:
        root = root[int(part)] if isinstance(root, list) else root[part]
    key = int(parts[-1]) if isinstance(root, list) else parts[-1]
    if remove:
        del root[key]
    else:
        root[key] = value


def context(value):
    return ValidationContext(
        processing_job_id=UUID(value["processingJobId"]),
        source_media_id=UUID(value["sourceMediaId"]), source_revision=value["sourceRevision"],
        transcript_id=UUID(value["transcriptId"]), transcript_revision=value["transcriptRevision"],
        producer_stage_run_id=UUID(value["producerStageRunId"]),
        trusted_duration_ms=value["trustedDurationMs"],
        expected_segment_ordinals=tuple(value["expectedSegmentOrdinals"]),
    )


def expand(case):
    payload, snapshot = copy.deepcopy(FIXTURES["base"]), copy.deepcopy(FIXTURES["context"])
    for pointer, value in case.get("set", {}).items():
        change(payload, pointer, value)
    for pointer, value in case.get("contextSet", {}).items():
        change(snapshot, pointer, value)
    if "remove" in case:
        change(payload, case["remove"], remove=True)
    if "modelLength" in case:
        payload["modelId"] = "m" * case["modelLength"]
    if "integerDigits" in case:
        if case["integerDigits"] <= 4300:
            payload["transcriptRevision"] = snapshot["transcriptRevision"] = 10 ** (case["integerDigits"] - 1)
    if "speakerCount" in case:
        payload["speakerLabels"] = [f"SPEAKER_{i:02d}" for i in range(1, case["speakerCount"] + 1)]
        payload["turns"] = [dict(startMs=i, endMs=i + 1, speakerLabel=label)
                            for i, label in enumerate(payload["speakerLabels"])]
    if "turnCount" in case:
        payload["turns"] = [payload["turns"][0]] * case["turnCount"]
    if "assignmentCount" in case:
        snapshot["expectedSegmentOrdinals"] = list(range(case["assignmentCount"]))
        payload["assignments"] = [dict(ordinal=i, speakerLabel=None)
                                  for i in snapshot["expectedSegmentOrdinals"]]
        payload["diagnostics"]["unknownAssignmentCount"] = case["assignmentCount"]
    # Construct the oversized token without asking the fixture serializer to accept it.
    if case.get("integerDigits", 0) > 4300:
        payload["transcriptRevision"] = 7
    raw = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    if case.get("integerDigits", 0) > 4300:
        raw = raw.replace('"transcriptRevision":7', '"transcriptRevision":' + "1" + "0" * (case["integerDigits"] - 1))
    if "rawReplace" in case:
        raw = raw.replace(*case["rawReplace"])
    raw = case.get("raw", raw)
    data = bytes.fromhex(case["rawHex"]) if "rawHex" in case else raw.encode("utf-8")
    if "paddedBytes" in case:
        data += b" " * (case["paddedBytes"] - len(data))
    return data, snapshot, case.get("expectedDigest", hashlib.sha256(data).hexdigest())


@pytest.mark.parametrize("case", FIXTURES["valid"], ids=lambda c: c["name"])
def test_shared_positive_fixtures_and_deterministic_serialization(case):
    data, snapshot, digest = expand(case)
    trusted = context(snapshot)
    result = validate_result(data, trusted, digest)
    artifact = serialize_result(result, trusted)
    if case.get("canonicalBytes"):
        assert artifact.data == data  # The same literal artifact bytes are independently accepted by Java.
    assert artifact == serialize_result(result, trusted)
    assert artifact.sha256 == hashlib.sha256(artifact.data).hexdigest()
    assert validate_result(artifact.data, trusted, artifact.sha256) == result
    original = json.loads(data)
    assert json.loads(artifact.data) == original
    assert [a.ordinal for a in result.assignments] == snapshot["expectedSegmentOrdinals"]
    assert result.diagnostics.unknown_assignment_count == sum(a.speaker_label is None for a in result.assignments)


@pytest.mark.parametrize("case", FIXTURES["invalid"], ids=lambda c: c["name"])
def test_shared_negative_fixtures(case):
    data, snapshot, digest = expand(case)
    # Oversized assignment snapshots cannot be trusted contexts either.
    with pytest.raises(ContractValidationError, match="Diarization result contract validation failed"):
        validate_result(data, context(snapshot), digest)


def test_completed_service_adapter_preserves_evidence_and_provenance():
    trusted = context(FIXTURES["context"])
    turns = (SpeakerTurn(0, 1000, "SPEAKER_01"), SpeakerTurn(0, 1000, "SPEAKER_02"))
    assignments = (SpeakerAssignment(9, None), SpeakerAssignment(2, "SPEAKER_02"), SpeakerAssignment(42, None))
    response = DiarizationResponse("completed", FIXTURES["base"]["modelId"],
                                   ("SPEAKER_01", "SPEAKER_02"), turns, assignments)
    result = DiarizationResultEnvelope.from_response(response, trusted)
    assert result.turns is turns and result.assignments is assignments
    assert result.model_id == response.model_id
    assert result.diagnostics.unknown_assignment_count == 2
    assert validate_result(serialize_result(result, trusted).data, trusted,
                           serialize_result(result, trusted).sha256) == result


@pytest.mark.parametrize("response", [DiarizationResponse("failed", error_category="timeout"),
                                      DiarizationResponse("skipped"),
                                      DiarizationResponse("completed", "model", error_category="provider")])
def test_non_successful_service_outcomes_cannot_become_artifacts(response):
    with pytest.raises(ContractValidationError):
        DiarizationResultEnvelope.from_response(response, context(FIXTURES["context"]))


@pytest.mark.parametrize("field,value", [
    ("transcript_revision", True), ("transcript_revision", 7.0),
    ("speaker_labels", ["SPEAKER_01"]), ("turns", (object(),)),
    ("assignments", (SpeakerAssignment(True, "SPEAKER_01"),)),
    ("model_id", object()), ("status", "FAILED"),
])
def test_typed_construction_rejects_coercions_and_unsupported_values(field, value):
    data, snapshot, digest = expand({})
    result = validate_result(data, context(snapshot), digest)
    with pytest.raises(ContractValidationError):
        serialize_result(replace(result, **{field: value}), context(snapshot))


@pytest.mark.parametrize("field,value", [
    ("processing_job_id", "11111111-1111-4111-8111-111111111111"),
    ("source_revision", "bad"), ("transcript_revision", True),
    ("trusted_duration_ms", -1), ("trusted_duration_ms", False),
    ("expected_segment_ordinals", (9, 9)), ("expected_segment_ordinals", (True,)),
])
def test_invalid_trusted_contexts_are_rejected(field, value):
    with pytest.raises(ContractValidationError):
        replace(context(FIXTURES["context"]), **{field: value})


def test_digest_covers_exact_bytes_and_byte_bound_precedes_parsing(monkeypatch):
    data, snapshot, digest = expand({})
    with pytest.raises(ContractValidationError):
        validate_result(data + b"\n", context(snapshot), digest)
    monkeypatch.setattr("sme_meeting_ai.diarization.contract.json.loads",
                        lambda *a, **kw: pytest.fail("oversized bytes reached JSON parsing"))
    with pytest.raises(ContractValidationError):
        validate_result(b" " * (MAX_RESULT_BYTES + 1), context(snapshot), digest)


def test_serialization_rejects_oversized_output_without_truncating_evidence():
    data, snapshot, digest = expand({})
    result = validate_result(data, context(snapshot), digest)
    trusted = replace(context(snapshot), trusted_duration_ms=10 ** 200)
    turns = (SpeakerTurn(0, trusted.trusted_duration_ms, "SPEAKER_01"),) * 100_000
    result = replace(result, turns=turns)
    with pytest.raises(ContractValidationError):
        serialize_result(result, trusted)
    assert result.turns is turns and len(result.turns) == 100_000
