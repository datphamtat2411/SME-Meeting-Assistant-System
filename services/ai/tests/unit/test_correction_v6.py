"""Offline sparse-edit eligibility and fail-closed regression tests."""

import importlib
import json
import os
import socket
import traceback
import unicodedata
from dataclasses import FrozenInstanceError, replace

import pytest

from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.transcription.correction import CorrectionErrorCategory
from sme_meeting_ai.transcription.correction_v6 import (
    CORRECTION_V6_JSON_SCHEMA,
    CORRECTION_V6_SCHEMA_NAME,
    V6CorrectionProposal,
    V6EditCandidate,
    V6EditResult,
    V6FailureReason,
    V6ValidationError,
    V6ValidationFailure,
    apply_v6_edits,
    parse_v6_proposal,
)
from sme_meeting_ai.transcription.reconciliation import (
    ReconciledSegment,
    ReconciliationEvidenceIdentity,
    ReconciliationFlag,
    ReconciliationProvenance,
    TranscriptReconciliation,
)

from .test_reconciliation import plan

CONTEXT = "hôm nay chúng ta cùng kiểm tra nội dung cuộc họp và giữ lại đầy đủ lời nói"
PRIVATE = "nội dung riêng tư tuyệt đối không ghi vào chẩn đoán"


@pytest.fixture(autouse=True)
def offline_environment(monkeypatch):
    monkeypatch.setattr(os, "environ", {})

    def forbidden(*args, **kwargs):
        pytest.fail("V6 must not access the network")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)


def meeting(texts=(CONTEXT,)):
    """Use existing planning provenance, with intact synthetic original segments.

    Construct directly so empty ASR wording can also be exercised without running
    reconciliation, providers, or any part of the audio pipeline.
    """
    approved = plan(max(1, len(texts)))
    segments = []
    for index, text in enumerate(texts):
        interval = SampleInterval(index * 100, (index + 1) * 100)
        identity = ReconciliationEvidenceIdentity(f"chunk-{index:06d}", 0, interval)
        segments.append(ReconciledSegment(
            interval, text, (identity.chunk_id,),
            (ReconciliationFlag.UNRESOLVED_BOUNDARY,), ("private alternative",),
            f"segment-{index:06d}", index, identity, (identity,), (),
        ))
    return TranscriptReconciliation(
        approved.source_id, approved.sample_count, tuple(segments), (), (),
        ReconciliationProvenance("2", approved.provenance, {}, (), approved.chunks),
    )


def edit(source, replacement, *, segment=0, occurrence=0):
    return {"segment_id": f"segment-{segment:06d}", "source": source,
            "replacement": replacement, "occurrence": occurrence}


def parse(reconciliation, edits):
    return parse_v6_proposal(json.dumps({"edits": edits}, ensure_ascii=True), reconciliation)


def invoke(reconciliation, edits, **limits):
    return apply_v6_edits(reconciliation, parse(reconciliation, edits), **limits)


def counts(result, proposed, accepted, reasons=None, segments=0):
    assert result.proposed_edit_count == proposed
    assert result.accepted_edit_count == accepted
    assert result.rejected_edit_count == proposed - accepted
    assert result.rejected_segment_count == segments
    assert dict(result.rejection_reason_counts) == (reasons or {})
    assert sum(result.rejection_reason_counts.values()) == result.rejected_edit_count


def sanitized(error, category, *sensitive):
    assert isinstance(error, V6ValidationError)
    assert isinstance(error.failure, V6ValidationFailure)
    assert error.category is error.failure.category is category
    assert isinstance(error.reason, V6FailureReason)
    assert error.__cause__ is None and error.__context__ is None
    rendered = str(error) + repr(error) + repr(error.failure) + "".join(traceback.format_exception(error))
    for text in (PRIVATE, *sensitive):
        assert text not in rendered


