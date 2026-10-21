package com.sme.meetingassistant.api.roomscheduling.service;
import java.time.OffsetDateTime;
import java.util.UUID;
/** Cross-feature port. The meeting module supplies the adapter when meeting-linked bookings are enabled. */
public interface MeetingReservationAccess {
    void requireReservable(UUID meetingId,UUID organizationId,UUID callerId,OffsetDateTime start,OffsetDateTime end);
}
