package com.sme.meetingassistant.api.meetingexport;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * PostgreSQL is the only durable authority for export intent/status.
 * No unbounded in-memory task queue and no binary blob/Minutes JSON in DB.
 */
@Repository
public class MeetingExportRepository {
    private static final String COLUMNS = """
        id,meeting_id,format,status,requested_by_user_id,created_at,ready_at,
        object_key,source_fingerprint,last_error_code,generation_attempt,
        claim_token,lease_expires_at,snapshot_object_key,renderer_version,
        artifact_sha256,artifact_size_bytes,row_version
        """;

    private final JdbcTemplate jdbc;
    private final int retentionHours;

    public MeetingExportRepository(JdbcTemplate jdbc,
            @Value("${app.exports.idempotency-retention-hours:24}") int retentionHours) {
        if (retentionHours < 1 || retentionHours > 168) {
            throw new IllegalArgumentException("Export idempotency retention must be 1..168 hours");
        }
        this.jdbc = jdbc;
        this.retentionHours = retentionHours;
    }

    /**
     * Caller is already content-authorized by ExportIntentService inside the
     * SAME transaction. The PostgreSQL unique key serializes concurrent retries.
     * An incomplete claim is invisible to other transactions and cannot commit
     * due to the deferred FK-completeness constraint trigger in V35.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public ExportRecord enqueue(UUID actorId, UUID meetingId,
            ExportFormat format, String rawKey) {
        String keyDigest = ExportDigests.keyDigest(meetingId, rawKey);
        String requestDigest = ExportDigests.requestDigest(meetingId, format);
        jdbc.update("""
            DELETE FROM meeting_export_idempotency
             WHERE actor_user_id=? AND meeting_id=? AND key_digest=?
               AND expires_at<=clock_timestamp()
            """, actorId, meetingId, keyDigest);
        int claimed = jdbc.update("""
            INSERT INTO meeting_export_idempotency(
                actor_user_id,meeting_id,key_digest,request_digest,expires_at)
            VALUES (?,?,?,?,clock_timestamp() + (? * INTERVAL '1 hour'))
            ON CONFLICT (actor_user_id,meeting_id,key_digest) DO NOTHING
            """, actorId, meetingId, keyDigest, requestDigest, retentionHours);
        if (claimed == 0) {
            List<Receipt> receipts = jdbc.query("""
                SELECT request_digest,export_id FROM meeting_export_idempotency
                 WHERE actor_user_id=? AND meeting_id=? AND key_digest=?
                """, (rs, ignored) -> new Receipt(rs.getString(1).trim(),
                        rs.getObject(2, UUID.class)), actorId, meetingId, keyDigest);
            if (receipts.size() != 1) throw new IllegalStateException("Export receipt missing");
            Receipt prior = receipts.getFirst();
            if (!requestDigest.equals(prior.requestDigest())) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Idempotency-Key belongs to a different export intent");
            }
            if (prior.exportId() == null) {
                throw new IllegalStateException("Incomplete committed export receipt");
            }
            return require(prior.exportId());
        }
        UUID exportId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_exports(id,meeting_id,format,requested_by_user_id)
            VALUES (?,?,?,?)
            """, exportId, meetingId, format.name(), actorId);
        if (jdbc.update("""
            UPDATE meeting_export_idempotency SET export_id=?
             WHERE actor_user_id=? AND meeting_id=? AND key_digest=?
               AND export_id IS NULL
            """, exportId, actorId, meetingId, keyDigest) != 1) {
            throw new IllegalStateException("Export idempotency receipt could not be finalized");
        }
        return require(exportId);
    }

    /** One DB-clock bounded cleanup pass; caller supplies the transaction. */
    @Transactional(propagation = Propagation.MANDATORY)
    public int deleteExpiredIdempotencyReceipts(int limit) {
        if (limit < 1 || limit > 500) {
            throw new IllegalArgumentException("Invalid idempotency cleanup batch size");
        }
        return jdbc.update("""
            DELETE FROM meeting_export_idempotency target
             USING (
                SELECT actor_user_id,meeting_id,key_digest
                  FROM meeting_export_idempotency
                 WHERE expires_at<=clock_timestamp()
                 ORDER BY expires_at,actor_user_id,meeting_id,key_digest
                 LIMIT ? FOR UPDATE SKIP LOCKED
             ) expired
             WHERE target.actor_user_id=expired.actor_user_id
               AND target.meeting_id=expired.meeting_id
               AND target.key_digest=expired.key_digest
            """, limit);
    }

    /** Trusted infrastructure read only; NOT a public authorization boundary. */
    @Transactional(readOnly = true)
    public Optional<ExportRecord> find(UUID id) {
        return jdbc.query("SELECT " + COLUMNS + " FROM meeting_exports WHERE id=?",
                MeetingExportRepository::map, id).stream().findFirst();
    }

    @Transactional(readOnly = true)
    public ExportRecord require(UUID id) {
        return find(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    static ExportRecord map(ResultSet rs, int row) throws SQLException {
        return new ExportRecord(
                rs.getObject("id", UUID.class),
                rs.getObject("meeting_id", UUID.class),
                ExportFormat.valueOf(rs.getString("format")),
                ExportStatus.valueOf(rs.getString("status")),
                rs.getObject("requested_by_user_id", UUID.class),
                rs.getObject("created_at", OffsetDateTime.class),
                rs.getObject("ready_at", OffsetDateTime.class),
                rs.getString("object_key"),
                rs.getString("source_fingerprint"),
                rs.getString("last_error_code"),
                rs.getInt("generation_attempt"),
                rs.getObject("claim_token", UUID.class),
                rs.getObject("lease_expires_at", OffsetDateTime.class),
                rs.getString("snapshot_object_key"),
                rs.getString("renderer_version"),
                rs.getString("artifact_sha256"),
                rs.getObject("artifact_size_bytes", Long.class),
                rs.getLong("row_version"));
    }

    private record Receipt(String requestDigest, UUID exportId) { }
}
