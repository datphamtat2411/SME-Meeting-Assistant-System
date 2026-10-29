package com.sme.meetingassistant.api.meeting.service;

import com.sme.meetingassistant.api.meeting.dto.*;
import com.sme.meetingassistant.api.meeting.entity.*;
import com.sme.meetingassistant.api.meeting.repository.*;
import com.sme.meetingassistant.api.meeting.notification.MeetingNotificationService;
import com.sme.meetingassistant.api.room.entity.RoomStatus;
import com.sme.meetingassistant.api.room.service.RoomCatalogService;
import com.sme.meetingassistant.api.room.reservation.RoomReservationService;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalIdentityLookup;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalAuthorizationService;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.*;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.http.HttpStatus;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@Transactional
public class MeetingCoreService {
    private static final Set<String> EDITABLE = Set.of(
        "title", "description", "scheduledStartAt", "scheduledEndAt", "roomId");

    private final MeetingRepository meetings;
    private final MeetingParticipantRepository participants;
    private final RoomCatalogService rooms;
    private final OrganizationalIdentityLookup users;
    private final OrganizationalAuthorizationService authorization;
    private final MeetingNotificationService notifications;
    private final RoomReservationService reservations;

    public MeetingCoreService(MeetingRepository meetings, MeetingParticipantRepository participants,
            RoomCatalogService rooms, OrganizationalIdentityLookup users, OrganizationalAuthorizationService authorization,
            MeetingNotificationService notifications, RoomReservationService reservations) {
        this.meetings = meetings; this.participants = participants;
        this.rooms = rooms; this.users = users;
        this.authorization = authorization; this.notifications = notifications;
        this.reservations = reservations;
    }

    public MeetingEntity create(CreateMeetingRequest request) {
        UserEntity actor = authorization.requireActiveActor();
        String title = requiredTitle(request.title());
        validateSchedule(request.scheduledStartAt(), request.scheduledEndAt());
        validateDraftRoom(request.roomId());
        MeetingEntity meeting = new MeetingEntity(actor.getId(), title, optional(request.description()));
        meeting.editDraftSchedule(request.scheduledStartAt(), request.scheduledEndAt(), request.roomId());

        Set<UUID> initial = new LinkedHashSet<>();
        initial.add(actor.getId()); // organizer has explicit historical association
        if (request.participantUserIds() != null) {
            for (UUID participantId : request.participantUserIds()) {
                if (participantId == null || !initial.add(participantId)) throw invalid();
                eligible(participantId);
            }
        }
        meetings.saveAndFlush(meeting);
        for (UUID participantId : initial) {
            participants.save(new MeetingParticipantEntity(meeting.getId(), participantId, actor.getId()));
        }
        participants.flush();
        return meeting;
    }

    @Transactional(readOnly = true)
    public MeetingEntity detail(UUID id) {
        UUID actor = authorization.requireActiveActor().getId();
        MeetingEntity meeting = lookup(id);
        requireAccess(meeting, actor);
        return meeting;
    }

    /**
     * Organizer-only schedule preview boundary. A known meeting ID never grants
     * permission to exclude someone else's reservation from availability.
     */
    @Transactional(readOnly = true)
    public MeetingEntity previewOwned(UUID meetingId) {
        return owned(meetingId);
    }

    @Transactional(readOnly = true)
    public Page<MeetingView> list(MeetingStatus status, String q, UUID organizerId, UUID roomId,
            OffsetDateTime from, OffsetDateTime to, Pageable pageable) {
        UUID actor = authorization.requireActiveActor().getId();
        if (from != null && to != null && !from.isBefore(to)) throw invalid();
        Specification<MeetingEntity> spec = (root, query, cb) -> {
            var sub = query.subquery(Integer.class);
            var participant = sub.from(MeetingParticipantEntity.class);
            sub.select(cb.literal(1)).where(
                cb.equal(participant.get("meetingId"), root.get("id")),
                cb.equal(participant.get("userId"), actor),
                cb.isNull(participant.get("removedAt")));
            return cb.or(cb.equal(root.get("organizerUserId"), actor), cb.exists(sub));
        };
        if (status != null) spec = spec.and((r,qry,cb)->cb.equal(r.get("status"), status));
        if (organizerId != null) spec = spec.and((r,qry,cb)->cb.equal(r.get("organizerUserId"), organizerId));
        if (roomId != null) spec = spec.and((r,qry,cb)->cb.equal(r.get("roomId"), roomId));
        if (from != null) spec = spec.and((r,qry,cb)->cb.greaterThan(r.get("scheduledEndAt"), from));
        if (to != null) spec = spec.and((r,qry,cb)->cb.lessThan(r.get("scheduledStartAt"), to));
        if (q != null && !q.isBlank()) {
            String pattern = "%" + q.trim().toLowerCase(Locale.ROOT)
                .replace("\\","\\\\").replace("%","\\%").replace("_","\\_") + "%";
            spec = spec.and((r,qry,cb)->cb.like(cb.lower(r.get("title")), pattern, '\\'));
        }
        return meetings.findAll(spec, pageable).map(MeetingView::from);
    }

