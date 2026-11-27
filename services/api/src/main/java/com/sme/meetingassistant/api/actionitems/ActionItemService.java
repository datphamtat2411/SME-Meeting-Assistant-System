package com.sme.meetingassistant.api.actionitems;

import com.sme.meetingassistant.api.actionitems.dto.CreateActionItemRequest;
import com.sme.meetingassistant.api.actionitems.dto.PatchActionItemRequest;
import com.sme.meetingassistant.api.actionitems.application.ActionItemCreationIdempotency;
import com.sme.meetingassistant.api.actionitems.application.ActionItemAssignmentEvents;
import com.sme.meetingassistant.api.actionitems.application.ActionItemAssignmentEvents.Kind;
import com.sme.meetingassistant.api.knowledge.KnowledgeIndexingProducer;
import com.sme.meetingassistant.api.actionitems.ActionItemLifecycle.Command;
import com.sme.meetingassistant.api.meeting.service.MeetingActionItemAccess;
import com.sme.meetingassistant.api.meeting.service.MeetingActionItemRightsSql;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Arrays;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

@Service
public class ActionItemService {
    private static final RowMapper<ActionItemView> ROW = ActionItemService::map;
    private final JdbcTemplate jdbc;
    private final MeetingActionItemAccess meetingAccess;
    private final ActionItemCreationIdempotency idempotency;
    private final ActionItemAssignmentEvents assignmentEvents;
    private final ObjectMapper json;
    private final ZoneId businessZone;
    private final KnowledgeIndexingProducer knowledge;

    public ActionItemService(JdbcTemplate jdbc, MeetingActionItemAccess meetingAccess,
            ActionItemCreationIdempotency idempotency,
            ActionItemAssignmentEvents assignmentEvents, ObjectMapper json,
            @Value("${app.action-items.business-zone:UTC}") String zoneId,
            KnowledgeIndexingProducer knowledge) {
        this.jdbc = jdbc;
        this.meetingAccess = meetingAccess;
        this.idempotency = idempotency;
        this.assignmentEvents = assignmentEvents;
        this.json = json;
        this.businessZone = ZoneId.of(zoneId);
        this.knowledge = knowledge;
    }

    @Transactional
    public ActionItemView createManual(UUID actorId, CreateActionItemRequest request) {
        return createManual(actorId, request, null);
    }

