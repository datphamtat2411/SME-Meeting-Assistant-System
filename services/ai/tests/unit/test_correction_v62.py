"""Controlled lexical eligibility, not a real-provider discovery/accuracy score."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError, replace

import pytest

from sme_meeting_ai.transcription import correction_v62 as engine
from sme_meeting_ai.transcription.correction import CorrectionErrorCategory
from sme_meeting_ai.transcription.correction_edit_review import _capture_edit_review
from sme_meeting_ai.transcription.correction_v6 import (
    V6FailureReason,
    V6ValidationError,
    V6ValidationFailure,
)
from sme_meeting_ai.transcription.correction_v61 import apply_v61_edits
from sme_meeting_ai.transcription.correction_v62 import (
    V62_ENGINE_VERSION,
    apply_v62_edits,
)

from .test_correction_v6 import CONTEXT, PRIVATE, counts, edit, meeting, parse
from .test_correction_v6 import offline_environment as offline_environment


def apply(texts, entries, **limits):
    original = meeting(texts)
    before = replace(original)
    proposal = parse(original, entries)
    result = apply_v62_edits(original, proposal, **limits)
    assert original == before
    return result


@pytest.mark.parametrize("source,replacement", [
    ("lè", "lòe"), ("chày chuỗi rồi nói", "trầy xước rồi nói"),
    ("bắn dụng con dòng", "bắn rụng con rồng"),
    ("máy mi cờrô", "máy micrô"), ("dùng micro phone", "dùng microphone"),
    ("đứt chằn chắn", "đứt chằng"),
])
def test_new_classes_are_bounded_and_do_not_change_v61(source, replacement):
    texts = (f"nội dung {source} kết thúc", CONTEXT)
    original = meeting(texts)
    proposal = parse(original, [edit(source, replacement)])
    old = apply_v61_edits(original, proposal)
    assert old.rejected_edit_count == 1 and old.texts == texts
    result = apply_v62_edits(original, proposal)
    counts(result, 1, 1)
    assert result.texts == (texts[0].replace(source, replacement), CONTEXT)
    assert apply_v61_edits(original, proposal) == old


@pytest.mark.parametrize("source,replacement", [
    ("danh", "ranh"), ("bắn dụng", "bắn rụng"), ("con dòng", "con rồng"),
    ("chày chuỗi", "trầy xước"), ("rapport", "raccord"),
])
def test_existing_target_classes_still_accept_minimal_independent_edits(source, replacement):
    texts = (f"nội dung {source} kết thúc", CONTEXT)
    counts(apply(texts, [edit(source, replacement)]), 1, 1)


@pytest.mark.parametrize("source,replacement", [
    ("mạch ngầm", "chiến lược"), ("đứt như chằn chắn", "đứt dây chằng"),
    ("như chằn chắn", "dây chằng chéo"), ("đứt chằn chắn", "đứt chân trái"),
    ("họp ngày mai", "họp vào ngày mai"), ("giữ vâng vâng", "giữ vâng"),
    ("giữ buồn buồn", "giữ buồn"), ("giữ nghĩ nghỉ", "giữ nghĩ"),
    ("giữ không gian", "giữ có gian"), ("giữ 25 mẫu", "giữ 26 mẫu"),
    ("mã JWT lỗi", "mã JWS lỗi"), ("của Ngọc rồi", "của Phát rồi"),
    ("dùng micro, phone", "dùng microphone"), ("máy mi\ncờrô", "máy micrô"),
    ("chày chuỗi rồi nói nữa", "trầy xước rồi nói nữa"),
    ("bắn dụng con dòng rồi", "bắn rụng con rồng rồi"),
    ("lè", "la"), ("micro phone", "microphone"),
    ("dùng micro phone", "dùng microphone mới"),
])
def test_context_or_low_distance_does_not_license_unrelated_or_protected_rewrites(source, replacement):
    texts = (f"nội dung {source} kết thúc", CONTEXT)
    result = apply(texts, [edit(source, replacement)])
    assert result.texts == texts and result.rejected_edit_count == 1


def test_independence_protected_numbers_and_exact_review_decisions():
    texts = ("cái rapport và lũ danh con nói về chày chuỗi và mã JWT", CONTEXT)
    entries = [edit("rapport", "raccord"), edit("danh", "ranh"), edit("chày chuỗi", "trầy xước"),
               edit("JWT", "JWS"), edit("absent", "trầy xước")]
    with _capture_edit_review() as review:
        result = apply(texts, entries)
    counts(result, 5, 3, {"protected_token": 1, "unresolvable_span": 1}, 1)
    assert review.validated and review.rejection_reasons == (None, None, None, "protected_token", "unresolvable_span")
    assert tuple(candidate.source for candidate in review.proposal.edits) == tuple(e["source"] for e in entries)
    assert "rapport" not in repr(review) and "trầy xước" not in repr(review)
    # The same replacement is present in final text, but proposal index 4 was rejected.
    assert "trầy xước" in result.texts[0] and review.rejection_reasons[4] == "unresolvable_span"


@pytest.mark.parametrize("engine", [apply_v61_edits, apply_v62_edits])
def test_audit_uses_real_engine_overlap_decisions_and_cannot_change_public_results(engine):
    original = meeting(("nội dung chày chuỗi kết thúc", CONTEXT))
    proposal = parse(original, [edit("chày", "trầy"), edit("chày chuỗi", "trầy xước")])
    plain = engine(original, proposal)
    with _capture_edit_review() as review:
        captured = engine(original, proposal)
    assert captured == plain
    assert review.rejection_reasons == ("overlap_conflict", "overlap_conflict")
    assert review.validated


@pytest.mark.parametrize("final", [False, True])
def test_global_failure_publishes_no_accepted_audit_decision(final):
    texts = ("aaa aaa", "bbbb bbbb") if final else ("nội dung cuộc họp còn nguyên",)
    entries = ([edit("aaa", "Aaa!!"), edit("aaa", "Aaa!!", occurrence=1), edit("bbbb bbbb", "b", segment=1)]
               if final else [edit(texts[0], "tóm tắt")])
    original = meeting(texts)
    with _capture_edit_review() as review:
        with pytest.raises(V6ValidationError) as caught:
            apply_v62_edits(original, parse(original, entries),
                            min_text_ratio=0.1 if final else 0.65, max_text_ratio=1.1 if final else 1.5)
    assert caught.value.reason is (V6FailureReason.FINAL_INTEGRITY if final else V6FailureReason.PROPOSAL_INTEGRITY)
    assert not review.validated and review.rejection_reasons is None
    assert review.proposal is not None


def test_review_is_opt_in_nested_and_thread_isolated():
    def run(source):
        with _capture_edit_review() as review:
            apply((f"nội dung {source} kết thúc", CONTEXT), [edit(source, source.upper())])
        return review

    with _capture_edit_review() as outer:
        with ThreadPoolExecutor(max_workers=2) as executor:
            reviews = list(executor.map(run, ("rapport", "danh")))
        assert outer.proposal is None and not outer.validated
        with _capture_edit_review() as inner:
            apply(("nội dung danh kết thúc", CONTEXT), [edit("danh", "ranh")])
        assert inner.validated and outer.proposal is None
    assert [r.proposal.edits[0].source for r in reviews] == ["rapport", "danh"]
    assert PRIVATE not in repr(reviews)
    assert V62_ENGINE_VERSION == "vi-context-validation-6.2.1"


INJURY = "khi tập luyện có thể trật tay hoặc bong gân và mọi người phải nghỉ làm"
GARBLED = "mình đứt như chằn chắn sau một va chạm rồi phải nghỉ buổi tập"


@pytest.mark.parametrize("source,replacement,retained_anchor", [
    ("đứt như chằn chắn", "đứt dây chằng", ""), ("như chằn chắn", "dây chằng", "đứt "),
    ("gãy như sương", "gãy xương", ""), ("trật như khợp", "trật khớp", ""),
])
@pytest.mark.parametrize("evidence_first", [False, True])
def test_strong_original_injury_context_can_outweigh_one_distorted_component(
    source, replacement, retained_anchor, evidence_first,
):
    original_line = f"mình {retained_anchor}{source} sau một va chạm rồi phải nghỉ buổi tập"
    texts = (INJURY, original_line) if evidence_first else (original_line, INJURY)
    owner = int(evidence_first)
    original = meeting(texts)
    proposal = parse(original, [edit(source, replacement, segment=owner)])
    old = apply_v61_edits(original, proposal)
    assert old.rejected_edit_count == 1
    with _capture_edit_review() as review:
        result = apply_v62_edits(original, proposal)
    counts(result, 1, 1)
    assert result.texts[owner] == original_line.replace(source, replacement)
    assert result.contextual_edit_count == 1
    assert review.acceptance_bases[0].value == "injury_context"
    assert set(review.evidence_segment_ids[0]) == {"segment-000000", "segment-000001"}
    assert original.segments[owner].text == original_line
    with pytest.raises(FrozenInstanceError):
        result.contextual_edit_count = 0


@pytest.mark.parametrize("prefix", ["mình", "mình đứt."])
def test_narrow_contextual_edit_requires_an_action_anchor_in_the_same_clause(prefix):
    texts = (INJURY, f"{prefix} như chằn chắn sau một va chạm rồi phải nghỉ buổi tập")
    result = apply(texts, [edit("như chằn chắn", "dây chằng", segment=1)])
    assert result.texts == texts and result.contextual_edit_count == 0
    counts(result, 1, 0, {"unsafe_phrase_contraction": 1}, 1)


@pytest.mark.parametrize("texts", [
    (CONTEXT, "mình đứt như chằn chắn rồi nói tiếp"),
    ("chúng ta nói về trật tay và trật chân khi tập luyện", "mình đứt như chằn chắn rồi nói tiếp"),
    ("có va chạm và một tai nạn trong câu chuyện", "mình đứt như chằn chắn rồi nói tiếp"),
    ("mọi việc bị trật. Tay là một mục khác trong câu chuyện", GARBLED),
    ("trật tay do va chạm khi tập luyện", CONTEXT, CONTEXT, "mình đứt như chằn chắn rồi nói tiếp"),
])
def test_neutral_single_family_or_only_distant_context_does_not_license_the_same_replacement(texts):
    owner = len(texts) - 1
    result = apply(texts, [edit("đứt như chằn chắn", "đứt dây chằng", segment=owner)])
    assert result.texts == texts and result.rejected_edit_count == 1
    assert result.contextual_edit_count == 0


@pytest.mark.parametrize("source,replacement", [
    ("đứt như chằn chắn", "đứt dây chằng chéo"),
    ("đứt như chằn chắn", "đứt dây chằng trước"),
    ("đứt chân trái", "đứt dây chằng"),
    ("đứt như mạch ngầm", "đứt dây chằng"),
    ("đứt vâng chằn chắn", "đứt dây chằng"),
    ("đứt 25 chằn chắn", "đứt dây chằng"),
    ("đứt Ngọc chằn chắn", "đứt dây chằng"),
    ("đứt như như chắn", "đứt dây chằng"),
    ("đứt như chằn, chắn", "đứt dây chằng"),
])
def test_injury_context_does_not_bypass_specificity_anatomy_or_preservation_guards(source, replacement):
    texts = (INJURY, f"mình {source} sau một va chạm rồi phải nghỉ buổi tập")
    with _capture_edit_review() as review:
        result = apply(texts, [edit(source, replacement, segment=1)])
    assert result.texts == texts and result.rejected_edit_count == 1
    assert result.contextual_edit_count == 0 and review.acceptance_bases == {}


def test_proposed_words_cannot_manufacture_the_injury_evidence():
    texts = ("nhóm bàn về kế hoạch cuối tuần và cuộc họp trong buổi làm việc hôm nay", GARBLED)
    entries = [edit("đứt như chằn chắn", "đứt dây chằng", segment=1),
               edit("kế hoạch", "trật tay"), edit("cuộc họp", "bong gân")]
    result = apply(texts, entries)
    assert result.texts == texts and result.contextual_edit_count == 0
    assert result.accepted_edit_count == 0


def test_context_index_is_built_once_and_decisions_do_not_depend_on_audit_capture(monkeypatch):
    calls = []
    build = engine._build_injury_context

    def counted(context, originals):
        calls.append(True)
        return build(context, originals)

    monkeypatch.setattr(engine, "_build_injury_context", counted)
    texts = (INJURY, GARBLED, GARBLED)
    entries = [edit("đứt như chằn chắn", "đứt dây chằng", segment=i) for i in (1, 2)]
    result = apply(texts, entries)
    assert calls == [True] and result.contextual_edit_count == result.accepted_edit_count == 2
    with _capture_edit_review() as review:
        observed = apply(texts, entries)
    assert result == observed and review.validated
    assert len(review.acceptance_bases) == 2


def test_two_independent_context_families_can_be_in_the_same_original_segment():
    text = INJURY + ". " + GARBLED
    with _capture_edit_review() as review:
        result = apply((text,), [edit("đứt như chằn chắn", "đứt dây chằng")])
    assert result.contextual_edit_count == result.accepted_edit_count == 1
    assert review.evidence_segment_ids[0] == ("segment-000000",)


def test_context_cannot_bypass_the_configured_local_length_ratio():
    result = apply((INJURY, GARBLED), [edit("đứt như chằn chắn", "đứt dây chằng", segment=1)], min_text_ratio=0.9)
    assert result.texts == (INJURY, GARBLED) and result.contextual_edit_count == 0


def test_context_acceptance_is_not_reported_when_final_integrity_fails(monkeypatch):
    original = engine._v61._global_integrity

    def fail_final(*args, **kwargs):
        original(*args, **kwargs)
        if kwargs["final"]:
            raise V6ValidationError(V6ValidationFailure(CorrectionErrorCategory.SUSPICIOUS_OUTPUT,
                                                        V6FailureReason.FINAL_INTEGRITY))

    monkeypatch.setattr(engine._v61, "_global_integrity", fail_final)
    with _capture_edit_review() as review:
        with pytest.raises(V6ValidationError) as caught:
            apply((INJURY, GARBLED), [edit("đứt như chằn chắn", "đứt dây chằng", segment=1)])
    assert caught.value.reason is V6FailureReason.FINAL_INTEGRITY
    assert not review.validated and review.acceptance_bases == {} and review.evidence_segment_ids == {}
