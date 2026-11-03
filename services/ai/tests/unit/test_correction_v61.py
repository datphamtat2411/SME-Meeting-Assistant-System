"""Offline calibration/safety matrix; lexical eligibility is not semantic truth."""

import importlib
import os
import socket
import unicodedata
from dataclasses import FrozenInstanceError, replace

import pytest

from sme_meeting_ai.transcription import correction_v61 as engine
from sme_meeting_ai.transcription.correction import CorrectionErrorCategory
from sme_meeting_ai.transcription.correction_v6 import (
    CORRECTION_V6_JSON_SCHEMA,
    CORRECTION_V6_SCHEMA_NAME,
    V6CorrectionProposal,
    V6EditCandidate,
    V6EditResult,
    V6FailureReason,
    V6ValidationError,
    apply_v6_edits,
    parse_v6_proposal,
)
from sme_meeting_ai.transcription.correction_v61 import (
    V61_ENGINE_VERSION,
    apply_v61_edits,
)

from .test_correction_v6 import (
    CONTEXT,
    PRIVATE,
    counts,
    edit,
    meeting,
    parse,
    sanitized,
)

FILM = (
    "Ngày mai đoàn phim sẽ tiếp tục quay cảnh này.",
    "Nếu gương mặt diễn viên bị trầy xước thì sẽ sai cái rapport của phim.",
    "Bộ phận hóa trang phải giữ ngoại hình nhân vật nhất quán giữa các cảnh quay.",
)
CUSTOMERS = (
    "Chúng ta đang nói về quan hệ khách hàng và sự tin tưởng.",
    "Nhân viên cần xây dựng rapport với khách hàng.",
    "Mối quan hệ tốt giúp hai bên giao tiếp cởi mở.",
)


@pytest.fixture(autouse=True)
def offline_environment(monkeypatch):
    monkeypatch.setattr(os, "environ", {})

    def forbidden(*args, **kwargs):
        pytest.fail("V6.1 must operate offline")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)


def invoke(reconciliation, edits, **limits):
    return apply_v61_edits(reconciliation, parse(reconciliation, edits), **limits)


def local_case(source, replacement):
    # Neutral intact speech keeps local rejection tests below the global gates.
    return meeting((f"nội dung {source} kết thúc", CONTEXT, CONTEXT)), [edit(source, replacement)]


def rejected(source, replacement, reason):
    reconciliation, entries = local_case(source, replacement)
    result = invoke(reconciliation, entries)
    assert result.texts == tuple(segment.text for segment in reconciliation.segments)
    counts(result, 1, 0, {reason: 1}, 1)
    return result


def test_engine_marker_and_existing_sparse_schema_are_unchanged():
    assert V61_ENGINE_VERSION == "vi-context-validation-6.1"
    assert CORRECTION_V6_SCHEMA_NAME == "vi-span-edits-v1"
    item = CORRECTION_V6_JSON_SCHEMA["properties"]["edits"]["items"]
    assert set(item["properties"]) == set(item["required"]) == {
        "segment_id", "source", "replacement", "occurrence",
    }
    assert item["additionalProperties"] is False
    reconciliation = meeting(FILM)
    proposal = parse(reconciliation, [edit("rapport", "raccord", segment=1)])
    assert type(proposal) is V6CorrectionProposal
    assert type(proposal.edits[0]) is V6EditCandidate
    assert type(apply_v61_edits(reconciliation, proposal)) is V6EditResult
    with pytest.raises(V6ValidationError) as caught:
        parse(reconciliation, [{**edit("rapport", "raccord", segment=1), "confidence": 1}])
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("source,replacement", [
    ("dòng", "rồng"), ("dụng", "rụng"), ("thà", "tha"), ("giữa", "giữ"),
    ("tinh", "tình"), ("mương", "gương"), ("băng", "bong"),
    ("bắn dụng", "bắn rụng"), ("con dòng", "con rồng"),
    ("Bí kíp luyện dòng", "Bí kíp luyện rồng"),
    ("vâng vâng", "Vâng, vâng."), ("ừ", "Ừ..."), ("API", "api"),
    ("OAuth", "oauth"), ("con dòng", "Con, dòng!"),
])
def test_legacy_accepted_patches_remain_identically_accepted(source, replacement):
    reconciliation, entries = local_case(source, replacement)
    proposal = parse(reconciliation, entries)
    legacy = apply_v6_edits(reconciliation, proposal)
    result = apply_v61_edits(reconciliation, proposal)
    counts(legacy, 1, 1)
    assert result == legacy
    assert result.texts[0] == reconciliation.segments[0].text.replace(source, replacement)


