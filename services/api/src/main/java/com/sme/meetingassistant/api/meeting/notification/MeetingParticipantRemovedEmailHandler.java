package com.sme.meetingassistant.api.meeting.notification;

import com.sme.meetingassistant.api.notification.email.TransactionalEmailHandler;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** T08: content-minimized notice referencing historical removed membership. */
@Component
public final class MeetingParticipantRemovedEmailHandler implements TransactionalEmailHandler {
    private final MeetingNotificationService notifications;
    public MeetingParticipantRemovedEmailHandler(MeetingNotificationService notifications) {
        this.notifications = notifications;
    }
    @Override public String notificationType() { return "MEETING_PARTICIPANT_REMOVED"; }
    @Override public Optional<Content> compose(UUID membershipId, String recipientEmail) {
        return notifications.composeParticipantRemoved(membershipId, recipientEmail);
    }
}
