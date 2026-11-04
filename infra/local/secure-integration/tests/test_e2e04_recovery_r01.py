"""Opt-in real E2E-04 R01 duplicate-publication recovery acceptance."""

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from uuid import UUID

import pytest
import test_worker_e2e04 as e2e

ROOT = Path(__file__).resolve().parents[4]
AI_INTEGRATION = ROOT / "services" / "ai" / "tests" / "integration"
sys.path.insert(0, str(AI_INTEGRATION))
from e2e04_recovery_control import POST_CLAIM, Environment, RecoveryControl  # noqa: E402

services = e2e.services
storage_boundary = e2e.storage_boundary
postgres = e2e.postgres

pytestmark = [pytest.mark.live_infrastructure, pytest.mark.skipif(
    os.environ.get("RUN_WORKER_REAL_ACCEPTANCE") != "1",
    reason="Explicit isolated R01 Level A E2E-04 opt-in is required")]


def _claim_state(database, event_id):
    event_id = str(event_id)
    raw = e2e._psql(database, database["password"], f"""
        SELECT json_build_object(
            'eventId', d.event_id,
            'processingJobId', d.processing_job_id,
            'generation', d.generation,
            'claimCount', (SELECT count(*) FROM transcription_worker_claims WHERE event_id=d.event_id),
            'claimStageRunId', c.execution_stage_run_id,
            'stageStatus', s.status,
            'live', COALESCE(s.status='RUNNING' AND s.lease_expires_at > clock_timestamp(), false)
        )
        FROM transcription_worker_deliveries d
        LEFT JOIN transcription_worker_claims c ON c.event_id=d.event_id
        LEFT JOIN processing_stage_runs s ON s.id=c.execution_stage_run_id
        WHERE d.event_id='{event_id}'::uuid
    """)
    if not raw:
        raise AssertionError("R01 claim evidence was not found")
    return json.loads(raw)


def _r01_evidence(database, job_id, event_id):
    job_id = str(job_id)
    event_id = str(event_id)
    raw = e2e._psql(database, database["password"], f"""
        SELECT json_build_object(
            'eventId', d.event_id,
            'processingJobId', p.id,
            'generation', d.generation,
            'jobStatus', p.status,
            'claimCount', (SELECT count(*) FROM transcription_worker_claims WHERE event_id=d.event_id),
            'claimStageRunId', (SELECT execution_stage_run_id FROM transcription_worker_claims WHERE event_id=d.event_id),
            'producerStageRunId', (SELECT producer_stage_run_id FROM transcription_worker_receipts
                                   WHERE processing_job_id=p.id AND outcome='RESULT_ACCEPTED'),
            'receiptCount', (SELECT count(*) FROM transcription_worker_receipts WHERE processing_job_id=p.id),
            'acceptedReceiptCount', (SELECT count(*) FROM transcription_worker_receipts
                                     WHERE processing_job_id=p.id AND outcome='RESULT_ACCEPTED'),
            'failureReceiptCount', (SELECT count(*) FROM transcription_worker_receipts
                                    WHERE processing_job_id=p.id AND outcome='FAILURE_RECORDED'),
            'contradictoryTerminalCount', CASE WHEN
                (SELECT count(*) FROM transcription_worker_receipts WHERE processing_job_id=p.id AND outcome='RESULT_ACCEPTED') > 0
                AND (SELECT count(*) FROM transcription_worker_receipts WHERE processing_job_id=p.id AND outcome='FAILURE_RECORDED') > 0
                THEN 1 ELSE 0 END,
            'canonicalTranscriptCount', (SELECT count(*) FROM transcripts
                                         WHERE processing_job_id=p.id AND is_current),
            'transcriptCount', (SELECT count(*) FROM transcripts WHERE processing_job_id=p.id),
            'receiptToTranscriptCount', (SELECT count(*) FROM transcription_worker_receipts r
                                         JOIN transcripts t ON t.id=r.transcript_id AND t.processing_job_id=r.processing_job_id
                                         WHERE r.processing_job_id=p.id AND r.outcome='RESULT_ACCEPTED'),
            'resultCount', (SELECT count(*) FROM transcription_worker_results WHERE processing_job_id=p.id),
            'resultSha256', (SELECT result_sha256 FROM transcription_worker_results
                             WHERE processing_job_id=p.id ORDER BY verified_at LIMIT 1),
            'correctionSha256', (SELECT correction_sha256 FROM transcription_worker_results
                                 WHERE processing_job_id=p.id ORDER BY verified_at LIMIT 1),
            'sourceSha256', m.sha256,
            'sourceRevision', m.sha256,
            'sourceObjectKey', m.object_key,
            'receiptId', (SELECT receipt_id FROM transcription_worker_receipts
                          WHERE processing_job_id=p.id AND outcome='RESULT_ACCEPTED'),
            'transcriptId', (SELECT transcript_id FROM transcription_worker_receipts
                             WHERE processing_job_id=p.id AND outcome='RESULT_ACCEPTED'),
            'transcriptStatus', (SELECT transcript_status FROM transcription_worker_receipts
                                 WHERE processing_job_id=p.id AND outcome='RESULT_ACCEPTED'),
            'outboxStatus', (SELECT status FROM outbox_events WHERE id=d.event_id),
            'reconciliationDispositions', COALESCE((SELECT json_agg(disposition ORDER BY checked_at)
                                                     FROM transcription_worker_reconciliations
                                                     WHERE event_id=d.event_id), '[]'::json),
            'stages', COALESCE((SELECT json_agg(json_build_object('id', s.id, 'code', s.stage_code,
                                      'status', s.status) ORDER BY s.created_at, s.id)
                                FROM processing_stage_runs s WHERE s.processing_job_id=p.id), '[]'::json)
        )
        FROM processing_jobs p
        JOIN transcription_worker_deliveries d ON d.processing_job_id=p.id AND d.event_id='{event_id}'::uuid
        JOIN meeting_media m ON m.id=p.source_media_id
        WHERE p.id='{job_id}'::uuid
    """)
    if not raw:
        raise AssertionError("R01 durable evidence was not found")
    return json.loads(raw)


