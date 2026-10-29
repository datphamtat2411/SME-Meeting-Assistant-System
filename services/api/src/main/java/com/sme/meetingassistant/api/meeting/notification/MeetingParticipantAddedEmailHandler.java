package com.sme.meetingassistant.api.meeting.notification;

import com.sme.meetingassistant.api.notification.email.TransactionalEmailHandler;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** T08: invitation for a newly added participant in an already scheduled meeting. */
@Component
public final class MeetingParticipantAddedEmailHandler implements TransactionalEmailHandler {
    private final MeetingNotificationService notifications;
    public MeetingParticipantAddedEmailHandler(MeetingNotificationService notifications) {
        this.notifications = notifications;
    }
    @Override public String notificationType() { return "MEETING_PARTICIPANT_ADDED"; }
    @Override public Optional<Content> compose(UUID membershipId, String recipientEmail) {
        return notifications.composeParticipantAdded(membershipId, recipientEmail);
    }
}
