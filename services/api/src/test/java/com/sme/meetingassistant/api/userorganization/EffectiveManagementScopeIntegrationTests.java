package com.sme.meetingassistant.api.userorganization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.security.Rs256AccessTokenService;
import com.sme.meetingassistant.api.authentication.service.LoginAdmissionService;
import com.sme.meetingassistant.api.authentication.transport.AuthTransport;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.*;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * F01: exact effective ACTIVE grants must protect every directory read and
 * lifecycle write, not just /auth/me. Uses real RS256 JWT, session admission,
 * Spring HTTP security and PostgreSQL; mutations are committed between calls.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(PostgresTestConfiguration.class)
class EffectiveManagementScopeIntegrationTests {
    private static final String PASSWORD = "A long and safe test passphrase for active scope 🔒";
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired UserRepository users;
    @Autowired OrganizationalUnitRepository units;
    @Autowired ManagerScopeUnitRepository scopes;
    @Autowired AccountSetupPasswordHasher hasher;
    @Autowired LoginAdmissionService logins;
    @Autowired Rs256AccessTokenService accessTokens;

    private UserEntity admin;
    private UserEntity manager;
    private UserEntity activeEmployee;
    private UserEntity retiredEmployee;
    private OrganizationalUnitEntity current;
    private OrganizationalUnitEntity retired;

