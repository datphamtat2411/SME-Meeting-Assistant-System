"""Infrastructure-free mechanics for the E2E-04 R01 recovery scenario."""

import asyncio
import importlib.util
import json
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
import test_e2e04_recovery_r01 as r01
import test_worker_e2e04 as e2e

ROOT = Path(__file__).resolve().parents[4]
AI_INTEGRATION = ROOT / "services" / "ai" / "tests" / "integration"
_control_spec = importlib.util.spec_from_file_location(
    "e2e04_recovery_control_r01", AI_INTEGRATION / "e2e04_recovery_control.py"
)
_control = importlib.util.module_from_spec(_control_spec)
sys.modules[_control_spec.name] = _control
_control_spec.loader.exec_module(_control)
sys.modules["e2e04_recovery_control"] = _control

Environment = _control.Environment
POST_CLAIM = _control.POST_CLAIM
ControlError = _control.ControlError
ControlAborted = _control.ControlAborted
RecoveryControl = _control.RecoveryControl

_worker_spec = importlib.util.spec_from_file_location(
    "e2e04_worker_process_r01", AI_INTEGRATION / "e2e04_worker_process.py"
)
_worker = importlib.util.module_from_spec(_worker_spec)
sys.modules[_worker_spec.name] = _worker
sys.path.insert(0, str(AI_INTEGRATION))
_worker_spec.loader.exec_module(_worker)


def run(coro):
    return asyncio.run(coro)


def wire():
    event_id = str(uuid4())
    job_id = str(uuid4())
    body = json.dumps({
        "eventId": event_id,
        "processingJobId": job_id,
        "meetingId": str(uuid4()),
        "sourceMediaId": str(uuid4()),
        "requestedByUserId": str(uuid4()),
        "requestId": "r01-unit",
        "schemaVersion": 1,
        "occurredAt": "2026-11-04T00:00:00Z",
    }, separators=(",", ":")).encode()
    return e2e.OutboxWireEvent(
        body=body,
        message_id=event_id,
        event_id=event_id,
        processing_job_id=job_id,
        event_type="PROCESSING_JOB_QUEUED",
        schema_version=1,
        headers=(
            ("eventId", event_id),
            ("eventType", "PROCESSING_JOB_QUEUED"),
            ("spring_listener_return_correlation", str(uuid4())),
            ("spring_returned_message_correlation", event_id),
        ),
        exchange="meeting.processing",
        routing_key="processing.job.queued",
        content_type="application/json",
        delivery_mode=2,
    )


def test_exact_duplicate_preserves_authoritative_body_and_properties():
    source = wire()
    original = e2e._wire_fingerprint(source)

    duplicate = e2e._exact_duplicate_message(source, original)

    assert duplicate.body == source.body
    assert duplicate.message_id == source.event_id == source.message_id
    assert duplicate.headers == dict(source.headers)
    assert e2e._wire_fingerprint(source, message=duplicate) == original


def test_original_spring_correlations_are_validated_and_cloned():
    source = wire()
    outbox = replace(source, headers=source.headers[:2])
    original = _observation_with_headers(source, {**dict(source.headers), "x-delivery-count": 0})
    reconstructed = e2e._with_publisher_headers(outbox, original)
    duplicate = e2e._exact_duplicate_message(reconstructed, original)
    assert duplicate.body == outbox.body
    assert duplicate.message_id == source.event_id
    assert duplicate.headers == dict(source.headers)
    assert "x-delivery-count" not in duplicate.headers
    assert e2e._headers_sha256(duplicate.headers) == e2e._headers_sha256(dict(reversed(source.headers)))


def test_published_outbox_reconstruction_retains_exact_payload_text(monkeypatch):
    source = wire()
    row = {"eventId": source.event_id, "eventType": source.event_type,
           "payload": source.body.decode(), "status": "PUBLISHED"}
    monkeypatch.setattr(e2e, "_psql", lambda *args: json.dumps(row))
    result = e2e._outbox_wire_event({"password": "unused"}, source.processing_job_id)
    assert result.body == source.body
    assert result.message_id == result.event_id == source.event_id
    assert dict(result.headers) == {"eventId": source.event_id, "eventType": source.event_type}