@pytest.mark.parametrize("source,replacement,legacy_reason,new_reason", [
    ("rapport", "raccord", "unsupported_lexical_change", None),
    ("chày chuỗi", "trầy xước", "unsupported_lexical_change", None),
    ("bắn dụng", "bắn rụng", None, None),
    ("con dòng", "con rồng", None, None),
    ("đứt như chằn chắn", "đứt dây chằng", "unsafe_length_change", "unsafe_phrase_contraction"),
    ("mạch ngầm", "chiến lược", "unsupported_lexical_change", "unsupported_phrase_alignment"),
    ("không đồng ý", "đồng ý", "unsafe_length_change", "protected_token"),
])
def test_reported_v6_and_v61_outcomes_are_measured(source, replacement, legacy_reason, new_reason):
    reconciliation, entries = local_case(source, replacement)
    proposal = parse(reconciliation, entries)
    for result, reason in ((apply_v6_edits(reconciliation, proposal), legacy_reason),
                           (apply_v61_edits(reconciliation, proposal), new_reason)):
        counts(result, 1, int(reason is None), {reason: 1} if reason else {}, int(reason is not None))
        expected = reconciliation.segments[0].text
        if reason is None:
            expected = expected.replace(source, replacement)
        assert result.texts[0] == expected


@pytest.mark.parametrize("texts", [(), ("",), (" ",), FILM, CUSTOMERS, ("con dòng", "thà mạng")])
def test_no_proposal_never_creates_a_correction(texts):
    reconciliation = meeting(texts)
    result = invoke(reconciliation, [])
    assert result.texts == texts
    counts(result, 0, 0)


def test_explicit_rare_terminology_proposal_needs_no_verbatim_target_elsewhere():
    reconciliation = meeting(FILM)
    assert all("raccord" not in segment.text for segment in reconciliation.segments)
    before, originals = replace(reconciliation), reconciliation.segments
    proposal = parse(reconciliation, [edit("rapport", "raccord", segment=1)])
    legacy = apply_v6_edits(reconciliation, proposal)
    counts(legacy, 1, 0, {"unsupported_lexical_change": 1}, 1)
    result = apply_v61_edits(reconciliation, proposal)
    assert result.texts == (FILM[0], FILM[1].replace("rapport", "raccord"), FILM[2])
    counts(result, 1, 1)
    assert reconciliation == before and reconciliation.segments is originals
    # Calling V6 after V6.1 must still use the original policy.
    assert apply_v6_edits(reconciliation, proposal) == legacy


def test_contextually_wrong_but_lexically_plausible_proposal_is_a_known_limitation():
    # Deliberately document the residual risk instead of faking domain inference.
    reconciliation = meeting(CUSTOMERS)
    result = invoke(reconciliation, [edit("rapport", "raccord", segment=1)])
    counts(result, 1, 1)
    assert result.texts[1] == CUSTOMERS[1].replace("rapport", "raccord")
    assert invoke(reconciliation, []).texts == CUSTOMERS


@pytest.mark.parametrize("source,replacement", [
    ("rapport", "raccord"), ("fotocopy", "photocopy"),
    ("grafik", "graphic"), ("telefone", "telephone"), ("fone", "phone"),
])
def test_latin_loanword_spelling_matrix_uses_general_bounded_rules(source, replacement):
    reconciliation, entries = local_case(source, replacement)
    result = invoke(reconciliation, entries)
    assert result.texts[0] == reconciliation.segments[0].text.replace(source, replacement)
    counts(result, 1, 1)


@pytest.mark.parametrize("replacement,reason", [
    ("điện ảnh", "unsafe_expansion"), ("kịch bản", "unsafe_expansion"),
    ("relationship", "insufficient_lexical_similarity"),
    ("support", "insufficient_lexical_similarity"),
    ("répertoire", "insufficient_lexical_similarity"),
])
def test_unrelated_terminology_is_not_licensed_by_context(replacement, reason):
    reconciliation = meeting(CUSTOMERS)
    result = invoke(reconciliation, [edit("rapport", replacement, segment=1)])
    assert result.texts == CUSTOMERS
    counts(result, 1, 0, {reason: 1}, 1)


@pytest.mark.parametrize("source,replacement", [
    ("meeting", "meaning"), ("report", "repeat"), ("support", "suppose"),
    ("rapport", "rасcord"),  # Two Cyrillic lookalikes are not Latin graphemes.
])
def test_meaning_changing_neighbors_and_mixed_script_spoofs_need_more_than_distance(source, replacement):
    rejected(source, replacement, "insufficient_lexical_similarity")


@pytest.mark.parametrize("source,replacement", [
    ("chày chuỗi", "trầy xước"), ("chầy xướt", "trầy xước"),
    ("chăn chở", "trăn trở"), ("dõ dàng", "rõ ràng"),
    ("băng gâng", "bong gân"), ("chày chuỗi nặng", "trầy xước nặng"),
    ("rõ chày chuỗi", "rõ trầy xước"),
])
def test_short_phrase_matrix_preserves_neighbors_and_originals(source, replacement):
    original = f"gương mặt mà nó bị {source}, rồi nói tiếp."
    reconciliation = meeting((original, CONTEXT))
    before = replace(reconciliation)
    entries = [edit(source, replacement)]
    counts(apply_v6_edits(reconciliation, parse(reconciliation, entries)),
           1, 0, {"unsupported_lexical_change": 1}, 1)
    results = [invoke(reconciliation, entries) for _ in range(3)]
    assert all(result == results[0] for result in results)
    assert results[0].texts == (original.replace(source, replacement), CONTEXT)
    counts(results[0], 1, 1)
    assert reconciliation == before