    /**
     * Permission and current actor/assignee validation precede replay.
     * A consumed key is a retry token, never an authorization capability.
     * Receipt, canonical item and initial history commit/rollback together.
     */
    @Transactional
    public ActionItemView createManual(UUID actorId, CreateActionItemRequest request,
            String idempotencyKey) {
        meetingAccess.requireCurrentActiveActor(actorId);
        if (request == null || request.meetingId() == null || request.assigneeUserId() == null) {
            throw invalid();
        }
        meetingAccess.requireManageActionItems(request.meetingId(), actorId);
        requireActiveAssignee(request.assigneeUserId());
        String title = requiredTitle(request.title());
        String details = optional(request.details());

        if (idempotencyKey != null) {
            UUID prior = idempotency.claimOrReplay(actorId, idempotencyKey, request);
            if (prior != null) {
                ActionItemView item = byId(prior);
                if (!request.meetingId().equals(item.meetingId()) ||
                        !"MANUAL".equals(item.sourceType())) throw notFound();
                return visibleForActor(item, actorId);
            }
        }

        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,details,status,assignee_user_id,due_date,
                source_type,created_by_user_id)
            VALUES (?,?,?,?,'OPEN',?,?,'MANUAL',?)
            """, id, request.meetingId(), title, details,
            request.assigneeUserId(), request.dueDate(), actorId);
        history(id, "STATUS", null, "OPEN", actorId);
        UUID assignmentHistory = history(id, "ASSIGNEE", null,
            request.assigneeUserId().toString(), actorId);
        if (request.dueDate() != null) {
            history(id, "DUE_DATE", null, request.dueDate().toString(), actorId);
        }
        // A manual OPEN task is an official obligation. History, event and
        // optional email intent all commit or roll back with this command.
        assignmentEvents.record(id, 0L, assignmentHistory,
            request.assigneeUserId(), Kind.ASSIGNED);
        if (idempotencyKey != null) idempotency.complete(actorId, idempotencyKey, id);
        knowledge.request("ACTION_ITEM", id, request.meetingId());
        return visibleForActor(byId(id), actorId);
    }

    /**
     * Detail and collection use the same resource rights. Only a *confirmed*
     * assignment (or manual OPEN work) extends read access outside the meeting.
     * Mere AI suggestions, including rejected proposals with a prefilled
     * assignee, never become a read capability.
     */
    private static final String MEETING_RIGHTS =
        " CROSS JOIN (SELECT CAST(? AS uuid) AS id) actor "
            + MeetingActionItemRightsSql.RIGHTS_JOIN;
    private static final String OFFICIAL = "(ai.source_type='MANUAL' OR ai.confirmed_by_user_id IS NOT NULL)";
    private static final String REVIEWABLE = "(ai.status='PROPOSED' AND rights.manageable)";
    private static final String VISIBLE_FROM = """
        FROM action_items ai JOIN meetings meeting ON meeting.id=ai.meeting_id
        LEFT JOIN users assigned ON assigned.id=ai.assignee_user_id
        """ + MEETING_RIGHTS + """
        WHERE (rights.content_visible OR rights.manageable OR (ai.assignee_user_id=actor.id AND
        """ + OFFICIAL + "))";
    private static final String PROJECT = """
        SELECT ai.*, (ai.due_date<? AND ai.status NOT IN ('DONE','CANCELLED')) AS overdue,
               rights.content_visible, rights.manageable, meeting.title AS meeting_title,
               assigned.display_name AS assignee_name, assigned.account_status AS assignee_status
        """;

    @Transactional(readOnly = true)
    public ActionItemView detail(UUID id, UUID actorId) {
        meetingAccess.requireCurrentActiveActor(actorId);
        return projectedDetail(id, actorId);
    }

    @Transactional(readOnly = true)
    public Page<ActionItemView> list(UUID actorId, UUID meetingId, ActionItemStatus status,
            String q, String assignee, Boolean overdue, Pageable pageable) {
        return list(actorId, meetingId, status, q, assignee, overdue, null, null, pageable);
    }

    @Transactional(readOnly = true)
    public Page<ActionItemView> list(UUID actorId, UUID meetingId, ActionItemStatus status,
            String q, String assignee, Boolean overdue, Boolean official, Boolean reviewable,
            Pageable pageable) {
        meetingAccess.requireCurrentActiveActor(actorId);
        LocalDate today = today();
        // Unknown/unauthorized meetingId values yield the same empty result.
        StringBuilder where = new StringBuilder(VISIBLE_FROM);
        List<Object> params = new ArrayList<>(List.of(actorId));
        if (meetingId != null) { where.append(" AND ai.meeting_id=?"); params.add(meetingId); }
        if (status != null) { where.append(" AND ai.status=?"); params.add(status.name()); }
        if (official != null) where.append(official ? " AND " + OFFICIAL : " AND NOT " + OFFICIAL);
        if (reviewable != null) where.append(reviewable ? " AND " + REVIEWABLE : " AND NOT " + REVIEWABLE);
        if (assignee != null && !assignee.isBlank()) {
            if (assignee.equalsIgnoreCase("me")) {
                where.append(" AND ai.assignee_user_id=?"); params.add(actorId);
            } else {
                UUID assigneeId;
                try { assigneeId = UUID.fromString(assignee); }
                catch (IllegalArgumentException bad) { throw invalid(); }
                where.append(" AND ai.assignee_user_id=?"); params.add(assigneeId);
            }
        }
        if (q != null && !q.isBlank()) {
            where.append(" AND (lower(ai.title) LIKE ? ESCAPE '\\' OR lower(coalesce(ai.details,'')) LIKE ? ESCAPE '\\')");
            String pattern = "%" + escapeLike(q.trim().toLowerCase(java.util.Locale.ROOT)) + "%";
            params.add(pattern);
            params.add(pattern);
        }
        if (overdue != null) {
            where.append(overdue
                ? " AND ai.due_date<? AND ai.status NOT IN ('DONE','CANCELLED')"
                : " AND (ai.due_date IS NULL OR ai.due_date>=? OR ai.status IN ('DONE','CANCELLED'))");
            params.add(today);
        }
        Long total = jdbc.queryForObject("SELECT count(*) " + where, Long.class, params.toArray());
        String sql = PROJECT + where + " ORDER BY " + sortColumn(pageable) + " "
            + pageable.getSort().stream().findFirst().map(order -> order.getDirection().name()).orElse("DESC")
            + ", ai.id LIMIT ? OFFSET ?";
        List<Object> pageParams = new ArrayList<>(List.of(today));
        pageParams.addAll(params);
        pageParams.add(pageable.getPageSize());
        pageParams.add(pageable.getOffset());
        List<ProjectionRow> rows = jdbc.query(sql, ActionItemService::projectionRow, pageParams.toArray());
        List<ActionItemView> evidenceItems = rows.stream()
            .filter(ProjectionRow::contentVisible)
            .map(ProjectionRow::item)
            .toList();
        Map<UUID, ActionItemView.Evidence> evidence = evidenceFor(evidenceItems, true);
        List<ActionItemView> projected = rows.stream()
            .map(row -> project(row.item(), actorId, row.contentVisible(), row.manageable(),
                evidence.get(row.item().id())))
            .toList();
        return new PageImpl<>(projected, pageable, total == null ? 0 : total);
    }

    @Transactional(readOnly = true)
    public Page<ActionItemView.CreationMeeting> creationMeetings(UUID actorId, String q, Pageable pageable) {
        meetingAccess.requireCurrentActiveActor(actorId);
        StringBuilder where = new StringBuilder(" FROM meetings meeting " + MEETING_RIGHTS
            + " WHERE rights.manageable");
        List<Object> params = new ArrayList<>(List.of(actorId));
        if (q != null && !q.isBlank()) {
            // Do not search, sort or count by a hidden title.
            where.append(" AND ((rights.content_visible AND lower(meeting.title) LIKE ? ESCAPE '\\')"
                + " OR CAST(meeting.id AS text)=?)");
            params.add("%" + escapeLike(q.strip().toLowerCase(java.util.Locale.ROOT)) + "%");
            params.add(q.strip().toLowerCase(java.util.Locale.ROOT));
        }
        Long total = jdbc.queryForObject("SELECT count(*) " + where, Long.class, params.toArray());
        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(pageable.getPageSize());
        pageParams.add(pageable.getOffset());
        var items = jdbc.query("""
            SELECT meeting.id, CASE WHEN rights.content_visible THEN meeting.title END AS visible_title,
                   rights.content_visible
            """ + where + " ORDER BY visible_title NULLS LAST, meeting.id LIMIT ? OFFSET ?",
            (rs, row) -> new ActionItemView.CreationMeeting(rs.getObject("id", UUID.class),
                rs.getString("visible_title"), rs.getBoolean("content_visible")), pageParams.toArray());
        return new PageImpl<>(items, pageable, total == null ? 0 : total);
    }

    private ActionItemView projectedDetail(UUID id, UUID actorId) {
        var rows = jdbc.query(PROJECT + VISIBLE_FROM + " AND ai.id=?",
            ActionItemService::projectionRow, today(), actorId, id);
        if (rows.isEmpty()) throw notFound();
        ProjectionRow row = rows.getFirst();
        ActionItemView.Evidence evidence = row.contentVisible()
            ? evidenceFor(List.of(row.item()), true).get(row.item().id()) : null;
        return project(row.item(), actorId, row.contentVisible(), row.manageable(), evidence);
    }

    private ActionItemView visibleForActor(ActionItemView item, UUID actorId) {
        return projectedDetail(item.id(), actorId);
    }

    private static boolean isOfficial(ActionItemView item) {
        return item.isOfficial();
    }

    /**
     * An assignee or manager may see *the task* without general meeting
     * content privileges. Omit sensitive producer/job and reviewer identities.
     * Meeting ID is retained as an opaque reference, not a content capability.
     */
    private static ActionItemView limitedActionItemView(ActionItemView item) {
        return new ActionItemView(
            item.id(), item.meetingId(), item.title(), item.details(), item.status(),
            item.assigneeUserId(), item.dueDate(), item.overdue(), item.sourceType(),
            null, null, null, null, null, null, null, null, null, null,
            item.version(), item.createdAt(), item.updatedAt(), item.isOfficial(),
            item.capabilities(), item.assignee(),
            new ActionItemView.MeetingDisplay(item.meetingId(), "Restricted meeting", true),
            new ActionItemView.Evidence("RESTRICTED", null, null, "RESTRICTED",
                List.of(), "Meeting-content access is required for transcript evidence."));
    }

    private static ProjectionRow projectionRow(ResultSet rs, int row) throws SQLException {
        return new ProjectionRow(map(rs, row), rs.getBoolean("content_visible"),
            rs.getBoolean("manageable"));
    }

    private ActionItemView project(ActionItemView item, UUID actorId, boolean contentVisible,
            boolean manageable, ActionItemView.Evidence sourceEvidence) {
        ActionItemView visible = contentVisible ? item : limitedActionItemView(item);
        boolean officialAssignee = visible.isOfficial() && actorId.equals(visible.assigneeUserId());
        boolean activeAssignee = visible.assignee() != null && visible.assignee().active();
        boolean editable = manageable && ActionItemLifecycle.canEdit(visible.status());
        ActionItemView.Capabilities capabilities = new ActionItemView.Capabilities(
            editable,
            editable,
            ActionItemLifecycle.isAllowed(Command.CONFIRM, visible.status())
                && ActionItemLifecycle.canExecute(Command.CONFIRM, manageable, officialAssignee)
                && (!ActionItemLifecycle.requiresActiveAssignee(Command.CONFIRM) || activeAssignee),
            ActionItemLifecycle.isAllowed(Command.REJECT, visible.status())
                && ActionItemLifecycle.canExecute(Command.REJECT, manageable, officialAssignee),
            ActionItemLifecycle.isAllowed(Command.START, visible.status())
                && ActionItemLifecycle.canExecute(Command.START, manageable, officialAssignee)
                && (!ActionItemLifecycle.requiresActiveAssignee(Command.START) || activeAssignee),
            ActionItemLifecycle.isAllowed(Command.COMPLETE, visible.status())
                && ActionItemLifecycle.canExecute(Command.COMPLETE, manageable, officialAssignee)
                && (!ActionItemLifecycle.requiresActiveAssignee(Command.COMPLETE) || activeAssignee),
            ActionItemLifecycle.isAllowed(Command.CANCEL, visible.status())
                && ActionItemLifecycle.canExecute(Command.CANCEL, manageable, officialAssignee)
                && (!ActionItemLifecycle.requiresActiveAssignee(Command.CANCEL) || activeAssignee),
            ActionItemLifecycle.isAllowed(Command.REOPEN, visible.status())
                && ActionItemLifecycle.canExecute(Command.REOPEN, manageable, officialAssignee)
                && (!ActionItemLifecycle.requiresActiveAssignee(Command.REOPEN) || activeAssignee),
            contentVisible,
            contentVisible && "AI_EXTRACTED".equals(visible.sourceType()));
        ActionItemView.MeetingDisplay meeting = contentVisible
            ? visible.meeting()
            : new ActionItemView.MeetingDisplay(visible.meetingId(), "Restricted meeting", true);
        ActionItemView.Evidence evidence = contentVisible
            ? (sourceEvidence == null ? unavailableEvidence(visible) : sourceEvidence)
            : new ActionItemView.Evidence("RESTRICTED", null, null, "RESTRICTED",
                List.of(), "Meeting-content access is required for transcript evidence.");
        return visible.withProjection(visible.isOfficial(), capabilities, visible.assignee(),
            meeting, evidence);
    }

    private record ProjectionRow(ActionItemView item, boolean contentVisible, boolean manageable) {}

    @Transactional
    public ActionItemView update(UUID id, UUID actorId, String ifMatch, PatchActionItemRequest patch) {
        meetingAccess.requireCurrentActiveActor(actorId);
        ActionItemView old = byIdForUpdate(id);
        meetingAccess.requireManageActionItems(old.meetingId(), actorId);
        ActionItemEtags.requireMatch(old, ifMatch);
        if (patch == null) throw invalid();
        if (!ActionItemLifecycle.canEdit(old.status())) {
            throw conflict();
        }

        String title = patch.titlePresent() ? requiredTitle(patch.title()) : old.title();
        String details = patch.detailsPresent() ? optional(patch.details()) : old.details();
        UUID assigneeId = patch.assigneePresent() ? patch.assigneeUserId() : old.assigneeUserId();
        LocalDate dueDate = patch.dueDatePresent() ? patch.dueDate() : old.dueDate();
        if (patch.assigneePresent() && assigneeId != null) requireActiveAssignee(assigneeId);
        if ((old.status() == ActionItemStatus.OPEN || old.status() == ActionItemStatus.IN_PROGRESS)
                && assigneeId == null) throw invalid();

        // An idempotent PATCH with no effective change does not create a new
        // ETag version or fabricate an audit event.
        boolean contentChanged = !old.title().equals(title) || !Objects.equals(old.details(), details);
        boolean assignmentChanged = !Objects.equals(old.assigneeUserId(), assigneeId);
        boolean dueChanged = !Objects.equals(old.dueDate(), dueDate);
        if (!contentChanged && !assignmentChanged && !dueChanged) {
            return visibleForActor(old, actorId);
        }

        int updated = jdbc.update("""
            UPDATE action_items SET title=?,details=?,assignee_user_id=?,due_date=?,updated_at=CURRENT_TIMESTAMP,
                version=version+1 WHERE id=? AND version=?
            """, title, details, assigneeId, dueDate, id, old.version());
        if (updated != 1) throw preconditionFailed();
        if (contentChanged) {
            history(id, "CONTENT", content(old.title(), old.details()), content(title, details), actorId);
        }
        if (assignmentChanged) {
            UUID assignmentHistory = history(id, "ASSIGNEE",
                string(old.assigneeUserId()), string(assigneeId), actorId);
            // A proposed assignee is only a hint; reassignments become official
            // only after the proposal is confirmed by a human.
            if (isOfficial(old)) {
                assignmentEvents.record(id, old.version() + 1, assignmentHistory,
                    assigneeId, Kind.REASSIGNED);
            }
        }
        if (dueChanged) {
            history(id, "DUE_DATE", string(old.dueDate()), string(dueDate), actorId);
        }
        ActionItemView updatedItem = byId(id);
        knowledge.request("ACTION_ITEM", id, updatedItem.meetingId());
        return visibleForActor(updatedItem, actorId);
    }

    @Transactional public ActionItemView confirm(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, Command.CONFIRM);
    }
    @Transactional public ActionItemView reject(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, Command.REJECT);
    }
    @Transactional public ActionItemView start(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, Command.START);
    }
    @Transactional public ActionItemView complete(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, Command.COMPLETE);
    }
    @Transactional public ActionItemView cancel(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, Command.CANCEL);
    }
    @Transactional public ActionItemView reopen(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, Command.REOPEN);
    }

    private ActionItemView transition(UUID id, UUID actor, String tag, Command command) {
        meetingAccess.requireCurrentActiveActor(actor);
        ActionItemView old = byId(id);
        boolean manager = meetingAccess.canManageActionItems(old.meetingId(), actor);
        boolean assignee = actor.equals(old.assigneeUserId()) && isOfficial(old);
        if (!ActionItemLifecycle.canExecute(command, manager, assignee)) {
            throw notFound();
        }
        ActionItemEtags.requireMatch(old, tag);
        ActionItemStatus target = ActionItemLifecycle.target(command, old.status());
        if (ActionItemLifecycle.requiresActiveAssignee(command)) {
            if (old.assigneeUserId() == null) throw invalid();
            requireActiveAssignee(old.assigneeUserId());
        }

        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        UUID completedBy = target == ActionItemStatus.DONE ? actor : null;
        OffsetDateTime completedAt = target == ActionItemStatus.DONE ? now : null;
        UUID cancelledBy = target == ActionItemStatus.CANCELLED ? actor : null;
        OffsetDateTime cancelledAt = target == ActionItemStatus.CANCELLED ? now : null;
        boolean confirmation = target == ActionItemStatus.OPEN && old.status() == ActionItemStatus.PROPOSED;
        int updated = jdbc.update("""
            UPDATE action_items SET status=?,
                confirmed_by_user_id=CASE WHEN ? THEN ? ELSE confirmed_by_user_id END,
                confirmed_at=CASE WHEN ? THEN ? ELSE confirmed_at END,
                completed_by_user_id=?,completed_at=?,cancelled_by_user_id=?,cancelled_at=?,
                updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=? AND version=?
            """, target.name(), confirmation, actor, confirmation, confirmation ? now : null,
            completedBy, completedAt, cancelledBy, cancelledAt, id, old.version());
        if (updated != 1) throw preconditionFailed();
        UUID statusHistory = history(id, "STATUS", old.status().name(), target.name(), actor);
        if (confirmation) {
            // The STATUS history row proves actual human confirmation;
            // do not fabricate an ASSIGNEE history transition for a proposal.
            assignmentEvents.record(id, old.version() + 1, statusHistory,
                old.assigneeUserId(), Kind.ASSIGNED);
        } else if (target == ActionItemStatus.DONE || target == ActionItemStatus.CANCELLED) {
            // Keep immutable evidence of terminal invalidation. Otherwise a
            // subsequent DONE -> OPEN reopen could resurrect pending mail.
            assignmentEvents.invalidate(id, old.version() + 1, statusHistory, target.name());
        }
        ActionItemView updatedItem = byId(id);
        knowledge.request("ACTION_ITEM", id, updatedItem.meetingId());
        return visibleForActor(updatedItem, actor);
    }

    private void requireActiveAssignee(UUID assignee) {
        if (assignee == null || !meetingAccess.isActiveAssignee(assignee)) throw invalid();
    }
    /** Serialize even an effective no-op with a competing conditional writer. */
    private ActionItemView byIdForUpdate(UUID id) {
        List<ActionItemView> rows = jdbc.query("""
            SELECT ai.*, (ai.due_date<? AND ai.status NOT IN ('DONE','CANCELLED')) AS overdue,
                   meeting.title AS meeting_title, assignee.display_name AS assignee_display_name,
                   (assignee.account_status='ACTIVE') AS assignee_active
              FROM action_items ai
              JOIN meetings meeting ON meeting.id=ai.meeting_id
              LEFT JOIN users assignee ON assignee.id=ai.assignee_user_id
             WHERE ai.id=? FOR UPDATE OF ai
            """, ROW, today(), id);
        if (rows.isEmpty()) throw notFound();
        return rows.getFirst();
    }

    private ActionItemView byId(UUID id) {
        List<ActionItemView> rows = jdbc.query("""
            SELECT ai.*, (ai.due_date<? AND ai.status NOT IN ('DONE','CANCELLED')) AS overdue,
                   meeting.title AS meeting_title, assignee.display_name AS assignee_display_name,
                   (assignee.account_status='ACTIVE') AS assignee_active
              FROM action_items ai
              JOIN meetings meeting ON meeting.id=ai.meeting_id
              LEFT JOIN users assignee ON assignee.id=ai.assignee_user_id
             WHERE ai.id=?
            """, ROW, today(), id);
        if (rows.isEmpty()) throw notFound();
        return rows.getFirst();
    }
    private UUID history(UUID id, String type, String from, String to, UUID actor) {
        UUID historyId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO action_item_history(id,action_item_id,change_type,from_value,to_value,changed_by_user_id)
            VALUES (?,?,?,?,?,?)
            """, historyId, id, type, from, to, actor);
        return historyId;
    }

