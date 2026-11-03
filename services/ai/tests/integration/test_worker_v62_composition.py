"""Offline production selection of the V6.2 correction provider."""

import asyncio
import hashlib
import json

import httpx
import pytest
from integration.test_correction_v6_worker import BINDING, MEDIA
from integration.test_correction_v61_pipeline import span_workflow as span_workflow
from integration.test_correction_v61_pipeline import v61_workflow as v61_workflow
from integration.test_correction_v61_pipeline import workflow as workflow
from integration.test_offline_transcription_pipeline import pipeline as controlled_pipeline
from integration.test_transcription_worker_integration import Delivery, FakeCore
from integration.test_worker_composition import composition as composition
from integration.test_worker_composition import pki as pki
from unit.test_correction_v6 import edit
from unit.test_correction_v6 import offline_environment as offline_environment
from unit.test_worker_integrations import S3, event_body

from sme_meeting_ai.providers.openrouter_instruction_llm_v62 import (
    OpenRouterInstructionLlmV62Adapter,
)
from sme_meeting_ai.transcription.correction_v6 import CORRECTION_V6_JSON_SCHEMA
from sme_meeting_ai.transcription.correction_v62_generation import V62_SYSTEM_PROMPT
from sme_meeting_ai.workers import transcription as worker_transcription
from sme_meeting_ai.workers.transcription import (
    ResultValidationError,
    TranscriptionExecution,
    correction_digest,
    map_result,
    validate_result_bytes,
)


async def lifecycle(h, flow, response, *, factory=None, body=None):
    body = body or event_body()
    core = FakeCore(body, S3())
    events = []

    async def transport(request):
        core.s3 = h.s3
        operation = request.url.path.rsplit("/", 1)[-1]
        events.append(operation)
        if getattr(core, "fail_unavailable", False) and (operation == "fail" or request.method == "GET"):
            return core.response(status=503, code="UNAVAILABLE")
        result = await core(request)
        if operation in ("complete", "fail") and core.receipt:
            events.append("receipt")
        return result

    h.transport = httpx.MockTransport(transport)
    execution = await TranscriptionExecution(h.settings, pipeline_factory=factory).__aenter__()
    pipeline = execution.worker.pipeline
    if factory is None:
        pipeline._preprocessing, pipeline._planner, pipeline._transcriber = flow.preprocessing, flow.planner, flow.transcriber
        provider = pipeline._correction_provider
        provider._client.close()
        provider._client = httpx.Client(transport=httpx.MockTransport(response))
    original_put = h.s3.put_object

    def put(**kwargs):
        events.append("storage")
        return original_put(**kwargs)
    h.s3.put_object = put

    class TracedDelivery(Delivery):
        async def ack(self):
            events.append("ack")
            await super().ack()

    return execution, core, body, events, TracedDelivery


def provider_response(content):
    return httpx.Response(200, json={"model": "test/resolved", "choices": [{"finish_reason": "stop", "message": {
        "role": "assistant", "content": json.dumps(content)}}]})