def test_reusable_strict_schema_has_the_exact_sparse_contract():
    assert CORRECTION_V6_SCHEMA_NAME == "vi-span-edits-v1"
    schema = json.loads(json.dumps(CORRECTION_V6_JSON_SCHEMA))
    assert schema["type"] == "object"
    assert schema["required"] == ["edits"]
    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"edits"}
    edits = schema["properties"]["edits"]
    assert edits["type"] == "array"
    item = edits["items"]
    assert item["type"] == "object" and item["additionalProperties"] is False
    assert set(item["required"]) == set(item["properties"]) == {
        "segment_id", "source", "replacement", "occurrence",
    }
    for name in ("segment_id", "source", "replacement"):
        assert item["properties"][name]["type"] == "string"
    assert item["properties"]["occurrence"]["type"] == "integer"
    assert item["properties"]["occurrence"]["minimum"] == 0


@pytest.mark.parametrize("texts", [(), ("",), (" ",), (CONTEXT,), ("con dòng", "thà mạng")])
def test_empty_proposals_preserve_every_original_position(texts):
    reconciliation = meeting(texts)
    proposal = parse_v6_proposal('{"edits":[]}', reconciliation)
    assert isinstance(proposal, V6CorrectionProposal) and proposal.edits == ()
    result = apply_v6_edits(reconciliation, proposal)
    assert isinstance(result, V6EditResult)
    assert result.texts == texts
    counts(result, 0, 0)


@pytest.mark.parametrize("body", [
    "", "not json " + PRIVATE, '{"edits":[', '{"edits":[],}',
    '```json\n{"edits":[]}\n```', '{"edits":[]} explanation',
    '{"edits":[],"edits":[]}',
    '{"edits":[{"segment_id":"segment-000000","source":"con","source":"con",'
    '"replacement":"Con","occurrence":0}]}',
    '{"edits":NaN}', '{"edits":Infinity}', '{"edits":-Infinity}',
    '[]', 'null', '{"edits":{}}', '{"edits":null}', '{"edits":""}',
    '{"edits":[],"segments":[]}', '{"edits":[],"coverage":{}}',
    '{"edits":[false]}', '{"edits":[[]]}',
])
def test_malformed_envelopes_are_sanitized(body, caplog):
    reconciliation = meeting((PRIVATE,))
    with pytest.raises(V6ValidationError) as caught:
        parse_v6_proposal(body, reconciliation)
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)
    assert PRIVATE not in caplog.text


@pytest.mark.parametrize("field", ["segment_id", "source", "replacement", "occurrence"])
def test_missing_edit_fields_are_rejected(field):
    entry = edit("con", "Con")
    del entry[field]
    with pytest.raises(V6ValidationError) as caught:
        parse(meeting(("con dòng",)), [entry])
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("field,value", [
    ("segment_id", None), ("segment_id", 0), ("segment_id", "unknown-" + PRIVATE),
    ("source", None), ("source", []), ("source", 12), ("source", ""),
    ("replacement", False), ("replacement", {}), ("replacement", ""),
    ("occurrence", True), ("occurrence", False), ("occurrence", -1),
    ("occurrence", 0.0), ("occurrence", "0"), ("occurrence", None),
    ("occurrence", float("inf")), ("occurrence", float("nan")),
    ("ordinal", 0), ("start_sample", 0), ("end_sample", 100),
    ("source_chunk_ids", []), ("provenance", {}), ("flags", []),
    ("confidence", 1), ("text", PRIVATE), ("rationale", PRIVATE),
])
def test_invalid_fields_types_and_server_metadata_fail_structurally(field, value):
    entry = {**edit("con", "Con"), field: value}
    with pytest.raises(V6ValidationError) as caught:
        parse(meeting(("con dòng",)), [entry])
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("body", [None, b'{"edits":[]}', [], 1, True])
def test_response_must_be_a_string(body):
    with pytest.raises(V6ValidationError) as caught:
        parse_v6_proposal(body, meeting())
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("field", ["source", "replacement", "segment_id"])
@pytest.mark.parametrize("invalid", ["\ud800", "\udfff", "\ud800x", "\udfff\ud800"])
def test_escaped_invalid_unicode_is_rejected_in_every_string_field(field, invalid):
    with pytest.raises(V6ValidationError) as caught:
        parse(meeting(), [{**edit("nội dung", PRIVATE), field: invalid}])
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT, invalid)


def test_literal_invalid_unicode_is_sanitized_before_utf8_accounting():
    with pytest.raises(V6ValidationError) as caught:
        parse_v6_proposal('{"edits":[]}\ud800' + PRIVATE, meeting())
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


