package com.sme.meetingassistant.api.meeting.service;

import com.sme.meetingassistant.api.meeting.dto.AddParticipantRequest;
import com.sme.meetingassistant.api.meeting.dto.ParticipantResponse;
import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingParticipantEntity;
import com.sme.meetingassistant.api.meeting.entity.ParticipantRole;
import com.sme.meetingassistant.api.meeting.entity.ParticipantStatus;
import com.sme.meetingassistant.api.meeting.repository.MeetingParticipantRepository;
import com.sme.meetingassistant.api.meeting.repository.MeetingRepository;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@Transactional
public class MeetingParticipantService {

	private static final List<ParticipantStatus> ACTIVE_STATUSES = List.of(ParticipantStatus.INVITED, ParticipantStatus.ACCEPTED);

	private final MeetingRepository meetingRepository;
	private final MeetingParticipantRepository participantRepository;

	public MeetingParticipantService(MeetingRepository meetingRepository,
			MeetingParticipantRepository participantRepository) {
		this.meetingRepository = meetingRepository;
		this.participantRepository = participantRepository;
	}

	public ParticipantResponse add(UUID meetingId, UUID callerId, AddParticipantRequest request) {
		MeetingEntity meeting = ownedMeeting(meetingId, callerId);
		if (meeting.getOrganizerId().equals(request.userId())) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		if (this.participantRepository.existsByMeetingIdAndUserIdAndStatusIn(meetingId, request.userId(), ACTIVE_STATUSES)) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		ParticipantRole role = request.role() == null ? ParticipantRole.REQUIRED : request.role();
		MeetingParticipantEntity participant = new MeetingParticipantEntity(request.userId(), role);
		meeting.addParticipant(participant);
		meeting.touch();
		this.meetingRepository.flush();
		return response(participant);
	}

	@Transactional(readOnly = true)
	public List<ParticipantResponse> list(UUID meetingId, UUID callerId) {
		ownedMeeting(meetingId, callerId);
		return this.participantRepository.findByMeetingIdOrderByCreatedAtAsc(meetingId).stream()
				.map(MeetingParticipantService::response).toList();
	}

	public ParticipantResponse remove(UUID meetingId, UUID participantId, UUID callerId) {
		MeetingEntity meeting = ownedMeeting(meetingId, callerId);
		MeetingParticipantEntity participant = this.participantRepository.findByIdAndMeetingId(participantId, meetingId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
		if (participant.getStatus() == ParticipantStatus.REMOVED) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		participant.remove();
		meeting.touch();
		this.meetingRepository.flush();
		return response(participant);
	}

	private MeetingEntity ownedMeeting(UUID meetingId, UUID callerId) {
		return this.meetingRepository.findByIdAndOrganizerId(meetingId, callerId)
				.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
	}

	private static ParticipantResponse response(MeetingParticipantEntity participant) {
		return new ParticipantResponse(participant.getId(), participant.getUserId(), participant.getRole(),
				participant.getStatus(), participant.getCreatedAt(), participant.getRemovedAt());
	}
}