def fingerprint(outcome, settings, mode):
    config = {k: v for k, v in settings.model_dump(mode="json").items()
              if k.startswith(("audio_", "transcript_correction_"))
              and k not in ("audio_temp_dir", "audio_vad_model_path", "transcript_correction_mode")}
    keys = {"context_window_tokens", "max_input_tokens", "max_output_tokens", "max_response_bytes",
            "max_attempts", "timeout_seconds", "min_text_ratio", "max_text_ratio", "model",
            "reasoning_effort", "temperature", "correction_mode", "schema_name", "validator_version"}
    effective = {k: v for k, v in outcome.provenance.correction.effective_configuration.items() if k in keys}
    raw = json.dumps(dict(version="worker-config-v2", settings=config, correction_mode=mode,
                          correction_effective=effective), sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(raw).hexdigest()


def historical_v1_provenance(outcome, settings, asr_adapter_version="openrouter-whisper-v1", correction_mode=None):
    """Reproduce pre-V2 _provenance from source commit 7161665."""
    p = outcome.provenance
    pre = p.preprocessing
    versions = [
        ("normalization", pre.normalization.normalizer_version),
        ("detection", pre.detection.detector_version), ("speech-map", pre.speech_map.mapper_version),
        ("planning", p.planning.planner_version), ("asr-adapter", asr_adapter_version),
        ("coverage", p.coverage.assessor_version), ("recovery", p.recovery.recovery_version),
        ("reconciliation", p.reconciliation.reconciler_version), ("correction", p.correction.correction_version),
    ]
    models = []
    for _, model in (*p.asr.asr, *p.coverage.asr, *p.reconciliation.asr):
        entry = dict(role="ASR", provider=model.provider, requestedModel=model.requested_model,
                     resolvedModel=model.resolved_model)
        if entry not in models:
            models.append(entry)
    models.append(dict(role="CORRECTION", provider=p.correction.provider,
                       requestedModel=p.correction.requested_model, resolvedModel=p.correction.resolved_model))
    config = {k: v for k, v in settings.model_dump(mode="json").items()
              if k.startswith(("audio_", "transcript_correction_"))
              and k not in ("audio_temp_dir", "audio_vad_model_path")}
    snapshot = json.dumps(dict(version="worker-config-v1", settings=config), sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode()
    return dict(pipelineVersion=p.pipeline_version, configurationSha256=hashlib.sha256(snapshot).hexdigest(),
                components=[dict(name=name, version=version) for name, version in versions],
                vadModel=dict(modelId=pre.detection.model_id, modelVersion=pre.detection.model_version,
                              sha256=pre.detection.model_sha256), models=models)


def test_production_selects_v62_adapter_and_mode(composition):
    h = composition
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": "v62_edits"})

    async def run():
        async with TranscriptionExecution(h.settings) as execution:
            pipeline = execution.worker.pipeline
            assert type(pipeline._correction_provider) is OpenRouterInstructionLlmV62Adapter
            assert pipeline._correction_mode == "v62_edits"
    asyncio.run(run())
    assert sorted(h.closed) == sorted(h.acquired)


def test_selected_provider_runs_real_v62_pipeline(composition, v61_workflow):
    h = composition
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": "v62_edits"})
    flow = v61_workflow(source_id=MEDIA, texts=("nhóm bàn về chày chuỗi rồi nói và mã JWT hôm nay", "cuộc họp giữ nguyên nội dung"))
    requests = []

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        content = {"edits": [edit("chày chuỗi rồi nói", "trầy xước rồi nói"), edit("JWT", "JWS")]}
        return httpx.Response(200, json={"model": "test/resolved", "choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": json.dumps(content)}}]})

    async def run():
        async with TranscriptionExecution(h.settings) as execution:
            pipeline = execution.worker.pipeline
            pipeline._preprocessing, pipeline._planner, pipeline._transcriber = flow.preprocessing, flow.planner, flow.transcriber
            provider = pipeline._correction_provider
            provider._client.close()
            provider._client = httpx.Client(transport=httpx.MockTransport(respond))
            outcome = pipeline.run(flow.source)
            assert len(requests) == 1
            assert requests[0]["messages"][0]["content"] == V62_SYSTEM_PROMPT
            schema = requests[0]["response_format"]["json_schema"]
            assert schema["strict"] is True and schema["schema"] == CORRECTION_V6_JSON_SCHEMA
            p = outcome.result.provenance
            assert (p.correction_version, p.prompt_version, p.provider, p.resolved_model) == (
                "6.2", "vi-whole-meeting-6.2.2", "openrouter", "test/resolved")
            assert (p.accepted_edit_count, p.rejected_edit_count) == (1, 1)
            assert "trầy xước rồi nói" in outcome.result.segments[0].text and "JWT" in outcome.result.segments[0].text
            raw = map_result(outcome, pipeline.effective_settings, correction_mode=pipeline._correction_mode, **BINDING)
            wire = validate_result_bytes(raw, **BINDING)
            components = {c.name: c.version for c in wire.provenance.components}
            assert components["correction-mode"] == "v62_edits"
            assert components["correction-validator"] == "vi-context-validation-6.2.1"
            assert wire.correctionProof.outputSha256 == correction_digest(json.loads(raw)["segments"])
            assert raw == map_result(outcome, pipeline.effective_settings, correction_mode=pipeline._correction_mode, **BINDING)
            with pytest.raises(ResultValidationError):
                map_result(outcome, pipeline.effective_settings, correction_mode="v5_full", **BINDING)
            changed = pipeline.effective_settings.model_copy(update={"audio_vad_speech_threshold": 0.7})
            other = validate_result_bytes(map_result(outcome, changed, correction_mode="v62_edits", **BINDING), **BINDING)
            assert other.provenance.configurationSha256 != wire.provenance.configurationSha256
    asyncio.run(run())


