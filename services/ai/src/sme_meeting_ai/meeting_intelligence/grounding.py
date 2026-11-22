"""Per-execution validation diagnostics. Never retain provider text or exceptions."""
from dataclasses import dataclass

from .errors import IntelligenceError, ValidationDiagnostic

DISCARDED = "GROUNDING_CLAIM_DISCARDED"
REPAIRED = "GROUNDING_CLAIM_REPAIRED"
RESULT_WARNING_CODES = (
    "INCOMPLETE_COVERAGE", "UNRESOLVED_EVIDENCE", "SUSPICIOUS_EVIDENCE", "SOURCE_QUALITY_WARNING",
    DISCARDED, REPAIRED,
)


@dataclass
class GroundingChanges:
    first: ValidationDiagnostic | None = None
    discarded: bool = False
    repaired: bool = False

    def discard(self, error: IntelligenceError) -> None:
        diagnostic = error.diagnostic
        if diagnostic is None or diagnostic.rule == "SOURCE_IDENTITY":
            raise error
        self.first = self.first or diagnostic
        self.discarded = True

    def require_usable(self, records) -> None:
        if not records and self.first is not None:
            d = self.first
            raise IntelligenceError(d.reason, rule=d.rule, item_index=d.item_index, evidence=d.evidence)

    def flags(self, quality_flags=()):
        return (*quality_flags, *((DISCARDED,) if self.discarded else ()), *((REPAIRED,) if self.repaired else ()))
