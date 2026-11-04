"""One authorized V6.2.2 provider-origin job through the isolated Core fixture."""

import asyncio
import hashlib
import io
import json
import os
import wave
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import e2e04_recovery_support as support
import pytest
import test_worker_e2e04 as e2e
from dotenv import dotenv_values
from e2e04_recovery_control import PRE_ACK

from sme_meeting_ai.workers.transcription import validate_result_bytes

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def _required(name):
    value = os.environ.get(name)
    if not value:
        value = dotenv_values(e2e.AI_ROOT / ".env").get(name)
    if not isinstance(value, str) or not value:
        pytest.fail(f"missing required private test setting: {name}")
    return value


def _clip():
    path = Path(_required("V622_REAL_CLIP"))
    raw = path.read_bytes()
    expected = os.environ.get("V622_REAL_CLIP_SHA256")
    digest = hashlib.sha256(raw).hexdigest()
    assert expected is None or digest == expected
    with wave.open(io.BytesIO(raw), "rb") as reader:
        assert (reader.getnchannels(), reader.getsampwidth(), reader.getframerate(),
                reader.getcomptype(), reader.getnframes()) == (1, 2, 16000, "NONE", 80000)
    return raw, digest


def _stored_result(run):
    raw = e2e._psql(run.database, run.database["password"], f"""
        SELECT json_build_object('resultSha256',v.result_sha256,'correctionSha256',v.correction_sha256,
            'sourceRevision',v.source_revision,'producerStageRunId',v.producer_stage_run_id,
            'sizeBytes',v.size_bytes,'metadata',v.metadata,'verifiedAt',v.verified_at,
            'recordedAt',r.recorded_at,'transcriptId',r.transcript_id)
        FROM transcription_worker_results v JOIN transcription_worker_receipts r
            ON r.processing_job_id=v.processing_job_id AND r.producer_stage_run_id=v.producer_stage_run_id
        WHERE v.processing_job_id='{run.job_id}'::uuid AND r.outcome='RESULT_ACCEPTED'
    """)
    assert raw
    return json.loads(raw)


def _provider_cost(records):
    costs = [Fraction(item["cost"]) for item in records if item.get("cost") is not None]
    return sum(costs, Fraction(0)) if len(costs) == len(records) else None