    public MeetingEntity update(UUID id, String ifMatch, Map<String, Object> patch) {
        MeetingEntity meeting = owned(id);
        MeetingVersionTags.requireMatch(meeting, ifMatch);
        if (meeting.getStatus() != MeetingStatus.DRAFT
                && meeting.getStatus() != MeetingStatus.SCHEDULED) throw conflict();
        if (patch == null || patch.isEmpty() || !EDITABLE.containsAll(patch.keySet())) throw invalid();
        String title = meeting.getTitle(), description = meeting.getDescription();
        OffsetDateTime start = meeting.getScheduledStartAt(), end = meeting.getScheduledEndAt();
        UUID room = meeting.getRoomId();
        boolean scheduleChanged = false;
        for (var item : patch.entrySet()) {
            switch (item.getKey()) {
                case "title" -> title = requiredTitle(asString(item.getValue()));
                case "description" -> description = optional(asString(item.getValue()));
                case "scheduledStartAt" -> { start = asTime(item.getValue()); scheduleChanged = true; }
                case "scheduledEndAt" -> { end = asTime(item.getValue()); scheduleChanged = true; }
                case "roomId" -> { room = asId(item.getValue()); scheduleChanged = true; }
                default -> throw invalid();
            }
        }
        validateSchedule(start, end);
        boolean materialChange = scheduleChanged
            && (!Objects.equals(meeting.getRoomId(), room)
                || !sameInstant(meeting.getScheduledStartAt(), start)
                || !sameInstant(meeting.getScheduledEndAt(), end));
        // Historical metadata is mutable only where the lifecycle permits;
        // rescheduling an in-progress or ended meeting is never allowed.
        if (materialChange) {
            if (meeting.getStatus() == MeetingStatus.DRAFT) {
                validateDraftRoom(room);
            } else {
                if (start == null) throw invalid();
            }
            meeting.editDraftSchedule(start, end, room);
        }
        meeting.editMetadata(title, description);
        MeetingEntity committed = flush(meeting);
        if (materialChange && meeting.getStatus() == MeetingStatus.SCHEDULED) {
            reservations.synchronizeCommitted(meeting.getId());
            notifications.supersedePendingScheduleNotices(meeting.getId());
            notifications.enqueue(committed, "MEETING_RESCHEDULED");
        }
        return committed;
    }

    public MeetingEntity schedule(UUID id, String ifMatch, ScheduleMeetingRequest request) {
        MeetingEntity meeting = owned(id);
        MeetingVersionTags.requireMatch(meeting, ifMatch);
        if (meeting.getStatus() != MeetingStatus.DRAFT) throw conflict();
        OffsetDateTime start = meeting.getScheduledStartAt(), end = meeting.getScheduledEndAt();
        if (request != null && (request.scheduledStartAt() != null || request.scheduledEndAt() != null)) {
            start = request.scheduledStartAt(); end = request.scheduledEndAt();
        }
        validateSchedule(start, end);
        if (start == null) throw invalid();
        meeting.editDraftSchedule(start, end, meeting.getRoomId());
        meeting.scheduleRoomless();
        MeetingEntity committed = flush(meeting);
        reservations.synchronizeCommitted(meeting.getId());
        notifications.enqueue(committed, "MEETING_SCHEDULED");
        return committed;
    }

    public MeetingEntity start(UUID id, String ifMatch) {
        MeetingEntity meeting = owned(id);
        MeetingVersionTags.requireMatch(meeting, ifMatch);
        if (meeting.getStatus() != MeetingStatus.SCHEDULED) throw conflict();
        meeting.start(OffsetDateTime.now(ZoneOffset.UTC));
        MeetingEntity committed = flush(meeting);
        notifications.supersedePendingScheduleNotices(meeting.getId());
        return committed;
    }

    public MeetingEntity end(UUID id, String ifMatch) {
        MeetingEntity meeting = owned(id);
        MeetingVersionTags.requireMatch(meeting, ifMatch);
        if (meeting.getStatus() != MeetingStatus.IN_PROGRESS) throw conflict();
        meeting.end(OffsetDateTime.now(ZoneOffset.UTC));
        MeetingEntity committed = flush(meeting);
        reservations.releaseEnded(meeting.getId());
        notifications.supersedePendingScheduleNotices(meeting.getId());
        return committed;
    }

    public MeetingEntity cancel(UUID id, String ifMatch, CancelMeetingRequest request) {
        MeetingEntity meeting = owned(id);
        MeetingVersionTags.requireMatch(meeting, ifMatch);
        if (meeting.getStatus() != MeetingStatus.DRAFT && meeting.getStatus() != MeetingStatus.SCHEDULED) {
            throw conflict();
        }
        boolean wasScheduled = meeting.getStatus() == MeetingStatus.SCHEDULED;
        meeting.cancel(OffsetDateTime.now(ZoneOffset.UTC),
            request == null ? null : optional(request.reason()));
        MeetingEntity committed = flush(meeting);
        if (wasScheduled) {
            reservations.releaseCancelled(meeting.getId());
            notifications.supersedePendingScheduleNotices(meeting.getId());
            notifications.enqueue(committed, "MEETING_CANCELLED");
        }
        return committed;
    }

