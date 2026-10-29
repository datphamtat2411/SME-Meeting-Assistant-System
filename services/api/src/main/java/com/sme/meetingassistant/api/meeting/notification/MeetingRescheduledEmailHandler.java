package com.sme.meetingassistant.api.meeting.notification;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.notification.email.TransactionalEmailHandler;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** Uses the already configured transactional email delivery worker. */
@Component
public class MeetingRescheduledEmailHandler implements TransactionalEmailHandler {
    private final MeetingNotificationService notifications;
    public MeetingRescheduledEmailHandler(MeetingNotificationService notifications) {
        this.notifications = notifications;
    }
    @Override public String notificationType() { return "MEETING_RESCHEDULED"; }
    @Override public Optional<Content> compose(UUID meetingId, String recipientEmail) {
        return notifications.compose(meetingId,recipientEmail,MeetingStatus.SCHEDULED,"MEETING_RESCHEDULED");
    }
}
