package com.sme.meetingassistant.api.authentication.abuse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.transport.AuthTransport;
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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.ObjectMapper;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties={
    "app.auth.transport.enabled=true",
    "app.auth.abuse.login-ip-limit=5",
    "app.auth.abuse.login-pair-threshold=3",
    "app.auth.abuse.refresh-ip-limit=3",
    "app.auth.abuse.refresh-credential-limit=2"
})
class AuthAbuseIntegrationTests {
    private static final AtomicInteger NEXT_IP=new AtomicInteger(40);
    private static final String PASSWORD="Correct and sufficiently long Unicode password 🧩 2026";
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired AuthAbuseGuard guard;
    @Autowired UserRepository users;
    @Autowired AuthSessionRepository sessions;
    @Autowired AccountSetupPasswordHasher passwords;
    private String remote;
    private UserEntity user;

    @BeforeEach void createFixture() {
        remote="198.51.100."+NEXT_IP.incrementAndGet();
        UserEntity account=new UserEntity("limit-"+UUID.randomUUID()+"@example.com",
            "Login Rate Test",GlobalRole.EMPLOYEE,null);
        account.completeInitialSetup(passwords.hash(PASSWORD),OffsetDateTime.now(ZoneOffset.UTC));
        user=users.saveAndFlush(account);
    }

