"""Opt-in, context-local engine observations for private human review only.

Never attach this transient, proposal-bearing object to canonical results, logs,
exceptions or worker/Core payloads. Index decisions are recorded only after both
integrity gates pass; a failed validation has no accepted per-edit decisions.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import StrEnum

from .correction_v6 import V6CorrectionProposal


class _AcceptanceBasis(StrEnum):
    INJURY_CONTEXT = "injury_context"


@dataclass(slots=True)
class _EditReview:
    proposal: V6CorrectionProposal | None = field(default=None, repr=False)
    rejection_reasons: tuple[str | None, ...] | None = None
    validated: bool = False
    acceptance_bases: dict[int, _AcceptanceBasis] = field(default_factory=dict, repr=False)
    evidence_segment_ids: dict[int, tuple[str, ...]] = field(default_factory=dict, repr=False)


_REVIEW: ContextVar[_EditReview | None] = ContextVar("private_correction_edit_review", default=None)


@contextmanager
def _capture_edit_review():
    review = _EditReview()
    token = _REVIEW.set(review)
    try:
        yield review
    finally:
        if not review.validated:
            review.acceptance_bases.clear()
            review.evidence_segment_ids.clear()
        _REVIEW.reset(token)


def _begin_edit_review(proposal: V6CorrectionProposal) -> None:
    if (review := _REVIEW.get()) is not None:
        review.proposal = proposal
        review.rejection_reasons = None
        review.validated = False
        review.acceptance_bases.clear()
        review.evidence_segment_ids.clear()


def _mark_context_acceptance(index: int, evidence_segment_ids: tuple[str, ...]) -> None:
    if (review := _REVIEW.get()) is not None:
        review.acceptance_bases[index] = _AcceptanceBasis.INJURY_CONTEXT
        review.evidence_segment_ids[index] = evidence_segment_ids


def _finish_edit_review(count: int, rejected: dict[int, str]) -> None:
    if (review := _REVIEW.get()) is not None:
        review.rejection_reasons = tuple(rejected.get(index) for index in range(count))
        review.validated = True
