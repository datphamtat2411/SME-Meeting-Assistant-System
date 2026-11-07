package com.sme.meetingassistant.api.actionitems;

import com.sme.meetingassistant.api.actionitems.application.ActionItemProposalPort;
import com.sme.meetingassistant.api.actionitems.dto.ActionItemProposal;
import com.sme.meetingassistant.api.actionitems.dto.CreateActionItemRequest;
import com.sme.meetingassistant.api.meeting.service.MeetingActionItemAccess;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.dao.DataAccessException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ActionItemService implements ActionItemProposalPort {
    private static final RowMapper<ActionItemView> ROW = ActionItemService::map;
    private static final java.util.Set<String> PATCH_FIELDS = java.util.Set.of(
        "title", "details", "assigneeUserId", "dueDate");

    private final JdbcTemplate jdbc;
    private final MeetingActionItemAccess meetingAccess;

    public ActionItemService(JdbcTemplate jdbc, MeetingActionItemAccess meetingAccess) {
        this.jdbc = jdbc;
        this.meetingAccess = meetingAccess;
    }

    @Transactional
    public ActionItemView createManual(UUID actorId, CreateActionItemRequest request) {
        meetingAccess.requireCurrentActiveActor(actorId);
        meetingAccess.requireManageActionItems(request.meetingId(), actorId);
        requireActiveAssignee(request.assigneeUserId());

        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,details,status,assignee_user_id,due_date,
                source_type,created_by_user_id)
            VALUES (?,?,?,?,'OPEN',?,?,'MANUAL',?)
            """, id, request.meetingId(), requiredTitle(request.title()), optional(request.details()),
            request.assigneeUserId(), request.dueDate(), actorId);
        history(id, "STATUS", null, "OPEN", actorId);
        history(id, "ASSIGNEE", null, request.assigneeUserId().toString(), actorId);
        if (request.dueDate() != null) history(id, "DUE_DATE", null, request.dueDate().toString(), actorId);
        return byId(id);
    }

    /** AI output is persisted as a proposal and can never create assigned work directly. */
    @Override
    @Transactional
    public ActionItemView propose(ActionItemProposal proposal) {
        validateProposal(proposal);
        requireActiveAssigneeWhenPresent(proposal.suggestedAssigneeUserId());
        for (UUID segmentId : proposal.transcriptSegmentIds()) {
            Integer matches = jdbc.queryForObject("""
                SELECT count(*) FROM transcript_segments segment
                JOIN transcripts transcript ON transcript.id=segment.transcript_id
                WHERE segment.id=? AND transcript.meeting_id=? AND transcript.processing_job_id=?
                  AND transcript.is_current=true AND transcript.status IN ('READY','READY_WITH_WARNINGS')
                """, Integer.class, segmentId, proposal.meetingId(), proposal.processingJobId());
            if (matches == null || matches != 1) throw invalid();
        }

        UUID existingId = findBySourceKey(proposal.processingJobId(), proposal.sourceItemKey());
        if (existingId != null) return replayOrConflict(existingId, proposal);

        UUID id = UUID.randomUUID();
        int inserted = jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,details,status,assignee_user_id,due_date,
                source_type,processing_job_id,source_item_key)
            VALUES (?,?,?,?,'PROPOSED',?,?,'AI_EXTRACTED',?,?)
            ON CONFLICT (processing_job_id,source_item_key) WHERE source_type='AI_EXTRACTED' DO NOTHING
            """, id, proposal.meetingId(), requiredTitle(proposal.title()), optional(proposal.details()),
            proposal.suggestedAssigneeUserId(), proposal.dueDate(), proposal.processingJobId(), proposal.sourceItemKey());
        if (inserted == 0) {
            existingId = findBySourceKey(proposal.processingJobId(), proposal.sourceItemKey());
            if (existingId == null) throw new ResponseStatusException(HttpStatus.CONFLICT);
            return replayOrConflict(existingId, proposal);
        }

        for (UUID segmentId : proposal.transcriptSegmentIds()) {
            jdbc.update("INSERT INTO action_item_evidence(action_item_id,transcript_segment_id) VALUES (?,?)", id, segmentId);
        }
        history(id, "STATUS", null, "PROPOSED", null);
        return byId(id);
    }

    @Transactional(readOnly = true)
    public ActionItemView detail(UUID id, UUID actorId) {
        meetingAccess.requireCurrentActiveActor(actorId);
        ActionItemView item = byId(id);
        if (!actorId.equals(item.assigneeUserId())) {
            meetingAccess.requireActionItemReadable(item.meetingId(), actorId);
        }
        return item;
    }

    @Transactional(readOnly = true)
    public Page<ActionItemView> list(UUID actorId, UUID meetingId, ActionItemStatus status,
            String q, String assignee, Boolean overdue, Pageable pageable) {
        meetingAccess.requireCurrentActiveActor(actorId);
        boolean managerVisible = false;
        List<UUID> managedMeetingIds = List.of();
        if (meetingId != null) {
            meetingAccess.requireActionItemReadable(meetingId, actorId);
            managerVisible = meetingAccess.canManageActionItems(meetingId, actorId);
        } else {
            managedMeetingIds = meetingAccess.actionItemManagerMeetingIds(actorId);
        }

        String managerMeetingPredicate = managedMeetingIds.isEmpty() ? ""
            : " OR ai.meeting_id IN (" + String.join(",", java.util.Collections.nCopies(managedMeetingIds.size(), "?")) + ")";
        StringBuilder where = new StringBuilder("""
            FROM action_items ai JOIN meetings meeting ON meeting.id=ai.meeting_id
            WHERE (meeting.organizer_user_id=? OR ai.assignee_user_id=? OR EXISTS (
                SELECT 1 FROM meeting_participants participant WHERE participant.meeting_id=ai.meeting_id
                  AND participant.user_id=? AND participant.removed_at IS NULL) OR (?=true AND ai.meeting_id=?)
            """).append(managerMeetingPredicate).append(")");
        List<Object> params = new ArrayList<>(List.of(actorId, actorId, actorId, managerVisible,
            meetingId == null ? new UUID(0, 0) : meetingId));
        params.addAll(managedMeetingIds);
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
                ? " AND ai.due_date<CURRENT_DATE AND ai.status NOT IN ('DONE','CANCELLED')"
                : " AND (ai.due_date IS NULL OR ai.due_date>=CURRENT_DATE OR ai.status IN ('DONE','CANCELLED'))");
        }

        Long total = jdbc.queryForObject("SELECT count(*) " + where, Long.class, params.toArray());
        String sql = "SELECT ai.*, (ai.due_date<CURRENT_DATE AND ai.status NOT IN ('DONE','CANCELLED')) AS overdue "
            + where + " ORDER BY " + sortColumn(pageable) + " "
            + pageable.getSort().stream().findFirst().map(order -> order.getDirection().name()).orElse("DESC")
            + ", ai.id LIMIT ? OFFSET ?";
        params.add(pageable.getPageSize());
        params.add(pageable.getOffset());
        List<ActionItemView> items = jdbc.query(sql, ROW, params.toArray());
        return new PageImpl<>(items, pageable, total == null ? 0 : total);
    }

    @Transactional
    public ActionItemView update(UUID id, UUID actorId, String ifMatch, Map<String, Object> patch) {
        meetingAccess.requireCurrentActiveActor(actorId);
        ActionItemView old = byId(id);
        meetingAccess.requireManageActionItems(old.meetingId(), actorId);
        ActionItemEtags.requireMatch(old, ifMatch);
        if (patch == null || patch.isEmpty() || !PATCH_FIELDS.containsAll(patch.keySet())) throw invalid();
        if (old.status() == ActionItemStatus.DONE || old.status() == ActionItemStatus.CANCELLED) throw conflict();

        String title = old.title();
        String details = old.details();
        UUID assigneeId = old.assigneeUserId();
        LocalDate dueDate = old.dueDate();
        if (patch.containsKey("title")) title = requiredTitle(asString(patch.get("title")));
        if (patch.containsKey("details")) details = optional(asString(patch.get("details")));
        if (patch.containsKey("assigneeUserId")) {
            assigneeId = asUuid(patch.get("assigneeUserId"));
            if (assigneeId != null) requireActiveAssignee(assigneeId);
            if ((old.status() == ActionItemStatus.OPEN || old.status() == ActionItemStatus.IN_PROGRESS)
                    && assigneeId == null) throw invalid();
        }
        if (patch.containsKey("dueDate")) dueDate = asDate(patch.get("dueDate"));

        int updated = jdbc.update("""
            UPDATE action_items SET title=?,details=?,assignee_user_id=?,due_date=?,updated_at=CURRENT_TIMESTAMP,
                version=version+1 WHERE id=? AND version=?
            """, title, details, assigneeId, dueDate, id, old.version());
        if (updated != 1) throw preconditionFailed();
        if (!old.title().equals(title) || !Objects.equals(old.details(), details)) {
            history(id, "CONTENT", content(old.title(), old.details()), content(title, details), actorId);
        }
        if (!Objects.equals(old.assigneeUserId(), assigneeId)) {
            history(id, "ASSIGNEE", string(old.assigneeUserId()), string(assigneeId), actorId);
        }
        if (!Objects.equals(old.dueDate(), dueDate)) {
            history(id, "DUE_DATE", string(old.dueDate()), string(dueDate), actorId);
        }
        return byId(id);
    }

    @Transactional public ActionItemView confirm(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, ActionItemStatus.OPEN);
    }
    @Transactional public ActionItemView reject(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, ActionItemStatus.CANCELLED);
    }
    @Transactional public ActionItemView start(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, ActionItemStatus.IN_PROGRESS);
    }
    @Transactional public ActionItemView complete(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, ActionItemStatus.DONE);
    }
    @Transactional public ActionItemView cancel(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, ActionItemStatus.CANCELLED);
    }
    @Transactional public ActionItemView reopen(UUID id, UUID actor, String tag) {
        return transition(id, actor, tag, ActionItemStatus.OPEN);
    }

    private ActionItemView transition(UUID id, UUID actor, String tag, ActionItemStatus target) {
        meetingAccess.requireCurrentActiveActor(actor);
        ActionItemView old = byId(id);
        boolean manager = meetingAccess.canManageActionItems(old.meetingId(), actor);
        boolean assignee = actor.equals(old.assigneeUserId());
        boolean organizerOnly = target == ActionItemStatus.CANCELLED || (target == ActionItemStatus.OPEN
            && old.status() == ActionItemStatus.PROPOSED);
        if (organizerOnly ? !manager : !manager && !assignee) throw notFound();
        ActionItemEtags.requireMatch(old, tag);
        if (!allowed(old.status(), target)) throw conflict();
        if (target == ActionItemStatus.OPEN && (old.status() == ActionItemStatus.PROPOSED
                || old.status() == ActionItemStatus.DONE)) {
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
        history(id, "STATUS", old.status().name(), target.name(), actor);
        return byId(id);
    }

    private ActionItemView replayOrConflict(UUID id, ActionItemProposal proposal) {
        ActionItemView existing = byId(id);
        List<UUID> evidence = jdbc.query("""
            SELECT transcript_segment_id FROM action_item_evidence
             WHERE action_item_id=? ORDER BY transcript_segment_id
            """, (rs, row) -> rs.getObject(1, UUID.class), id);
        List<UUID> proposedEvidence = proposal.transcriptSegmentIds().stream().sorted().toList();
        if (!existing.meetingId().equals(proposal.meetingId())
                || !existing.title().equals(requiredTitle(proposal.title()))
                || !Objects.equals(existing.details(), optional(proposal.details()))
                || !Objects.equals(existing.assigneeUserId(), proposal.suggestedAssigneeUserId())
                || !Objects.equals(existing.dueDate(), proposal.dueDate())
                || !evidence.equals(proposedEvidence)) {
            throw conflict();
        }
        return existing;
    }

    private void validateProposal(ActionItemProposal proposal) {
        if (proposal == null || proposal.meetingId() == null || proposal.processingJobId() == null
                || proposal.sourceItemKey() == null || proposal.sourceItemKey().isBlank()
                || proposal.sourceItemKey().length() > 128 || proposal.transcriptSegmentIds() == null
                || proposal.transcriptSegmentIds().isEmpty() || proposal.transcriptSegmentIds().stream().anyMatch(Objects::isNull)
                || proposal.transcriptSegmentIds().stream().distinct().count() != proposal.transcriptSegmentIds().size()) {
            throw invalid();
        }
        requiredTitle(proposal.title());
        Integer jobMatches = jdbc.queryForObject("""
            SELECT count(*) FROM processing_jobs WHERE id=? AND meeting_id=?
            """, Integer.class, proposal.processingJobId(), proposal.meetingId());
        if (jobMatches == null || jobMatches != 1) throw invalid();
    }

    private static boolean allowed(ActionItemStatus from, ActionItemStatus to) {
        return switch (from) {
            case PROPOSED -> to == ActionItemStatus.OPEN || to == ActionItemStatus.CANCELLED;
            case OPEN -> to == ActionItemStatus.IN_PROGRESS || to == ActionItemStatus.DONE || to == ActionItemStatus.CANCELLED;
            case IN_PROGRESS -> to == ActionItemStatus.DONE || to == ActionItemStatus.CANCELLED;
            case DONE -> to == ActionItemStatus.OPEN;
            case CANCELLED -> false;
        };
    }

    private void requireActiveAssignee(UUID assignee) {
        if (assignee == null || !meetingAccess.isActiveAssignee(assignee)) throw invalid();
    }
    private void requireActiveAssigneeWhenPresent(UUID assignee) {
        if (assignee != null) requireActiveAssignee(assignee);
    }
    private UUID findBySourceKey(UUID jobId, String sourceKey) {
        List<UUID> ids = jdbc.query("""
            SELECT id FROM action_items WHERE processing_job_id=? AND source_item_key=?
            """, (rs, row) -> rs.getObject(1, UUID.class), jobId, sourceKey);
        return ids.isEmpty() ? null : ids.getFirst();
    }
    private ActionItemView byId(UUID id) {
        List<ActionItemView> rows = jdbc.query("""
            SELECT ai.*, (ai.due_date<CURRENT_DATE AND ai.status NOT IN ('DONE','CANCELLED')) AS overdue
              FROM action_items ai WHERE ai.id=?
            """, ROW, id);
        if (rows.isEmpty()) throw notFound();
        return rows.getFirst();
    }
    private void history(UUID id, String type, String from, String to, UUID actor) {
        jdbc.update("""
            INSERT INTO action_item_history(id,action_item_id,change_type,from_value,to_value,changed_by_user_id)
            VALUES (?,?,?,?,?,?)
            """, UUID.randomUUID(), id, type, from, to, actor);
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
    private static String requiredTitle(String title) {
        if (title == null || title.isBlank() || title.trim().length() > 500) throw invalid();
        return title.trim();
    }
    private static String optional(String value) { return value == null || value.isBlank() ? null : value.trim(); }
    private static String asString(Object value) {
        if (value == null || !(value instanceof String string)) throw invalid();
        return string;
    }
    private static UUID asUuid(Object value) {
        if (value == null) return null;
        if (value instanceof String string) try { return UUID.fromString(string); }
        catch (IllegalArgumentException ignored) { throw invalid(); }
        throw invalid();
    }
    private static LocalDate asDate(Object value) {
        if (value == null) return null;
        if (value instanceof String string) try { return LocalDate.parse(string); }
        catch (RuntimeException ignored) { throw invalid(); }
        throw invalid();
    }
    private static String string(Object value) { return value == null ? null : value.toString(); }
    private static String content(String title, String details) { return title + "\n" + Objects.toString(details, ""); }
    private static String escapeLike(String value) { return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_"); }
    private static ResponseStatusException invalid() { return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY); }
    private static ResponseStatusException notFound() { return new ResponseStatusException(HttpStatus.NOT_FOUND); }
    private static ResponseStatusException conflict() { return new ResponseStatusException(HttpStatus.CONFLICT); }
    private static ResponseStatusException preconditionFailed() { return new ResponseStatusException(HttpStatus.PRECONDITION_FAILED); }
}
