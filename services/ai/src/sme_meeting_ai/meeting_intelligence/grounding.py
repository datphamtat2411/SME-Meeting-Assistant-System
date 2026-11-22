"""Per-execution validation diagnostics. Never retain provider text or exceptions."""
import json
import re
from dataclasses import dataclass, field
from hashlib import sha256
from uuid import UUID

from .errors import (
    CLAIM_AUDIT_REASONS,
    CLAIM_AUDIT_STAGES,
    MAX_GROUNDING_DIAGNOSTICS,
    MAX_VALIDATION_EVIDENCE_CHARS,
    MAX_VALIDATION_ITEM_INDEX,
    MAX_VALIDATION_REFERENCE_OFFSET,
    MAX_VALIDATION_REFERENCES,
    MAX_VALIDATION_STATEMENT_CHARS,
    VALIDATION_EVIDENCE_ASSESSMENTS,
    VALIDATION_LEAF_REASONS,
    VALIDATION_RULES,
    IntelligenceError,
    ValidationDiagnostic,
    ValidationEvidence,
    ValidationReference,
)

GROUNDING_DIAGNOSTIC_VERSION = "1.0"
DISCARDED = "GROUNDING_CLAIM_DISCARDED"
REPAIRED = "GROUNDING_CLAIM_REPAIRED"
RESULT_WARNING_CODES = (
    "INCOMPLETE_COVERAGE", "UNRESOLVED_EVIDENCE", "SUSPICIOUS_EVIDENCE", "SOURCE_QUALITY_WARNING",
    DISCARDED, REPAIRED,
)
_DISPOSITION_DISCARDED = "DISCARDED"
_DISPOSITION_REPAIRED = "REPAIRED"
_DISPOSITION_ACCEPTED = "ACCEPTED"
_DISPOSITION_REJECTED = "REJECTED"
_DISPOSITIONS = frozenset({
    _DISPOSITION_DISCARDED, _DISPOSITION_REPAIRED,
    _DISPOSITION_ACCEPTED, _DISPOSITION_REJECTED,
})
_DIGEST = re.compile(r"[a-f0-9]{64}")
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)
_MODEL_CATEGORY = re.compile(r"[A-Z_]{1,32}")
_LEGACY_DIAGNOSTIC_KEYS = frozenset({
    "disposition", "reason", "rule", "itemIndex", "evidence",
})
_CLAIM_DIAGNOSTIC_KEYS = frozenset({
    "diagnosticVersion", "stage", "disposition", "reason", "rule", "itemIndex",
    "fingerprint", "warningCodes", "evidence",
})
_EVIDENCE_KEYS = frozenset({
    "sourceSnapshotId", "transcriptId", "contentRevision", "sourceSha256",
    "references", "modelCategory", "statementSha256", "statementCharLength",
    "evidenceSha256", "evidenceCharLength", "affirmativeMarker", "negativeMarker",
    "assessment",
})
_REFERENCE_KEYS = frozenset({"segmentId", "charStart", "charEnd"})
_WARNING_CODES = frozenset(RESULT_WARNING_CODES)


def _bounded_uuid(value: object) -> str:
    if not isinstance(value, str) or _UUID.fullmatch(value) is None:
        raise ValueError
    try:
        if str(UUID(value)) != value:
            raise ValueError
    except (ValueError, AttributeError):
        raise ValueError from None
    return value


def _bounded_digest(value: object) -> str:
    if not isinstance(value, str) or _DIGEST.fullmatch(value) is None:
        raise ValueError
    return value


def _bounded_integer(value: object, maximum: int) -> int:
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError
    return value