def test_v62_worker_completion_storage_receipt_and_ack(composition, v61_workflow):
    h = composition
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": "v62_edits"})
    flow = v61_workflow(texts=("nhóm bàn về chày chuỗi rồi nói và mã JWT hôm nay", "cuộc họp giữ nguyên nội dung"))
    requests, outcomes = [], []

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        assert body["messages"][0]["content"] == V62_SYSTEM_PROMPT
        assert body["response_format"]["json_schema"]["schema"] == CORRECTION_V6_JSON_SCHEMA
        return provider_response({"edits": [edit("chày chuỗi rồi nói", "trầy xước rồi nói"), edit("JWT", "JWS")]})

    async def run():
        execution, core, body, events, delivery_type = await lifecycle(h, flow, respond)
        try:
            pipeline = execution.worker.pipeline
            original = pipeline.run
            def capture(source):
                outcome = original(source)
                outcomes.append(outcome)
                return outcome
            pipeline.run = capture
            delivery = delivery_type(body)
            await execution.worker.handle(delivery)
            assert delivery.actions == ["ack"] and core.state == "RESULT_ACCEPTED"
            assert events.index("claim") < events.index("storage") < events.index("complete") < events.index("receipt") < events.index("ack")
            assert len(requests) == len(outcomes) == len(core.transcripts) == len(h.s3.objects) == 1
            outcome = outcomes[0]
            assert (outcome.provenance.correction.accepted_edit_count, outcome.provenance.correction.rejected_edit_count) == (1, 1)
            raw, = h.s3.objects.values()
            wire = validate_result_bytes(raw, job_id=body["processingJobId"], media_id=body["sourceMediaId"],
                                         source_revision=core.claim["source"]["sourceRevision"], producer_id=core.claim["executionStageRunId"])
            data = json.loads(raw)
            components = {c.name: c.version for c in wire.provenance.components}
            assert components["correction"] == "6.2"
            assert components["correction-mode"] == "v62_edits"
            assert components["correction-validator"] == "vi-context-validation-6.2.1"
            assert wire.contractVersion == "1.0" and wire.resultType == "CORRECTED_TRANSCRIPT"
            assert wire.correctionProof.contextScope == "WHOLE_MEETING"
            assert wire.correctionProof.promptVersion == "vi-whole-meeting-6.2.2"
            assert wire.correctionProof.outputSha256 == correction_digest(data["segments"])
            model, = [m for m in wire.provenance.models if m.role == "CORRECTION"]
            assert (model.provider, model.requestedModel, model.resolvedModel) == ("openrouter", "test/corrector", "test/resolved")
            assert wire.provenance.configurationSha256 == fingerprint(outcome, pipeline.effective_settings, "v62_edits")
            complete, = [c for op, c in core.requests if op == "complete"]
            assert complete["resultSha256"] == core.receipt["resultSha256"] == hashlib.sha256(raw).hexdigest()
            assert "trầy xước rồi nói" in wire.segments[0].text and "JWT" in wire.segments[0].text
        finally:
            await execution.__aexit__(None, None, None)
    asyncio.run(run())


