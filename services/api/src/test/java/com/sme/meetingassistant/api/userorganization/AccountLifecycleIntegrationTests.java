package com.sme.meetingassistant.api.userorganization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.security.Rs256AccessTokenService;
import com.sme.meetingassistant.api.authentication.service.LoginAdmissionService;
import com.sme.meetingassistant.api.authentication.service.RefreshSessionService;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.*;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import com.sme.meetingassistant.api.authentication.transport.AuthTransport;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.*;
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
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

/** Real HTTP authorization and PostgreSQL transactions, not mock user mutation hooks. */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(PostgresTestConfiguration.class)
class AccountLifecycleIntegrationTests {
    private static final String PASSWORD="A sufficiently long Unicode password for lifecycle 🔒 2026";
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired UserRepository users;
    @Autowired OrganizationalUnitRepository units;
    @Autowired ManagerScopeUnitRepository grants;
    @Autowired AccountSetupPasswordHasher passwords;
    @Autowired LoginAdmissionService logins;
    @Autowired Rs256AccessTokenService jwt;
    @Autowired AuthSessionRepository sessions;
    @Autowired RefreshSessionService refresh;
    @Autowired JdbcTemplate jdbc;
    private UserEntity admin, manager, employee, outsider;
    private OrganizationalUnitEntity finance, engineering;

