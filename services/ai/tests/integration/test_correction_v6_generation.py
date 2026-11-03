"""Offline V6 HTTP -> generation -> Task 01 application, outside production."""

import json
from fractions import Fraction

import httpx
import pytest
from unit.test_correction_v6 import edit, meeting, offline_environment
from unit.test_correction_v6_generation import settings

from sme_meeting_ai.providers.openrouter_instruction_llm_v6 import (
    OpenRouterInstructionLlmV6Adapter,
)
from sme_meeting_ai.transcription.correction_v6 import apply_v6_edits
from sme_meeting_ai.transcription.correction_v6_generation import generate_v6_proposal

__all__ = ["offline_environment"]


@pytest.mark.parametrize("first_failure", [None, "malformed", "timeout", "rate_limit"])
def test_whole_meeting_generation_retry_and_independent_application(first_failure, caplog):
    original = meeting((
        "vâng vâng giữa nguyên và tinh tiết trong Bí kíp luyện dòng",
        "con dòng được thà mạng; con dòng có mương mặt ấy",
        "đứt như chằn chắn",
    ))
    entries = [edit("giữa nguyên", "giữ nguyên"), edit("tinh tiết", "tình tiết"),
               edit("dòng", "rồng"), edit("dòng", "rồng", segment=1),
               edit("dòng", "rồng", segment=1, occurrence=1), edit("thà", "tha", segment=1),
               edit("mương", "gương", segment=1), edit("vâng vâng", "vâng")]
    config = settings(OPENROUTER_API_KEY="synthetic-v6-key", transcript_correction_reasoning_effort="low")
    calls = []

    def handle(request):
        calls.append(request.content)
        body = json.loads(request.content)
        assert body["response_format"]["type"] == "json_schema"
        assert body["response_format"]["json_schema"]["strict"] is True
        assert body["provider"] == {"require_parameters": True}
        assert "temperature" not in body
        assert [s["text"] for s in json.loads(body["messages"][1]["content"])["segments"]] == [
            s.text for s in original.segments
        ]
        if len(calls) == 1:
            if first_failure == "timeout":
                raise httpx.ReadTimeout("private-rejected-output", request=request)
            if first_failure == "rate_limit":
                return httpx.Response(429, content=b"private-rejected-output")
            if first_failure == "malformed":
                return httpx.Response(200, json={"choices": []})
        return httpx.Response(200, json={
            "model": "test/resolved", "choices": [{"finish_reason": "stop", "message": {
                "role": "assistant", "content": json.dumps({"edits": entries}, ensure_ascii=False),
            }}], "usage": {"prompt_tokens": 100, "completion_tokens": 40, "total_tokens": 140,
                          "cost": 0.001, "completion_tokens_details": {"reasoning_tokens": 10}},
        })

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        adapter = OpenRouterInstructionLlmV6Adapter(config, client)
        outcome = generate_v6_proposal(original, adapter, config)
        assert not client.is_closed
    result = outcome.result
    assert outcome.failure is None
    assert result.attempts == len(calls) == (1 if first_failure is None else 2)
    assert all(call == calls[0] for call in calls)
    assert result.usage.cost == Fraction(1, 1000) and result.usage.reasoning_tokens == 10
    assert result.usage.input_tokens == 100 and result.usage.output_tokens == 40
    # Usage belongs to the accepted provider response, matching V5.3 provenance;
    # failed attempts with unavailable usage are not assigned fabricated costs.
    assert len(json.loads(calls[0])["messages"]) == 2
    assert set(json.loads(calls[0])) == {
        "model", "stream", "max_tokens", "provider", "response_format", "messages", "reasoning",
    }
    applied = apply_v6_edits(original, result.proposal)
    assert applied.texts == (
        "vâng vâng giữ nguyên và tình tiết trong Bí kíp luyện rồng",
        "con rồng được tha mạng; con rồng có gương mặt ấy", "đứt như chằn chắn",
    )
    assert applied.accepted_edit_count == 7 and applied.rejected_edit_count == 1
    assert dict(applied.rejection_reason_counts) == {"unsafe_length_change": 1}
    assert original.segments[0].text.startswith("vâng vâng giữa nguyên")
    for sensitive in ("rồng", "private-rejected-output", "synthetic-v6-key"):
        assert sensitive not in repr(outcome) + caplog.text
