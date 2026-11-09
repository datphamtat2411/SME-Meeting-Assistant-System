"""AIMI-T07 contracts, deterministic scoring, gates, and safe reports.

This module is intentionally test-local, like the existing evaluation
foundation.  It accepts Core TranscriptViews snapshots, but never changes the
production Meeting Intelligence processors or canonical contracts.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from threading import Event
from types import SimpleNamespace
from typing import Annotated, Iterable, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.meeting_intelligence.action_item_contract import (
    prepare_action_item_request,
)
from sme_meeting_ai.meeting_intelligence.context import ContextLimits
from sme_meeting_ai.meeting_intelligence.evidence import (
    EvidenceSource,
    normalize_evidence,
)
from sme_meeting_ai.meeting_intelligence.processor import StageContext
from sme_meeting_ai.meeting_intelligence.result import serialize_result
from sme_meeting_ai.meeting_intelligence.source import verify_snapshot

from .support import EvaluationError, _unique_keys, canonical_json, digest_json, require

EVALUATION_VERSION = "meeting-intelligence-1"
SCORING_POLICY_VERSION = "meeting-intelligence-scoring-1"
REPORT_SCHEMA_VERSION = 1
REPORT_STATUSES = ("PASS", "FAIL", "UNESTABLISHED", "UNAVAILABLE")
FEATURES = ("summary", "decision", "action")
DECISION_STATUSES = ("PROPOSED", "DISCUSSION", "ACCEPTED", "REJECTED", "REVISED",
                     "CONDITIONAL", "UNRESOLVED", "HISTORICAL", "ACTION_ITEM")
ACTION_STATES = ("SUGGESTED", "ACTIVE", "ASSIGNED", "COMMITTED", "REVISED", "CANCELLED",
                 "UNRESOLVED", "CONDITIONAL", "HISTORICAL")
DATASET_CATEGORIES = (
    "short-routine", "long-multi-topic", "vietnamese-english-technical", "multiple-speakers",
    "anonymous-speakers", "explicit-decision", "proposal-no-agreement", "rejected-proposal",
    "revised-decision", "explicit-assignment", "self-commitment", "cancelled-task",
    "reassigned-task", "missing-assignee", "relative-deadline", "contradiction",
    "historical-reference", "empty-extraction", "incomplete-coverage", "unresolved-speech",
    "cross-window-correction", "prompt-injection",
)
_WARNING_CODES = {"INCOMPLETE_COVERAGE", "UNRESOLVED_EVIDENCE", "SUSPICIOUS_EVIDENCE", "SOURCE_QUALITY_WARNING"}
_IDENTIFIER = r"^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,159}$"
_VERSION = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$"
_UUID = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
_DIGEST = r"^[a-f0-9]{64}$"
Identifier = Annotated[str, Field(min_length=1, max_length=160, pattern=_IDENTIFIER)]
Version = Annotated[str, Field(min_length=1, max_length=80, pattern=_VERSION)]
UuidText = Annotated[str, Field(pattern=_UUID)]
Digest = Annotated[str, Field(pattern=_DIGEST)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)


def _path(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("relative path required")
    parsed = PurePosixPath(value)
    if (not value or parsed.is_absolute() or ".." in parsed.parts or str(parsed) != value
            or "\\" in value or ":" in value or "\0" in value):
        raise ValueError("relative path required")
    return value


def _normal(text: str) -> str:
    text = unicodedata.normalize("NFC", text).casefold()
    return " ".join(text.split())


def _contains(text: str, phrase: str) -> bool:
    phrase = _normal(phrase)
    return bool(phrase) and phrase in _normal(text)


def _phrases(value: Iterable[str]) -> tuple[str, ...]:
    return tuple(item for item in value if isinstance(item, str) and item.strip())


class EvidenceReference(Contract):
    segment_id: UuidText
    char_start: int = Field(ge=0, le=8_388_608)
    char_end: int = Field(gt=0, le=8_388_608)

    @model_validator(mode="after")
    def ordered(self):
        if self.char_start >= self.char_end:
            raise ValueError("evidence range must be non-empty")
        return self


class SourceDescriptor(Contract):
    schema_version: Literal[1]
    path: str
    sha256: Digest
    snapshot_id: UuidText
    transcript_id: UuidText
    meeting_id: UuidText
    source_media_id: UuidText
    content_revision: int = Field(ge=0)
    language: Literal["vi"]
    size_bytes: int = Field(gt=0, le=8 * 1024 * 1024)

    _relative_path = field_validator("path")(_path)


class ReferenceDescriptor(Contract):
    schema_version: Literal[1]
    path: str
    sha256: Digest
    reference_version: Version
    annotation_version: Version
    origin: Literal["synthetic-independent", "human-double-review", "human-adjudicated", "external-approved"]

    _relative_path = field_validator("path")(_path)


class CaseDescriptor(Contract):
    fixture_id: Identifier
    dataset_version: Version
    source: SourceDescriptor
    reference: ReferenceDescriptor
    annotation_version: Version
    categories: list[str] = Field(min_length=1)
    features: list[Literal["summary", "decision", "action"]] = Field(min_length=1)
    eligibility: Literal["DETERMINISTIC_REGRESSION", "MODEL_EVALUATION", "EXCLUDED"]

    @model_validator(mode="after")
    def identities_and_categories(self):
        if self.annotation_version != self.reference.annotation_version:
            raise ValueError("annotation version mismatch")
        if len(set(self.categories)) != len(self.categories) or any(
            category not in DATASET_CATEGORIES for category in self.categories
        ):
            raise ValueError("unknown or duplicate dataset category")
        if len(set(self.features)) != len(self.features):
            raise ValueError("duplicate feature")
        return self


class Manifest(Contract):
    schema_version: Literal[1]
    evaluation_version: Literal["meeting-intelligence-1"]
    dataset_id: Identifier
    dataset_version: Version
    language: Literal["vi"]
    dataset_kind: Literal["synthetic-non-sensitive", "approved-private"]
    privacy_approved: bool
    legal_approved: bool
    approval_version: Version
    annotation_guideline_version: Version
    scoring_policy_version: Version
    required_categories: list[str] = Field(default_factory=list)
    cases: list[CaseDescriptor] = Field(min_length=1)
    manifest_sha256: Digest = "0" * 64

    @model_validator(mode="after")
    def complete(self):
        ids = [case.fixture_id for case in self.cases]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate fixture ID")
        if any(case.dataset_version != self.dataset_version for case in self.cases):
            raise ValueError("conflicting source revisions")
        source_versions = {}
        for case in self.cases:
            identity = (case.source.snapshot_id, case.source.transcript_id)
            previous = source_versions.setdefault(identity, case.source)
            if (previous.content_revision != case.source.content_revision
                    or previous.sha256 != case.source.sha256):
                raise ValueError("conflicting source revisions")
        if any(category not in DATASET_CATEGORIES for category in self.required_categories):
            raise ValueError("unknown required category")
        available = {category for case in self.cases for category in case.categories}
        if not set(self.required_categories) <= available:
            raise ValueError("missing required categories")
        if self.dataset_kind == "synthetic-non-sensitive" and not (self.privacy_approved and self.legal_approved):
            raise ValueError("synthetic dataset approval required")
        return self


class AnnotationProvenance(Contract):
    origin: Literal["synthetic-independent", "human-double-review", "human-adjudicated", "external-approved"]
    review_status: Literal["NOT_REVIEWED", "INDEPENDENTLY_REVIEWED", "ADJUDICATED"]
    reviewers: list[Identifier] = Field(default_factory=list)
    disagreement_count: int = Field(ge=0)
    adjudication_id: Version | None = None

    @model_validator(mode="after")
    def review_requirements(self):
        if self.origin == "synthetic-independent" and self.review_status != "NOT_REVIEWED":
            raise ValueError("synthetic labels cannot claim human review")
        if self.review_status == "INDEPENDENTLY_REVIEWED" and len(self.reviewers) < 2:
            raise ValueError("double review requires two reviewers")
        if self.review_status == "ADJUDICATED" and (len(self.reviewers) < 2 or not self.adjudication_id):
            raise ValueError("adjudication provenance required")
        if self.disagreement_count and self.review_status == "NOT_REVIEWED":
            raise ValueError("unreviewed disagreement must be represented by review records")
        return self


class SummaryFact(Contract):
    fact_id: Identifier
    match_key: Identifier
    statement: str = Field(min_length=1, max_length=2000)
    match_phrases: list[str] = Field(min_length=1, max_length=16)
    importance: Literal["critical", "material", "context"]
    region: Literal["early", "middle", "late"]
    evidence: list[EvidenceReference] = Field(min_length=1, max_length=16)
    required_qualifications: list[str] = Field(default_factory=list, max_length=8)
    required_uncertainty_terms: list[str] = Field(default_factory=list, max_length=8)
    contradiction_group: Identifier | None = None


class ContradictionReference(Contract):
    contradiction_id: Identifier
    match_phrases: list[str] = Field(min_length=1, max_length=8)
    required_phrases: list[str] = Field(min_length=1, max_length=8)
    forbidden_phrases: list[str] = Field(default_factory=list, max_length=8)
    severity: Literal["material", "critical"]
    evidence: list[EvidenceReference] = Field(min_length=1, max_length=16)


class DecisionReference(Contract):
    decision_id: Identifier
    match_key: Identifier
    scope: str = Field(min_length=1, max_length=500)
    scope_phrases: list[str] = Field(min_length=1, max_length=8)
    outcome: str = Field(min_length=1, max_length=2000)
    outcome_phrases: list[str] = Field(min_length=1, max_length=8)
    status: Literal["PROPOSED", "DISCUSSION", "ACCEPTED", "REJECTED", "REVISED", "CONDITIONAL",
                    "UNRESOLVED", "HISTORICAL", "ACTION_ITEM"]
    valid: bool
    uncertainty: Literal["NONE", "LOW", "MATERIAL"]
    evidence: list[EvidenceReference] = Field(min_length=1, max_length=16)
    negative_category: Literal["proposal", "rejected-proposal", "historical", "unresolved", "action-only"] | None = None
    supersedes_id: Identifier | None = None

    @model_validator(mode="after")
    def validity(self):
        active = {"ACCEPTED", "REVISED", "CONDITIONAL"}
        if self.valid != (self.status in active):
            raise ValueError("decision validity/status mismatch")
        if not self.valid and not self.negative_category:
            raise ValueError("negative decision category required")
        return self


class ActionReference(Contract):
    action_id: Identifier
    match_key: Identifier
    action: str = Field(min_length=1, max_length=500)
    deliverable: str = Field(min_length=1, max_length=500)
    action_phrases: list[str] = Field(min_length=1, max_length=8)
    deliverable_phrases: list[str] = Field(min_length=1, max_length=8)
    state: Literal["SUGGESTED", "ACTIVE", "ASSIGNED", "COMMITTED", "REVISED", "CANCELLED",
                   "UNRESOLVED", "CONDITIONAL", "HISTORICAL"]
    valid: bool
    evidence: list[EvidenceReference] = Field(min_length=1, max_length=16)
    mentioned_party: str | None = Field(default=None, max_length=200)
    party_phrases: list[str] = Field(default_factory=list, max_length=8)
    due_date: str | None = Field(default=None, pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
    due_date_phrases: list[str] = Field(default_factory=list, max_length=8)
    expected_null_fields: list[Literal["assignee", "due_date"]] = Field(default_factory=list)
    negative_category: Literal["suggestion", "cancelled-task", "historical-task", "decision-only", "unresolved"] | None = None

    @model_validator(mode="after")
    def validity(self):
        if self.valid != (self.state in {"ACTIVE", "ASSIGNED", "COMMITTED", "REVISED"}):
            raise ValueError("action validity/state mismatch")
        if not self.valid and not self.negative_category:
            raise ValueError("negative action category required")
        if self.mentioned_party and not self.party_phrases:
            raise ValueError("party phrases required")
        if self.due_date and not self.due_date_phrases:
            raise ValueError("due-date phrases required")
        if self.due_date:
            try:
                if date.fromisoformat(self.due_date).isoformat() != self.due_date:
                    raise ValueError("due date must be an ISO calendar date")
            except ValueError:
                raise ValueError("due date must be an ISO calendar date") from None
        return self


class SummaryClaimJudgment(Contract):
    prediction_id: Identifier
    factual_support: Literal["SUPPORTED", "PARTIAL", "UNSUPPORTED", "NOT_REVIEWED"]
    evidence_support: Literal["SUPPORTED", "PARTIAL", "UNSUPPORTED", "NOT_REVIEWED"]
    severity: Literal["none", "low", "material", "critical"]
    reviewer_id: Identifier
    adjudicated: bool = False


class SummaryHumanReview(Contract):
    fixture_id: Identifier
    reviewer_id: Identifier
    readability: Literal["GOOD", "ACCEPTABLE", "POOR"]
    usefulness: Literal["GOOD", "ACCEPTABLE", "POOR"]
    adjudicated: bool = False


class ReferenceAnnotations(Contract):
    schema_version: Literal[1]
    fixture_id: Identifier
    reference_version: Version
    annotation_version: Version
    source_snapshot_id: UuidText
    transcript_id: UuidText
    content_revision: int = Field(ge=0)
    source_sha256: Digest
    provenance: AnnotationProvenance
    summary_facts: list[SummaryFact] = Field(default_factory=list)
    contradictions: list[ContradictionReference] = Field(default_factory=list)
    decisions: list[DecisionReference] = Field(default_factory=list)
    action_items: list[ActionReference] = Field(default_factory=list)
    expected_warnings: list[str] = Field(default_factory=list)
    summary_reviews: list[SummaryClaimJudgment] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_labels(self):
        for values, name, identifier in ((self.summary_facts, "summary facts", "fact_id"),
                                         (self.contradictions, "contradictions", "contradiction_id"),
                                         (self.decisions, "decisions", "decision_id"),
                                         (self.action_items, "action items", "action_id")):
            ids = [getattr(value, identifier, None) for value in values]
            if len(set(ids)) != len(ids):
                raise ValueError(f"duplicate {name}")
        keys = {}
        for item in self.decisions:
            previous = keys.setdefault(item.match_key, item)
            if previous is not item and (previous.valid != item.valid or previous.outcome != item.outcome):
                raise ValueError("conflicting decision labels")
        keys = {}
        for item in self.action_items:
            previous = keys.setdefault(item.match_key, item)
            if previous is not item and (previous.valid != item.valid or previous.deliverable != item.deliverable):
                raise ValueError("conflicting action labels")
        if any(code not in _WARNING_CODES for code in self.expected_warnings):
            raise ValueError("unknown warning code")
        if len(set(self.expected_warnings)) != len(self.expected_warnings):
            raise ValueError("duplicate warning code")
        return self


@dataclass(frozen=True)
class LoadedCase:
    descriptor: CaseDescriptor
    snapshot: dict
    source: EvidenceSource
    reference: ReferenceAnnotations


@dataclass(frozen=True)
class MeetingDataset:
    manifest: Manifest
    cases: tuple[LoadedCase, ...]
    dataset_sha256: str


def _read_json(path: Path, maximum: int = 16 * 1024 * 1024):
    try:
        if (not path.is_file() or path.is_symlink()
                or any(parent.is_symlink() for parent in path.parents)
                or path.stat().st_size > maximum):
            raise ValueError
        raw = path.read_bytes()
        value = json.loads(raw, object_pairs_hook=_unique_keys, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if not isinstance(value, dict):
            raise ValueError
        return raw, value
    except (OSError, ValueError, TypeError, UnicodeError):
        raise EvaluationError("evaluation JSON asset invalid or unavailable") from None


def _safe_file(root: Path, relative: str) -> Path:
    try:
        root = root.absolute()
        path = root / relative
        require(not root.is_symlink() and path.resolve().is_relative_to(root.resolve()), "evaluation asset path")
        require(not any(part.is_symlink() for part in (path, *path.parents)), "evaluation asset symlink")
        require(path.is_file(), "evaluation asset")
        return path
    except (OSError, ValueError):
        raise EvaluationError("evaluation asset unavailable or unsafe") from None


def _source_claim(descriptor: SourceDescriptor):
    return SimpleNamespace(
        meetingId=descriptor.meeting_id,
        sourceMediaId=descriptor.source_media_id,
        source=SimpleNamespace(
            transcriptId=descriptor.transcript_id,
            contentRevision=descriptor.content_revision,
            schemaVersion=1,
            sizeBytes=descriptor.size_bytes,
            sha256=descriptor.sha256,
            snapshotId=descriptor.snapshot_id,
        ),
    )


def _normalized_source(descriptor: SourceDescriptor, snapshot: dict):
    deadline = time.monotonic() + 30
    context = StageContext(
        "00000000-0000-0000-0000-000000000004", "00000000-0000-0000-0000-000000000005",
        "GENERATING_SUMMARY", descriptor.meeting_id, descriptor.snapshot_id, descriptor.sha256,
        descriptor.transcript_id, descriptor.content_revision, snapshot, deadline, Event(),
    )
    settings = Settings(service_name="t07-evaluation", service_identity="ai-core", _env_file=None)
    return normalize_evidence(context, ContextLimits.from_settings(settings))


def _validate_annotations(reference: ReferenceAnnotations, descriptor: SourceDescriptor, source: EvidenceSource):
    require(reference.source_snapshot_id == descriptor.snapshot_id
            and reference.transcript_id == descriptor.transcript_id
            and reference.content_revision == descriptor.content_revision
            and reference.source_sha256 == descriptor.sha256, "reference source binding")
    for collection in (reference.summary_facts, reference.contradictions, reference.decisions, reference.action_items):
        for item in collection:
            for evidence in item.evidence:
                try:
                    source.resolve(evidence.segment_id, evidence.char_start, evidence.char_end)
                except Exception:
                    raise EvaluationError("evaluation annotation evidence invalid") from None
    return reference


def load_meeting_dataset(root: Path, *, manifest_path: Path | None = None) -> MeetingDataset:
    """Load and verify a T07 manifest, immutable Core snapshots, and references."""
    try:
        root = Path(root).absolute()
        require(root.is_dir() and not root.is_symlink(), "dataset root")
        path = manifest_path.absolute() if manifest_path is not None else root / "manifest.json"
        require(path == root / "manifest.json" or path.resolve().is_relative_to(root.resolve()), "manifest location")
        raw_manifest, document = _read_json(path)
        require("manifest_sha256" not in document, "manifest digest")
        manifest = Manifest.model_validate({**document, "manifest_sha256": hashlib.sha256(raw_manifest).hexdigest()})
        cases = []
        for descriptor in sorted(manifest.cases, key=lambda item: item.fixture_id):
            source_path = _safe_file(root, descriptor.source.path)
            raw_source = source_path.read_bytes()
            require(len(raw_source) == descriptor.source.size_bytes
                    and hashlib.sha256(raw_source).hexdigest() == descriptor.source.sha256, "source digest")
            snapshot = verify_snapshot(raw_source, _source_claim(descriptor.source))
            source = _normalized_source(descriptor.source, snapshot)
            reference_path = _safe_file(root, descriptor.reference.path)
            raw_reference, reference_document = _read_json(reference_path)
            require(hashlib.sha256(raw_reference).hexdigest() == descriptor.reference.sha256, "reference digest")
            reference = ReferenceAnnotations.model_validate(reference_document)
            require(reference.fixture_id == descriptor.fixture_id
                    and reference.reference_version == descriptor.reference.reference_version
                    and reference.annotation_version == descriptor.annotation_version, "reference identity")
            _validate_annotations(reference, descriptor.source, source)
            cases.append(LoadedCase(descriptor, snapshot, source, reference))
        identity = {
            "manifest_sha256": manifest.manifest_sha256,
            "cases": [{"fixture_id": case.descriptor.fixture_id,
                       "source_sha256": case.descriptor.source.sha256,
                       "reference_sha256": case.descriptor.reference.sha256,
                       "annotation_version": case.descriptor.annotation_version} for case in cases],
        }
        return MeetingDataset(manifest, tuple(cases), digest_json(identity))
    except EvaluationError:
        raise
    except (OSError, TypeError, ValueError, ValidationError):
        raise EvaluationError("evaluation dataset invalid or unavailable") from None


def _ratio(numerator: int, denominator: int):
    if denominator <= 0:
        return None
    return {"numerator": numerator, "denominator": denominator}


def _f1(true_positive: int, false_positive: int, false_negative: int):
    return _ratio(2 * true_positive, 2 * true_positive + false_positive + false_negative)


def _undefined(metrics: dict, names: Iterable[str]):
    metrics["undefined_metrics"] = sorted(name for name in names if metrics.get(name) is None)
    return metrics


def _items(value, key):
    if isinstance(value, dict):
        return value.get(key, ())
    return getattr(value, key, ())


def _result(value):
    return value.get("result", value) if isinstance(value, dict) else value


def _one_to_one(predictions, references, edges):
    """Stable maximum-cardinality bipartite matching for explicit labels."""
    assigned: dict[int, int] = {}

    def visit(pred_index: int, seen: set[int]) -> bool:
        for _, reference_index in sorted(edges.get(pred_index, ()), key=lambda item: (item[0], item[1])):
            if reference_index in seen:
                continue
            seen.add(reference_index)
            previous = next((key for key, value in assigned.items() if value == reference_index), None)
            if previous is None or visit(previous, seen):
                assigned[pred_index] = reference_index
                return True
        return False

    for index in range(len(predictions)):
        visit(index, set())
    return assigned


def _reference_evidence_ids(reference) -> set[str]:
    return {item.segment_id for item in reference.evidence}


def evidence_metrics(prediction_evidence: Iterable[str], reference_evidence: Iterable[EvidenceReference],
                     valid_segment_ids: Iterable[str] | None = None):
    predicted = list(prediction_evidence)
    reference = {item.segment_id for item in reference_evidence}
    valid = set(valid_segment_ids or ())
    invalid = sorted(set(predicted) - valid) if valid else []
    relevant = sum(item in reference for item in predicted)
    complete = reference <= set(predicted)
    return {
        "predicted_reference_count": len(predicted),
        "reference_segment_count": len(reference),
        "relevant_segment_count": relevant,
        "invalid_segment_count": len(invalid),
        "evidence_precision": _ratio(relevant, len(predicted)),
        "evidence_completeness": _ratio(len(reference & set(predicted)), len(reference)),
        "complete": complete,
        "invalid_segment_ids": invalid,
    }


def _candidate_evidence(candidate):
    ids = candidate.get("evidenceSegmentIds", [])
    return ids if isinstance(ids, list) else []


def decision_metrics(prediction, annotations, *, valid_segment_ids: Iterable[str] | None = None):
    result = _result(prediction)
    candidates = list(result.get("candidates", ())) if isinstance(result, dict) else []
    references = list(_items(annotations, "decisions"))
    expected = [item for item in references if item.valid]
    edges = {}
    for pindex, candidate in enumerate(candidates):
        content = candidate.get("content", "")
        for rindex, reference in enumerate(references):
            phrase = any(_contains(content, value) for value in reference.outcome_phrases)
            scope = any(_contains(content, value) for value in reference.scope_phrases)
            if phrase and scope:
                edges.setdefault(pindex, []).append((0, rindex))
            elif phrase:
                edges.setdefault(pindex, []).append((1, rindex))
    matches = _one_to_one(candidates, references, edges)
    matched_expected = {rindex for rindex in matches.values() if references[rindex].valid}
    true_positive = len(matched_expected)
    false_positive = len(candidates) - true_positive
    false_negative = len(expected) - true_positive
    duplicate_count = len(candidates) - len({_normal(item.get("content", "")) for item in candidates})
    critical = []
    rejected = historical = action_only = 0
    uncertainty_correct = 0
    evidence = []
    for pindex, candidate in enumerate(candidates):
        rindex = matches.get(pindex)
        if rindex is None:
            critical.append({"category": "INVENTED_AGREEMENT", "severity": "critical",
                             "prediction_index": pindex})
            continue
        reference = references[rindex]
        if not reference.valid:
            category = reference.negative_category or "non-decision"
            if category == "rejected-proposal":
                rejected += 1
                critical.append({"category": "REJECTED_PROPOSAL_FALSE_PROMOTION", "severity": "critical",
                                 "prediction_index": pindex, "reference_id": reference.decision_id})
            elif category == "historical":
                historical += 1
                critical.append({"category": "HISTORICAL_DECISION_FALSE_PROMOTION", "severity": "high",
                                 "prediction_index": pindex, "reference_id": reference.decision_id})
            elif category == "action-only":
                action_only += 1
                critical.append({"category": "ACTION_ITEM_FALSE_PROMOTION", "severity": "high",
                                 "prediction_index": pindex, "reference_id": reference.decision_id})
        else:
            if candidate.get("uncertainty") == reference.uncertainty:
                uncertainty_correct += 1
            if reference.status == "CONDITIONAL" and candidate.get("uncertainty") != "MATERIAL":
                critical.append({"category": "CONDITIONAL_UNCERTAINTY_MISSED", "severity": "high",
                                 "prediction_index": pindex, "reference_id": reference.decision_id})
        evidence.append(evidence_metrics(_candidate_evidence(candidate), reference.evidence, valid_segment_ids))
    metrics = {
        "prediction_count": len(candidates), "reference_count": len(expected),
        "true_positive": true_positive, "false_positive": false_positive, "false_negative": false_negative,
        "precision": _ratio(true_positive, len(candidates)), "recall": _ratio(true_positive, len(expected)),
        "f1": _f1(true_positive, false_positive, false_negative),
        "duplicate_candidate_count": max(0, duplicate_count),
        "duplicate_candidate_rate": _ratio(max(0, duplicate_count), len(candidates)),
        "rejected_proposal_false_promotion_count": rejected,
        "historical_false_positive_count": historical,
        "action_only_false_positive_count": action_only,
        "uncertainty_correct_count": uncertainty_correct,
        "uncertainty_appropriate": _ratio(uncertainty_correct, true_positive),
        "evidence": evidence,
        "critical_failures": critical,
    }
    return _undefined(metrics, ("precision", "recall", "f1", "duplicate_candidate_rate", "uncertainty_appropriate"))


def _summary_claims(content: str):
    claims = []
    for line in content.splitlines():
        if not line.lstrip().startswith("-"):
            continue
        text = line.lstrip()[1:].strip()
        if not text:
            continue
        claims.append({"prediction_id": f"claim-{len(claims) + 1:04d}", "text": text})
    return claims


def human_review_metrics(reviews: Iterable[SummaryHumanReview | dict]) -> dict:
    normalized = []
    seen = set()
    for item in reviews:
        review = item if isinstance(item, SummaryHumanReview) else SummaryHumanReview.model_validate(item)
        identity = (review.fixture_id, review.reviewer_id)
        if identity in seen:
            raise EvaluationError("duplicate human review")
        seen.add(identity)
        normalized.append(review)
    ratings = {name: {value: 0 for value in ("GOOD", "ACCEPTABLE", "POOR")} for name in ("readability", "usefulness")}
    for review in normalized:
        ratings["readability"][review.readability] += 1
        ratings["usefulness"][review.usefulness] += 1
    return {
        "status": "ESTABLISHED" if normalized else "UNESTABLISHED",
        "review_count": len(normalized),
        **ratings,
    }


def score_summary(prediction, annotations, *, review: Iterable[SummaryClaimJudgment | dict] | None = None,
                  human_review: Iterable[SummaryHumanReview | dict] | None = None):
    result = _result(prediction)
    content = result.get("content", "") if isinstance(result, dict) else ""
    claims = _summary_claims(content)
    facts = list(_items(annotations, "summary_facts"))
    edges = {}
    for pindex, claim in enumerate(claims):
        for rindex, fact in enumerate(facts):
            if any(_contains(claim["text"], phrase) for phrase in fact.match_phrases):
                edges.setdefault(pindex, []).append((0, rindex))
    matches = _one_to_one(claims, facts, edges)
    matched = set(matches.values())
    critical_facts = [fact for fact in facts if fact.importance in {"critical", "material"}]
    matched_critical = sum(index in matched for index, fact in enumerate(facts) if fact.importance in {"critical", "material"})
    reviewed = list(review if review is not None else _items(annotations, "summary_reviews"))
    review_by_id = {item.get("prediction_id") if isinstance(item, dict) else item.prediction_id: item for item in reviewed}
    support_counts = Counter()
    unsupported = []
    for claim in claims:
        item = review_by_id.get(claim["prediction_id"])
        if item is None:
            continue
        value = item.get("factual_support") if isinstance(item, dict) else item.factual_support
        if value != "NOT_REVIEWED":
            support_counts[value] += 1
        if value == "UNSUPPORTED":
            severity = item.get("severity", "material") if isinstance(item, dict) else item.severity
            unsupported.append({"category": "UNSUPPORTED_SUMMARY_CLAIM", "severity": severity,
                                "prediction_id": claim["prediction_id"]})
    qualifications = []
    for pindex, rindex in matches.items():
        fact = facts[rindex]
        if fact.required_qualifications and not any(
            _contains(claims[pindex]["text"], phrase) for phrase in fact.required_qualifications
        ):
            qualifications.append(fact.fact_id)
    uncertainty_missing = []
    uncertainty_preserved = 0
    for index, fact in enumerate(facts):
        if not fact.required_uncertainty_terms:
            continue
        pindex = next((candidate for candidate, reference in matches.items() if reference == index), None)
        if pindex is not None and any(
            _contains(claims[pindex]["text"], phrase) for phrase in fact.required_uncertainty_terms
        ):
            uncertainty_preserved += 1
        else:
            uncertainty_missing.append(fact.fact_id)
    warnings = tuple(result.get("warnings", ())) if isinstance(result, dict) else ()
    expected_warnings = tuple(_items(annotations, "expected_warnings"))
    warning_hit = sum(code in warnings for code in expected_warnings)
    contradiction_results = []
    for contradiction in _items(annotations, "contradictions"):
        relevant = any(any(_contains(claim["text"], phrase) for phrase in contradiction.match_phrases) for claim in claims)
        text = " ".join(claim["text"] for claim in claims)
        correct = relevant and all(_contains(text, phrase) for phrase in contradiction.required_phrases) \
            and not any(_contains(text, phrase) for phrase in contradiction.forbidden_phrases)
        contradiction_results.append({"contradiction_id": contradiction.contradiction_id, "correct": correct})
        if relevant and not correct:
            unsupported.append({"category": "CONTRADICTION_MISREPRESENTED", "severity": contradiction.severity,
                                "reference_id": contradiction.contradiction_id})
    by_region = {}
    for region in ("early", "middle", "late"):
        region_facts = [index for index, fact in enumerate(facts) if fact.region == region]
        by_region[region] = _ratio(sum(index in matched for index in region_facts), len(region_facts))
    human = human_review_metrics(human_review or ())
    reviewed_claim_count = sum(support_counts.values())
    expected_warning_count = len(expected_warnings)
    correct_contradiction_count = sum(item["correct"] for item in contradiction_results)
    region_fact_count = {region: sum(1 for fact in facts if fact.region == region) for region in ("early", "middle", "late")}
    region_matched_count = {
        region: sum(index in matched for index, fact in enumerate(facts) if fact.region == region)
        for region in ("early", "middle", "late")
    }
    metrics = {
        "claim_count": len(claims), "fact_count": len(facts), "matched_fact_count": len(matched),
        "critical_fact_count": len(critical_facts), "matched_critical_fact_count": matched_critical,
        "coverage_rate": _ratio(len(matched), len(facts)),
        "critical_coverage_rate": _ratio(matched_critical, len(critical_facts)),
        "material_omission_count": len([fact for index, fact in enumerate(facts)
                                         if index not in matched and fact.importance in {"critical", "material"}]),
        "material_omissions": [fact.fact_id for index, fact in enumerate(facts)
                                if index not in matched and fact.importance in {"critical", "material"}],
        "groundedness_status": "ESTABLISHED" if reviewed_claim_count else "UNESTABLISHED",
        "groundedness": (_ratio(support_counts["SUPPORTED"], reviewed_claim_count) if reviewed_claim_count else None),
        "factual_groundedness": (_ratio(support_counts["SUPPORTED"], reviewed_claim_count)
                                 if reviewed_claim_count else None),
        "reviewed_claim_count": reviewed_claim_count,
        "supported_claim_count": support_counts["SUPPORTED"],
        "unsupported_factual_claim_count": (support_counts["UNSUPPORTED"] if reviewed_claim_count else None),
        "unreviewed_claim_count": sum(claim["prediction_id"] not in review_by_id for claim in claims),
        "expected_warning_count": expected_warning_count, "warning_hit_count": warning_hit,
        "warning_recall": _ratio(warning_hit, expected_warning_count),
        "missing_warning_codes": sorted(set(expected_warnings) - set(warnings)),
        "qualification_missing_count": len(qualifications),
        "qualification_missing_fact_ids": qualifications,
        "uncertainty_required_count": sum(bool(fact.required_uncertainty_terms) for fact in facts),
        "uncertainty_preserved_count": uncertainty_preserved,
        "uncertainty_preservation_rate": _ratio(uncertainty_preserved,
                                                 sum(bool(fact.required_uncertainty_terms) for fact in facts)),
        "uncertainty_missing_count": len(uncertainty_missing),
        "uncertainty_missing_fact_ids": uncertainty_missing,
        "contradictions": contradiction_results,
        "contradiction_count": len(contradiction_results),
        "correct_contradiction_count": correct_contradiction_count,
        "contradiction_accuracy": _ratio(correct_contradiction_count, len(contradiction_results)),
        "coverage_by_region": by_region,
        "region_fact_count": region_fact_count, "region_matched_count": region_matched_count,
        "human_review": human,
        "critical_failures": unsupported,
    }
    return _undefined(metrics, ("coverage_rate", "critical_coverage_rate", "groundedness", "warning_recall",
                                "factual_groundedness", "contradiction_accuracy", "uncertainty_preservation_rate"))


def _party_from_details(details):
    if not isinstance(details, str):
        return ""
    marker = "Người được nhắc trong bằng chứng:"
    if marker not in details:
        return ""
    return details.split(marker, 1)[1].split(".", 1)[0].strip()


def score_action_items(prediction, annotations, *, valid_segment_ids: Iterable[str] | None = None):
    result = _result(prediction)
    candidates = list(result.get("candidates", ())) if isinstance(result, dict) else []
    references = list(_items(annotations, "action_items"))
    expected = [item for item in references if item.valid]
    edges = {}
    for pindex, candidate in enumerate(candidates):
        text = f"{candidate.get('title', '')} {candidate.get('details') or ''}"
        for rindex, reference in enumerate(references):
            action = any(_contains(text, value) for value in reference.action_phrases)
            deliverable = any(_contains(text, value) for value in reference.deliverable_phrases)
            if action and deliverable:
                edges.setdefault(pindex, []).append((0, rindex))
            elif action:
                edges.setdefault(pindex, []).append((1, rindex))
    matches = _one_to_one(candidates, references, edges)
    matched_expected = {rindex for rindex in matches.values() if references[rindex].valid}
    true_positive = len(matched_expected)
    false_positive = len(candidates) - true_positive
    false_negative = len(expected) - true_positive
    duplicate_count = len(candidates) - len({_normal(item.get("title", "")) for item in candidates})
    cancelled = historical = decision_only = unsupported_due = missing_due = party_errors = 0
    due_correct = party_correct = 0
    critical = []
    evidence = []
    for pindex, candidate in enumerate(candidates):
        rindex = matches.get(pindex)
        if rindex is None:
            critical.append({"category": "INVENTED_ACTION_ITEM", "severity": "critical", "prediction_index": pindex})
            continue
        reference = references[rindex]
        if not reference.valid:
            category = reference.negative_category or "non-obligation"
            if category == "cancelled-task":
                cancelled += 1
                critical.append({"category": "CANCELLED_WORK_ACTIVE", "severity": "critical",
                                 "prediction_index": pindex, "reference_id": reference.action_id})
            elif category == "historical-task":
                historical += 1
                critical.append({"category": "HISTORICAL_WORK_ACTIVE", "severity": "high",
                                 "prediction_index": pindex, "reference_id": reference.action_id})
            elif category == "decision-only":
                decision_only += 1
                critical.append({"category": "DECISION_FALSE_OBLIGATION", "severity": "high",
                                 "prediction_index": pindex, "reference_id": reference.action_id})
            continue
        due = candidate.get("suggestedDueDate")
        if reference.due_date is None:
            if due is not None:
                unsupported_due += 1
                critical.append({"category": "FABRICATED_DEADLINE", "severity": "critical", "prediction_index": pindex})
        elif due is None:
            missing_due += 1
        elif due == reference.due_date:
            due_correct += 1
        else:
            unsupported_due += 1
            critical.append({"category": "INCORRECT_DEADLINE", "severity": "high", "prediction_index": pindex})
        party = _party_from_details(candidate.get("details"))
        if reference.mentioned_party is None:
            if party:
                party_errors += 1
                critical.append({"category": "FABRICATED_ASSIGNEE", "severity": "critical", "prediction_index": pindex})
        elif any(_contains(party, phrase) for phrase in reference.party_phrases):
            party_correct += 1
        else:
            party_errors += 1
        evidence.append(evidence_metrics(_candidate_evidence(candidate), reference.evidence, valid_segment_ids))
    metrics = {
        "prediction_count": len(candidates), "reference_count": len(expected),
        "true_positive": true_positive, "false_positive": false_positive, "false_negative": false_negative,
        "precision": _ratio(true_positive, len(candidates)), "recall": _ratio(true_positive, len(expected)),
        "f1": _f1(true_positive, false_positive, false_negative),
        "false_obligation_rate": _ratio(false_positive, len(candidates)),
        "duplicate_task_count": max(0, duplicate_count), "duplicate_task_rate": _ratio(max(0, duplicate_count), len(candidates)),
        "cancelled_task_false_positive_count": cancelled, "historical_false_positive_count": historical,
        "decision_only_false_positive_count": decision_only,
        "unsupported_due_date": unsupported_due,
        "missing_supported_due_date": missing_due,
        "due_date_correct_count": due_correct,
        "due_date_reference_count": sum(reference.due_date is not None for reference in expected),
        "due_date_accuracy": _ratio(due_correct, sum(reference.due_date is not None for reference in expected)),
        "assignee_correct_count": party_correct,
        "assignee_reference_count": sum(reference.mentioned_party is not None for reference in expected),
        "assignee_accuracy": _ratio(party_correct, sum(reference.mentioned_party is not None for reference in expected)),
        "unsupported_assignee_implication": party_errors,
        "evidence": evidence,
        "critical_failures": critical,
    }
    return _undefined(metrics, ("precision", "recall", "f1", "false_obligation_rate", "duplicate_task_rate",
                                "due_date_accuracy", "assignee_accuracy"))


def cross_feature_consistency(predictions: dict, annotations) -> dict:
    findings = []
    summary = _result(predictions.get("summary", {}))
    decision = _result(predictions.get("decision", {}))
    action = _result(predictions.get("action", {}))
    summary_text = summary.get("content", "") if isinstance(summary, dict) else ""
    decisions = decision.get("candidates", ()) if isinstance(decision, dict) else ()
    actions = action.get("candidates", ()) if isinstance(action, dict) else ()
    if re.search(r"(?:nhóm\s+)?(?:đã\s+)?thống\s+nhất|đã\s+chốt|agreed", summary_text, re.I) and not decisions:
        findings.append({"category": "SUMMARY_UNSUPPORTED_CONCLUSION", "severity": "critical"})
    if actions and not _items(annotations, "action_items"):
        findings.append({"category": "CROSS_FEATURE_UNSUPPORTED_OBLIGATION", "severity": "critical"})
    return {"status": "FAIL" if any(item["severity"] == "critical" for item in findings) else "PASS",
            "findings": findings, "decision_count": len(decisions), "action_count": len(actions)}


class GatePolicy(Contract):
    schema_version: Literal[1]
    policy_version: Version
    minimum_reference_coverage: int = Field(ge=0)
    minimum_evaluated_cases: int = Field(ge=1)
    minimum_decision_precision: dict[str, int] | None = None
    minimum_decision_recall: dict[str, int] | None = None
    minimum_action_precision: dict[str, int] | None = None
    minimum_action_recall: dict[str, int] | None = None
    minimum_summary_groundedness: dict[str, int] | None = None
    maximum_critical_failures: int = Field(ge=0)
    require_human_review: bool
    required_categories: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def bounds(self):
        for value in (self.minimum_decision_precision, self.minimum_decision_recall,
                      self.minimum_action_precision, self.minimum_action_recall,
                      self.minimum_summary_groundedness):
            if value is not None and (set(value) != {"numerator", "denominator"}
                                      or type(value["numerator"]) is not int
                                      or type(value["denominator"]) is not int
                                      or value["denominator"] <= 0
                                      or value["numerator"] < 0
                                      or value["numerator"] > value["denominator"]):
                raise ValueError("invalid threshold")
        if any(category not in DATASET_CATEGORIES for category in self.required_categories):
            raise ValueError("unknown gate category")
        return self


def _fraction(value):
    if isinstance(value, dict) and set(value) == {"numerator", "denominator"} and value["denominator"] > 0:
        return value["numerator"] / value["denominator"]
    return None


def evaluate_quality_gates(policy: GatePolicy | None, *, mode: str, reference_reviewed: bool,
                           attempted_cases: int, reference_coverage: int, metrics: dict,
                           critical_failure_count: int = 0, category_coverage: Iterable[str] = ()):
    software = "PASS" if attempted_cases >= 0 else "FAIL"
    if critical_failure_count:
        software = "FAIL"
    covered_categories = sorted(set(category_coverage))
    missing_categories = sorted(set(policy.required_categories) - set(covered_categories)) if policy else []
    if attempted_cases == 0:
        model = "UNAVAILABLE"
    elif mode == "deterministic-offline" or not reference_reviewed or policy is None:
        model = "UNESTABLISHED"
    else:
        checks = []
        if attempted_cases < policy.minimum_evaluated_cases:
            checks.append(False)
        if reference_coverage < policy.minimum_reference_coverage:
            checks.append(False)
        if missing_categories:
            checks.append(False)
        if critical_failure_count > policy.maximum_critical_failures:
            checks.append(False)
        for name, threshold in (("decision_precision", policy.minimum_decision_precision),
                                ("decision_recall", policy.minimum_decision_recall),
                                ("action_precision", policy.minimum_action_precision),
                                ("action_recall", policy.minimum_action_recall),
                                ("summary_groundedness", policy.minimum_summary_groundedness)):
            if threshold is not None:
                actual = _fraction(metrics.get(name))
                checks.append(actual is not None and actual >= _fraction(threshold))
        model = "PASS" if checks and all(checks) else "FAIL" if checks else "UNESTABLISHED"
    return {
        "software_gate": software,
        "model_quality_gate": model,
        "production_readiness_gate": "UNAVAILABLE",
        "evidence_level": "DETERMINISTIC_SOFTWARE" if mode == "deterministic-offline" else mode.upper(),
        "reference_reviewed": reference_reviewed,
        "attempted_cases": attempted_cases,
        "reference_coverage": reference_coverage,
        "critical_failure_count": critical_failure_count,
        "required_category_coverage": covered_categories,
        "missing_required_categories": missing_categories,
    }


def validate_processor_candidate(feature: str, candidate: dict, snapshot: dict, claim) -> dict:
    """Validate a candidate through its existing production canonical boundary."""
    try:
        require(feature in FEATURES, "feature")
        if feature in {"summary", "decision"}:
            stage = "GENERATING_SUMMARY" if feature == "summary" else "EXTRACTING_DECISIONS"
            require(claim.executionStageCode == stage, "stage")
            raw = serialize_result(candidate, claim, snapshot)
        else:
            raw = prepare_action_item_request(candidate, claim, snapshot)
        return json.loads(raw)
    except Exception:
        raise EvaluationError("processor candidate failed canonical validation") from None


def _safe_record(record: dict) -> dict:
    allowed = {
        "fixture_id", "feature", "status", "failure_category", "empty_result", "quality_status", "metrics",
        "provenance", "telemetry", "critical_failures", "source", "evaluation_id", "duration_ns", "warnings",
        "reference_reviewed",
    }
    return {key: value for key, value in record.items() if key in allowed}


def _aggregate_metrics(feature: str, rows: list[dict]) -> dict:
    if not rows:
        return {}
    ratio_keys = {
        "precision", "recall", "f1", "duplicate_candidate_rate", "duplicate_task_rate",
        "false_obligation_rate", "uncertainty_appropriate", "coverage_rate", "critical_coverage_rate",
        "groundedness", "factual_groundedness", "warning_recall", "contradiction_accuracy",
        "uncertainty_preservation_rate", "due_date_accuracy", "assignee_accuracy",
    }
    list_keys = {
        "critical_failures", "evidence", "material_omissions", "missing_warning_codes",
        "qualification_missing_fact_ids", "undefined_metrics", "contradictions",
    }
    aggregate = {}
    for key in sorted({key for row in rows for key in row} - ratio_keys - {"coverage_by_region", "human_review"}):
        values = [row[key] for row in rows if key in row]
        if not values:
            continue
        if key in list_keys:
            merged = []
            for value in values:
                if isinstance(value, list):
                    merged.extend(value)
            aggregate[key] = merged
        elif all(type(value) is int for value in values):
            aggregate[key] = sum(values)
        elif key == "groundedness_status":
            aggregate[key] = "ESTABLISHED" if "ESTABLISHED" in values else "UNESTABLISHED"
        elif all(value == values[0] for value in values):
            aggregate[key] = values[0]

    def total(key: str) -> int:
        return sum(row.get(key, 0) for row in rows)

    def total_map(key: str, name: str) -> int:
        return sum(row.get(key, {}).get(name, 0) for row in rows)

    true_positive = total("true_positive")
    false_positive = total("false_positive")
    false_negative = total("false_negative")
    if feature in {"decision", "action"}:
        aggregate.update({
            "precision": _ratio(true_positive, total("prediction_count")),
            "recall": _ratio(true_positive, total("reference_count")),
            "f1": _f1(true_positive, false_positive, false_negative),
        })
    if feature == "decision":
        aggregate["duplicate_candidate_rate"] = _ratio(total("duplicate_candidate_count"), total("prediction_count"))
        aggregate["uncertainty_appropriate"] = _ratio(total("uncertainty_correct_count"), true_positive)
    elif feature == "action":
        aggregate["false_obligation_rate"] = _ratio(false_positive, total("prediction_count"))
        aggregate["duplicate_task_rate"] = _ratio(total("duplicate_task_count"), total("prediction_count"))
        aggregate["due_date_accuracy"] = _ratio(total("due_date_correct_count"), total("due_date_reference_count"))
        aggregate["assignee_accuracy"] = _ratio(total("assignee_correct_count"), total("assignee_reference_count"))
    elif feature == "summary":
        aggregate["coverage_rate"] = _ratio(total("matched_fact_count"), total("fact_count"))
        aggregate["critical_coverage_rate"] = _ratio(
            total("matched_critical_fact_count"), total("critical_fact_count"))
        aggregate["groundedness"] = _ratio(total("supported_claim_count"), total("reviewed_claim_count"))
        aggregate["factual_groundedness"] = aggregate["groundedness"]
        aggregate["warning_recall"] = _ratio(total("warning_hit_count"), total("expected_warning_count"))
        aggregate["contradiction_accuracy"] = _ratio(
            total("correct_contradiction_count"), total("contradiction_count"))
        aggregate["uncertainty_preservation_rate"] = _ratio(
            total("uncertainty_preserved_count"), total("uncertainty_required_count"))
        aggregate["coverage_by_region"] = {
            region: _ratio(total_map("region_matched_count", region), total_map("region_fact_count", region))
            for region in ("early", "middle", "late")
        }

    if feature == "summary":
        review_rows = [row.get("human_review", {}) for row in rows if isinstance(row.get("human_review"), dict)]
        review_count = sum(row.get("review_count", 0) for row in review_rows)
        human = {"status": "ESTABLISHED" if review_count else "UNESTABLISHED", "review_count": review_count}
        for rating in ("readability", "usefulness"):
            human[rating] = {
                value: sum(row.get(rating, {}).get(value, 0) for row in review_rows)
                for value in ("GOOD", "ACCEPTABLE", "POOR")
            }
        aggregate["human_review"] = human
    return _undefined(aggregate, ratio_keys)


def _provenance_dimensions(records: list[dict]) -> dict:
    dimensions = {}
    for key in ("processor_version", "model", "prompt_version", "configuration_sha256", "provider"):
        values = sorted({record.get("provenance", {}).get(key) for record in records
                         if record.get("provenance", {}).get(key) is not None})
        if values:
            dimensions[key] = values
    return dimensions


def build_evaluation_report(manifest, results, *, mode: str, policy: GatePolicy | None,
                            baseline: dict | None = None, run_id: str | None = None) -> dict:
    dataset_id = getattr(manifest, "dataset_id")
    dataset_version = getattr(manifest, "dataset_version")
    manifest_sha = getattr(manifest, "manifest_sha256", None)
    annotation_version = getattr(manifest, "annotation_version", None) or getattr(manifest, "annotation_guideline_version", None)
    scoring_version = getattr(manifest, "scoring_policy_version", SCORING_POLICY_VERSION)
    clean = [_safe_record(record) for record in sorted(results, key=lambda item: (item.get("fixture_id", ""), item.get("feature", "")))]
    critical = [failure for record in clean for failure in record.get("critical_failures", ()) or ()]
    attempted = len(clean)
    successful = sum(record.get("status") == "SUCCESS" for record in clean)
    reference_reviewed = all(record.get("reference_reviewed", False) for record in clean) if clean else False
    feature_metrics = {}
    for feature in FEATURES:
        rows = [record.get("metrics") for record in clean if record.get("feature") == feature and record.get("metrics")]
        feature_metrics[feature] = {
            "case_count": len(rows),
            "metrics": _aggregate_metrics(feature, rows),
        }
    gate_metrics = {
        f"{feature}_{metric}": feature_metrics[feature]["metrics"].get(metric)
        for feature, metric in (("decision", "precision"), ("decision", "recall"),
                                ("action", "precision"), ("action", "recall"),
                                ("summary", "factual_groundedness"))
    }
    case_categories = {case.fixture_id: case.categories for case in getattr(manifest, "cases", ())}
    category_coverage = sorted({category for record in clean for category in case_categories.get(record.get("fixture_id"), ())})
    gates = evaluate_quality_gates(policy, mode=mode, reference_reviewed=reference_reviewed,
                                    attempted_cases=attempted, reference_coverage=successful,
                                    metrics=gate_metrics, critical_failure_count=len(critical),
                                    category_coverage=category_coverage)
    identity = {"dataset_id": dataset_id, "dataset_version": dataset_version,
                "manifest_sha256": manifest_sha, "annotation_version": annotation_version,
                "scoring_policy_version": scoring_version, "mode": mode}
    run = {"run_id": run_id or digest_json({**identity, "results": clean}), "mode": mode,
           "attempted_cases": attempted, "successful_cases": successful, "failed_cases": attempted - successful,
           "provenance": _provenance_dimensions(clean)}
    report = {
        "schema_version": REPORT_SCHEMA_VERSION, "evaluation_version": EVALUATION_VERSION,
        "evaluation_tool_version": EVALUATION_VERSION, "dataset": identity,
        "run": run, "feature_metrics": feature_metrics, "results": clean,
        "critical_failures": critical, "gates": gates,
        "limitations": [
            "Deterministic controlled adapters establish software behavior, not real-model accuracy.",
            "Production readiness is outside AIMI-T07 and remains unavailable.",
        ],
         "missing_evidence": ["approved human-reviewed references", "authorized real-model predictions"]
         if mode == "deterministic-offline" or not reference_reviewed else [],
        "regression": None,
    }
    if baseline is not None:
        report["regression"] = compare_reports(report, baseline)
    return report


def compare_reports(current: dict, baseline: dict) -> dict:
    if not isinstance(current, dict) or not isinstance(baseline, dict):
        raise EvaluationError("evaluation comparison invalid")
    current_dataset = current.get("dataset", {})
    baseline_dataset = baseline.get("dataset", {})
    comparable_keys = ("dataset_id", "dataset_version", "manifest_sha256", "annotation_version",
                       "scoring_policy_version")
    if any(current_dataset.get(key) != baseline_dataset.get(key) for key in comparable_keys):
        return {"status": "INCOMPATIBLE", "reason": "dataset, annotation, or scoring identity differs",
                "metric_changes": [], "critical_failures_added": [], "critical_failures_resolved": []}
    current_rows = {(row.get("fixture_id"), row.get("feature")): row for row in current.get("results", [])}
    baseline_rows = {(row.get("fixture_id"), row.get("feature")): row for row in baseline.get("results", [])}
    changes = []
    for key in sorted(set(current_rows) | set(baseline_rows), key=repr):
        now = current_rows.get(key, {}).get("metrics", {})
        old = baseline_rows.get(key, {}).get("metrics", {})
        for metric in sorted(set(now) & set(old)):
            left, right = _fraction(now.get(metric)), _fraction(old.get(metric))
            if left is not None and right is not None:
                changes.append({"fixture_id": key[0], "feature": key[1], "metric": metric,
                                "delta": {"numerator": now[metric]["numerator"] * old[metric]["denominator"]
                                           - old[metric]["numerator"] * now[metric]["denominator"],
                                           "denominator": now[metric]["denominator"] * old[metric]["denominator"]}})
    current_failures = {json.dumps(item, sort_keys=True) for item in current.get("critical_failures", [])}
    baseline_failures = {json.dumps(item, sort_keys=True) for item in baseline.get("critical_failures", [])}
    return {"status": "COMPARABLE", "metric_changes": changes,
            "comparison_dimensions": {
                "current": current.get("run", {}).get("provenance", {}),
                "baseline": baseline.get("run", {}).get("provenance", {}),
            },
            "critical_failures_added": [json.loads(item) for item in sorted(current_failures - baseline_failures)],
            "critical_failures_resolved": [json.loads(item) for item in sorted(baseline_failures - current_failures)]}


def _display_metric(value) -> str:
    if not isinstance(value, dict) or set(value) != {"numerator", "denominator"}:
        return "undefined" if value is None else str(value)
    denominator = value["denominator"]
    percentage = 100 * value["numerator"] / denominator if denominator else 0
    return f"{value['numerator']}/{denominator} ({percentage:.1f}%)"


def render_evaluation_summary(report: dict) -> str:
    """Render a safe Markdown review summary without model output or transcript text."""
    lines = [
        "# Meeting Intelligence Evaluation",
        "",
        f"- Dataset: `{report.get('dataset', {}).get('dataset_id', 'unknown')}` "
        f"(version `{report.get('dataset', {}).get('dataset_version', 'unknown')}`)",
        f"- Run: `{report.get('run', {}).get('run_id', 'unknown')}` "
        f"(`{report.get('run', {}).get('mode', 'unknown')}`)",
        "",
        "## Gates",
        "",
        f"- Software: **{report.get('gates', {}).get('software_gate', 'UNKNOWN')}**",
        f"- Model quality: **{report.get('gates', {}).get('model_quality_gate', 'UNKNOWN')}**",
        f"- Production readiness: **{report.get('gates', {}).get('production_readiness_gate', 'UNKNOWN')}**",
        f"- Evidence: `{report.get('gates', {}).get('evidence_level', 'UNKNOWN')}`",
        "",
        "## Feature Metrics",
        "",
        "| Feature | Evaluations | Precision | Recall | F1 / Coverage |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for feature in FEATURES:
        metrics = report.get("feature_metrics", {}).get(feature, {}).get("metrics", {})
        final = metrics.get("f1") if feature in {"decision", "action"} else metrics.get("coverage_rate")
        lines.append(f"| {feature} | {report.get('feature_metrics', {}).get(feature, {}).get('case_count', 0)} "
                     f"| {_display_metric(metrics.get('precision'))} "
                     f"| {_display_metric(metrics.get('recall'))} "
                     f"| {_display_metric(final)} |")
    lines.extend(["", "## Critical Failures", ""])
    failures = report.get("critical_failures", ())
    if failures:
        for failure in failures:
            lines.append(f"- `{failure.get('category', 'UNKNOWN')}` ({failure.get('severity', 'unknown')})")
    else:
        lines.append("- None recorded.")
    lines.extend(["", "## Limitations", ""])
    for limitation in report.get("limitations", ()):
        lines.append(f"- {limitation}")
    for missing in report.get("missing_evidence", ()):
        lines.append(f"- Missing evidence: {missing}")
    regression = report.get("regression")
    if regression is not None:
        lines.extend(["", "## Regression", "", f"- Status: **{regression.get('status', 'UNKNOWN')}**"])
        for change in regression.get("metric_changes", ()):
            lines.append(f"- `{change.get('feature')}/{change.get('metric')}` delta: "
                         f"{_display_metric(change.get('delta'))}")
    return "\n".join(lines) + "\n"


def write_evaluation_report(path: Path, report: dict):
    try:
        path = Path(path)
        require(path.parent.is_dir() and not path.is_symlink()
                and not any(parent.is_symlink() for parent in path.parents), "evaluation output")
        path.write_text(canonical_json(report), encoding="utf-8")
    except (OSError, TypeError, ValueError):
        raise EvaluationError("evaluation report output unavailable") from None


def write_evaluation_summary(path: Path, report: dict):
    try:
        path = Path(path)
        require(path.parent.is_dir() and not path.is_symlink()
                and not any(parent.is_symlink() for parent in path.parents), "evaluation summary output")
        path.write_text(render_evaluation_summary(report), encoding="utf-8")
    except (OSError, TypeError, ValueError):
        raise EvaluationError("evaluation summary output unavailable") from None