def test_mismatched_message_id_fails_independent_identity_check():
    source = wire()
    with pytest.raises(AssertionError, match="identity"):
        e2e._wire_fingerprint(replace(source, message_id=str(uuid4())))


@pytest.mark.parametrize("change", [
    lambda headers: headers.pop("eventId"),
    lambda headers: headers.pop("eventType"),
    lambda headers: headers.pop("spring_listener_return_correlation"),
    lambda headers: headers.pop("spring_returned_message_correlation"),
    lambda headers: headers.update({"spring_returned_message_correlation": str(uuid4())}),
    lambda headers: headers.update({"spring_listener_return_correlation": "private-secret"}),
    lambda headers: headers.update({"unknown-secret-name": "private-secret-value"}),
])
def test_reconstructed_headers_reject_missing_invalid_and_unknown(change):
    source = wire()
    headers = dict(source.headers)
    change(headers)
    original = _observation_with_headers(source, headers)
    with pytest.raises(AssertionError) as error:
        e2e._with_publisher_headers(replace(source, headers=source.headers[:2]), original)
    assert "private-secret" not in str(error.value)
    assert "unknown-secret-name" not in str(error.value)


def test_duplicate_is_rejected_before_publish_when_any_wire_property_differs():
    source = wire()
    original = e2e._wire_fingerprint(source)
    original["bodySha256"] = "0" * 64

    with pytest.raises(AssertionError, match="wire properties"):
        e2e._exact_duplicate_message(source, original)


def test_header_fingerprint_excludes_only_broker_delivery_count():
    source = wire()
    headers = dict(source.headers)
    expected = e2e._headers_sha256(headers)
    assert e2e._headers_sha256({**headers, "x-delivery-count": 2}) == expected
    assert e2e._headers_sha256({**headers, "unexpected": "secret"}) != expected


def _observation_with_headers(source, headers):
    delivery = SimpleNamespace(
        body=source.body, message_id=source.message_id, headers=headers,
        content_type=source.content_type, delivery_mode=source.delivery_mode,
        exchange=source.exchange, routing_key=source.routing_key,
        delivery_tag=1, redelivered=False, channel=SimpleNamespace(number=1),
    )
    return _worker.message_observation(delivery)


@pytest.mark.parametrize("mutation,field", [
    (lambda headers: headers.pop("eventType"), "eventType"),
    (lambda headers: headers.update({"eventType": "different-secret"}), "eventType"),
    (lambda headers: headers.update({"eventType": b"PROCESSING_JOB_QUEUED"}), "eventType"),
    (lambda headers: headers.update({"unknown-secret-name": "private-secret-value"}), None),
    (lambda headers: headers.update({"x-unknown": 1}), None),
])
def test_header_diagnostics_identify_mismatch_without_disclosing_values(mutation, field):
    source = wire()
    headers = dict(source.headers)
    mutation(headers)
    observed = _observation_with_headers(source, headers)
    for secret in ("different-secret", "private-secret-value", "unknown-secret-name", "x-unknown"):
        assert secret not in json.dumps(observed)
    with pytest.raises(AssertionError, match="wire properties") as error:
        e2e._exact_duplicate_message(source, observed)
    text = str(error.value)
    assert "headers" in text and "expected" in text and "observed" in text
    if field:
        assert field in text
    else:
        assert "nameSha256" in text
    for secret in ("different-secret", "private-secret-value", "unknown-secret-name",
                   "x-unknown", source.event_id):
        assert secret not in text


def test_header_comparison_is_order_independent_and_excludes_only_delivery_count():
    source = wire()
    headers = dict(reversed(source.headers))
    headers["x-delivery-count"] = 3
    observed = _observation_with_headers(source, headers)
    assert e2e._exact_duplicate_message(source, observed).body == source.body
    assert _worker.header_evidence(headers) == _worker.header_evidence(dict(reversed(list(headers.items()))))
    evidence = _worker.header_evidence(headers)
    assert next(item for item in evidence if item.get("name") == "x-delivery-count")["excluded"] is True