    @BeforeEach void fixtures() {
        finance=units.saveAndFlush(new OrganizationalUnitEntity(
            "FIN-"+UUID.randomUUID(),"Finance",null));
        engineering=units.saveAndFlush(new OrganizationalUnitEntity(
            "ENG-"+UUID.randomUUID(),"Engineering",null));
        admin=active(GlobalRole.ADMINISTRATOR,null);
        manager=active(GlobalRole.DEPARTMENT_MANAGER,finance.getId());
        employee=active(GlobalRole.EMPLOYEE,finance.getId());
        outsider=active(GlobalRole.EMPLOYEE,engineering.getId());
        grants.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(),finance.getId(),admin.getId()));
    }

    private UserEntity active(GlobalRole role,UUID orgId) {
        var user=new UserEntity("lifecycle-"+UUID.randomUUID()+"@example.com",
            "Lifecycle",role,orgId);
        user.completeInitialSetup(passwords.hash(PASSWORD),OffsetDateTime.now(ZoneOffset.UTC));
        return users.saveAndFlush(user);
    }

    private record Login(String access,String refresh,UUID sessionId) {}
    private Login login(UserEntity actor) {
        var admitted=logins.authenticateAndAdmit(actor.getEmail(),PASSWORD,AuthClientType.MOBILE);
        return new Login(jwt.issue(actor.getId(),admitted.sessionId()),
            admitted.refreshToken(),admitted.sessionId());
    }

    private MvcResult detail(String access,UUID id,int expected) throws Exception {
        return mvc.perform(get("/api/v1/users/"+id)
                .header(HttpHeaders.AUTHORIZATION,"Bearer "+access))
            .andExpect(status().is(expected)).andReturn();
    }
    private String tag(String access, UUID id) throws Exception {
        return detail(access,id,200).getResponse().getHeader(HttpHeaders.ETAG);
    }
    private MvcResult command(String access,UUID id,String kind,String etag,int expected)
            throws Exception {
        var request=post("/api/v1/users/"+id+"/"+kind)
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+access)
            .header(AuthTransport.PLATFORM,"mobile");
        if(etag!=null)request.header(HttpHeaders.IF_MATCH,etag);
        return mvc.perform(request).andExpect(status().is(expected)).andReturn();
    }
    private MvcResult change(String access,UUID id,String etag,Object values,int expected)
            throws Exception {
        return mvc.perform(patch("/api/v1/users/"+id)
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+access)
            .header(AuthTransport.PLATFORM,"mobile")
            .header(HttpHeaders.IF_MATCH,etag)
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(values)))
            .andExpect(status().is(expected)).andReturn();
    }
    private long activeSessions(UserEntity target) {
        return sessions.countByUserIdAndStatus(target.getId(),AuthSessionStatus.ACTIVE);
    }
    private long audit(UUID target,String event) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE entity_id=? AND action_code=?
            """,Long.class,target,event);
    }

    @Test void deactivateRevokesEveryDeviceAndPreservesIdentityAndHistoricalReferences()
            throws Exception {
        Login administrator=login(admin);
        Login first=login(employee);
        Login second=login(employee);
        String oldTag=tag(administrator.access(),employee.getId());
        var result=command(administrator.access(),employee.getId(),"deactivate",oldTag,200);
        assertThat(result.getResponse().getHeader(HttpHeaders.ETAG)).isNotEqualTo(oldTag);
        var now=users.findById(employee.getId()).orElseThrow();
        assertThat(now.getAccountStatus()).isEqualTo(AccountStatus.INACTIVE);
        assertThat(now.getDeactivatedAt()).isNotNull();
        assertThat(now.getPrimaryOrgUnitId()).isEqualTo(finance.getId());
        assertThat(now.getEmail()).isEqualTo(employee.getEmail());
        assertThat(activeSessions(employee)).isZero();
        assertThat(sessions.findById(first.sessionId()).orElseThrow().getRevokeReason())
            .isEqualTo("ACCOUNT_DEACTIVATED");
        assertThat(sessions.findById(second.sessionId()).orElseThrow().getRevokeReason())
            .isEqualTo("ACCOUNT_DEACTIVATED");
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+first.access()))
            .andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+second.access()))
            .andExpect(status().isUnauthorized());
        assertThatThrownBy(()->refresh.rotate(first.refresh(),AuthClientType.MOBILE))
            .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(()->logins.authenticateAndAdmit(employee.getEmail(),
            PASSWORD,AuthClientType.MOBILE))
            .isInstanceOf(ResponseStatusException.class);
        assertThat(audit(employee.getId(),"ACCOUNT_DEACTIVATED")).isEqualTo(1);
    }

    @Test void reactivationRequiresFreshSessionAndCannotResurrectPreviouslyRevokedTokens()
            throws Exception {
        Login administrator=login(admin);
        Login previous=login(employee);
        String etag=tag(administrator.access(),employee.getId());
        var inactive=command(administrator.access(),employee.getId(),"deactivate",etag,200);
        String inactiveTag=inactive.getResponse().getHeader(HttpHeaders.ETAG);
        var restored=command(administrator.access(),employee.getId(),"reactivate",inactiveTag,200);
        assertThat(restored.getResponse().getHeader(HttpHeaders.ETAG)).isNotEqualTo(inactiveTag);
        assertThat(users.findById(employee.getId()).orElseThrow().getAccountStatus())
            .isEqualTo(AccountStatus.ACTIVE);
        assertThat(users.findById(employee.getId()).orElseThrow().getDeactivatedAt()).isNull();
        assertThat(activeSessions(employee)).isZero();
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+previous.access()))
            .andExpect(status().isUnauthorized());
        assertThatThrownBy(()->refresh.rotate(previous.refresh(),AuthClientType.MOBILE))
            .isInstanceOf(ResponseStatusException.class);
        Login fresh=login(employee);
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+fresh.access()))
            .andExpect(status().isOk());
        assertThat(audit(employee.getId(),"ACCOUNT_REACTIVATED")).isEqualTo(1);
    }

    @Test void lifecycleCommandsEnforceScopeAndStateAndOpaqueVersionPreconditions()
            throws Exception {
        Login administrator=login(admin);
        Login limited=login(manager);
        String tag=tag(administrator.access(),employee.getId());
        command(administrator.access(),employee.getId(),"deactivate",null,428);
        command(administrator.access(),employee.getId(),"deactivate","\"stale\"",412);
        command(limited.access(),outsider.getId(),"deactivate",tag,404);
        command(limited.access(),admin.getId(),"deactivate",tag,404);
        command(administrator.access(),admin.getId(),"deactivate",
            tag(administrator.access(),admin.getId()),409);
        command(administrator.access(),employee.getId(),"reactivate",tag,409);
        command(limited.access(),employee.getId(),"deactivate",tag,200);
        command(administrator.access(),employee.getId(),"deactivate",tag,412);
        assertThat(activeSessions(employee)).isZero();
    }

    @Test void roleChangeRevokesExistingSessionButDisplayNameEditDoesNot()
            throws Exception {
        Login administrator=login(admin);
        Login before=login(employee);
        String etag=tag(administrator.access(),employee.getId());
        var name=change(administrator.access(),employee.getId(),etag,
            Map.of("displayName","Renamed Without Privilege Changes"),200);
        assertThat(activeSessions(employee)).isEqualTo(1);
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+before.access()))
            .andExpect(status().isOk());
        var newTag=name.getResponse().getHeader(HttpHeaders.ETAG);
        change(administrator.access(),employee.getId(),newTag,
            Map.of("globalRole","DEPARTMENT_MANAGER",
                "managerScopeUnitIds",Set.of(finance.getId())),200);
        assertThat(activeSessions(employee)).isZero();
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+before.access()))
            .andExpect(status().isUnauthorized());
        assertThatThrownBy(()->refresh.rotate(before.refresh(),AuthClientType.MOBILE))
            .isInstanceOf(ResponseStatusException.class);
        assertThat(users.findById(employee.getId()).orElseThrow().getGlobalRole())
            .isEqualTo(GlobalRole.DEPARTMENT_MANAGER);
        assertThat(audit(employee.getId(),"ROLE_CHANGED")).isEqualTo(1);
        Login newLogin=login(employee);
        var next=mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+newLogin.access()))
            .andExpect(status().isOk()).andReturn();
        assertThat(next.getResponse().getContentAsString()).contains("DEPARTMENT_MANAGER");
    }

    @Test void managerGrantChangesAndPrimaryUnitMovesRevokeSessions() throws Exception {
        Login administrator=login(admin);
        Login managerLogin=login(manager);
        String managerTag=tag(administrator.access(),manager.getId());
        change(administrator.access(),manager.getId(),managerTag,
            Map.of("managerScopeUnitIds",Set.of(engineering.getId())),200);
        assertThat(activeSessions(manager)).isZero();
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerLogin.access()))
            .andExpect(status().isUnauthorized());
        assertThat(audit(manager.getId(),"SCOPE_CHANGED")).isEqualTo(1);
        assertThat(grants.existsByIdUserIdAndIdOrgUnitId(manager.getId(),finance.getId()))
            .isFalse();
        assertThat(grants.existsByIdUserIdAndIdOrgUnitId(manager.getId(),engineering.getId()))
            .isTrue();

        Login worker=login(employee);
        String workerTag=tag(administrator.access(),employee.getId());
        change(administrator.access(),employee.getId(),workerTag,
            Map.of("primaryOrgUnitId",engineering.getId()),200);
        assertThat(activeSessions(employee)).isZero();
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+worker.access()))
            .andExpect(status().isUnauthorized());
        assertThat(audit(employee.getId(),"SCOPE_CHANGED")).isEqualTo(1);
    }

    @Test void roleDemotionClearsScopesAndRevokesEveryExistingSession()
            throws Exception {
        Login administrator=login(admin);
        Login existing=login(manager);
        String etag=tag(administrator.access(),manager.getId());
        change(administrator.access(),manager.getId(),etag,
            Map.of("globalRole","EMPLOYEE"),200);
        assertThat(grants.findByIdUserId(manager.getId())).isEmpty();
        assertThat(activeSessions(manager)).isZero();
        mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+existing.access()))
            .andExpect(status().isUnauthorized());
        Login newSession=login(manager);
        mvc.perform(get("/api/v1/users")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+newSession.access()))
            .andExpect(status().isForbidden());
    }

    @Test void concurrentAdmissionCannotLeaveActiveSessionAfterDeactivation()
            throws Exception {
        Login administrator=login(admin);
        String etag=tag(administrator.access(),employee.getId());
        var pool=Executors.newFixedThreadPool(2);
        var ready=new CountDownLatch(2);
        var start=new CountDownLatch(1);
        try {
            var admission=pool.submit(()->{
                ready.countDown();
                if(!start.await(20,TimeUnit.SECONDS))throw new IllegalStateException("timeout");
                try {
                    return logins.authenticateAndAdmit(employee.getEmail(),PASSWORD,AuthClientType.MOBILE);
                } catch(ResponseStatusException rejected) {
                    return null;
                }
            });
            var disable=pool.submit(()->{
                ready.countDown();
                if(!start.await(20,TimeUnit.SECONDS))throw new IllegalStateException("timeout");
                return command(administrator.access(),employee.getId(),"deactivate",etag,200);
            });
            assertThat(ready.await(20,TimeUnit.SECONDS)).isTrue();
            start.countDown();
            admission.get(60,TimeUnit.SECONDS);
            disable.get(60,TimeUnit.SECONDS);
            assertThat(users.findById(employee.getId()).orElseThrow().getAccountStatus())
                .isEqualTo(AccountStatus.INACTIVE);
            assertThat(activeSessions(employee)).isZero();
        } finally {
            start.countDown();
            pool.shutdownNow();
            assertThat(pool.awaitTermination(20,TimeUnit.SECONDS)).isTrue();
        }
    }
}
