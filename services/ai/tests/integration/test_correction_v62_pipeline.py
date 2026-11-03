"""One mock completion through the explicit experimental policy and Core proof."""

import json

import httpx
import pytest
from integration.test_correction_v6_worker import BINDING, MEDIA
from integration.test_correction_v61_pipeline import span_workflow as span_workflow
from integration.test_correction_v61_pipeline import v61_workflow as v61_workflow
from integration.test_correction_v61_pipeline import workflow as workflow
from integration.test_offline_transcription_pipeline import assert_released
from unit.test_correction import Provider, configuration, meeting
from unit.test_correction_v6 import edit
from unit.test_correction_v6 import offline_environment as offline_environment

from sme_meeting_ai.pipeline import OfflineTranscriptionPipeline
from sme_meeting_ai.providers.openrouter_instruction_llm_v62 import (
    OpenRouterInstructionLlmV62Adapter,
)
from sme_meeting_ai.transcription.correction import (
    CorrectionProvenance,
    CorrectionProviderResponse,
    CorrectionUsage,
    TranscriptCorrectionStatus,
)
from sme_meeting_ai.transcription.correction_edit_review import _capture_edit_review
from sme_meeting_ai.transcription.correction_v6 import CORRECTION_V6_JSON_SCHEMA
from sme_meeting_ai.transcription.correction_v62 import V62_ENGINE_VERSION
from sme_meeting_ai.transcription.correction_v62_generation import (
    V62_PROMPT_VERSION,
    V62_SYSTEM_PROMPT,
)
from sme_meeting_ai.transcription.correction_v62_pipeline import correct_transcript_v62
from sme_meeting_ai.workers.transcription import map_result, validate_result_bytes


def test_explicit_v62_adapter_pipeline_review_versions_and_worker_proof(v61_workflow):
    h = v61_workflow(source_id=MEDIA, texts=("nhóm bàn về chày chuỗi rồi nói và mã JWT hôm nay", "cuộc họp giữ nguyên nội dung"),
                     OPENROUTER_API_KEY="synthetic-only", transcript_correction_reasoning_effort="medium")
    requests = []

    def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        assert body["messages"][0]["content"] == V62_SYSTEM_PROMPT
        assert body["reasoning"] == {"effort": "medium"}
        assert body["response_format"]["json_schema"]["schema"] == CORRECTION_V6_JSON_SCHEMA
        content = {"edits": [edit("chày chuỗi rồi nói", "trầy xước rồi nói"), edit("JWT", "JWS")]}
        return httpx.Response(200, json={"model": "test/resolved", "choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": json.dumps(content),
        }}]})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with OpenRouterInstructionLlmV62Adapter(h.settings, client) as provider:
            with _capture_edit_review() as review:
                outcome = OfflineTranscriptionPipeline(h.preprocessing, h.planner, h.transcriber, provider,
                                                       h.settings, correction_mode="v62_edits").run(h.source)
        assert not client.is_closed
    assert outcome.status.value == "COMPLETED_WITH_WARNINGS" and len(requests) == 1
    p = outcome.result.provenance
    assert p.correction_version == "6.2" and p.prompt_version == V62_PROMPT_VERSION
    assert p.effective_configuration["validator_version"] == V62_ENGINE_VERSION
    assert p.effective_configuration["correction_mode"] == "v62_edits"
    assert (p.proposed_edit_count, p.accepted_edit_count, p.rejected_edit_count) == (2, 1, 1)
    assert review.validated and review.rejection_reasons == (None, "protected_token")
    assert "trầy xước rồi nói" in outcome.result.segments[0].text
    assert "JWT" in outcome.result.segments[0].text
    wire = validate_result_bytes(map_result(outcome, h.settings, **BINDING), **BINDING)
    assert wire.contractVersion == "1.0" and wire.correctionProof.promptVersion == V62_PROMPT_VERSION
    assert wire.correctionProof.contextScope == "WHOLE_MEETING"
    assert_released(h)


@pytest.mark.parametrize("body", ["invalid", {"segments": []}])
def test_bad_generation_does_not_create_validation_decisions_or_fallback(body):
    original, coverage = meeting(("nội dung chày chuỗi rồi nói", "giữ nguyên cuộc họp"))
    provider = Provider(body)
    with _capture_edit_review() as review:
        outcome = correct_transcript_v62(original, coverage, provider, configuration(transcript_correction_max_attempts=1))
    assert outcome.status is TranscriptCorrectionStatus.FAILED and outcome.result is None
    assert len(provider.requests) == 1 and not review.validated and review.proposal is None


@pytest.mark.parametrize("version", ["4", "5", "6.1", "6.2"])
def test_experimental_provenance_preserves_version_aware_reason_and_count_validation(version):
    kwargs = dict(correction_version=version, prompt_version=V62_PROMPT_VERSION, provider="fake",
                  requested_model="test/model", resolved_model=None, effective_configuration={}, attempts=1,
                  usage=CorrectionUsage(), proposed_edit_count=1, rejected_edit_count=1,
                  rejection_reason_counts={"unsafe_phrase_contraction": 1})
    if version in ("6.1", "6.2"):
        assert CorrectionProvenance(**kwargs).rejected_edit_count == 1
    else:
        with pytest.raises(ValueError):
            CorrectionProvenance(**kwargs)
    kwargs["rejection_reason_counts"] = {"arbitrary-private-text": 1}
    with pytest.raises(ValueError):
        CorrectionProvenance(**kwargs)