def test_header_value_type_difference_is_reported_even_for_python_equal_values():
    expected = _worker.header_evidence({"eventType": 1})
    observed = _worker.header_evidence({"eventType": True})
    details = e2e._header_differences(expected, observed)
    assert details[0]["expected"]["type"] == "int"
    assert details[0]["observed"]["type"] == "bool"
    assert details[0]["expected"]["sha256"] != details[0]["observed"]["sha256"]


def test_header_details_report_presence_and_exclusion():
    expected = _worker.header_evidence({"eventId": "id", "eventType": "type"})
    observed = _worker.header_evidence({"eventId": "id", "x-delivery-count": 0, "extra": "hidden"})
    details = e2e._header_differences(expected, observed)
    missing = next(item for item in details if item.get("name") == "eventType")
    extra = next(item for item in details if "nameSha256" in item)
    broker = next(item for item in details if item.get("name") == "x-delivery-count")
    assert missing["expected"]["present"] and not missing["observed"]["present"]
    assert not extra["expected"]["present"] and extra["observed"]["present"]
    assert broker["excluded"] and broker["observed"]["present"]


def test_aggregate_header_hash_mismatch_remains_fatal_even_with_matching_details():
    source = wire()
    observed = _observation_with_headers(source, dict(source.headers))
    observed["headersSha256"] = "0" * 64
    with pytest.raises(AssertionError, match="headersSha256"):
        e2e._exact_duplicate_message(source, observed)


def test_header_evidence_is_bounded_without_silently_ignoring_fields():
    with pytest.raises(AssertionError, match="header.*limit"):
        _worker.header_evidence({str(index): index for index in range(65)})


def test_delivery_mode_enum_normalization_preserves_value():
    source = wire()
    duplicate = e2e._exact_duplicate_message(source, e2e._wire_fingerprint(source))
    assert e2e._delivery_mode_number(duplicate.delivery_mode) == 2
    assert e2e._wire_fingerprint(source, message=duplicate)["deliveryMode"] == 2


def test_duplicate_publisher_uses_publisher_identity_without_topology_changes(monkeypatch, tmp_path):
    source = wire()
    calls = {}

    class Exchange:
        async def publish(self, message, routing_key, *, mandatory):
            calls["published"] = (message, routing_key, mandatory)
            return object()

    class Channel:
        async def get_exchange(self, name, *, ensure):
            calls["exchange"] = (name, ensure)
            return Exchange()

        def __getattr__(self, name):
            if name.startswith(("declare", "bind", "unbind", "get_queue")):
                raise AssertionError("duplicate publisher must not alter topology")
            raise AttributeError(name)

    class Connection:
        async def channel(self, **kwargs):
            calls["channel"] = kwargs
            return Channel()

        async def close(self):
            calls["closed"] = True

    async def connect(**kwargs):
        calls["connect"] = kwargs
        return Connection()

    monkeypatch.setattr(e2e.aio_pika, "connect", connect)
    monkeypatch.setattr(e2e.ssl, "create_default_context", lambda **_: object())
    credentials = SimpleNamespace(publisher_user="publisher", publisher_password="publisher-secret")
    run(e2e._publish_exact_duplicate(
        {"broker_port": 5671}, credentials, tmp_path, source, e2e._wire_fingerprint(source)))

    assert calls["connect"]["login"] == credentials.publisher_user
    assert calls["connect"]["password"] == credentials.publisher_password
    assert calls["exchange"] == (source.exchange, False)
    assert calls["channel"]["publisher_confirms"] is True
    assert calls["published"][1:] == (source.routing_key, True)
    assert calls["closed"] is True


def test_publisher_and_worker_permissions_remain_separate():
    definitions = e2e.broker.definitions(
        "sme-integration", {"publisher": "publisher", "worker": "worker", "reconciler": "reconciler"})
    permissions = {item["user"]: item for item in definitions["permissions"]}

    assert permissions["publisher"]["write"] == r"^meeting\.processing$"
    assert permissions["publisher"]["read"] == "^$"
    assert permissions["worker"]["write"] == "^$"
    assert permissions["worker"]["read"] == r"^meeting\.processing\.jobs$"


