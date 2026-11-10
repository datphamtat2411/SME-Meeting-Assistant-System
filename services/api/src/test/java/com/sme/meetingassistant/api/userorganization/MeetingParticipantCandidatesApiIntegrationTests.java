package com.sme.meetingassistant.api.userorganization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationalUnitEntity;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.OrganizationalUnitRepository;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.security.Principal;
import java.util.ArrayList;
import java.util.List;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
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
class MeetingParticipantCandidatesApiIntegrationTests {
    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper json;
    @Autowired private UserRepository users;
    @Autowired private OrganizationalUnitRepository units;

    private UserEntity requester;
    private OrganizationalUnitEntity activeUnit;
    private OrganizationalUnitEntity inactiveUnit;

    @BeforeEach
    void setup() {
        activeUnit = units.saveAndFlush(new OrganizationalUnitEntity(
            "CANDIDATE-ACTIVE-" + UUID.randomUUID(), "Active Candidate Unit", null));
        inactiveUnit = units.saveAndFlush(new OrganizationalUnitEntity(
            "CANDIDATE-INACTIVE-" + UUID.randomUUID(), "Inactive Candidate Unit", null));
        inactiveUnit.deactivate();
        units.saveAndFlush(inactiveUnit);
        requester = active("requester-" + UUID.randomUUID() + "@example.com",
            "Meeting Requester", GlobalRole.EMPLOYEE, null);
    }

    @Test
    void requiresAnActiveAuthenticatedActorButNotDirectoryManagementPrivileges() throws Exception {
        mvc.perform(get("/api/v1/users/meeting-candidates").param("q", "me"))
            .andExpect(status().isUnauthorized());

        mvc.perform(get("/api/v1/users/meeting-candidates").principal(principal(requester))
                .param("q", "me"))
            .andExpect(status().isOk());

        // The existing administrative directory remains protected for employees.
        mvc.perform(get("/api/v1/users").principal(principal(requester)))
            .andExpect(status().isForbidden());

        UserEntity pending = new UserEntity("pending-" + UUID.randomUUID() + "@example.com",
            "Pending Requester", GlobalRole.EMPLOYEE, null);
        pending = users.saveAndFlush(pending);
        mvc.perform(get("/api/v1/users/meeting-candidates").principal(principal(pending))
                .param("q", "pe"))
            .andExpect(status().isUnauthorized());

        UserEntity inactive = active("inactive-requester-" + UUID.randomUUID() + "@example.com",
            "Inactive Requester", GlobalRole.EMPLOYEE, null);
        inactive.deactivate(java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC));
        users.saveAndFlush(inactive);
        mvc.perform(get("/api/v1/users/meeting-candidates").principal(principal(inactive))
                .param("q", "in"))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void returnsOnlyActiveMeetingEligibleUsersIncludingAllMeetingRoles() throws Exception {
        UserEntity employee = active("eligible-employee-" + UUID.randomUUID() + "@example.com",
            "Eligible Employee", GlobalRole.EMPLOYEE, null);
        UserEntity manager = active("eligible-manager-" + UUID.randomUUID() + "@example.com",
            "Eligible Manager", GlobalRole.DEPARTMENT_MANAGER, activeUnit.getId());
        UserEntity administrator = active("eligible-admin-" + UUID.randomUUID() + "@example.com",
            "Eligible Administrator", GlobalRole.ADMINISTRATOR, null);
        UserEntity inactive = active("eligible-inactive-" + UUID.randomUUID() + "@example.com",
            "Eligible Inactive", GlobalRole.EMPLOYEE, null);
        inactive.deactivate(java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC));
        users.saveAndFlush(inactive);
        UserEntity pending = new UserEntity("eligible-pending-" + UUID.randomUUID() + "@example.com",
            "Eligible Pending", GlobalRole.EMPLOYEE, null);
        users.saveAndFlush(pending);

