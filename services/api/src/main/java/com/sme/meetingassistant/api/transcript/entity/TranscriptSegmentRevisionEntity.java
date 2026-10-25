package com.sme.meetingassistant.api.transcript.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "transcript_segment_revisions")
public class TranscriptSegmentRevisionEntity {

	@Id
	private UUID id;

	@Column(name = "segment_id", nullable = false)
	private UUID segmentId;

	@Column(name = "revision_number", nullable = false)
	private int revisionNumber;

	@Column(name = "previous_text", nullable = false, columnDefinition = "text")
	private String previousText;

	@Column(name = "new_text", nullable = false, columnDefinition = "text")
	private String newText;

	@Column(name = "previous_speaker_label", length = 255)
	private String previousSpeakerLabel;

	@Column(name = "new_speaker_label", length = 255)
	private String newSpeakerLabel;

	@Column(name = "editor_id", nullable = false)
	private UUID editorId;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	protected TranscriptSegmentRevisionEntity() {
	}

	public TranscriptSegmentRevisionEntity(UUID segmentId, int revisionNumber, String previousText, String newText,
			String previousSpeakerLabel, String newSpeakerLabel, UUID editorId) {
		this.id = UUID.randomUUID();
		this.segmentId = segmentId;
		this.revisionNumber = revisionNumber;
		this.previousText = previousText;
		this.newText = newText;
		this.previousSpeakerLabel = previousSpeakerLabel;
		this.newSpeakerLabel = newSpeakerLabel;
		this.editorId = editorId;
	}

	@PrePersist
	void onCreate() { this.createdAt = OffsetDateTime.now(ZoneOffset.UTC); }

	public UUID getId() { return this.id; }
	public UUID getSegmentId() { return this.segmentId; }
	public int getRevisionNumber() { return this.revisionNumber; }
	public String getPreviousText() { return this.previousText; }
	public String getNewText() { return this.newText; }
	public String getPreviousSpeakerLabel() { return this.previousSpeakerLabel; }
	public String getNewSpeakerLabel() { return this.newSpeakerLabel; }
	public UUID getEditorId() { return this.editorId; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }

}
