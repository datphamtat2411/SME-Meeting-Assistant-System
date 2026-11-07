package com.sme.meetingassistant.api.meetingexport;

import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Immutable admission receipt: a checksum-verified source envelope must exist
 * before a scheduler may claim the corresponding durable export.
 */
@Repository
public class ExportIntakeRepository {
    private final JdbcTemplate jdbc;

    public ExportIntakeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Intake(UUID exportId, UUID meetingId, UUID requestedByUserId,
            String sourceFingerprint, String intakeSha256, String objectKey) { }

    @Transactional(readOnly = true)
    public Optional<Intake> find(UUID exportId) {
        return jdbc.query("""
            SELECT export_id,meeting_id,requested_by_user_id,
                   source_fingerprint,intake_sha256,object_key
              FROM meeting_export_intakes WHERE export_id=?
            """, (rs, ignored) -> new Intake(
                rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                rs.getObject(3, UUID.class), rs.getString(4).trim(),
                rs.getString(5).trim(), rs.getString(6)), exportId)
                .stream().findFirst();
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void insert(ExportRecord record, String fingerprint,
            String sha256, String objectKey) {
        int inserted = jdbc.update("""
            INSERT INTO meeting_export_intakes(export_id,meeting_id,
              requested_by_user_id,source_fingerprint,intake_sha256,object_key)
            VALUES(?,?,?,?,?,?)
            """, record.id(), record.meetingId(), record.requestedByUserId(),
                ExportDigests.requireDigest(fingerprint),
                ExportDigests.requireDigest(sha256), objectKey);
        if (inserted != 1) throw new IllegalStateException("Export intake not persisted");
    }
}
