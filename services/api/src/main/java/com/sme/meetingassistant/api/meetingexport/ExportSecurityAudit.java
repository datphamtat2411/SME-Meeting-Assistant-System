package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.audit.TransactionalAuditWriter;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Persist only safe, typed metadata. NEVER audit bearer signed URLs, tokens,
 * raw source, object keys, PDF bytes, response bodies or private S3 headers.
 */
@Service
public class ExportSecurityAudit {
    private final TransactionalAuditWriter writer;

    public ExportSecurityAudit(TransactionalAuditWriter writer) {
        this.writer = writer;
    }

    /** Participates in the admission transaction: never audit a rolled-back intent. */
    @Transactional
    public void admitted(ExportRecord record) {
        writer.record(record.requestedByUserId(), "EXPORT_INTENT_ADMITTED",
                "MEETING_EXPORT", record.id(), record.meetingId(),
                Map.of("format", record.format().name()));
    }

    /**
     * Independent audited grant. Fail closed if audit persistence is down:
     * the signed capability may have been minted, but must NOT be returned.
     */
    @Transactional
    public void capabilityIssued(UUID actorId, ExportRecord record, Duration ttl) {
        writer.record(actorId, "EXPORT_DOWNLOAD_CAPABILITY_ISSUED",
                "MEETING_EXPORT", record.id(), record.meetingId(),
                Map.of("format", record.format().name(),
                        "ttlSeconds", ttl.toSeconds()));
    }
}
