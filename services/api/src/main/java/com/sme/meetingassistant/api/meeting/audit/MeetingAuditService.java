package com.sme.meetingassistant.api.meeting.audit;

import com.sme.meetingassistant.api.audit.TransactionalAuditWriter;
import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingParticipantEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Meeting-specific allowlisted events. Do not persist free-text meeting content,
 * request bodies or opaque credentials in the audit metadata.
 */
@Service
public class MeetingAuditService {
    private enum Action {
        MEETING_CREATED, MEETING_UPDATED, MEETING_RESCHEDULED,
        MEETING_SCHEDULED, MEETING_STARTED, MEETING_ENDED, MEETING_CANCELLED,
        MEETING_PARTICIPANT_ADDED, MEETING_PARTICIPANT_REMOVED
    }

    public record Snapshot(String title, String description, OffsetDateTime start,
            OffsetDateTime end, UUID roomId) {
        public static Snapshot of(MeetingEntity meeting) {
            return new Snapshot(meeting.getTitle(), meeting.getDescription(),
                meeting.getScheduledStartAt(), meeting.getScheduledEndAt(), meeting.getRoomId());
        }
    }

    private final TransactionalAuditWriter writer;

    public MeetingAuditService(TransactionalAuditWriter writer) {
        this.writer = writer;
    }

    public void created(MeetingEntity meeting, List<MeetingParticipantEntity> initialMemberships) {
        Map<String, Object> metadata = base();
        metadata.put("status", meeting.getStatus().name());
        metadata.put("initialParticipantCount", initialMemberships.size());
        record(meeting, Action.MEETING_CREATED, "MEETING", meeting.getId(), metadata);
        for (MeetingParticipantEntity participant : initialMemberships) {
            membership(meeting, participant, Action.MEETING_PARTICIPANT_ADDED, "INITIAL");
        }
    }

    public void updated(MeetingEntity meeting, Snapshot before) {
        List<String> fields = new ArrayList<>();
        Map<String, Object> previousSchedule = new LinkedHashMap<>();
        Map<String, Object> nextSchedule = new LinkedHashMap<>();
        Snapshot after = Snapshot.of(meeting);
        if (!Objects.equals(before.title(), after.title())) fields.add("title");
        if (!Objects.equals(before.description(), after.description())) fields.add("description");
        if (!sameInstant(before.start(), after.start())) {
            fields.add("scheduledStartAt");
            previousSchedule.put("scheduledStartAt", before.start());
            nextSchedule.put("scheduledStartAt", after.start());
        }
        if (!sameInstant(before.end(), after.end())) {
            fields.add("scheduledEndAt");
            previousSchedule.put("scheduledEndAt", before.end());
            nextSchedule.put("scheduledEndAt", after.end());
        }
        if (!Objects.equals(before.roomId(), after.roomId())) {
            fields.add("roomId");
            previousSchedule.put("roomId", before.roomId());
            nextSchedule.put("roomId", after.roomId());
        }
        if (fields.isEmpty()) return; // No synthetic event for no-op PATCH.
        boolean changedSchedule = !previousSchedule.isEmpty();
        Action action = changedSchedule && meeting.getStatus() == MeetingStatus.SCHEDULED
            ? Action.MEETING_RESCHEDULED : Action.MEETING_UPDATED;
        Map<String, Object> metadata = base();
        metadata.put("changedFields", List.copyOf(fields));
        if (changedSchedule) {
            metadata.put("before", previousSchedule);
            metadata.put("after", nextSchedule);
        }
        record(meeting, action, "MEETING", meeting.getId(), metadata);
    }

    public void scheduled(MeetingEntity meeting) {
        transition(meeting, Action.MEETING_SCHEDULED, MeetingStatus.DRAFT);
    }

    public void started(MeetingEntity meeting) {
        transition(meeting, Action.MEETING_STARTED, MeetingStatus.SCHEDULED);
    }

    public void ended(MeetingEntity meeting) {
        transition(meeting, Action.MEETING_ENDED, MeetingStatus.IN_PROGRESS);
    }

    public void cancelled(MeetingEntity meeting, MeetingStatus previous) {
        transition(meeting, Action.MEETING_CANCELLED, previous);
    }

    public void participantAdded(MeetingEntity meeting, MeetingParticipantEntity membership) {
        membership(meeting, membership, Action.MEETING_PARTICIPANT_ADDED, "MANUAL");
    }

    public void participantRemoved(MeetingEntity meeting, MeetingParticipantEntity membership) {
        membership(meeting, membership, Action.MEETING_PARTICIPANT_REMOVED, "MANUAL");
    }

    private void transition(MeetingEntity meeting, Action action, MeetingStatus previous) {
        Map<String, Object> metadata = base();
        metadata.put("fromStatus", previous.name());
        metadata.put("toStatus", meeting.getStatus().name());
        if (action == Action.MEETING_SCHEDULED) {
            // Scheduled timestamps are authoritative; not user-supplied audit data.
            metadata.put("scheduledStartAt", meeting.getScheduledStartAt());
            metadata.put("scheduledEndAt", meeting.getScheduledEndAt());
            metadata.put("roomId", meeting.getRoomId());
        }
        record(meeting, action, "MEETING", meeting.getId(), metadata);
    }

    private void membership(MeetingEntity meeting, MeetingParticipantEntity membership,
            Action action, String source) {
        Map<String, Object> metadata = base();
        metadata.put("affectedUserId", membership.getUserId());
        metadata.put("source", source);
        record(meeting, action, "MEETING_PARTICIPANT", membership.getId(), metadata);
    }

    private void record(MeetingEntity meeting, Action action, String entityType, UUID entityId,
            Map<String, Object> metadata) {
        // Current canonical mutation authorization is organizer-only.
        writer.record(meeting.getOrganizerUserId(), action.name(), entityType, entityId,
            meeting.getId(), metadata);
    }

    private static Map<String, Object> base() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("schemaVersion", 1);
        value.put("outcome", "SUCCESS");
        return value;
    }

    private static boolean sameInstant(OffsetDateTime first, OffsetDateTime second) {
        return first == null ? second == null
            : second != null && first.toInstant().equals(second.toInstant());
    }
}
