package com.sme.meetingassistant.api.authentication.abuse;

import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Distributed rate limiting: PostgreSQL rolling windows with an advisory transaction
 * lock per HMAC key, not per-process counters. Fail closed on database errors.
 * Credential verification and refresh rotation occur ONLY after admission.
 */
@Service
@ConditionalOnProperty(prefix="app.auth.transport",name="enabled",havingValue="true")
public class AuthAbuseGuard {
    private final JdbcTemplate jdbc;
    private final TrustedClientSource sources;
    private final AuthSecurityEventRecorder audit;
    private final byte[] key;
    private final int loginIpLimit, refreshIpLimit, refreshCredentialLimit;
    private final int loginWindowSeconds, refreshWindowSeconds, refreshCredentialWindowSeconds;
    private final int pairBackoffThreshold, maxPairBackoffSeconds;

    public AuthAbuseGuard(JdbcTemplate jdbc, TrustedClientSource sources,
            AuthSecurityEventRecorder audit,
            @Value("${app.auth.abuse.hashing-key:}") String configuredKey,
            @Value("${app.auth.abuse.login-ip-limit:30}") int loginIpLimit,
            @Value("${app.auth.abuse.login-window-seconds:600}") int loginWindowSeconds,
            @Value("${app.auth.abuse.login-pair-threshold:3}") int pairBackoffThreshold,
            @Value("${app.auth.abuse.login-pair-max-delay-seconds:300}") int maxPairBackoffSeconds,
            @Value("${app.auth.abuse.refresh-ip-limit:60}") int refreshIpLimit,
            @Value("${app.auth.abuse.refresh-window-seconds:600}") int refreshWindowSeconds,
            @Value("${app.auth.abuse.refresh-credential-limit:12}") int refreshCredentialLimit,
            @Value("${app.auth.abuse.refresh-credential-window-seconds:60}") int refreshCredentialWindowSeconds) {
        this.jdbc=jdbc; this.sources=sources; this.audit=audit;
        this.loginIpLimit=positive(loginIpLimit,1,10000);
        this.refreshIpLimit=positive(refreshIpLimit,1,10000);
        this.refreshCredentialLimit=positive(refreshCredentialLimit,1,1000);
        this.loginWindowSeconds=positive(loginWindowSeconds,1,86400);
        this.refreshWindowSeconds=positive(refreshWindowSeconds,1,86400);
        this.refreshCredentialWindowSeconds=positive(refreshCredentialWindowSeconds,1,86400);
        this.pairBackoffThreshold=positive(pairBackoffThreshold,1,100);
        this.maxPairBackoffSeconds=positive(maxPairBackoffSeconds,1,3600);
        try {
            key=Base64.getDecoder().decode(configuredKey);
            if (key.length < 32) throw new IllegalArgumentException();
        } catch (RuntimeException invalid) {
            throw new IllegalStateException("Authentication abuse hashing key requires 32+ Base64 random bytes");
        }
    }

    private static int positive(int value,int min,int max) {
        if (value<min || value>max) throw new IllegalArgumentException("Invalid auth rate-limit configuration");
        return value;
    }

    public record Admission(String sourceHash,String pairHash) {}

    /** Accepted attempts are counted even if the password is invalid. */
    @Transactional
    public Admission loginAdmission(HttpServletRequest request,String account) {
        String sourceHash=fingerprint("ip",sources.from(request));
        String pairHash=fingerprint("account-source",sourceHash+"|"+
            (account==null?"invalid":account.trim().toLowerCase(java.util.Locale.ROOT)));
        boolean ipAllowed=recordRolling("LOGIN_IP",sourceHash,loginIpLimit,loginWindowSeconds);
        boolean pairAllowed=pairAllowed(pairHash);
        if (!ipAllowed || !pairAllowed) {
            audit.record(AuthSecurityEventRecorder.Action.LOGIN_THROTTLED,null,sourceHash);
            throw throttled(Math.max(2,loginWindowSeconds / 10));
        }
        return new Admission(sourceHash,pairHash);
    }

    @Transactional
    public void loginFailed(Admission admission) {
        // Serialize account-source counters across API workers, independently of the IP window.
        lock("PAIR|"+admission.pairHash());
        OffsetDateTime now=OffsetDateTime.now(ZoneOffset.UTC);
        var state=jdbc.query("""
            SELECT failure_count,updated_at FROM auth_login_failure_backoff
             WHERE pair_hash=? FOR UPDATE
            """,(rs,n)->new Failure(rs.getInt(1),
                rs.getObject(2,OffsetDateTime.class)),admission.pairHash());
        int failures=state.isEmpty() || state.getFirst().updatedAt().isBefore(now.minusHours(1))
            ? 1 : Math.min(state.getFirst().count()+1,1000000);
        int delay=failures<pairBackoffThreshold ? 0
            : Math.min(maxPairBackoffSeconds,
                (int)Math.min(1L << Math.min(failures-pairBackoffThreshold+1,20),
                    (long)maxPairBackoffSeconds));
        jdbc.update("""
            INSERT INTO auth_login_failure_backoff(pair_hash,failure_count,blocked_until,updated_at)
            VALUES (?,?,?,?)
            ON CONFLICT(pair_hash) DO UPDATE SET failure_count=EXCLUDED.failure_count,
                blocked_until=EXCLUDED.blocked_until,updated_at=EXCLUDED.updated_at
            """,admission.pairHash(),failures,now.plusSeconds(delay),now);
        audit.record(AuthSecurityEventRecorder.Action.LOGIN_DENIED,null,admission.sourceHash());
    }

