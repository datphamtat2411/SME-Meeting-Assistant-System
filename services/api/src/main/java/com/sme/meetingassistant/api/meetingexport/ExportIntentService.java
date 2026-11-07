package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * DE-06 internal admission boundary. NO public export POST is exposed until
 * DE-09 can actually execute the job and D09/D10 policy has been approved.
 * A future HTTP adapter must call this service, never the repository directly.
 */
@Service
public class ExportIntentService {
    private final MeetingMediaAccess access;
    private final AuthenticatedUserId identity;
    private final MeetingExportRepository repository;

    public ExportIntentService(MeetingMediaAccess access, AuthenticatedUserId identity,
            MeetingExportRepository repository) {
        this.access = access;
        this.identity = identity;
        this.repository = repository;
    }

    @Transactional
    public ExportRecord create(UUID meetingId, ExportFormat format, String idempotencyKey) {
        Objects.requireNonNull(meetingId, "meetingId");
        Objects.requireNonNull(format, "format");
        // Authorization is checked EVEN ON REPLAY. Neither idempotency receipt,
        // previous membership, administrative role nor a UUID is access authority.
        UUID actorId = identity.requireUserId();
        access.requireReadable(meetingId, actorId);
        ExportDigests.requireKey(idempotencyKey);
        return repository.enqueue(actorId, meetingId, format, idempotencyKey);
    }
}