def test_post_claim_owner_stays_held_while_competing_delivery_attempts():
    async def exercise():
        with RecoveryControl.parent(Environment.TEST, timeout=0.5) as parent:
            child = RecoveryControl.child(Environment.TEST, parent.environment)
            parent.arm(POST_CLAIM)
            owner = asyncio.create_task(child.checkpoint(POST_CLAIM, event_id=str(uuid4())))
            await asyncio.to_thread(parent.wait_for_checkpoint, POST_CLAIM)
            competing_attempt = asyncio.create_task(asyncio.sleep(0))
            await competing_attempt
            assert not owner.done()
            parent.release(POST_CLAIM)
            await asyncio.wait_for(owner, timeout=0.5)
            await child.close()

    run(exercise())


def test_checkpoint_release_is_one_shot_and_bounded():
    async def exercise():
        with RecoveryControl.parent(Environment.TEST, timeout=0.2) as parent:
            child = RecoveryControl.child(Environment.TEST, parent.environment, timeout=0.05)
            parent.arm(POST_CLAIM)
            blocked = asyncio.create_task(child.checkpoint(POST_CLAIM))
            await asyncio.to_thread(parent.wait_for_checkpoint, POST_CLAIM)
            parent.release(POST_CLAIM)
            await blocked
            with pytest.raises(ControlError, match="one-shot|active"):
                parent.release(POST_CLAIM)
            await child.checkpoint(POST_CLAIM)
            await child.close()

    run(exercise())


def test_claim_observation_reports_actual_busy_or_status_without_fabrication():
    event = SimpleNamespace(eventId=str(uuid4()), processingJobId=str(uuid4()))
    busy = _worker.claim_observation(
        event, 2, error=_worker.CoreError(409, "WORKER_ATTEMPT_BUSY"))
    status = _worker.claim_observation(
        event, 3, result=SimpleNamespace(state="RUNNING"))

    assert busy["outcome"] == "error"
    assert busy["status"] == 409
    assert busy["code"] == "WORKER_ATTEMPT_BUSY"
    assert status["outcome"] == "status"
    assert status["state"] == "RUNNING"
    with pytest.raises(ValueError, match="claim response"):
        _worker.claim_observation(event, 4)


def test_claim_observation_is_correlated_to_current_delivery():
    event = SimpleNamespace(eventId=str(uuid4()), processingJobId=str(uuid4()))
    token = _worker._delivery_context.set({"channel": 3, "deliveryTag": 7, "deliveryCount": 2})
    try:
        observed = _worker.claim_observation(event, 2, error=_worker.CoreError(409, "WORKER_ATTEMPT_BUSY"))
    finally:
        _worker._delivery_context.reset(token)
    assert (observed["channel"], observed["deliveryTag"], observed["deliveryCount"]) == (3, 7, 2)


def test_delivery_a_and_b_have_independent_sanitized_correlation():
    source = wire()

    class Delivery:
        body = source.body
        message_id = source.message_id
        headers = dict(source.headers)
        content_type = source.content_type
        delivery_mode = source.delivery_mode
        exchange = source.exchange
        routing_key = source.routing_key
        channel = SimpleNamespace(number=11)

        def __init__(self, tag, redelivered):
            self.delivery_tag = tag
            self.redelivered = redelivered

    first = _worker.message_observation(Delivery(31, False))
    second = _worker.message_observation(Delivery(32, False))

    assert first["eventId"] == second["eventId"] == source.event_id
    assert first["processingJobId"] == second["processingJobId"] == source.processing_job_id
    assert first["deliveryTag"] == 31
    assert second["deliveryTag"] == 32
    assert first["deliveryTag"] != second["deliveryTag"]
    assert first["contentType"] == "application/json"
    assert e2e._exact_duplicate_message(source, first).body == source.body


def test_mismatch_diagnostics_are_bounded_and_sanitized():
    source = wire()
    original = e2e._wire_fingerprint(source)
    original["messageId"] = "authorization-secret"
    del original["contentType"]
    with pytest.raises(AssertionError) as error:
        e2e._exact_duplicate_message(source, original)
    diagnostic = str(error.value)
    assert "messageId" in diagnostic and "contentType" in diagnostic
    assert "missing" in diagnostic and "sha256" in diagnostic
    assert "authorization-secret" not in diagnostic
    assert source.event_id not in diagnostic and source.body.decode() not in diagnostic


