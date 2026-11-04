"""Real F02 negative acceptance: genuine evidence failure, private HTTP and PostgreSQL."""

import asyncio
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import e2e04_recovery_support as support
import pytest
import test_worker_e2e04 as e2e
from botocore.exceptions import ClientError
from e2e04_recovery_control import POST_CLAIM, PRE_ACK

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def private_inventory(run):
    """Bounded fixture-admin observation; object identities never enter diagnostics."""
    client = e2e.worker_infrastructure.storage_client(run.boundary)
    try:
        result = client.list_objects_v2(Bucket=run.boundary.s3_bucket, MaxKeys=1000)
        if result.get("IsTruncated"):
            raise AssertionError("isolated F02 storage inventory exceeded bound")
        return {(item["Key"], item["ETag"], item["Size"]) for item in result.get("Contents", [])}
    finally:
        client.close()


def f02_database_state(run):
    return json.loads(e2e._psql(run.database, run.database["password"], f"""
        SELECT json_build_object(
            'jobStatus', p.status, 'errorCode', p.error_code, 'retryable', p.retryable,
            'retryCount', p.retry_count,
            'deliveryCount', (SELECT count(*) FROM transcription_worker_deliveries WHERE processing_job_id=p.id),
            'outboxCount', (SELECT count(*) FROM outbox_events WHERE aggregate_id=p.id),
            'registeredArtifacts', (SELECT count(*) FROM processing_artifacts WHERE processing_job_id=p.id),
            'failedCorrectionCount', (SELECT count(*) FROM processing_stage_runs
                WHERE processing_job_id=p.id AND stage_code='CONTEXTUAL_CORRECTION'
                    AND status='FAILED' AND error_code='TRANSCRIPTION_EVIDENCE_INVALID'))
        FROM processing_jobs p WHERE p.id='{run.job_id}'::uuid
    """))


def assert_source_mutations_denied(run):
    key = run.evidence()["sourceObjectKey"]
    with run.storage_client() as client:
        for operation in (
            lambda: client.put_object(Bucket=run.boundary.s3_bucket, Key=key, Body=b"synthetic-replacement"),
            lambda: client.put_object(Bucket=run.boundary.s3_bucket, Key=key,
                                      Body=b"synthetic-replacement", IfNoneMatch="*"),
            lambda: client.delete_object(Bucket=run.boundary.s3_bucket, Key=key),
        ):
            with pytest.raises(ClientError) as denied:
                operation()
            assert denied.value.response["ResponseMetadata"]["HTTPStatusCode"] == 403


