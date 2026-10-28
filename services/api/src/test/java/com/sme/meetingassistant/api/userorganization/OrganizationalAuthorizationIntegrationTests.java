package com.sme.meetingassistant.api.userorganization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.*;
import com.sme.meetingassistant.api.userorganization.service.*;
import java.security.Principal;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Full MVC + authorization + real PostgreSQL persistence; principal is server-supplied in tests. */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import({PostgresTestConfiguration.class, OrganizationalAuthorizationIntegrationTests.AuthorizationTestController.class})
@Transactional
class OrganizationalAuthorizationIntegrationTests {
    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper json;
    @Autowired private UserRepository users;
    @Autowired private OrganizationalUnitRepository units;
    @Autowired private ManagerScopeUnitRepository grants;
    @Autowired private OrganizationalAuthorizationService auth;
    @Autowired private ManagerScopeAssignmentService assignments;

    private OrganizationalUnitEntity parent;
    private OrganizationalUnitEntity child;
    private OrganizationalUnitEntity unrelated;
    private UserEntity employee;
    private UserEntity manager;
    private UserEntity admin;

    @BeforeEach
    void fixtures() {
        parent = units.saveAndFlush(new OrganizationalUnitEntity("P-" + UUID.randomUUID(), "Parent", null));
        child = units.saveAndFlush(new OrganizationalUnitEntity("C-" + UUID.randomUUID(), "Child", parent.getId()));
        unrelated = units.saveAndFlush(new OrganizationalUnitEntity("U-" + UUID.randomUUID(), "Unrelated", null));
        employee = activeUser("employee", GlobalRole.EMPLOYEE);
        manager = activeUser("manager", GlobalRole.DEPARTMENT_MANAGER);
        admin = activeUser("administrator", GlobalRole.ADMINISTRATOR);
        grants.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(), child.getId(), admin.getId()));
    }

    private UserEntity activeUser(String prefix, GlobalRole role) {
        UserEntity user = users.saveAndFlush(new UserEntity(
            prefix + "-" + UUID.randomUUID() + "@example.com", prefix, role, null));
        // T04 owns the account-setup transition; fixture uses the canonical persisted ACTIVE state.
        org.springframework.test.util.ReflectionTestUtils.setField(user, "passwordHash", "test-verifier");
        org.springframework.test.util.ReflectionTestUtils.setField(user, "accountStatus", AccountStatus.ACTIVE);
        return users.saveAndFlush(user);
    }

    private static Principal principal(UUID id) { return () -> id.toString(); }

    @Test
    void anonymousAndSpoofedHeadersNeverProvideAuthenticatedIdentity() throws Exception {
        mvc.perform(get("/api/v1/organizational-units")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/organizational-units")
            .header("X-User-Id", admin.getId().toString())
            .header("X-Role", "ADMINISTRATOR"))
            .andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/organizational-units")
            .principal(() -> "not-a-uuid"))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void pendingInactiveAndUnknownPrincipalsAreRejected() throws Exception {
        UserEntity pending = users.saveAndFlush(new UserEntity(
            "pending-" + UUID.randomUUID() + "@example.com", "Pending", GlobalRole.ADMINISTRATOR, null));
        UserEntity inactive = activeUser("inactive", GlobalRole.ADMINISTRATOR);
        org.springframework.test.util.ReflectionTestUtils.setField(inactive, "accountStatus", AccountStatus.INACTIVE);
        users.saveAndFlush(inactive);
        for (UUID id : Set.of(pending.getId(), inactive.getId(), UUID.randomUUID())) {
            mvc.perform(get("/api/v1/organizational-units").principal(principal(id)))
                .andExpect(status().isUnauthorized());
        }
    }

    @Test
    void employeeCannotEnumerateOrganizationOrManageAnyUnit() throws Exception {
        mvc.perform(get("/api/v1/organizational-units").principal(principal(employee.getId())))
            .andExpect(status().isForbidden());
        mvc.perform(get("/api/v1/test/org-access/" + child.getId()).principal(principal(employee.getId())))
            .andExpect(status().isForbidden());
    }

    @Test
    void managerListingUsesOnlyExactActiveGrantsBeforePagination() throws Exception {
        MvcResult result = mvc.perform(get("/api/v1/organizational-units")
            .principal(principal(manager.getId())).param("page", "0").param("size", "1"))
            .andExpect(status().isOk()).andReturn();
        JsonNode body = json.readTree(result.getResponse().getContentAsString());
        assertThat(body.path("success").asBoolean()).isTrue();
        assertThat(body.path("data")).hasSize(1);
        assertThat(body.path("data").get(0).path("id").asText()).isEqualTo(child.getId().toString());
        assertThat(body.path("meta").path("pagination").path("totalElements").asLong()).isEqualTo(1);
        assertThat(body.path("meta").path("pagination").path("hasNext").asBoolean()).isFalse();
    }

    @Test
    void parentHierarchyDoesNotImplicitlyGrantParentOrSibling() throws Exception {
        MvcResult result = mvc.perform(get("/api/v1/organizational-units")
            .principal(principal(manager.getId()))).andExpect(status().isOk()).andReturn();
        String body = result.getResponse().getContentAsString();
        assertThat(body).contains(child.getId().toString());
        JsonNode data = json.readTree(body).path("data");
        assertThat(data).hasSize(1);
        assertThat(data.get(0).path("id").asText()).isEqualTo(child.getId().toString());
    }

    @Test
    void managerWithoutGrantsHasAnEmptyScopedDirectory() throws Exception {
        UserEntity emptyManager = activeUser("empty", GlobalRole.DEPARTMENT_MANAGER);
        MvcResult result = mvc.perform(get("/api/v1/organizational-units")
            .principal(principal(emptyManager.getId()))).andExpect(status().isOk()).andReturn();
        JsonNode body = json.readTree(result.getResponse().getContentAsString());
        assertThat(body.path("data")).hasSize(0);
        assertThat(body.path("meta").path("pagination").path("totalElements").asLong()).isZero();
    }

    @Test
    void adminListsAllActiveUnitsButNeverInactiveOnes() throws Exception {
        OrganizationalUnitEntity inactive = units.saveAndFlush(new OrganizationalUnitEntity("I-" + UUID.randomUUID(), "Inactive", null));
        inactive.deactivate();
        units.saveAndFlush(inactive);
        MvcResult result = mvc.perform(get("/api/v1/organizational-units")
            .principal(principal(admin.getId())).param("size", "100"))
            .andExpect(status().isOk()).andReturn();
        String body = result.getResponse().getContentAsString();
        assertThat(body).contains(parent.getId().toString(), child.getId().toString(), unrelated.getId().toString());
        assertThat(body).doesNotContain(inactive.getId().toString());
    }

    @Test
    void pagingRejectsNegativeAndOversizedValuesAndMethodIsReadOnly() throws Exception {
        mvc.perform(get("/api/v1/organizational-units")
            .principal(principal(admin.getId())).param("page", "-1"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/v1/organizational-units")
            .principal(principal(admin.getId())).param("size", "101"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(
            "/api/v1/organizational-units").principal(principal(admin.getId())))
            .andExpect(status().isMethodNotAllowed());
    }

    @Test
    void replacingManagerScopesRequiresAdministratorAndUsesExactGrants() throws Exception {
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(
            "/api/v1/test/org-grants/" + manager.getId() + "/" + parent.getId())
            .principal(principal(manager.getId()))).andExpect(status().isForbidden());
        assertThat(grants.existsByIdUserIdAndIdOrgUnitId(manager.getId(), child.getId())).isTrue();
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(
            "/api/v1/test/org-grants/" + manager.getId() + "/" + parent.getId())
            .principal(principal(admin.getId()))).andExpect(status().isOk());
        assertThat(grants.existsByIdUserIdAndIdOrgUnitId(manager.getId(), parent.getId())).isTrue();
        assertThat(grants.existsByIdUserIdAndIdOrgUnitId(manager.getId(), child.getId())).isFalse();
    }

    @Test
    void managerCannotEscalateScopeByClaimingAnUnrelatedUnitId() {
        // Scope is deliberately exact, not derived from a parent's tree position.
        var approved = grants.findByIdUserId(manager.getId()).stream()
            .map(scope -> scope.getId().getOrgUnitId()).collect(java.util.stream.Collectors.toSet());
        assertThat(approved).containsExactly(child.getId());
        assertThat(approved).doesNotContain(parent.getId(), unrelated.getId());
    }

    @org.springframework.web.bind.annotation.RestController
    static class AuthorizationTestController {
        private final OrganizationalAuthorizationService authorization;
        private final ManagerScopeAssignmentService assignments;
        AuthorizationTestController(OrganizationalAuthorizationService authorization,
                ManagerScopeAssignmentService assignments) {
            this.authorization = authorization;
            this.assignments = assignments;
        }
        @org.springframework.web.bind.annotation.GetMapping("/api/v1/test/org-access/{unitId}")
        String access(@org.springframework.web.bind.annotation.PathVariable UUID unitId) {
            authorization.requireManagementOfActiveUnit(unitId);
            return "authorized";
        }
        @org.springframework.web.bind.annotation.PostMapping("/api/v1/test/org-grants/{managerId}/{unitId}")
        String grant(@org.springframework.web.bind.annotation.PathVariable UUID managerId,
                     @org.springframework.web.bind.annotation.PathVariable UUID unitId) {
            assignments.replaceManagerScopes(managerId, Set.of(unitId));
            return "updated";
        }
    }
}
