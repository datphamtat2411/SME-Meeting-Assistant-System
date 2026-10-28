package com.sme.meetingassistant.api.userorganization.setup;

import java.net.URI;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Small durable PostgreSQL delivery queue. One atomic claim per message prevents parallel
 * workers from sending the same attempt; stale SENDING leases are recoverable after a crash.
 * SMTP delivery remains at-least-once, not exactly-once.
 */
@Component
public class AccountSetupDeliveryWorker {
    private final JdbcTemplate jdbc;
    private final AccountSetupTokenCodec codec;
    private final ObjectProvider<JavaMailSender> mailSender;
    private final String sender;
    private final String setupUrl;

    public AccountSetupDeliveryWorker(JdbcTemplate jdbc, AccountSetupTokenCodec codec,
            ObjectProvider<JavaMailSender> mailSender,
            @Value("${app.account-setup.sender:}") String sender,
            @Value("${app.account-setup.setup-url:}") String setupUrl) {
        this.jdbc = jdbc;
        this.codec = codec;
        this.mailSender = mailSender;
        this.sender = sender;
        this.setupUrl = setupUrl;
    }

    @Scheduled(fixedDelayString = "${app.account-setup.poll-delay-ms:30000}")
    public void poll() {
        for (int i = 0; i < 10; i++) {
            if (!deliverOne()) break;
        }
    }

    /** One bounded delivery attempt; public for deterministic integration testing. */
    public boolean deliverOne() {
        List<Delivery> claimed = jdbc.query("""
            UPDATE email_deliveries SET status = 'SENDING',
                attempt_count = attempt_count + 1, updated_at = clock_timestamp()
            WHERE id = (
                SELECT id FROM email_deliveries
                WHERE notification_type = 'ACCOUNT_SETUP'
                  AND ((status IN ('PENDING','FAILED')
                        AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
                       OR (status = 'SENDING'
                           AND updated_at < clock_timestamp() - INTERVAL '5 minutes'))
                ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
            ) RETURNING id,related_entity_id,recipient_email,attempt_count
            """, (rs,n) -> new Delivery(
                rs.getObject("id", UUID.class),
                rs.getObject("related_entity_id", UUID.class),
                rs.getString("recipient_email"),
                rs.getInt("attempt_count")));
        if (claimed.isEmpty()) return false;
        Delivery job = claimed.getFirst();
        try {
            if (!isValidPendingToken(job.tokenId())) {
                markDead(job.id(), "SETUP_TOKEN_UNAVAILABLE");
                return true;
            }
            send(job);
            jdbc.update("""
                UPDATE email_deliveries SET status='SENT',sent_at=clock_timestamp(),
                    last_error_code=NULL,last_error_summary=NULL,next_attempt_at=NULL,
                    updated_at=clock_timestamp() WHERE id=? AND status='SENDING'
                """, job.id());
        } catch (RuntimeException sendingError) {
            // No SMTP/token/recipient details, stack trace, or provider response is persisted.
            int delayMinutes = Math.min(60, 1 << Math.min(job.attempts(), 6));
            if (job.attempts() >= 5) {
                markDead(job.id(), "SMTP_DELIVERY_FAILED");
            } else {
                jdbc.update("""
                    UPDATE email_deliveries SET status='FAILED',
                        next_attempt_at=clock_timestamp() + (? * INTERVAL '1 minute'),
                        last_error_code='SMTP_DELIVERY_FAILED',last_error_summary=NULL,
                        updated_at=clock_timestamp() WHERE id=? AND status='SENDING'
                    """, delayMinutes, job.id());
            }
        }
        return true;
    }

    private boolean isValidPendingToken(UUID tokenId) {
        if (tokenId == null) return false;
        Integer found = jdbc.queryForObject("""
            SELECT COUNT(*) FROM account_setup_tokens t JOIN users u ON u.id=t.user_id
            WHERE t.id=? AND t.expires_at>clock_timestamp()
              AND t.used_at IS NULL AND t.revoked_at IS NULL AND u.account_status='PENDING_SETUP'
            """, Integer.class, tokenId);
        return found != null && found == 1;
    }

    private void send(Delivery job) {
        if (sender.isBlank()) throw new IllegalStateException("APP_ACCOUNT_SETUP_SENDER is missing");
        URI destination = URI.create(setupUrl);
        if (!"https".equalsIgnoreCase(destination.getScheme()) || destination.getHost() == null
                || destination.getFragment() != null || destination.getRawQuery() != null) {
            throw new IllegalStateException("APP_ACCOUNT_SETUP_URL must be an HTTPS page without query/fragment");
        }
        JavaMailSender smtp = mailSender.getIfAvailable();
        if (smtp == null) throw new IllegalStateException("SMTP not configured");
        String link = destination + "#token=" + codec.issue(job.tokenId());
        SimpleMailMessage message = new SimpleMailMessage();
        message.setFrom(sender);
        message.setTo(job.recipientEmail());
        message.setSubject("Complete your SME Meeting Assistant account setup");
        message.setText("Set your account password using this one-time link (expires within 24 hours):\n"
            + link + "\nIf you did not expect this invitation, please disregard it.");
        smtp.send(message);
    }

    private void markDead(UUID id, String code) {
        jdbc.update("""
            UPDATE email_deliveries SET status='DEAD',last_error_code=?,last_error_summary=NULL,
                next_attempt_at=NULL,updated_at=clock_timestamp() WHERE id=? AND status='SENDING'
            """, code, id);
    }

    private record Delivery(UUID id, UUID tokenId, String recipientEmail, int attempts) {}
}
