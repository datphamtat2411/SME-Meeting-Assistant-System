package com.sme.meetingassistant.api.media.worker;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.slf4j.LoggerFactory;

/** Bounded durable backlog recovery; never holds DB locks across broker/storage I/O. */
@Component
@ConditionalOnProperty(name="app.worker.dead-letter.enabled",havingValue="true")
public class DeadLetterRecovery {
    private final JdbcTemplate jdbc;
    private final DeadLetterReconciliation reconciliation;
    public DeadLetterRecovery(JdbcTemplate jdbc,DeadLetterReconciliation reconciliation) { this.jdbc=jdbc; this.reconciliation=reconciliation; }
    @Scheduled(fixedDelayString="${app.worker.dead-letter.recovery-ms:30000}")
    public void recover() {
        var events=jdbc.query("""
            SELECT d.*,r.evidence_sha256 FROM transcription_worker_reconciliations r
            JOIN transcription_worker_deliveries d ON d.event_id=r.event_id
            WHERE r.disposition='DEFERRED' ORDER BY r.checked_at LIMIT 25
            """,(r,n)->new DeadLetterEvent(r.getObject("event_id",java.util.UUID.class),r.getObject("processing_job_id",java.util.UUID.class),
                r.getObject("meeting_id",java.util.UUID.class),r.getObject("source_media_id",java.util.UUID.class),r.getObject("requested_by_user_id",java.util.UUID.class),
                r.getInt("generation"),r.getString("event_type"),r.getInt("event_schema_version"),r.getString("retry_from_stage"),r.getString("evidence_sha256")));
        for(var event:events) {
            try { reconciliation.reconcile(event); }
            catch(RuntimeException failure) { LoggerFactory.getLogger(getClass()).warn("worker.dlq.recovery.failed event={}",event.event()); }
        }
    }
}