@pytest.mark.parametrize("failure", [False, True])
def test_admission_closed_on_owning_live_loop_even_on_wire_failure(failure):
    class Admission:
        async def use(self):
            self.loop = asyncio.get_running_loop()

        async def close(self):
            assert asyncio.get_running_loop() is self.loop
            assert not self.loop.is_closed()
            self.closed = True

    admission = Admission()

    async def exercise():
        await admission.use()
        if failure:
            original = e2e._wire_fingerprint(wire())
            original["messageId"] = "wrong"
            e2e._exact_duplicate_message(wire(), original)
        return "done"

    if failure:
        with pytest.raises(AssertionError, match="wire properties"):
            run(r01._with_admission(admission, exercise))
    else:
        assert run(r01._with_admission(admission, exercise)) == "done"
    assert admission.closed


def test_ack_nack_and_reject_observations_are_safe_and_complete():
    async def exercise():
        event_id = str(uuid4())
        with RecoveryControl.parent(Environment.TEST, timeout=0.5) as parent:
            child = RecoveryControl.child(Environment.TEST, parent.environment)
            for action in ("ack", "nack", "reject"):
                for phase in ("invoked", "client_completed"):
                    await child.observe_delivery(
                        event_id=event_id, delivery_tag=9, channel=4, redelivered=True,
                        action=action, phase=phase)
            observations = parent.observations()
            assert {(item["action"], item["phase"]) for item in observations} == {
                (action, phase) for action in ("ack", "nack", "reject")
                for phase in ("invoked", "client_completed")
            }
            await child.close()

    run(exercise())


def _settlement_fixture():
    original = {"eventId": "event-a", "channel": 4, "deliveryTag": 31}
    duplicate = {"eventId": "event-a", "channel": 4, "deliveryTag": 32}

    def operation(delivery, action, phase, redelivered=False):
        return {**delivery, "redelivered": redelivered, "action": action, "phase": phase}

    final = {"eventId": "event-a", "channel": 4, "deliveryTag": 33}
    observations = [
        {"checkpoint": POST_CLAIM, "eventId": "event-a", "status": "activated"},
        operation(duplicate, "nack", "invoked"),
        operation(duplicate, "nack", "client_completed"),
        {"checkpoint": POST_CLAIM, "status": "released"},
        operation(final, "reject", "invoked", True),
        operation(final, "reject", "client_completed", True),
        operation(original, "ack", "invoked"),
        operation(original, "ack", "client_completed"),
    ]
    return observations, original, duplicate, observations[5], [{**final, "redelivered": True}]


def test_mixed_checkpoint_and_settlement_observations_are_classified():
    observations, original, duplicate, final, deliveries = _settlement_fixture()
    settlements = r01._assert_settlements(observations, "event-a", original, duplicate, final, deliveries)
    assert len(settlements) == 6
    assert all("checkpoint" not in item for item in settlements)


def test_redelivered_duplicate_can_finish_with_correlated_ack():
    observations, original, duplicate, final, deliveries = _settlement_fixture()
    observations[4]["action"] = final["action"] = "ack"
    r01._assert_settlements(observations, "event-a", original, duplicate, final, deliveries)


@pytest.mark.parametrize("change,match", [
    (lambda record: record.pop("action"), "action"),
    (lambda record: record.update(action="unknown"), "action"),
    (lambda record: record.update(phase="unknown"), "phase"),
    (lambda record: record.pop("deliveryTag"), "delivery"),
])
def test_malformed_settlement_fails_explicitly(change, match):
    observations, original, duplicate, final, deliveries = _settlement_fixture()
    change(observations[1])
    with pytest.raises(AssertionError, match=match):
        r01._assert_settlements(observations, "event-a", original, duplicate, final, deliveries)


@pytest.mark.parametrize("remove", [2, 4, 5, 6, 7])
def test_missing_correlated_settlement_phase_fails(remove):
    observations, original, duplicate, final, deliveries = _settlement_fixture()
    del observations[remove]
    with pytest.raises(AssertionError, match="settlement|ACK|NACK|disposition"):
        r01._assert_settlements(observations, "event-a", original, duplicate, final, deliveries)


