import hashlib
from uuid import uuid4

import pytest
from pydantic import ValidationError

from sme_meeting_ai.rag import (
    ActionItemProjection,
    ActionItemSnapshot,
    AuthorizedRetrievalScope,
    CanonicalSourceIdentity,
    ChunkingConfig,
    DecisionProjection,
    DecisionSnapshot,
    ImmutableSnapshotReference,
    IndexGeneration,
    IndexLifecycleEvent,
    KnowledgeContractError,
    KnowledgeSnapshot,
    ProcessingStatus,
    RetrievalFilters,
    RetrievalScopeRequest,
    SnapshotIntegrity,
    SnapshotMetadata,
    SourceRevision,
    SummaryProjection,
    SummarySnapshot,
    TranscriptPayload,
    TranscriptProjection,
    TranscriptSegment,
    TranscriptSnapshot,
    TranscriptSpeaker,
    process_snapshot,
    validate_snapshot,
    verify_snapshot_bytes,
)

MEETING = str(uuid4())
TRANSCRIPT = str(uuid4())
MEDIA = str(uuid4())
JOB = str(uuid4())
SNAPSHOT = str(uuid4())
ALICE = str(uuid4())
BOB = str(uuid4())
DECISION = str(uuid4())
SUMMARY = str(uuid4())
ACTION = str(uuid4())


class WordCounter:
    def count(self, text: str) -> int:
        return len(text.split())


def metadata(source_type: str, source_id: str, revision: int = 4) -> SnapshotMetadata:
    return SnapshotMetadata(
        snapshot_id=SNAPSHOT,
        meeting_id=MEETING,
        source_identity=CanonicalSourceIdentity(
            source_type=source_type, source_id=source_id, meeting_id=MEETING
        ),
        source_revision=SourceRevision(number=revision, content_sha256="a" * 64),
        integrity=SnapshotIntegrity(sha256="b" * 64, size_bytes=512),
    )


def transcript_snapshot(
    *,
    segments: tuple[TranscriptSegment, ...] | None = None,
    current: bool = True,
    representation: str = "RECONCILED",
    status: str = "READY",
    revision: int = 4,
) -> TranscriptSnapshot:
    segments = segments or (
        TranscriptSegment(
            id=str(uuid4()),
            ordinal=0,
            start_ms=0,
            end_ms=1800,
            text="Chúng ta cần chốt ngân sách quý này.",
            quality_status="ACCEPTED",
            speaker_cluster_id=ALICE,
            speaker_label="Chị Lan",
            version=2,
        ),
        TranscriptSegment(
            id=str(uuid4()),
            ordinal=1,
            start_ms=1900,
            end_ms=3500,
            text="Em đồng ý, nhóm sẽ gửi bảng chi tiết trước thứ Sáu.",
            quality_status="ACCEPTED",
            speaker_cluster_id=BOB,
            speaker_label="Anh Minh",
            version=1,
        ),
    )
    projection = TranscriptProjection(
        id=TRANSCRIPT,
        meeting_id=MEETING,
        source_media_id=MEDIA,
        processing_job_id=JOB,
        version_number=3,
        language_code="vi",
        status=status,
        duration_ms=max(5000, max((segment.end_ms or 0 for segment in segments), default=0)),
        finalized_at="2026-11-09T12:00:00Z",
        content_revision=revision,
        segments=segments,
    )
    payload = TranscriptPayload(
        schema_version="1.0",
        transcript=projection,
        coverage=(),
        speakers=(
            TranscriptSpeaker(id=ALICE, label="Chị Lan"),
            TranscriptSpeaker(id=BOB, label="Anh Minh"),
        ),
    )
    return TranscriptSnapshot(
        contract_version="1.0",
        snapshot_type="TRANSCRIPT",
        metadata=metadata("TRANSCRIPT", TRANSCRIPT, revision),
        current=current,
        representation=representation,
        payload=payload,
    )