def _reconciliation(database, job_id, event_id):
    job_id, event_id = str(UUID(str(job_id))), str(UUID(str(event_id)))
    raw = e2e._psql(database, database["password"], f"""
        SELECT COALESCE((SELECT json_build_object(
            'eventId', r.event_id, 'processingJobId', r.processing_job_id,
            'disposition', r.disposition, 'generation', d.generation,
            'currentGeneration', p.retry_count, 'recordedAt', r.recorded_at,
            'checkedAt', r.checked_at, 'receiptId', receipt.receipt_id,
            'receiptEventId', receipt.event_id, 'receiptOutcome', receipt.outcome,
            'errorCode', receipt.error_code, 'retryable', receipt.retryable,
            'retryExhausted', receipt.retry_exhausted)
          FROM transcription_worker_reconciliations r
          JOIN transcription_worker_deliveries d ON d.event_id=r.event_id AND d.processing_job_id=r.processing_job_id
          JOIN processing_jobs p ON p.id=r.processing_job_id
          LEFT JOIN LATERAL (SELECT x.* FROM transcription_worker_receipts x
              WHERE x.processing_job_id=r.processing_job_id
                AND (x.event_id=r.event_id OR x.outcome='RESULT_ACCEPTED')
              ORDER BY (x.event_id=r.event_id) DESC LIMIT 1) receipt ON true
          WHERE r.event_id='{event_id}'::uuid AND r.processing_job_id='{job_id}'::uuid), 'null'::json)
    """)
    return json.loads(raw)


def _reconciliation_terminal(record, job_id, event_id):
    if not record or record.get("eventId") != event_id or record.get("processingJobId") != job_id:
        return False
    receipt = (bool(record.get("receiptId")) and
               (record.get("receiptEventId") == event_id or
                record.get("receiptOutcome") == "RESULT_ACCEPTED"))
    if record.get("disposition") == "TERMINAL":
        return receipt
    if record.get("disposition") == "SUPERSEDED":
        generation, current = record.get("generation"), record.get("currentGeneration")
        return receipt or (type(generation) is int and type(current) is int and current > generation)
    return False


def _wait_for_reconciliation(database, job_id, event_id, *, required, timeout=75, interval=0.5):
    deadline = time.monotonic() + timeout
    transitions = []
    while True:
        record = _reconciliation(database, job_id, event_id)
        if not transitions or transitions[-1] != record:
            transitions.append(record)
        if record is None and not required:
            return record, transitions
        if _reconciliation_terminal(record, job_id, event_id):
            return record, transitions
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError("R01 reconciliation did not reach a durable terminal state: " +
                                 json.dumps({"last": record, "observations": transitions[-20:]},
                                            separators=(",", ":")))
        time.sleep(min(interval, remaining))


