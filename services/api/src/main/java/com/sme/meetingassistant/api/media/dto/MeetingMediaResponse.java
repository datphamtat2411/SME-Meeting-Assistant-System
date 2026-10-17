package com.sme.meetingassistant.api.media.dto;

import com.sme.meetingassistant.api.media.entity.MeetingMediaEntity;
import java.time.OffsetDateTime;
import java.util.UUID;

public record MeetingMediaResponse(UUID id, UUID meetingId, String fileName, String fileExtension,
		String contentType, long sizeBytes, String availabilityStatus, OffsetDateTime uploadedAt) {

	public static MeetingMediaResponse from(MeetingMediaEntity media) {
		return new MeetingMediaResponse(media.getId(), media.getMeetingId(), media.getOriginalFileName(),
				media.getFileExtension(), media.getContentType(), media.getSizeBytes(),
				media.getAvailabilityStatus().name(), media.getUploadedAt());
	}

}
