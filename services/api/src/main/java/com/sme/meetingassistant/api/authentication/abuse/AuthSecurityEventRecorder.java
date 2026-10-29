package com.sme.meetingassistant.api.authentication.abuse;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Audit only allowlisted event codes and opaque ids; never capture request bodies or secrets. */
@Component
public class AuthSecurityEventRecorder {
    private static final Logger logger = LoggerFactory.getLogger(AuthSecurityEventRecorder.class);
    private final JdbcTemplate jdbc;
    public AuthSecurityEventRecorder(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public enum Action {
        LOGIN_SUCCEEDED, LOGIN_DENIED, LOGIN_THROTTLED, LOGIN_SESSION_CREATED,
        REFRESH_SUCCEEDED, REFRESH_DENIED, REFRESH_THROTTLED,
        REFRESH_REPLAY_DETECTED, SESSION_LOGGED_OUT, RECOVERY_REQUEST_RECEIVED
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(Action action, UUID userId, String sourceHash) {
        String metadata = sourceHash != null && sourceHash.matches("[0-9a-f]{64}")
            ? "{\"source_hash\":\""+sourceHash+"\"}" : "{}";
        String requestId = RequestIdContext.currentRequestId();
        jdbc.update("""
            INSERT INTO audit_events(
              id,occurred_at,actor_user_id,actor_type,action_code,
              entity_type,entity_id,correlation_id,metadata)
            VALUES (?,? ,?,'SYSTEM',?,'USER',?,?,?::jsonb)
            """, UUID.randomUUID(), OffsetDateTime.now(ZoneOffset.UTC),
            userId, action.name(), userId,
            requestId == null ? null : requestId.substring(0,Math.min(128,requestId.length())),
            metadata);
        logger.info("security_action={} actor_id={} request_id={}", action, userId, requestId);
    }
}
