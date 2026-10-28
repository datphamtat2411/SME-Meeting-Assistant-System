package com.sme.meetingassistant.api.authentication;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
import com.sme.meetingassistant.api.userorganization.repository.*;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import jakarta.servlet.http.Cookie;
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
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Real Web/Mobile bearer filter, canonical organization data, PostgreSQL session and
 * refresh revocation. No T05 lifecycle commands are simulated in PRODUCTION:
 * the lifecycle tests explicitly invoke the auth-owned revocation capability as
 * a future cross-PR integration contract.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(PostgresTestConfiguration.class)
class AuthIdentityBoundaryIntegrationTests {
    private static final String PASSWORD = "Long test identity passphrase with Unicode 🔐 2026";
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired UserRepository users;
    @Autowired OrganizationalUnitRepository orgUnits;
    @Autowired ManagerScopeUnitRepository scopes;
    @Autowired AuthSessionRepository sessions;
    @Autowired AccountSetupPasswordHasher passwords;
    @Autowired LoginAdmissionService login;
    @Autowired RefreshSessionService refresh;
    @Autowired Rs256AccessTokenService accessTokens;
    @Autowired PlatformTransactionManager manager;
    @Autowired JdbcTemplate jdbc;

    private UserEntity account(GlobalRole role, UUID primary) {
        var user = new UserEntity("identity-"+UUID.randomUUID()+"@example.com",
            "Identity Projection",role,primary);
        user.completeInitialSetup(passwords.hash(PASSWORD),OffsetDateTime.now(ZoneOffset.UTC));
        return users.saveAndFlush(user);
    }
    private LoginAdmissionService.AdmittedLogin admit(UserEntity user,AuthClientType client) {
        return login.authenticateAndAdmit(user.getEmail(),PASSWORD,client);
    }
    private MvcResult me(String jwt) throws Exception {
        return mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+jwt))
            .andExpect(status().isOk()).andReturn();
    }
    private JsonNode data(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsString()).path("data");
    }
    private void denied(String jwt) throws Exception {
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+jwt))
            .andExpect(status().isUnauthorized());
    }
    private static String bearer(LoginAdmissionService.AdmittedLogin session,
            Rs256AccessTokenService tokens) {
        return tokens.issue(session.userId(),session.sessionId());
    }
    private TransactionTemplate tx() {return new TransactionTemplate(manager);}

    @Test
    void mobileIdentityIsCurrentSafeProjectionNotProfileOrSensitiveAuthData() throws Exception {
        var user=account(GlobalRole.EMPLOYEE,null);
        var session=admit(user,AuthClientType.MOBILE);
        String jwt=bearer(session,accessTokens);
        var response=me(jwt);
        var body=data(response);
        assertThat(body.path("userId").asText()).isEqualTo(user.getId().toString());
        assertThat(body.path("email").asText()).isEqualTo(user.getEmail());
        assertThat(body.path("displayName").asText()).isEqualTo(user.getDisplayName());
        assertThat(body.path("globalRole").asText()).isEqualTo("EMPLOYEE");
        assertThat(body.path("accountStatus").asText()).isEqualTo("ACTIVE");
        assertThat(body.path("session").path("id").asText())
            .isEqualTo(session.sessionId().toString());
        assertThat(body.path("session").path("clientType").asText()).isEqualTo("MOBILE");
        assertThat(body.path("session").path("absoluteExpiresAt").asText()).isNotBlank();
        assertThat(body.path("directoryManagementScope").path("allUnits").asBoolean()).isFalse();
        assertThat(body.path("directoryManagementScope").path("unitIds").size()).isZero();
        assertThat(response.getResponse().getHeader(HttpHeaders.CACHE_CONTROL)).contains("no-store");
        String serialized=response.getResponse().getContentAsString();
        assertThat(serialized).doesNotContain(jwt,session.refreshToken(),
            user.getPasswordHash(),"passwordHash","tokenHash","accessToken","refreshToken",
            "meetingPermissions");
        // PR #3 owns profile CRUD; P4-T08 introduces no competing profile route.
        mvc.perform(get("/api/v1/me/profile")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+jwt))
            .andExpect(status().isOk());
    }

    @Test
    void webHttpOnlyAccessCookieUsesSameVerifiedRs256Session() throws Exception {
        var user=account(GlobalRole.EMPLOYEE,null);
        var session=admit(user,AuthClientType.WEB);
        String jwt=bearer(session,accessTokens);
        var response=mvc.perform(get("/api/v1/auth/me")
            .cookie(new Cookie(AuthTransport.ACCESS,jwt)))
            .andExpect(status().isOk()).andReturn();
        assertThat(data(response).path("session").path("clientType").asText()).isEqualTo("WEB");
        assertThat(response.getResponse().getContentAsString())
            .doesNotContain(jwt,session.refreshToken());
    }

    @Test
    void anonymousSpoofedPrincipalAndWrongSessionClaimsCannotAccessMe() throws Exception {
        var user=account(GlobalRole.ADMINISTRATOR,null);
        mvc.perform(get("/api/v1/auth/me")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/auth/me").header("X-User-Id",user.getId().toString())
            .header("X-Role","ADMINISTRATOR")).andExpect(status().isUnauthorized());
        denied("not-a-valid-jwt");
        var session=admit(user,AuthClientType.MOBILE);
        String jwt=bearer(session,accessTokens);
        // A DB session ID is not a bearer credential.
        denied(session.sessionId().toString());
        me(jwt);
    }

    @Test
    void directoryAdminProjectionNeverClaimsMeetingContentAuthorization() throws Exception {
        var admin=account(GlobalRole.ADMINISTRATOR,null);
        var session=admit(admin,AuthClientType.MOBILE);
        var data=data(me(bearer(session,accessTokens)));
        assertThat(data.path("directoryManagementScope").path("allUnits").asBoolean()).isTrue();
        assertThat(data.path("directoryManagementScope").path("unitIds").size()).isZero();
        assertThat(data.toString()).doesNotContain("meetingScope","meetingContent",
            "meetingPermissions","transcript","recordingAccess");
        // Real meeting-content endpoints are owned by PR #2; no fake grant is added.
    }

    @Test
    void managerHasOnlyExplicitDirectoryScopeAndServerEnforcesObjectAccess() throws Exception {
        var granted=orgUnits.saveAndFlush(new OrganizationalUnitEntity(
            "granted-"+UUID.randomUUID(),"Granted Unit",null));
        var outside=orgUnits.saveAndFlush(new OrganizationalUnitEntity(
            "outside-"+UUID.randomUUID(),"Unrelated Unit",null));
        var manager=account(GlobalRole.DEPARTMENT_MANAGER,granted.getId());
        scopes.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(),granted.getId(),null));
        var allowedUser=account(GlobalRole.EMPLOYEE,granted.getId());
        var otherUser=account(GlobalRole.EMPLOYEE,outside.getId());
        var session=admit(manager,AuthClientType.MOBILE);
        String jwt=bearer(session,accessTokens);
        var body=data(me(jwt));
        var visible=body.path("directoryManagementScope");
        assertThat(visible.path("allUnits").asBoolean()).isFalse();
        assertThat(visible.path("unitIds").size()).isEqualTo(1);
        assertThat(visible.path("unitIds").get(0).asText()).isEqualTo(granted.getId().toString());
        mvc.perform(get("/api/v1/users/"+allowedUser.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+jwt)).andExpect(status().isOk());
        mvc.perform(get("/api/v1/users/"+otherUser.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+jwt)).andExpect(status().isNotFound());
        var list=mvc.perform(get("/api/v1/users")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+jwt))
            .andExpect(status().isOk()).andReturn();
        String entries=list.getResponse().getContentAsString();
        assertThat(entries).contains(allowedUser.getId().toString())
            .doesNotContain(otherUser.getId().toString());
    }

    @Test
    void inactiveOrganizationalUnitsDoNotAppearAsUsableManagementGrants() throws Exception {
        var current = orgUnits.saveAndFlush(new OrganizationalUnitEntity(
            "current-"+UUID.randomUUID(), "Active Management Unit", null));
        var inactive = orgUnits.saveAndFlush(new OrganizationalUnitEntity(
            "inactive-"+UUID.randomUUID(), "Retired Management Unit", null));
        var manager = account(GlobalRole.DEPARTMENT_MANAGER, current.getId());
        scopes.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(),current.getId(),null));
        scopes.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(),inactive.getId(),null));
        var loginSession = admit(manager,AuthClientType.MOBILE);
        String jwt = bearer(loginSession,accessTokens);

        // A former authorized unit becomes inactive while the current session is live.
        inactive.deactivate();
        orgUnits.saveAndFlush(inactive);

        var projected = data(me(jwt)).path("directoryManagementScope");
        assertThat(projected.path("allUnits").asBoolean()).isFalse();
        assertThat(projected.path("unitIds").size()).isEqualTo(1);
        assertThat(projected.path("unitIds").get(0).asText()).isEqualTo(current.getId().toString());
        // The historical grant row was not deleted by the identity projection.
        assertThat(scopes.existsByIdUserIdAndIdOrgUnitId(manager.getId(),inactive.getId()))
            .isTrue();
        mvc.perform(get("/api/v1/organizational-units")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+jwt))
            .andExpect(status().isOk());
    }

    @Test
    void revokedAndAbsoluteExpiredSessionsAreRejectedEvenWithUnexpiredAccessJwt() throws Exception {
        var user=account(GlobalRole.EMPLOYEE,null);
        var current=admit(user,AuthClientType.MOBILE);
        String token=bearer(current,accessTokens);

        jdbc.update("UPDATE auth_sessions SET status='EXPIRED' WHERE id=?",current.sessionId());
        denied(token);
        var another=admit(user,AuthClientType.MOBILE);
        String next=bearer(another,accessTokens);

        // Alter a test-only session to be past its absolute expiration.
        // A DB-level consistency check may require moving the creation instant too.
        jdbc.update("""
            UPDATE auth_sessions
               SET created_at=clock_timestamp()-INTERVAL '31 days',
                   last_seen_at=clock_timestamp()-INTERVAL '1 minute',
                   absolute_expires_at=clock_timestamp()-INTERVAL '2 days'
             WHERE id=?
            """,another.sessionId());
        denied(next);
    }

    @Test
    void roleChangeAndExplicitSessionRevocationAreAtomicInFutureLifecycleContract() throws Exception {
        var admin=account(GlobalRole.ADMINISTRATOR,null);
        var first=admit(admin,AuthClientType.MOBILE);
        String old=bearer(first,accessTokens);
        assertThat(data(me(old)).path("globalRole").asText()).isEqualTo("ADMINISTRATOR");
        // Demonstrate exactly the auth-owned capability PR #3 T05 must invoke.
        tx().executeWithoutResult(status->{
            var actor=users.findByIdForSessionAdmission(admin.getId()).orElseThrow();
            actor.assignGlobalRole(GlobalRole.EMPLOYEE);
            users.saveAndFlush(actor);
            assertThat(refresh.revokeAllForUser(admin.getId(),"ROLE_CHANGED")).isEqualTo(1);
        });
        denied(old);
        assertThat(sessions.findById(first.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.REVOKED);
        assertThatThrownBy(()->refresh.rotate(first.refreshToken(),AuthClientType.MOBILE))
            .isInstanceOf(ResponseStatusException.class);
        var second=admit(users.findById(admin.getId()).orElseThrow(),AuthClientType.MOBILE);
        assertThat(data(me(bearer(second,accessTokens))).path("globalRole").asText())
            .isEqualTo("EMPLOYEE");
    }

    @Test
    void deactivationAndReactivationNeverRestoreAnOldSessionWithRevocationHook() throws Exception {
        var user=account(GlobalRole.EMPLOYEE,null);
        var first=admit(user,AuthClientType.MOBILE);
        String signed=bearer(first,accessTokens);
        tx().executeWithoutResult(status->{
            var current=users.findByIdForSessionAdmission(user.getId()).orElseThrow();
            org.springframework.test.util.ReflectionTestUtils.setField(current,
                "accountStatus",AccountStatus.INACTIVE);
            users.saveAndFlush(current);
            refresh.revokeAllForUser(user.getId(),"ACCOUNT_DEACTIVATED");
        });
        denied(signed);
        assertThatThrownBy(()->refresh.rotate(first.refreshToken(),AuthClientType.MOBILE))
            .isInstanceOf(ResponseStatusException.class);
        tx().executeWithoutResult(status->{
            var current=users.findByIdForSessionAdmission(user.getId()).orElseThrow();
            org.springframework.test.util.ReflectionTestUtils.setField(current,
                "accountStatus",AccountStatus.ACTIVE);
            users.saveAndFlush(current);
        });
        denied(signed);
        var second=admit(users.findById(user.getId()).orElseThrow(),AuthClientType.MOBILE);
        assertThat(data(me(bearer(second,accessTokens))).path("session").path("id").asText())
            .isEqualTo(second.sessionId().toString());
        assertThat(sessions.findById(first.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.REVOKED);
    }

    @Test
    void scopeChangeWithExplicitRevocationRequiresNewSessionAndNewExactGrants() throws Exception {
        var unitA=orgUnits.saveAndFlush(new OrganizationalUnitEntity(
            "scope-a-"+UUID.randomUUID(),"Scope A",null));
        var unitB=orgUnits.saveAndFlush(new OrganizationalUnitEntity(
            "scope-b-"+UUID.randomUUID(),"Scope B",null));
        var manager=account(GlobalRole.DEPARTMENT_MANAGER,unitA.getId());
        scopes.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(),unitA.getId(),null));
        var first=admit(manager,AuthClientType.WEB);
        String old=bearer(first,accessTokens);
        assertThat(data(me(old)).path("directoryManagementScope").path("unitIds").get(0).asText())
            .isEqualTo(unitA.getId().toString());
        tx().executeWithoutResult(status->{
            scopes.deleteById(new ManagerScopeId(manager.getId(),unitA.getId()));
            scopes.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(),unitB.getId(),null));
            var current=users.findByIdForSessionAdmission(manager.getId()).orElseThrow();
            current.markManagementScopeChanged();
            users.saveAndFlush(current);
            assertThat(refresh.revokeAllForUser(manager.getId(),"SCOPE_CHANGED")).isEqualTo(1);
        });
        denied(old);
        var second=admit(users.findById(manager.getId()).orElseThrow(),AuthClientType.WEB);
        var projection=data(me(bearer(second,accessTokens)))
            .path("directoryManagementScope").path("unitIds");
        assertThat(projection.size()).isEqualTo(1);
        assertThat(projection.get(0).asText()).isEqualTo(unitB.getId().toString());
    }

    @Test
    void logoutAndReplayDestroyIdentityEvenWithUnexpiredSignedJwt() throws Exception {
        var user=account(GlobalRole.EMPLOYEE,null);
        var session=admit(user,AuthClientType.MOBILE);
        String jwt=bearer(session,accessTokens);
        me(jwt);
        refresh.logout(user.getId(),session.sessionId());
        denied(jwt);
        assertThat(sessions.findById(session.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.REVOKED);
    }

    @Test
    void inactiveUserAndInactivityExpirationFailClosedEvenWithoutLifecycleCommand() throws Exception {
        var inactive=account(GlobalRole.EMPLOYEE,null);
        var session=admit(inactive,AuthClientType.MOBILE);
        String token=bearer(session,accessTokens);
        // Direct DB status modification proves live per-request checks, not lifecycle integration.
        jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?",inactive.getId());
        denied(token);
        jdbc.update("UPDATE users SET account_status='ACTIVE' WHERE id=?",inactive.getId());
        jdbc.update("""
            UPDATE auth_sessions SET last_seen_at=clock_timestamp()-INTERVAL '8 days'
             WHERE id=?
            """,session.sessionId());
        denied(token);
    }
}