@pytest.mark.parametrize("control", ["\x00", "\x1b", "\x7f", "\x85", "\u202e", "\u200b"])
@pytest.mark.parametrize("field", ["source", "replacement"])
def test_unsafe_control_characters_are_rejected(control, field):
    with pytest.raises(V6ValidationError) as caught:
        parse(meeting(), [{**edit("nội dung", "Nội dung"), field: "nội" + control + "dung"}])
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


def test_response_size_is_bounded_in_utf8_bytes_without_truncation():
    reconciliation = meeting()
    prefix = '{"edits":[]}'
    at_limit = prefix + " " * (4 * 1024 * 1024 - len(prefix))
    assert parse_v6_proposal(at_limit, reconciliation).edits == ()
    for body in (at_limit + " ", "ừ" * (2 * 1024 * 1024)):
        with pytest.raises(V6ValidationError) as caught:
            parse_v6_proposal(body, reconciliation)
        sanitized(caught.value, CorrectionErrorCategory.RESOURCE)


@pytest.mark.parametrize("field", ["source", "replacement"])
def test_field_length_uses_unicode_code_points(field):
    reconciliation = meeting(("ừ" * 256,))
    assert len(parse(reconciliation, [{**edit("ừ", "Ừ"), field: "ừ" * 256}]).edits) == 1
    with pytest.raises(V6ValidationError) as caught:
        parse(reconciliation, [{**edit("ừ", "Ừ"), field: "ừ" * 257}])
    sanitized(caught.value, CorrectionErrorCategory.RESOURCE)


def test_occurrence_bound_and_per_segment_edit_bound():
    reconciliation = meeting(("con dòng",))
    assert parse(reconciliation, [edit("con", "Con", occurrence=255)]).edits[0].occurrence == 255
    assert len(parse(reconciliation, [edit("con", "Con")] * 32).edits) == 32
    for entries in ([edit("con", "Con", occurrence=256)], [edit("con", "Con")] * 33):
        with pytest.raises(V6ValidationError) as caught:
            parse(reconciliation, entries)
        sanitized(caught.value, CorrectionErrorCategory.RESOURCE)


def test_total_edit_count_bound_is_independent_of_per_segment_limit():
    reconciliation = meeting(tuple("con dòng" for _ in range(257)))
    entries = [edit("dòng", "rồng", segment=segment) for segment in range(256) for _ in range(32)]
    assert len(parse(reconciliation, entries).edits) == 8192
    with pytest.raises(V6ValidationError) as caught:
        parse(reconciliation, [*entries, edit("dòng", "rồng", segment=256)])
    sanitized(caught.value, CorrectionErrorCategory.RESOURCE)


@pytest.mark.parametrize("depth", [4, 2000])
def test_excessive_nesting_is_rejected_at_the_exact_structural_boundary(depth):
    with pytest.raises(V6ValidationError) as caught:
        parse_v6_proposal('{"edits":' + "[" * depth + "]" * depth + "}", meeting())
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)


def test_quoted_escaped_brackets_are_data_during_structural_nesting_checks():
    source = r'giữa nguyên \"[[[{{{'
    proposal = parse(meeting((source,)), [edit(source, source)])
    assert proposal.edits[0].source == source


@pytest.mark.parametrize("occurrence,expected", [
    (0, "con rồng và loài dòng"), (1, "con dòng và loài rồng"),
])
def test_exact_first_and_second_occurrence(occurrence, expected):
    result = invoke(meeting(("con dòng và loài dòng",)), [edit("dòng", "rồng", occurrence=occurrence)])
    assert result.texts == (expected,)
    counts(result, 1, 1)


def test_occurrences_are_literal_left_to_right_and_nonoverlapping():
    # "a a" occurs at 0 and 4 under non-overlapping matching, never at 2.
    result = invoke(meeting(("a a a a", CONTEXT)), [edit("a a", "A a", occurrence=1)])
    assert result.texts == ("a a A a", CONTEXT)
    counts(result, 1, 1)


@pytest.mark.parametrize("source,occurrence", [("missing", 0), ("dòng", 2), ("con  dòng", 0)])
def test_missing_spans_are_local_rejections(source, occurrence):
    original = "con dòng và loài dòng"
    result = invoke(meeting((original,)), [edit(source, "rồng", occurrence=occurrence)])
    assert result.texts == (original,)
    counts(result, 1, 0, {"unresolvable_span": 1}, 1)


