"""R06: actual typed correction provider failure, HTTP replay and admitted exhaustion."""

import asyncio
from uuid import uuid4

import e2e04_recovery_support as support
import test_worker_e2e04 as e2e

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def test_real_r06_provider_failure_and_core_retry_budget(recovery):
    run = recovery
    worker = run.start("worker", fault="provider_failure")

    async def exercise():
        await run.admit()
        generations = []
        for generation in range(4):
            if generation:
                await run.retry(generation)
            receipts = await asyncio.to_thread(run.wait_failure, "LLM_CORRECTION_FAILED", timeout=30)
            current = next(item for item in receipts if item["eventId"] == run.event_id)
            assert current["generation"] == generation
            assert current["retryable"] is (generation < 3)
            assert current["retryExhausted"] is (generation == 3)
            ack = await asyncio.to_thread(run.wait_record, worker, "E2E04_ACK", lambda item:
                                          item["eventId"] == run.event_id and item["operation"] == "client_completed")
            assert ack["terminal"] == {"state": "FAILURE_RECORDED", "receiptId": current["receiptId"]}
            assert not ack["redelivered"]
            run.assert_missing(run.slot())
            generations.append({"eventId": run.event_id, "generation": generation, "receiptId": current["receiptId"]})
        response = await run.admission.client.post(
            f"/api/v1/processing-jobs/{run.job_id}/retry",
            headers={**run.admission.headers, "Idempotency-Key": str(uuid4())}, json={})
        assert response.status_code == 409
        assert run.delivery_id() == run.event_id
        return generations

    generations = asyncio.run(run.exercise(exercise))
    run.stop(worker)
    final, receipts = run.settled_failure(code="LLM_CORRECTION_FAILED", count=4)
    assert [receipt["generation"] for receipt in receipts] == [0, 1, 2, 3]
    failures = run.records(worker, "E2E04_FAILURE")
    assert len(failures) == 4
    assert all(item["phase"] == "CORRECTION" and item["category"] == "PROVIDER"
               and item["completedThrough"] == "RECONCILIATION"
               and item["metrics"]["sampleCount"] == 16000 for item in failures)
    replays = run.records(worker, "E2E04_REPLAY")
    assert len(replays) == 4 and all(item["replay"] for item in replays)
    assert {item["receiptId"] for item in replays} == {receipt["receiptId"] for receipt in receipts}
    assert len(run.records(worker, "E2E04_PIPELINE")) == 4
    provider_failures = run.records(worker, "E2E04_PROVIDER_FAILURE")
    assert [item["generation"] for item in provider_failures] == [0, 1, 2, 3]
    assert [item["eventId"] for item in provider_failures] == [item["eventId"] for item in generations]
    assert not [item for item in run.records(worker, "E2E04_STORAGE") if item["operation"] == "put_result"]
    assert not [item for item in run.records(worker, "E2E04_HTTP") if item["operation"] == "complete"]
    assert any(stage["code"] == "TRANSCRIPTION" and stage["status"] == "SUCCEEDED" for stage in final["stages"])
    run.report("R06", fault="controlled_CORRECTION_PROVIDER", generations=generations, receipts=receipts,
               exactFailureReplays=replays, upstreamTranscriptionPreserved=True, pipelineExecutions=4,
               providerAttempts=len(provider_failures), acceptedCount=0, transcriptCount=0, finalBroker=run.broker())
