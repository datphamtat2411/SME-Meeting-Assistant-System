package com.sme.meetingassistant.api.meeting.notification;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.notification.email.TransactionalEmailHandler;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

@Component
public class MeetingScheduledEmailHandler implements TransactionalEmailHandler {
    private final MeetingNotificationService notifications;
    public MeetingScheduledEmailHandler(MeetingNotificationService notifications) { this.notifications = notifications; }
    @Override public String notificationType() { return "MEETING_SCHEDULED"; }
    @Override public Optional<Content> compose(UUID meetingId, String recipientEmail) {
        return notifications.compose(meetingId,recipientEmail,MeetingStatus.SCHEDULED,"MEETING_SCHEDULED");
    }
}