def _same_delivery(first, second):
    return (first.get("channel"), first.get("deliveryTag")) == (second.get("channel"), second.get("deliveryTag"))


def _assert_settlements(observations, event_id, original, duplicate, final, deliveries):
    settlements = []
    for item in observations:
        if "checkpoint" in item:
            assert not any(field in item for field in ("action", "phase", "deliveryTag", "channel")), (
                "malformed checkpoint observation")
            continue
        assert item.get("action") in ("ack", "nack", "reject"), "invalid settlement action"
        assert item.get("phase") in ("invoked", "client_completed"), "invalid settlement phase"
        assert (isinstance(item.get("eventId"), str) and item["eventId"]
                and type(item.get("deliveryTag")) is int and item["deliveryTag"] > 0
                and ((type(item.get("channel")) is int and item["channel"] > 0)
                     or (type(item.get("channel")) is str and item["channel"]))
                and type(item.get("redelivered")) is bool), "invalid settlement delivery identity"
        settlements.append(item)

    assert original.get("eventId") == duplicate.get("eventId") == final.get("eventId") == event_id
    assert not _same_delivery(original, duplicate) and not _same_delivery(original, final)
    assert final.get("action") in ("ack", "reject") and final.get("phase") == "client_completed"
    assert any(item.get("eventId") == event_id and item.get("redelivered") is True
               and _same_delivery(item, final) for item in deliveries), "missing redelivery for final disposition"

    def paired(delivery, action):
        matching = [item["phase"] for item in settlements if item["eventId"] == event_id
                    and _same_delivery(item, delivery) and item["action"] == action]
        return "invoked" in matching and "client_completed" in matching[matching.index("invoked") + 1:]

    assert paired(original, "ack"), "original ACK settlement incomplete"
    assert paired(duplicate, "nack"), "duplicate NACK settlement incomplete"
    assert paired(final, final["action"]), "duplicate final disposition settlement incomplete"
    return settlements


def _broker_evidence(container):
    queues = e2e.broker.inspect(container, "sme-integration")
    work = next(queue for queue in queues if queue["name"] == e2e.broker.WORK)
    dead = next(queue for queue in queues if queue["name"] == e2e.broker.DEAD)
    return {
        "work": {field: work.get(field, 0) for field in (
            "messages", "messages_ready", "messages_unacknowledged", "consumers", "retained_dead_letters")},
        "dead": {field: dead.get(field, 0) for field in (
            "messages", "messages_ready", "messages_unacknowledged", "consumers")},
    }


def _wait_for_duplicate_settlement(parent, event_id, original, *, timeout=45):
    deadline = time.monotonic() + timeout
    while True:
        for item in parent.observations():
            if (item.get("eventId") == event_id and not _same_delivery(item, original)
                    and item.get("phase") == "client_completed"
                    and item.get("action") in ("ack", "reject")):
                return item
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError("duplicate delivery did not reach a terminal broker operation")
        time.sleep(min(0.1, remaining))


def _delivery_summary(item):
    return {field: item[field] for field in (
        "eventId", "processingJobId", "deliveryTag", "channel", "redelivered", "deliveryCount",
        "messageId", "bodySha256", "headerEventId", "headerEventType", "eventType",
        "schemaVersion", "exchange", "routingKey", "contentType", "deliveryMode")}


async def _with_admission(admission, exercise):
    try:
        result = await exercise()
    except BaseException as error:
        try:
            await asyncio.wait_for(admission.close(), timeout=20)
        except Exception:
            error.add_note("Admission client cleanup failed or timed out")
        raise
    await asyncio.wait_for(admission.close(), timeout=20)
    return result


