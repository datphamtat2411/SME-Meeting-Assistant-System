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

    /**
     * Administrator-initiated repair for an expired or undeliverable invitation.
     * The caller MUST already hold the target users row lock and be authorized;
     * token revocation, abandoned delivery intents, and new intent are atomic.
     */
    @Transactional
    public void reissueInitialSetup(UserEntity user) {
        if (user.getAccountStatus() != AccountStatus.PENDING_SETUP
                || user.getPasswordHash() != null || user.getCredentialChangedAt() != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Only accounts awaiting initial setup are eligible");
        }
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        var previous = jdbc.query("""
            SELECT t.requested_at,t.expires_at,t.used_at,t.revoked_at,
                (SELECT d.status FROM email_deliveries d
                  WHERE d.notification_type='ACCOUNT_SETUP' AND d.related_entity_id=t.id
                  ORDER BY d.created_at DESC,d.id DESC LIMIT 1) AS delivery_status
              FROM account_setup_tokens t
             WHERE t.user_id=?
             ORDER BY t.requested_at DESC,t.id DESC LIMIT 1
            """, (rs, row) -> new PriorInvitation(
                rs.getObject("requested_at", OffsetDateTime.class),
                rs.getObject("expires_at", OffsetDateTime.class),
                rs.getObject("used_at", OffsetDateTime.class),
                rs.getObject("revoked_at", OffsetDateTime.class),
                rs.getString("delivery_status")), user.getId());

        if (!previous.isEmpty()) {
            PriorInvitation last = previous.getFirst();
            boolean expired = !now.isBefore(last.expiresAt());
            boolean undeliverable = last.revokedAt() != null
                || last.deliveryStatus() == null || "DEAD".equals(last.deliveryStatus());
            if (last.usedAt() != null || (!expired && !undeliverable)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "An initial setup invitation is still being delivered or is usable");
            }

            // Restrict repeated privileged issuance, even when an SMTP handler
            // immediately marks every delivery DEAD.
            if (now.isBefore(last.requestedAt().plusMinutes(1))) {
                throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "Account setup invitation was recently issued");
            }
        }
        // Each successful administrator reissue records an audit event in the
        // same transaction as the replacement token. Initial issuance has no
        // ACCOUNT_SETUP_REISSUED event and must not consume the reissue quota.
        Integer reissuesLastDay = jdbc.queryForObject("""
            SELECT COUNT(*) FROM audit_events
             WHERE entity_type='USER' AND entity_id=?
               AND action_code='ACCOUNT_SETUP_REISSUED'
               AND occurred_at>?
            """, Integer.class, user.getId(), now.minusHours(24));
        if (reissuesLastDay != null && reissuesLastDay >= 5) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                "Account setup reissue limit reached");
        }

        jdbc.update("""
            UPDATE account_setup_tokens SET revoked_at=?
             WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL
            """, now, user.getId());
        // The worker may already have claimed a job: a late old email link is
        // harmless because its verifier has been revoked in the same commit.
        jdbc.update("""
            UPDATE email_deliveries SET status='DEAD',
                last_error_code='SETUP_REISSUED',last_error_summary=NULL,
                next_attempt_at=NULL,updated_at=?
             WHERE notification_type='ACCOUNT_SETUP' AND recipient_user_id=?
               AND status IN ('PENDING','FAILED','SENDING')
            """, now, user.getId());
        enqueueInitialSetup(user);
    }

    @Transactional
    public void completeSetup(String presented, String password) {
        passwordPolicy.validate(password);
        UUID tokenId = tokens.parseId(presented);
        if (tokenId == null) invalid();
        // Match the user-first lock ordering used by reissue/lifecycle mutations.
        // Read ownership without locking, then lock the canonical user row
        // before locking the token, to avoid opposite-order DB deadlocks.
        var owners = jdbc.query(
            "SELECT user_id,token_hash FROM account_setup_tokens WHERE id=?",
            (rs, row) -> new OwnerRow(
                rs.getObject("user_id", UUID.class), rs.getString("token_hash")), tokenId);
        // Reject invalid capability proofs before taking the user row lock.
        // The authoritative token check still happens after both locks.
        if (owners.size() != 1
                || !tokens.verify(tokenId, presented, owners.getFirst().tokenHash())) invalid();
        var account = users.findByIdForSessionAdmission(owners.getFirst().userId())
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY));
        if (account.getAccountStatus() != AccountStatus.PENDING_SETUP) invalid();

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
        if (!record.userId().equals(account.getId())) invalid();
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        if (record.usedAt() != null || record.revokedAt() != null || !now.isBefore(record.expiresAt())
                || !tokens.verify(tokenId, presented, record.tokenHash())) invalid();
        account.completeInitialSetup(hasher.hash(password), now);
        users.saveAndFlush(account);
        int consumed = jdbc.update("UPDATE account_setup_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL",
            now, tokenId);
        if (consumed != 1) throw new IllegalStateException("Setup token was concurrently consumed");
    }

    private static void invalid() {
        throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Invalid setup authorization");
    }

    private record OwnerRow(UUID userId, String tokenHash) {}

    private record PriorInvitation(OffsetDateTime requestedAt, OffsetDateTime expiresAt,
                                   OffsetDateTime usedAt, OffsetDateTime revokedAt,
                                   String deliveryStatus) {}

    private record TokenRow(UUID userId, String tokenHash, OffsetDateTime expiresAt,
                            OffsetDateTime usedAt, OffsetDateTime revokedAt) {}
}
