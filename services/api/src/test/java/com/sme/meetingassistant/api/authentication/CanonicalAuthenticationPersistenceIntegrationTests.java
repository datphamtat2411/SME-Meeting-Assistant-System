package com.sme.meetingassistant.api.authentication;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionEntity;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.entity.PasswordResetTokenEntity;
import com.sme.meetingassistant.api.authentication.entity.RefreshTokenEntity;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.repository.PasswordResetTokenRepository;
import com.sme.meetingassistant.api.authentication.repository.RefreshTokenRepository;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import jakarta.persistence.EntityManager;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

/** Real PostgreSQL/Testcontainers with Flyway and Hibernate mappings; no synthetic H2 schema. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@Transactional
class CanonicalAuthenticationPersistenceIntegrationTests {
    @Autowired private JdbcTemplate jdbc;
    @Autowired private EntityManager entityManager;
    @Autowired private UserRepository users;
    @Autowired private AuthSessionRepository sessions;
    @Autowired private RefreshTokenRepository refreshTokens;
    @Autowired private PasswordResetTokenRepository resetTokens;

    private UserEntity user() {
        return users.saveAndFlush(new UserEntity("auth-" + UUID.randomUUID() + "@example.com",
            "User", GlobalRole.EMPLOYEE, null));
    }

    private AuthSessionEntity session(UserEntity owner) {
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        return sessions.saveAndFlush(new AuthSessionEntity(
            owner.getId(), AuthClientType.WEB, now, now.plusDays(30),
            Map.of("platform", "integration-test")));
    }

    private static String verifier(String raw) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest(raw.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void canonicalTablesAndMigrationArePresentWithoutLegacyOrganizationModel() {
        Set<String> tables = Set.copyOf(jdbc.queryForList(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
            String.class));
        assertThat(tables).contains("users", "organizational_units", "manager_scope_units",
            "account_setup_tokens", "auth_sessions", "refresh_tokens", "password_reset_tokens")
            .doesNotContain("user_accounts", "organizations", "organization_memberships");

        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM flyway_schema_history
            WHERE version IN ('1','20','21') AND success
            """, Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) - count(DISTINCT version) FROM flyway_schema_history
            WHERE version IS NOT NULL
            """, Long.class)).isZero();

        Set<String> sessionColumns = Set.copyOf(jdbc.queryForList("""
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'auth_sessions'
            """, String.class));
        assertThat(sessionColumns).contains("user_id", "status", "last_seen_at",
            "absolute_expires_at", "revoked_at", "revoke_reason", "client_type", "client_metadata");

        Set<String> refreshColumns = Set.copyOf(jdbc.queryForList("""
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'refresh_tokens'
            """, String.class));
        assertThat(refreshColumns).contains("session_id", "token_hash", "issued_at",
            "expires_at", "consumed_at", "revoked_at", "replaced_by_token_id")
            .doesNotContain("user_id", "raw_token", "refresh_token");
    }

    @Test
    void sessionPersistsWebClientMetadataAndCanBeRevokedIndependently() {
        UserEntity owner = user();
        AuthSessionEntity created = session(owner);
        created.recordActivity(created.getCreatedAt().plusMinutes(3));
        sessions.flush();
        entityManager.clear();

        AuthSessionEntity loaded = sessions.findByIdForUpdate(created.getId()).orElseThrow();
        assertThat(loaded.getUserId()).isEqualTo(owner.getId());
        assertThat(loaded.getClientMetadata()).containsEntry("platform", "integration-test");
        assertThat(loaded.getLastSeenAt()).isAfter(loaded.getCreatedAt());
        assertThat(sessions.countByUserIdAndStatus(owner.getId(), AuthSessionStatus.ACTIVE)).isEqualTo(1);

        loaded.revoke(loaded.getCreatedAt().plusHours(1), "LOGOUT");
        sessions.flush();
        assertThat(loaded.getStatus()).isEqualTo(AuthSessionStatus.REVOKED);
        assertThat(loaded.getRevokeReason()).isEqualTo("LOGOUT");
        assertThat(loaded.getRevokedAt()).isNotNull();
        assertThat(sessions.countByUserIdAndStatus(owner.getId(), AuthSessionStatus.ACTIVE)).isZero();
    }

    @Test
    void sessionAbsoluteLifetimeCannotExceedThirtyDays() {
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        assertThatThrownBy(() -> new AuthSessionEntity(UUID.randomUUID(), AuthClientType.MOBILE,
            now, now.plusDays(31), null)).isInstanceOf(IllegalArgumentException.class);
        UUID existingUser = user().getId();
        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO auth_sessions(id,user_id,status,created_at,absolute_expires_at,client_type)
            VALUES (?,?,'ACTIVE',?,?,'WEB')
            """, UUID.randomUUID(), existingUser, now, now.plusDays(31)))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void authSessionRequiresCanonicalUserForeignKey() {
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO auth_sessions(id,user_id,status,created_at,absolute_expires_at,client_type)
            VALUES (?,?,'ACTIVE',?,?,'WEB')
            """, UUID.randomUUID(), UUID.randomUUID(), now, now.plusDays(7)))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void refreshRotationLineagePersistsOneVerifierPerToken() throws Exception {
        AuthSessionEntity family = session(user());
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        RefreshTokenEntity first = refreshTokens.saveAndFlush(
            new RefreshTokenEntity(family.getId(), verifier("original"), now, now.plusDays(7)));
        RefreshTokenEntity replacement = refreshTokens.saveAndFlush(
            new RefreshTokenEntity(family.getId(), verifier("replacement"), now.plusSeconds(1),
                now.plusDays(7)));
        first.consume(now.plusSeconds(2), replacement.getId());
        refreshTokens.flush();
        entityManager.clear();

        RefreshTokenEntity loaded = refreshTokens.findByTokenHashForUpdate(verifier("original"))
            .orElseThrow();
        assertThat(loaded.getSessionId()).isEqualTo(family.getId());
        assertThat(loaded.getConsumedAt()).isNotNull();
        assertThat(loaded.getReplacedByTokenId()).isEqualTo(replacement.getId());
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(family.getId())).hasSize(2);
        assertThat(refreshTokens.existsByTokenHash(verifier("replacement"))).isTrue();
    }

    @Test
    void duplicateRefreshVerifierIsRejectedByDatabase() throws Exception {
        UUID family = session(user()).getId();
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        refreshTokens.saveAndFlush(new RefreshTokenEntity(family, verifier("duplicate"), now,
            now.plusDays(7)));
        assertThatThrownBy(() -> refreshTokens.saveAndFlush(
            new RefreshTokenEntity(family, verifier("duplicate"), now, now.plusDays(7))))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void tokenLineageCannotCrossSessionFamilies() throws Exception {
        AuthSessionEntity firstFamily = session(user());
        AuthSessionEntity otherFamily = session(user());
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        RefreshTokenEntity original = refreshTokens.saveAndFlush(
            new RefreshTokenEntity(firstFamily.getId(), verifier("lineage-original"), now,
                now.plusDays(7)));
        RefreshTokenEntity foreign = refreshTokens.saveAndFlush(
            new RefreshTokenEntity(otherFamily.getId(), verifier("lineage-foreign"), now,
                now.plusDays(7)));
        assertThatThrownBy(() -> jdbc.update(
            "UPDATE refresh_tokens SET replaced_by_token_id = ? WHERE id = ?",
            foreign.getId(), original.getId()))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void tokenCannotExpireBeforeItIsIssued() {
        AuthSessionEntity family = session(user());
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO refresh_tokens(id,session_id,token_hash,issued_at,expires_at)
            VALUES (?,?,?,?,?)
            """, UUID.randomUUID(), family.getId(), "f".repeat(64), now, now.minusSeconds(1)))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void resetCapabilityIsSeparateAndRecordsUsedAndRevokedStates() throws Exception {
        UserEntity owner = user();
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        PasswordResetTokenEntity used = resetTokens.saveAndFlush(
            new PasswordResetTokenEntity(owner.getId(), verifier("reset-used"),
                now, now.plusMinutes(30)));
        PasswordResetTokenEntity revoked = resetTokens.saveAndFlush(
            new PasswordResetTokenEntity(owner.getId(), verifier("reset-revoked"),
                now, now.plusMinutes(30)));
        used.consume(now.plusMinutes(1));
        revoked.revoke(now.plusMinutes(1));
        resetTokens.flush();
        entityManager.clear();

        assertThat(resetTokens.findByTokenHashForUpdate(verifier("reset-used")).orElseThrow()
            .getUsedAt()).isNotNull();
        assertThat(resetTokens.findByTokenHashForUpdate(verifier("reset-revoked")).orElseThrow()
            .getRevokedAt()).isNotNull();
        assertThat(resetTokens.findByUserIdOrderByRequestedAtDesc(owner.getId())).hasSize(2);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM password_reset_tokens WHERE user_id=?
            """, Integer.class, owner.getId())).isEqualTo(2);
    }

    @Test
    void resetCapabilityEnforcesThirtyMinuteExpiryAndCanonicalUserForeignKey() throws Exception {
        UserEntity owner = user();
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        assertThatThrownBy(() -> new PasswordResetTokenEntity(owner.getId(),
            verifier("invalidreset"), now, now.plusHours(1)))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO password_reset_tokens(id,user_id,token_hash,requested_at,expires_at)
            VALUES (?,?,?,?,?)
            """, UUID.randomUUID(), UUID.randomUUID(), verifier("unknown-user"),
                now, now.plusMinutes(30))).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void revokeSessionPreservesHistoricalRefreshLineage() throws Exception {
        AuthSessionEntity family = session(user());
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        RefreshTokenEntity token = refreshTokens.saveAndFlush(
            new RefreshTokenEntity(family.getId(), verifier("historical"), now, now.plusDays(7)));
        family.revoke(now.plusMinutes(1), "ACCOUNT_DEACTIVATED");
        sessions.flush();

        assertThat(refreshTokens.findById(token.getId())).isPresent();
        assertThat(sessions.findById(family.getId()).orElseThrow()
            .getStatus()).isEqualTo(AuthSessionStatus.REVOKED);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM refresh_tokens t
            JOIN auth_sessions s ON s.id=t.session_id
            WHERE t.id=? AND s.status='REVOKED'
            """, Integer.class, token.getId())).isEqualTo(1);
        // A token row persisting is not an authorization grant; the active session is authoritative.
    }
}