def test_real_f02_invalid_correction_evidence_is_nonretryable(recovery):
    run = recovery
    control = run.control()
    control.arm(POST_CLAIM)
    control.arm(PRE_ACK)
    worker = run.start("f02-worker", control=control, fault="evidence_invalid")

    async def exercise():
        await run.admit()
        claimed = await asyncio.to_thread(control.wait_for_checkpoint, POST_CLAIM, timeout=25)
        assert claimed["eventId"] == run.event_id
        owner = run.owner()
        assert owner["live"] and owner["generation"] == 0
        before = private_inventory(run)
        control.release(POST_CLAIM)
        held = await asyncio.to_thread(control.wait_for_checkpoint, PRE_ACK, timeout=25)
        assert held["eventId"] == run.event_id
        receipts = run.receipts()
        receipt, = receipts
        assert receipt["outcome"] == "FAILURE_RECORDED"
        assert receipt["errorCode"] == "TRANSCRIPTION_EVIDENCE_INVALID"
        assert receipt["retryable"] is False and receipt["retryExhausted"] is False
        assert receipt["eventId"] == run.event_id and receipt["generation"] == 0
        assert receipt["executionStageRunId"] == owner["stageRunId"] and receipt["commandId"]
        assert receipt["transcriptId"] is None and receipt["producerStageRunId"] is None
        assert [item["operation"] for item in run.records(worker, "E2E04_ACK")] == ["invoked"]
        broker_held = run.wait_broker(lambda state: state["work"]["messages_unacknowledged"] == 1)

        with e2e._tls_client(run.pki, certificate="ai-worker") as client:
            response = client.get(
                f"https://localhost:{run.core.private_port}/internal/v1/worker/processing-jobs/"
                f"{run.job_id}/transcription/deliveries/{run.event_id}",
                headers={"X-Request-Id": "f02-durable-observation"})
        assert response.status_code == 200 and "no-store" in response.headers["cache-control"]
        status = response.json()["data"]
        assert status["processingJobId"] == run.job_id and status["eventId"] == run.event_id
        assert status["generation"] == 0 and status["state"] == "FAILURE_RECORDED"
        assert set(status["receipt"]) == {"receiptId", "errorCode", "retryable", "retryExhausted", "recordedAt"}
        assert {key: value for key, value in status["receipt"].items() if key != "recordedAt"} == {
            key: receipt[key] for key in status["receipt"] if key != "recordedAt"}
        assert datetime.fromisoformat(status["receipt"]["recordedAt"]) == datetime.fromisoformat(receipt["recordedAt"])

        denied_retry = await run.admission.client.post(
            f"/api/v1/processing-jobs/{run.job_id}/retry",
            headers={**run.admission.headers, "Idempotency-Key": str(uuid4())}, json={})
        assert denied_retry.status_code == 409
        state = f02_database_state(run)
        assert state == {"jobStatus": "FAILED", "errorCode": "TRANSCRIPTION_EVIDENCE_INVALID",
                         "retryable": False, "retryCount": 0, "deliveryCount": 1, "outboxCount": 1,
                         "registeredArtifacts": 0, "failedCorrectionCount": 1}
        assert run.delivery_id() == run.event_id
        control.release(PRE_ACK)
        ack = await asyncio.to_thread(run.wait_record, worker, "E2E04_ACK",
                                      lambda item: item["operation"] == "client_completed")
        assert ack["redelivered"] is False
        assert ack["terminal"] == {"state": "FAILURE_RECORDED", "receiptId": receipt["receiptId"]}
        return owner, before, receipt, broker_held, status, state, ack

    owner, before, receipt, broker_held, status, state, ack = asyncio.run(run.exercise(exercise))
    run.stop(worker)
    evidence, final_receipts = run.settled_failure(code="TRANSCRIPTION_EVIDENCE_INVALID")
    assert final_receipts == [receipt]
    assert evidence["claimCount"] == evidence["receiptCount"] == evidence["failureReceiptCount"] == 1
    assert evidence["acceptedReceiptCount"] == evidence["contradictoryTerminalCount"] == 0
    assert evidence["transcriptCount"] == evidence["canonicalTranscriptCount"] == evidence["resultCount"] == 0
    assert evidence["generation"] == 0 and evidence["outboxStatus"] == "PUBLISHED"
    assert evidence["reconciliationDispositions"] == []
    assert any(stage["code"] == "TRANSCRIPTION" and stage["status"] == "SUCCEEDED" for stage in evidence["stages"])
    run.assert_missing(run.slot(owner["stageRunId"]))
    assert_source_mutations_denied(run)
    if private_inventory(run) != before:
        raise AssertionError("F02 private storage inventory changed")
    source_sha = run.assert_source()
    assert source_sha == hashlib.sha256(e2e.synthetic_wav()).hexdigest()
    assert f02_database_state(run) == state
    assert not list((worker.path / "worker-temp" / "sme-transcription-worker").glob("run-*"))

    fault, = run.records(worker, "E2E04_F02_FAULT")
    assert fault["boundary"] == "correction_handoff" and fault["invariant"] == "sample_identity"
    assert fault["originalSampleCount"] == fault["coverageSampleCount"] == 16000
    assert fault["invalidSampleCount"] == 16001
    pipeline, = run.records(worker, "E2E04_PIPELINE_RESULT")
    assert pipeline["status"] == "FAILED"
    assert (pipeline["failurePhase"], pipeline["failureCategory"]) == ("CORRECTION", "VALIDATION")
    failure, = run.records(worker, "E2E04_FAILURE")
    assert (failure["phase"], failure["category"], failure["completedThrough"]) == (
        "CORRECTION", "VALIDATION", "RECONCILIATION")
    assert failure["receipt"] == status["receipt"]
    replay, = run.records(worker, "E2E04_F02_REPLAY")
    assert replay["status"] == 200 and replay["originalReplay"] is False and replay["replay"] is True
    assert replay["receiptId"] == receipt["receiptId"] and replay["commandId"] == receipt["commandId"]
    http = run.records(worker, "E2E04_HTTP")
    failed, = [item for item in http if item["operation"] == "fail"]
    assert failed["status"] == 200 and failed["state"] == "FAILURE_RECORDED"
    assert failed["receiptId"] == receipt["receiptId"]
    assert not [item for item in http if item["operation"] == "complete"]
    assert not run.records(worker, "E2E04_F02_PROVIDER")
    assert len(run.records(worker, "E2E04_PIPELINE")) == 1
    assert not [item for item in run.records(worker, "E2E04_STORAGE") if item["operation"] == "put_result"]
    assert len(run.records(worker, "E2E04_MESSAGE")) == 1
    assert replay["monotonicNs"] < failed["monotonicNs"] < ack["monotonicNs"]

    safe = {
        "jobId": run.job_id, "eventId": run.event_id, "generation": 0,
        "executionStageRunId": owner["stageRunId"], "receiptId": receipt["receiptId"],
        "phase": failure["phase"], "category": failure["category"],
        "errorCode": receipt["errorCode"], "retryable": False, "retryExhausted": False,
        "privateFailHttpStatus": 200, "deliveryStatusHttpStatus": 200,
        "exactReplay": replay, "database": state,
        "failureReceiptCount": 1, "acceptedReceiptCount": 0, "canonicalTranscriptCount": 0,
        "correctedResultCount": 0, "privateInventoryUnchanged": True,
        "sourceMutationDenied": True, "sourceSha256": source_sha,
        "ack": ack, "heldBroker": broker_held, "finalBroker": run.broker(),
    }
    print("E2E04_F02_EVIDENCE " + json.dumps(safe, separators=(",", ":")), flush=True)
    if destination := os.environ.get("F02_ACCEPTANCE_LEDGER"):
        with Path(destination).open("a", encoding="utf-8") as ledger:
            ledger.write("\n## F02 real scenario observations\n\n"
                         "All scenario assertions completed; overall pytest verdict also governs "
                         "fixture teardown and selected regressions. No paid provider calls.\n\n```json\n"
                         + json.dumps(safe, indent=2) + "\n```\n")
