package com.sme.meetingassistant.api.meeting.service;

import com.sme.meetingassistant.api.meeting.dto.CreateMeetingRequest;
import com.sme.meetingassistant.api.meeting.dto.MeetingDetailResponse;
import com.sme.meetingassistant.api.meeting.dto.MeetingResponse;
import com.sme.meetingassistant.api.meeting.dto.ScheduleMeetingRequest;
import com.sme.meetingassistant.api.meeting.dto.UpdateMeetingRequest;
import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.entity.MeetingParticipantEntity;
import com.sme.meetingassistant.api.meeting.entity.ParticipantStatus;
import com.sme.meetingassistant.api.meeting.repository.MeetingParticipantRepository;
import com.sme.meetingassistant.api.meeting.repository.MeetingRepository;
import java.util.UUID;
import java.util.List;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.http.HttpStatus;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@Transactional
public class MeetingService {

	private final MeetingRepository meetingRepository;
	private final MeetingParticipantRepository participantRepository;

	public MeetingService(MeetingRepository meetingRepository, MeetingParticipantRepository participantRepository) {
		this.meetingRepository = meetingRepository;
		this.participantRepository = participantRepository;
	}

	public MeetingDetailResponse createMeeting(CreateMeetingRequest request, UUID organizerId) {
		MeetingEntity meeting = this.meetingRepository.saveAndFlush(new MeetingEntity(request.title().trim(), organizerId));
		if (request.description() != null) {
			meeting.updateDetails(meeting.getTitle(), request.description().trim());
		}
		return detail(meeting);
	}

	@Transactional(readOnly = true)
	public MeetingDetailResponse getMeetingById(UUID meetingId, UUID callerId) {
		MeetingEntity meeting = this.meetingRepository.findById(meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		if (!meeting.getOrganizerId().equals(callerId)
				&& !this.participantRepository.existsByMeetingIdAndUserIdAndStatusIn(meetingId, callerId,
						List.of(ParticipantStatus.INVITED, ParticipantStatus.ACCEPTED))) {
			throw new ResponseStatusException(HttpStatus.NOT_FOUND);
		}
		return detail(meeting);
	}

	public MeetingDetailResponse updateMeeting(UUID meetingId, UUID callerId, String ifMatch,
			UpdateMeetingRequest request) {
		MeetingEntity meeting = this.meetingRepository.findByIdAndOrganizerId(meetingId, callerId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		long expectedVersion = expectedVersion(ifMatch);
		if (meeting.getVersion() != expectedVersion) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
		}
		if (meeting.getStatus() != MeetingStatus.DRAFT && meeting.getStatus() != MeetingStatus.SCHEDULED) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		if (request.isEmpty()) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
		String title = request.title() == null ? meeting.getTitle() : request.title().trim();
		String description = request.description() == null ? meeting.getDescription() : request.description().trim();
		meeting.updateDetails(title, description);
		try {
			this.meetingRepository.flush();
		}
		catch (ObjectOptimisticLockingFailureException exception) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED, null, exception);
		}
		return detail(meeting);
	}

	public MeetingDetailResponse scheduleMeeting(UUID meetingId, UUID callerId, ScheduleMeetingRequest request) {
		MeetingEntity meeting = ownedMeeting(meetingId, callerId);
		if (meeting.getStatus() != MeetingStatus.DRAFT) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		if (!request.startTime().isBefore(request.endTime())) {
			throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
		}
		meeting.setSchedule(request.startTime(), request.endTime());
		meeting.transitionTo(MeetingStatus.SCHEDULED);
		this.meetingRepository.flush();
		return detail(meeting);
	}

	public MeetingDetailResponse transition(UUID meetingId, UUID callerId, MeetingStatus targetStatus) {
		MeetingEntity meeting = ownedMeeting(meetingId, callerId);
		boolean allowed = switch (targetStatus) {
			case IN_PROGRESS -> meeting.getStatus() == MeetingStatus.SCHEDULED;
			case ENDED -> meeting.getStatus() == MeetingStatus.IN_PROGRESS;
			case CANCELLED -> meeting.getStatus() == MeetingStatus.DRAFT
					|| meeting.getStatus() == MeetingStatus.SCHEDULED
					|| meeting.getStatus() == MeetingStatus.IN_PROGRESS;
			default -> false;
		};
		if (!allowed) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		meeting.transitionTo(targetStatus);
		this.meetingRepository.flush();
		return detail(meeting);
	}

	@Transactional(readOnly = true)
	public Page<MeetingResponse> listMeetings(UUID callerId, MeetingStatus status, String query, Pageable pageable) {
		Specification<MeetingEntity> specification = (root, criteriaQuery, builder) -> {
			var participantSubquery = criteriaQuery.subquery(Integer.class);
			var participant = participantSubquery.from(MeetingParticipantEntity.class);
			participantSubquery.select(builder.literal(1)).where(
					builder.equal(participant.get("meeting"), root),
					builder.equal(participant.get("userId"), callerId),
					participant.get("status").in(ParticipantStatus.INVITED, ParticipantStatus.ACCEPTED));
			return builder.or(builder.equal(root.get("organizerId"), callerId), builder.exists(participantSubquery));
		};
		if (status != null) {
			specification = specification.and((root, criteriaQuery, builder) -> builder.equal(root.get("status"), status));
		}
		if (query != null && !query.isBlank()) {
			String pattern = "%" + query.trim().toLowerCase(java.util.Locale.ROOT) + "%";
			specification = specification.and((root, criteriaQuery, builder) -> builder.like(builder.lower(root.get("title")), pattern));
		}
		return this.meetingRepository.findAll(specification, pageable).map(MeetingService::summary);
	}

	private static MeetingResponse summary(MeetingEntity meeting) {
		return new MeetingResponse(meeting.getId(), meeting.getTitle(), meeting.getStatus(), meeting.getStartTime(),
				meeting.getEndTime(), meeting.getVersion());
	}

	private MeetingEntity ownedMeeting(UUID meetingId, UUID callerId) {
		return this.meetingRepository.findByIdAndOrganizerId(meetingId, callerId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
	}

	private static long expectedVersion(String ifMatch) {
		if (ifMatch == null || !ifMatch.matches("\\\"[0-9]+\\\"")) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
		}
		try {
			return Long.parseLong(ifMatch.substring(1, ifMatch.length() - 1));
		}
		catch (NumberFormatException exception) {
			throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
		}
	}

	private static MeetingDetailResponse detail(MeetingEntity meeting) {
		return new MeetingDetailResponse(meeting.getId(), meeting.getTitle(), meeting.getDescription(), meeting.getStatus(),
				meeting.getOrganizerId(), meeting.getStartTime(), meeting.getEndTime(), meeting.getVersion(),
				meeting.getCreatedAt(), meeting.getUpdatedAt());
	}
}
