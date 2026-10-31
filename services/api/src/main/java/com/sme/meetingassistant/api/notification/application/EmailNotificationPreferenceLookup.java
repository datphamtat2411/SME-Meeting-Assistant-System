package com.sme.meetingassistant.api.notification.application;

import java.util.UUID;

/** Cross-feature read boundary for optional transactional-email preferences. */
public interface EmailNotificationPreferenceLookup {
    boolean meetingEmailEnabled(UUID userId);

    boolean actionItemEmailEnabled(UUID userId);
}
