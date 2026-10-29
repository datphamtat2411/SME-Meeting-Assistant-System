package com.sme.meetingassistant.api.notification.email;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupService;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.MailSendException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

/**
 * Real PostgreSQL queue and shared SMTP worker, with a TEST-ONLY recovery handler.
 * The actual recovery token renderer belongs to P4-T06 once its auth schema is present.
 */
@ActiveProfiles("test")
@SpringBootTest
@Import({PostgresTestConfiguration.class,
         TransactionalEmailDeliveryIntegrationTests.RecoveryTestHandlerConfig.class})
@Transactional
class TransactionalEmailDeliveryIntegrationTests {
    private static final UUID REVOKED = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID TRANSIENT = UUID.fromString("00000000-0000-0000-0000-000000000002");
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepository users;
    @Autowired AccountSetupService setup;
    @Autowired TransactionalEmailDeliveryWorker worker;
    @MockitoBean JavaMailSender smtp;

    @TestConfiguration(proxyBeanMethods = false)
    static class RecoveryTestHandlerConfig {
        @Bean
        TransactionalEmailHandler recoveryTestHandler() {
            return new TransactionalEmailHandler() {
                @Override public String notificationType() { return "PASSWORD_RECOVERY"; }

                @Override public Optional<Content> compose(UUID id, String address) {
                    if (REVOKED.equals(id)) return Optional.empty();
                    if (TRANSIENT.equals(id)) throw new IllegalStateException("temporary renderer failure");
                    return Optional.of(new Content("Reset your account password",
                        "Test-only recovery intent " + id + " for " + address));
                }
            };
        }
    }

    private UUID queue(String type, UUID purposeId) {
        UUID deliveryId = UUID.randomUUID();
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        jdbc.update("""
            INSERT INTO email_deliveries(
                id,notification_type,recipient_email,related_entity_type,related_entity_id,
                status,dedupe_key,attempt_count,next_attempt_at,created_at,updated_at)
            VALUES (?,?,?,'PASSWORD_RESET',?,'PENDING',?,0,?,?,?)
            """, deliveryId, type, "recipient@example.com", purposeId,
            "integration:" + deliveryId, now, now.minusMinutes(1), now.minusMinutes(1));
        return deliveryId;
    }

    private String status(UUID id) {
        return jdbc.queryForObject("SELECT status FROM email_deliveries WHERE id=?",
            String.class, id);
    }

    @Test
    void registeredRecoveryAndExistingSetupUseSameWorkerAndSingleSmtpSender() {
        UUID recovery = queue("PASSWORD_RECOVERY", UUID.randomUUID());
        UserEntity pending = users.saveAndFlush(new UserEntity(
            "setup-" + UUID.randomUUID() + "@example.com",
            "Pending Setup", GlobalRole.EMPLOYEE, null));
        setup.enqueueInitialSetup(pending);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(status(recovery)).isEqualTo("SENT");
        assertThat(worker.deliverOne()).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM email_deliveries
            WHERE notification_type='ACCOUNT_SETUP' AND recipient_user_id=? AND status='SENT'
            """, Integer.class, pending.getId())).isEqualTo(1);
        assertThat(worker.deliverOne()).isFalse();
        ArgumentCaptor<SimpleMailMessage> captures =
            ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(smtp, times(2)).send(captures.capture());
        var messages = captures.getAllValues();
        assertThat(messages).extracting(SimpleMailMessage::getSubject)
            .containsExactly("Reset your account password",
                "Complete your SME Meeting Assistant account setup");
        assertThat(messages).extracting(SimpleMailMessage::getFrom).containsOnly(
            "test-sender@example.invalid");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM email_deliveries
            WHERE last_error_summary IS NOT NULL
            """, Integer.class)).isZero();
    }

    @Test
    void unsupportedNotificationTypeIsNotClaimedOrDropped() {
        UUID unsupported = queue("UNREGISTERED_EVENT", UUID.randomUUID());
        assertThat(worker.deliverOne()).isFalse();
        assertThat(status(unsupported)).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("""
            SELECT attempt_count FROM email_deliveries WHERE id=?
            """, Integer.class, unsupported)).isZero();
        verifyNoInteractions(smtp);
    }

    @Test
    void revokedRecoveryContextIsSkippedWithoutSending() {
        UUID delivery = queue("PASSWORD_RECOVERY", REVOKED);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(status(delivery)).isEqualTo("SKIPPED");
        assertThat(jdbc.queryForObject("""
            SELECT skip_reason FROM email_deliveries WHERE id=?
            """, String.class, delivery)).isEqualTo("ACTION_NO_LONGER_ELIGIBLE");
        assertThat(jdbc.queryForObject("""
            SELECT last_error_code FROM email_deliveries WHERE id=?
            """, String.class, delivery)).isNull();
        assertThat(worker.deliverOne()).isFalse(); // terminal, never retried
        verifyNoInteractions(smtp);
    }

    @Test
    void smtpFailureRetriesRecoveryIntentWithoutPersistingProviderDetails() {
        UUID delivery = queue("PASSWORD_RECOVERY", UUID.randomUUID());
        doThrow(new MailSendException("smtp secret provider trace must never be stored"))
            .doNothing().when(smtp).send(any(SimpleMailMessage.class));
        assertThat(worker.deliverOne()).isTrue();
        assertThat(status(delivery)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("""
            SELECT last_error_code FROM email_deliveries WHERE id=?
            """, String.class, delivery)).isEqualTo("SMTP_DELIVERY_FAILED");
        assertThat(jdbc.queryForObject("""
            SELECT last_error_summary FROM email_deliveries WHERE id=?
            """, String.class, delivery)).isNull();
        assertThat(worker.deliverOne()).isFalse(); // backoff, no immediate duplicate
        jdbc.update("""
            UPDATE email_deliveries SET next_attempt_at=clock_timestamp() - INTERVAL '1 minute'
            WHERE id=?
            """, delivery);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(status(delivery)).isEqualTo("SENT");
        verify(smtp, times(2)).send(any(SimpleMailMessage.class));
    }

    @Test
    void unsafeRendererFailsClosedAndRetriesWithoutHeaderInjection() {
        UUID delivery = queue("PASSWORD_RECOVERY", TRANSIENT);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(status(delivery)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("""
            SELECT last_error_summary FROM email_deliveries WHERE id=?
            """, String.class, delivery)).isNull();
        verifyNoInteractions(smtp);
    }
}