@pytest.mark.parametrize("index,field,value", [
    (2, "deliveryTag", 99), (2, "channel", 5), (2, "eventId", "event-b"),
    (4, "deliveryTag", 99), (4, "channel", 5), (4, "eventId", "event-b"),
    (7, "deliveryTag", 99), (7, "channel", 5), (7, "eventId", "event-b"),
])
def test_unrelated_delivery_evidence_cannot_satisfy_settlement(index, field, value):
    observations, original, duplicate, final, deliveries = _settlement_fixture()
    observations[index][field] = value
    with pytest.raises(AssertionError, match="settlement|ACK|NACK|disposition"):
        r01._assert_settlements(observations, "event-a", original, duplicate, final, deliveries)


@pytest.mark.parametrize("field,value", [
    ("claimCount", 2), ("acceptedReceiptCount", 0), ("receiptCount", 2),
    ("failureReceiptCount", 1), ("canonicalTranscriptCount", 2), ("transcriptCount", 2),
    ("receiptToTranscriptCount", 0), ("contradictoryTerminalCount", 1),
])
def test_r01_cardinality_evaluation_requires_one_accepted_effect(field, value):
    evidence = {
        "claimCount": 1,
        "acceptedReceiptCount": 1,
        "failureReceiptCount": 0,
        "receiptCount": 1,
        "canonicalTranscriptCount": 1,
        "transcriptCount": 1,
        "receiptToTranscriptCount": 1,
        "resultCount": 1,
        "generation": 0,
        "reconciliationDispositions": [],
    }
    e2e._assert_r01_evidence(evidence)

    evidence[field] = value
    with pytest.raises(AssertionError, match="cardinality"):
        e2e._assert_r01_evidence(evidence)


def _reconciliation(disposition="TERMINAL", **changes):
    record = {"eventId": "event-a", "processingJobId": "job-a", "disposition": disposition,
              "generation": 0, "currentGeneration": 0, "receiptId": "receipt-a",
              "receiptEventId": "event-a", "receiptOutcome": "RESULT_ACCEPTED",
              "recordedAt": "t1", "checkedAt": "t2"}
    record.update(changes)
    return record


