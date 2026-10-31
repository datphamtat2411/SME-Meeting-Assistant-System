package com.sme.meetingassistant.api.notification.preferences;

/** Server-persisted personal preferences shared by Web and Mobile. */
public record UserNotificationPreferences(
        String timezone,
        String locale,
        boolean meetingEmailEnabled,
        boolean actionItemEmailEnabled) { }