        JsonNode data = data(list(requester, "eligible", 0, 20));
        assertThat(ids(data)).containsExactlyInAnyOrder(employee.getId(), manager.getId(), administrator.getId());
        assertThat(ids(data)).doesNotContain(inactive.getId(), pending.getId());
    }

    @Test
    void excludesTheAuthenticatedOrganizerFromMeetingCandidates() throws Exception {
        JsonNode result = data(list(requester, "meeting requester", 0, 20));

        assertThat(ids(result)).doesNotContain(requester.getId());
    }

    @Test
    void appliesTwoNonWhitespaceSearchBoundaryAndCaseInsensitiveIdentitySearch() throws Exception {
        String token = "Q" + UUID.randomUUID().toString().replace("-", "").substring(0, 7);
        UserEntity matched = active(token.toLowerCase() + "@example.com",
            "Search " + token, GlobalRole.EMPLOYEE, null);
        UserEntity unrelated = active("bravo-" + UUID.randomUUID() + "@example.com",
            "Bravo Person", GlobalRole.EMPLOYEE, null);

        JsonNode result = data(list(requester, "  " + token.toUpperCase() + "  ", 0, 20));
        assertThat(ids(result)).containsExactly(matched.getId());
        assertThat(ids(result)).doesNotContain(unrelated.getId());

        mvc.perform(get("/api/v1/users/meeting-candidates").principal(principal(requester)))
            .andExpect(status().isBadRequest());
        for (String invalid : List.of("a", " x ", "   ")) {
            mvc.perform(get("/api/v1/users/meeting-candidates").principal(principal(requester))
                    .param("q", invalid))
                .andExpect(status().isUnprocessableEntity());
        }
    }

    @Test
    void filtersAndPaginatesInDatabaseWithDeterministicOrderingAndBoundedSize() throws Exception {
        List<UserEntity> expected = new ArrayList<>();
        for (int index = 0; index < 21; index++) {
            expected.add(active("paged-" + String.format("%02d", index) + "-"
                    + UUID.randomUUID() + "@example.com",
                "Paged Candidate " + String.format("%02d", index), GlobalRole.EMPLOYEE, null));
        }

        JsonNode firstPage = data(list(requester, "paged candidate", 0, 20));
        JsonNode secondPage = data(list(requester, "paged candidate", 1, 20));
        JsonNode repeatFirstPage = data(list(requester, "paged candidate", 0, 20));
        assertThat(firstPage).hasSize(20);
        assertThat(secondPage).hasSize(1);
        assertThat(ids(firstPage)).containsExactlyElementsOf(ids(repeatFirstPage));
        assertThat(ids(firstPage)).containsExactlyElementsOf(expected.subList(0, 20).stream()
            .map(UserEntity::getId).toList());
        assertThat(ids(secondPage)).containsExactly(expected.get(20).getId());
        assertThat(data(list(requester, "paged candidate", 0, 20)).toString())
            .doesNotContain(requester.getId().toString());
        assertThat(json.readTree(list(requester, "paged candidate", 0, 20)
            .getResponse().getContentAsString()).path("meta").path("pagination")
            .path("totalElements").asLong()).isEqualTo(21L);

        mvc.perform(get("/api/v1/users/meeting-candidates").principal(principal(requester))
                .param("q", "pa").param("size", "21"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/v1/users/meeting-candidates").principal(principal(requester))
                .param("q", "pa").param("size", "0"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/v1/users/meeting-candidates").principal(principal(requester))
                .param("q", "pa").param("page", "-1"))
            .andExpect(status().isUnprocessableEntity());

        UserEntity sameA = active("same-a-" + UUID.randomUUID() + "@example.com",
            "Same Display", GlobalRole.EMPLOYEE, null);
        UserEntity sameB = active("same-b-" + UUID.randomUUID() + "@example.com",
            "Same Display", GlobalRole.EMPLOYEE, null);
        List<UUID> expectedTieOrder = List.of(sameA.getId(), sameB.getId()).stream()
            .sorted(java.util.Comparator.comparing(UUID::toString)).toList();
        assertThat(ids(data(list(requester, "same display", 0, 20))))
            .containsExactlyElementsOf(expectedTieOrder);
    }

    @Test
    void returnsOnlyPublicCandidateFieldsAndActiveOrganizationMetadata() throws Exception {
        UserEntity assigned = active("assigned-" + UUID.randomUUID() + "@example.com",
            "Assigned Candidate", GlobalRole.EMPLOYEE, activeUnit.getId());
        UserEntity unassigned = active("unassigned-" + UUID.randomUUID() + "@example.com",
            "Unassigned Candidate", GlobalRole.EMPLOYEE, null);
        UserEntity inactiveUnitUser = active("inactive-unit-" + UUID.randomUUID() + "@example.com",
            "Inactive Unit Candidate", GlobalRole.EMPLOYEE, inactiveUnit.getId());

        JsonNode result = data(list(requester, "candidate", 0, 20));
        JsonNode assignedData = find(result, assigned.getId());
        JsonNode unassignedData = find(result, unassigned.getId());
        JsonNode inactiveUnitData = find(result, inactiveUnitUser.getId());

        assertThat(assignedData.path("organizationalUnitName").asText())
            .isEqualTo(activeUnit.getName());
        assertThat(unassignedData.path("organizationalUnitName").isNull()).isTrue();
        assertThat(inactiveUnitData.path("organizationalUnitName").isNull()).isTrue();

        Set<String> fields = new HashSet<>();
        assignedData.properties().forEach(property -> fields.add(property.getKey()));
        assertThat(fields).containsExactlyInAnyOrder(
            "id", "displayName", "email", "organizationalUnitName");
        assertThat(assignedData.toString()).doesNotContain(
            "passwordHash", "password_hash", "globalRole", "accountStatus",
            "primaryOrgUnitId", "createdAt", "updatedAt", "managerScopeUnitIds");
    }

    private UserEntity active(String email, String displayName, GlobalRole role, UUID unitId) {
        UserEntity user = new UserEntity(email, displayName, role, unitId);
        ReflectionTestUtils.setField(user, "passwordHash", "test-only-hash");
        ReflectionTestUtils.setField(user, "accountStatus", AccountStatus.ACTIVE);
        return users.saveAndFlush(user);
    }

    private MvcResult list(UserEntity actor, String query, int page, int size) throws Exception {
        return mvc.perform(get("/api/v1/users/meeting-candidates")
                .principal(principal(actor)).param("q", query)
                .param("page", Integer.toString(page)).param("size", Integer.toString(size)))
            .andExpect(status().isOk()).andReturn();
    }

    private JsonNode data(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsString()).path("data");
    }

    private List<UUID> ids(JsonNode data) {
        List<UUID> ids = new ArrayList<>();
        data.forEach(item -> ids.add(UUID.fromString(item.path("id").asText())));
        return ids;
    }

    private JsonNode find(JsonNode data, UUID id) {
        for (JsonNode item : data) {
            if (item.path("id").asText().equals(id.toString())) return item;
        }
        throw new AssertionError("Candidate not found: " + id);
    }

    private static Principal principal(UserEntity user) {
        return () -> user.getId().toString();
    }
}
