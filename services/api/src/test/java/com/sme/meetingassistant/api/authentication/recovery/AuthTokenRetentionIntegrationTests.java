package com.sme.meetingassistant.api.authentication.recovery;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupService;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.transaction.annotation.Transactional;

/** Real PostgreSQL. Cleanup is invoked deterministically, never by sleeping for a scheduler. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = "app.auth.token-retention.enabled=true")
@Transactional
class AuthTokenRetentionIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepository users;
    @Autowired AccountSetupService setup;
    @Autowired AuthTokenRetentionCleanup cleanup;

    private UUID pendingUser() {
        UserEntity pending = users.saveAndFlush(new UserEntity(
            "retention-" + UUID.randomUUID() + "@example.com",
            "Retention Test", GlobalRole.EMPLOYEE, null));
        return pending.getId();
    }

    private String verifier() {
        // Test-only opaque 64-hex-character verifier, never a real bearer.
        return UUID.randomUUID().toString().replace("-", "").repeat(2);
    }

    private UUID setupToken(UUID userId, int expiredDaysAgo) {
        UUID id = UUID.randomUUID();
        OffsetDateTime expiry = OffsetDateTime.now(ZoneOffset.UTC).minusDays(expiredDaysAgo);
        jdbc.update("""
            INSERT INTO account_setup_tokens
                (id,user_id,token_hash,requested_at,expires_at)
            VALUES (?,?,?,?,?)
            """, id, userId, verifier(), expiry.minusHours(12), expiry);
        return id;
    }

    private UUID resetToken(UUID userId, int expiredDaysAgo) {
        UUID id = UUID.randomUUID();
        OffsetDateTime expiry = OffsetDateTime.now(ZoneOffset.UTC).minusDays(expiredDaysAgo);
        jdbc.update("""
            INSERT INTO password_reset_tokens
                (id,user_id,token_hash,requested_at,expires_at)
            VALUES (?,?,?,?,?)
            """, id, userId, verifier(), expiry.minusMinutes(30), expiry);
        return id;
    }

    private UUID delivery(String type, String entityType, UUID userId, UUID tokenId,
            String status) {
        UUID id = UUID.randomUUID();
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        jdbc.update("""
            INSERT INTO email_deliveries
                (id,notification_type,recipient_user_id,recipient_email,
                 related_entity_type,related_entity_id,status,dedupe_key,
                 attempt_count,next_attempt_at,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,0,?,?,?)
            """, id,type,userId,"retention@example.com",entityType,tokenId,status,
            "retention:" + id,now,now,now);
        return id;
    }

    private int tokenCount(String table, UUID id) {
        if (!table.equals("account_setup_tokens") && !table.equals("password_reset_tokens")) {
            throw new IllegalArgumentException("Unexpected table");
        }
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE id=?",
            Integer.class,id);
    }

    private String deliveryStatus(UUID id) {
        return jdbc.queryForObject("SELECT status FROM email_deliveries WHERE id=?",
            String.class,id);
    }

    @Test
    void expiredRecordsPurgedButRecentAndAuditHistorySurvive() {
        UUID user = pendingUser();
        UUID oldSetup = setupToken(user,31);
        UUID recentSetup = setupToken(user,29);
        UUID oldReset = resetToken(user,31);
        UUID recentReset = resetToken(user,29);
        // A genuinely unexpired setup invitation and reset authorization must survive.
        setup.enqueueInitialSetup(users.findById(user).orElseThrow());
        UUID liveSetup=jdbc.queryForObject("""
            SELECT id FROM account_setup_tokens
             WHERE user_id=? AND expires_at>clock_timestamp()
            """,UUID.class,user);
        UUID liveReset=UUID.randomUUID();
        OffsetDateTime liveNow=OffsetDateTime.now(ZoneOffset.UTC);
        jdbc.update("""
            INSERT INTO password_reset_tokens
                (id,user_id,token_hash,requested_at,expires_at)
            VALUES (?,?,?,?,?)
            """,liveReset,user,verifier(),liveNow,liveNow.plusMinutes(30));
        UUID oldSetupDelivery = delivery("ACCOUNT_SETUP","ACCOUNT_SETUP",user,oldSetup,"PENDING");
        UUID recentSetupDelivery = delivery("ACCOUNT_SETUP","ACCOUNT_SETUP",user,recentSetup,"PENDING");
        UUID oldResetDelivery = delivery("PASSWORD_RECOVERY","PASSWORD_RESET",user,oldReset,"FAILED");
        UUID recentResetDelivery = delivery("PASSWORD_RECOVERY","PASSWORD_RESET",user,recentReset,"SENDING");
        UUID audit = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO audit_events
                (id,occurred_at,actor_user_id,actor_type,action_code,entity_type,entity_id)
            VALUES (?,clock_timestamp(),?,'USER','ACCOUNT_SETUP_REISSUED','USER',?)
            """, audit,user,user);

        AuthTokenRetentionCleanup.PurgeCounts removed=cleanup.cleanupBatch();
        assertThat(removed.setup()).isEqualTo(1);
        assertThat(removed.recovery()).isEqualTo(1);
        assertThat(tokenCount("account_setup_tokens",oldSetup)).isZero();
        assertThat(tokenCount("password_reset_tokens",oldReset)).isZero();
        assertThat(tokenCount("account_setup_tokens",recentSetup)).isEqualTo(1);
        assertThat(tokenCount("password_reset_tokens",recentReset)).isEqualTo(1);
        assertThat(tokenCount("account_setup_tokens",liveSetup)).isEqualTo(1);
        assertThat(tokenCount("password_reset_tokens",liveReset)).isEqualTo(1);
        assertThat(deliveryStatus(oldSetupDelivery)).isEqualTo("DEAD");
        assertThat(deliveryStatus(oldResetDelivery)).isEqualTo("DEAD");
        assertThat(deliveryStatus(recentSetupDelivery)).isEqualTo("PENDING");
        assertThat(deliveryStatus(recentResetDelivery)).isEqualTo("SENDING");
        assertThat(jdbc.queryForObject("""
            SELECT last_error_code FROM email_deliveries WHERE id=?
            """,String.class,oldSetupDelivery)).isEqualTo("TOKEN_RETENTION_PURGED");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM audit_events WHERE id=?
            """,Integer.class,audit)).isEqualTo(1);
        assertThat(users.existsById(user)).isTrue();
        assertThat(cleanup.cleanupBatch()).isEqualTo(
            new AuthTokenRetentionCleanup.PurgeCounts(0,0));
    }

    @Test
    void consumedAndRevokedRecordsAreRemovedWithoutTouchingSentHistory() {
        UUID user = pendingUser();
        UUID consumed = setupToken(user,32);
        UUID revoked = resetToken(user,32);
        jdbc.update("""
            UPDATE account_setup_tokens SET used_at=expires_at-INTERVAL '1 hour' WHERE id=?
            """,consumed);
        jdbc.update("""
            UPDATE password_reset_tokens SET revoked_at=expires_at-INTERVAL '1 minute' WHERE id=?
            """,revoked);
        UUID sent = delivery("ACCOUNT_SETUP","ACCOUNT_SETUP",user,consumed,"SENT");
        UUID dead = delivery("PASSWORD_RECOVERY","PASSWORD_RESET",user,revoked,"DEAD");
        UUID unrelated = delivery("MEETING_SCHEDULED","MEETING",user,consumed,"PENDING");

        assertThat(cleanup.cleanupBatch()).isEqualTo(
            new AuthTokenRetentionCleanup.PurgeCounts(1,1));
        assertThat(deliveryStatus(sent)).isEqualTo("SENT");
        assertThat(deliveryStatus(dead)).isEqualTo("DEAD");
        assertThat(deliveryStatus(unrelated)).isEqualTo("PENDING");
        assertThat(tokenCount("account_setup_tokens",consumed)).isZero();
        assertThat(tokenCount("password_reset_tokens",revoked)).isZero();
    }

    @Test
    void cleanupIsBoundedTo200RecordsPerPurposeAndRepeatable() {
        UUID user=pendingUser();
        for(int i=0;i<201;i++) setupToken(user,31);
        UUID recent=setupToken(user,29);
        assertThat(cleanup.cleanupBatch()).isEqualTo(
            new AuthTokenRetentionCleanup.PurgeCounts(200,0));
        assertThat(cleanup.cleanupBatch()).isEqualTo(
            new AuthTokenRetentionCleanup.PurgeCounts(1,0));
        assertThat(cleanup.cleanupBatch()).isEqualTo(
            new AuthTokenRetentionCleanup.PurgeCounts(0,0));
        assertThat(tokenCount("account_setup_tokens",recent)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM account_setup_tokens WHERE user_id=?
            """,Integer.class,user)).isEqualTo(1);
    }

    @Test
    void workerIntentForExpiredSetupCannotRemainRunnableAfterCleanup() {
        UUID user=pendingUser();
        UUID expired=setupToken(user,31);
        UUID sending=delivery("ACCOUNT_SETUP","ACCOUNT_SETUP",user,expired,"SENDING");
        assertThat(cleanup.cleanupBatch().setup()).isEqualTo(1);
        assertThat(deliveryStatus(sending)).isEqualTo("DEAD");
        assertThat(jdbc.queryForObject("""
            SELECT next_attempt_at FROM email_deliveries WHERE id=?
            """,OffsetDateTime.class,sending)).isNull();
    }
}