    private static ActionItemView map(ResultSet rs, int row) throws SQLException {
        java.sql.Date rawDue = rs.getDate("due_date");
        UUID id = rs.getObject("id", UUID.class);
        UUID meetingId = rs.getObject("meeting_id", UUID.class);
        UUID assigneeId = rs.getObject("assignee_user_id", UUID.class);
        String assigneeName = optionalString(rs, "assignee_display_name");
        if (assigneeName == null) assigneeName = optionalString(rs, "assignee_name");
        boolean assigneeActive = optionalBoolean(rs, "assignee_active")
            || "ACTIVE".equals(optionalString(rs, "assignee_status"));
        String meetingTitle = optionalString(rs, "meeting_title");
        return new ActionItemView(id, meetingId,
            rs.getString("title"), rs.getString("details"), ActionItemStatus.valueOf(rs.getString("status")),
            assigneeId, rawDue == null ? null : rawDue.toLocalDate(),
            rs.getBoolean("overdue"), rs.getString("source_type"), rs.getObject("processing_job_id", UUID.class),
            rs.getObject("transcript_id", UUID.class), rs.getObject("content_revision", Long.class),
            rs.getObject("created_by_user_id", UUID.class), rs.getObject("confirmed_by_user_id", UUID.class),
            rs.getObject("confirmed_at", OffsetDateTime.class), rs.getObject("completed_by_user_id", UUID.class),
            rs.getObject("completed_at", OffsetDateTime.class), rs.getObject("cancelled_by_user_id", UUID.class),
            rs.getObject("cancelled_at", OffsetDateTime.class), rs.getLong("version"),
            rs.getObject("created_at", OffsetDateTime.class), rs.getObject("updated_at", OffsetDateTime.class),
            "MANUAL".equals(rs.getString("source_type"))
                || rs.getObject("confirmed_by_user_id", UUID.class) != null,
            ActionItemView.Capabilities.none(),
            assigneeId == null ? null
                : new ActionItemView.Assignee(assigneeId, assigneeName, assigneeActive),
            new ActionItemView.MeetingDisplay(meetingId,
                meetingTitle == null ? "Meeting unavailable" : meetingTitle, false),
            null);
    }

