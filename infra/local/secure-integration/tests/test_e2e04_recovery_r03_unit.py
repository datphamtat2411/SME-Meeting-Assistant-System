"""R03 independently requires a killed original and actual redelivered ACK."""

import pytest
from e2e04_recovery_support import assert_redelivery_ack


def ack(redelivered, operation, receipt="receipt-a"):
    return {"eventId": "event-a", "deliveryTag": 1, "channel": 1,
            "redelivered": redelivered, "operation": operation,
            "terminal": {"state": "RESULT_ACCEPTED", "receiptId": receipt}}


def test_pre_ack_termination_is_distinct_from_completed_ack():
    assert_redelivery_ack([ack(False, "invoked")],
                          [ack(True, "invoked"), ack(True, "client_completed")],
                          "event-a", "receipt-a")


@pytest.mark.parametrize("first,second", [
    ([ack(False, "invoked"), ack(False, "client_completed")],
     [ack(True, "invoked"), ack(True, "client_completed")]),
    ([ack(False, "invoked")], [ack(False, "invoked"), ack(False, "client_completed")]),
    ([ack(False, "invoked")], [ack(True, "invoked")]),
    ([ack(False, "invoked")], [ack(True, "invoked", "other"), ack(True, "client_completed", "other")]),
])
def test_missing_or_contradictory_redelivery_evidence_fails(first, second):
    with pytest.raises(AssertionError):
        assert_redelivery_ack(first, second, "event-a", "receipt-a")
