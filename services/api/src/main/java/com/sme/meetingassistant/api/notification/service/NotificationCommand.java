package com.sme.meetingassistant.api.notification.service;

import com.sme.meetingassistant.api.notification.dto.CreateNotificationCommand;
import com.sme.meetingassistant.api.notification.dto.NotificationResponse;

/** Application boundary for feature events that create in-app inbox notifications. */
public interface NotificationCommand {

	NotificationResponse create(CreateNotificationCommand command);

}
