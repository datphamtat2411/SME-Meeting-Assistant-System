package com.sme.meetingassistant.api.authentication.recovery;

import com.sme.meetingassistant.api.authentication.service.RefreshSessionService;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.service.EmailNormalizer;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordPolicy;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Recovery is independent of access/refresh/account-setup. The same transaction
 * writes recovery verifier + durable email intent. A successful reset changes the
 * canonical verifier, consumes the recovery authorization, revokes ALL sessions,
 * invalidates other reset capabilities and appends a security audit event.
 */
@Service
@ConditionalOnProperty(prefix="app.auth.recovery",name="enabled",havingValue="true")
public class PasswordRecoveryService {
    private final JdbcTemplate jdbc;
    private final UserRepository users;
    private final RecoveryCapabilityCodec tokens;
    private final AccountSetupPasswordHasher passwords;
    private final AccountSetupPasswordPolicy policy;
    private final RefreshSessionService sessions;
    public PasswordRecoveryService(JdbcTemplate jdbc,UserRepository users,
            RecoveryCapabilityCodec tokens,AccountSetupPasswordHasher passwords,
            AccountSetupPasswordPolicy policy, RefreshSessionService sessions) {
        this.jdbc=jdbc;this.users=users;this.tokens=tokens;
        this.passwords=passwords;this.policy=policy;this.sessions=sessions;
    }

    /** Neutral for unknown, pending, inactive or throttled identities. */
    @Transactional
    public void request(String email, String remoteAddress) {
        String source=tokens.sourceFingerprint(remoteAddress);
        OffsetDateTime now=OffsetDateTime.now(ZoneOffset.UTC);
        var admission=jdbc.query("""
          INSERT INTO recovery_ip_limits(source_hash,window_started_at,attempts)
          VALUES (?,?,1)
          ON CONFLICT(source_hash) DO UPDATE
            SET window_started_at=CASE
                  WHEN recovery_ip_limits.window_started_at <= EXCLUDED.window_started_at - INTERVAL '1 hour'
                    THEN EXCLUDED.window_started_at ELSE recovery_ip_limits.window_started_at END,
                attempts=CASE
                  WHEN recovery_ip_limits.window_started_at <= EXCLUDED.window_started_at - INTERVAL '1 hour'
                    THEN 1 ELSE recovery_ip_limits.attempts+1 END
          WHERE recovery_ip_limits.window_started_at <= EXCLUDED.window_started_at - INTERVAL '1 hour'
             OR recovery_ip_limits.attempts < 20
          RETURNING attempts
          """,(rs,n)->rs.getInt(1),source,now);
        // Do not disclose which limit (or account eligibility) caused suppression.
        if(admission.isEmpty()) return;
        if(email==null || email.isBlank() || email.length()>320) return;
        String normalized=EmailNormalizer.normalize(email);
        var candidate=users.findByEmailNormalized(normalized);
        if(candidate.isEmpty()) {
            // Comparable inexpensive capability work for unknown users.
            tokens.verifier(tokens.issue(UUID.randomUUID(),tokens.nonce()));
            return;
        }
        var owner=users.findByIdForSessionAdmission(candidate.get().getId()).orElse(null);
        if(owner==null || owner.getAccountStatus()!=AccountStatus.ACTIVE
                || owner.getPasswordHash()==null || !owner.getPasswordHash().startsWith("$argon2id$"))
            return;
        Long recent=jdbc.queryForObject("""
            SELECT count(*) FROM password_reset_tokens
             WHERE user_id=? AND requested_at>? 
            """,Long.class,owner.getId(),now.minusHours(1));
        if(recent!=null && recent>=3) return;
        UUID id=UUID.randomUUID();
        byte[] nonce=tokens.nonce();
        String verifier=tokens.verifier(tokens.issue(id,nonce));
        jdbc.update("""
            INSERT INTO password_reset_tokens
              (id,user_id,token_hash,requested_at,expires_at,delivery_nonce)
            VALUES (?,?,?,?,?,?)
            """,id,owner.getId(),verifier,now,now.plusMinutes(30),nonce);
        jdbc.update("""
            INSERT INTO email_deliveries(
              id,notification_type,recipient_user_id,recipient_email,
              related_entity_type,related_entity_id,status,dedupe_key,attempt_count,
              next_attempt_at,created_at,updated_at)
            VALUES (?,'PASSWORD_RECOVERY',?,?,'PASSWORD_RESET',?,'PENDING',?,0,?,?,?)
            """,UUID.randomUUID(),owner.getId(),owner.getEmail(),id,
            "password-recovery:"+id,now,now,now);
    }

    @Transactional
    public void reset(String presented,String newPassword) {
        policy.validate(newPassword);
        UUID id=tokens.parseId(presented);
        if(id==null) invalid();
        // Read only user UUID before taking any entity lock; avoid stale JPA state.
        var owners=jdbc.query("""
            SELECT user_id FROM password_reset_tokens WHERE id=?
            """,(rs,n)->rs.getObject(1,UUID.class),id);
        if(owners.size()!=1) invalid();
        var account=users.findByIdForSessionAdmission(owners.getFirst()).orElse(null);
        if(account==null || account.getAccountStatus()!=AccountStatus.ACTIVE) invalid();
        var rows=jdbc.query("""
            SELECT token_hash,delivery_nonce,expires_at,used_at,revoked_at
              FROM password_reset_tokens WHERE id=? AND user_id=? FOR UPDATE
            """,(rs,n)->new ResetRow(rs.getString(1),rs.getBytes(2),
                rs.getObject(3,OffsetDateTime.class),rs.getObject(4,OffsetDateTime.class),
                rs.getObject(5,OffsetDateTime.class)),id,account.getId());
        if(rows.size()!=1) invalid();
        ResetRow row=rows.getFirst();
        OffsetDateTime now=OffsetDateTime.now(ZoneOffset.UTC);
        if(row.usedAt()!=null || row.revokedAt()!=null || !now.isBefore(row.expiresAt())
                || !tokens.valid(id,row.nonce(),presented,row.hash())) invalid();
        // Argon2id is computed before any persisted mutation; failures roll back everything.
        account.resetPasswordVerifier(passwords.hash(newPassword),now);
        users.saveAndFlush(account);
        jdbc.update("UPDATE password_reset_tokens SET used_at=? WHERE id=? AND used_at IS NULL",
            now,id);
        jdbc.update("""
            UPDATE password_reset_tokens SET revoked_at=?
             WHERE user_id=? AND id<>? AND used_at IS NULL AND revoked_at IS NULL
            """,now,account.getId(),id);
        sessions.revokeAllForUser(account.getId(),"PASSWORD_RESET");
        jdbc.update("""
            INSERT INTO audit_events(id,occurred_at,actor_user_id,actor_type,action_code,
                entity_type,entity_id)
            VALUES (?,?,?,'SYSTEM','PASSWORD_RESET_COMPLETED','USER',?)
            """,UUID.randomUUID(),now,account.getId(),account.getId());
    }

    private static void invalid() {
        throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
            "Invalid or expired password recovery authorization");
    }
    private record ResetRow(String hash,byte[] nonce,OffsetDateTime expiresAt,
                             OffsetDateTime usedAt,OffsetDateTime revokedAt) {}
}