@pytest.fixture
def reconciliation_clock(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(r01.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(r01.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    return clock


@pytest.mark.parametrize("record", [
    _reconciliation(),
    _reconciliation(receiptEventId="covering-event"),
    _reconciliation("SUPERSEDED", receiptId=None, receiptEventId=None, receiptOutcome=None,
                    currentGeneration=1),
])
def test_reconciliation_requires_bound_durable_terminal_evidence(record):
    assert r01._reconciliation_terminal(record, "job-a", "event-a")


@pytest.mark.parametrize("record", [
    None, _reconciliation("DEFERRED"), _reconciliation("OPERATOR_REVIEW"),
    _reconciliation("EXHAUSTED"), _reconciliation("UNKNOWN"),
    _reconciliation(eventId="wrong-event"), _reconciliation(processingJobId="wrong-job"),
    _reconciliation(receiptId=None),
    _reconciliation("SUPERSEDED", receiptId=None, currentGeneration=0),
])
def test_unresolved_or_wrong_reconciliation_never_passes(record):
    assert not r01._reconciliation_terminal(record, "job-a", "event-a")


def test_reconciliation_poll_observes_committed_transition(monkeypatch, reconciliation_clock):
    states = iter([_reconciliation("DEFERRED"), _reconciliation()])
    monkeypatch.setattr(r01, "_reconciliation", lambda *args: next(states))
    record, transitions = r01._wait_for_reconciliation({}, "job-a", "event-a", required=True,
                                                        timeout=2, interval=1)
    assert record["disposition"] == "TERMINAL"
    assert [item["disposition"] for item in transitions] == ["DEFERRED", "TERMINAL"]
    assert reconciliation_clock[0] == 1


@pytest.mark.parametrize("record", [None, _reconciliation("DEFERRED"),
                                    _reconciliation(eventId="wrong-event")])
def test_reconciliation_poll_fails_closed_with_last_safe_state(monkeypatch, reconciliation_clock, record):
    monkeypatch.setattr(r01, "_reconciliation", lambda *args: record)
    with pytest.raises(AssertionError, match="reconciliation") as error:
        r01._wait_for_reconciliation({}, "job-a", "event-a", required=True, timeout=2, interval=1)
    assert reconciliation_clock[0] == 2
    assert ("DEFERRED" if record and record["disposition"] == "DEFERRED" else
            "wrong-event" if record else "null") in str(error.value)


def test_broker_settlement_does_not_replace_required_reconciliation(monkeypatch, reconciliation_clock):
    monkeypatch.setattr(r01, "_reconciliation", lambda *args: None)
    with pytest.raises(AssertionError, match="reconciliation"):
        r01._wait_for_reconciliation({}, "job-a", "event-a", required=True, timeout=1, interval=1)
    assert r01._wait_for_reconciliation({}, "job-a", "event-a", required=False)[0] is None


def test_reconciliation_lookup_is_scoped_to_job_and_event(monkeypatch):
    event, job = str(uuid4()), str(uuid4())
    captured = []
    monkeypatch.setattr(e2e, "_psql", lambda db, password, sql: captured.append(sql) or "null")
    assert r01._reconciliation({"password": "unused"}, job, event) is None
    assert f"r.event_id='{event}'::uuid" in captured[0]
    assert f"r.processing_job_id='{job}'::uuid" in captured[0]


def test_delivery_identity_includes_channel_and_tag():
    original = {"channel": 1, "deliveryTag": 1}
    assert not r01._same_delivery(original, {"channel": 2, "deliveryTag": 1})
    assert r01._same_delivery(original, {"channel": 1, "deliveryTag": 1})


def test_bounded_log_wait_has_sanitized_timeout():
    with pytest.raises(AssertionError, match="timed out") as error:
        e2e._wait_for_log_record(
            Path("/tmp/r01-missing-log"), "E2E04_CLAIM", lambda _: True,
            timeout=0.01, interval=0.001)
    assert "secret" not in str(error.value).lower()


def test_message_diagnostic_contains_digest_not_body():
    source = wire()
    secret = b"raw transcript and claim-token-secret"

    class Delivery:
        body = source.body + secret
        message_id = source.message_id
        headers = dict(source.headers)
        content_type = source.content_type
        delivery_mode = source.delivery_mode
        exchange = source.exchange
        routing_key = source.routing_key
        delivery_tag = 4
        redelivered = False
        channel = SimpleNamespace(number=8)

    output = _worker.message_observation(Delivery())

    serialized = json.dumps(output)
    assert secret.decode() not in serialized
    assert output["bodySha256"]
    assert output["eventId"] == "invalid"


def test_missing_body_identity_never_falls_back_to_message_id():
    source = wire()
    payload = json.loads(source.body)
    del payload["eventId"]
    delivery = SimpleNamespace(
        body=json.dumps(payload).encode(), message_id=source.message_id,
        headers=dict(source.headers), content_type=source.content_type,
        delivery_mode=source.delivery_mode, exchange=source.exchange, routing_key=source.routing_key,
        delivery_tag=1, redelivered=False, channel=SimpleNamespace(number=1),
    )
    observed = _worker.message_observation(delivery)
    assert observed["eventId"] == "invalid"
    with pytest.raises(AssertionError, match="wire properties"):
        e2e._exact_duplicate_message(source, observed)


def test_control_cleanup_after_interrupted_checkpoint():
    async def exercise():
        parent = RecoveryControl.parent(Environment.TEST, timeout=0.2)
        child = RecoveryControl.child(Environment.TEST, parent.environment)
        parent.arm(POST_CLAIM)
        task = asyncio.create_task(child.checkpoint(POST_CLAIM))
        await asyncio.to_thread(parent.wait_for_checkpoint, POST_CLAIM)
        parent.abort()
        with pytest.raises(ControlAborted):
            await asyncio.wait_for(task, timeout=0.5)
        await child.close()
        path = Path(parent.environment["AI_E2E04_CONTROL_SOCKET"])
        parent.close()
        assert not path.exists()

    run(exercise())