    private static String optionalString(ResultSet rs, String column) {
        try {
            return rs.getString(column);
        } catch (SQLException missing) {
            return null;
        }
    }

    private static boolean optionalBoolean(ResultSet rs, String column) {
        try {
            return rs.getBoolean(column);
        } catch (SQLException missing) {
            return false;
        }
    }

    private ActionItemView project(ActionItemView item, UUID actorId,
            boolean meetingContent, ActionItemView.Evidence sourceEvidence) {
        boolean manager = meetingAccess.canManageActionItems(item.meetingId(), actorId);
        boolean officialAssignee = item.isOfficial()
            && actorId.equals(item.assigneeUserId());
        boolean activeAssignee = item.assignee() != null && item.assignee().active();
        boolean editable = item.status() != ActionItemStatus.DONE
            && item.status() != ActionItemStatus.CANCELLED;
        ActionItemView.Capabilities capabilities = new ActionItemView.Capabilities(
            manager && editable,
            manager && editable,
            manager && item.status() == ActionItemStatus.PROPOSED && activeAssignee,
            manager && item.status() == ActionItemStatus.PROPOSED,
            editable && item.status() == ActionItemStatus.OPEN
                && (manager || officialAssignee),
            editable && (item.status() == ActionItemStatus.OPEN
                || item.status() == ActionItemStatus.IN_PROGRESS)
                && (manager || officialAssignee),
            editable && (item.status() == ActionItemStatus.OPEN
                || item.status() == ActionItemStatus.IN_PROGRESS) && manager,
            item.status() == ActionItemStatus.DONE && (manager || officialAssignee),
            meetingContent,
            meetingContent && item.sourceType().equals("AI_EXTRACTED"));
        ActionItemView.MeetingDisplay meeting = meetingContent
            ? item.meeting()
            : new ActionItemView.MeetingDisplay(item.meetingId(), "Restricted meeting", true);
        ActionItemView.Evidence evidence = meetingContent
            ? (sourceEvidence == null ? unavailableEvidence(item) : sourceEvidence)
            : new ActionItemView.Evidence("RESTRICTED", null, null, "RESTRICTED",
                List.of(), "Meeting-content access is required for transcript evidence.");
        return item.withProjection(item.isOfficial(), capabilities, item.assignee(), meeting, evidence);
    }