@pytest.mark.parametrize("source,replacement,reason", [
    ("mạch ngầm", "chiến lược", "unsupported_phrase_alignment"),
    ("con dòng", "loài rồng", "unsupported_phrase_alignment"),
    ("hôm nay họp", "hôm nay nghỉ", "unsupported_phrase_alignment"),
    ("kiểm tra hệ thống", "triển khai giải pháp", "unsupported_lexical_change"),
    ("tôi đồng ý", "tôi tán thành hoàn toàn", "protected_token"),
    ("chăn chở dàng", "trăn trở ràng", "unsupported_phrase_alignment"),
    ("chày chuỗi", "trầy xước nhẹ", "unsafe_expansion"),
    ("tôi đồng ý", "tôi hoàn toàn đồng ý", "unsafe_expansion"),
    ("họp ngày mai", "họp vào sáng ngày mai", "unsafe_expansion"),
])
def test_paraphrase_and_unanchored_expansion_matrix(source, replacement, reason):
    rejected(source, replacement, reason)


@pytest.mark.parametrize("source,replacement", [
    ("rapport,", "raccord."), ("chày, chuỗi", "trầy xước"),
    ("chày chuỗi!", "trầy xước?"), ("chày\nchuỗi", "trầy xước"),
])
def test_relaxation_cannot_rewrite_attached_or_sentence_punctuation(source, replacement):
    rejected(source, replacement, "unsupported_phrase_alignment")


def test_uncorroborated_interview_contraction_is_safely_rejected():
    source = "đứt như chằn chắn"
    original = f"Rồi mình {source} hay là mình bị một cái va chạm"
    reconciliation = meeting((original, CONTEXT))
    entries = [edit(source, "đứt dây chằng")]
    legacy = apply_v6_edits(reconciliation, parse(reconciliation, entries))
    counts(legacy, 1, 0, {"unsafe_length_change": 1}, 1)
    result = invoke(reconciliation, entries)
    assert result.texts == (original, CONTEXT)
    counts(result, 1, 0, {"unsafe_phrase_contraction": 1}, 1)


@pytest.mark.parametrize("evidence_first", [False, True])
@pytest.mark.parametrize("source,replacement,evidence", [
    ("máy mi cờrô", "máy micrô", "kiểm tra máy micrô đang bật"),
    ("máy mi crrô", "máy micrô", "kiểm tra máy micrô đang bật"),
    ("dùng micro phone", "dùng microphone", "tôi dùng microphone hôm nay"),
    ("dùng microphone", "dùng micro phone", "tôi dùng micro phone hôm nay"),
])
def test_originally_corroborated_split_merge_is_supported(evidence_first, source, replacement, evidence):
    original = f"kiểm tra {source} rồi nói tiếp"
    texts = (evidence, original) if evidence_first else (original, evidence)
    owner = int(evidence_first)
    result = invoke(meeting(texts), [edit(source, replacement, segment=owner)])
    expected = list(texts)
    expected[owner] = original.replace(source, replacement)
    assert result.texts == tuple(expected)
    counts(result, 1, 1)


@pytest.mark.parametrize("source,replacement", [
    ("máy mi cờrô", "máy micrô"), ("dùng micro phone", "dùng microphone"),
    ("dùng microphone", "dùng micro phone"),
])
def test_boundary_repair_requires_original_independent_anchored_evidence(source, replacement):
    rejected(source, replacement, "insufficient_context_evidence")
    original = f"{source} rồi nhắc {replacement}"
    result = invoke(meeting((original, CONTEXT)), [edit(source, replacement)])
    assert result.texts[0] == original
    counts(result, 1, 0, {"insufficient_context_evidence": 1}, 1)


@pytest.mark.parametrize("evidence", [
    "micrô đang bật", "máy. micrô đang bật", "máy\nmicrô đang bật", "máy micrồ đang bật",
])
def test_unanchored_punctuated_or_different_accent_evidence_is_insufficient(evidence):
    original = "hãy kiểm tra máy mi cờrô rồi nói"
    result = invoke(meeting((original, evidence)), [edit("máy mi cờrô", "máy micrô")])
    assert result.texts == (original, evidence)
    counts(result, 1, 0, {"insufficient_context_evidence": 1}, 1)