def test_real_r01_duplicate_publication_recovery(services, storage_boundary, postgres, tmp_path):
    service_settings, pki, names = services
    boundary_settings, boundary_pki, topology = storage_boundary
    assert pki == boundary_pki
    assert topology["backend"]
    transport_settings = {
        "broker_port": e2e._docker_port(names[0], "5671/tcp"),
        "endpoint": boundary_settings.s3_endpoint_url,
        "bucket": boundary_settings.s3_bucket,
        "names": names,
        "root_secret": service_settings.s3_secret_access_key.get_secret_value(),
    }
    credentials = e2e._application_credentials(transport_settings, pki)
    worker = worker_log = None
    admission = None
    checkpoint_active = False
    with e2e._ai_process(tmp_path, pki) as ai_url, e2e._core_process(
            tmp_path, postgres, transport_settings, credentials, pki, ai_url) as core:
        email, password = e2e._seed_user(postgres, core)
        with RecoveryControl.parent(Environment.TEST, timeout=20) as parent:
            parent.arm(POST_CLAIM)
            job_id = event_id = None
            checkpoint_observation = {"activated": False, "released": False}
            try:
                worker, worker_log = e2e._start_worker(
                    tmp_path, postgres, transport_settings, credentials, core, pki,
                    control_environment=parent.environment, worker_concurrency=2)
                admission = e2e.CoreAdmission(
                    type("Settings", (), {"s3_ca_file": pki / "ca.crt"})(),
                    public_url=core.public_url, email=email, password=password)

                async def exercise():
                    nonlocal checkpoint_active, job_id, event_id
                    audio = e2e.synthetic_wav()
                    meeting_id, media_id, job_id = await admission.admit(audio)
                    activation = await asyncio.to_thread(
                        parent.wait_for_checkpoint, POST_CLAIM, timeout=20)
                    checkpoint_active = True
                    checkpoint_observation["activated"] = True
                    event_id = activation["eventId"]
                    wire = e2e._outbox_wire_event(postgres, job_id)
                    assert event_id == wire.event_id
                    original = e2e._wait_for_log_record(
                        tmp_path / "worker.log", "E2E04_MESSAGE ",
                        lambda record: record.get("eventId") == event_id and not record.get("redelivered"),
                        timeout=20)
                    wire = e2e._with_publisher_headers(wire, original)
                    assert original["processingJobId"] == job_id
                    claim = _claim_state(postgres, event_id)
                    assert claim["claimCount"] == 1 and claim["live"] is True
                    assert claim["generation"] == 0

                    published = await e2e._publish_exact_duplicate(
                        transport_settings, credentials, pki, wire, original)
                    assert published == e2e._wire_fingerprint(wire)
                    duplicate = await asyncio.to_thread(
                        e2e._wait_for_log_record,
                        tmp_path / "worker.log", "E2E04_MESSAGE ",
                        lambda record: record.get("eventId") == event_id
                        and not _same_delivery(record, original),
                        )
                    for field in ("eventId", "processingJobId", "messageId", "bodySha256",
                                  "headerEventId", "headerEventType", "headersSha256", "eventType", "schemaVersion",
                                  "exchange", "routingKey", "contentType", "deliveryMode"):
                        assert duplicate[field] == original[field] == e2e._wire_fingerprint(wire)[field]
                    assert duplicate["redelivered"] is False

                    competing_claim = await asyncio.to_thread(
                        e2e._wait_for_log_record,
                        tmp_path / "worker.log", "E2E04_CLAIM ",
                        lambda record: record.get("eventId") == event_id
                        and record.get("phase") == "result" and _same_delivery(record, duplicate),
                        )
                    assert competing_claim["outcome"] in ("error", "status")
                    if competing_claim["outcome"] == "error":
                        assert competing_claim["code"] == "WORKER_ATTEMPT_BUSY"
                    else:
                        assert competing_claim["state"] in (
                            "RUNNING", "AWAITING_RECONCILIATION", "RESULT_ACCEPTED", "SUPERSEDED")
                    assert not e2e._log_records(tmp_path / "worker.log", "E2E04_INFERENCE ")
                    parent.release(POST_CLAIM)
                    checkpoint_observation["released"] = True
                    checkpoint_active = False

                    job, transcript = await admission.wait_for_acceptance(
                        meeting_id, job_id, worker_alive=lambda: worker.poll() is None)
                    settled = await asyncio.to_thread(
                        _wait_for_duplicate_settlement, parent, event_id, original)
                    first_evidence = _r01_evidence(postgres, job_id, event_id)
                    return (meeting_id, media_id, job_id, job, transcript, wire, original,
                            duplicate, competing_claim, settled, first_evidence)

                result = asyncio.run(_with_admission(admission, exercise))
                (meeting_id, media_id, job_id, job, transcript, wire, original, duplicate,
                 competing_claim, settled, first_evidence) = result
                assert job["status"] in ("COMPLETED", "COMPLETED_WITH_WARNINGS")
                assert transcript["processingJobId"] == job_id
                inference = e2e._log_records(tmp_path / "worker.log", "E2E04_INFERENCE ")
                assert len(inference) == 1 and _same_delivery(inference[0], original)
                e2e._stop_worker(worker, worker_log)
                worker = worker_log = None
                e2e._assert_acknowledged(names[0], credentials, timeout=45)
                reconciliation, transitions = _wait_for_reconciliation(
                    postgres, job_id, wire.event_id, required=settled["action"] == "reject")
                second_evidence = _r01_evidence(postgres, job_id, wire.event_id)
                for field in ("sourceSha256", "resultSha256", "correctionSha256", "producerStageRunId",
                              "receiptId", "transcriptId"):
                    assert second_evidence[field] == first_evidence[field]
                e2e._assert_r01_evidence(second_evidence)
                assert second_evidence["outboxStatus"] == "PUBLISHED"
                assert second_evidence["transcriptStatus"] in ("READY", "READY_WITH_WARNINGS")
                e2e._assert_result_storage(boundary_settings, job_id, second_evidence, credentials)
                broker_state = _broker_evidence(names[0])
                assert broker_state["work"]["messages"] == 0
                assert broker_state["work"]["messages_ready"] == 0
                assert broker_state["work"]["messages_unacknowledged"] == 0
                assert broker_state["work"]["retained_dead_letters"] == 0
                assert broker_state["dead"]["messages"] == 0
                _assert_settlements(parent.observations(), wire.event_id, original, duplicate, settled,
                                    e2e._log_records(tmp_path / "worker.log", "E2E04_MESSAGE "))
                print("E2E04_R01_EVIDENCE " + json.dumps({
                    "meetingId": meeting_id,
                    "mediaId": media_id,
                    "jobId": job_id,
                    "eventId": wire.event_id,
                    "generation": second_evidence["generation"],
                    "deliveryA": _delivery_summary(original),
                    "deliveryB": _delivery_summary(duplicate),
                    "claimB": {field: competing_claim[field] for field in (
                        "attempt", "outcome", "status", "code", "state") if field in competing_claim},
                    "duplicateSettlement": {field: settled[field] for field in (
                        "deliveryTag", "channel", "redelivered", "action", "phase")},
                    "claimStageRunId": second_evidence["claimStageRunId"],
                    "producerStageRunId": second_evidence["producerStageRunId"],
                    "resultSha256": second_evidence["resultSha256"],
                    "correctionSha256": second_evidence["correctionSha256"],
                    "sourceSha256": second_evidence["sourceSha256"],
                    "receiptId": second_evidence["receiptId"],
                    "transcriptId": second_evidence["transcriptId"],
                    "receiptCount": second_evidence["receiptCount"],
                    "canonicalTranscriptCount": second_evidence["canonicalTranscriptCount"],
                    "broker": broker_state,
                    "reconciliation": reconciliation,
                    "reconciliationObservations": transitions,
                }, separators=(",", ":")))
            finally:
                if job_id and event_id:
                    try:
                        current = _r01_evidence(postgres, job_id, event_id)
                        safe_fields = ("eventId", "processingJobId", "generation", "jobStatus", "claimCount",
                                       "claimStageRunId", "producerStageRunId", "receiptId", "receiptCount",
                                       "acceptedReceiptCount", "failureReceiptCount", "canonicalTranscriptCount",
                                       "transcriptCount", "sourceSha256", "resultSha256", "correctionSha256", "stages")
                        diagnostic = {field: current.get(field) for field in safe_fields}
                        diagnostic["postClaim"] = checkpoint_observation
                        diagnostic["reconciliation"] = _reconciliation(postgres, job_id, event_id)
                        diagnostic["settlements"] = [item for item in parent.observations()
                                                     if item.get("eventId") == event_id][-40:]
                        for prefix, key in (("E2E04_MESSAGE ", "deliveries"), ("E2E04_CLAIM ", "claims"),
                                            ("E2E04_INFERENCE ", "inference"), ("E2E04_ACK ", "acks"),
                                            ("E2E04_COMMAND_JSON ", "commands")):
                            diagnostic[key] = [item for item in e2e._log_records(tmp_path / "worker.log", prefix)
                                               if item.get("eventId") == event_id][-40:]
                        diagnostic["broker"] = _broker_evidence(names[0])
                        print("E2E04_R01_DIAGNOSTIC " + json.dumps(diagnostic, separators=(",", ":")), flush=True)
                    except Exception:
                        print("E2E04_R01_DIAGNOSTIC unavailable", flush=True)
                if checkpoint_active:
                    parent.abort()
                if worker is not None:
                    try:
                        _stop = e2e._stop_worker(worker, worker_log)
                    finally:
                        worker = worker_log = None