    private static ActionItemView.Evidence unavailableEvidence(ActionItemView item) {
        return new ActionItemView.Evidence(
            item.sourceType().equals("AI_EXTRACTED") ? "UNAVAILABLE" : "NOT_APPLICABLE",
            item.sourceType().equals("AI_EXTRACTED") ? item.transcriptId() : null,
            item.sourceType().equals("AI_EXTRACTED") ? item.contentRevision() : null,
            item.sourceType().equals("AI_EXTRACTED") ? "UNKNOWN" : "NOT_APPLICABLE",
            List.of(),
            item.sourceType().equals("AI_EXTRACTED")
                ? "Supporting transcript evidence is unavailable."
                : null);
    }

    private Map<UUID, ActionItemView.Evidence> evidenceFor(List<ActionItemView> items,
            boolean authorized) {
        if (!authorized || items.isEmpty()) return Map.of();
        List<UUID> ids = items.stream().map(ActionItemView::id).toList();
        String placeholders = String.join(",", ids.stream().map(id -> "?").toList());
        List<Object> params = new ArrayList<>(ids);
        Map<UUID, EvidenceRows> rows = new LinkedHashMap<>();
        String evidenceSql = """
            SELECT ai.id, ai.transcript_id, ai.content_revision,
                   current_transcript.id AS current_transcript_id,
                   current_transcript.content_revision AS current_content_revision,
                   evidence.transcript_segment_id, segment.ordinal, segment.current_text
              FROM action_items ai
              LEFT JOIN action_item_evidence evidence ON evidence.action_item_id=ai.id
              LEFT JOIN transcript_segments segment
                ON segment.transcript_id=evidence.transcript_id
               AND segment.id=evidence.transcript_segment_id
              LEFT JOIN transcripts current_transcript
                ON current_transcript.meeting_id=ai.meeting_id
               AND current_transcript.is_current
             WHERE ai.id IN (%s)
             ORDER BY ai.id, segment.ordinal, evidence.transcript_segment_id
            """.formatted(placeholders);
        jdbc.query(evidenceSql, rs -> {
            while (rs.next()) {
                UUID id = rs.getObject("id", UUID.class);
                EvidenceRows row = rows.get(id);
                if (row == null) {
                    row = new EvidenceRows(
                        rs.getObject("transcript_id", UUID.class),
                        rs.getObject("content_revision", Long.class),
                        rs.getObject("current_transcript_id", UUID.class),
                        rs.getObject("current_content_revision", Long.class));
                    rows.put(id, row);
                }
                UUID segmentId = rs.getObject("transcript_segment_id", UUID.class);
                if (segmentId != null) {
                    row.references.add(new ActionItemView.Reference(segmentId,
                        (Integer) rs.getObject("ordinal"), row.isCurrent()
                            ? rs.getString("current_text") : null));
                }
            }
            return null;
            }, params.toArray());
        Map<UUID, ActionItemView.Evidence> result = new HashMap<>();
        for (ActionItemView item : items) {
            EvidenceRows row = rows.get(item.id());
            if (row == null || item.sourceType().equals("MANUAL")) {
                result.put(item.id(), unavailableEvidence(item));
                continue;
            }
            String freshness = row.isCurrent() ? "CURRENT"
                : row.currentTranscriptId == null ? "UNKNOWN" : "STALE";
            String availability = row.references.isEmpty() ? "UNAVAILABLE"
                : row.isCurrent() ? "AVAILABLE" : "STALE";
            String limitation = row.references.isEmpty()
                ? "No supporting transcript segments are currently available."
                : row.isCurrent() ? null
                : "The source transcript revision has changed; historical previews are withheld.";
            result.put(item.id(), new ActionItemView.Evidence(availability,
                row.transcriptId, row.contentRevision, freshness, row.references, limitation));
        }
        return result;
    }