def test_accepted_edits_cannot_create_independent_corroboration():
    texts = ("hãy kiểm tra máy mi cờrô rồi nói", "máy micrồ đang bật")
    entries = [edit("máy mi cờrô", "máy micrô"), edit("micrồ", "micrô", segment=1)]
    for order in (entries, list(reversed(entries))):
        result = invoke(meeting(texts), order)
        assert result.texts == (texts[0], "máy micrô đang bật")
        counts(result, 2, 1, {"insufficient_context_evidence": 1}, 1)
    source = "kiểm tra máy mi cờrô đang bật"
    result = invoke(meeting((source, source)), [
        edit("máy mi cờrô", "máy micrô"), edit("máy mi cờrô", "máy micrô", segment=1),
    ])
    counts(result, 2, 0, {"insufficient_context_evidence": 2}, 2)


@pytest.mark.parametrize("source,replacement", [
    ("vâng vâng", "vâng"), ("ờ ờ", "ờ"), ("tôi tôi nghĩ", "tôi nghĩ"),
    ("dùng micro micro", "dùng micromicro"), ("máy ờ micrô", "máy micrô"),
    ("tôi rất đồng ý", "tôi đồng ý"),
])
def test_corroboration_never_licenses_filler_repetition_or_meaningful_word_deletion(source, replacement):
    original = f"nội dung {source} kết thúc"
    evidence = f"nội dung {replacement} kết thúc"
    result = invoke(meeting((original, evidence, CONTEXT)), [edit(source, replacement)])
    assert result.texts == (original, evidence, CONTEXT)
    assert result.accepted_edit_count == 0
    assert set(result.rejection_reason_counts) <= {"protected_token", "unsafe_phrase_contraction"}
    assert result.rejected_edit_count == sum(result.rejection_reason_counts.values()) == 1


@pytest.mark.parametrize("source,replacement", [
    ("không đồng ý", "đồng ý"), ("chưa hoàn thành", "đã hoàn thành"),
    ("trước cuộc họp", "sau cuộc họp"), ("có", "không"), ("sẽ", "đã"),
    ("10", "11"), ("1,5", "1.5"), ("-10", "10"), ("2026", "2027"),
    ("03/11/2026", "04/11/2026"), ("10:30", "10:31"),
    ("API-v1", "API-v2"), ("JWT", "JWS"), ("OAuth", "OAut"),
    ("C++", "C#"), ("user_name", "user_nam"), ("Minh", "Mình"),
    ("rapport JWT", "raccord JWS"), ("rapport Minh", "raccord Mình"),
    ("rapport API-v1", "raccord API-v2"), ("rapport C++", "raccord C#"),
    ("rapport có", "raccord cỏ"), ("chưa chày chuỗi", "đã trầy xước"),
    ("rapport trước", "raccord sau"), ("rapport ờ", "raccord ừ"),
    ("rapport một", "raccord mốt"), ("rapport phải", "raccord phái"),
])
def test_protected_speech_cannot_hide_after_an_early_lexical_rejection(source, replacement):
    rejected(source, replacement, "protected_token")


def test_protected_tokens_inside_boundary_wrappers_cannot_be_split_or_fused():
    for source, replacement in [
        ("dùng APIv1", "dùng API v1"), ("dùng JWT token", "dùng JWTtoken"),
        ("dùng C++ code", "dùng C+ code"), ("dùng Minh An", "dùng MinhAn"),
        ("dùng không rõ", "dùng khôngrõ"),
    ]:
        original = f"nội dung {source} kết thúc"
        evidence = f"nội dung {replacement} kết thúc"
        result = invoke(meeting((original, evidence, CONTEXT)), [edit(source, replacement)])
        assert result.texts == (original, evidence, CONTEXT)
        counts(result, 1, 0, {"protected_token": 1}, 1)


def test_legacy_independently_corroborated_name_rules_remain_available():
    texts = ("hôm nay chị Mai Hải Vânn sẽ trình bày", "mời Mai Hải Vân nói tiếp")
    reconciliation = meeting(texts)
    proposal = parse(reconciliation, [edit("Vânn", "Vân")])
    result = apply_v61_edits(reconciliation, proposal)
    assert result == apply_v6_edits(reconciliation, proposal)
    counts(result, 1, 1)
    # New lexical relaxation cannot borrow this waiver for a multi-change patch.
    source = "rapport Vânn"
    result = invoke(meeting((source, "raccord Vân", CONTEXT)), [edit(source, "raccord Vân")])
    counts(result, 1, 0, {"protected_token": 1}, 1)


@pytest.mark.parametrize("occurrence,expected", [
    (0, "cái raccord và cái rapport"), (1, "cái rapport và cái raccord"),
])
def test_occurrence_indices_resolve_literal_original_spans(occurrence, expected):
    result = invoke(meeting(("cái rapport và cái rapport", CONTEXT)),
                    [edit("rapport", "raccord", occurrence=occurrence)])
    assert result.texts == (expected, CONTEXT)
    counts(result, 1, 1)


