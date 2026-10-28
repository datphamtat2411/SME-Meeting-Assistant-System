package com.sme.meetingassistant.api.authentication.recovery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.security.Rs256AccessTokenService;
import com.sme.meetingassistant.api.authentication.service.LoginAdmissionService;
import com.sme.meetingassistant.api.authentication.service.RefreshSessionService;
import com.sme.meetingassistant.api.notification.email.TransactionalEmailDeliveryWorker;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.MailSendException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.JsonNode;

/** Real PostgreSQL, real filter chain, mocked external SMTP only; no rollback test envelope. */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties="app.auth.recovery.enabled=true")
class PasswordRecoveryIntegrationTests {
    private static final String FIRST="A strong existing password 🇻🇳 2026!";
    private static final String SECOND="Another sufficiently long password 🔐 2027!";
    private static final AtomicInteger IP_COUNTER=new AtomicInteger(20);
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepository users;
    @Autowired AccountSetupPasswordHasher hasher;
    @Autowired TransactionalEmailDeliveryWorker worker;
    @Autowired RecoveryCapabilityCodec codec;
    @Autowired LoginAdmissionService login;
    @Autowired RefreshSessionService refresh;
    @Autowired Rs256AccessTokenService jwt;
    @Autowired AuthSessionRepository sessions;
    @MockitoBean JavaMailSender smtp;
    private UserEntity active;
    private String source;

    @org.junit.jupiter.api.AfterEach
    void cleanupPendingDeliveries() {
        // Non-transactional tests verify real commits. Prevent one test's pending
        // security email from being claimed by another test's shared worker.
        if (active != null) {
            jdbc.update("""
                UPDATE email_deliveries SET status='DEAD',
                    last_error_code='TEST_TEARDOWN',next_attempt_at=NULL,
                    updated_at=clock_timestamp()
                WHERE recipient_user_id=? AND notification_type='PASSWORD_RECOVERY'
                  AND status IN ('PENDING','FAILED')
                """,active.getId());
        }
    }

    @BeforeEach void setupUser() {
        source="198.51.100."+IP_COUNTER.incrementAndGet();
        UserEntity account=new UserEntity("recover-"+UUID.randomUUID()+"@example.com",
            "Recovery Test",GlobalRole.EMPLOYEE,null);
        account.completeInitialSetup(hasher.hash(FIRST),OffsetDateTime.now(ZoneOffset.UTC));
        active=users.saveAndFlush(account);
    }