@pytest.mark.parametrize("unresolved", [False, True])
@pytest.mark.parametrize("kind,category", [("malformed", "MALFORMED_OUTPUT"), ("provider", "PROVIDER")])
def test_v62_worker_failure_is_typed_private_and_ack_requires_receipt(composition, v61_workflow, caplog, unresolved, kind, category):
    h = composition
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": "v62_edits", "transcript_correction_max_attempts": 1})
    flow = v61_workflow()
    private = "private-provider-response-do-not-leak"
    outcomes = []
    def respond(request):
        assert json.loads(request.content)["messages"][0]["content"] == V62_SYSTEM_PROMPT
        if kind == "provider":
            return httpx.Response(500, content=private.encode())
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": private}}]})

    async def run():
        execution, core, body, events, delivery_type = await lifecycle(h, flow, respond)
        try:
            pipeline = execution.worker.pipeline
            original = pipeline.run
            def capture(source):
                outcome = original(source)
                outcomes.append(outcome)
                return outcome
            pipeline.run = capture
            core.fail_unavailable = unresolved
            delivery = delivery_type(body)
            await execution.worker.handle(delivery)
            assert len(outcomes) == 1 and outcomes[0].failure.category == category
            assert outcomes[0].failure.stage.name == "CORRECTION" and outcomes[0].result is None
            assert not h.s3.objects and not core.transcripts and not any(op == "complete" for op, _ in core.requests)
            if unresolved:
                assert delivery.actions == ["nack"] and core.receipt is None
            else:
                failure, = core.failures
                assert failure["phase"] == "CORRECTION" and failure["category"] == category
                assert failure["completedThrough"] == "RECONCILIATION"
                assert core.state == "FAILURE_RECORDED" and core.receipt
                assert events.index("fail") < events.index("receipt") < events.index("ack")
                assert delivery.actions == ["ack"]
            diagnostics = json.dumps(core.requests) + repr(outcomes[0]) + caplog.text
            assert private not in diagnostics
            assert all(text not in diagnostics for text in ("rapport", "chày chuỗi"))
        finally:
            await execution.__aexit__(None, None, None)
    asyncio.run(run())


@pytest.mark.parametrize("initial_mode", ["v5_full", "v62_edits"])
def test_immutable_replay_preserves_original_provenance_across_selector_change(composition, v61_workflow, initial_mode):
    h = composition
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": initial_mode})
    flow = v61_workflow()
    requests, outcomes = [], []
    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        if initial_mode == "v5_full":
            segments = json.loads(body["messages"][1]["content"])["segments"]
            return provider_response({"segments": [{k: s[k] for k in ("segment_id", "ordinal", "text")} for s in segments]})
        assert body["messages"][0]["content"] == V62_SYSTEM_PROMPT
        return provider_response({"edits": []})

    async def run():
        first, core, body, events, delivery_type = await lifecycle(h, flow, respond)
        second = None
        try:
            pipeline = first.worker.pipeline
            original = pipeline.run
            def capture(source):
                outcome = original(source)
                outcomes.append(outcome)
                return outcome
            pipeline.run = capture
            core.rollback = True
            delivery = delivery_type(body)
            await first.worker.handle(delivery)
            assert delivery.actions == ["nack"] and not core.transcripts
            key, = h.s3.objects
            raw = h.s3.objects[key]
            wire = validate_result_bytes(raw)
            assert wire.provenance.configurationSha256 == fingerprint(outcomes[0], pipeline.effective_settings, initial_mode)
            components = {c.name: c.version for c in wire.provenance.components}
            assert components["correction-mode"] == initial_mode
            assert components["correction"] == ("4" if initial_mode == "v5_full" else "6.2")
            original_sha = hashlib.sha256(raw).hexdigest()
            producer = core.claim["executionStageRunId"]
            core.rollback = False
            core.state, core.claim_request, core.claim = "AVAILABLE", None, None
            core.reusable = dict(storageId="private", producerStageRunId=producer, objectKey=key)
            h.settings = h.settings.model_copy(update={"transcript_correction_mode": "v62_edits"})
            second = await TranscriptionExecution(h.settings).__aenter__()
            h.s3.objects[key] = raw
            second.worker.pipeline.run = lambda source: pytest.fail("replay must not run inference")
            duplicate = delivery_type(body, 1)
            await second.worker.handle(duplicate)
            assert duplicate.actions == ["ack"] and core.state == "RESULT_ACCEPTED"
            assert h.s3.objects[key] == raw and hashlib.sha256(h.s3.objects[key]).hexdigest() == original_sha
            assert validate_result_bytes(h.s3.objects[key]).provenance == wire.provenance
            assert core.receipt["resultSha256"] == original_sha
            assert len(requests) == len(outcomes) == len(core.transcripts) == 1
            replay = delivery_type(body, 2)
            await second.worker.handle(replay)
            assert replay.actions == ["ack"] and len(core.transcripts) == 1
        finally:
            if second:
                await second.__aexit__(None, None, None)
            await first.__aexit__(None, None, None)
    asyncio.run(run())