def _bounded_evidence(value: object) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != _EVIDENCE_KEYS:
        raise ValueError
    references = value["references"]
    if not isinstance(references, list) or not 1 <= len(references) <= MAX_VALIDATION_REFERENCES:
        raise ValueError
    normalized_references = []
    seen = set()
    for reference in references:
        if not isinstance(reference, dict) or set(reference) != _REFERENCE_KEYS:
            raise ValueError
        normalized = {
            "segmentId": _bounded_uuid(reference["segmentId"]),
            "charStart": _bounded_integer(reference["charStart"], MAX_VALIDATION_REFERENCE_OFFSET),
            "charEnd": _bounded_integer(reference["charEnd"], MAX_VALIDATION_REFERENCE_OFFSET),
        }
        if normalized["charStart"] > normalized["charEnd"]:
            raise ValueError
        identity = tuple(normalized.values())
        if identity in seen:
            raise ValueError
        seen.add(identity)
        normalized_references.append(normalized)
    statement_length = _bounded_integer(
        value["statementCharLength"], MAX_VALIDATION_STATEMENT_CHARS
    )
    evidence_length = _bounded_integer(
        value["evidenceCharLength"], MAX_VALIDATION_EVIDENCE_CHARS
    )
    if not isinstance(value["modelCategory"], str) or _MODEL_CATEGORY.fullmatch(
        value["modelCategory"]
    ) is None:
        raise ValueError
    if not isinstance(value["assessment"], str) or value["assessment"] not in VALIDATION_EVIDENCE_ASSESSMENTS:
        raise ValueError
    if type(value["affirmativeMarker"]) is not bool or type(value["negativeMarker"]) is not bool:
        raise ValueError
    return {
        "sourceSnapshotId": _bounded_uuid(value["sourceSnapshotId"]),
        "transcriptId": _bounded_uuid(value["transcriptId"]),
        "contentRevision": _bounded_integer(value["contentRevision"], 2**63 - 1),
        "sourceSha256": _bounded_digest(value["sourceSha256"]),
        "references": normalized_references,
        "modelCategory": value["modelCategory"],
        "statementSha256": _bounded_digest(value["statementSha256"]),
        "statementCharLength": statement_length,
        "evidenceSha256": _bounded_digest(value["evidenceSha256"]),
        "evidenceCharLength": evidence_length,
        "affirmativeMarker": value["affirmativeMarker"],
        "negativeMarker": value["negativeMarker"],
        "assessment": value["assessment"],
    }


def validate_diagnostic_payloads(value: object) -> tuple[dict, ...]:
    """Validate the wire-safe diagnostic side channel and return normalized data."""
    if not isinstance(value, (list, tuple)) or len(value) > MAX_GROUNDING_DIAGNOSTICS:
        raise ValueError
    normalized = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError
        claim_record = set(item) == _CLAIM_DIAGNOSTIC_KEYS
        if not claim_record and set(item) != _LEGACY_DIAGNOSTIC_KEYS:
            raise ValueError
        disposition = item["disposition"]
        reason = item["reason"]
        rule = item["rule"]
        index = item["itemIndex"]
        if claim_record:
            if (item["diagnosticVersion"] != GROUNDING_DIAGNOSTIC_VERSION
                    or item["stage"] not in CLAIM_AUDIT_STAGES
                    or disposition not in {_DISPOSITION_ACCEPTED, _DISPOSITION_REJECTED}
                    or reason not in CLAIM_AUDIT_REASONS
                    or not isinstance(item["fingerprint"], str)
                    or _DIGEST.fullmatch(item["fingerprint"]) is None):
                raise ValueError
            warning_codes = item["warningCodes"]
            if (not isinstance(warning_codes, list)
                    or len(warning_codes) > len(_WARNING_CODES)
                    or len(set(warning_codes)) != len(warning_codes)
                    or any(code not in _WARNING_CODES for code in warning_codes)):
                raise ValueError
        elif disposition not in {_DISPOSITION_DISCARDED, _DISPOSITION_REPAIRED} \
                or reason not in VALIDATION_LEAF_REASONS:
            raise ValueError
        if rule is not None and rule not in VALIDATION_RULES:
            raise ValueError
        if index is not None:
            index = _bounded_integer(index, MAX_VALIDATION_ITEM_INDEX)
        item_payload = {
            "disposition": disposition,
            "reason": reason,
            "rule": rule,
            "itemIndex": index,
            "evidence": _bounded_evidence(item["evidence"]),
        }
        if claim_record:
            item_payload = {
                "diagnosticVersion": item["diagnosticVersion"],
                "stage": item["stage"],
                **item_payload,
                "fingerprint": item["fingerprint"],
                "warningCodes": list(item["warningCodes"]),
            }
        normalized.append(item_payload)
    return tuple(normalized)


def diagnostic_counts(value: object) -> dict:
    """Return reconciled disposition counts for a validated diagnostic list."""
    payloads = validate_diagnostic_payloads(value)
    counts = {
        "accepted": sum(item["disposition"] == _DISPOSITION_ACCEPTED for item in payloads),
        "rejected": sum(item["disposition"] == _DISPOSITION_REJECTED for item in payloads),
        "discarded": sum(item["disposition"] == _DISPOSITION_DISCARDED for item in payloads),
        "repaired": sum(item["disposition"] == _DISPOSITION_REPAIRED for item in payloads),
    }
    counts["total"] = sum(counts.values())
    return counts