def test_real_v622_provider_core_acceptance(recovery):
    run = recovery
    audio, clip_digest = _clip()
    key = _required("OPENROUTER_API_KEY")
    vad_path = _required("V622_VAD_MODEL_PATH")
    vad_digest = _required("V622_VAD_MODEL_SHA256")
    control = run.control(timeout=90)
    control.arm(PRE_ACK)
    worker = run.start("v622-real-provider", control=control, extra={
        "AI_E2E04_CONTROL_TIMEOUT": "90",
        "AI_E2E04_REAL_PROVIDER_DIAGNOSTICS": "1",
        "AI_E2E04_COMPOSITION": "real-provider",
        "OPENROUTER_API_KEY": key,
        "AI_AUDIO_ASR_MODEL": "openai/whisper-large-v3",
        "AI_AUDIO_ASR_LANGUAGE": "vi",
        "AI_AUDIO_ASR_STRATEGY_MODE": "chunked",
        "AI_AUDIO_ASR_MAX_TOTAL_CALLS": "2",
        "AI_AUDIO_ASR_RECOVERY_MAX_TOTAL_ATTEMPTS": "1",
        "AI_AUDIO_ASR_RECOVERY_MAX_TOTAL_REQUEST_SAMPLES": "480000",
        "AI_AUDIO_ASR_MAX_CONCURRENT_CHUNKS": "1",
        "AI_AUDIO_VAD_MODEL_PATH": vad_path,
        "AI_AUDIO_VAD_MODEL_SHA256": vad_digest,
        "AI_TRANSCRIPT_CORRECTION_MODE": "v62_edits",
        "AI_TRANSCRIPT_CORRECTION_MODEL": "openai/gpt-6-luna",
        "AI_TRANSCRIPT_CORRECTION_REASONING_EFFORT": "medium",
        "AI_TRANSCRIPT_CORRECTION_MAX_ATTEMPTS": "1",
        "AI_TRANSCRIPT_CORRECTION_CONTEXT_WINDOW_TOKENS": "32768",
        "AI_TRANSCRIPT_CORRECTION_MAX_INPUT_TOKENS": "16384",
        "AI_TRANSCRIPT_CORRECTION_MAX_OUTPUT_TOKENS": "4096",
        "AI_CORE_API_MAX_ATTEMPTS": "1",
    })

    async def exercise():
        run.meeting_id, run.media_id, run.job_id = await run.admission.admit(audio)
        run.event_id = await asyncio.to_thread(run.delivery_id)
        activation = await asyncio.to_thread(control.wait_for_checkpoint, PRE_ACK, timeout=85)
        assert activation["eventId"] == run.event_id
        receipt, = run.receipts()
        assert receipt["outcome"] == "RESULT_ACCEPTED" and receipt["generation"] == 0
        assert receipt["errorCode"] is None and receipt["retryable"] is None
        evidence = run.evidence()
        e2e._assert_r01_evidence(evidence)
        assert evidence["sourceSha256"] == clip_digest
        assert evidence["outboxStatus"] == "PUBLISHED"
        held_broker = await asyncio.to_thread(
            run.wait_broker, lambda state: state["work"]["messages_unacknowledged"] == 1)

        with e2e._tls_client(run.pki, certificate="ai-worker") as client:
            response = client.get(
                f"https://localhost:{run.core.private_port}/internal/v1/worker/processing-jobs/"
                f"{run.job_id}/transcription/deliveries/{run.event_id}",
                headers={"X-Request-Id": "v622-real-provider-independent-observation"})
        assert response.status_code == 200 and "no-store" in response.headers["cache-control"]
        status = response.json()["data"]
        assert status["state"] == "RESULT_ACCEPTED" and status["generation"] == 0
        assert status["receipt"]["receiptId"] == receipt["receiptId"]

        job = await run.admission.request("GET", f"/api/v1/processing-jobs/{run.job_id}")
        transcript = await run.admission.request("GET", f"/api/v1/meetings/{run.meeting_id}/transcript")
        assert job["status"] in ("COMPLETED", "COMPLETED_WITH_WARNINGS")
        assert transcript["id"] == receipt["transcriptId"]
        assert transcript["processingJobId"] == run.job_id
        assert transcript["segments"] and all(
            isinstance(segment.get("text"), str) and segment["text"].strip()
            for segment in transcript["segments"])

        raw = run.object_bytes(run.slot(receipt["producerStageRunId"]))
        wire = validate_result_bytes(raw, job_id=run.job_id, media_id=run.media_id,
                                     source_revision=clip_digest,
                                     producer_id=receipt["producerStageRunId"])
        data = json.loads(raw)
        assert wire.contractVersion == "1.0" and wire.resultType == "CORRECTED_TRANSCRIPT"
        assert wire.correctionProof.contextScope == "WHOLE_MEETING"
        assert wire.correctionProof.promptVersion == "vi-whole-meeting-6.2.2"
        assert hashlib.sha256(raw).hexdigest() == evidence["resultSha256"]
        assert wire.correctionProof.outputSha256 == evidence["correctionSha256"]
        assert {item.name: item.version for item in wire.provenance.components}.items() >= {
            "correction": "6.2", "correction-mode": "v62_edits",
            "correction-validator": "vi-context-validation-6.2.1",
            "asr-adapter": "openrouter-whisper-v1",
        }.items()
        asr_models = [model for model in wire.provenance.models if model.role == "ASR"]
        correction_models = [model for model in wire.provenance.models if model.role == "CORRECTION"]
        assert asr_models and all(
            model.provider == "openrouter" and model.requestedModel == "openai/whisper-large-v3"
            for model in asr_models)
        assert len(correction_models) == 1
        assert (correction_models[0].provider, correction_models[0].requestedModel) == (
            "openrouter", "openai/gpt-6-luna")
        stored = _stored_result(run)
        assert stored["metadata"] == {key: data[key] for key in ("warnings", "provenance", "correctionProof")}
        assert stored["sizeBytes"] == len(raw)
        assert stored["resultSha256"] == hashlib.sha256(raw).hexdigest()
        assert stored["correctionSha256"] == wire.correctionProof.outputSha256
        assert stored["sourceRevision"] == wire.sourceRevision
        assert stored["transcriptId"] == transcript["id"]
        assert status["receipt"]["resultSha256"] == stored["resultSha256"]
        assert status["receipt"]["correctionSha256"] == stored["correctionSha256"]
        assert run.object_bytes(evidence["sourceObjectKey"]) == audio
        run.assert_immutable(run.slot(), raw)
        control.release(PRE_ACK)
        ack = await asyncio.to_thread(run.wait_record, worker, "E2E04_ACK",
                                      lambda item: item["operation"] == "client_completed")
        return evidence, receipt, stored, held_broker, ack

    evidence, receipt, stored, held_broker, ack = asyncio.run(run.exercise(exercise))
    run.stop(worker)
    e2e._assert_acknowledged(run.names[0], run.credentials, timeout=45)
    run.assert_ack_order()
    e2e._assert_original_ack(worker.path / "worker.log", evidence)
    assert run.receipts() == [receipt]
    assert _stored_result(run) == stored
    assert run.object_bytes(run.slot()) == run.object_bytes(run.slot(receipt["producerStageRunId"]))
    assert not list((worker.path / "worker-temp/sme-transcription-worker").glob("run-*"))

    providers = run.records(worker, "E2E04_REAL_PROVIDER")
    assert [item["boundary"] for item in providers] == ["asr", "correction"]
    assert all(item["outcome"] == "accepted" and item["requestCount"] == 1 for item in providers)
    actual_cost = _provider_cost(providers)
    assert actual_cost is not None and actual_cost <= Fraction(1, 10)
    assert len(run.records(worker, "E2E04_INFERENCE")) == 1
    complete, = [item for item in run.records(worker, "E2E04_HTTP") if item["operation"] == "complete"]
    assert complete["status"] == 200 and complete["state"] == "RESULT_ACCEPTED"
    assert complete["monotonicNs"] < ack["monotonicNs"]

    safe = {
        "case": "real-provider",
        "inference": "REAL_OPENROUTER",
        "externalRequests": 2,
        "jobId": run.job_id,
        "eventId": run.event_id,
        "generation": receipt["generation"],
        "executionStageRunId": receipt["executionStageRunId"],
        "producerStageRunId": receipt["producerStageRunId"],
        "receiptId": receipt["receiptId"],
        "transcriptId": receipt["transcriptId"],
        "outcome": receipt["outcome"],
        "acceptedReceiptCount": evidence["acceptedReceiptCount"],
        "canonicalTranscriptCount": evidence["canonicalTranscriptCount"],
        "resultCount": evidence["resultCount"],
        "sourceSha256": clip_digest,
        "resultSha256": stored["resultSha256"],
        "correctionSha256": stored["correctionSha256"],
        "mode": "v62_edits",
        "promptVersion": "vi-whole-meeting-6.2.2",
        "provider": "openrouter",
        "asrModel": "openai/whisper-large-v3",
        "correctionModel": "openai/gpt-6-luna",
        "providerRequests": providers,
        "actualCostUsd": str(Decimal(actual_cost.numerator) / Decimal(actual_cost.denominator)),
        "completionHttpStatus": complete["status"],
        "deliveryStatusHttpStatus": 200,
        "immutable": True,
        "sourceUnchanged": True,
        "originalAckAfterDurableAcceptance": True,
        "ack": ack,
        "heldBroker": held_broker,
        "finalBroker": run.broker(),
        "sourceSelection": {
            "originalSourceSha256": os.environ.get("V622_REAL_SOURCE_SHA256"),
            "clipStartSeconds": os.environ.get("V622_REAL_CLIP_START_SECONDS"),
            "clipDurationSeconds": os.environ.get("V622_REAL_CLIP_DURATION_SECONDS"),
            "clipSha256": clip_digest,
        },
    }
    print("E2E04_V622_REAL_PROVIDER_EVIDENCE " + json.dumps(safe, separators=(",", ":")), flush=True)
    if destination := os.environ.get("V622_ACCEPTANCE_LEDGER"):
        with Path(destination).open("a", encoding="utf-8") as ledger:
            ledger.write("\n## Real-provider V6.2.2 Core observation\n\n"
                         "One authorized OpenRouter ASR/correction job through real isolated Core, "
                         "storage, PostgreSQL, RabbitMQ and mTLS.\n\n```json\n"
                         + json.dumps(safe, indent=2) + "\n```\n")