    private static final class EvidenceRows {
        private final UUID transcriptId;
        private final Long contentRevision;
        private final UUID currentTranscriptId;
        private final Long currentContentRevision;
        private final List<ActionItemView.Reference> references = new ArrayList<>();

        private EvidenceRows(UUID transcriptId, Long contentRevision,
                UUID currentTranscriptId, Long currentContentRevision) {
            this.transcriptId = transcriptId;
            this.contentRevision = contentRevision;
            this.currentTranscriptId = currentTranscriptId;
            this.currentContentRevision = currentContentRevision;
        }

        private boolean isCurrent() {
            return transcriptId != null && transcriptId.equals(currentTranscriptId)
                && Objects.equals(contentRevision, currentContentRevision);
        }
    }

    public record ManagementTarget(UUID id, String label) { }

    public record ManagementCapability(boolean canCreate) { }

    public record AssigneeCandidate(UUID id, String displayName, String email,
            String organizationalUnitName, boolean active) { }

    @Transactional(readOnly = true)
    public ManagementCapability managementCapability(UUID actorId) {
        return managementCapability(actorId, null);
    }

    @Transactional(readOnly = true)
    public ManagementCapability managementCapability(UUID actorId, UUID meetingId) {
        meetingAccess.requireCurrentActiveActor(actorId);
        if (meetingId != null) {
            return new ManagementCapability(meetingAccess.canManageActionItems(meetingId, actorId));
        }
        Boolean canCreate = jdbc.queryForObject("""
            SELECT EXISTS (
                SELECT 1
                  FROM meetings meeting
                 WHERE meeting.organizer_user_id=?
                    OR EXISTS (
                        SELECT 1
                          FROM meeting_action_item_scopes scope
                          JOIN organizational_units unit
                            ON unit.id=scope.org_unit_id AND unit.status='ACTIVE'
                          JOIN manager_scope_units grant_record
                            ON grant_record.org_unit_id=scope.org_unit_id
                           AND grant_record.user_id=?
                          JOIN users manager_actor
                            ON manager_actor.id=grant_record.user_id
                           AND manager_actor.account_status='ACTIVE'
                           AND manager_actor.global_role='DEPARTMENT_MANAGER'
                         WHERE scope.meeting_id=meeting.id))
            """, Boolean.class, actorId, actorId);
        return new ManagementCapability(Boolean.TRUE.equals(canCreate));
    }