def validate_diagnostic_counts(value: object, diagnostics: object) -> dict:
    if not isinstance(value, dict) or set(value) != {
        "version", "accepted", "rejected", "discarded", "repaired", "total",
    }:
        raise ValueError
    if value["version"] != GROUNDING_DIAGNOSTIC_VERSION:
        raise ValueError
    for key in ("accepted", "rejected", "discarded", "repaired", "total"):
        if type(value[key]) is not int or not 0 <= value[key] <= MAX_GROUNDING_DIAGNOSTICS:
            raise ValueError
    expected = diagnostic_counts(diagnostics)
    if any(value[key] != expected[key] for key in expected):
        raise ValueError
    return {
        "version": value["version"],
        **{key: value[key] for key in ("accepted", "rejected", "discarded", "repaired", "total")},
    }


def _claim_digest(value: object) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def _claim_reason(error: IntelligenceError) -> str:
    if error.category == "INVALID_REFERENCE":
        return "INVALID_REFERENCE"
    if error.rule in {"REFERENCE_SEGMENT_NOT_FOUND", "REFERENCE_RANGE", "REFERENCE_NOT_ALLOWED",
                      "REFERENCE_SHAPE", "REFERENCE_DUPLICATE", "REFERENCE_OUTSIDE_WINDOW"}:
        return "MISSING_REFERENCE" if error.rule == "REFERENCE_SEGMENT_NOT_FOUND" else "INVALID_REFERENCE"
    if error.rule in {"AGREEMENT_CONTRADICTED", "CLAIM_CONFLICT_UNRESOLVED"}:
        return "CONTRADICTED"
    if error.rule in {"CLAIM_UNCERTAINTY", "CLAIM_QUALIFICATION_GROUNDING"}:
        return "UNCERTAIN"
    return "UNSUPPORTED"


def _reference_values(references) -> tuple[ValidationReference, ...]:
    values = []
    for reference in references or ():
        if isinstance(reference, ValidationReference):
            values.append(reference)
        elif isinstance(reference, dict):
            values.append(ValidationReference(
                reference["segmentId"] if "segmentId" in reference else reference["segment_id"],
                reference["charStart"] if "charStart" in reference else reference["char_start"],
                reference["charEnd"] if "charEnd" in reference else reference["char_end"],
            ))
        elif all(hasattr(reference, name) for name in ("segment_id", "char_start", "char_end")):
            values.append(ValidationReference(
                reference.segment_id, reference.char_start, reference.char_end,
            ))
        else:
            values.append(ValidationReference(reference[0], reference[1], reference[2]))
    return tuple(values)


def _claim_payload(
    *,
    stage: str,
    disposition: str,
    reason: str,
    rule: str | None,
    item_index: int | None,
    source,
    references=(),
    statement: str = "",
    model_category: str = "CLAIM",
    assessment: str = "SUPPORTED",
    affirmative_marker: bool = False,
    negative_marker: bool = False,
    warning_codes=(),
) -> dict:
    if stage not in CLAIM_AUDIT_STAGES or disposition not in {
        _DISPOSITION_ACCEPTED, _DISPOSITION_REJECTED,
    } or reason not in CLAIM_AUDIT_REASONS:
        raise ValueError
    normalized_references = _reference_values(references)
    evidence = None
    if source is not None and normalized_references:
        try:
            evidence_text = " ".join(
                source.resolve(reference.segment_id, reference.char_start, reference.char_end).text
                for reference in normalized_references
            )
            evidence = GroundingChanges._evidence_for(
                source, normalized_references, statement, model_category,
                assessment, affirmative_marker, negative_marker, evidence_text,
            )
        except (ValueError, TypeError, KeyError, AttributeError, IntelligenceError):
            evidence = None
    source_identity = getattr(source, "identity", None)
    fingerprint = _claim_digest({
        "version": GROUNDING_DIAGNOSTIC_VERSION,
        "stage": stage,
        "source": {
            "snapshotId": getattr(source_identity, "snapshot_id", None),
            "transcriptId": getattr(source_identity, "transcript_id", None),
            "contentRevision": getattr(source_identity, "content_revision", None),
            "sha256": getattr(source_identity, "sha256", None),
        },
        "modelCategory": model_category,
        "statementSha256": sha256(statement.encode("utf-8")).hexdigest(),
        "references": [
            {"segmentId": reference.segment_id, "charStart": reference.char_start,
             "charEnd": reference.char_end}
            for reference in normalized_references
        ],
    })
    normalized_warnings = []
    for code in warning_codes:
        if code in _WARNING_CODES and code not in normalized_warnings:
            normalized_warnings.append(code)
    return {
        "diagnosticVersion": GROUNDING_DIAGNOSTIC_VERSION,
        "stage": stage,
        "disposition": disposition,
        "reason": reason,
        "rule": rule if rule in VALIDATION_RULES else None,
        "itemIndex": item_index if type(item_index) is int else None,
        "fingerprint": fingerprint,
        "warningCodes": normalized_warnings,
        "evidence": evidence,
    }