@pytest.mark.parametrize("source,occurrence", [("Rapport", 0), ("rapport", 2), ("cái  rapport", 0)])
def test_unresolvable_spans_do_not_gain_fuzzy_source_matching(source, occurrence):
    original = "cái rapport và cái rapport"
    result = invoke(meeting((original, CONTEXT)), [edit(source, "raccord", occurrence=occurrence)])
    assert result.texts == (original, CONTEXT)
    counts(result, 1, 0, {"unresolvable_span": 1}, 1)


def test_segment_identity_original_order_and_all_metadata_survive():
    texts = ("cái rapport", "gương mặt bị chày chuỗi", "con dòng")
    reconciliation = meeting(texts)
    before, originals = replace(reconciliation), reconciliation.segments
    entries = [edit("rapport", "raccord"), edit("chày chuỗi", "trầy xước", segment=1),
               edit("dòng", "rồng", segment=2)]
    result = invoke(reconciliation, entries)
    assert result.texts == ("cái raccord", "gương mặt bị trầy xước", "con rồng")
    counts(result, 3, 3)
    assert reconciliation == before and reconciliation.segments is originals
    assert all(segment is originals[index] for index, segment in enumerate(reconciliation.segments))
    with pytest.raises(V6ValidationError) as caught:
        invoke(reconciliation, [edit("rapport", "raccord", segment=3)])
    assert caught.value.reason is V6FailureReason.UNKNOWN_SEGMENT


@pytest.mark.parametrize("entries,conflicts", [
    ([edit("rapport", "raccord"), edit("rapport", "raccord")], 2),
    ([edit("cái rapport", "cái raccord"), edit("rapport", "raccord")], 2),
    ([edit("cái rapport", "cái raccord"), edit("rapport và", "raccord và"),
      edit("và cái", "và Cái")], 3),
])
def test_all_overlap_participants_are_rejected_without_losing_independent_edits(entries, conflicts):
    original = "cái rapport và cái khác; chày chuỗi"
    reconciliation = meeting((original, CONTEXT))
    for order in (entries, list(reversed(entries))):
        result = invoke(reconciliation, [*order, edit("chày chuỗi", "trầy xước")])
        assert result.texts == (original.replace("chày chuỗi", "trầy xước"), CONTEXT)
        counts(result, conflicts + 1, 1, {"overlap_conflict": conflicts}, 1)


def test_adjacent_variable_length_patches_and_independent_segment_order_are_deterministic():
    context = "Trong cuộc họp hôm nay chúng ta cùng xem lại nội dung bản ghi trước khi trao đổi: "
    texts = (context + "giữa nguyên, chày chuỗi; cái rapport", "con dòng")
    entries = [edit("giữa nguyên,", "giữ nguyên,"), edit(" chày chuỗi;", " trầy xước;"),
               edit("rapport", "raccord"), edit("dòng", "rồng", segment=1)]
    reconciliation = meeting(texts)
    before, originals = replace(reconciliation), reconciliation.segments
    results = [invoke(reconciliation, order) for order in (entries, entries, list(reversed(entries)))]
    assert results[0].texts == (context + "giữ nguyên, trầy xước; cái raccord", "con rồng")
    assert all(result == results[0] for result in results)
    counts(results[0], 4, 4)
    assert reconciliation == before and reconciliation.segments is originals
    assert all(segment is originals[index] for index, segment in enumerate(reconciliation.segments))


def test_replacements_cannot_be_sources_for_other_proposals():
    original = "cái rapport và con dòng"
    result = invoke(meeting((original, CONTEXT)), [
        edit("rapport", "raccord"), edit("raccord", "record"), edit("dòng", "rồng"),
    ])
    assert result.texts == ("cái raccord và con rồng", CONTEXT)
    counts(result, 3, 2, {"unresolvable_span": 1}, 1)


def test_phrase_spans_cannot_cross_original_segment_boundaries():
    texts = ("gương mặt bị chày", "chuỗi rồi nói", CONTEXT)
    result = invoke(meeting(texts), [edit("chày chuỗi", "trầy xước")])
    assert result.texts == texts
    counts(result, 1, 0, {"unresolvable_span": 1}, 1)


def test_nfc_nfd_comparison_does_not_change_literal_offsets_or_output():
    original = unicodedata.normalize("NFD", "gương mặt bị chày chuỗi rồi nói")
    literal = unicodedata.normalize("NFD", "chày chuỗi")
    replacement = unicodedata.normalize("NFD", "trầy xước")
    reconciliation = meeting((original, CONTEXT))
    miss = invoke(reconciliation, [edit("chày chuỗi", "trầy xước")])
    counts(miss, 1, 0, {"unresolvable_span": 1}, 1)
    result = invoke(reconciliation, [edit(literal, replacement)])
    assert result.texts == (original.replace(literal, replacement), CONTEXT)
    assert result.texts[0] != unicodedata.normalize("NFC", result.texts[0])
    counts(result, 1, 1)


