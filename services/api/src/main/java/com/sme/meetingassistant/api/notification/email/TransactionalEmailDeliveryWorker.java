package com.sme.meetingassistant.api.notification.email;

import jakarta.mail.internet.AddressException;
import jakarta.mail.internet.InternetAddress;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * One durable queue and one bounded SMTP retry worker for all registered email purposes.
 * Registry-based dispatch prevents unimplemented notification types from being claimed
 * (in particular PASSWORD_RECOVERY until P4-T06 registers its secure token handler).
 *
 * Delivery is at-least-once because SMTP cannot be atomically committed with PostgreSQL.
 * Never persist full rendered mail, bearer tokens, SMTP credentials or provider exceptions.
 */
@Component
public final class TransactionalEmailDeliveryWorker {
    private final JdbcTemplate jdbc;
    private final NamedParameterJdbcTemplate namedJdbc;
    private final Map<String, TransactionalEmailHandler> handlers;
    private final ObjectProvider<JavaMailSender> mailSender;
    private final String sender;
    private final boolean workerEnabled;

    public TransactionalEmailDeliveryWorker(JdbcTemplate jdbc,
            List<TransactionalEmailHandler> registeredHandlers,
            ObjectProvider<JavaMailSender> mailSender,
            @Value("${app.email.delivery.sender:}") String sender,
            @Value("${app.email.delivery.worker-enabled:true}") boolean workerEnabled) {
        this.jdbc = jdbc;
        this.namedJdbc = new NamedParameterJdbcTemplate(jdbc);
        this.mailSender = mailSender;
        this.sender = sender;
        this.workerEnabled = workerEnabled;
        Map<String, TransactionalEmailHandler> configured = new LinkedHashMap<>();
        for (TransactionalEmailHandler handler : registeredHandlers) {
            String type = handler.notificationType();
            if (type == null || !type.matches("[A-Z][A-Z0-9_]{0,47}")
                    || configured.putIfAbsent(type, handler) != null) {
                throw new IllegalStateException("Duplicate or invalid transactional email handler type");
            }
        }
        this.handlers = Map.copyOf(configured);
    }

    @Scheduled(fixedDelayString = "${app.email.delivery.poll-delay-ms:30000}")
    public void poll() {
        // @EnableScheduling is application-wide: another module may enable
        // it even when email worker-enabled=false. Never poll in that case.
        if (!workerEnabled) return;
        for (int i = 0; i < 10; i++) {
            if (!deliverOne()) break;
        }
    }

    /** One eligible delivery, exposed for deterministic integration testing. */
    public boolean deliverOne() {
        Set<String> supported = handlers.keySet();
        if (supported.isEmpty()) return false;
        List<Delivery> claimed = namedJdbc.query("""
            UPDATE email_deliveries SET status='SENDING',
                attempt_count=attempt_count + 1, updated_at=clock_timestamp()
            WHERE id=(
                SELECT id FROM email_deliveries
                 WHERE notification_type IN (:supported)
                   AND ((status IN ('PENDING','FAILED')
                         AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
                        OR (status='SENDING'
                            AND updated_at < clock_timestamp() - INTERVAL '5 minutes'))
                 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
            ) RETURNING id,notification_type,related_entity_type,related_entity_id,
                        recipient_user_id,recipient_email,dedupe_key,attempt_count
            """, new MapSqlParameterSource("supported", supported),
            (rs, index) -> new Delivery(
                rs.getObject("id", UUID.class),
                rs.getString("notification_type"),
                rs.getString("related_entity_type"),
                rs.getObject("related_entity_id", UUID.class),
                rs.getObject("recipient_user_id", UUID.class),
                rs.getString("recipient_email"),
                rs.getString("dedupe_key"),
                rs.getInt("attempt_count")));
        if (claimed.isEmpty()) return false;

        Delivery job = claimed.getFirst();
        try {
            // A long-lived worker may have lost this lease to another attempt.
            // No renderer or SMTP call may proceed with a superseded claim.
            if (!claimStillOwned(job)) return true;
            var prepared = handlers.get(job.type()).prepare(
                new TransactionalEmailHandler.DeliveryContext(job.contextId(),
                    job.relatedEntityType(), job.recipientUserId(), job.recipientEmail(),
                    job.dedupeKey()));
            if (prepared.content().isEmpty()) {
                markSkipped(job, prepared.skipReason());
                return true;
            }
            // Recheck the durable claim immediately before SMTP. A business
            // change can invalidate the claim while the renderer is running.
            if (!claimStillOwned(job)) return true;
            send(job.recipientEmail(), prepared.content().orElseThrow());
            // Generation fencing prevents an old SMTP attempt from overwriting
            // a newer worker's claim result (SMTP itself remains at-least-once).
            jdbc.update("""
                UPDATE email_deliveries SET status='SENT',sent_at=clock_timestamp(),
                    last_error_code=NULL,last_error_summary=NULL,next_attempt_at=NULL,
                    updated_at=clock_timestamp()
                 WHERE id=? AND status='SENDING' AND attempt_count=?
                """, job.id(), job.attempts());
        } catch (RuntimeException deliveryError) {
            // Do not persist/log the exception: SMTP may include provider secrets.
            int retryMinutes = Math.min(60, 1 << Math.min(job.attempts(), 6));
            if (job.attempts() >= 5) {
                markDead(job, "SMTP_DELIVERY_FAILED");
            } else {
                jdbc.update("""
                    UPDATE email_deliveries SET status='FAILED',
                        next_attempt_at=clock_timestamp() + (? * INTERVAL '1 minute'),
                        last_error_code='SMTP_DELIVERY_FAILED',last_error_summary=NULL,
                        updated_at=clock_timestamp()
                     WHERE id=? AND status='SENDING' AND attempt_count=?
                """, retryMinutes, job.id(), job.attempts());
            }
        }
        return true;
    }

