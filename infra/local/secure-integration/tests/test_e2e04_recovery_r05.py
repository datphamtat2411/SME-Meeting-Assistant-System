"""R05 A/B: same-binding immutable result reuse and invalid-slot typed failure."""

import asyncio
import hashlib
from contextlib import ExitStack

import e2e04_recovery_support as support
import pytest
import test_worker_e2e04 as e2e
from e2e04_recovery_control import POST_CLAIM

from sme_meeting_ai.audio import AudioSource
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.workers.transcription import map_result

services, storage_boundary, postgres = e2e.services, e2e.storage_boundary, e2e.postgres
recovery = support.recovery
pytestmark = support.OPT_IN


def seed_bytes(run):
    source = run.path / "synthetic-seed.wav"
    source.write_bytes(e2e.synthetic_wav())
    settings = Settings(service_name="e2e04-seed", service_identity="ai-worker", environment="test",
                        audio_temp_dir=run.path, _env_file=None)
    try:
        with ExitStack() as resources:
            pipeline = e2e._helpers.controlled_pipeline(settings, resources)
            outcome = pipeline.run(AudioSource(run.media_id, source))
            assert outcome.failure is None
            binding = dict(job_id=run.job_id, media_id=run.media_id,
                           source_revision=run.evidence()["sourceSha256"], producer_id=run.owner()["stageRunId"])
            raw = map_result(outcome, pipeline.effective_settings,
                             asr_adapter_version=pipeline.asr_adapter_version, **binding)
            digest, correction = support.validate_seed(raw, **binding)
            return raw, digest, correction
    finally:
        source.unlink()


@pytest.mark.parametrize("valid", [True, False], ids=["authorized-reuse", "invalid-conflict"])
def test_real_r05_immutable_existing_result(recovery, valid):
    run = recovery
    control = run.control()
    control.arm(POST_CLAIM)
    worker = run.start("worker", control=control)

    async def exercise():
        await run.admit()
        await asyncio.to_thread(control.wait_for_checkpoint, POST_CLAIM, timeout=25)
        owner = run.owner()
        assert owner["live"] and owner["generation"] == 0
        if valid:
            raw, digest, correction = seed_bytes(run)
        else:
            raw = b'{"contractVersion":"1.0","resultType":"INVALID"}'
            digest, correction = hashlib.sha256(raw).hexdigest(), None
        key = run.slot()
        with run.storage_client() as client:
            client.put_object(Bucket=run.boundary.s3_bucket, Key=key, Body=raw,
                              ContentType="application/json", IfNoneMatch="*")
        run.assert_immutable(key, raw)
        assert not run.records(worker, "E2E04_INFERENCE")
        control.release(POST_CLAIM)
        if valid:
            await run.accepted(worker)
        else:
            await asyncio.to_thread(run.wait_failure, "TRANSCRIPT_RESULT_INVALID", timeout=30)
        ack = await asyncio.to_thread(run.wait_record, worker, "E2E04_ACK",
                                      lambda item: item["operation"] == "client_completed")
        return raw, digest, correction, key, owner, ack

    raw, digest, correction, key, owner, ack = asyncio.run(run.exercise(exercise))
    run.stop(worker)
    assert not run.records(worker, "E2E04_PIPELINE")
    storage = run.records(worker, "E2E04_STORAGE")
    assert len(storage) == 1 and storage[0]["operation"] == "get_result"
    assert storage[0]["outcome"] == "found" and storage[0]["sha256"] == digest
    if valid:
        final = run.settled_success()
        assert final["resultSha256"] == digest and final["correctionSha256"] == correction
        assert final["producerStageRunId"] == owner["stageRunId"]
        receipts = run.receipts()
    else:
        final, receipts = run.settled_failure(code="TRANSCRIPT_RESULT_INVALID")
        assert receipts[0]["retryable"] is False and receipts[0]["retryExhausted"] is False
        failure, = run.records(worker, "E2E04_FAILURE")
        assert failure["phase"] == "RESULT_VALIDATION" and failure["category"] == "VALIDATION"
        assert ack["terminal"]["state"] == "FAILURE_RECORDED"
    run.assert_immutable(key, raw)
    run.report("R05A" if valid else "R05B", fault="preseed_same_binding_slot", originalSha256=digest,
               correctionSha256=correction, owner=owner, pipelineExecutions=0, storage=storage,
               receipts=receipts, transcriptCount=final["transcriptCount"], ack=ack, finalBroker=run.broker())
