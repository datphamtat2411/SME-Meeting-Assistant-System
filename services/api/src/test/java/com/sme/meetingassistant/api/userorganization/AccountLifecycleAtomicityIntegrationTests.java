package com.sme.meetingassistant.api.userorganization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.security.Rs256AccessTokenService;
import com.sme.meetingassistant.api.authentication.service.LoginAdmissionService;
import com.sme.meetingassistant.api.authentication.service.RefreshSessionService;
import com.sme.meetingassistant.api.authentication.transport.AuthTransport;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

/**
 * Commit/rollback verification: force an auth-owned revocation failure after
 * the organization transaction has already flushed its changed user state.
 * A 500 must not make account state, role or session authorization diverge.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(PostgresTestConfiguration.class)
class AccountLifecycleAtomicityIntegrationTests {
    private static final String PASSWORD="Lifecycle atomicity with sufficient Unicode 🔏 2026";
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired UserRepository users;
    @Autowired AccountSetupPasswordHasher passwords;
    @Autowired LoginAdmissionService login;
    @Autowired Rs256AccessTokenService jwt;
    @Autowired AuthSessionRepository sessions;
    @Autowired JdbcTemplate jdbc;
    @MockitoSpyBean RefreshSessionService revocations;

    private UserEntity active(GlobalRole role) {
        var user=new UserEntity("atomic-"+UUID.randomUUID()+"@example.com",
            "Atomic",role,null);
        user.completeInitialSetup(passwords.hash(PASSWORD),OffsetDateTime.now(ZoneOffset.UTC));
        return users.saveAndFlush(user);
    }
    private String access(UserEntity user) {
        var admitted=login.authenticateAndAdmit(user.getEmail(),PASSWORD,AuthClientType.MOBILE);
        return jwt.issue(user.getId(),admitted.sessionId());
    }
    private String etag(String bearer,UserEntity target) throws Exception {
        var detail=mvc.perform(get("/api/v1/users/"+target.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+bearer))
            .andExpect(status().isOk()).andReturn();
        return detail.getResponse().getHeader(HttpHeaders.ETAG);
    }
    private long audits(UserEntity target,String code) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE entity_id=? AND action_code=?
            """,Long.class,target.getId(),code);
    }

    @Test void failedRevocationRollsBackDeactivationAndPreservesLiveJwt() throws Exception {
        UserEntity admin=active(GlobalRole.ADMINISTRATOR);
        UserEntity target=active(GlobalRole.EMPLOYEE);
        String adminToken=access(admin);
        String employeeToken=access(target);
        String before=etag(adminToken,target);
        doThrow(new IllegalStateException("simulated revocation failure"))
            .when(revocations).revokeAllForUser(target.getId(),"ACCOUNT_DEACTIVATED");

        mvc.perform(post("/api/v1/users/"+target.getId()+"/deactivate")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+adminToken)
            .header(AuthTransport.PLATFORM,"mobile")
            .header(HttpHeaders.IF_MATCH,before))
            .andExpect(status().isInternalServerError());

        assertThat(users.findById(target.getId()).orElseThrow().getAccountStatus())
            .isEqualTo(AccountStatus.ACTIVE);
        assertThat(users.findById(target.getId()).orElseThrow().getDeactivatedAt()).isNull();
        assertThat(etag(adminToken,target)).isEqualTo(before);
        assertThat(sessions.countByUserIdAndStatus(target.getId(),AuthSessionStatus.ACTIVE))
            .isEqualTo(1);
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+employeeToken))
            .andExpect(status().isOk());
        assertThat(audits(target,"ACCOUNT_DEACTIVATED")).isZero();
        verify(revocations).revokeAllForUser(target.getId(),"ACCOUNT_DEACTIVATED");
    }

    @Test void failedRevocationRollsBackRoleChangeWithoutGrantingAuthority() throws Exception {
        UserEntity admin=active(GlobalRole.ADMINISTRATOR);
        UserEntity target=active(GlobalRole.EMPLOYEE);
        String adminToken=access(admin);
        String employeeToken=access(target);
        String before=etag(adminToken,target);
        doThrow(new IllegalStateException("simulated role revocation failure"))
            .when(revocations).revokeAllForUser(target.getId(),"ROLE_CHANGED");

        mvc.perform(patch("/api/v1/users/"+target.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+adminToken)
            .header(AuthTransport.PLATFORM,"mobile")
            .header(HttpHeaders.IF_MATCH,before)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("globalRole","ADMINISTRATOR"))))
            .andExpect(status().isInternalServerError());

        assertThat(users.findById(target.getId()).orElseThrow().getGlobalRole())
            .isEqualTo(GlobalRole.EMPLOYEE);
        assertThat(etag(adminToken,target)).isEqualTo(before);
        assertThat(sessions.countByUserIdAndStatus(target.getId(),AuthSessionStatus.ACTIVE))
            .isEqualTo(1);
        mvc.perform(get("/api/v1/users")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+employeeToken))
            .andExpect(status().isForbidden());
        assertThat(audits(target,"ROLE_CHANGED")).isZero();
        verify(revocations).revokeAllForUser(target.getId(),"ROLE_CHANGED");
    }
}
