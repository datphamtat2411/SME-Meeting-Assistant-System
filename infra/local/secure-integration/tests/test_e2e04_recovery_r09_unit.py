"""R09 overlap proof cannot be replaced by merely starting two processes."""

import pytest
from e2e04_recovery_support import assert_claim_overlap


def test_two_distinct_real_database_waiters_prove_overlapping_claims():
    assert_claim_overlap([{"pid": 101, "rootBlocker": 99, "waitEventType": "Lock"},
                          {"pid": 102, "rootBlocker": 99, "waitEventType": "Lock"}], 99)


@pytest.mark.parametrize("waiters", [
    [], [{"pid": 101, "rootBlocker": 99, "waitEventType": "Lock"}],
    [{"pid": 101, "rootBlocker": 99, "waitEventType": "Lock"}] * 2,
    [{"pid": 101, "rootBlocker": 98, "waitEventType": "Lock"},
     {"pid": 102, "rootBlocker": 99, "waitEventType": "Lock"}],
    [{"pid": 101, "rootBlocker": 99, "waitEventType": "Client"},
     {"pid": 102, "rootBlocker": 99, "waitEventType": "Lock"}],
])
def test_missing_unrelated_or_duplicate_waiter_is_not_concurrency_proof(waiters):
    with pytest.raises(AssertionError):
        assert_claim_overlap(waiters, 99)