def test_prompt_rechecks_occurrences_and_does_not_embed_review_target_dictionary():
    prompt = " ".join(V62_SYSTEM_PROMPT.split()).casefold()
    assert "every occurrence" in prompt and "unchanged occurrence" in prompt
    assert "smallest independently supported" in prompt and "one completion" in prompt
    assert "exact second occurrence is not required" in prompt
    assert "up to four source and four target tokens" in prompt
    assert "complete target phrase with its anchor must already occur" not in prompt
    assert "context takes priority" in prompt and "original context" in prompt
    assert V62_PROMPT_VERSION == "vi-whole-meeting-6.2.2"
    assert V62_SYSTEM_PROMPT.startswith("RÀ SOÁT CỤM TỪ TIẾNG VIỆT")
    for instruction in ("kết hợp từ", "phụ âm đầu", "kết quả", "ít thay đổi", "chưa chắc"):
        assert instruction in V62_SYSTEM_PROMPT
    for forbidden in ("rapport", "raccord", "danh con", "ranh con", "chằn chắn", "dây chằng",
                      "bắn dụng", "bắn rụng", "bắn trúng", "Bí kíp", "Running Man"):
        assert forbidden not in V62_SYSTEM_PROMPT


def test_contextual_acceptance_warns_without_inventing_rejections_and_preserves_core_proof(v61_workflow):
    texts = ("tập luyện có thể trật tay hoặc bong gân rồi phải nghỉ làm",
             "mình đứt như chằn chắn sau một va chạm rồi phải nghỉ buổi tập")
    h = v61_workflow(source_id=MEDIA, texts=texts)

    def complete(request):
        h.requests.append(request)
        return CorrectionProviderResponse(json.dumps({"edits": [edit(
            "đứt như chằn chắn", "đứt dây chằng", segment=1)]}), "fake", request.model)

    h.correction_callback = complete
    with _capture_edit_review() as review:
        outcome = OfflineTranscriptionPipeline(h.preprocessing, h.planner, h.transcriber, h.corrector,
                                               h.settings, correction_mode="v62_edits").run(h.source)
    assert outcome.status.value == "COMPLETED_WITH_WARNINGS"
    assert h.correction_calls == len(h.requests) == 1
    assert h.requests[0].system_prompt == V62_SYSTEM_PROMPT
    p = outcome.result.provenance
    assert p.accepted_edit_count == p.proposed_edit_count == 1
    assert p.rejected_edit_count == p.rejected_segment_count == 0 and dict(p.rejection_reason_counts) == {}
    assert p.effective_configuration["contextual_edit_count"] == 1
    assert review.validated and review.acceptance_bases[0].value == "injury_context"
    assert outcome.result.segments[1].text == texts[1].replace("đứt như chằn chắn", "đứt dây chằng")
    wire = validate_result_bytes(map_result(outcome, h.settings, **BINDING), **BINDING)
    assert wire.pipelineStatus == "COMPLETED_WITH_WARNINGS"
    assert wire.correctionProof.promptVersion == "vi-whole-meeting-6.2.2"
    assert [(w.stage, w.code) for w in wire.warnings] == [("CORRECTION", "completed-with-warnings")]
    assert outcome.result.coverage is outcome.evidence.coverage
    assert_released(h)


@pytest.mark.parametrize("wrong_alternative", [False, True])
def test_minimal_collocation_repairs_publish_independently_and_distant_alternative_is_not_forced(
    v61_workflow, wrong_alternative,
):
    texts = ("mọi người kể chuyện cho lũ danh con trong buổi họp này",
             "cảnh đó có người bắn dụng một vật đang bay trên cao")
    h = v61_workflow(source_id=MEDIA, texts=texts)
    entries = [edit("danh", "ranh"),
               edit("bắn dụng", "bắn trúng", segment=1) if wrong_alternative else edit("dụng", "rụng", segment=1)]

    def complete(request):
        h.requests.append(request)
        return CorrectionProviderResponse(json.dumps({"edits": entries}), "fake", request.model)

    h.correction_callback = complete
    with _capture_edit_review() as review:
        outcome = OfflineTranscriptionPipeline(h.preprocessing, h.planner, h.transcriber, h.corrector,
                                               h.settings, correction_mode="v62_edits").run(h.source)
    p = outcome.result.provenance
    assert h.correction_calls == len(h.requests) == p.attempts == 1
    assert h.requests[0].system_prompt == V62_SYSTEM_PROMPT
    assert outcome.result.segments[0].text == texts[0].replace("danh", "ranh")
    assert outcome.result.segments[1].text == (texts[1] if wrong_alternative else texts[1].replace("dụng", "rụng"))
    assert review.rejection_reasons == (None, "unsupported_phrase_alignment" if wrong_alternative else None)
    assert p.proposed_edit_count == 2 and p.accepted_edit_count == 2 - int(wrong_alternative)
    assert p.rejected_edit_count == int(wrong_alternative) and p.effective_configuration["contextual_edit_count"] == 0
    assert p.effective_configuration["validator_version"] == "vi-context-validation-6.2.1"
    assert outcome.result.coverage is outcome.evidence.coverage
    wire = validate_result_bytes(map_result(outcome, h.settings, **BINDING), **BINDING)
    assert wire.correctionProof.promptVersion == "vi-whole-meeting-6.2.2"
    assert wire.pipelineStatus == ("COMPLETED_WITH_WARNINGS" if wrong_alternative else "COMPLETED")
    assert_released(h)