    private MvcResult mobileLogin(String email,String password,int expected) throws Exception {
        return mvc.perform(post("/api/v1/auth/login")
            .with(r->{r.setRemoteAddr(remote);return r;})
            .header(AuthTransport.PLATFORM,"mobile")
            .header("X-Forwarded-For","203.0.113.9")
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("email",email,"password",password))))
            .andExpect(status().is(expected)).andReturn();
    }

    @Test void fiveAttemptsPerSourceAreAllowedAndSixthIsCanonical429() throws Exception {
        for(int i=0;i<5;i++) {
            mobileLogin("unknown-"+i+"@example.com","incorrect-password-"+i+"-2026",401);
        }
        var blocked=mobileLogin(user.getEmail(),PASSWORD,429);
        var body=json.readTree(blocked.getResponse().getContentAsString());
        assertThat(body.path("code").asText()).isEqualTo("RATE_LIMIT_EXCEEDED");
        assertThat(blocked.getResponse().getHeader(HttpHeaders.RETRY_AFTER)).isNotBlank();
        assertThat(blocked.getResponse().getHeader(HttpHeaders.CACHE_CONTROL))
            .contains("no-store");
        assertThat(sessions.countByUserIdAndStatus(user.getId(),AuthSessionStatus.ACTIVE))
            .isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE action_code='LOGIN_THROTTLED'
            """,Long.class)).isPositive();
    }

    @Test void repeatedWrongPasswordProgressivelyBlocksOnePairButNotEntireAccount() throws Exception {
        for(int i=0;i<3;i++) mobileLogin(user.getEmail(),"incorrect-password-2026",401);
        var throttled=mobileLogin(user.getEmail(),PASSWORD,429);
        assertThat(json.readTree(throttled.getResponse().getContentAsString())
            .path("code").asText()).isEqualTo("RATE_LIMIT_EXCEEDED");
        assertThat(sessions.countByUserIdAndStatus(user.getId(),AuthSessionStatus.ACTIVE))
            .isZero();
        remote="198.51.100."+NEXT_IP.incrementAndGet();
        var success=mobileLogin(user.getEmail(),PASSWORD,200);
        assertThat(json.readTree(success.getResponse().getContentAsString())
            .path("data").path("accessToken").asText()).isNotBlank();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE actor_user_id=?
                AND action_code='LOGIN_SUCCEEDED'
            """,Long.class,user.getId())).isPositive();
    }

    @Test void refreshIsThrottledBeforeTokenDatabaseLookupAndDoesNotLogBearer() throws Exception {
        var signedIn=mobileLogin(user.getEmail(),PASSWORD,200);
        String token=json.readTree(signedIn.getResponse().getContentAsString())
            .path("data").path("refreshToken").asText();
        for(int i=0;i<3;i++) {
            mvc.perform(post("/api/v1/auth/refresh")
                .with(r->{r.setRemoteAddr(remote);return r;})
                .header(AuthTransport.PLATFORM,"mobile")
                .header(HttpHeaders.AUTHORIZATION,"Bearer "+("A".repeat(63)+i)))
                .andExpect(status().isUnauthorized());
        }
        var blocked=mvc.perform(post("/api/v1/auth/refresh")
            .with(r->{r.setRemoteAddr(remote);return r;})
            .header(AuthTransport.PLATFORM,"mobile")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+token))
            .andExpect(status().isTooManyRequests()).andReturn();
        assertThat(json.readTree(blocked.getResponse().getContentAsString())
            .path("code").asText()).isEqualTo("RATE_LIMIT_EXCEEDED");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE action_code='REFRESH_THROTTLED'
            """,Long.class)).isPositive();
        String persisted=jdbc.queryForObject("""
            SELECT coalesce(string_agg(metadata::text||action_code,','),'') FROM audit_events
            """,String.class);
        assertThat(persisted).doesNotContain(token,PASSWORD,user.getEmail(),remote);
    }

    @Test void concurrentAdmissionsAcrossThreadsNeverExceedSharedPostgresLimit() throws Exception {
        int total=8;
        var start=new java.util.concurrent.CountDownLatch(1);
        var ready=new java.util.concurrent.CountDownLatch(total);
        var executor=java.util.concurrent.Executors.newFixedThreadPool(total);
        try {
            var futures=new java.util.ArrayList<java.util.concurrent.Future<Boolean>>();
            for(int i=0;i<total;i++) {
                final int index=i;
                futures.add(executor.submit(()->{
                    var request=new org.springframework.mock.web.MockHttpServletRequest();
                    request.setRemoteAddr(remote);
                    ready.countDown();
                    if(!start.await(20,java.util.concurrent.TimeUnit.SECONDS))
                        throw new IllegalStateException("Parallel admission gate timed out");
                    try {
                        guard.loginAdmission(request,"parallel-"+index+"@example.com");
                        return true;
                    } catch (org.springframework.web.server.ResponseStatusException throttled) {
                        assertThat(throttled.getStatusCode())
                            .isEqualTo(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS);
                        return false;
                    }
                }));
            }
            assertThat(ready.await(20,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            start.countDown();
            int allowed=0;
            for(var future:futures) {
                if(future.get(60,java.util.concurrent.TimeUnit.SECONDS)) allowed++;
            }
            assertThat(allowed).isEqualTo(5);
            var probe=new org.springframework.mock.web.MockHttpServletRequest();
            probe.setRemoteAddr(remote);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM auth_abuse_attempts
                 WHERE attempt_class='LOGIN_IP' AND key_hash=?
                """,Long.class,guard.sourceFingerprint(probe))).isEqualTo(5L);
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(20,java.util.concurrent.TimeUnit.SECONDS))
                .isTrue();
        }
    }

    @Test void successfulLoginAndLogoutGenerateStructuredAuditWithoutSecrets() throws Exception {
        var signedIn=mobileLogin(user.getEmail(),PASSWORD,200);
        var data=json.readTree(signedIn.getResponse().getContentAsString()).path("data");
        String access=data.path("accessToken").asText();
        String refresh=data.path("refreshToken").asText();
        mvc.perform(post("/api/v1/auth/logout")
            .with(r->{r.setRemoteAddr(remote);return r;})
            .header(AuthTransport.PLATFORM,"mobile")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+access))
            .andExpect(status().isOk());
        var codes=jdbc.query("""
            SELECT action_code FROM audit_events WHERE actor_user_id=?
            """,(rs,n)->rs.getString(1),user.getId());
        assertThat(codes).contains("LOGIN_SUCCEEDED","LOGIN_SESSION_CREATED","SESSION_LOGGED_OUT");
        String metadata=jdbc.queryForObject("""
            SELECT coalesce(string_agg(metadata::text,','),'') FROM audit_events
             WHERE actor_user_id=?
            """,String.class,user.getId());
        assertThat(metadata).doesNotContain(refresh,access,PASSWORD,user.getEmail(),remote);
    }
}