    public ParticipantView addParticipant(UUID meetingId, String ifMatch, AddParticipantRequest request) {
        MeetingEntity meeting = owned(meetingId);
        MeetingVersionTags.requireMatch(meeting, ifMatch);
        if (meeting.getStatus() == MeetingStatus.ENDED || meeting.getStatus() == MeetingStatus.CANCELLED) throw conflict();
        UUID userId = request.userId();
        if (userId == null) throw invalid();
        eligible(userId);
        if (participants.existsByMeetingIdAndUserIdAndRemovedAtIsNull(meetingId, userId)) throw conflict();
        MeetingParticipantEntity record;
        try {
            record = participants.saveAndFlush(new MeetingParticipantEntity(meetingId, userId, meeting.getOrganizerUserId()));
        } catch (DataIntegrityViolationException duplicate) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, null, duplicate);
        }
        meeting.touch();
        MeetingEntity committed = flush(meeting);
        notifications.participantAdded(committed, record);
        return ParticipantView.from(record);
    }

    public void removeParticipant(UUID meetingId, UUID userId, String ifMatch) {
        MeetingEntity meeting = owned(meetingId);
        MeetingVersionTags.requireMatch(meeting, ifMatch);
        if (meeting.getStatus() == MeetingStatus.ENDED || meeting.getStatus() == MeetingStatus.CANCELLED) throw conflict();
        if (meeting.getOrganizerUserId().equals(userId)) throw conflict();
        MeetingParticipantEntity participant = participants
            .findByMeetingIdAndUserIdAndRemovedAtIsNull(meetingId, userId)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        participant.remove(meeting.getOrganizerUserId());
        participants.flush();
        meeting.touch();
        MeetingEntity committed = flush(meeting);
        notifications.participantRemoved(committed, participant);
    }

    @Transactional(readOnly = true)
    public List<ParticipantView> listParticipants(UUID meetingId) {
        MeetingEntity meeting = lookup(meetingId);
        requireAccess(meeting, authorization.requireActiveActor().getId());
        return participants.findByMeetingIdOrderByAddedAtAsc(meetingId).stream()
            .map(ParticipantView::from).toList();
    }

    private MeetingEntity owned(UUID id) {
        UUID actor = authorization.requireActiveActor().getId();
        MeetingEntity meeting = lookup(id);
        if (!meeting.getOrganizerUserId().equals(actor)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return meeting;
    }
    private MeetingEntity lookup(UUID id) {
        return meetings.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }
    private void requireAccess(MeetingEntity meeting, UUID actor) {
        if (!meeting.getOrganizerUserId().equals(actor)
                && !participants.existsByMeetingIdAndUserIdAndRemovedAtIsNull(meeting.getId(), actor)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
    }
    private void eligible(UUID id) {
        if (!users.isActive(id)) {
            throw invalid();
        }
    }
    private void validateDraftRoom(UUID id) {
        if (id != null && rooms.get(id).getStatus() != RoomStatus.ACTIVE) throw invalid();
    }
    private static boolean sameInstant(OffsetDateTime a, OffsetDateTime b) {
        return a == null ? b == null : b != null && a.toInstant().equals(b.toInstant());
    }
    private static void validateSchedule(OffsetDateTime start, OffsetDateTime end) {
        if ((start == null) != (end == null) || (start != null && !start.isBefore(end))) throw invalid();
    }
    private static String requiredTitle(String value) {
        if (value == null || value.isBlank() || value.trim().length()>255) throw invalid();
        return value.trim();
    }
    private static String optional(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
    private static String asString(Object value) {
        if (value == null) return null;
        if (!(value instanceof String s)) throw invalid();
        return s;
    }
    private static UUID asId(Object value) {
        if (value == null) return null;
        if (!(value instanceof String s)) throw invalid();
        try { return UUID.fromString(s); }
        catch (IllegalArgumentException bad) { throw invalid(); }
    }
    private static OffsetDateTime asTime(Object value) {
        if (value == null) return null;
        if (!(value instanceof String s)) throw invalid();
        try { return OffsetDateTime.parse(s); }
        catch (RuntimeException bad) { throw invalid(); }
    }
    private MeetingEntity flush(MeetingEntity meeting) {
        try { return meetings.saveAndFlush(meeting); }
        catch (ObjectOptimisticLockingFailureException stale) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED, null, stale);
        }
    }
    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
    }
    private static ResponseStatusException conflict() {
        return new ResponseStatusException(HttpStatus.CONFLICT);
    }
}