def test_genuine_pre_v2_artifact_replays_immutably_under_v62(composition, workflow, monkeypatch):
    h = composition
    fixed_body = dict(
        eventId="11111111-1111-4111-8111-111111111111",
        processingJobId="22222222-2222-4222-8222-222222222222",
        meetingId="33333333-3333-4333-8333-333333333333",
        sourceMediaId="44444444-4444-4444-8444-444444444444",
        requestedByUserId="55555555-5555-4555-8555-555555555555",
        requestId="pre-v2-replay", schemaVersion=1, occurredAt="2026-10-31T12:00:00Z",
    )
    historical_settings = h.settings.model_copy(deep=True)
    historical_flow = workflow(source_id=fixed_body["sourceMediaId"])
    historical_outcome = controlled_pipeline(historical_flow).run(historical_flow.source)
    worker_flow = workflow(source_id=fixed_body["sourceMediaId"])
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": "v62_edits"})
    provider_requests = []

    def unexpected_provider_call(request):
        provider_requests.append(request)
        pytest.fail("pre-V2 artifact replay must not call correction")

    async def run():
        execution, core, body, events, delivery_type = await lifecycle(
            h, worker_flow, unexpected_provider_call, body=fixed_body)
        try:
            pipeline = execution.worker.pipeline
            assert pipeline._correction_mode == "v62_edits"
            assert type(pipeline._correction_provider) is OpenRouterInstructionLlmV62Adapter
            pipeline.run = lambda source: pytest.fail("pre-V2 artifact replay must not run ASR or correction")

            source_revision = hashlib.sha256(h.s3.data).hexdigest()
            producer_id = "66666666-6666-4666-8666-666666666666"
            key = f"processing/{body['processingJobId']}/transcription/results/{producer_id}.json"
            binding = dict(job_id=body["processingJobId"], media_id=body["sourceMediaId"],
                           source_revision=source_revision, producer_id=producer_id)
            # The historical implementation is preserved at 7161665. Its _provenance
            # snapshot uses worker-config-v1 and only the audio_/transcript_correction_
            # Settings subset; current worker-config-v2 is never used to create these bytes.
            with monkeypatch.context() as patch:
                patch.setattr(worker_transcription, "_provenance", historical_v1_provenance)
                raw = map_result(historical_outcome, historical_settings, **binding)
                assert map_result(historical_outcome, historical_settings, **binding) == raw

            original_raw = bytes(raw)
            original_sha = hashlib.sha256(original_raw).hexdigest()
            original_wire = validate_result_bytes(original_raw, **binding)
            historical_config = {
                k: v for k, v in historical_settings.model_dump(mode="json").items()
                if k.startswith(("audio_", "transcript_correction_"))
                and k not in ("audio_temp_dir", "audio_vad_model_path")
            }
            historical_snapshot = json.dumps(
                dict(version="worker-config-v1", settings=historical_config), sort_keys=True,
                separators=(",", ":"), allow_nan=False,
            ).encode()
            legacy_hash = hashlib.sha256(historical_snapshot).hexdigest()
            assert original_wire.provenance.configurationSha256 == legacy_hash
            assert legacy_hash != fingerprint(historical_outcome, historical_settings, "v5_full")
            assert legacy_hash != fingerprint(historical_outcome, h.settings, "v62_edits")

            original_components = [(c.name, c.version) for c in original_wire.provenance.components]
            assert ("correction", "4") in original_components
            assert not any(name in ("correction-mode", "correction-validator")
                           for name, _ in original_components)
            assert original_wire.correctionProof.promptVersion == "vi-whole-meeting-5.3"
            assert original_wire.correctionProof.promptVersion != "vi-whole-meeting-6.2.2"
            original_models = [m.model_dump() for m in original_wire.provenance.models]
            original_correction_models = [m for m in original_models if m["role"] == "CORRECTION"]
            assert original_correction_models == [dict(
                role="CORRECTION", provider=historical_outcome.provenance.correction.provider,
                requestedModel=historical_outcome.provenance.correction.requested_model,
                resolvedModel=historical_outcome.provenance.correction.resolved_model,
            )]

            core.reusable = dict(storageId="private", producerStageRunId=producer_id, objectKey=key)
            h.s3.objects[key] = original_raw
            delivery = delivery_type(body)
            await execution.worker.handle(delivery)

            assert delivery.actions == ["ack"] and core.state == "RESULT_ACCEPTED"
            assert events.index("claim") < events.index("complete") < events.index("receipt") < events.index("ack")
            assert len([command for operation, command in core.requests if operation == "complete"]) == 1
            complete, = [command for operation, command in core.requests if operation == "complete"]
            assert complete["resultProducerStageRunId"] == producer_id
            assert complete["resultSha256"] == core.receipt["resultSha256"] == original_sha
            assert core.receipt["correctionSha256"] == original_wire.correctionProof.outputSha256
            assert len(core.transcripts) == 1 and core.transcripts[0] == json.loads(original_raw)
            assert h.s3.objects[key] == original_raw
            assert hashlib.sha256(h.s3.objects[key]).hexdigest() == original_sha
            assert h.s3.puts == [] and "storage" not in events

            replay_wire = validate_result_bytes(h.s3.objects[key], **binding)
            assert replay_wire.provenance.configurationSha256 == legacy_hash
            assert replay_wire.provenance.components == original_wire.provenance.components
            assert replay_wire.provenance.models == original_wire.provenance.models
            assert replay_wire.correctionProof == original_wire.correctionProof

            receipt = core.receipt.copy()
            duplicate = delivery_type(body, 1)
            await execution.worker.handle(duplicate)
            assert duplicate.actions == ["ack"]
            assert core.receipt == receipt and len(core.transcripts) == 1
            assert len([command for operation, command in core.requests if operation == "complete"]) == 1
            assert h.s3.objects[key] == original_raw and h.s3.puts == []
            assert not provider_requests and not worker_flow.asr_calls and worker_flow.correction_calls == 0
        finally:
            await execution.__aexit__(None, None, None)
    asyncio.run(run())


