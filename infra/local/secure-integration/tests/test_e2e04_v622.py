"""Deterministic V6.2.2 production composition across real Core HTTP/PostgreSQL."""

import asyncio
import hashlib
import json
import os
from pathlib import Path

import e2e04_recovery_support as support
import pytest
import test_worker_e2e04 as e2e
from e2e04_recovery_control import PRE_ACK
from e2e04_v622_composition import MODEL, SYNTHETIC_KEY, TEXT

from sme_meeting_ai.workers.transcription import (
    correction_digest,
    validate_result_bytes,
)

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def stored_result(run):
    """Observe committed Core metadata independently of Worker diagnostics."""
    return json.loads(e2e._psql(run.database, run.database["password"], f"""
        SELECT json_build_object('resultSha256',v.result_sha256,'correctionSha256',v.correction_sha256,
            'sourceRevision',v.source_revision,'producerStageRunId',v.producer_stage_run_id,
            'sizeBytes',v.size_bytes,'metadata',v.metadata,'verifiedAt',v.verified_at,
            'recordedAt',r.recorded_at,'transcriptId',r.transcript_id)
        FROM transcription_worker_results v JOIN transcription_worker_receipts r
            ON r.processing_job_id=v.processing_job_id AND r.producer_stage_run_id=v.producer_stage_run_id
        WHERE v.processing_job_id='{run.job_id}'::uuid AND r.outcome='RESULT_ACCEPTED'
    """))


