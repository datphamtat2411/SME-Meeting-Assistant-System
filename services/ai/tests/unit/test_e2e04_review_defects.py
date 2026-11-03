"""Focused post-review exception and ACK evidence regressions."""

import asyncio
import importlib
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from integration.test_offline_transcription_pipeline import pipeline
from integration.test_offline_transcription_pipeline import workflow as workflow
from integration.test_transcription_worker_integration import Delivery, cleanup, setup
from unit.test_correction import Provider, configuration, meeting, payload
from unit.test_transcription_worker import binding

from sme_meeting_ai.integrations.core_api import CoreApiClient
from sme_meeting_ai.pipeline.offline_transcription import OfflineTranscriptionPipeline
from sme_meeting_ai.transcription import correction
from sme_meeting_ai.transcription.correction import (
    CorrectionError,
    CorrectionErrorCategory,
)
from sme_meeting_ai.workers import transcription
from sme_meeting_ai.workers.transcription import (
    _eligible_failure,
    ResultValidationError,
    TranscriptionWorker,
    map_result,
    pipeline_failure,
    validate_result_bytes,
)

PRIVATE = "private-exception-content"


@pytest.mark.parametrize("kind,expected", [
    ("validation", CorrectionErrorCategory.VALIDATION),
    ("unexpected", CorrectionErrorCategory.RESOURCE),
    ("provider", CorrectionErrorCategory.TIMEOUT),
])
def test_v5_correction_distinguishes_local_and_typed_failures(monkeypatch, caplog, kind, expected):
    reconciliation, coverage = meeting()
    provider = Provider(payload(reconciliation))
    if kind == "validation":
        reconciliation = replace(reconciliation, source_id="")
    elif kind == "unexpected":
        def fail(*args):
            raise TypeError(PRIVATE)
        monkeypatch.setattr(correction, "_validate_request", fail)
    else:
        provider = Provider(CorrectionError(CorrectionErrorCategory.TIMEOUT))
    outcome = correction.correct_transcript(reconciliation, coverage, provider, configuration())
    assert outcome.result is None and outcome.failure.category is expected
    if kind == "unexpected":
        assert outcome.failure.attempts == 0 and not provider.requests
    assert PRIVATE not in repr(outcome) + caplog.text


def test_v5_local_exception_reaches_worker_fail_command(workflow, monkeypatch, caplog):
    def fail(*args):
        raise TypeError(PRIVATE)
    monkeypatch.setattr(correction, "_validate_request", fail)

    async def run():
        h = workflow()
        resources = await setup(h)
        try:
            await resources.worker.handle(Delivery(resources.body))
            command, = resources.core.failures
            assert (command["phase"], command["category"]) == ("CORRECTION", "RESOURCE")
            assert _eligible_failure(transcription.WorkFailure(command["phase"], command["category"]), "TRANSCRIPTION")
            assert not resources.s3.objects and not resources.core.transcripts
            assert h.correction_calls == 0
            assert PRIVATE not in json.dumps(command) + caplog.text
        finally:
            await cleanup(resources)
    asyncio.run(run())


def test_v5_malformed_provider_json_and_unexpected_post_response_failure(monkeypatch):
    reconciliation, coverage = meeting()
    malformed = correction.correct_transcript(reconciliation, coverage, Provider("{"), configuration())
    assert malformed.failure.category is CorrectionErrorCategory.MALFORMED_OUTPUT

    def fail(*args):
        raise TypeError(PRIVATE)
    monkeypatch.setattr(correction, "_validated_texts", fail)
    outcome = correction.correct_transcript(reconciliation, coverage, Provider(payload(reconciliation)), configuration())
    assert outcome.failure.category is CorrectionErrorCategory.RESOURCE


def test_preprocessing_invalid_handoff_and_source_are_distinct(workflow):
    h = workflow()
    offline = OfflineTranscriptionPipeline(SimpleNamespace(run=lambda _: None), None, None, None, h.settings)
    invalid = pipeline_failure(offline.run(h.source))
    assert (invalid.phase, invalid.category) == ("PREPROCESSING", "MALFORMED_OUTPUT")
    assert _eligible_failure(invalid, "TRANSCRIPTION")
    h.source.path.unlink()
    source = pipeline_failure(pipeline(h).run(h.source))
    assert (source.phase, source.category) == ("PREPROCESSING", "VALIDATION")
    assert _eligible_failure(source, "TRANSCRIPTION")


def test_valid_pipeline_and_result_validation_categories(workflow):
    h = workflow(source_id=str(uuid4()))
    outcome = pipeline(h).run(h.source)
    bound = binding(h)
    assert validate_result_bytes(map_result(outcome, h.settings, **bound))
    with pytest.raises(ResultValidationError) as invalid:
        map_result(None, h.settings, **bound)
    assert invalid.value.category == "VALIDATION"
    empty = replace(outcome, result=replace(outcome.result, segments=()))
    with pytest.raises(ResultValidationError) as no_output:
        map_result(empty, h.settings, **bound)
    assert no_output.value.category == "EMPTY_OUTPUT"
    with pytest.raises(ResultValidationError) as malformed:
        validate_result_bytes(b'{"broken":')
    assert malformed.value.category == "VALIDATION"


