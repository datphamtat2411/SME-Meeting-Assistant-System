package com.sme.meetingassistant.api.actionitems.application;

import java.util.List;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Action Items owns official assignment-event identity, version and audit provenance.
 * A notification listener may react, but never creates authoritative assignments.
 */
@Service
public class ActionItemAssignmentEvents {
    private final JdbcTemplate jdbc;
    private final ApplicationEventPublisher publisher;

    public ActionItemAssignmentEvents(JdbcTemplate jdbc, ApplicationEventPublisher publisher) {
        this.jdbc = jdbc;
        this.publisher = publisher;
    }

    public enum Kind { ASSIGNED, REASSIGNED }

    /** An official assignment was terminally revoked at its audited status change. */
    public record Invalidated(UUID actionItemId) {}

    /** Transactional event notification; listener must not make an independent commit. */
    public record Recorded(UUID eventId) {}

    public record Snapshot(UUID eventId, UUID actionItemId, long version,
            UUID assigneeUserId, Kind kind) {}

    @Transactional(propagation = Propagation.MANDATORY)
    public UUID record(UUID actionItemId, long version, UUID historyId, UUID assigneeUserId,
            Kind kind) {
        if (actionItemId == null || historyId == null || assigneeUserId == null
                || version < 0 || kind == null) {
            throw new IllegalArgumentException("Invalid authoritative assignment event");
        }
        UUID eventId = UUID.randomUUID();
        if (jdbc.update("""
                INSERT INTO action_item_assignment_events
                    (id,action_item_id,action_item_version,history_id,assignee_user_id,event_type)
                VALUES (?,?,?,?,?,?)
                """, eventId, actionItemId, version, historyId, assigneeUserId,
                kind.name()) != 1) {
            throw new IllegalStateException("Could not record canonical assignment event");
        }
        publisher.publishEvent(new Recorded(eventId));
        return eventId;
    }

    /**
     * DONE/CANCELLED permanently revokes the latest official assignment,
     * even if DONE is later reopened. No event is fabricated on reopen.
     * Called after the canonical status and STATUS history are persisted.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void invalidate(UUID actionItemId, long version, UUID historyId, String reason) {
        if (actionItemId == null || historyId == null || version < 0
                || (!"DONE".equals(reason) && !"CANCELLED".equals(reason))) {
            throw new IllegalArgumentException("Invalid assignment termination");
        }
        List<UUID> latest = jdbc.query("""
            SELECT id FROM action_item_assignment_events WHERE action_item_id=?
            ORDER BY action_item_version DESC LIMIT 1
            """, (rs, row) -> rs.getObject(1, UUID.class), actionItemId);
        if (!latest.isEmpty()) {
            // Repeated completion after a reopen cannot rewrite a previous
            // revocation; only the first terminal transition is evidence.
            jdbc.update("""
                INSERT INTO action_item_assignment_revocations
                    (event_id,action_item_id,status_history_id,action_item_version,reason)
                VALUES (?,?,?,?,?)
                ON CONFLICT (event_id) DO NOTHING
                """, latest.getFirst(), actionItemId, historyId, version, reason);
        }
        publisher.publishEvent(new Invalidated(actionItemId));
    }

    /**
     * Same-transaction lookup performed by the integration adapter.
     * A random or stale in-memory notification event is not authoritative.
     */
    @Transactional(propagation = Propagation.MANDATORY, readOnly = true)
    public Snapshot require(UUID eventId) {
        List<Snapshot> rows = jdbc.query("""
                SELECT id,action_item_id,action_item_version,assignee_user_id,event_type
                  FROM action_item_assignment_events WHERE id=?
                """, (rs, index) -> new Snapshot(
                    rs.getObject("id", UUID.class),
                    rs.getObject("action_item_id", UUID.class),
                    rs.getLong("action_item_version"),
                    rs.getObject("assignee_user_id", UUID.class),
                    Kind.valueOf(rs.getString("event_type"))), eventId);
        if (rows.size() != 1) {
            throw new IllegalStateException("Unknown canonical assignment event");
        }
        return rows.getFirst();
    }
}
