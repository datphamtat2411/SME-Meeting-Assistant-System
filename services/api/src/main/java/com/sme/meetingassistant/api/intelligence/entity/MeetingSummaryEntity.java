package com.sme.meetingassistant.api.intelligence.entity;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "meeting_summaries")
public class MeetingSummaryEntity {

	@Id
	private UUID id;

	@Column(name = "meeting_id", nullable = false)
	private UUID meetingId;

	@Column(name = "source_transcript_id", nullable = false)
	private UUID sourceTranscriptId;

	@Column(name = "version_number", nullable = false)
	private int versionNumber;

	@Column(nullable = false, length = 255)
	private String title;

	@Column(nullable = false, columnDefinition = "text")
	private String overview;

	@JdbcTypeCode(SqlTypes.JSON)
	@Column(name = "key_points", nullable = false, columnDefinition = "jsonb")
	private List<String> keyPoints;

	@Column(name = "is_current", nullable = false)
	private boolean current;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	protected MeetingSummaryEntity() {
	}

	public MeetingSummaryEntity(UUID meetingId, UUID sourceTranscriptId, int versionNumber, String title,
			String overview, List<String> keyPoints) {
		this.id = UUID.randomUUID();
		this.meetingId = meetingId;
		this.sourceTranscriptId = sourceTranscriptId;
		this.versionNumber = versionNumber;
		this.title = title;
		this.overview = overview;
		this.keyPoints = List.copyOf(keyPoints);
		this.current = true;
	}

	@jakarta.persistence.PrePersist
	void onCreate() { this.createdAt = OffsetDateTime.now(ZoneOffset.UTC); }

	public UUID getId() { return this.id; }
	public UUID getMeetingId() { return this.meetingId; }
	public UUID getSourceTranscriptId() { return this.sourceTranscriptId; }
	public int getVersionNumber() { return this.versionNumber; }
	public String getTitle() { return this.title; }
	public String getOverview() { return this.overview; }
	public List<String> getKeyPoints() { return this.keyPoints; }
	public boolean isCurrent() { return this.current; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }
	public void markNotCurrent() { this.current = false; }

}
