package com.sme.meetingassistant.api.intelligence.entity;

import com.sme.meetingassistant.api.intelligence.dto.MeetingDecisionStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "meeting_decisions")
public class MeetingDecisionEntity {

	@Id
	private UUID id;

	@Column(name = "meeting_id", nullable = false)
	private UUID meetingId;

	@Column(name = "summary_id", nullable = false)
	private UUID summaryId;

	@Column(nullable = false, columnDefinition = "text")
	private String statement;

	@Enumerated(EnumType.STRING)
	@Column(nullable = false, length = 20)
	private MeetingDecisionStatus status;

	@Column(precision = 5, scale = 4)
	private BigDecimal confidence;

	@Version
	@Column(name = "row_version", nullable = false)
	private long concurrencyVersion;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	@Column(name = "updated_at", nullable = false)
	private OffsetDateTime updatedAt;

	protected MeetingDecisionEntity() {
	}

	public MeetingDecisionEntity(UUID meetingId, UUID summaryId, String statement, BigDecimal confidence) {
		this.id = UUID.randomUUID();
		this.meetingId = meetingId;
		this.summaryId = summaryId;
		this.statement = statement;
		this.confidence = confidence;
		this.status = MeetingDecisionStatus.PROPOSED;
	}

	@PrePersist
	void onCreate() {
		OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
		this.createdAt = now;
		this.updatedAt = now;
	}

	@PreUpdate
	void onUpdate() { this.updatedAt = OffsetDateTime.now(ZoneOffset.UTC); }

	public UUID getId() { return this.id; }
	public UUID getMeetingId() { return this.meetingId; }
	public UUID getSummaryId() { return this.summaryId; }
	public String getStatement() { return this.statement; }
	public MeetingDecisionStatus getStatus() { return this.status; }
	public BigDecimal getConfidence() { return this.confidence; }
	public long getConcurrencyVersion() { return this.concurrencyVersion; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }
	public OffsetDateTime getUpdatedAt() { return this.updatedAt; }
	public void setStatus(MeetingDecisionStatus status) { this.status = status; }

}