@pytest.mark.parametrize("original,source,replacement", [
    ("con dòng", "òng", "ồng"), ("con dòng", "dò", "rồ"),
    ("API-v2 đang chạy", "API", "api"), ("mã user_name", "name", "Name"),
    ("tôi nói", "to", "To"),
])
def test_matches_inside_lexical_or_technical_tokens_are_rejected(original, source, replacement):
    result = invoke(meeting((original, CONTEXT)), [edit(source, replacement)])
    assert result.texts == (original, CONTEXT)
    counts(result, 1, 0, {"partial_token": 1}, 1)


@pytest.mark.parametrize("source,replacement", [("con ", "Con"), ("con ", "con/"), (" dòng", "dòng")])
def test_anchored_edits_cannot_fuse_retained_neighboring_tokens(source, replacement):
    original = "con dòng"
    result = invoke(meeting((original, CONTEXT)), [edit(source, replacement)])
    assert result.texts == (original, CONTEXT)
    counts(result, 1, 0, {"partial_token": 1}, 1)


def test_adjacent_nonoverlapping_patches_and_changing_character_lengths():
    original = "giữa nguyên, tinh tiết; con dòng"
    entries = [edit("giữa nguyên,", "giữ nguyên,"), edit(" tinh tiết;", " tình tiết;"), edit("dòng", "rồng")]
    reconciliation = meeting((original,))
    a = invoke(reconciliation, entries)
    b = invoke(reconciliation, list(reversed(entries)))
    assert a.texts == b.texts == ("giữ nguyên, tình tiết; con rồng",)
    counts(a, 3, 3)
    assert a == b


def test_replacements_never_create_source_matches_for_later_edits():
    original = "con dòng và loài vật"
    result = invoke(meeting((original,)), [edit("dòng", "rồng"), edit("rồng", "Dòng")])
    assert result.texts == ("con rồng và loài vật",)
    counts(result, 2, 1, {"unresolvable_span": 1}, 1)


@pytest.mark.parametrize("entries", [
    [edit("dòng", "rồng"), edit("dòng", "rồng")],
    [edit("con dòng", "con rồng"), edit("dòng", "rồng")],
    [edit("con dòng", "con rồng"), edit("dòng và", "rồng và"), edit("và loài", "và Loài")],
])
def test_every_participant_in_duplicate_or_transitive_overlap_is_rejected(entries):
    original = "con dòng và loài dòng; tinh tiết"
    reconciliation = meeting((original,))
    independent = edit("tinh tiết", "tình tiết")
    for order in (entries, list(reversed(entries))):
        result = invoke(reconciliation, [*order, independent])
        assert result.texts == ("con dòng và loài dòng; tình tiết",)
        counts(result, len(entries) + 1, 1, {"overlap_conflict": len(entries)}, 1)


def test_conflicting_and_unresolvable_proposals_do_not_enter_the_global_projection():
    original = "hôm nay chúng ta họp để kiểm tra toàn bộ nội dung bản ghi này"
    entries = [edit(original, "tóm tắt"), edit(original, "nội dung"), edit("missing", "invented " * 20)]
    result = invoke(meeting((original,)), entries)
    assert result.texts == (original,)
    counts(result, 3, 0, {"overlap_conflict": 2, "unresolvable_span": 1}, 1)


@pytest.mark.parametrize("source,replacement", [
    ("Bí kíp luyện dòng", "Bí kíp luyện rồng"), ("con dòng", "con rồng"),
    ("loài dòng", "loài rồng"), ("thà mạng", "tha mạng"),
    ("mương mặt", "gương mặt"), ("giữa nguyên", "giữ nguyên"),
    ("tinh tiết", "tình tiết"), ("vát", "đặt"), ("dụng", "rụng"),
    ("giao", "rao"), ("chanh", "tranh"), ("sinh", "xinh"),
    ("lặng", "nặng"), ("ngang", "nghang"), ("can", "kan"),
])
def test_vietnamese_near_phonetic_repairs_publish_the_actual_candidate(source, replacement):
    reconciliation = meeting((source,))
    result = invoke(reconciliation, [edit(source, replacement)])
    assert result.texts == (replacement,)
    counts(result, 1, 1)
    assert reconciliation.segments[0].text == source