    @Transactional(readOnly = true)
    public Page<ManagementTarget> managementTargets(UUID actorId, String query, int page, int size) {
        meetingAccess.requireCurrentActiveActor(actorId);
        validateLookupPage(page, size);
        String pattern = lookupPattern(query);
        String condition = """
            FROM meetings meeting
             WHERE (meeting.organizer_user_id=?
                OR EXISTS (
                    SELECT 1 FROM meeting_action_item_scopes scope
                    JOIN organizational_units unit ON unit.id=scope.org_unit_id
                       AND unit.status='ACTIVE'
                    JOIN manager_scope_units grant_record
                      ON grant_record.org_unit_id=scope.org_unit_id
                    JOIN users manager_actor ON manager_actor.id=grant_record.user_id
                       AND manager_actor.account_status='ACTIVE'
                       AND manager_actor.global_role='DEPARTMENT_MANAGER'
                    WHERE scope.meeting_id=meeting.id AND grant_record.user_id=?))
               AND lower(meeting.title) LIKE ? ESCAPE '\\'
            """;
        Object[] params = { actorId, actorId, pattern };
        Long total = jdbc.queryForObject("SELECT count(*) " + condition, Long.class, params);
        List<ManagementTarget> targets = jdbc.query("""
            SELECT meeting.id, meeting.title
              """ + condition + """
             ORDER BY lower(meeting.title), meeting.id
             LIMIT ? OFFSET ?
            """, (rs, ignored) -> new ManagementTarget(
                rs.getObject("id", UUID.class), rs.getString("title")),
            actorId, actorId, pattern, size, (long) page * size);
        return new PageImpl<>(targets, PageRequest.of(page, size), total == null ? 0 : total);
    }

