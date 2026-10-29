package com.sme.meetingassistant.api.meeting.notification;

import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.repository.MeetingParticipantRepository;
import com.sme.meetingassistant.api.meeting.repository.MeetingRepository;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalIdentityLookup;
import com.sme.meetingassistant.api.notification.email.TransactionalEmailHandler;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Durable intent in the same transaction as the meeting mutation, using existing SMTP worker. */
@Service
public class MeetingNotificationService {
    private final JdbcTemplate jdbc;
    private final MeetingParticipantRepository participants;
    private final MeetingRepository meetings;
    private final OrganizationalIdentityLookup users;

    public MeetingNotificationService(JdbcTemplate jdbc, MeetingParticipantRepository participants,
            MeetingRepository meetings, OrganizationalIdentityLookup users) {
        this.jdbc = jdbc; this.participants = participants;
        this.meetings = meetings; this.users = users;
    }

    /** Must be called inside the business transaction; never sends SMTP synchronously. */
    public void enqueue(MeetingEntity meeting, String notificationType) {
        if (!Set.of("MEETING_SCHEDULED","MEETING_RESCHEDULED","MEETING_CANCELLED").contains(notificationType))
            throw new IllegalArgumentException("Unsupported meeting email event");
        Set<UUID> recipients = new LinkedHashSet<>();
        recipients.add(meeting.getOrganizerUserId());
        for (var participant : participants.findByMeetingIdAndRemovedAtIsNull(meeting.getId())) {
            recipients.add(participant.getUserId());
        }
        for (UUID id : recipients) {
            var user = users.activeRecipient(id).orElse(null);
            if (user == null) continue;
            String key = "meeting:" + meeting.getId() + ":" + notificationType
                + ":" + meeting.getVersion() + ":" + id;
            jdbc.update("""
                INSERT INTO email_deliveries(id,notification_type,recipient_user_id,recipient_email,
                    related_entity_type,related_entity_id,status,dedupe_key,created_at,updated_at)
                VALUES (?, ?, ?, ?, 'MEETING', ?, 'PENDING', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT (dedupe_key) DO NOTHING
                """, UUID.randomUUID(), notificationType, id, user.email(), meeting.getId(), key);
        }
    }

    /**
     * Invalidate obsolete, unclaimed schedule notices atomically with the authoritative
     * meeting transition. A SENDING handoff might already be in flight over SMTP and
     * cannot safely be revoked; it is still revalidated by its handler before sending.
     * Never alter SENT or other email purposes (especially account/security mail).
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public int supersedePendingScheduleNotices(UUID meetingId) {
        return jdbc.update("""
            UPDATE email_deliveries
               SET status='SKIPPED', skip_reason='SUPERSEDED_BY_MEETING_CHANGE',
                   last_error_code=NULL,last_error_summary=NULL,next_attempt_at=NULL,
                   updated_at=clock_timestamp()
             WHERE related_entity_type='MEETING' AND related_entity_id=?
               AND notification_type IN ('MEETING_SCHEDULED','MEETING_RESCHEDULED')
               AND status IN ('PENDING','FAILED')
            """, meetingId);
    }

    @Transactional(readOnly = true)
    public Optional<TransactionalEmailHandler.Content> compose(UUID meetingId, String email,
            MeetingStatus requiredStatus, String eventType) {
        var meeting = meetings.findById(meetingId).orElse(null);
        if (meeting == null || meeting.getStatus() != requiredStatus) return Optional.empty();
        var user = users.activeRecipientByEmail(email).orElse(null);
        if (user == null) return Optional.empty();
        if (!meeting.getOrganizerUserId().equals(user.id())
                && !participants.existsByMeetingIdAndUserIdAndRemovedAtIsNull(meetingId,user.id())) {
            return Optional.empty();
        }
        String subject = switch (eventType) {
            case "MEETING_CANCELLED" -> "Meeting cancelled";
            case "MEETING_RESCHEDULED" -> "Meeting rescheduled";
            case "MEETING_SCHEDULED" -> "Meeting scheduled";
            default -> throw new IllegalArgumentException("Unknown meeting notification");
        };
        // Email content remains deliberately minimal; full sensitive meeting information
        // is only available through an authorized authenticated API.
        String message = switch (eventType) {
            case "MEETING_CANCELLED" ->
                "A meeting you are associated with has been cancelled. Sign in for details.";
            case "MEETING_RESCHEDULED" ->
                "A meeting you are associated with has changed its schedule. Sign in for details.";
            case "MEETING_SCHEDULED" ->
                "A meeting you are associated with has been scheduled. Sign in for details.";
            default -> throw new IllegalArgumentException("Unknown meeting notification");
        };
        return Optional.of(new TransactionalEmailHandler.Content(subject,message));
    }
}