@dataclass
class GroundingChanges:
    stage: str | None = None
    source: object | None = field(default=None, repr=False)
    first: ValidationDiagnostic | None = None
    discarded: bool = False
    repaired: bool = False
    _diagnostics: list[tuple[str, ValidationDiagnostic]] | None = field(
        default=None, init=False, repr=False
    )
    _claims: list[dict] | None = field(default=None, init=False, repr=False)

    @property
    def diagnostics(self) -> tuple[tuple[str, ValidationDiagnostic], ...]:
        return tuple(self._diagnostics or ())

    def _record(self, disposition: str, error: IntelligenceError) -> ValidationDiagnostic:
        diagnostic = error.diagnostic
        if diagnostic is None or diagnostic.rule == "SOURCE_IDENTITY":
            raise error
        if self._diagnostics is None:
            self._diagnostics = []
        if len(self._diagnostics) < MAX_GROUNDING_DIAGNOSTICS:
            self._diagnostics.append((disposition, diagnostic))
        return diagnostic

    def _record_claim(
        self,
        disposition: str,
        reason: str,
        *,
        rule: str | None = None,
        item_index: int | None = None,
        references=(),
        statement: str = "",
        model_category: str = "CLAIM",
        assessment: str = "SUPPORTED",
        affirmative_marker: bool = False,
        negative_marker: bool = False,
    ) -> None:
        if self.stage not in CLAIM_AUDIT_STAGES or self.source is None:
            return
        payload = _claim_payload(
            stage=self.stage, disposition=disposition, reason=reason, rule=rule,
            item_index=item_index, source=self.source, references=references,
            statement=statement, model_category=model_category, assessment=assessment,
            affirmative_marker=affirmative_marker, negative_marker=negative_marker,
            warning_codes=(),
        )
        if self._claims is None:
            self._claims = []
        if any(item["fingerprint"] == payload["fingerprint"] for item in self._claims):
            return
        if len(self._claims) < MAX_GROUNDING_DIAGNOSTICS:
            self._claims.append(payload)

    def accept_claim(
        self,
        *,
        statement: str,
        references=(),
        model_category: str = "CLAIM",
        item_index: int | None = None,
        rule: str | None = None,
        assessment: str = "SUPPORTED",
        affirmative_marker: bool = False,
        negative_marker: bool = False,
    ) -> None:
        self._record_claim(
            _DISPOSITION_ACCEPTED, "SUPPORTED", rule=rule, item_index=item_index,
            references=references, statement=statement, model_category=model_category,
            assessment=assessment, affirmative_marker=affirmative_marker,
            negative_marker=negative_marker,
        )

    def discard(self, error: IntelligenceError) -> None:
        diagnostic = self._record(_DISPOSITION_DISCARDED, error)
        self.first = self.first or diagnostic
        self.discarded = True
        self._record_claim(
            _DISPOSITION_REJECTED, _claim_reason(error), rule=diagnostic.rule,
            item_index=diagnostic.item_index,
            references=diagnostic.evidence.references if diagnostic.evidence else (),
            statement="",
            model_category=(
                diagnostic.evidence.model_category if diagnostic.evidence else "CLAIM"
            ),
            assessment=(
                diagnostic.evidence.assessment if diagnostic.evidence else "UNSUPPORTED_MODEL_CLASSIFICATION"
            ),
            affirmative_marker=(
                diagnostic.evidence.affirmative_marker if diagnostic.evidence else False
            ),
            negative_marker=(
                diagnostic.evidence.negative_marker if diagnostic.evidence else False
            ),
        )

    def repair(self, error: IntelligenceError) -> None:
        diagnostic = self._record(_DISPOSITION_REPAIRED, error)
        self.repaired = True
        self._record_claim(
            _DISPOSITION_ACCEPTED, "SUPPORTED", rule=diagnostic.rule,
            item_index=diagnostic.item_index,
            references=diagnostic.evidence.references if diagnostic.evidence else (),
            model_category=(
                diagnostic.evidence.model_category if diagnostic.evidence else "CLAIM"
            ),
            assessment=(
                diagnostic.evidence.assessment if diagnostic.evidence else "SUPPORTED"
            ),
            affirmative_marker=(
                diagnostic.evidence.affirmative_marker if diagnostic.evidence else False
            ),
            negative_marker=(
                diagnostic.evidence.negative_marker if diagnostic.evidence else False
            ),
        )

    @staticmethod
    def _evidence(value: ValidationEvidence | None) -> dict | None:
        if value is None:
            return None
        return {
            "sourceSnapshotId": value.source_snapshot_id,
            "transcriptId": value.transcript_id,
            "contentRevision": value.content_revision,
            "sourceSha256": value.source_sha256,
            "references": [
                {
                    "segmentId": reference.segment_id,
                    "charStart": reference.char_start,
                    "charEnd": reference.char_end,
                }
                for reference in value.references
            ],
            "modelCategory": value.model_category,
            "statementSha256": value.statement_sha256,
            "statementCharLength": value.statement_char_length,
            "evidenceSha256": value.evidence_sha256,
            "evidenceCharLength": value.evidence_char_length,
            "affirmativeMarker": value.affirmative_marker,
            "negativeMarker": value.negative_marker,
            "assessment": value.assessment,
        }

    def diagnostic_payloads(self, warning_codes=()) -> tuple[dict, ...]:
        payloads = tuple({
            "disposition": disposition,
            "reason": diagnostic.reason,
            "rule": diagnostic.rule,
            "itemIndex": diagnostic.item_index,
            "evidence": self._evidence(diagnostic.evidence),
        } for disposition, diagnostic in self.diagnostics)
        claims = []
        for payload in sorted(
            tuple(self._claims or ()), key=lambda item: item["fingerprint"],
        ):
            claim = dict(payload)
            linked_warning_codes = set(claim["warningCodes"])
            linked_warning_codes.update(
                code for code in warning_codes if code in RESULT_WARNING_CODES
            )
            if claim["disposition"] == _DISPOSITION_REJECTED and self.discarded:
                linked_warning_codes.add(DISCARDED)
            if claim["disposition"] == _DISPOSITION_ACCEPTED and self.repaired:
                linked_warning_codes.add(REPAIRED)
            claim["warningCodes"] = [
                code for code in RESULT_WARNING_CODES if code in linked_warning_codes
            ]
            claims.append(claim)
        return validate_diagnostic_payloads((*payloads, *claims))

    def diagnostic_counts(self) -> dict:
        return diagnostic_counts(self.diagnostic_payloads())

    @staticmethod
    def _evidence_for(
        source,
        references: tuple[ValidationReference, ...],
        statement: str,
        model_category: str,
        assessment: str,
        affirmative_marker: bool,
        negative_marker: bool,
        evidence_text: str,
    ) -> dict:
        identity = source.identity
        return {
            "sourceSnapshotId": identity.snapshot_id,
            "transcriptId": identity.transcript_id,
            "contentRevision": identity.content_revision,
            "sourceSha256": identity.sha256,
            "references": [
                {
                    "segmentId": reference.segment_id,
                    "charStart": reference.char_start,
                    "charEnd": reference.char_end,
                }
                for reference in references
            ],
            "modelCategory": model_category,
            "statementSha256": sha256(statement.encode("utf-8")).hexdigest(),
            "statementCharLength": len(statement),
            "evidenceSha256": sha256(evidence_text.encode("utf-8")).hexdigest(),
            "evidenceCharLength": len(evidence_text),
            "affirmativeMarker": affirmative_marker,
            "negativeMarker": negative_marker,
            "assessment": assessment,
        }

    def require_usable(self, records) -> None:
        if not records and self.first is not None:
            d = self.first
            raise IntelligenceError(d.reason, rule=d.rule, item_index=d.item_index, evidence=d.evidence)

    def flags(self, quality_flags=()):
        return (*quality_flags, *((DISCARDED,) if self.discarded else ()), *((REPAIRED,) if self.repaired else ()))