def test_controlled_factory_reports_its_own_mode_and_provider(composition, workflow):
    from integration.test_offline_transcription_pipeline import (
        pipeline as controlled_pipeline,
    )

    from sme_meeting_ai.transcription.correction import CorrectionProviderResponse

    h = composition
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": "v62_edits", "openrouter_api_key": None})
    flow = workflow()
    def controlled(request):
        segments = json.loads(request.transcript_json)["segments"]
        entries = [{k: s[k] for k in ("segment_id", "ordinal", "text")} for s in segments]
        return CorrectionProviderResponse(json.dumps({"segments": entries}), "e2e04-controlled", request.model)
    flow.correction_callback = controlled

    async def run():
        execution, core, body, events, delivery_type = await lifecycle(
            h, flow, None, factory=lambda settings, resources: controlled_pipeline(flow))
        try:
            delivery = delivery_type(body)
            await execution.worker.handle(delivery)
            assert delivery.actions == ["ack"] and core.state == "RESULT_ACCEPTED"
            raw, = h.s3.objects.values()
            wire = validate_result_bytes(raw)
            components = {c.name: c.version for c in wire.provenance.components}
            assert components["correction-mode"] == "v5_full"
            model, = [m for m in wire.provenance.models if m.role == "CORRECTION"]
            assert model.provider == "e2e04-controlled"
        finally:
            await execution.__aexit__(None, None, None)
    asyncio.run(run())
