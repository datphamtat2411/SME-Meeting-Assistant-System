"""Check the synthetic Core fixture against current real worker composition bytes.

Run from services/ai with V62_FIXTURE_DIR pointing to the API worker-v1 resources:
V62_FIXTURE_DIR=../api/src/test/resources/worker-v1 .venv/bin/pytest -q tests/integration/test_v62_core_fixture.py
The config file is the exact canonical JSON preimage of configurationSha256; the
sha256 file is the digest of the exact worker result bytes, without a newline.
"""

import asyncio
import hashlib
import json
import os
from pathlib import Path

import httpx
from integration.test_correction_v6_worker import BINDING, MEDIA
from integration.test_worker_v62_composition import (
    composition as composition,
)
from integration.test_worker_v62_composition import (
    offline_environment as offline_environment,
)
from integration.test_worker_v62_composition import pki as pki
from integration.test_worker_v62_composition import provider_response
from integration.test_worker_v62_composition import span_workflow as span_workflow
from integration.test_worker_v62_composition import v61_workflow as v61_workflow
from integration.test_worker_v62_composition import workflow as workflow
from unit.test_correction_v6 import edit

from sme_meeting_ai.providers.openrouter_instruction_llm_v62 import (
    OpenRouterInstructionLlmV62Adapter,
)
from sme_meeting_ai.workers.transcription import TranscriptionExecution, map_result

FIXTURE_DIR = os.environ.get("V62_FIXTURE_DIR")

def test_v62_core_fixture_matches_production_composition(composition, v61_workflow):
    h = composition
    h.settings = h.settings.model_copy(update={"transcript_correction_mode": "v62_edits"})
    flow = v61_workflow(source_id=MEDIA, texts=("nhóm bàn về chày chuỗi rồi nói và mã JWT hôm nay", "cuộc họp giữ nguyên nội dung"))

    async def generate():
        async with TranscriptionExecution(h.settings) as execution:
            pipeline = execution.worker.pipeline
            pipeline._preprocessing, pipeline._planner, pipeline._transcriber = flow.preprocessing, flow.planner, flow.transcriber
            provider = pipeline._correction_provider
            assert type(provider) is OpenRouterInstructionLlmV62Adapter
            provider._client.close()
            provider._client = httpx.Client(transport=httpx.MockTransport(lambda request: provider_response(
                {"edits": [edit("chày chuỗi rồi nói", "trầy xước rồi nói"), edit("JWT", "JWS")]})))
            outcome = pipeline.run(flow.source)
            raw = map_result(outcome, pipeline.effective_settings, correction_mode=pipeline._correction_mode, **BINDING)
            config = {k: v for k, v in pipeline.effective_settings.model_dump(mode="json").items()
                      if k.startswith(("audio_", "transcript_correction_"))
                      and k not in ("audio_temp_dir", "audio_vad_model_path", "transcript_correction_mode")}
            keys = {"context_window_tokens", "max_input_tokens", "max_output_tokens", "max_response_bytes",
                    "max_attempts", "timeout_seconds", "min_text_ratio", "max_text_ratio", "model",
                    "reasoning_effort", "temperature", "correction_mode", "schema_name", "validator_version"}
            effective = {k: v for k, v in outcome.provenance.correction.effective_configuration.items() if k in keys}
            snapshot = json.dumps(dict(version="worker-config-v2", settings=config, correction_mode="v62_edits",
                                       correction_effective=effective), sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
            assert json.loads(raw)["provenance"]["configurationSha256"] == hashlib.sha256(snapshot).hexdigest()
            generated = {"v62-worker.json": raw, "v62-worker-config.json": snapshot,
                         "v62-worker.sha256": (hashlib.sha256(raw).hexdigest() + "\n").encode("ascii")}
            directory = Path(FIXTURE_DIR) if FIXTURE_DIR else Path(__file__).resolve().parents[3] / "api/src/test/resources/worker-v1"
            for name, content in generated.items():
                if FIXTURE_DIR:
                    (directory / name).write_bytes(content)
                else:
                    assert (directory / name).read_bytes() == content, f"stale Python-generated Core fixture: {name}"

    asyncio.run(generate())
