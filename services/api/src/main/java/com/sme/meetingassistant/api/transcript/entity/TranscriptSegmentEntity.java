package com.sme.meetingassistant.api.transcript.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "transcript_segments")
public class TranscriptSegmentEntity {

	@Id
	private UUID id;

	@Column(name = "transcript_id", nullable = false)
	private UUID transcriptId;

	@Column(name = "sequence_number", nullable = false)
	private int sequenceNumber;

	@Column(name = "start_ms", nullable = false)
	private long startMs;

	@Column(name = "end_ms", nullable = false)
	private long endMs;

	@Column(nullable = false, columnDefinition = "text")
	private String text;

	@Column(name = "speaker_label", length = 255)
	private String speakerLabel;

	@Column(precision = 5, scale = 4)
	private BigDecimal confidence;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	protected TranscriptSegmentEntity() {
	}

	public TranscriptSegmentEntity(UUID transcriptId, int sequenceNumber, long startMs, long endMs, String text,
			String speakerLabel, BigDecimal confidence) {
		this.id = UUID.randomUUID();
		this.transcriptId = transcriptId;
		this.sequenceNumber = sequenceNumber;
		this.startMs = startMs;
		this.endMs = endMs;
		this.text = text;
		this.speakerLabel = speakerLabel;
		this.confidence = confidence;
	}

	@PrePersist
	void onCreate() { this.createdAt = OffsetDateTime.now(ZoneOffset.UTC); }

	public UUID getId() { return this.id; }
	public UUID getTranscriptId() { return this.transcriptId; }
	public int getSequenceNumber() { return this.sequenceNumber; }
	public long getStartMs() { return this.startMs; }
	public long getEndMs() { return this.endMs; }
	public String getText() { return this.text; }
	public String getSpeakerLabel() { return this.speakerLabel; }
	public BigDecimal getConfidence() { return this.confidence; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }

	public void correct(String text, String speakerLabel) {
		this.text = text;
		this.speakerLabel = speakerLabel;
	}

}