def config(*, max_tokens: int = 40, generation: str = "rag-t01-v1") -> ChunkingConfig:
    return ChunkingConfig(
        max_tokens=max_tokens,
        target_tokens=max(1, max_tokens // 2),
        max_temporal_gap_ms=5000,
        max_units_per_chunk=8,
        index_generation=IndexGeneration(
            generation_id=generation,
            configuration_version="chunking-v1",
            configuration_sha256="c" * 64,
            tokenizer_id="test-word-counter",
        ),
    )


def decision_snapshot(*, status: str = "CONFIRMED", stale: bool = False) -> DecisionSnapshot:
    return DecisionSnapshot(
        contract_version="1.0",
        snapshot_type="DECISION",
        metadata=metadata("DECISION", DECISION, 2),
        content=DecisionProjection(
            id=DECISION,
            meeting_id=MEETING,
            content="Phê duyệt ngân sách thử nghiệm cho quý IV.",
            status=status,
            source_type="MANUAL",
            evidence_segment_ids=(
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
            ),
            transcript_id=TRANSCRIPT,
            transcript_revision=SourceRevision(number=4),
            version=2,
            is_stale=stale,
            confirmed_by_user_id=str(uuid4()),
            confirmed_at="2026-11-09T12:01:00Z",
        ),
    )


def test_current_reconciled_transcript_is_normalized_with_all_provenance():
    snapshot = transcript_snapshot()

    result = process_snapshot(snapshot, token_counter=WordCounter(), config=config())

    assert result.status is ProcessingStatus.PROCESSED
    assert len(result.chunks) == 1
    chunk = result.chunks[0]
    assert chunk.provenance.meeting_id == MEETING
    assert chunk.provenance.source_identity.source_id == TRANSCRIPT
    assert chunk.provenance.source_revision.number == 4
    assert chunk.provenance.index_generation_id == "rag-t01-v1"
    assert [ref.segment_id for ref in chunk.provenance.source_references] == [
        snapshot.payload.transcript.segments[0].id,
        snapshot.payload.transcript.segments[1].id,
    ]
    assert {speaker.label for speaker in chunk.provenance.speakers} == {"Chị Lan", "Anh Minh"}
    assert "Chị Lan: Chúng ta cần chốt ngân sách quý này." in chunk.retrieval_text
    assert "Anh Minh: Em đồng ý" in chunk.retrieval_text
    assert "11111111" not in chunk.retrieval_text


def test_transcript_excludes_suspicious_unknown_and_unresolved_segments():
    accepted = TranscriptSegment(
        id=str(uuid4()), ordinal=0, start_ms=0, end_ms=1000,
        text="Nội dung đã được kiểm tra.", quality_status="ACCEPTED",
        speaker_cluster_id=ALICE, speaker_label="Chị Lan", version=1,
    )
    suspicious = accepted.model_copy(update={
        "id": str(uuid4()), "ordinal": 1, "start_ms": 1100,
        "end_ms": 2000, "text": "Không dùng đoạn đáng ngờ.", "quality_status": "SUSPICIOUS",
    })
    unknown = accepted.model_copy(update={
        "id": str(uuid4()), "ordinal": 2, "start_ms": 2100,
        "end_ms": 3000, "text": "Không rõ chất lượng.", "quality_status": None,
    })
    unresolved = accepted.model_copy(update={
        "id": str(uuid4()), "ordinal": 3, "start_ms": 3100,
        "end_ms": 4000, "text": "Không dùng đoạn chưa giải quyết.", "quality_status": "UNRESOLVED",
    })

    result = process_snapshot(
        transcript_snapshot(segments=(accepted, suspicious, unknown, unresolved)),
        token_counter=WordCounter(), config=config(),
    )

    assert result.status is ProcessingStatus.PROCESSED
    assert len(result.chunks) == 1
    assert [ref.segment_id for ref in result.chunks[0].provenance.source_references] == [accepted.id]
    assert {issue.code for issue in result.issues} >= {
        "SUSPICIOUS_SEGMENT_EXCLUDED",
        "UNRESOLVED_SEGMENT_EXCLUDED",
        "UNKNOWN_SEGMENT_QUALITY",
    }


@pytest.mark.parametrize(
    ("current", "representation", "status", "expected"),
    [
        (False, "RECONCILED", "READY", "SOURCE_NOT_CURRENT"),
        (True, "RAW_ASR", "READY", "TRANSCRIPT_NOT_RECONCILED"),
        (True, "RECONCILED", "PROCESSING", "TRANSCRIPT_NOT_FINALIZED"),
    ],
)
def test_transcript_authority_rejects_stale_raw_or_unfinalized_sources(
    current: bool, representation: str, status: str, expected: str,
):
    result = process_snapshot(
        transcript_snapshot(current=current, representation=representation, status=status),
        token_counter=WordCounter(), config=config(),
    )

    assert result.status is ProcessingStatus.INELIGIBLE
    assert expected in {issue.code for issue in result.issues}
    assert result.chunks == ()


def test_no_eligible_transcript_content_is_not_malformed_input():
    suspicious = TranscriptSegment(
        id=str(uuid4()), ordinal=0, start_ms=0, end_ms=1000,
        text="Đoạn chưa thể xác minh.", quality_status="SUSPICIOUS",
    )

    result = process_snapshot(
        transcript_snapshot(segments=(suspicious,)),
        token_counter=WordCounter(), config=config(),
    )

    assert result.status is ProcessingStatus.NO_ELIGIBLE_CONTENT
    assert result.normalized is not None
    assert result.chunks == ()


def test_confirmed_decision_preserves_evidence_and_rejects_proposal_or_stale():
    result = process_snapshot(decision_snapshot(), token_counter=WordCounter(), config=config())
    assert result.status is ProcessingStatus.PROCESSED
    chunk = result.chunks[0]
    assert chunk.provenance.authority_class == "CONFIRMED_DECISION"
    assert [ref.segment_id for ref in chunk.provenance.evidence_references] == [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    ]

    for snapshot, code in (
        (decision_snapshot(status="PROPOSED"), "DECISION_NOT_CONFIRMED"),
        (decision_snapshot(stale=True), "DECISION_STALE"),
    ):
        rejected = process_snapshot(snapshot, token_counter=WordCounter(), config=config())
        assert rejected.status is ProcessingStatus.INELIGIBLE
        assert code in {issue.code for issue in rejected.issues}


def test_current_approved_summary_splits_by_paragraph_without_rewriting_text():
    text = (
        "Mục tiêu cuộc họp là thống nhất kế hoạch triển khai.\n\n"
        "Nhóm kỹ thuật sẽ hoàn thiện bản thử nghiệm trong tuần này.\n\n"
        "Các rủi ro về dữ liệu sẽ được rà soát trước khi phát hành."
    )
    snapshot = SummarySnapshot(
        contract_version="1.0",
        snapshot_type="SUMMARY",
        metadata=metadata("SUMMARY", SUMMARY, 7),
        content=SummaryProjection(
            id=SUMMARY,
            meeting_id=MEETING,
            version_number=7,
            content=text,
            source_type="HUMAN_EDIT",
            quality_status="READY",
            is_current=True,
            is_approved=True,
            is_stale=False,
            transcript_id=TRANSCRIPT,
            transcript_revision=SourceRevision(number=4),
        ),
    )

    result = process_snapshot(snapshot, token_counter=WordCounter(), config=config(max_tokens=10))

    assert result.status is ProcessingStatus.PROCESSED
    assert len(result.chunks) >= 2
    combined = " ".join(chunk.retrieval_text for chunk in result.chunks)
    assert "Mục tiêu cuộc họp" in combined
    assert "Các rủi ro về dữ liệu" in combined
    assert all(chunk.token_count <= 10 for chunk in result.chunks)
    assert all(chunk.provenance.quality_class == "ACCEPTED" for chunk in result.chunks)


def test_summary_must_be_current_approved_and_non_stale():
    base = SummaryProjection(
        id=SUMMARY, meeting_id=MEETING, version_number=1, content="Tóm tắt cuộc họp.",
        source_type="AI_GENERATED", quality_status="READY", is_current=True,
        is_approved=True, is_stale=False,
    )
    for mutation, code in (
        (base.model_copy(update={"is_current": False}), "SUMMARY_NOT_CURRENT"),
        (base.model_copy(update={"is_approved": False}), "SUMMARY_NOT_APPROVED"),
        (base.model_copy(update={"is_stale": True}), "SUMMARY_STALE"),
    ):
        snapshot = SummarySnapshot(
            contract_version="1.0", snapshot_type="SUMMARY",
            metadata=metadata("SUMMARY", SUMMARY, 1), content=mutation,
        )
        result = process_snapshot(snapshot, token_counter=WordCounter(), config=config())
        assert result.status is ProcessingStatus.INELIGIBLE
        assert code in {issue.code for issue in result.issues}


@pytest.mark.parametrize("status", ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"])
def test_official_action_item_preserves_status_due_date_and_assignee(status: str):
    snapshot = ActionItemSnapshot(
        contract_version="1.0", snapshot_type="ACTION_ITEM",
        metadata=metadata("ACTION_ITEM", ACTION, 9),
        content=ActionItemProjection(
            id=ACTION, meeting_id=MEETING, title="Gửi bảng phân tích chi phí",
            details="Đính kèm các giả định và phương án thay thế.", status=status,
            source_type="MANUAL", is_official=True, assignee_user_id=BOB,
            due_date="2026-11-20", version=9,
        ),
    )

    result = process_snapshot(snapshot, token_counter=WordCounter(), config=config())

    assert result.status is ProcessingStatus.PROCESSED
    chunk = result.chunks[0]
    assert f"Status: {status}" in chunk.retrieval_text
    assert "2026-11-20" in chunk.retrieval_text
    assert chunk.provenance.action_status == status
    assert chunk.provenance.assignee_user_id == BOB
    assert chunk.provenance.due_date == "2026-11-20"
    assert "Assignee ID" not in chunk.retrieval_text


def test_proposed_action_item_is_not_official_knowledge():
    snapshot = ActionItemSnapshot(
        contract_version="1.0", snapshot_type="ACTION_ITEM",
        metadata=metadata("ACTION_ITEM", ACTION, 1),
        content=ActionItemProjection(
            id=ACTION, meeting_id=MEETING, title="Theo dõi vấn đề", details=None,
            status="PROPOSED", source_type="AI_EXTRACTED", is_official=False,
            version=1,
        ),
    )
    result = process_snapshot(snapshot, token_counter=WordCounter(), config=config())
    assert result.status is ProcessingStatus.INELIGIBLE
    assert "ACTION_ITEM_NOT_OFFICIAL" in {issue.code for issue in result.issues}


def test_oversized_transcript_segment_is_bounded_without_losing_words_or_timing():
    words = " ".join(f"từ{i}" for i in range(75)) + "."
    segment = TranscriptSegment(
        id=str(uuid4()), ordinal=0, start_ms=1000, end_ms=9000, text=words,
        quality_status="ACCEPTED", speaker_cluster_id=ALICE, speaker_label="Chị Lan", version=1,
    )
    result = process_snapshot(
        transcript_snapshot(segments=(segment,)), token_counter=WordCounter(), config=config(max_tokens=12),
    )

    assert result.status is ProcessingStatus.PROCESSED
    assert len(result.chunks) > 1
    assert all(chunk.token_count <= 12 for chunk in result.chunks)
    assert all(ref.segment_id == segment.id for chunk in result.chunks for ref in chunk.provenance.source_references)
    assert all(
        ref.timeline_start_ms == 1000 and ref.timeline_end_ms == 9000
        for chunk in result.chunks for ref in chunk.provenance.source_references
    )
    extracted = " ".join(chunk.retrieval_text.split(": ", 1)[1] for chunk in result.chunks)
    assert extracted == words


def test_processing_is_deterministic_and_revision_or_generation_changes_identity():
    snapshot = transcript_snapshot()
    first = process_snapshot(snapshot, token_counter=WordCounter(), config=config())
    second = process_snapshot(snapshot, token_counter=WordCounter(), config=config())
    assert first.model_dump() == second.model_dump()
    assert [chunk.chunk_id for chunk in first.chunks] == [chunk.chunk_id for chunk in second.chunks]

    new_generation = process_snapshot(
        snapshot, token_counter=WordCounter(), config=config(generation="rag-t01-v2")
    )
    new_revision = process_snapshot(
        transcript_snapshot(revision=5), token_counter=WordCounter(), config=config()
    )
    assert new_generation.chunks[0].chunk_id != first.chunks[0].chunk_id
    assert new_revision.chunks[0].chunk_id != first.chunks[0].chunk_id


def test_invalid_source_contract_is_explicit_and_does_not_process_partial_content():
    snapshot = transcript_snapshot()
    malformed = snapshot.model_dump()
    malformed["payload"]["transcript"]["segments"][1]["startMs"] = -1

    result = process_snapshot(malformed, token_counter=WordCounter(), config=config())

    assert result.status is ProcessingStatus.INVALID
    assert result.chunks == ()
    assert result.issues[0].code == "INVALID_SOURCE_CONTRACT"
    with pytest.raises(ValueError):
        validate_snapshot(malformed)


def test_contract_models_are_strict_and_cross_service_contracts_are_bounded():
    with pytest.raises(ValidationError):
        SourceRevision(number="4")
    with pytest.raises(ValidationError):
        SnapshotIntegrity(sha256="b" * 64, size_bytes=0)

    scope = AuthorizedRetrievalScope(
        contract_version="1.0", scope_id=str(uuid4()), principal_id=str(uuid4()),
        scope_version="authz-v1", issued_at="2026-11-09T12:00:00Z",
        expires_at="2026-11-09T13:00:00Z", allowed_meeting_ids=(), allowed_source_ids=(),
    )
    assert scope.effective_meeting_ids(RetrievalFilters(meeting_ids=(MEETING,))) == ()
    request = RetrievalScopeRequest(
        contract_version="1.0", authorized_scope=scope,
        user_filters=RetrievalFilters(meeting_ids=(MEETING,)),
    )
    assert request.effective_meeting_ids == ()

    generation = config().index_generation
    event = IndexLifecycleEvent(
        contract_version="1.0", event_id=str(uuid4()), occurred_at="2026-11-09T12:00:00Z",
        meeting_id=MEETING, source_identity=CanonicalSourceIdentity(
            source_type="TRANSCRIPT", source_id=TRANSCRIPT, meeting_id=MEETING,
        ), source_revision=SourceRevision(number=4), operation="UPSERT",
        snapshot=ImmutableSnapshotReference(
            snapshot_id=SNAPSHOT, sha256="b" * 64, size_bytes=512,
        ), index_generation=generation,
    )
    assert event.index_generation.generation_id == "rag-t01-v1"
    assert "segments" not in event.model_dump()


def test_external_snapshot_bytes_are_integrity_checked_before_processing():
    raw = b'{"schemaVersion":"1.0"}'
    descriptor = metadata("TRANSCRIPT", TRANSCRIPT).model_copy(update={
        "integrity": SnapshotIntegrity(
            sha256=hashlib.sha256(raw).hexdigest(), size_bytes=len(raw),
        ),
    })

    assert verify_snapshot_bytes(raw, descriptor) == raw
    with pytest.raises(KnowledgeContractError) as error:
        verify_snapshot_bytes(raw + b" ", descriptor)
    assert error.value.code == "INVALID_SNAPSHOT_INTEGRITY"


def test_snapshot_union_accepts_existing_camel_case_transcript_projection():
    snapshot = transcript_snapshot().model_dump(by_alias=True)

    parsed: KnowledgeSnapshot = validate_snapshot(snapshot)

    assert isinstance(parsed, TranscriptSnapshot)
    assert parsed.payload.transcript.status == "READY"


def test_serialized_supported_snapshots_use_json_mode_for_array_fields():
    summary = SummarySnapshot(
        contract_version="1.0",
        snapshot_type="SUMMARY",
        metadata=metadata("SUMMARY", SUMMARY, 7),
        content=SummaryProjection(
            id=SUMMARY,
            meeting_id=MEETING,
            version_number=7,
            content="Tóm tắt cuộc họp.",
            source_type="HUMAN_EDIT",
            quality_status="READY",
            is_current=True,
            is_approved=True,
            is_stale=False,
        ),
    )

    for snapshot in (transcript_snapshot(), decision_snapshot(), summary):
        parsed = validate_snapshot(snapshot.model_dump_json(by_alias=True).encode())
        assert type(parsed) is type(snapshot)