    @Transactional(readOnly = true)
    public Page<AssigneeCandidate> assigneeCandidates(UUID actorId, UUID meetingId, String query, int page, int size) {
        meetingAccess.requireCurrentActiveActor(actorId);
        meetingAccess.requireManageActionItems(meetingId, actorId);
        validateLookupPage(page, size);
        String pattern = lookupPattern(query);
        String condition = """
            FROM users candidate
             LEFT JOIN organizational_units unit
               ON unit.id=candidate.primary_org_unit_id AND unit.status='ACTIVE'
             WHERE candidate.account_status='ACTIVE'
               AND (lower(candidate.display_name) LIKE ? ESCAPE '\\'
                    OR lower(candidate.email_normalized) LIKE ? ESCAPE '\\')
            """;
        Object[] params = { pattern, pattern };
        Long total = jdbc.queryForObject("SELECT count(*) " + condition, Long.class, params);
        List<AssigneeCandidate> candidates = jdbc.query("""
            SELECT candidate.id, candidate.display_name, candidate.email, unit.name
              """ + condition + """
             ORDER BY lower(candidate.display_name), candidate.display_name, candidate.id
             LIMIT ? OFFSET ?
            """, (rs, ignored) -> new AssigneeCandidate(
                rs.getObject("id", UUID.class), rs.getString("display_name"),
                rs.getString("email"), rs.getString("name"), true),
            pattern, pattern, size, (long) page * size);
        return new PageImpl<>(candidates, PageRequest.of(page, size), total == null ? 0 : total);
    }

    private static void validateLookupPage(int page, int size) {
        if (page < 0 || size < 1 || size > 20) throw invalid();
    }

    private static String lookupPattern(String query) {
        if (query == null) throw invalid();
        String normalized = query.strip();
        if (normalized.codePoints().filter(cp -> !Character.isWhitespace(cp)).count() < 2) {
            throw invalid();
        }
        return "%" + escapeLike(normalized.toLowerCase(java.util.Locale.ROOT)) + "%";
    }
    private static String sortColumn(Pageable pageable) {
        if (pageable.getSort().isEmpty()) return "ai.created_at";
        return pageable.getSort().stream().findFirst().map(order -> switch (order.getProperty()) {
            case "createdAt" -> "ai.created_at";
            case "dueDate" -> "ai.due_date";
            case "status" -> "ai.status";
            case "title" -> "ai.title";
            default -> "ai.created_at";
        }).orElse("ai.created_at");
    }
    private LocalDate today() { return LocalDate.now(businessZone); }

    private static String requiredTitle(String title) {
        if (title == null || title.isBlank()) throw invalid();
        String normalized = title.strip();
        if (normalized.length() > 500 || invalidTitleControls(normalized)) throw invalid();
        return normalized;
    }
    private static String optional(String value) {
        if (value == null || value.isBlank()) return null;
        String normalized = value.strip();
        if (normalized.length() > 10000 || invalidDetailsControls(normalized)) throw invalid();
        return normalized;
    }
    private static boolean invalidTitleControls(String text) {
        return text.codePoints().anyMatch(Character::isISOControl);
    }
    private static boolean invalidDetailsControls(String text) {
        return text.codePoints().anyMatch(cp -> Character.isISOControl(cp)
            && cp != '\n' && cp != '\t');
    }
    private static String string(Object value) { return value == null ? null : value.toString(); }
    /** Structured audit values avoid ambiguity when details contain newlines. */
    private String content(String title, String details) {
        return json.writeValueAsString(Arrays.asList(title, details));
    }
    private static String escapeLike(String value) { return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_"); }
    private static ResponseStatusException invalid() { return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY); }
    private static ResponseStatusException notFound() { return new ResponseStatusException(HttpStatus.NOT_FOUND); }
    private static ResponseStatusException conflict() { return new ResponseStatusException(HttpStatus.CONFLICT); }
    private static ResponseStatusException preconditionFailed() { return new ResponseStatusException(HttpStatus.PRECONDITION_FAILED); }
}