    @BeforeEach void fixtures() {
        current = units.saveAndFlush(new OrganizationalUnitEntity(
            "SCOPE-CURRENT-"+UUID.randomUUID(), "Current Unit", null));
        retired = units.saveAndFlush(new OrganizationalUnitEntity(
            "SCOPE-RETIRED-"+UUID.randomUUID(), "Retired Unit", null));
        admin = user(GlobalRole.ADMINISTRATOR, null);
        manager = user(GlobalRole.DEPARTMENT_MANAGER, current.getId());
        activeEmployee = user(GlobalRole.EMPLOYEE, current.getId());
        retiredEmployee = user(GlobalRole.EMPLOYEE, retired.getId());
        scopes.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(),current.getId(),admin.getId()));
        scopes.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(),retired.getId(),admin.getId()));
    }

    private UserEntity user(GlobalRole role, UUID org) {
        var created = new UserEntity("f01-"+UUID.randomUUID()+"@example.com",
            "Scope Test",role,org);
        created.completeInitialSetup(hasher.hash(PASSWORD),OffsetDateTime.now(ZoneOffset.UTC));
        return users.saveAndFlush(created);
    }

    private String jwt(UserEntity user) {
        var session = logins.authenticateAndAdmit(user.getEmail(),PASSWORD,AuthClientType.MOBILE);
        return accessTokens.issue(session.userId(),session.sessionId());
    }

    private void deactivateUnit() {
        retired.deactivate();
        units.saveAndFlush(retired);
    }

    private JsonNode data(MvcResult r) throws Exception {
        return json.readTree(r.getResponse().getContentAsString()).path("data");
    }

    @Test void deactivatedGrantIsRemovedImmediatelyFromAuthMeUserListAndPagination()
            throws Exception {
        String managerJwt = jwt(manager); // session exists BEFORE unit is deactivated
        String adminJwt = jwt(admin);
        deactivateUnit();

        var identity = mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt))
            .andExpect(status().isOk()).andReturn();
        JsonNode effective = data(identity).path("directoryManagementScope");
        assertThat(effective.path("allUnits").asBoolean()).isFalse();
        assertThat(effective.path("unitIds")).hasSize(1);
        assertThat(effective.path("unitIds").get(0).asText())
            .isEqualTo(current.getId().toString());

        var list = mvc.perform(get("/api/v1/users")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt)
            .param("size","1").param("page","0"))
            .andExpect(status().isOk()).andReturn();
        JsonNode response = json.readTree(list.getResponse().getContentAsString());
        assertThat(response.path("data")).hasSize(1);
        assertThat(response.path("data").get(0).path("id").asText())
            .isEqualTo(activeEmployee.getId().toString());
        assertThat(response.path("meta").path("pagination").path("totalElements").asLong())
            .isEqualTo(1);
        assertThat(response.toString()).doesNotContain(retiredEmployee.getId().toString());
        mvc.perform(get("/api/v1/users").header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt)
            .param("page","1").param("size","1"))
            .andExpect(status().isOk())
            .andExpect(result -> assertThat(
                json.readTree(result.getResponse().getContentAsString())
                    .path("data").size()).isZero());

        var filtered = mvc.perform(get("/api/v1/users")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt)
            .param("orgUnitId",retired.getId().toString()))
            .andExpect(status().isOk()).andReturn();
        JsonNode filteredBody = json.readTree(filtered.getResponse().getContentAsString());
        assertThat(filteredBody.path("data")).hasSize(0);
        assertThat(filteredBody.path("meta").path("pagination").path("totalElements").asLong())
            .isZero();

        mvc.perform(get("/api/v1/users/"+retiredEmployee.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt))
            .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/users/"+retiredEmployee.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+adminJwt))
            .andExpect(status().isOk());

        var orgs = mvc.perform(get("/api/v1/organizational-units")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt))
            .andExpect(status().isOk()).andReturn();
        assertThat(data(orgs).toString()).contains(current.getId().toString())
            .doesNotContain(retired.getId().toString());
        assertThat(scopes.existsByIdUserIdAndIdOrgUnitId(manager.getId(),retired.getId()))
            .isTrue(); // historical scope attribution preserved
    }

    @Test void staleGrantCannotAuthorizePatchDeactivateCreateOrMoveToInactiveUnit()
            throws Exception {
        String managerJwt = jwt(manager);
        String adminJwt = jwt(admin);
        String oldName = retiredEmployee.getDisplayName();
        deactivateUnit();

        var adminDetail = mvc.perform(get("/api/v1/users/"+retiredEmployee.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+adminJwt))
            .andExpect(status().isOk()).andReturn();
        String etag = adminDetail.getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(patch("/api/v1/users/"+retiredEmployee.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt)
            .header(AuthTransport.PLATFORM,"mobile")
            .header(HttpHeaders.IF_MATCH,etag)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("displayName","UNAUTHORIZED CHANGE"))))
            .andExpect(status().isNotFound());
        mvc.perform(post("/api/v1/users/"+retiredEmployee.getId()+"/deactivate")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt)
            .header(AuthTransport.PLATFORM,"mobile")
            .header(HttpHeaders.IF_MATCH,etag))
            .andExpect(status().isNotFound());

        // Even an in-scope employee may not be moved to an inactive granted unit.
        var activeDetail = mvc.perform(get("/api/v1/users/"+activeEmployee.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt))
            .andExpect(status().isOk()).andReturn();
        mvc.perform(patch("/api/v1/users/"+activeEmployee.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt)
            .header(AuthTransport.PLATFORM,"mobile")
            .header(HttpHeaders.IF_MATCH,activeDetail.getResponse().getHeader(HttpHeaders.ETAG))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(
                Map.of("primaryOrgUnitId",retired.getId().toString()))))
            .andExpect(status().isForbidden());

        mvc.perform(post("/api/v1/users")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt)
            .header(AuthTransport.PLATFORM,"mobile")
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of(
                "email","f01-create-"+UUID.randomUUID()+"@example.com",
                "displayName","Not Allowed",
                "primaryOrgUnitId",retired.getId().toString()))))
            .andExpect(status().isForbidden());

        assertThat(users.findById(retiredEmployee.getId()).orElseThrow().getDisplayName())
            .isEqualTo(oldName);
        assertThat(users.findById(retiredEmployee.getId()).orElseThrow().getAccountStatus())
            .isEqualTo(AccountStatus.ACTIVE);
        assertThat(users.findById(activeEmployee.getId()).orElseThrow().getPrimaryOrgUnitId())
            .isEqualTo(current.getId());
        // The same JWT still retains authority over the other ACTIVE unit.
        mvc.perform(get("/api/v1/users/"+activeEmployee.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+managerJwt))
            .andExpect(status().isOk());
    }

    @Test void managerWithOnlyRetiredGrantsGetsEmptyScopedDirectoryNotFallbackAccess()
            throws Exception {
        scopes.deleteById(new ManagerScopeId(manager.getId(),current.getId()));
        scopes.flush();
        String token = jwt(manager);
        deactivateUnit();
        var scope = data(mvc.perform(get("/api/v1/auth/me")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+token))
            .andExpect(status().isOk()).andReturn()).path("directoryManagementScope");
        assertThat(scope.path("allUnits").asBoolean()).isFalse();
        assertThat(scope.path("unitIds")).hasSize(0);

        var list = mvc.perform(get("/api/v1/users")
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+token))
            .andExpect(status().isOk()).andReturn();
        JsonNode response = json.readTree(list.getResponse().getContentAsString());
        assertThat(response.path("data")).hasSize(0);
        assertThat(response.path("meta").path("pagination").path("totalElements").asLong())
            .isZero();
        mvc.perform(get("/api/v1/users/"+retiredEmployee.getId())
            .header(HttpHeaders.AUTHORIZATION,"Bearer "+token))
            .andExpect(status().isNotFound());
        assertThat(scopes.existsByIdUserIdAndIdOrgUnitId(manager.getId(),retired.getId()))
            .isTrue();
    }
}