def test_independent_good_edits_survive_an_unrelated_unsafe_patch_in_the_same_segment():
    original = "giữa nguyên và tinh tiết trong Bí kíp luyện dòng; Nhưng vát cược ấy"
    good = [edit("giữa nguyên", "giữ nguyên"), edit("tinh tiết", "tình tiết"),
            edit("Bí kíp luyện dòng", "Bí kíp luyện rồng")]
    reconciliation = meeting((original, CONTEXT))
    expected = "giữ nguyên và tình tiết trong Bí kíp luyện rồng; Nhưng vát cược ấy"
    result = invoke(reconciliation, good)
    assert result.texts == (expected, CONTEXT)
    counts(result, 3, 3)
    result = invoke(reconciliation, [good[0], edit("Nhưng vát cược ấy", "Đặt cược ấy"), *good[1:]])
    assert result.texts == (expected, CONTEXT)
    counts(result, 4, 3, {"unsafe_length_change": 1}, 1)


@pytest.mark.parametrize("source,replacement,reason", [
    ("Nhưng vát cược ấy", "Đặt cược ấy", "unsafe_length_change"),
    ("vâng vâng", "vâng", "unsafe_length_change"),
    ("ờ ờ", "ờ", "unsafe_length_change"),
    ("chúng ta nói", "chúng ta vừa nói", "unsafe_expansion"),
    ("mạch ngầm", "chiến lược", "unsupported_lexical_change"),
    ("con dòng", "loài rồng", "unsupported_lexical_change"),
    ("gi", "ri", "unsupported_lexical_change"),
    ("dòng", "rạp", "unsupported_lexical_change"),
    ("triển khai hệ thống hôm nay để kiểm tra", "Triển khai hệ thống hôm nay để kiểm tra.",
     "unsupported_lexical_change"),
    ("!", "?", "unsupported_lexical_change"),
])
def test_unsafe_local_edits_preserve_original_speech(source, replacement, reason):
    result = invoke(meeting((source, CONTEXT, CONTEXT)), [edit(source, replacement)])
    assert result.texts == (source, CONTEXT, CONTEXT)
    counts(result, 1, 0, {reason: 1}, 1)


@pytest.mark.parametrize("source,replacement", [
    ("10", "11"), ("v2", "v3"), ("-10", "10"), ("1,5", "1.5"),
    ("API", "APJ"), ("JWT", "JWS"), ("OAuth", "OAut"),
    ("C++", "C#"), ("user_name", "user_nam"), ("api-v1", "api-v2"),
    ("Minh", "Mình"), ("Lan", "Lam"), ("Vânn", "Vân"),
])
def test_numbers_names_and_identifiers_require_protection(source, replacement):
    original = f"tôi kiểm tra {source} hôm nay"
    result = invoke(meeting((original, CONTEXT)), [edit(source, replacement)])
    assert result.texts == (original, CONTEXT)
    counts(result, 1, 0, {"protected_token": 1}, 1)


@pytest.mark.parametrize("evidence_first", [False, True])
@pytest.mark.parametrize("source,replacement,evidence", [
    ("hôm nay chị Mai Hải Vânn sẽ trình bày", "Vân", "mời Mai Hải Vân nói tiếp"),
    ("hệ thống dùng JWT để ký", "JWS", "chúng ta dùng JWS hằng ngày"),
    ("chạy OAuth hôm nay", "OAut", "kiểm tra OAut hôm nay"),
])
def test_protected_repairs_need_neighboring_original_context(evidence_first, source, replacement, evidence):
    suspect = "Vânn" if "Vânn" in source else "JWT" if "JWT" in source else "OAuth"
    texts = (evidence, source) if evidence_first else (source, evidence)
    segment = int(evidence_first)
    result = invoke(meeting(texts), [edit(suspect, replacement, segment=segment)])
    expected = list(texts)
    expected[segment] = source.replace(suspect, replacement)
    assert result.texts == tuple(expected)
    counts(result, 1, 1)