@pytest.mark.parametrize("original,source,replacement", [
    ("cái rapport", "apport", "accord"),
    ("gương mặt chày chuỗi", "ày chuỗi", "ầy xước"),
    ("xchày chuỗi", "chày chuỗi", "trầy xước"),
    ("API-v1", "API", "APJ"),
    ("chày chuỗi_x", "chày chuỗi", "trầy xước"),
    ("cái rapport khác", " rapport", "raccord"),
    ("cái rapport khác", "rapport ", "raccord"),
    ("chày chuỗi tiếp", "chày chuỗi ", "trầy xước/"),
])
def test_partial_tokens_and_neighbor_fusion_remain_rejected(original, source, replacement):
    result = invoke(meeting((original, CONTEXT)), [edit(source, replacement)])
    assert result.texts == (original, CONTEXT)
    counts(result, 1, 0, {"partial_token": 1}, 1)


def test_early_lexical_rejection_does_not_bypass_neighboring_numeric_sign_protection():
    original = "cái rapport +10 hôm nay"
    result = invoke(meeting((original, CONTEXT)), [edit("rapport +", "raccord -")])
    assert result.texts == (original, CONTEXT)
    counts(result, 1, 0, {"protected_token": 1}, 1)


@pytest.mark.parametrize("source,replacement", [
    ("một hai", "một"), ("con dòng", "con dòng " * 5),
    ("con dòng", "con dòng" + "!" * 100),
    ("một hai ba bốn năm sáu bảy tám chín mười", "đỏ xanh tím vàng cam nâu đen trắng bạc hồng"),
])
def test_proposal_wide_integrity_precedes_any_local_acceptance(source, replacement, monkeypatch):
    reconciliation = meeting(tuple(source for _ in range(10)))
    entries = [edit(source, replacement, segment=index) for index in range(10)]

    def forbidden(*args, **kwargs):
        pytest.fail("local checks must not run before the proposal gate")

    monkeypatch.setattr(engine, "_local_rejection", forbidden)
    with pytest.raises(V6ValidationError) as caught:
        invoke(reconciliation, entries)
    sanitized(caught.value, CorrectionErrorCategory.SUSPICIOUS_OUTPUT, source, replacement)
    assert caught.value.reason is V6FailureReason.PROPOSAL_INTEGRITY


def test_high_rewrite_nonoverlapping_proposal_still_fails_global_integrity():
    # Each local correction is plausible, but five of eight original lexical
    # tokens change: 3/8 shared content must fail the inherited 50% global gate.
    texts = ("giữa nguyên, chày chuỗi; cái rapport", "con dòng")
    entries = [edit("giữa nguyên,", "giữ nguyên,"), edit(" chày chuỗi;", " trầy xước;"),
               edit("rapport", "raccord"), edit("dòng", "rồng", segment=1)]
    reconciliation = meeting(texts)
    before = replace(reconciliation)
    for order in (entries, list(reversed(entries))):
        with pytest.raises(V6ValidationError) as caught:
            invoke(reconciliation, order)
        sanitized(caught.value, CorrectionErrorCategory.SUSPICIOUS_OUTPUT)
        assert caught.value.reason is V6FailureReason.PROPOSAL_INTEGRITY
        assert str(caught.value) == "suspicious_output:proposal_integrity"
    assert reconciliation == before


def test_final_integrity_failure_never_returns_a_partial_result():
    texts = ("aaa aaa", "bbbb bbbb")
    entries = [edit("aaa", "Aaa!!", occurrence=0), edit("aaa", "Aaa!!", occurrence=1),
               edit("bbbb bbbb", "b", segment=1)]
    reconciliation = meeting(texts)
    with pytest.raises(V6ValidationError) as caught:
        invoke(reconciliation, entries, min_text_ratio=0.1, max_text_ratio=1.1)
    sanitized(caught.value, CorrectionErrorCategory.SUSPICIOUS_OUTPUT)
    assert caught.value.reason is V6FailureReason.FINAL_INTEGRITY
    assert tuple(segment.text for segment in reconciliation.segments) == texts


def test_independent_legacy_and_new_edits_survive_mixed_local_rejections():
    original = "cái rapport; chày chuỗi; con dòng; mã JWT; mạch ngầm"
    result = invoke(meeting((original, CONTEXT)), [
        edit("rapport", "raccord"), edit("chày chuỗi", "trầy xước"), edit("dòng", "rồng"),
        edit("JWT", "JWS"), edit("mạch ngầm", "chiến lược"), edit("absent", "replacement"),
        edit("cái", "cái"),
    ])
    assert result.texts == ("cái raccord; trầy xước; con rồng; mã JWT; mạch ngầm", CONTEXT)
    counts(result, 7, 3, {"protected_token": 1, "unsupported_phrase_alignment": 1,
                          "unresolvable_span": 1, "noop_edit": 1}, 1)


