package com.sme.meetingassistant.api.userorganization.setup;

import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Canonical account setup. The token verifier and delivery intent commit in the same
 * transaction as the newly created PENDING_SETUP user. SMTP is never called inline.
 */
@Service
public class AccountSetupService {
    private final JdbcTemplate jdbc;
    private final AccountSetupTokenCodec tokens;
    private final AccountSetupPasswordPolicy passwordPolicy;
    private final AccountSetupPasswordHasher hasher;
    private final UserRepository users;

    public AccountSetupService(JdbcTemplate jdbc, AccountSetupTokenCodec tokens,
            AccountSetupPasswordPolicy passwordPolicy, AccountSetupPasswordHasher hasher,
            UserRepository users) {
        this.jdbc = jdbc;
        this.tokens = tokens;
        this.passwordPolicy = passwordPolicy;
        this.hasher = hasher;
        this.users = users;
    }

    @Transactional
    public void enqueueInitialSetup(UserEntity user) {
        if (user.getAccountStatus() != AccountStatus.PENDING_SETUP) {
            throw new IllegalStateException("Setup requires PENDING_SETUP account");
        }
        UUID tokenId = UUID.randomUUID();
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        String verifier = tokens.sha256(tokens.issue(tokenId));
        jdbc.update("INSERT INTO account_setup_tokens(id,user_id,token_hash,requested_at,expires_at) VALUES (?,?,?,?,?)",
            tokenId, user.getId(), verifier, now, now.plusHours(24));
        jdbc.update("""
            INSERT INTO email_deliveries(
                id,notification_type,recipient_user_id,recipient_email,related_entity_type,
                related_entity_id,status,dedupe_key,attempt_count,next_attempt_at,created_at,updated_at)
            VALUES (?,'ACCOUNT_SETUP',?,?,'ACCOUNT_SETUP',?,'PENDING',?,0,?,?,?)
            """, UUID.randomUUID(), user.getId(), user.getEmail(), tokenId,
            "account-setup:" + tokenId, now, now, now);
    }

    @Transactional
    public void completeSetup(String presented, String password) {
        passwordPolicy.validate(password);
        UUID tokenId = tokens.parseId(presented);
        if (tokenId == null) invalid();
        var records = jdbc.query("""
            SELECT user_id,token_hash,expires_at,used_at,revoked_at
            FROM account_setup_tokens WHERE id = ? FOR UPDATE
            """, (rs, row) -> new TokenRow(
                rs.getObject("user_id", UUID.class),
                rs.getString("token_hash"),
                rs.getObject("expires_at", OffsetDateTime.class),
                rs.getObject("used_at", OffsetDateTime.class),
                rs.getObject("revoked_at", OffsetDateTime.class)), tokenId);
        if (records.size() != 1) invalid();
        var record = records.getFirst();
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        if (record.usedAt() != null || record.revokedAt() != null || !now.isBefore(record.expiresAt())
                || !tokens.verify(tokenId, presented, record.tokenHash())) invalid();
        var account = users.findById(record.userId())
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY));
        if (account.getAccountStatus() != AccountStatus.PENDING_SETUP) invalid();
        account.completeInitialSetup(hasher.hash(password), now);
        users.saveAndFlush(account);
        int consumed = jdbc.update("UPDATE account_setup_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL",
            now, tokenId);
        if (consumed != 1) throw new IllegalStateException("Setup token was concurrently consumed");
    }

    private static void invalid() {
        throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Invalid setup authorization");
    }

    private record TokenRow(UUID userId, String tokenHash, OffsetDateTime expiresAt,
                            OffsetDateTime usedAt, OffsetDateTime revokedAt) {}
}
