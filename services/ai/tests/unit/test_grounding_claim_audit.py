import hashlib

import pytest

from sme_meeting_ai.meeting_intelligence.errors import (
    CLAIM_AUDIT_REASONS,
    CLAIM_AUDIT_STAGES,
    IntelligenceError,
    ValidationReference,
)
from sme_meeting_ai.meeting_intelligence.grounding import (
    GroundingChanges,
    diagnostic_counts,
    validate_diagnostic_payloads,
)


_SNAPSHOT = "11111111-1111-4111-8111-111111111111"
_TRANSCRIPT = "22222222-2222-4222-8222-222222222222"
_SEGMENT = "33333333-3333-4333-8333-333333333333"
_SOURCE_SHA = "a" * 64


def _claim(stage, reason, disposition):
    return {
        "diagnosticVersion": "1.0",
        "stage": stage,
        "disposition": disposition,
        "reason": reason,
        "rule": None,
        "itemIndex": 0,
        "fingerprint": hashlib.sha256(
            f"{stage}:{disposition}:{reason}".encode()
        ).hexdigest(),
        "warningCodes": [],
        "evidence": None,
    }


@pytest.mark.parametrize("stage", sorted(CLAIM_AUDIT_STAGES))
@pytest.mark.parametrize("reason", sorted(CLAIM_AUDIT_REASONS))
def test_claim_audit_reason_matrix_is_bounded_and_stage_bound(stage, reason):
    disposition = "ACCEPTED" if reason == "SUPPORTED" else "REJECTED"
    payload = validate_diagnostic_payloads([_claim(stage, reason, disposition)])

    assert payload[0]["diagnosticVersion"] == "1.0"
    assert payload[0]["stage"] == stage
    assert payload[0]["disposition"] == disposition
    assert payload[0]["reason"] == reason
    assert diagnostic_counts(payload) == {
        "accepted": disposition == "ACCEPTED",
        "rejected": disposition == "REJECTED",
        "discarded": 0,
        "repaired": 0,
        "total": 1,
    }


@pytest.mark.parametrize(
    ("rule", "expected_reason"),
    [
        ("TEXT_POLICY", "UNSUPPORTED"),
        ("REFERENCE_RANGE", "INVALID_REFERENCE"),
        ("REFERENCE_SEGMENT_NOT_FOUND", "MISSING_REFERENCE"),
        ("AGREEMENT_CONTRADICTED", "CONTRADICTED"),
        ("CLAIM_UNCERTAINTY", "UNCERTAIN"),
        ("CLAIM_QUALIFICATION_GROUNDING", "UNCERTAIN"),
    ],
)
def test_grounding_changes_maps_rejected_claims_without_retaining_text(rule, expected_reason):
    source = type(
        "Source",
        (),
        {
            "identity": type(
                "Identity",
                (),
                {
                    "snapshot_id": _SNAPSHOT,
                    "transcript_id": _TRANSCRIPT,
                    "content_revision": 3,
                    "sha256": _SOURCE_SHA,
                },
            )(),
            "resolve": lambda self, *_args: type("Unit", (), {"text": "evidence"})(),
        },
    )()
    changes = GroundingChanges(
        stage="GENERATING_SUMMARY",
        source=source,
    )
    changes.discard(IntelligenceError("GROUNDING_FAILURE", rule=rule, item_index=0))

    claim = next(
        item for item in changes.diagnostic_payloads()
        if item["disposition"] == "REJECTED"
    )
    assert claim["reason"] == expected_reason
    assert claim["stage"] == "GENERATING_SUMMARY"
    assert "evidence" not in claim or "text" not in repr(claim["evidence"])


def test_grounding_changes_emits_source_bound_positive_claim_for_each_stage():
    reference = ValidationReference(_SEGMENT, 0, 8)
    source = type(
        "Source",
        (),
        {
            "identity": type(
                "Identity",
                (),
                {
                    "snapshot_id": _SNAPSHOT,
                    "transcript_id": _TRANSCRIPT,
                    "content_revision": 3,
                    "sha256": _SOURCE_SHA,
                },
            )(),
            "resolve": lambda self, *_args: type("Unit", (), {"text": "evidence"})(),
        },
    )()

    for stage in sorted(CLAIM_AUDIT_STAGES):
        changes = GroundingChanges(stage=stage, source=source)
        changes.accept_claim(
            statement="evidence",
            references=(reference,),
            model_category="CLAIM",
        )
        claim = changes.diagnostic_payloads()[0]
        assert claim["disposition"] == "ACCEPTED"
        assert claim["reason"] == "SUPPORTED"
        assert claim["stage"] == stage
        assert claim["evidence"]["sourceSnapshotId"] == _SNAPSHOT
        assert claim["evidence"]["transcriptId"] == _TRANSCRIPT
        assert claim["evidence"]["references"] == [{
            "segmentId": _SEGMENT,
            "charStart": 0,
            "charEnd": 8,
        }]
