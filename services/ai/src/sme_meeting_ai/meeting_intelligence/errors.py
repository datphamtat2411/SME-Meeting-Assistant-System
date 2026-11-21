"""Content-free capability failures; worker ownership always takes precedence."""

import math
import time
from dataclasses import dataclass
from threading import Event

VALIDATION_LEAF_REASONS = frozenset({"INVALID_REFERENCE", "GROUNDING_FAILURE"})
VALIDATION_RULES = frozenset({
    "SOURCE_IDENTITY",
    "REFERENCE_SHAPE",
    "REFERENCE_SEGMENT_NOT_FOUND",
    "REFERENCE_RANGE",
    "REFERENCE_DUPLICATE",
    "REFERENCE_OUTSIDE_WINDOW",
    "REFERENCE_NOT_ALLOWED",
    "TEXT_POLICY",
    "STATEMENT_NOT_GROUNDED",
    "QUALIFICATION_NOT_GROUNDED",
    "UNSUPPORTED_NUMBER",
    "AGREEMENT_UNSUPPORTED",
    "AGREEMENT_CONTRADICTED",
    "REDUCTION_COVERAGE",
    "REDUCTION_EMPTY",
    "CLAIM_SECTION",
    "CLAIM_NOT_MATCHED",
    "CLAIM_UNCERTAINTY",
    "CLAIM_CONFLICT_UNRESOLVED",
    "CLAIM_NOT_GROUNDED",
    "CLAIM_RECORD_GROUNDING",
    "CLAIM_QUALIFICATION_GROUNDING",
    "MATERIAL_CLAIM_COVERAGE",
})
MAX_VALIDATION_ITEM_INDEX = 10_000
MAX_VALIDATION_REFERENCES = 16
MAX_VALIDATION_REFERENCE_OFFSET = 8_388_608
VALIDATION_EVIDENCE_ASSESSMENTS = frozenset({
    "SUPPORTED",
    "NEGATIVE_OR_TENTATIVE",
    "INCOMPLETE_CITATION",
    "POSSIBLE_VALIDATOR_FALSE_NEGATIVE",
    "UNSUPPORTED_MODEL_CLASSIFICATION",
})


@dataclass(frozen=True)
class ValidationReference:
    """Safe source coordinates; never carries transcript text."""

    segment_id: str
    char_start: int
    char_end: int


@dataclass(frozen=True)
class ValidationEvidence:
    """Bounded, content-minimizing evidence for local validation diagnosis."""

    source_snapshot_id: str
    transcript_id: str
    content_revision: int
    source_sha256: str
    references: tuple[ValidationReference, ...]
    model_category: str
    statement_sha256: str
    statement_char_length: int
    evidence_sha256: str
    evidence_char_length: int
    affirmative_marker: bool
    negative_marker: bool
    assessment: str


@dataclass(frozen=True)
class ValidationDiagnostic:
    """Allowlisted context for semantic validation failures."""

    reason: str
    rule: str | None
    item_index: int | None
    evidence: ValidationEvidence | None = None


class IntelligenceError(Exception):
    def __init__(
        self,
        category: str,
        *,
        rule: str | None = None,
        item_index: int | None = None,
        evidence: ValidationEvidence | None = None,
    ):
        self.category = category
        self.rule = rule
        self.item_index = item_index
        self.evidence = evidence
        super().__init__(f"INTELLIGENCE_{category}")

    @property
    def diagnostic(self) -> ValidationDiagnostic | None:
        if not isinstance(self.category, str) or self.category not in VALIDATION_LEAF_REASONS:
            return None
        return ValidationDiagnostic(
            self.category,
            self.rule if isinstance(self.rule, str) and self.rule in VALIDATION_RULES else None,
            self.item_index if type(self.item_index) is int
            and 0 <= self.item_index <= MAX_VALIDATION_ITEM_INDEX else None,
            self.evidence if isinstance(self.evidence, ValidationEvidence) else None,
        )


def require(condition: bool, category: str, *, rule: str | None = None,
            item_index: int | None = None,
            evidence: ValidationEvidence | None = None) -> None:
    if not condition:
        raise IntelligenceError(category, rule=rule, item_index=item_index, evidence=evidence)


def check_authority(deadline: float, cancelled: Event) -> None:
    require(type(deadline) in (int, float) and math.isfinite(deadline), "CONFIGURATION")
    require(not cancelled.is_set(), "CANCELLED")
    require(time.monotonic() < deadline, "DEADLINE")
