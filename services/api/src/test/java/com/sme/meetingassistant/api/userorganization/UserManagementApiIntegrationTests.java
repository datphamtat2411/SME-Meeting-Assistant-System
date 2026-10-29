package com.sme.meetingassistant.api.userorganization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.*;
import java.security.Principal;
import java.util.Map;
import java.util.Set;
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
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@Transactional
class UserManagementApiIntegrationTests {
    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper mapper;
    @Autowired private UserRepository users;
    @Autowired private OrganizationalUnitRepository units;
    @Autowired private ManagerScopeUnitRepository grants;

    private UserEntity admin;
    private UserEntity manager;
    private UserEntity employee;
    private UserEntity outsider;
    private OrganizationalUnitEntity finance;
    private OrganizationalUnitEntity engineering;

    @BeforeEach
    void setup() {
        finance = units.saveAndFlush(new OrganizationalUnitEntity("FIN-" + UUID.randomUUID(), "Finance", null));
        engineering = units.saveAndFlush(new OrganizationalUnitEntity("ENG-" + UUID.randomUUID(), "Engineering", null));
        admin = active("admin", GlobalRole.ADMINISTRATOR, null);
        manager = active("manager", GlobalRole.DEPARTMENT_MANAGER, finance.getId());
        employee = active("employee", GlobalRole.EMPLOYEE, finance.getId());
        outsider = active("outside", GlobalRole.EMPLOYEE, engineering.getId());
        grants.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(), finance.getId(), admin.getId()));
    }

    private UserEntity active(String prefix, GlobalRole role, UUID unitId) {
        UserEntity user = new UserEntity(prefix + UUID.randomUUID() + "@example.com", prefix, role, unitId);
        ReflectionTestUtils.setField(user, "passwordHash", "fixture-not-a-production-password");
        ReflectionTestUtils.setField(user, "accountStatus", AccountStatus.ACTIVE);
        return users.saveAndFlush(user);
    }

    private static Principal principal(UserEntity user) { return () -> user.getId().toString(); }

    private String json(Object value) throws Exception { return mapper.writeValueAsString(value); }

    private JsonNode body(MvcResult response) throws Exception { return mapper.readTree(response.getResponse().getContentAsString()); }

    private MvcResult detail(UserEntity actor, UUID target) throws Exception {
        return mvc.perform(get("/api/v1/users/" + target).principal(principal(actor)))
            .andExpect(status().isOk()).andReturn();
    }

    @Test
    void anonymousAndEmployeeAreDeniedManagedDirectoryButEmployeeCanReadOwnProfile() throws Exception {
        mvc.perform(get("/api/v1/users")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/users").principal(principal(employee))).andExpect(status().isForbidden());
        mvc.perform(get("/api/v1/users/" + employee.getId()).principal(principal(employee)))
            .andExpect(status().isForbidden());
        MvcResult profile = mvc.perform(get("/api/v1/me/profile").principal(principal(employee)))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(profile).path("data").path("id").asText()).isEqualTo(employee.getId().toString());
    }

    @Test
    void managerSeesOnlyEmployeesFromExplicitlyGrantedUnitWithScopedTotal() throws Exception {
        MvcResult response = mvc.perform(get("/api/v1/users").principal(principal(manager))
            .param("page", "0").param("size", "1"))
            .andExpect(status().isOk()).andReturn();
        JsonNode result = body(response);
        assertThat(result.path("data")).hasSize(1);
        assertThat(result.path("data").get(0).path("id").asText()).isEqualTo(employee.getId().toString());
        assertThat(result.path("meta").path("pagination").path("totalElements").asLong()).isEqualTo(1L);
        mvc.perform(get("/api/v1/users/" + outsider.getId()).principal(principal(manager)))
            .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/users/" + admin.getId()).principal(principal(manager)))
            .andExpect(status().isNotFound());
    }

    @Test
    void administratorDirectorySupportsIdentityAndStatusFilters() throws Exception {
        MvcResult found = mvc.perform(get("/api/v1/users").principal(principal(admin))
            .param("q", "outsIDE").param("role", "EMPLOYEE").param("status", "ACTIVE")
            .param("orgUnitId", engineering.getId().toString()))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(found).path("data")).hasSize(1);
        assertThat(body(found).path("data").get(0).path("id").asText())
            .isEqualTo(outsider.getId().toString());
        MvcResult none = mvc.perform(get("/api/v1/users").principal(principal(admin))
            .param("q", "no-match-" + UUID.randomUUID()))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(none).path("meta").path("pagination").path("totalElements").asLong()).isZero();
    }

    @Test
    void creatingUserProvisionsOnlyPendingAccountAndDoesNotExposePasswordHash() throws Exception {
        String email = "Created-" + UUID.randomUUID() + "@Example.COM";
        MvcResult result = mvc.perform(post("/api/v1/users").principal(principal(admin))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("email", email, "displayName", "New Employee",
                "globalRole", "EMPLOYEE", "primaryOrgUnitId", finance.getId()))))
            .andExpect(status().isCreated()).andReturn();

        JsonNode data = body(result).path("data");
        UUID id = UUID.fromString(data.path("id").asText());
        UserEntity created = users.findById(id).orElseThrow();
        assertThat(created.getEmailNormalized()).isEqualTo(email.toLowerCase(java.util.Locale.ROOT));
        assertThat(created.getAccountStatus()).isEqualTo(AccountStatus.PENDING_SETUP);
        assertThat(created.getPasswordHash()).isNull();
        assertThat(result.getResponse().getHeader(HttpHeaders.LOCATION)).isEqualTo("/api/v1/users/" + id);
        assertThat(result.getResponse().getHeader(HttpHeaders.ETAG)).isNotBlank();
        assertThat(result.getResponse().getContentAsString())
            .doesNotContain("passwordHash", "password_hash", "credentialChangedAt", "lastLoginAt");
    }

    @Test
    void duplicateEmailIgnoringCaseReturnsConflict() throws Exception {
        mvc.perform(post("/api/v1/users").principal(principal(admin))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("email", employee.getEmail().toUpperCase(java.util.Locale.ROOT),
                "displayName", "Duplicate", "globalRole", "EMPLOYEE"))))
            .andExpect(status().isConflict());
    }

    @Test
    void managerCanCreateEmployeeInScopeButCannotCreateAdminOrOutsideScope() throws Exception {
        mvc.perform(post("/api/v1/users").principal(principal(manager))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("email", "allowed-" + UUID.randomUUID() + "@example.com",
                "displayName", "Allowed", "primaryOrgUnitId", finance.getId()))))
            .andExpect(status().isCreated());
        mvc.perform(post("/api/v1/users").principal(principal(manager))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("email", "denied-" + UUID.randomUUID() + "@example.com",
                "displayName", "Denied", "primaryOrgUnitId", finance.getId(),
                "globalRole", "ADMINISTRATOR"))))
            .andExpect(status().isForbidden());
        mvc.perform(post("/api/v1/users").principal(principal(manager))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("email", "outside-" + UUID.randomUUID() + "@example.com",
                "displayName", "Outside", "primaryOrgUnitId", engineering.getId()))))
            .andExpect(status().isForbidden());
    }

    @Test
    void managerCannotEscalateExistingEmployeeRoleOrMoveOutsideGrant() throws Exception {
        String tag = detail(manager, employee.getId()).getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(patch("/api/v1/users/" + employee.getId()).principal(principal(manager))
            .header(HttpHeaders.IF_MATCH, tag).contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("globalRole", "ADMINISTRATOR"))))
            .andExpect(status().isForbidden());
        mvc.perform(patch("/api/v1/users/" + employee.getId()).principal(principal(manager))
            .header(HttpHeaders.IF_MATCH, tag).contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("primaryOrgUnitId", engineering.getId()))))
            .andExpect(status().isForbidden());
        assertThat(users.findById(employee.getId()).orElseThrow().getGlobalRole())
            .isEqualTo(GlobalRole.EMPLOYEE);
    }

    @Test
    void conditionalUpdateRejectsMissingOrStaleVersionWithoutLostWrites() throws Exception {
        String oldTag = detail(admin, employee.getId()).getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(patch("/api/v1/users/" + employee.getId()).principal(principal(admin))
            .contentType(MediaType.APPLICATION_JSON).content(json(Map.of("displayName", "Without Tag"))))
            .andExpect(status().is(428));

        MvcResult changed = mvc.perform(patch("/api/v1/users/" + employee.getId()).principal(principal(admin))
            .header(HttpHeaders.IF_MATCH, oldTag).contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("displayName", "Changed"))))
            .andExpect(status().isOk()).andReturn();
        assertThat(changed.getResponse().getHeader(HttpHeaders.ETAG)).isNotEqualTo(oldTag);
        mvc.perform(patch("/api/v1/users/" + employee.getId()).principal(principal(admin))
            .header(HttpHeaders.IF_MATCH, oldTag).contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("displayName", "Stale Overwrite"))))
            .andExpect(status().isPreconditionFailed());
        assertThat(users.findById(employee.getId()).orElseThrow().getDisplayName()).isEqualTo("Changed");
    }

    @Test
    void administratorCanAssignManagerRoleAndExplicitScopes() throws Exception {
        String tag = detail(admin, employee.getId()).getResponse().getHeader(HttpHeaders.ETAG);
        MvcResult result = mvc.perform(patch("/api/v1/users/" + employee.getId())
            .principal(principal(admin)).header(HttpHeaders.IF_MATCH, tag)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("globalRole", "DEPARTMENT_MANAGER",
                "managerScopeUnitIds", Set.of(finance.getId())))))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(result).path("data").path("globalRole").asText()).isEqualTo("DEPARTMENT_MANAGER");
        assertThat(grants.existsByIdUserIdAndIdOrgUnitId(employee.getId(), finance.getId())).isTrue();
        assertThat(grants.findByIdUserId(employee.getId())).hasSize(1);
    }

    @Test
    void administratorDemotionClearsOldScope() throws Exception {
        grants.saveAndFlush(new ManagerScopeUnitEntity(manager.getId(), engineering.getId(), admin.getId()));
        String tag = detail(admin, manager.getId()).getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(patch("/api/v1/users/" + manager.getId()).principal(principal(admin))
            .header(HttpHeaders.IF_MATCH, tag).contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("globalRole", "EMPLOYEE")))).andExpect(status().isOk());
        assertThat(grants.findByIdUserId(manager.getId())).isEmpty();
    }

    @Test
    void selfProfileChangeCannotAlterGlobalRoleUnitOrAccountStatus() throws Exception {
        MvcResult original = mvc.perform(get("/api/v1/me/profile").principal(principal(employee)))
            .andExpect(status().isOk()).andReturn();
        String oldTag = original.getResponse().getHeader(HttpHeaders.ETAG);
        MvcResult modified = mvc.perform(patch("/api/v1/me/profile").principal(principal(employee))
            .header(HttpHeaders.IF_MATCH, oldTag)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("displayName", "Personal Name", "globalRole", "ADMINISTRATOR",
                "primaryOrgUnitId", engineering.getId(), "accountStatus", "ACTIVE"))))
            .andExpect(status().isOk()).andReturn();
        UserEntity after = users.findById(employee.getId()).orElseThrow();
        assertThat(after.getDisplayName()).isEqualTo("Personal Name");
        assertThat(after.getGlobalRole()).isEqualTo(GlobalRole.EMPLOYEE);
        assertThat(after.getPrimaryOrgUnitId()).isEqualTo(finance.getId());
        assertThat(modified.getResponse().getHeader(HttpHeaders.ETAG)).isNotEqualTo(oldTag);
    }

    @Test
    void missingRequiredCreateFieldsAndBadPageSizeAreRejected() throws Exception {
        mvc.perform(post("/api/v1/users").principal(principal(admin))
            .contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/v1/users").principal(principal(admin)).param("size", "101"))
            .andExpect(status().isUnprocessableEntity());
    }

    @Test
    void pendingAccountCannotUseProfileBeforeActivation() throws Exception {
        UserEntity pending = users.saveAndFlush(new UserEntity("p-" + UUID.randomUUID() + "@example.com",
            "Pending", GlobalRole.EMPLOYEE, finance.getId()));
        mvc.perform(get("/api/v1/me/profile").principal(principal(pending)))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void adminCannotAssignScopesToAnEmployee() throws Exception {
        String tag = detail(admin, employee.getId()).getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(patch("/api/v1/users/" + employee.getId()).principal(principal(admin))
            .header(HttpHeaders.IF_MATCH, tag)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json(Map.of("managerScopeUnitIds", Set.of(finance.getId())))))
            .andExpect(status().isUnprocessableEntity());
        assertThat(grants.findByIdUserId(employee.getId())).isEmpty();
    }
}
