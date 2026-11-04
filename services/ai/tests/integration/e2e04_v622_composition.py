"""TEST-only inference transports around the unchanged production Worker composition."""

import hashlib
import io
import json
import wave
from contextlib import contextmanager
from email import policy
from email.parser import BytesParser
from unittest.mock import patch

import httpx
from e2e04_recovery_faults import emit, execution_binding
from test_worker_live_acceptance import ControlledExecution, ControlledVadBackend

from sme_meeting_ai.audio.vad import SileroVadBackend
from sme_meeting_ai.core.config import Environment
from sme_meeting_ai.pipeline import OfflineTranscriptionPipeline
from sme_meeting_ai.providers.openrouter_instruction_llm import (
    OpenRouterInstructionLlmAdapter,
)
from sme_meeting_ai.providers.openrouter_instruction_llm_v62 import (
    OpenRouterInstructionLlmV62Adapter,
)
from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
from sme_meeting_ai.transcription.correction_v6 import CORRECTION_V6_JSON_SCHEMA
from sme_meeting_ai.transcription.correction_v62_generation import V62_SYSTEM_PROMPT

SYNTHETIC_KEY = "v622-controlled-not-a-provider-key"
MODEL = "e2e04/v622-correction"
TEXT = "nhóm bàn về chày chuỗi rồi nói và mã JWT hôm nay"


@contextmanager
def controlled_v622_boundaries(settings, *, case):
    if settings.environment is not Environment.TEST:
        raise ValueError("V6.2.2 controls require test environment")
    key = settings.openrouter_api_key
    if (settings.transcript_correction_mode != "v62_edits" or settings.transcript_correction_model != MODEL
            or key is None or key.get_secret_value() != SYNTHETIC_KEY or case not in ("sparse", "empty")):
        raise ValueError("V6.2.2 fixture configuration is invalid")
    state = {"asrRequests": 0, "correctionRequests": 0}
    real_client = httpx.Client

    def respond(request):
        if (request.url.scheme != "https" or request.url.host != "openrouter.ai"
                or request.url.port not in (None, 443) or request.url.query
                or request.url.path not in ("/api/v1/audio/transcriptions", "/api/v1/chat/completions")
                or request.method != "POST"):
            raise AssertionError("unexpected fixture destination")
        if request.url.path.endswith("/audio/transcriptions"):
            assert state["asrRequests"] < 1, "ASR request bound exceeded"
            assert request.headers["Authorization"] == "Bearer " + SYNTHETIC_KEY
            message = BytesParser(policy=policy.default).parsebytes(
                b"Content-Type: " + request.headers["Content-Type"].encode("ascii") + b"\r\n\r\n" + request.content)
            audio, = [part.get_payload(decode=True) for part in message.iter_parts()
                      if part.get_param("name", header="content-disposition") == "file"]
            with wave.open(io.BytesIO(audio), "rb") as reader:
                assert reader.getnchannels() == 1 and reader.getframerate() == 16000
                assert reader.getnframes() == 16000 and reader.getsampwidth() == 2
            state["asrRequests"] += 1
            emit("E2E04_V622_PROVIDER", boundary="asr", controlled=True, requestCount=1, **execution_binding.get())
            return httpx.Response(200, json={"text": TEXT, "language": "vi", "confidence": 1,
                                           "segments": [{"start": 0, "end": 1, "text": TEXT, "confidence": 1}]})
        assert state["correctionRequests"] < 1, "correction request bound exceeded"
        body = json.loads(request.content)
        assert body["model"] == MODEL and body["messages"][0]["content"] == V62_SYSTEM_PROMPT
        schema = body["response_format"]["json_schema"]
        assert schema["strict"] is True and schema["schema"] == CORRECTION_V6_JSON_SCHEMA
        assert request.headers["Authorization"] == "Bearer " + SYNTHETIC_KEY
        segment, = json.loads(body["messages"][1]["content"])["segments"]
        assert segment["text"] == TEXT
        entries = [] if case == "empty" else [
            {"segment_id": segment["segment_id"], "source": source, "replacement": target, "occurrence": 0}
            for source, target in (("chày chuỗi rồi nói", "trầy xước rồi nói"), ("JWT", "JWS"))
        ]
        state["correctionRequests"] += 1
        emit("E2E04_V622_PROVIDER", boundary="correction", controlled=True, requestCount=1, **execution_binding.get())
        return httpx.Response(200, json={"model": "e2e04/v622-resolved", "choices": [{
            "finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps({"edits": entries})}}]})

    def client(*args, **kwargs):
        assert "transport" not in kwargs, "fixture client transport must remain controlled"
        return real_client(*args, **kwargs, transport=httpx.MockTransport(respond))

    with patch.object(httpx, "Client", client), patch.object(
            SileroVadBackend, "from_settings", lambda _: ControlledVadBackend()):
        yield state


def configuration_sha256(outcome, settings):
    """Independent canonical preimage check; excludes credentials, paths and text."""
    values = {key: value for key, value in settings.model_dump(mode="json").items()
              if key.startswith(("audio_", "transcript_correction_"))
              and key not in ("audio_temp_dir", "audio_vad_model_path", "transcript_correction_mode")}
    keys = {"context_window_tokens", "max_input_tokens", "max_output_tokens", "max_response_bytes",
            "max_attempts", "timeout_seconds", "min_text_ratio", "max_text_ratio", "model",
            "reasoning_effort", "temperature", "correction_mode", "schema_name", "validator_version"}
    effective = {key: value for key, value in outcome.provenance.correction.effective_configuration.items() if key in keys}
    snapshot = dict(version="worker-config-v2", settings=values,
                    correction_mode="v62_edits", correction_effective=effective)
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class ObservedV622Execution(ControlledExecution):
    def __init__(self, execution, state):
        super().__init__(execution)
        self.state = state

    async def __aenter__(self):
        await super().__aenter__()
        try:
            pipeline = self.execution.worker.pipeline
            assert self.execution._pipeline_factory is None
            assert type(pipeline) is OfflineTranscriptionPipeline
            assert type(pipeline._transcriber) is OpenRouterWhisperAdapter
            assert type(pipeline._correction_provider) is OpenRouterInstructionLlmV62Adapter
            assert not isinstance(pipeline._correction_provider, OpenRouterInstructionLlmAdapter)
            assert pipeline._correction_mode == pipeline.effective_settings.transcript_correction_mode == "v62_edits"
            emit("E2E04_V622_COMPOSITION", productionFactory=True, mode=pipeline._correction_mode,
                 adapter=type(pipeline._correction_provider).__name__)
            original = pipeline.run

            def observed(source):
                outcome = original(source)
                fields = dict(status=outcome.status.value,
                              failure=outcome.failure.category if outcome.failure else None, **self.state)
                if outcome.result is not None:
                    provenance = outcome.provenance.correction
                    fields.update(proposedEdits=provenance.proposed_edit_count,
                                  acceptedEdits=provenance.accepted_edit_count,
                                  rejectedEdits=provenance.rejected_edit_count,
                                  configurationSha256=configuration_sha256(outcome, pipeline.effective_settings))
                emit("E2E04_V622_RESULT", **fields, **execution_binding.get())
                return outcome

            pipeline.run = observed
            return self
        except BaseException:
            await self.__aexit__(None, None, None)
            raise
