"""Real correction/provider composition inside the unchanged offline pipeline."""

import json
from fractions import Fraction

import httpx
import pytest
from test_offline_transcription_pipeline import assert_released, pipeline, workflow

from sme_meeting_ai.pipeline import OfflineTranscriptionStatus
from sme_meeting_ai.providers.openrouter_instruction_llm import (
    OpenRouterInstructionLlmAdapter,
)

__all__ = ["workflow"]


@pytest.mark.parametrize("repair_final", [False, True])
def test_openrouter_schema_retry_and_pipeline_compatibility(workflow, repair_final):
    h = workflow(OPENROUTER_API_KEY="synthetic-private-key")
    requests = []

    def handle(request):
        body = json.loads(request.content)
        data = json.loads(body["messages"][1]["content"])
        requests.append(data)
        assert set(data) == {"sample_rate_hz", "segments"}
        assert data == requests[0]
        response = {"segments": [{k: s[k] for k in ("segment_id", "ordinal", "text")} for s in data["segments"]]}
        if repair_final and len(requests) == 1:
            response["segments"][0]["ordinal"] = True
        return httpx.Response(200, json={
            "model": "test/resolved-corrector",
            "choices": [{"message": {"content": json.dumps(response)}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
                      "cost": 0.001, "completion_tokens_details": {"reasoning_tokens": 10}},
        })

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        h.corrector = OpenRouterInstructionLlmAdapter(h.settings, client)
        outcome = pipeline(h).run(h.source)
    assert outcome.status is OfflineTranscriptionStatus.COMPLETED
    provenance = outcome.result.provenance
    count = 2 if repair_final else 1
    assert len(requests) == provenance.attempts == count
    assert provenance.correction_version == "4" and provenance.prompt_version == "vi-whole-meeting-5.3"
    assert provenance.usage.input_tokens == 100
    assert provenance.usage.reasoning_tokens == 10
    assert provenance.usage.cost == Fraction(1, 1000)
    assert outcome.result.coverage is outcome.evidence.coverage
    assert [s.text for s in outcome.result.segments] == [s["text"] for s in requests[0]["segments"]]
    assert_released(h)
