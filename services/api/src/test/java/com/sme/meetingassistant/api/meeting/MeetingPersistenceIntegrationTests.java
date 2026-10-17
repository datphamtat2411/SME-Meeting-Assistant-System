package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingParticipantEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.entity.ParticipantRole;
import com.sme.meetingassistant.api.meeting.entity.ParticipantStatus;
import com.sme.meetingassistant.api.meeting.repository.MeetingRepository;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import jakarta.persistence.EntityManager;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class MeetingPersistenceIntegrationTests {

	@Autowired
	private EntityManager entityManager;

	@Autowired
	private MeetingRepository meetingRepository;

	@Test
	@Transactional
	void persistsMeetingAndParticipantAndSupportsOrganizerLookup() {
		UUID organizerId = UUID.randomUUID();
		UUID participantId = UUID.randomUUID();		
		MeetingEntity meeting = new MeetingEntity("Planning", organizerId);
		meeting.addParticipant(new MeetingParticipantEntity(participantId, ParticipantRole.REQUIRED));
		MeetingEntity saved = this.meetingRepository.saveAndFlush(meeting);
		UUID meetingId = saved.getId();

		this.entityManager.clear();
		MeetingEntity reloaded = this.meetingRepository.findByIdAndOrganizerId(meetingId, organizerId).orElseThrow();
		assertThat(reloaded.getStatus()).isEqualTo(MeetingStatus.DRAFT);
		assertThat(reloaded.getParticipants()).singleElement().satisfies(participant -> {
			assertThat(participant.getUserId()).isEqualTo(participantId);
			assertThat(participant.getStatus()).isEqualTo(ParticipantStatus.INVITED);
			assertThat(participant.getMeeting().getId()).isEqualTo(meetingId);
		});
	}
}