    @Transactional
    public void loginSucceeded(Admission admission,UUID userId) {
        jdbc.update("DELETE FROM auth_login_failure_backoff WHERE pair_hash=?",
            admission.pairHash());
        audit.record(AuthSecurityEventRecorder.Action.LOGIN_SUCCEEDED,userId,admission.sourceHash());
        audit.record(AuthSecurityEventRecorder.Action.LOGIN_SESSION_CREATED,userId,admission.sourceHash());
    }

    @Transactional
    public Admission refreshAdmission(HttpServletRequest request,String opaqueToken) {
        String source=fingerprint("ip",sources.from(request));
        String presented=opaqueToken==null?"missing":opaqueToken;
        String credential=fingerprint("refresh-credential",presented.length()>256
            ? "oversized" : presented);
        boolean sourceAllowed=recordRolling("REFRESH_IP",source,
            refreshIpLimit,refreshWindowSeconds);
        boolean tokenAllowed=recordRolling("REFRESH_CREDENTIAL",credential,
            refreshCredentialLimit,refreshCredentialWindowSeconds);
        if (!sourceAllowed || !tokenAllowed) {
            audit.record(AuthSecurityEventRecorder.Action.REFRESH_THROTTLED,null,source);
            throw throttled(Math.max(2,refreshCredentialWindowSeconds / 2));
        }
        return new Admission(source,credential);
    }

    public void refreshOutcome(Admission admission,UUID userId,boolean successful) {
        audit.record(successful?AuthSecurityEventRecorder.Action.REFRESH_SUCCEEDED:
            AuthSecurityEventRecorder.Action.REFRESH_DENIED,userId,admission.sourceHash());
    }

    public String sourceFingerprint(HttpServletRequest request) {
        return fingerprint("ip",sources.from(request));
    }

    public void logEvent(AuthSecurityEventRecorder.Action action,UUID userId,
            HttpServletRequest request) {
        audit.record(action,userId,sourceFingerprint(request));
    }

    private boolean pairAllowed(String pairHash) {
        var active=jdbc.query("""
            SELECT blocked_until FROM auth_login_failure_backoff WHERE pair_hash=?
            """,(rs,i)->rs.getObject(1,OffsetDateTime.class),pairHash);
        return active.isEmpty() || !active.getFirst().isAfter(OffsetDateTime.now(ZoneOffset.UTC));
    }

    private boolean recordRolling(String kind,String hash,int limit,int windowSeconds) {
        lock(kind+"|"+hash);
        OffsetDateTime now=OffsetDateTime.now(ZoneOffset.UTC);
        Long used=jdbc.queryForObject("""
            SELECT count(*) FROM auth_abuse_attempts
             WHERE attempt_class=? AND key_hash=? AND attempted_at>?
            """,Long.class,kind,hash,now.minusSeconds(windowSeconds));
        if (used!=null && used>=limit) return false;
        jdbc.update("""
            INSERT INTO auth_abuse_attempts(id,attempt_class,key_hash,attempted_at)
            VALUES (?,?,?,?)
            """,UUID.randomUUID(),kind,hash,now);
        return true;
    }

    private void lock(String identifier) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?,0))",
            (java.sql.ResultSet rs)->{},identifier);
    }

    private String fingerprint(String purpose,String input) {
        try {
            Mac hmac=Mac.getInstance("HmacSHA256");
            hmac.init(new SecretKeySpec(key,"HmacSHA256"));
            return HexFormat.of().formatHex(hmac.doFinal(
                ("sme-auth-abuse-v1|"+purpose+"|"+input).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception unexpected) {
            throw new IllegalStateException("Authentication rate-limit key unavailable");
        }
    }

    public static ResponseStatusException throttled(int seconds) {
        org.springframework.http.HttpHeaders headers=new org.springframework.http.HttpHeaders();
        headers.set(HttpHeaders.RETRY_AFTER,Integer.toString(seconds));
        headers.set(HttpHeaders.CACHE_CONTROL,"no-store");
        return new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"Too many requests",null) {
            @Override public HttpHeaders getHeaders() { return headers; }
        };
    }

    private record Failure(int count,OffsetDateTime updatedAt) {}
}