    private String payload(Object v) throws Exception {return json.writeValueAsString(v);}
    private MvcResult request(String email) throws Exception {
        return mvc.perform(post("/api/v1/auth/password-recovery")
            .with(r->{r.setRemoteAddr(source);return r;})
            .contentType(MediaType.APPLICATION_JSON).content(payload(Map.of("email",email))))
            .andExpect(status().isOk()).andReturn();
    }
    private String recoveryEmailToken(String email) throws Exception {
        request(email);
        assertThat(worker.deliverOne()).isTrue();
        var capture=ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(smtp,atLeastOnce()).send(capture.capture());
        String body=capture.getAllValues().getLast().getText();
        String bearer=body.split("#token=",2)[1].split("\\n",2)[0];
        assertThat(codec.parseId(bearer)).isEqualTo(tokenId());
        return bearer;
    }
    private MvcResult reset(String token,String password,int status) throws Exception {
        return mvc.perform(post("/api/v1/auth/password-reset")
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload(Map.of("token",token,"password",password))))
            .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status()
                .is(status)).andReturn();
    }
    private UUID tokenId() {
        return jdbc.queryForObject("""
            SELECT id FROM password_reset_tokens WHERE user_id=?
            ORDER BY requested_at DESC LIMIT 1
            """,UUID.class,active.getId());
    }

    @Test void neutralResponseForUnknownInactiveAndActiveAccounts() throws Exception {
        var eligible=request(active.getEmail());
        var absent=request("missing-"+UUID.randomUUID()+"@example.com");
        UserEntity inactive=new UserEntity("inactive-"+UUID.randomUUID()+"@example.com",
            "Inactive",GlobalRole.EMPLOYEE,null);
        inactive.completeInitialSetup(hasher.hash(FIRST),OffsetDateTime.now(ZoneOffset.UTC));
        org.springframework.test.util.ReflectionTestUtils.setField(inactive,
            "accountStatus",AccountStatus.INACTIVE);
        users.saveAndFlush(inactive);
        var denied=request(inactive.getEmail());
        // Common API Response deliberately includes a unique requestId/timestamp.
        // Compare only the neutral public contract rather than per-request metadata.
        var eligibleJson=json.readTree(eligible.getResponse().getContentAsString());
        var missingJson=json.readTree(absent.getResponse().getContentAsString());
        var deniedJson=json.readTree(denied.getResponse().getContentAsString());
        assertThat(eligibleJson.path("data")).isEqualTo(missingJson.path("data"))
            .isEqualTo(deniedJson.path("data"));
        assertThat(eligibleJson.path("code")).isEqualTo(missingJson.path("code"))
            .isEqualTo(deniedJson.path("code"));
        assertThat(eligible.getResponse().getHeader(HttpHeaders.CACHE_CONTROL))
            .contains("no-store");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM password_reset_tokens WHERE user_id=?
            """,Integer.class,active.getId())).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM password_reset_tokens WHERE user_id=?
            """,Integer.class,inactive.getId())).isZero();
    }

    @Test void recoveryEmailUsesSharedWorkerAndRandomTokenWithVerifierOnly() throws Exception {
        String token=recoveryEmailToken(active.getEmail());
        UUID id=codec.parseId(token);
        assertThat(id).isEqualTo(tokenId());
        assertThat(token).contains(".");
        assertThat(jdbc.queryForObject("""
            SELECT token_hash FROM password_reset_tokens WHERE id=?
            """,String.class,id)).isEqualTo(codec.verifier(token));
        assertThat(jdbc.queryForObject("""
            SELECT octet_length(delivery_nonce) FROM password_reset_tokens WHERE id=?
            """,Integer.class,id)).isEqualTo(32);
        assertThat(jdbc.queryForObject("""
            SELECT expires_at <= requested_at + INTERVAL '30 minutes'
            FROM password_reset_tokens WHERE id=?
            """,Boolean.class,id)).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT status FROM email_deliveries
            WHERE notification_type='PASSWORD_RECOVERY' AND related_entity_id=?
            """,String.class,id)).isEqualTo("SENT");
        var email=ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(smtp).send(email.capture());
        assertThat(email.getValue().getText()).contains("#token="+token);
        assertThat(email.getValue().getText()).doesNotContain(FIRST,"Bearer ");
        assertThat(jdbc.queryForObject("""
            SELECT dedupe_key FROM email_deliveries WHERE related_entity_id=?
            """,String.class,id)).doesNotContain(token);
    }

    @Test void resetConsumesOnceAuditsRevokesAllSessionsAndOldJwt() throws Exception {
        var session1=login.authenticateAndAdmit(active.getEmail(),FIRST,AuthClientType.MOBILE);
        var session2=login.authenticateAndAdmit(active.getEmail(),FIRST,AuthClientType.WEB);
        String oldJwt=jwt.issue(active.getId(),session1.sessionId());
        String raw=recoveryEmailToken(active.getEmail());
        var completed=reset(raw,SECOND,200);
        assertThat(completed.getResponse().getContentAsString()).contains("Password updated");
        assertThat(completed.getResponse().getHeader(HttpHeaders.CACHE_CONTROL)).contains("no-store");
        var current=users.findById(active.getId()).orElseThrow();
        assertThat(current.getAccountStatus()).isEqualTo(AccountStatus.ACTIVE);
        assertThat(current.getPasswordHash()).startsWith("$argon2id$");
        assertThat(hasher.matches(SECOND,current.getPasswordHash())).isTrue();
        assertThat(hasher.matches(FIRST,current.getPasswordHash())).isFalse();
        assertThat(current.getCredentialChangedAt()).isNotNull();
        assertThat(jdbc.queryForObject("""
            SELECT used_at IS NOT NULL FROM password_reset_tokens WHERE id=?
            """,Boolean.class,tokenId())).isTrue();
        assertThat(sessions.findById(session1.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.REVOKED);
        assertThat(sessions.findById(session2.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.REVOKED);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE action_code='PASSWORD_RESET_COMPLETED'
              AND entity_id=?
            """,Integer.class,active.getId())).isEqualTo(1);
        reset(raw,"A different long password 2028 🚀",422);
        assertThat(users.findById(active.getId()).orElseThrow().getPasswordHash())
            .isEqualTo(current.getPasswordHash());
        assertThatThrownBy(()->refresh.rotate(session1.refreshToken(),AuthClientType.MOBILE))
            .isInstanceOf(ResponseStatusException.class);
        mvc.perform(get("/api/v1/me/profile")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+oldJwt)).andExpect(status().isUnauthorized());
        var newSession=login.authenticateAndAdmit(active.getEmail(),SECOND,AuthClientType.MOBILE);
        assertThat(newSession.sessionId()).isNotEqualTo(session1.sessionId());
    }

    @Test void compromisedLongPasswordCannotConsumeRecoveryTokenOrChangeVerifier()
            throws Exception {
        String recovery = recoveryEmailToken(active.getEmail());
        String oldHash = users.findById(active.getId()).orElseThrow().getPasswordHash();
        reset(recovery, "1q2w3e4r5t6y7u8i9o0p", 422);
        reset(recovery, "SME Meeting Assistant 2026!", 422);
        assertThat(jdbc.queryForObject(
            "SELECT used_at FROM password_reset_tokens WHERE id=?",
            OffsetDateTime.class, tokenId())).isNull();
        assertThat(users.findById(active.getId()).orElseThrow().getPasswordHash())
            .isEqualTo(oldHash);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events
             WHERE entity_id=? AND action_code='PASSWORD_RESET_COMPLETED'
            """, Integer.class, active.getId())).isZero();

        reset(recovery, SECOND, 200);
        assertThat(hasher.matches(SECOND,users.findById(active.getId())
            .orElseThrow().getPasswordHash())).isTrue();
    }

    @Test void expiredRevokedInvalidAndForeignPurposeTokensNeverChangePassword() throws Exception {
        String raw=recoveryEmailToken(active.getEmail());
        reset("wrong-token",SECOND,422);
        reset(raw+"x",SECOND,422);
        reset("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJub25lIn0.signed",SECOND,422);
        jdbc.update("""
            UPDATE password_reset_tokens
              SET requested_at=clock_timestamp()-INTERVAL '1 hour',
                  expires_at=clock_timestamp()-INTERVAL '40 minutes'
            WHERE id=?
            """,tokenId());
        reset(raw,SECOND,422);
        jdbc.update("""
            UPDATE password_reset_tokens SET requested_at=clock_timestamp(),
              expires_at=clock_timestamp()+INTERVAL '25 minutes',
              revoked_at=clock_timestamp() WHERE id=?
            """,tokenId());
        reset(raw,SECOND,422);
        assertThat(hasher.matches(FIRST,users.findById(active.getId())
            .orElseThrow().getPasswordHash())).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE entity_id=? AND action_code='PASSWORD_RESET_COMPLETED'
            """,Integer.class,active.getId())).isZero();
    }

    @Test void threePerAccountHourlyRequestsAndTwentyPerSourceAreEnforcedNeutrally()
            throws Exception {
        for(int i=0;i<4;i++) request(active.getEmail());
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM password_reset_tokens WHERE user_id=?
            """,Integer.class,active.getId())).isEqualTo(3);
        for(int i=0;i<18;i++)
            request("unknown-"+i+"-"+UUID.randomUUID()+"@example.com");
        assertThat(jdbc.queryForObject("""
            SELECT attempts FROM recovery_ip_limits WHERE source_hash=?
            """,Integer.class,codec.sourceFingerprint(source))).isEqualTo(20);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries WHERE recipient_user_id=?
              AND notification_type='PASSWORD_RECOVERY'
            """,Integer.class,active.getId())).isEqualTo(3);
    }

    @Test void smtpFailureDoesNotRollbackRecoveryAndRetriesWithoutStoringSecrets()
            throws Exception {
        request(active.getEmail());
        UUID id=tokenId();
        doThrow(new MailSendException("sensitive mail provider response must never persist"))
            .doNothing().when(smtp).send(any(SimpleMailMessage.class));
        assertThat(worker.deliverOne()).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT status FROM email_deliveries WHERE related_entity_id=?
            """,String.class,id)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("""
            SELECT last_error_summary FROM email_deliveries WHERE related_entity_id=?
            """,String.class,id)).isNull();
        jdbc.update("""
            UPDATE email_deliveries SET next_attempt_at=clock_timestamp()-INTERVAL '1 minute'
            WHERE related_entity_id=?
            """,id);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT status FROM email_deliveries WHERE related_entity_id=?
            """,String.class,id)).isEqualTo("SENT");
        verify(smtp,times(2)).send(any(SimpleMailMessage.class));
    }

    @Test void consumedTokenCannotBeResentAndItsDeliveryIntentIsDead() throws Exception {
        request(active.getEmail());
        UUID id=tokenId();
        byte[] nonce=jdbc.queryForObject("SELECT delivery_nonce FROM password_reset_tokens WHERE id=?",
            byte[].class,id);
        reset(codec.issue(id,nonce),SECOND,200);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT status FROM email_deliveries WHERE related_entity_id=?
            """,String.class,id)).isEqualTo("DEAD");
        verifyNoInteractions(smtp);
    }
}
