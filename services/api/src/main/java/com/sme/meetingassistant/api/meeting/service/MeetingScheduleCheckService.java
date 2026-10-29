package com.sme.meetingassistant.api.meeting.service;

import com.sme.meetingassistant.api.meeting.dto.MeetingScheduleCheckRequest;
import com.sme.meetingassistant.api.meeting.dto.MeetingScheduleCheckView;
import com.sme.meetingassistant.api.meeting.dto.MeetingScheduleCheckView.Warning;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.repository.MeetingParticipantRepository;
import com.sme.meetingassistant.api.room.availability.RoomAvailabilityService;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalAuthorizationService;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalIdentityLookup;
import java.time.OffsetDateTime;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * One read-only transaction; no write API and no participant calendar disclosure.
 * A warning is emitted only when the overlapping meeting is accessible to caller.
 */
@Service
@Transactional(readOnly = true)
public class MeetingScheduleCheckService {
    private final MeetingCoreService meetings;
    private final MeetingParticipantRepository participants;
    private final RoomAvailabilityService availability;
    private final OrganizationalAuthorizationService authorization;
    private final OrganizationalIdentityLookup identities;
    private final NamedParameterJdbcTemplate jdbc;

    public MeetingScheduleCheckService(MeetingCoreService meetings,
            MeetingParticipantRepository participants,RoomAvailabilityService availability,
            OrganizationalAuthorizationService authorization,OrganizationalIdentityLookup identities,
            NamedParameterJdbcTemplate jdbc) {
        this.meetings=meetings;this.participants=participants;this.availability=availability;
        this.authorization=authorization;this.identities=identities;this.jdbc=jdbc;
    }

    public MeetingScheduleCheckView check(MeetingScheduleCheckRequest request) {
        if (request == null) throw invalid();
        UUID actor=authorization.requireActiveActor().getId();
        RoomAvailabilityService.requireInterval(request.start(),request.end());
        UUID exclude=request.meetingId();
        UUID organizer=actor;
        if (exclude!=null) {
            var own=meetings.previewOwned(exclude);
            // A preview cannot promise that a terminal/in-progress occurrence
            // may be rescheduled. This matches the authoritative PATCH guard.
            if (own.getStatus() != MeetingStatus.DRAFT
                    && own.getStatus() != MeetingStatus.SCHEDULED) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Meeting lifecycle does not permit schedule changes");
            }
            organizer=own.getOrganizerUserId();
        }
        Set<UUID> people=new LinkedHashSet<>();
        people.add(organizer);
        List<UUID> supplied=request.participantUserIds();
        if (supplied!=null) {
            if (supplied.size()>100) throw invalid();
            for(UUID id:supplied) {
                if(id==null || !people.add(id)) throw invalid();
                if(!identities.isActive(id)) throw invalid();
            }
        } else if(exclude!=null) {
            for (var person:participants.findByMeetingIdAndRemovedAtIsNull(exclude)) {
                people.add(person.getUserId());
            }
        }
        Integer count=people.size();
        var room=request.roomId()==null ? null : availability.inspect(
            request.roomId(),request.start(),request.end(),exclude,count);
        boolean conflict=room!=null && !room.available();
        List<Warning> warnings=new ArrayList<>();
        if(room!=null && Boolean.TRUE.equals(room.capacityExceeded()))
            warnings.add(new Warning("CAPACITY_ADVISORY_EXCEEDED",null));

        MapSqlParameterSource args=new MapSqlParameterSource()
            .addValue("actor",actor).addValue("start",request.start())
            .addValue("end",request.end()).addValue("ids",List.copyOf(people));
        String sql="""
            SELECT DISTINCT mp.user_id
            FROM meetings m
            JOIN meeting_participants mp ON mp.meeting_id=m.id AND mp.removed_at IS NULL
            WHERE m.status IN ('SCHEDULED','IN_PROGRESS')
              AND m.scheduled_start_at < CAST(:end AS timestamptz)
              AND m.scheduled_end_at > CAST(:start AS timestamptz)
              AND mp.user_id IN (:ids)
              AND (m.organizer_user_id=:actor OR EXISTS (
                  SELECT 1 FROM meeting_participants caller
                  WHERE caller.meeting_id=m.id AND caller.user_id=:actor
                    AND caller.removed_at IS NULL
              ))
            """;
        if(exclude!=null) {
            sql += " AND m.id<>:exclude";
            args.addValue("exclude",exclude);
        }
        Set<UUID> occupied=new HashSet<>(jdbc.query(sql,args,
            (rs,i)->rs.getObject("user_id",UUID.class)));
        for(UUID id:people) {
            if(occupied.contains(id)) warnings.add(new Warning("PARTICIPANT_OVERLAP",id));
        }
        return new MeetingScheduleCheckView(true,!conflict,conflict,room,List.copyOf(warnings));
    }

    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
    }
}