@pytest.mark.parametrize("case", ["sparse", "empty"])
def test_real_v622_core_acceptance_with_production_composition(recovery, case):
    run = recovery
    control = run.control(timeout=45)
    control.arm(PRE_ACK)
    worker = run.start("v622-" + case, control=control, extra={
        "AI_E2E04_COMPOSITION": "v622", "AI_E2E04_V622_CASE": case,
        "AI_E2E04_CONTROL_TIMEOUT": "45",
        "AI_TRANSCRIPT_CORRECTION_MODE": "v62_edits",
        "AI_TRANSCRIPT_CORRECTION_MODEL": MODEL, "OPENROUTER_API_KEY": SYNTHETIC_KEY,
        "AI_TRANSCRIPT_CORRECTION_MAX_ATTEMPTS": "1",
    })

    async def exercise():
        await run.admit()
        held = await asyncio.to_thread(control.wait_for_checkpoint, PRE_ACK, timeout=40)
        assert held["eventId"] == run.event_id
        receipt, = run.receipts()
        assert receipt["outcome"] == "RESULT_ACCEPTED" and receipt["eventId"] == run.event_id
        assert receipt["generation"] == 0
        assert receipt["executionStageRunId"] == receipt["producerStageRunId"] == run.owner()["stageRunId"]
        assert receipt["errorCode"] is None and receipt["retryable"] is None
        evidence = run.evidence()
        e2e._assert_r01_evidence(evidence)
        assert evidence["outboxStatus"] == "PUBLISHED"
        assert [item["operation"] for item in run.records(worker, "E2E04_ACK")] == ["invoked"]
        held_broker = await asyncio.to_thread(
            run.wait_broker, lambda state: state["work"]["messages_unacknowledged"] == 1)

        with e2e._tls_client(run.pki, certificate="ai-worker") as client:
            response = client.get(
                f"https://localhost:{run.core.private_port}/internal/v1/worker/processing-jobs/"
                f"{run.job_id}/transcription/deliveries/{run.event_id}",
                headers={"X-Request-Id": "v622-independent-durable-observation"})
        assert response.status_code == 200 and "no-store" in response.headers["cache-control"]
        status = response.json()["data"]
        assert status["state"] == "RESULT_ACCEPTED" and status["generation"] == 0
        assert status["processingJobId"] == run.job_id and status["eventId"] == run.event_id
        assert status["receipt"]["receiptId"] == receipt["receiptId"]
        assert status["receipt"]["transcriptId"] == receipt["transcriptId"]

        job = await run.admission.request("GET", f"/api/v1/processing-jobs/{run.job_id}")
        transcript = await run.admission.request("GET", f"/api/v1/meetings/{run.meeting_id}/transcript")
        assert job["status"] in ("COMPLETED", "COMPLETED_WITH_WARNINGS")
        assert transcript["id"] == receipt["transcriptId"] and transcript["processingJobId"] == run.job_id
        expected = TEXT.replace("chày chuỗi rồi nói", "trầy xước rồi nói") if case == "sparse" else TEXT
        assert [segment["text"] for segment in transcript["segments"]] == [expected]
        raw = run.object_bytes(run.slot(receipt["producerStageRunId"]))
        wire = validate_result_bytes(raw, job_id=run.job_id, media_id=run.media_id,
                                     source_revision=evidence["sourceSha256"], producer_id=receipt["producerStageRunId"])
        data = json.loads(raw)
        assert [segment.text for segment in wire.segments] == [expected]
        assert wire.contractVersion == "1.0" and wire.resultType == "CORRECTED_TRANSCRIPT"
        assert wire.correctionProof.contextScope == "WHOLE_MEETING"
        assert wire.correctionProof.promptVersion == "vi-whole-meeting-6.2.2"
        assert wire.correctionProof.outputSha256 == correction_digest(data["segments"]) == evidence["correctionSha256"]
        assert hashlib.sha256(raw).hexdigest() == evidence["resultSha256"]
        assert {component.name: component.version for component in wire.provenance.components}.items() >= {
            "correction": "6.2", "correction-mode": "v62_edits",
            "correction-validator": "vi-context-validation-6.2.1", "asr-adapter": "openrouter-whisper-v1",
        }.items()
        correction_model, = [model for model in wire.provenance.models if model.role == "CORRECTION"]
        assert (correction_model.provider, correction_model.requestedModel, correction_model.resolvedModel) == (
            "openrouter", MODEL, "e2e04/v622-resolved")
        stored = stored_result(run)
        assert stored["metadata"] == {key: data[key] for key in ("warnings", "provenance", "correctionProof")}
        assert stored["sizeBytes"] == len(raw) and stored["resultSha256"] == hashlib.sha256(raw).hexdigest()
        assert stored["correctionSha256"] == wire.correctionProof.outputSha256
        assert stored["sourceRevision"] == wire.sourceRevision and stored["producerStageRunId"] == wire.producerStageRunId
        assert stored["transcriptId"] == transcript["id"]
        assert status["receipt"]["resultSha256"] == stored["resultSha256"]
        assert status["receipt"]["correctionSha256"] == stored["correctionSha256"]
        run.assert_immutable(run.slot(), raw)
        run.assert_source()
        control.release(PRE_ACK)
        ack = await asyncio.to_thread(run.wait_record, worker, "E2E04_ACK",
                                      lambda item: item["operation"] == "client_completed")
        return evidence, receipt, stored, held_broker, raw, ack

    evidence, receipt, stored, held_broker, raw, ack = asyncio.run(run.exercise(exercise))
    run.stop(worker)
    e2e._assert_acknowledged(run.names[0], run.credentials, timeout=45)
    run.assert_ack_order()
    e2e._assert_original_ack(worker.path / "worker.log", evidence)
    assert run.receipts() == [receipt]
    assert stored_result(run) == stored
    assert run.object_bytes(run.slot()) == raw
    assert not list((worker.path / "worker-temp/sme-transcription-worker").glob("run-*"))
    composition, = run.records(worker, "E2E04_V622_COMPOSITION")
    assert composition["mode"] == "v62_edits" and composition["productionFactory"] is True
    assert composition["adapter"] == "OpenRouterInstructionLlmV62Adapter"
    pipeline, = run.records(worker, "E2E04_V622_RESULT")
    assert pipeline["status"] in ("COMPLETED", "COMPLETED_WITH_WARNINGS") and pipeline["failure"] is None
    assert (pipeline["proposedEdits"], pipeline["acceptedEdits"], pipeline["rejectedEdits"]) == (
        (2, 1, 1) if case == "sparse" else (0, 0, 0))
    assert pipeline["configurationSha256"] == stored["metadata"]["provenance"]["configurationSha256"]
    assert pipeline["correctionRequests"] == pipeline["asrRequests"] == 1
    assert len(run.records(worker, "E2E04_INFERENCE")) == len(run.records(worker, "E2E04_MESSAGE")) == 1
    providers = run.records(worker, "E2E04_V622_PROVIDER")
    assert [item["boundary"] for item in providers] == ["asr", "correction"]
    assert all(item["controlled"] is True for item in providers)
    complete, = [item for item in run.records(worker, "E2E04_HTTP") if item["operation"] == "complete"]
    assert complete["status"] == 200 and complete["state"] == "RESULT_ACCEPTED"
    assert complete["receiptId"] == receipt["receiptId"] and complete["monotonicNs"] < ack["monotonicNs"]
    assert len([item for item in run.records(worker, "E2E04_STORAGE")
                if item["operation"] == "put_result" and item["phase"] == "completed"]) == 1
    assert not [item for item in run.records(worker, "E2E04_HTTP") if item["operation"] == "fail"]
    safe = {
        "case": case, "inference": "DETERMINISTIC_NOT_REAL_PROVIDER", "externalRequests": 0,
        "jobId": run.job_id, "eventId": run.event_id, "generation": 0,
        "executionStageRunId": receipt["executionStageRunId"], "producerStageRunId": receipt["producerStageRunId"],
        "receiptId": receipt["receiptId"], "transcriptId": receipt["transcriptId"], "outcome": receipt["outcome"],
        "acceptedReceiptCount": evidence["acceptedReceiptCount"], "canonicalTranscriptCount": evidence["canonicalTranscriptCount"],
        "resultCount": evidence["resultCount"], "resultSha256": stored["resultSha256"],
        "correctionSha256": stored["correctionSha256"], "configurationSha256": pipeline["configurationSha256"],
        "mode": composition["mode"], "promptVersion": "vi-whole-meeting-6.2.2",
        "provider": "openrouter", "model": MODEL, "resolvedModel": "e2e04/v622-resolved",
        "asrRequests": pipeline["asrRequests"], "correctionRequests": pipeline["correctionRequests"],
        "proposedEdits": pipeline["proposedEdits"], "acceptedEdits": pipeline["acceptedEdits"],
        "rejectedEdits": pipeline["rejectedEdits"], "completionHttpStatus": complete["status"],
        "deliveryStatusHttpStatus": 200, "immutable": True, "sourceUnchanged": True,
        "originalAckAfterDurableAcceptance": True, "ack": ack,
        "verifiedAt": stored["verifiedAt"], "recordedAt": stored["recordedAt"],
        "heldBroker": held_broker, "finalBroker": run.broker(),
    }
    print("E2E04_V622_EVIDENCE " + json.dumps(safe, separators=(",", ":")), flush=True)
    if destination := os.environ.get("V622_ACCEPTANCE_LEDGER"):
        with Path(destination).open("a", encoding="utf-8") as ledger:
            ledger.write("\n## Controlled V6.2.2 Core observations — " + case + "\n\n"
                         "Real HTTP/PostgreSQL/storage/broker; deterministic inference only. "
                         "Overall pytest verdict also governs teardown.\n\n```json\n"
                         + json.dumps(safe, indent=2) + "\n```\n")
