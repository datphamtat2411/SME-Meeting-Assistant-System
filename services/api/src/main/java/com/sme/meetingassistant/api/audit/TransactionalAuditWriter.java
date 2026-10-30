package com.sme.meetingassistant.api.audit;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

/**
 * Small shared PostgreSQL audit persistence boundary. Successful business events
 * MUST live or die with their owning domain transaction; never use REQUIRES_NEW.
 * Authentication attempt/denial auditing has deliberately different semantics.
 */
@Service
public class TransactionalAuditWriter {
    private static final int MAX_METADATA_BYTES = 4096;
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public TransactionalAuditWriter(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void record(UUID actorId, String action, String entityType, UUID entityId,
            UUID meetingId, Map<String, Object> metadata) {
        if (actorId == null || entityId == null || meetingId == null
                || action == null || action.isBlank() || action.length() > 96
                || entityType == null || entityType.isBlank() || entityType.length() > 64) {
            throw new IllegalArgumentException("Invalid business audit context");
        }
        String encoded = json.writeValueAsString(metadata);
        if (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_METADATA_BYTES) {
            throw new IllegalArgumentException("Audit metadata exceeds safe size");
        }
        String requestId = RequestIdContext.currentRequestId();
        if (requestId != null && requestId.length() > 128) {
            throw new IllegalStateException("Invalid trusted audit correlation ID");
        }
        jdbc.update("""
            INSERT INTO audit_events
              (id, occurred_at, actor_user_id, actor_type, action_code,
               entity_type, entity_id, meeting_id, correlation_id, metadata)
            VALUES (?, clock_timestamp(), ?, 'USER', ?, ?, ?, ?, ?, CAST(? AS jsonb))
            """, UUID.randomUUID(), actorId, action, entityType, entityId,
            meetingId, requestId, encoded);
    }
}