@pytest.mark.parametrize("evidence", [
    "Vân có mặt hôm nay", "Mai Hải Vần đang báo cáo", "Mai Hải Vânn đang nói",
    "người khác tên Vân", "Mai Hải", "Vân đang nói",
])
def test_weak_or_differently_accented_original_evidence_does_not_waive_name_protection(evidence):
    source = "hôm nay chị Mai Hải Vânn sẽ trình bày"
    result = invoke(meeting((source, evidence)), [edit("Vânn", "Vân")])
    assert result.texts == (source, evidence)
    counts(result, 1, 0, {"protected_token": 1}, 1)


def test_only_original_other_segments_can_corroborate_a_protected_token():
    texts = ("mời Mai Hải Vânn nói tiếp", "Mai Hải Vânn đang báo cáo")
    result = invoke(meeting(texts), [edit("Vânn", "Vân", segment=0), edit("Vânn", "Vân", segment=1)])
    assert result.texts == texts
    counts(result, 2, 0, {"protected_token": 2}, 2)
    same_segment = "tôi gặp Mai Hải Vânn rồi nhắc Mai Hải Vân"
    result = invoke(meeting((same_segment, "Mai Hải", "Vân đang nói")), [edit("Vânn", "Vân")])
    assert result.texts[0] == same_segment
    counts(result, 1, 0, {"protected_token": 1}, 1)


def test_corroboration_does_not_waive_numeric_or_atomic_edit_rules():
    source = "chạy API-v1 và chị Mai Hải Vânn"
    evidence = "chạy API-v2 và chị Mai Hải Vân"
    result = invoke(meeting((source, evidence)), [edit("API-v1", "API-v2")])
    assert result.texts == (source, evidence)
    counts(result, 1, 0, {"protected_token": 1}, 1)


def test_anchored_punctuation_cannot_change_a_neighboring_numeric_sign():
    original = "giá +10 hôm nay"
    result = invoke(meeting((original, CONTEXT)), [edit("giá +", "giá -")])
    assert result.texts == (original, CONTEXT)
    counts(result, 1, 0, {"protected_token": 1}, 1)


def test_name_corroboration_is_nfc_casefolded_but_not_accent_insensitive():
    original = "chị Mai Hải Vânn đang nói"
    evidence = unicodedata.normalize("NFD", "mai hải vân đã đến")
    result = invoke(meeting((original, evidence)), [edit("Vânn", "Vân")])
    assert result.texts == (original.replace("Vânn", "Vân"), evidence)
    counts(result, 1, 1)


@pytest.mark.parametrize("source,replacement", [
    ("ừ", "Ừ."), ("ừ", "Ừ..."), ("a", "A?"), ("10", "10."),
    ("vâng vâng", "Vâng, vâng."), ("API", "api"), ("OAuth", "oauth"),
    ("con dòng", "Con, dòng!"), ("vâng 👍", "Vâng. 👍"),
    ("tôi\nđồng ý", "Tôi,\nđồng ý."),
])
def test_anchored_punctuation_case_and_repetition_preservation_remain_eligible(source, replacement):
    result = invoke(meeting((source,)), [edit(source, replacement)])
    assert result.texts == (replacement,)
    counts(result, 1, 1)


def test_unicode_comparison_never_normalizes_literal_span_positions_or_published_text():
    original = unicodedata.normalize("NFD", "tôi giữ nguyên tinh tiết")
    literal = unicodedata.normalize("NFD", "tinh tiết")
    candidate = unicodedata.normalize("NFD", "tình tiết")
    reconciliation = meeting((original,))
    result = invoke(reconciliation, [edit("tinh tiết", "tình tiết")])
    counts(result, 1, 0, {"unresolvable_span": 1}, 1)
    result = invoke(reconciliation, [edit(literal, candidate)])
    assert result.texts == (original.replace(literal, candidate),)
    assert result.texts[0] != unicodedata.normalize("NFC", result.texts[0])
    counts(result, 1, 1)


def test_unicode_equivalent_protected_tokens_are_allowed_without_other_segment_evidence():
    source = unicodedata.normalize("NFD", "chị Minh gặp Vân")
    result = invoke(meeting((source,)), [edit(source, unicodedata.normalize("NFC", source))])
    assert result.texts == ("chị Minh gặp Vân",)
    counts(result, 1, 1)


