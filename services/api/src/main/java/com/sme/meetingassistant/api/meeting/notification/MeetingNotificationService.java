package com.sme.meetingassistant.api.meeting.notification;

import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingParticipantEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.repository.MeetingParticipantRepository;
import com.sme.meetingassistant.api.meeting.repository.MeetingRepository;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalIdentityLookup;
import com.sme.meetingassistant.api.notification.application.EmailNotificationPreferenceLookup;
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
    private final EmailNotificationPreferenceLookup preferences;

    public MeetingNotificationService(JdbcTemplate jdbc, MeetingParticipantRepository participants,
            MeetingRepository meetings, OrganizationalIdentityLookup users,
            EmailNotificationPreferenceLookup preferences) {
        this.jdbc = jdbc; this.participants = participants;
        this.meetings = meetings; this.users = users;
        this.preferences = preferences;
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
            boolean enabled = preferences.meetingEmailEnabled(id);
            jdbc.update("""
                INSERT INTO email_deliveries(id,notification_type,recipient_user_id,recipient_email,
                    related_entity_type,related_entity_id,status,skip_reason,dedupe_key,created_at,updated_at)
                VALUES (?, ?, ?, ?, 'MEETING', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT (dedupe_key) DO NOTHING
                """, UUID.randomUUID(), notificationType, id, user.email(), meeting.getId(),
                enabled ? "PENDING" : "SKIPPED", enabled ? null : "USER_PREFERENCE_DISABLED", key);
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
        int skipped = jdbc.update("""
            UPDATE email_deliveries
               SET status='SKIPPED', skip_reason='SUPERSEDED_BY_MEETING_CHANGE',
                   last_error_code=NULL,last_error_summary=NULL,next_attempt_at=NULL,
                   updated_at=clock_timestamp()
             WHERE related_entity_type='MEETING' AND related_entity_id=?
               AND notification_type IN ('MEETING_SCHEDULED','MEETING_RESCHEDULED')
               AND status IN ('PENDING','FAILED')
            """, meetingId);
        // A later committed reschedule/cancel/start/end makes queued add-invites stale.
        return skipped + jdbc.update("""
            UPDATE email_deliveries d
               SET status='SKIPPED',skip_reason='SUPERSEDED_BY_MEETING_CHANGE',
                   last_error_code=NULL,last_error_summary=NULL,next_attempt_at=NULL,
                   updated_at=clock_timestamp()
             WHERE d.notification_type='MEETING_PARTICIPANT_ADDED'
               AND d.related_entity_type='MEETING_PARTICIPANT'
               AND d.status IN ('PENDING','FAILED')
               AND EXISTS (SELECT 1 FROM meeting_participants p
                   WHERE p.id=d.related_entity_id AND p.meeting_id=?)
            """, meetingId);
    }

    /**
     * T08: membership events refer to the immutable historical membership row ID.
     * No schema change is required and remove notices do not re-grant meeting access.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void participantAdded(MeetingEntity meeting, MeetingParticipantEntity membership) {
        if (meeting.getStatus() != MeetingStatus.SCHEDULED) return;
        // A user re-added after a removal should not receive an obsolete removal notice.
        jdbc.update("""
            UPDATE email_deliveries d
               SET status='SKIPPED',skip_reason='SUPERSEDED_BY_MEETING_CHANGE',
                   last_error_code=NULL,last_error_summary=NULL,next_attempt_at=NULL,
                   updated_at=clock_timestamp()
             WHERE d.notification_type='MEETING_PARTICIPANT_REMOVED'
               AND d.related_entity_type='MEETING_PARTICIPANT'
               AND d.status IN ('PENDING','FAILED')
               AND EXISTS (SELECT 1 FROM meeting_participants p
                   WHERE p.id=d.related_entity_id AND p.meeting_id=?
                     AND p.user_id=? AND p.removed_at IS NOT NULL)
            """, meeting.getId(), membership.getUserId());
        enqueueParticipant(membership, "MEETING_PARTICIPANT_ADDED");
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void participantRemoved(MeetingEntity meeting, MeetingParticipantEntity membership) {
        if (meeting.getStatus() != MeetingStatus.SCHEDULED) return;
        // The removed recipient must not receive a stale schedule or invitation.
        jdbc.update("""
            UPDATE email_deliveries d
               SET status='SKIPPED',skip_reason='SUPERSEDED_BY_MEETING_CHANGE',
                   last_error_code=NULL,last_error_summary=NULL,next_attempt_at=NULL,
                   updated_at=clock_timestamp()
             WHERE d.status IN ('PENDING','FAILED')
               AND ((d.related_entity_type='MEETING' AND d.related_entity_id=?
                     AND d.recipient_user_id=?
                     AND d.notification_type IN ('MEETING_SCHEDULED','MEETING_RESCHEDULED'))
                 OR (d.related_entity_type='MEETING_PARTICIPANT'
                     AND d.related_entity_id=?
                     AND d.notification_type='MEETING_PARTICIPANT_ADDED'))
            """, meeting.getId(), membership.getUserId(), membership.getId());
        enqueueParticipant(membership, "MEETING_PARTICIPANT_REMOVED");
    }

    private void enqueueParticipant(MeetingParticipantEntity membership, String eventType) {
        var recipient = users.activeRecipient(membership.getUserId()).orElse(null);
        if (recipient == null) return;
        String key = "meeting-participant:" + membership.getId() + ":" + eventType;
        boolean enabled = preferences.meetingEmailEnabled(membership.getUserId());
        jdbc.update("""
            INSERT INTO email_deliveries(id,notification_type,recipient_user_id,recipient_email,
                related_entity_type,related_entity_id,status,skip_reason,dedupe_key,created_at,updated_at)
            VALUES (?,?,?,?, 'MEETING_PARTICIPANT',?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
            ON CONFLICT (dedupe_key) DO NOTHING
            """, UUID.randomUUID(), eventType, membership.getUserId(), recipient.email(),
            membership.getId(), enabled ? "PENDING" : "SKIPPED",
            enabled ? null : "USER_PREFERENCE_DISABLED", key);
    }

    /**
     * Every optional Meeting email must be authenticated against its durable
     * recipient ID, exact currently approved address, and current preferences
     * before the shared worker hands content to SMTP.
     *
     * Unlike legacy compose(id,email), this cannot accidentally authorize an
     * old intent because another account later receives the same email.
     */
    @Transactional(readOnly = true)
    public TransactionalEmailHandler.Prepared prepareMeeting(
            TransactionalEmailHandler.DeliveryContext delivery, MeetingStatus status,
            String notificationType) {
        String rejection = ineligibleRecipient(delivery, "MEETING");
        if (rejection != null) return TransactionalEmailHandler.Prepared.skipped(rejection);
        if (!currentScheduleNotice(delivery, notificationType)) {
            return TransactionalEmailHandler.Prepared.skipped("SUPERSEDED_BY_MEETING_CHANGE");
        }
        return compose(delivery.relatedEntityId(), delivery.recipientEmail(), status, notificationType)
                .map(TransactionalEmailHandler.Prepared::ready)
                .orElseGet(() -> TransactionalEmailHandler.Prepared.skipped(
                    "MEETING_NO_LONGER_ELIGIBLE"));
    }

    @Transactional(readOnly = true)
    public TransactionalEmailHandler.Prepared prepareParticipant(
            TransactionalEmailHandler.DeliveryContext delivery, boolean addition) {
        String rejection = ineligibleRecipient(delivery, "MEETING_PARTICIPANT");
        if (rejection != null) return TransactionalEmailHandler.Prepared.skipped(rejection);
        var membership = participants.findById(delivery.relatedEntityId()).orElse(null);
        if (membership == null || !delivery.recipientUserId().equals(membership.getUserId())) {
            return TransactionalEmailHandler.Prepared.skipped("MEETING_NO_LONGER_ELIGIBLE");
        }
        var content = addition
                ? composeParticipantAdded(delivery.relatedEntityId(), delivery.recipientEmail())
                : composeParticipantRemoved(delivery.relatedEntityId(), delivery.recipientEmail());
        return content.map(TransactionalEmailHandler.Prepared::ready)
                .orElseGet(() -> TransactionalEmailHandler.Prepared.skipped(
                    "MEETING_NO_LONGER_ELIGIBLE"));
    }

    private String ineligibleRecipient(TransactionalEmailHandler.DeliveryContext delivery,
            String expectedEntityType) {
        if (delivery == null || delivery.relatedEntityId() == null
                || delivery.recipientUserId() == null || delivery.recipientEmail() == null
                || !expectedEntityType.equals(delivery.relatedEntityType())) {
            return "MEETING_NO_LONGER_ELIGIBLE";
        }
        var active = users.activeRecipient(delivery.recipientUserId()).orElse(null);
        if (active == null || !delivery.recipientEmail().equals(active.email())) {
            return "RECIPIENT_NO_LONGER_ELIGIBLE";
        }
        if (!preferences.meetingEmailEnabled(delivery.recipientUserId())) {
            return "USER_PREFERENCE_DISABLED";
        }
        return null;
    }

    /**
     * A normal metadata-only meeting edit increments the aggregate's version,
     * but MUST NOT invalidate a still-useful scheduled email. Accordingly we
     * compare the event-version encoded in durable *notification intents*,
     * rather than requiring meeting.version to equal the old event version.
     *
     * A later material reschedule/cancel always records a newer schedule
     * intent, including when the recipient has opted out (SKIPPED). This
     * detects even an older SENDING attempt that pending supersession could
     * not rewrite. Malformed/foreign keys fail closed.
     */
    private boolean currentScheduleNotice(TransactionalEmailHandler.DeliveryContext delivery,
            String notificationType) {
        Long currentVersion = scheduleIntentVersion(delivery.dedupeKey(),
                delivery.relatedEntityId(), notificationType, delivery.recipientUserId());
        if (currentVersion == null) return false;
        List<Map.Entry<String,String>> recorded = jdbc.query("""
            SELECT notification_type,dedupe_key FROM email_deliveries
             WHERE related_entity_type='MEETING' AND related_entity_id=?
               AND recipient_user_id=?
               AND notification_type IN (
                   'MEETING_SCHEDULED','MEETING_RESCHEDULED','MEETING_CANCELLED')
            """, (rs, row) -> Map.entry(rs.getString(1), rs.getString(2)),
                delivery.relatedEntityId(), delivery.recipientUserId());
        if (recorded.isEmpty()) return false;
        boolean foundSelf = false;
        for (var entry : recorded) {
            Long candidateVersion = scheduleIntentVersion(entry.getValue(),
                    delivery.relatedEntityId(), entry.getKey(), delivery.recipientUserId());
            if (candidateVersion == null || candidateVersion > currentVersion) return false;
            if (delivery.dedupeKey().equals(entry.getValue())
                    && notificationType.equals(entry.getKey())) foundSelf = true;
        }
        return foundSelf;
    }

    private static Long scheduleIntentVersion(String key, UUID meetingId, String type,
            UUID userId) {
        if (key == null || meetingId == null || userId == null
                || !Set.of("MEETING_SCHEDULED", "MEETING_RESCHEDULED",
                    "MEETING_CANCELLED").contains(type)) return null;
        String prefix = "meeting:" + meetingId + ":" + type + ":";
        String suffix = ":" + userId;
        if (!key.startsWith(prefix) || !key.endsWith(suffix)
                || key.length() <= prefix.length() + suffix.length()) return null;
        try {
            long version = Long.parseLong(
                key.substring(prefix.length(), key.length() - suffix.length()));
            return version < 0 ? null : version;
        } catch (NumberFormatException bad) {
            return null;
        }
    }

    @Transactional(readOnly = true)
    public Optional<TransactionalEmailHandler.Content> composeParticipantAdded(UUID membershipId,
            String email) {
        var member = participants.findById(membershipId).orElse(null);
        if (member == null || member.getRemovedAt() != null) return Optional.empty();
        var meeting = meetings.findById(member.getMeetingId()).orElse(null);
        if (meeting == null || meeting.getStatus() != MeetingStatus.SCHEDULED) return Optional.empty();
        var recipient = users.activeRecipientByEmail(email).orElse(null);
        if (recipient == null || !recipient.id().equals(member.getUserId())) return Optional.empty();
        return Optional.of(new TransactionalEmailHandler.Content("Meeting invitation",
            "You have been added to a scheduled meeting. Sign in to see its details."));
    }

    /**
     * Removal is intentionally generic: the recipient has lost Meeting read access.
     * The historical membership row proves their own removal, while a later re-add
     * invalidates the old notice. Never render Meeting title, room or schedule here.
     */
    @Transactional(readOnly = true)
    public Optional<TransactionalEmailHandler.Content> composeParticipantRemoved(UUID membershipId,
            String email) {
        var member = participants.findById(membershipId).orElse(null);
        if (member == null || member.getRemovedAt() == null) return Optional.empty();
        var recipient = users.activeRecipientByEmail(email).orElse(null);
        if (recipient == null || !recipient.id().equals(member.getUserId())) return Optional.empty();
        if (participants.existsByMeetingIdAndUserIdAndRemovedAtIsNull(
                member.getMeetingId(), member.getUserId())) return Optional.empty();
        return Optional.of(new TransactionalEmailHandler.Content("Meeting participation updated",
            "You are no longer a participant in a meeting. Contact its organizer if unexpected."));
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
