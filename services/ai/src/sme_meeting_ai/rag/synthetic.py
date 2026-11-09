"""Small canonical Vietnamese snapshot used by T02 development tooling."""

from __future__ import annotations

from .contracts import (
    CanonicalSourceIdentity,
    SnapshotMetadata,
    SourceRevision,
    TranscriptPayload,
    TranscriptProjection,
    TranscriptSegment,
    TranscriptSnapshot,
    TranscriptSpeaker,
)

MEETING_ID = "11111111-1111-4111-8111-111111111111"
TRANSCRIPT_ID = "22222222-2222-4222-8222-222222222222"
MEDIA_ID = "33333333-3333-4333-8333-333333333333"
JOB_ID = "44444444-4444-4444-8444-444444444444"
SNAPSHOT_ID = "55555555-5555-4555-8555-555555555555"
LAN_ID = "66666666-6666-4666-8666-666666666666"
MINH_ID = "77777777-7777-4777-8777-777777777777"
SEGMENT_ONE_ID = "88888888-8888-4888-8888-888888888888"
SEGMENT_TWO_ID = "99999999-9999-4999-8999-999999999999"


def synthetic_vietnamese_snapshot() -> TranscriptSnapshot:
    return TranscriptSnapshot(
        contract_version="1.0",
        snapshot_type="TRANSCRIPT",
        metadata=SnapshotMetadata(
            snapshot_id=SNAPSHOT_ID,
            meeting_id=MEETING_ID,
            source_identity=CanonicalSourceIdentity(
                source_type="TRANSCRIPT",
                source_id=TRANSCRIPT_ID,
                meeting_id=MEETING_ID,
            ),
            source_revision=SourceRevision(number=1),
        ),
        current=True,
        representation="RECONCILED",
        payload=TranscriptPayload(
            schema_version="1.0",
            transcript=TranscriptProjection(
                id=TRANSCRIPT_ID,
                meeting_id=MEETING_ID,
                source_media_id=MEDIA_ID,
                processing_job_id=JOB_ID,
                version_number=1,
                language_code="vi",
                status="READY",
                duration_ms=7_000,
                finalized_at="2026-11-09T12:00:00Z",
                content_revision=1,
                segments=(
                    TranscriptSegment(
                        id=SEGMENT_ONE_ID,
                        ordinal=0,
                        start_ms=0,
                        end_ms=3_000,
                        text="Chúng ta thống nhất kế hoạch phát hành bản thử nghiệm vào thứ Sáu.",
                        quality_status="ACCEPTED",
                        speaker_cluster_id=LAN_ID,
                        speaker_label="Chị Lan",
                        version=1,
                    ),
                    TranscriptSegment(
                        id=SEGMENT_TWO_ID,
                        ordinal=1,
                        start_ms=3_100,
                        end_ms=6_800,
                        text="Nhóm kỹ thuật sẽ kiểm tra dữ liệu và gửi báo cáo trước cuộc họp tiếp theo.",
                        quality_status="ACCEPTED",
                        speaker_cluster_id=MINH_ID,
                        speaker_label="Anh Minh",
                        version=1,
                    ),
                ),
            ),
            coverage=(),
            speakers=(
                TranscriptSpeaker(id=LAN_ID, label="Chị Lan"),
                TranscriptSpeaker(id=MINH_ID, label="Anh Minh"),
            ),
        ),
    )