@pytest.mark.parametrize("error", [MemoryError(PRIVATE), RuntimeError(PRIVATE)])
def test_result_mapping_resource_is_submitted_without_upload(workflow, monkeypatch, caplog, error):
    def fail(*args):
        raise error
    monkeypatch.setattr(transcription, "_require", fail)

    async def run():
        resources = await setup(workflow())
        try:
            await resources.worker.handle(Delivery(resources.body))
            command, = resources.core.failures
            assert (command["phase"], command["category"]) == ("RESULT_VALIDATION", "RESOURCE")
            assert _eligible_failure(transcription.WorkFailure(command["phase"], command["category"]), "TRANSCRIPTION")
            assert not resources.s3.objects and not resources.core.transcripts
            assert not any(op == "complete" for op, _ in resources.core.requests)
            assert PRIVATE not in json.dumps(command) + caplog.text
        finally:
            await cleanup(resources)
    asyncio.run(run())


def test_digest_resource_failure_is_not_reclassified(workflow, monkeypatch):
    h = workflow(source_id=str(uuid4()))
    outcome = pipeline(h).run(h.source)

    def fail(*args):
        raise MemoryError(PRIVATE)
    monkeypatch.setattr(transcription.hashlib, "sha256", fail)
    with pytest.raises(MemoryError):
        transcription.correction_digest([{"ordinal": 0, "startMs": 0, "endMs": 1, "text": "test"}])
    with pytest.raises(ResultValidationError) as caught:
        map_result(outcome, h.settings, **binding(h))
    assert caught.value.category == "RESOURCE"


@pytest.mark.parametrize("redelivered", [False, True])
def test_ack_observer_correlates_delivery_and_rejects_redelivery(monkeypatch, tmp_path, capsys, redelivered):
    ai = Path(__file__).resolve().parents[2]
    root = ai.parents[1]
    monkeypatch.syspath_prepend(str(ai / "tests/integration"))
    monkeypatch.syspath_prepend(str(root / "infra/local/secure-integration/tests"))
    observer = importlib.import_module("e2e04_worker_process")
    acceptance = importlib.import_module("test_worker_e2e04")
    event = SimpleNamespace(eventId="event-1")

    async def request(*args, **kwargs):
        return SimpleNamespace(durable=True, state="RESULT_ACCEPTED", receipt={"receiptId": "receipt-1"})

    async def handle(self, delivery):
        await delivery.ack()

    monkeypatch.setattr(CoreApiClient, "request", request)
    monkeypatch.setattr(TranscriptionWorker, "_prepare", TranscriptionWorker._prepare)
    monkeypatch.setattr(TranscriptionWorker, "handle", handle)
    observer.install_diagnostics()
    calls = []

    class FakeDelivery:
        message_id = "event-1"
        delivery_tag = 42
        channel = SimpleNamespace(number=7)

        async def ack(self):
            calls.append("ack")

    delivery = FakeDelivery()
    delivery.redelivered = redelivered

    async def run():
        await CoreApiClient.request(None, event, "complete")
        await TranscriptionWorker.handle(None, delivery)
    asyncio.run(run())
    assert calls == ["ack"]
    log = tmp_path / "worker.log"
    log.write_text(capsys.readouterr().out)
    records = [json.loads(line.removeprefix("E2E04_ACK ")) for line in log.read_text().splitlines()
               if line.startswith("E2E04_ACK ")]
    assert [item["operation"] for item in records] == ["invoked", "client_completed"]
    assert all(item["redelivered"] is redelivered for item in records)
    evidence = {"eventId": "event-1", "receiptId": "receipt-1"}
    if redelivered:
        with pytest.raises(AssertionError):
            acceptance._assert_original_ack(log, evidence)
    else:
        assert acceptance._assert_original_ack(log, evidence)["deliveryTag"] == 42
        with pytest.raises(AssertionError):
            acceptance._assert_original_ack(log, {**evidence, "receiptId": "wrong"})


def test_ack_observer_does_not_report_client_completion_on_failure(monkeypatch, capsys):
    ai = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(ai / "tests/integration"))
    observer = importlib.import_module("e2e04_worker_process")

    async def handle(self, delivery):
        await delivery.ack()

    monkeypatch.setattr(CoreApiClient, "request", CoreApiClient.request)
    monkeypatch.setattr(TranscriptionWorker, "_prepare", TranscriptionWorker._prepare)
    monkeypatch.setattr(TranscriptionWorker, "handle", handle)
    observer.install_diagnostics()

    class FailedDelivery:
        message_id = "event-1"
        delivery_tag = 42
        channel = SimpleNamespace(number=7)
        redelivered = False

        async def ack(self):
            raise RuntimeError("ack failed")

    with pytest.raises(RuntimeError):
        asyncio.run(TranscriptionWorker.handle(None, FailedDelivery()))
    output = capsys.readouterr().out
    assert '"operation": "invoked"' in output
    assert '"operation": "client_completed"' not in output