def test_noop_edits_are_counted_as_local_rejections():
    result = invoke(meeting(("con dòng",)), [edit("con", "con"), edit("dòng", "rồng")])
    assert result.texts == ("con rồng",)
    counts(result, 2, 1, {"noop_edit": 1}, 1)


@pytest.mark.parametrize("source,replacement", [
    ("một hai", "một"),
    ("con dòng", "con dòng " * 5),
    ("con dòng", "con dòng" + "!" * 100),
    ("một hai ba bốn năm sáu bảy tám chín mười", "đỏ xanh tím vàng cam nâu đen trắng bạc hồng"),
])
def test_global_projection_detects_mass_deletion_expansion_or_rewriting_before_local_rejection(source, replacement):
    reconciliation = meeting(tuple(source for _ in range(10)))
    entries = [edit(source, replacement, segment=i) for i in range(10)]
    with pytest.raises(V6ValidationError) as caught:
        invoke(reconciliation, entries)
    sanitized(caught.value, CorrectionErrorCategory.SUSPICIOUS_OUTPUT, source, replacement)
    assert caught.value.reason is V6FailureReason.PROPOSAL_INTEGRITY


def test_local_character_ratio_failure_does_not_fail_an_otherwise_intact_meeting():
    original = "a; con dòng"
    result = invoke(meeting((original, CONTEXT, CONTEXT)), [edit("a", "A" + "!" * 20), edit("dòng", "rồng")])
    assert result.texts == ("a; con rồng", CONTEXT, CONTEXT)
    counts(result, 2, 1, {"unsafe_expansion": 1}, 1)


def test_final_integrity_is_rechecked_after_mixed_local_acceptance_and_rejection():
    # Short anchored punctuation edits have a bounded presentation allowance.
    # An unsupported contraction must not hide their aggregate expansion.
    texts = ("aaa aaa", "bbbb bbbb")
    entries = [edit("aaa", "Aaa!!", occurrence=0), edit("aaa", "Aaa!!", occurrence=1),
               edit("bbbb bbbb", "b", segment=1)]
    with pytest.raises(V6ValidationError) as caught:
        invoke(meeting(texts), entries, min_text_ratio=0.1, max_text_ratio=1.1)
    sanitized(caught.value, CorrectionErrorCategory.SUSPICIOUS_OUTPUT)
    assert caught.value.reason is V6FailureReason.FINAL_INTEGRITY


@pytest.mark.parametrize("source", ["", " ", "...", "\t\n"])
def test_source_empty_speech_cannot_acquire_lexical_content(source):
    reconciliation = meeting((source, CONTEXT))
    if not source:
        with pytest.raises(V6ValidationError) as caught:
            invoke(reconciliation, [edit(source, "nội dung mới")])
        sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)
    else:
        result = invoke(reconciliation, [edit(source, "nội dung mới")])
        assert result.texts == (source, CONTEXT)
        counts(result, 1, 0, {"unsafe_expansion": 1}, 1)


@pytest.mark.parametrize("key,value", [
    ("min_text_ratio", 0), ("min_text_ratio", -1), ("min_text_ratio", True),
    ("min_text_ratio", 1.1), ("min_text_ratio", float("nan")),
    ("max_text_ratio", 0.9), ("max_text_ratio", float("inf")),
    ("max_text_ratio", "1.5"), ("max_text_ratio", None),
])
def test_invalid_explicit_limits_fail_with_sanitized_validation(key, value):
    reconciliation = meeting()
    with pytest.raises(V6ValidationError) as caught:
        apply_v6_edits(reconciliation, parse(reconciliation, []), **{key: value})
    sanitized(caught.value, CorrectionErrorCategory.VALIDATION)


def test_apply_revalidates_manually_constructed_proposals_and_foreign_reconciliation():
    reconciliation = meeting(("con dòng",))
    invalid = V6CorrectionProposal((V6EditCandidate("segment-000000", "dòng", "rồng", True),))
    with pytest.raises(V6ValidationError) as caught:
        apply_v6_edits(reconciliation, invalid)
    sanitized(caught.value, CorrectionErrorCategory.MALFORMED_OUTPUT)
    for operation in (lambda: parse_v6_proposal('{"edits":[]}', None),
                      lambda: apply_v6_edits(None, V6CorrectionProposal(()))):
        with pytest.raises(V6ValidationError) as caught:
            operation()
        sanitized(caught.value, CorrectionErrorCategory.VALIDATION)


