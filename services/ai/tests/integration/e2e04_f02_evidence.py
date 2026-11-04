"""Test-only invalid intermediate input; production correction validation is unchanged."""

from contextlib import contextmanager
from dataclasses import replace
from unittest.mock import patch

from e2e04_recovery_faults import emit, execution_binding

from sme_meeting_ai.core.config import Environment
from sme_meeting_ai.transcription import correction


class ForbiddenCorrectionProvider:
    def complete(self, request):
        emit("E2E04_F02_PROVIDER", phase="unexpected_call", **execution_binding.get())
        raise AssertionError("invalid handoff reached correction provider")


@contextmanager
def invalid_correction_handoff(environment):
    """Copy a valid handoff with inconsistent sample identity, then call the real entry."""
    if environment is not Environment.TEST:
        raise ValueError("F02 evidence injection requires test environment")
    original = correction.correct_transcript

    def invalid_input(reconciliation, coverage, provider, settings):
        if reconciliation.sample_count != coverage.sample_count:
            raise AssertionError("F02 requires an initially valid handoff")
        invalid = replace(reconciliation, sample_count=reconciliation.sample_count + 1)
        emit("E2E04_F02_FAULT", boundary="correction_handoff", invariant="sample_identity",
             originalSampleCount=reconciliation.sample_count, invalidSampleCount=invalid.sample_count,
             coverageSampleCount=coverage.sample_count, **execution_binding.get())
        # No fake exception/outcome: the original _handoff rejects these inputs.
        return original(invalid, coverage, provider, settings)

    with patch.object(correction, "correct_transcript", invalid_input):
        yield