def test_empty_long_transcript_skips_all_context_and_similarity_work(monkeypatch):
    original = "nội dung cuộc họp được giữ nguyên. " * 20000
    reconciliation = meeting((original,))

    def forbidden(*args, **kwargs):
        pytest.fail("empty proposals need no context index or lexical comparison")

    monkeypatch.setattr(engine, "_make_context", forbidden)
    result = invoke(reconciliation, [])
    assert result.texts == (original,)
    counts(result, 0, 0)


@pytest.mark.parametrize("invalid", ["\ud800", "\x00", "\u202e", "\u200b"])
def test_manually_constructed_invalid_unicode_or_controls_are_sanitized(invalid, caplog):
    reconciliation = meeting((PRIVATE, CONTEXT))
    proposal = V6CorrectionProposal((V6EditCandidate("segment-000000", PRIVATE, PRIVATE + invalid, 0),))
    with pytest.raises(V6ValidationError) as caught:
        apply_v61_edits(reconciliation, proposal)
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT, invalid)
    assert PRIVATE not in caplog.text


@pytest.mark.parametrize("key,value", [
    ("min_text_ratio", 0), ("min_text_ratio", True), ("min_text_ratio", float("nan")),
    ("max_text_ratio", 0.9), ("max_text_ratio", float("inf")), ("max_text_ratio", None),
])
def test_ratio_limits_reuse_sanitized_v6_contract(key, value):
    with pytest.raises(V6ValidationError) as caught:
        apply_v61_edits(meeting(), V6CorrectionProposal(()), **{key: value})
    sanitized(caught.value, CorrectionErrorCategory.VALIDATION)
    assert caught.value.reason is V6FailureReason.INVALID_LIMITS


def test_invalid_reconciliation_and_direct_proposals_are_revalidated():
    reconciliation = meeting()
    bad_identity = replace(reconciliation.segments[0], ordinal=1)
    for source, proposal in [
        (None, V6CorrectionProposal(())),
        (replace(reconciliation, segments=(bad_identity,)), V6CorrectionProposal(())),
        (reconciliation, None),
    ]:
        with pytest.raises(V6ValidationError) as caught:
            apply_v61_edits(source, proposal)
        sanitized(caught.value, CorrectionErrorCategory.VALIDATION)
    proposal = V6CorrectionProposal((V6EditCandidate("segment-000000", "con", "Con", True),))
    with pytest.raises(V6ValidationError) as caught:
        apply_v61_edits(reconciliation, proposal)
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


def test_public_objects_and_internal_context_repr_never_expose_sensitive_text(caplog):
    reconciliation = meeting((PRIVATE + "; cái rapport; chày chuỗi; mã JWT", CONTEXT))
    proposal = parse(reconciliation, [edit("rapport", "raccord"), edit("chày chuỗi", "trầy xước"),
                                      edit("JWT", "JWS")])
    result = apply_v61_edits(reconciliation, proposal)
    counts(result, 3, 2, {"protected_token": 1}, 1)
    context = engine._make_context(reconciliation.segments, proposal.edits)
    rendered = repr(proposal) + repr(proposal.edits) + repr(result) + repr(context) + caplog.text
    for sensitive in (PRIVATE, "rapport", "raccord", "chày chuỗi", "trầy xước", "JWT", "JWS"):
        assert sensitive not in rendered
    for obj, name, value in ((proposal, "edits", ()), (proposal.edits[0], "source", "changed"),
                             (result, "texts", ()), (result, "accepted_edit_count", 99)):
        with pytest.raises(FrozenInstanceError):
            setattr(obj, name, value)
    with pytest.raises(TypeError):
        result.rejection_reason_counts["protected_token"] = 99
    with pytest.raises(TypeError):
        result.texts[0] = "changed"


@pytest.mark.parametrize("exception,category,reason", [
    (MemoryError(PRIVATE), CorrectionErrorCategory.RESOURCE, V6FailureReason.RESOURCE_EXHAUSTED),
    (RecursionError(PRIVATE), CorrectionErrorCategory.RESOURCE, V6FailureReason.RESOURCE_EXHAUSTED),
    (RuntimeError(PRIVATE), CorrectionErrorCategory.VALIDATION, V6FailureReason.INVALID_PROPOSAL),
])
def test_public_boundary_clears_arbitrary_exception_chains(monkeypatch, exception, category, reason):
    def fail(*args, **kwargs):
        raise exception

    monkeypatch.setattr(engine, "_original_segments", fail)
    with pytest.raises(V6ValidationError) as caught:
        apply_v61_edits(meeting(), V6CorrectionProposal(()))
    sanitized(caught.value, category)
    assert caught.value.reason is reason