def test_results_proposals_candidates_and_failures_are_immutable_and_private(caplog):
    reconciliation = meeting((PRIVATE + "; con dòng; mã JWT", CONTEXT))
    proposal = parse(reconciliation, [edit("dòng", "rồng"), edit("JWT", "JWS")])
    result = apply_v6_edits(reconciliation, proposal)
    counts(result, 2, 1, {"protected_token": 1}, 1)
    for obj, name, value in ((proposal, "edits", ()), (proposal.edits[0], "source", "changed"),
                             (result, "texts", ()), (result, "accepted_edit_count", 99)):
        with pytest.raises(FrozenInstanceError):
            setattr(obj, name, value)
    with pytest.raises(TypeError):
        result.rejection_reason_counts["protected_token"] = 99
    with pytest.raises(TypeError):
        result.texts[0] = "changed"
    failure = V6ValidationFailure(CorrectionErrorCategory.VALIDATION, V6FailureReason.INVALID_LIMITS)
    with pytest.raises(FrozenInstanceError):
        failure.category = CorrectionErrorCategory.RESOURCE
    rendered = repr(result) + repr(proposal) + repr(proposal.edits[0]) + caplog.text
    for sensitive in (PRIVATE, "rồng", "JWS", "dòng"):
        assert sensitive not in rendered


def test_repeated_execution_and_order_preserve_original_identity_and_evidence():
    reconciliation = meeting(("giữa nguyên và tinh tiết", "con dòng", "thà mạng"))
    before = replace(reconciliation)
    originals = reconciliation.segments
    entries = [edit("giữa nguyên", "giữ nguyên"), edit("tinh tiết", "tình tiết"),
               edit("dòng", "rồng", segment=1), edit("thà", "tha", segment=2)]
    expected = ("giữ nguyên và tình tiết", "con rồng", "tha mạng")
    results = [invoke(reconciliation, order) for order in (entries, entries, list(reversed(entries)))]
    assert all(result == results[0] and result.texts == expected for result in results)
    assert reconciliation == before and reconciliation.segments is originals
    for ordinal, source in enumerate(reconciliation.segments):
        assert source is originals[ordinal]
        assert source.segment_id == f"segment-{ordinal:06d}" and source.ordinal == ordinal
        assert source.interval == originals[ordinal].interval
        assert source.selected_evidence_id is originals[ordinal].selected_evidence_id
        assert source.source_chunk_ids == originals[ordinal].source_chunk_ids
        assert source.flags == originals[ordinal].flags


def test_import_and_execution_require_no_settings_provider_pipeline_audio_or_key(monkeypatch):
    module = importlib.import_module("sme_meeting_ai.transcription.correction_v6")
    assert "OPENROUTER_API_KEY" not in os.environ
    reconciliation = meeting(("con dòng",))
    body = json.dumps({"edits": [edit("dòng", "rồng")]})
    result = module.apply_v6_edits(reconciliation, module.parse_v6_proposal(body, reconciliation))
    assert result.texts == ("con rồng",)


@pytest.mark.parametrize("operation", ["parse", "apply"])
@pytest.mark.parametrize("exception,category", [
    (MemoryError(PRIVATE), CorrectionErrorCategory.RESOURCE),
    (RuntimeError(PRIVATE), CorrectionErrorCategory.VALIDATION),
])
def test_public_boundaries_do_not_chain_arbitrary_internal_exceptions(monkeypatch, operation, exception, category):
    module = importlib.import_module("sme_meeting_ai.transcription.correction_v6")
    reconciliation = meeting()

    def fail(*args, **kwargs):
        raise exception

    monkeypatch.setattr(module, "_original_segments", fail)
    with pytest.raises(V6ValidationError) as caught:
        if operation == "parse":
            parse_v6_proposal('{"edits":[]}', reconciliation)
        else:
            apply_v6_edits(reconciliation, V6CorrectionProposal(()))
    sanitized(caught.value, category)