    private void send(String recipient, TransactionalEmailHandler.Content content) {
        if (sender == null || sender.isBlank()) {
            throw new IllegalStateException("Transactional email sender is not configured");
        }
        if (content.subject() == null || content.subject().isBlank()
                || content.subject().length() > 200
                || content.subject().contains("\r") || content.subject().contains("\n")
                || content.body() == null || content.body().isBlank()) {
            throw new IllegalStateException("Invalid transactional email template");
        }
        if (!validAddress(sender) || !validAddress(recipient)) {
            throw new IllegalStateException("Invalid transactional email address");
        }
        JavaMailSender smtp = mailSender.getIfAvailable();
        if (smtp == null) throw new IllegalStateException("SMTP not configured");
        SimpleMailMessage mail = new SimpleMailMessage();
        mail.setFrom(sender);
        mail.setTo(recipient);
        mail.setSubject(content.subject());
        mail.setText(content.body());
        smtp.send(mail);
    }

    private static boolean validAddress(String address) {
        if (address == null || address.isBlank() || address.contains("\r")
                || address.contains("\n") || address.contains(",") || address.contains(";")) {
            return false;
        }
        try {
            InternetAddress parsed = new InternetAddress(address, true);
            parsed.validate();
            return address.equals(parsed.getAddress());
        } catch (AddressException invalid) {
            return false;
        }
    }

    /** Check status AND claim generation without holding a PostgreSQL lock during SMTP. */
    private boolean claimStillOwned(Delivery job) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS (
                SELECT 1 FROM email_deliveries
                 WHERE id=? AND status='SENDING' AND attempt_count=?
            )
            """, Boolean.class, job.id(), job.attempts()));
    }

    private void markSkipped(Delivery job, String reason) {
        jdbc.update("""
            UPDATE email_deliveries
               SET status='SKIPPED', skip_reason=?,last_error_code=NULL,
                   last_error_summary=NULL,next_attempt_at=NULL,
                   updated_at=clock_timestamp()
             WHERE id=? AND status='SENDING' AND attempt_count=?
            """, reason, job.id(), job.attempts());
    }

    private void markDead(Delivery job, String code) {
        jdbc.update("""
            UPDATE email_deliveries SET status='DEAD',last_error_code=?,
                last_error_summary=NULL,next_attempt_at=NULL,updated_at=clock_timestamp()
             WHERE id=? AND status='SENDING' AND attempt_count=?
            """, code, job.id(), job.attempts());
    }

    private record Delivery(UUID id, String type, String relatedEntityType, UUID contextId,
                            UUID recipientUserId, String recipientEmail, String dedupeKey,
                            int attempts) { }
}
