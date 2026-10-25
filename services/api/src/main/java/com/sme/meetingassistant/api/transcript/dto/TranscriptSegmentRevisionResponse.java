package com.sme.meetingassistant.api.transcript.dto;

import com.sme.meetingassistant.api.transcript.entity.TranscriptSegmentRevisionEntity;
import java.time.OffsetDateTime;
import java.util.UUID;

public record TranscriptSegmentRevisionResponse(UUID id, int revisionNumber, String previousText, String newText,
		String previousSpeakerLabel, String newSpeakerLabel, UUID editorId, OffsetDateTime createdAt) {

	public static TranscriptSegmentRevisionResponse from(TranscriptSegmentRevisionEntity revision) {
		return new TranscriptSegmentRevisionResponse(revision.getId(), revision.getRevisionNumber(),
				revision.getPreviousText(), revision.getNewText(), revision.getPreviousSpeakerLabel(),
				revision.getNewSpeakerLabel(), revision.getEditorId(), revision.getCreatedAt());
	}

}
