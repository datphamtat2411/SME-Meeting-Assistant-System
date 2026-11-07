package com.sme.meetingassistant.api.dashboard;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.actionitems.application.ActionItemReportingPort;
import com.sme.meetingassistant.api.dashboard.query.DashboardReportingQueries;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.service.MeetingReportingPort;
import com.sme.meetingassistant.api.media.service.ProcessingReportingPort;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@ActiveProfiles("test")
@SpringBootTest(properties = "app.action-items.business-zone=Asia/Ho_Chi_Minh")
@Import(PostgresTestConfiguration.class)
@Transactional
class ReportingQueryIntegrationTests {
    private static final Instant NOW = Instant.parse("2026-11-07T00:30:00Z");
    private static final Instant FROM = Instant.parse("2026-11-01T00:00:00Z");
    private static final Instant TO = Instant.parse("2026-12-01T00:00:00Z");

    @Autowired JdbcTemplate jdbc;
    @Autowired MeetingReportingPort meetingReports;
    @Autowired ActionItemReportingPort actionReports;
    @Autowired ProcessingReportingPort processingReports;
    @Autowired DashboardReportingQueries coordinator;

    @AfterEach
    void clearRequestContext() {
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void meetingCountsAndBoundedWindowsScopeBeforeCountingAndIgnoreDuplicateMembership() {
        UUID alice = user("EMPLOYEE");
        UUID bob = user("EMPLOYEE");
        UUID outsider = user("EMPLOYEE");
        UUID admin = user("ADMINISTRATOR");
        UUID own = meeting(alice, "SCHEDULED", NOW.plusSeconds(3600), null);
        participant(own, alice); // organizer/participant overlap must count once
        UUID invited = meeting(bob, "SCHEDULED", NOW.plusSeconds(7200), null);
        participant(invited, alice);
        UUID ended = meeting(alice, "ENDED", null, NOW.minusSeconds(3600));
        UUID hidden = meeting(outsider, "SCHEDULED", NOW.plusSeconds(5400), null);

        Map<MeetingStatus, Long> counts = as(alice, () -> meetingReports.countVisibleByStatus(alice));
        assertThat(counts.get(MeetingStatus.SCHEDULED)).isEqualTo(2L);
        assertThat(counts.get(MeetingStatus.ENDED)).isEqualTo(1L);
        assertThat(counts.get(MeetingStatus.CANCELLED)).isZero();

        List<MeetingReportingPort.MeetingRow> scheduled = as(alice, () ->
            meetingReports.scheduledStartingIn(alice, NOW, TO, 2));
        assertThat(scheduled.stream().map(MeetingReportingPort.MeetingRow::id))
            .containsExactly(own, invited)
            .doesNotContain(hidden);
        assertThat(as(alice, () -> meetingReports.scheduledStartingIn(alice, NOW, TO, 1)))
            .extracting(MeetingReportingPort.MeetingRow::id).containsExactly(own);
        assertThat(as(alice, () -> meetingReports.endedIn(alice, FROM, NOW, 10)))
            .extracting(MeetingReportingPort.MeetingRow::id).containsExactly(ended);
        assertThat(as(admin, () -> meetingReports.countVisibleByStatus(admin)).values())
            .containsOnly(0L);

        // Exact exclusive end: item whose start is TO must not be selected.
        UUID atEnd = meeting(alice, "SCHEDULED", TO, null);
        assertThat(as(alice, () -> meetingReports.scheduledStartingIn(alice, NOW, TO, 10)))
            .extracting(MeetingReportingPort.MeetingRow::id).doesNotContain(atEnd);

        // Current removal takes immediate effect even if historic participation is retained.
        jdbc.update("UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP "
            + "WHERE meeting_id=? AND user_id=? AND removed_at IS NULL", invited, alice);
        assertThat(as(alice, () -> meetingReports.countVisibleByStatus(alice))
            .get(MeetingStatus.SCHEDULED)).isEqualTo(2L); // own + atEnd
        assertThat(as(alice, () -> meetingReports.scheduledStartingIn(alice, NOW, TO, 10)))
            .extracting(MeetingReportingPort.MeetingRow::id).containsExactly(own);
    }

    @Test
    void actorIdentityIsServerBoundAndInactiveUsersCannotQueryAnything() {
        UUID alice = user("EMPLOYEE");
        UUID bob = user("EMPLOYEE");
        meeting(alice, "SCHEDULED", NOW.plusSeconds(3600), null);

        assertThatThrownBy(() -> as(bob, () -> meetingReports.countVisibleByStatus(alice)))
            .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> as(bob, () -> actionReports.assignedOfficial(alice, NOW)))
            .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> as(bob, () -> processingReports.visibleJobStatusCounts(alice)))
            .isInstanceOf(ResponseStatusException.class);

        jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?", alice);
        assertThatThrownBy(() -> as(alice, () -> meetingReports.countVisibleByStatus(alice)))
            .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> as(alice, () -> actionReports.assignedOfficial(alice, NOW)))
            .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> as(alice, () -> processingReports.visibleJobStatusCounts(alice)))
            .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void actionReportsRespectIndependentOfficialAssigneeAndGrantedManagerScope() {
        UUID unitOne = unit();
        UUID unitTwo = unit();
        UUID organizer = user("EMPLOYEE");
        UUID assignee = user("EMPLOYEE");
        UUID manager = user("DEPARTMENT_MANAGER");
        UUID admin = user("ADMINISTRATOR");
        jdbc.update("UPDATE users SET primary_org_unit_id=? WHERE id=?", unitOne, organizer);
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id) VALUES (?,?)",
            manager, unitOne);
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id) VALUES (?,?)",
            manager, unitTwo);

        UUID m1 = meeting(organizer, "DRAFT", null, null);
        jdbc.update("INSERT INTO meeting_action_item_scopes(meeting_id,org_unit_id,recorded_by_user_id)"
            + " VALUES (?,?,?)", m1, unitOne, organizer);
        UUID m2 = meeting(organizer, "DRAFT", null, null);
        jdbc.update("INSERT INTO meeting_action_item_scopes(meeting_id,org_unit_id,recorded_by_user_id)"
            + " VALUES (?,?,?)", m2, unitTwo, organizer);
        UUID unrelatedOrganizer = user("EMPLOYEE");
        UUID hidden = meeting(unrelatedOrganizer, "DRAFT", null, null);

        UUID open = action(m1, organizer, assignee, LocalDate.of(2026, 11, 6));
        UUID today = action(m1, organizer, assignee, LocalDate.of(2026, 11, 7));
        UUID done = action(m2, organizer, assignee, LocalDate.of(2026, 11, 6));
        complete(done, assignee);
        action(hidden, unrelatedOrganizer, unrelatedOrganizer, LocalDate.of(2026, 11, 6));

        ActionItemReportingPort.OfficialCounts assigned =
            as(assignee, () -> actionReports.assignedOfficial(assignee, NOW));
        assertThat(assigned.open()).isEqualTo(2L);
        assertThat(assigned.done()).isEqualTo(1L);
        assertThat(assigned.overdue()).isEqualTo(1L);
        // Assignment gives no protected Meeting metadata or processing access.
        assertThat(as(assignee, () -> meetingReports.countVisibleByStatus(assignee)).values())
            .containsOnly(0L);

        ActionItemReportingPort.OfficialCounts managed =
            as(manager, () -> actionReports.visibleOfficial(manager, NOW));
        assertThat(managed.open()).isEqualTo(2L);
        assertThat(managed.done()).isEqualTo(1L);
        assertThat(managed.overdue()).isEqualTo(1L);
        assertThat(as(manager, () -> meetingReports.countVisibleByStatus(manager)).values())
            .containsOnly(0L);
        assertThat(as(admin, () -> actionReports.visibleOfficial(admin, NOW)).open()).isZero();

        // Source scope does not change if the organizer later changes department.
        jdbc.update("UPDATE users SET primary_org_unit_id=? WHERE id=?", unitTwo, organizer);
        assertThat(as(manager, () -> actionReports.visibleOfficial(manager, NOW)).open())
            .isEqualTo(2L);
        // But current manager role and active grants are required at request time.
        jdbc.update("UPDATE users SET global_role='EMPLOYEE' WHERE id=?", manager);
        assertThat(as(manager, () -> actionReports.visibleOfficial(manager, NOW)).open())
            .isZero();
        assertThat(open).isNotEqualTo(today);
    }

    @Test
    void processingTechnicalStatesRemainSeparateFromMeetingLifecycleAndCoordinatorIsScoped() {
        UUID organizer = user("EMPLOYEE");
        UUID participant = user("EMPLOYEE");
        UUID outsider = user("EMPLOYEE");
        UUID ended = meeting(organizer, "ENDED", null, NOW.minusSeconds(3600));
        participant(ended, participant);
        UUID hidden = meeting(outsider, "ENDED", null, NOW.minusSeconds(6000));
        job(ended, organizer, "FAILED");
        job(ended, organizer, "COMPLETED_WITH_WARNINGS");
        job(hidden, outsider, "COMPLETED");

        Map<String, Long> technical = as(participant,
            () -> processingReports.visibleJobStatusCounts(participant));
        assertThat(technical).containsEntry("FAILED", 1L)
            .containsEntry("COMPLETED_WITH_WARNINGS", 1L)
            .doesNotContainKey("COMPLETED");

        DashboardReportingQueries.Window scheduled =
            new DashboardReportingQueries.Window(NOW, TO, 10);
        DashboardReportingQueries.Window recent =
            new DashboardReportingQueries.Window(FROM, NOW, 10);
        var snapshot = as(participant, () ->
            coordinator.currentVisible(participant, NOW, scheduled, recent));
        assertThat(snapshot.asOf()).isEqualTo(NOW);
        assertThat(snapshot.visibleMeetingStates().get(MeetingStatus.ENDED)).isEqualTo(1L);
        assertThat(snapshot.visibleTechnicalJobStates()).isEqualTo(technical);
        assertThat(snapshot.endedWindow()).extracting(MeetingReportingPort.MeetingRow::id)
            .containsExactly(ended);
        assertThat(snapshot.assignedOfficialActions().open()).isZero();
        assertThat(snapshot.visibleOfficialActions().open()).isZero();

        jdbc.update("UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP "
            + "WHERE meeting_id=? AND user_id=? AND removed_at IS NULL", ended, participant);
        assertThat(as(participant, () -> processingReports.visibleJobStatusCounts(participant)))
            .isEmpty();
        assertThat(as(participant, () -> coordinator.currentVisible(participant,
            NOW, scheduled, recent).visibleMeetingStates().get(MeetingStatus.ENDED)))
            .isZero();
    }

    @Test
    void invalidQueryWindowsAndLimitsFailBeforeUnboundedSQL() {
        UUID actor = user("EMPLOYEE");
        assertThatThrownBy(() -> as(actor, () ->
            meetingReports.scheduledStartingIn(actor, NOW, NOW, 10)))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> as(actor, () ->
            meetingReports.endedIn(actor, FROM, TO, 101)))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> as(actor, () ->
            meetingReports.scheduledStartingIn(actor, FROM, TO, 0)))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() ->
            new DashboardReportingQueries.Window(NOW, NOW, 1))
            .isInstanceOf(IllegalArgumentException.class);
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "de02-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'DE02 test actor','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private UUID unit() {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO organizational_units(id,code,name,status) VALUES (?,?,?,'ACTIVE')",
            id, "DE02-" + id, "DE02 Unit");
        return id;
    }

    private UUID meeting(UUID organizer, String status, Instant scheduledStart,
            Instant actualEnd) {
        UUID id = UUID.randomUUID();
        OffsetDateTime start = scheduledStart == null ? null : utc(scheduledStart);
        OffsetDateTime end = scheduledStart == null ? null : utc(scheduledStart.plusSeconds(3600));
        OffsetDateTime started = actualEnd == null ? null : utc(actualEnd.minusSeconds(3600));
        OffsetDateTime ended = actualEnd == null ? null : utc(actualEnd);
        OffsetDateTime cancelled = status.equals("CANCELLED") ? utc(NOW) : null;
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status,
                scheduled_start_at,scheduled_end_at,started_at,ended_at,cancelled_at)
            VALUES (?,?,?, ?,?,?,?,?,?,?)
            """, id, "DE02 meeting " + id, organizer, organizer, status,
                start, end, started, ended, cancelled);
        return id;
    }

    private void participant(UUID meetingId, UUID userId) {
        jdbc.update("INSERT INTO meeting_participants(id,meeting_id,user_id) VALUES (?,?,?)",
            UUID.randomUUID(), meetingId, userId);
    }

    private UUID action(UUID meetingId, UUID creator, UUID assignee, LocalDate dueDate) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,assignee_user_id,
                                     due_date,source_type,created_by_user_id)
            VALUES (?,?,?,'OPEN',?,?,'MANUAL',?)
            """, id, meetingId, "DE02 official task", assignee, dueDate, creator);
        return id;
    }

    private void complete(UUID actionId, UUID assignee) {
        jdbc.update("""
            UPDATE action_items SET status='DONE',completed_by_user_id=?,
                completed_at=CURRENT_TIMESTAMP,version=version+1
            WHERE id=?
            """, assignee, actionId);
    }

    private void job(UUID meetingId, UUID requester, String status) {
        UUID mediaId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,
                content_type,expected_size_bytes,uploaded_by_user_id,size_bytes,
                duration_ms,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,'audio/wav',1024,?,1024,1000,CURRENT_TIMESTAMP)
            """, mediaId, meetingId, "de02/" + mediaId, requester);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,status,requested_by_user_id)
            VALUES (?,?,?,?,?)
            """, UUID.randomUUID(), meetingId, mediaId, status, requester);
    }

    private static OffsetDateTime utc(Instant instant) {
        return instant.atOffset(ZoneOffset.UTC);
    }

    /** Simulate verified server request identity; no public Dashboard controller exists in DE-02. */
    private static <T> T as(UUID actor, Supplier<T> work) {
        RequestAttributes old = RequestContextHolder.getRequestAttributes();
        MockHttpServletRequest request = new MockHttpServletRequest();
        Principal principal = () -> actor.toString();
        request.setUserPrincipal(principal);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        try {
            return work.get();
        } finally {
            if (old == null) RequestContextHolder.resetRequestAttributes();
            else RequestContextHolder.setRequestAttributes(old);
        }
    }
}