def test_import_and_execution_have_no_network_or_provider_requirements():
    module = importlib.import_module("sme_meeting_ai.transcription.correction_v61")
    assert "OPENROUTER_API_KEY" not in os.environ
    reconciliation = meeting(FILM)
    result = module.apply_v61_edits(reconciliation, parse(reconciliation, [edit("rapport", "raccord", segment=1)]))
    counts(result, 1, 1)


def test_response_limit_stays_four_mib_and_parser_is_not_replaced():
    reconciliation = meeting()
    prefix = '{"edits":[]}'
    body = prefix + " " * (4 * 1024 * 1024 - len(prefix))
    assert apply_v61_edits(reconciliation, parse_v6_proposal(body, reconciliation)).texts == (CONTEXT,)
    with pytest.raises(V6ValidationError) as caught:
        parse_v6_proposal(body + " ", reconciliation)
    assert caught.value.reason is V6FailureReason.RESPONSE_SIZE


@pytest.mark.parametrize("field", ["source", "replacement"])
def test_inherited_edit_field_limit_is_256_unicode_code_points(field):
    reconciliation = meeting(("ừ" * 256, CONTEXT * 20))
    entry = {**edit("ừ", "Ừ"), field: "ừ" * 256}
    result = invoke(reconciliation, [entry])
    assert result.proposed_edit_count == 1
    with pytest.raises(V6ValidationError) as caught:
        invoke(reconciliation, [{**entry, field: "ừ" * 257}])
    assert caught.value.reason is V6FailureReason.FIELD_LENGTH


def test_per_segment_and_occurrence_limits_are_revalidated_at_apply_boundary():
    reconciliation = meeting(("cái rapport", CONTEXT))
    candidate = V6EditCandidate("segment-000000", "rapport", "raccord", 255)
    counts(apply_v61_edits(reconciliation, V6CorrectionProposal((candidate,))),
           1, 0, {"unresolvable_span": 1}, 1)
    counts(apply_v61_edits(reconciliation, V6CorrectionProposal((replace(candidate, occurrence=0),) * 32)),
           32, 0, {"overlap_conflict": 32}, 1)
    for edits, reason in [
        ((replace(candidate, occurrence=256),), V6FailureReason.OCCURRENCE_LIMIT),
        ((replace(candidate, occurrence=0),) * 33, V6FailureReason.SEGMENT_EDIT_COUNT),
    ]:
        with pytest.raises(V6ValidationError) as caught:
            apply_v61_edits(reconciliation, V6CorrectionProposal(edits))
        assert caught.value.reason is reason


def test_total_edit_limit_stays_8192():
    reconciliation = meeting(tuple("cái rapport" for _ in range(257)))
    entries = tuple(V6EditCandidate(f"segment-{index:06d}", "rapport", "raccord", 0)
                    for index in range(256) for _ in range(32))
    counts(apply_v61_edits(reconciliation, V6CorrectionProposal(entries)),
           8192, 0, {"overlap_conflict": 8192}, 256)
    with pytest.raises(V6ValidationError) as caught:
        apply_v61_edits(reconciliation, V6CorrectionProposal((*entries, entries[0])))
    assert caught.value.reason is V6FailureReason.EDIT_COUNT


def test_new_dynamic_programming_never_receives_an_unbounded_token(monkeypatch):
    original_distance = engine._bounded_distance
    calls = []

    def checked(source, target, limit):
        assert len(source) <= 24 and len(target) <= 24 and limit <= 3
        calls.append((len(source), len(target)))
        return original_distance(source, target, limit)

    monkeypatch.setattr(engine, "_bounded_distance", checked)
    source = "a" * 128 + "b" * 128
    target = "a" * 128 + "c" * 128
    rejected(source, target, "insufficient_lexical_similarity")
    assert calls == []
    reconciliation, entries = local_case("rapport", "raccord")
    counts(invoke(reconciliation, entries), 1, 1)
    assert calls


@pytest.mark.parametrize("source,replacement", [
    ("a chày chuỗi nặng", "a trầy xước nặng"),
    ("máy mi cờrô khác nữa", "máy micrô khác nữa"),
])
def test_complex_phrase_work_is_bounded_instead_of_searching_for_a_better_alignment(source, replacement):
    original = f"nội dung {source} kết thúc"
    evidence = f"nội dung {replacement} kết thúc"
    result = invoke(meeting((original, evidence, CONTEXT)), [edit(source, replacement)])
    assert result.texts == (original, evidence, CONTEXT)
    assert result.accepted_edit_count == 0 and result.rejected_edit_count == 1


@pytest.mark.parametrize("source,target,limit,expected", [
    ("rapport", "raccord", 3, 3), ("micro", "micoro", 1, 1),
    ("abc", "xyz", 1, 2), ("abc", "abc", 1, 0), ("a", "aaaa", 1, 2),
])
def test_distance_is_finite_and_returns_a_capped_rejection_sentinel(source, target, limit, expected):
    assert engine._bounded_distance(source, target, limit) == expected
