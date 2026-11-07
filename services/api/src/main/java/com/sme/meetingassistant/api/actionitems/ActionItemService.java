package com.sme.meetingassistant.api.actionitems;

import com.sme.meetingassistant.api.actionitems.dto.CreateActionItemRequest;
import com.sme.meetingassistant.api.actionitems.dto.PatchActionItemRequest;
import com.sme.meetingassistant.api.actionitems.application.ActionItemCreationIdempotency;
import com.sme.meetingassistant.api.actionitems.application.ActionItemAssignmentEvents;
import com.sme.meetingassistant.api.actionitems.application.ActionItemAssignmentEvents.Kind;
import com.sme.meetingassistant.api.actionitems.ActionItemLifecycle.Command;
import com.sme.meetingassistant.api.meeting.service.MeetingActionItemAccess;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Arrays;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
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

    public ActionItemService(JdbcTemplate jdbc, MeetingActionItemAccess meetingAccess,
            ActionItemCreationIdempotency idempotency,
            ActionItemAssignmentEvents assignmentEvents, ObjectMapper json,
            @Value("${app.action-items.business-zone:UTC}") String zoneId) {
        this.jdbc = jdbc;
        this.meetingAccess = meetingAccess;
        this.idempotency = idempotency;
        this.assignmentEvents = assignmentEvents;
        this.json = json;
        this.businessZone = ZoneId.of(zoneId);
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
        return visibleForActor(byId(id), actorId);
    }

    /**
     * Detail and collection use the same resource rights. Only a *confirmed*
     * assignment (or manual OPEN work) extends read access outside the meeting.
     * Mere AI suggestions, including rejected proposals with a prefilled
     * assignee, never become a read capability.
     */
    @Transactional(readOnly = true)
    public ActionItemView detail(UUID id, UUID actorId) {
        meetingAccess.requireCurrentActiveActor(actorId);
        ActionItemView item = byId(id);
        boolean meetingContent = meetingAccess.canReadMeetingContent(item.meetingId(), actorId);
        if (!meetingContent
                && !meetingAccess.canReadActionItems(item.meetingId(), actorId)
                && !(actorId.equals(item.assigneeUserId()) && isOfficial(item))) {
            throw notFound();
        }
        return meetingContent ? item : limitedActionItemView(item);
    }

    @Transactional(readOnly = true)
    public Page<ActionItemView> list(UUID actorId, UUID meetingId, ActionItemStatus status,
            String q, String assignee, Boolean overdue, Pageable pageable) {
        meetingAccess.requireCurrentActiveActor(actorId);
        LocalDate today = today();
        // No preflight requireActionItemReadable(meetingId): an official
        // assignee outside the meeting may filter their own work by meeting.
        // Unknown/unauthorized meetingId values yield the same empty result.
        StringBuilder where = new StringBuilder("""
            FROM action_items ai JOIN meetings meeting ON meeting.id=ai.meeting_id
            WHERE (
                meeting.organizer_user_id=?
                OR EXISTS (
                    SELECT 1 FROM meeting_participants participant
                     WHERE participant.meeting_id=ai.meeting_id
                       AND participant.user_id=? AND participant.removed_at IS NULL)
                OR (ai.assignee_user_id=? AND
                    (ai.source_type='MANUAL' OR ai.confirmed_by_user_id IS NOT NULL))
                OR EXISTS (
                    SELECT 1 FROM meeting_action_item_scopes scope
                    JOIN organizational_units unit ON unit.id=scope.org_unit_id
                       AND unit.status='ACTIVE'
                    JOIN manager_scope_units grant_record
                       ON grant_record.org_unit_id=scope.org_unit_id
                    JOIN users manager_actor ON manager_actor.id=grant_record.user_id
                       AND manager_actor.account_status='ACTIVE'
                       AND manager_actor.global_role='DEPARTMENT_MANAGER'
                    WHERE scope.meeting_id=ai.meeting_id
                      AND grant_record.user_id=?)
            )
            """);
        List<Object> params = new ArrayList<>(List.of(actorId, actorId, actorId, actorId));
        if (meetingId != null) { where.append(" AND ai.meeting_id=?"); params.add(meetingId); }
        if (status != null) { where.append(" AND ai.status=?"); params.add(status.name()); }
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

        // COUNT and LIMIT/OFFSET share one permission-filtered FROM/WHERE.
        // Return minimal item-only projection for non-members (assignees,
        // scoped managers); do not reveal processing job or reviewer identities.
        Long total = jdbc.queryForObject("SELECT count(*) " + where, Long.class, params.toArray());
        String sql = """
            SELECT ai.*, (ai.due_date<? AND ai.status NOT IN ('DONE','CANCELLED')) AS overdue,
                   (meeting.organizer_user_id=? OR EXISTS (
                        SELECT 1 FROM meeting_participants visible
                         WHERE visible.meeting_id=ai.meeting_id AND visible.user_id=?
                           AND visible.removed_at IS NULL)) AS meeting_content_visible
            """ + where + " ORDER BY " + sortColumn(pageable) + " "
            + pageable.getSort().stream().findFirst().map(order -> order.getDirection().name()).orElse("DESC")
            + ", ai.id LIMIT ? OFFSET ?";
        List<Object> pageParams = new ArrayList<>(List.of(today, actorId, actorId));
        pageParams.addAll(params);
        pageParams.add(pageable.getPageSize());
        pageParams.add(pageable.getOffset());
        List<ActionItemView> items = jdbc.query(sql, (rs, row) -> {
            ActionItemView item = map(rs, row);
            return rs.getBoolean("meeting_content_visible") ? item : limitedActionItemView(item);
        }, pageParams.toArray());
        return new PageImpl<>(items, pageable, total == null ? 0 : total);
    }

    private ActionItemView visibleForActor(ActionItemView item, UUID actorId) {
        return meetingAccess.canReadMeetingContent(item.meetingId(), actorId)
            ? item : limitedActionItemView(item);
    }

    private static boolean isOfficial(ActionItemView item) {
        return "MANUAL".equals(item.sourceType()) || item.confirmedByUserId() != null;
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
            null, null, null, null, null, null, null, null,
            item.version(), item.createdAt(), item.updatedAt());
    }

    @Transactional
    public ActionItemView update(UUID id, UUID actorId, String ifMatch, PatchActionItemRequest patch) {
        meetingAccess.requireCurrentActiveActor(actorId);
        ActionItemView old = byIdForUpdate(id);
        meetingAccess.requireManageActionItems(old.meetingId(), actorId);
        ActionItemEtags.requireMatch(old, ifMatch);
        if (patch == null) throw invalid();
        if (old.status() == ActionItemStatus.DONE || old.status() == ActionItemStatus.CANCELLED) {
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
        return visibleForActor(byId(id), actorId);
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
        if (ActionItemLifecycle.requiresManager(command) ? !manager : !manager && !assignee) {
            throw notFound();
        }
        ActionItemEtags.requireMatch(old, tag);
        ActionItemStatus target = ActionItemLifecycle.target(command, old.status());
        if (target == ActionItemStatus.OPEN || target == ActionItemStatus.IN_PROGRESS
                || target == ActionItemStatus.DONE) {
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
        }
        return visibleForActor(byId(id), actor);
    }

    private void requireActiveAssignee(UUID assignee) {
        if (assignee == null || !meetingAccess.isActiveAssignee(assignee)) throw invalid();
    }
    /** Serialize even an effective no-op with a competing conditional writer. */
    private ActionItemView byIdForUpdate(UUID id) {
        List<ActionItemView> rows = jdbc.query("""
            SELECT ai.*, (ai.due_date<? AND ai.status NOT IN ('DONE','CANCELLED')) AS overdue
              FROM action_items ai WHERE ai.id=? FOR UPDATE
            """, ROW, today(), id);
        if (rows.isEmpty()) throw notFound();
        return rows.getFirst();
    }

    private ActionItemView byId(UUID id) {
        List<ActionItemView> rows = jdbc.query("""
            SELECT ai.*, (ai.due_date<? AND ai.status NOT IN ('DONE','CANCELLED')) AS overdue
              FROM action_items ai WHERE ai.id=?
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
        return new ActionItemView(rs.getObject("id", UUID.class), rs.getObject("meeting_id", UUID.class),
            rs.getString("title"), rs.getString("details"), ActionItemStatus.valueOf(rs.getString("status")),
            rs.getObject("assignee_user_id", UUID.class), rawDue == null ? null : rawDue.toLocalDate(),
            rs.getBoolean("overdue"), rs.getString("source_type"), rs.getObject("processing_job_id", UUID.class),
            rs.getObject("created_by_user_id", UUID.class), rs.getObject("confirmed_by_user_id", UUID.class),
            rs.getObject("confirmed_at", OffsetDateTime.class), rs.getObject("completed_by_user_id", UUID.class),
            rs.getObject("completed_at", OffsetDateTime.class), rs.getObject("cancelled_by_user_id", UUID.class),
            rs.getObject("cancelled_at", OffsetDateTime.class), rs.getLong("version"),
            rs.getObject("created_at", OffsetDateTime.class), rs.getObject("updated_at", OffsetDateTime.class));
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
