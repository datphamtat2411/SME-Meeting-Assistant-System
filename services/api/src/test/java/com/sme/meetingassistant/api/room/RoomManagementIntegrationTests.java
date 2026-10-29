package com.sme.meetingassistant.api.room;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.room.entity.RoomEntity;
import com.sme.meetingassistant.api.room.entity.RoomStatus;
import com.sme.meetingassistant.api.room.repository.RoomRepository;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.security.Principal;
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
class RoomManagementIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired RoomRepository rooms;
    @Autowired UserRepository users;

    private UserEntity administrator;
    private UserEntity employee;
    private UserEntity manager;
    private UserEntity pending;

    @BeforeEach
    void users() {
        administrator = user(GlobalRole.ADMINISTRATOR, true);
        employee = user(GlobalRole.EMPLOYEE, true);
        manager = user(GlobalRole.DEPARTMENT_MANAGER, true);
        pending = user(GlobalRole.EMPLOYEE, false);
    }

    private UserEntity user(GlobalRole role, boolean active) {
        UserEntity user = new UserEntity("t01-" + UUID.randomUUID() + "@example.invalid",
            "Test User", role, null);
        if (active) {
            ReflectionTestUtils.setField(user, "passwordHash", "test-only-verifier");
            ReflectionTestUtils.setField(user, "accountStatus", AccountStatus.ACTIVE);
        }
        return users.saveAndFlush(user);
    }

    private static Principal principal(UserEntity user) {
        return () -> user.getId().toString();
    }

    private String payload(Object body) throws Exception {
        return json.writeValueAsString(body);
    }

    private JsonNode body(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsString());
    }

    private MvcResult create(String code) throws Exception {
        return mvc.perform(post("/api/v1/rooms").principal(principal(administrator))
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload(Map.of("code", code, "name", "Conference North", "capacity", 12))))
            .andExpect(status().isCreated()).andReturn();
    }

    @Test
    void administratorCreatesRoomWithCanonicalFieldsAndEmployeeCanReadIt() throws Exception {
        MvcResult result = create("Room-" + UUID.randomUUID());
        JsonNode created = body(result).path("data");
        String id = created.path("id").asText();
        assertThat(created.path("code").asText()).startsWith("ROOM-");
        assertThat(created.path("name").asText()).isEqualTo("Conference North");
        assertThat(created.path("capacity").asInt()).isEqualTo(12);
        assertThat(created.path("status").asText()).isEqualTo("ACTIVE");
        assertThat(result.getResponse().getHeader(HttpHeaders.LOCATION)).isEqualTo("/api/v1/rooms/" + id);
        assertThat(result.getResponse().getHeader(HttpHeaders.ETAG)).isNotBlank();

        MvcResult detail = mvc.perform(get("/api/v1/rooms/" + id).principal(principal(employee)))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(detail).path("data").path("code").asText()).isEqualTo(created.path("code").asText());
        assertThat(rooms.findById(UUID.fromString(id)).orElseThrow().getCapacity()).isEqualTo(12);
    }

    @Test
    void normalizedRoomCodesAreUniqueAndNameIsNotTheIdentity() throws Exception {
        String code = "C-" + UUID.randomUUID();
        create(code.toLowerCase(java.util.Locale.ROOT));
        mvc.perform(post("/api/v1/rooms").principal(principal(administrator))
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload(Map.of("code", code.toUpperCase(java.util.Locale.ROOT), "name", "Other"))))
            .andExpect(status().isConflict());
        create("X-" + UUID.randomUUID()); // Duplicate display names are permitted.
    }

    @Test
    void anonymousInactiveEmployeeAndManagerCannotMutateRoomCatalog() throws Exception {
        mvc.perform(get("/api/v1/rooms")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/rooms").principal(principal(pending)))
            .andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/rooms").principal(principal(employee))
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload(Map.of("code", "X-" + UUID.randomUUID(), "name", "Forbidden"))))
            .andExpect(status().isForbidden());
        mvc.perform(post("/api/v1/rooms").principal(principal(manager))
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload(Map.of("code", "Y-" + UUID.randomUUID(), "name", "Forbidden"))))
            .andExpect(status().isForbidden());
    }

    @Test
    void patchIsPartialAndRequiresFreshEtagAndDoesNotAllowMassAssignment() throws Exception {
        MvcResult created = create("Z-" + UUID.randomUUID());
        String id = body(created).path("data").path("id").asText();
        String etag = created.getResponse().getHeader(HttpHeaders.ETAG);

        mvc.perform(patch("/api/v1/rooms/" + id).principal(principal(administrator))
            .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"No precondition\"}"))
            .andExpect(status().is(428));
        mvc.perform(patch("/api/v1/rooms/" + id).principal(principal(administrator))
            .header(HttpHeaders.IF_MATCH, etag).contentType(MediaType.APPLICATION_JSON)
            .content("{\"status\":\"INACTIVE\"}"))
            .andExpect(status().isUnprocessableEntity());

        MvcResult changed = mvc.perform(patch("/api/v1/rooms/" + id).principal(principal(administrator))
            .header(HttpHeaders.IF_MATCH, etag).contentType(MediaType.APPLICATION_JSON)
            .content("{\"name\":\"Renamed\",\"capacity\":null,\"location\":\"Level 3\"}"))
            .andExpect(status().isOk()).andReturn();

        JsonNode modified = body(changed).path("data");
        assertThat(modified.path("name").asText()).isEqualTo("Renamed");
        assertThat(modified.path("capacity").isNull()).isTrue();
        assertThat(modified.path("location").asText()).isEqualTo("Level 3");
        assertThat(modified.path("code").asText()).isEqualTo(body(created).path("data").path("code").asText());
        assertThat(changed.getResponse().getHeader(HttpHeaders.ETAG)).isNotEqualTo(etag);

        mvc.perform(patch("/api/v1/rooms/" + id).principal(principal(administrator))
            .header(HttpHeaders.IF_MATCH, etag).contentType(MediaType.APPLICATION_JSON)
            .content("{\"name\":\"Lost write\"}"))
            .andExpect(status().isPreconditionFailed());
        assertThat(rooms.findById(UUID.fromString(id)).orElseThrow().getName()).isEqualTo("Renamed");
    }

    @Test
    void rejectsInvalidRequiredNameAndCapacity() throws Exception {
        mvc.perform(post("/api/v1/rooms").principal(principal(administrator))
            .contentType(MediaType.APPLICATION_JSON).content("{\"code\":\"A\",\"name\":\" \",\"capacity\":-3}"))
            .andExpect(status().isUnprocessableEntity());
        MvcResult created = create("Valid-" + UUID.randomUUID());
        String id = body(created).path("data").path("id").asText();
        String etag = created.getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(patch("/api/v1/rooms/" + id).principal(principal(administrator))
            .header(HttpHeaders.IF_MATCH, etag).contentType(MediaType.APPLICATION_JSON)
            .content("{\"capacity\":0}"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(patch("/api/v1/rooms/" + id).principal(principal(administrator))
            .header(HttpHeaders.IF_MATCH, etag).contentType(MediaType.APPLICATION_JSON)
            .content("{\"code\":\"MUTATED\"}"))
            .andExpect(status().isUnprocessableEntity());
    }

    @Test
    void deactivatePreservesRowAndRemovesRoomFromEmployeeCatalog() throws Exception {
        MvcResult created = create("Inactive-" + UUID.randomUUID());
        String id = body(created).path("data").path("id").asText();
        String etag = created.getResponse().getHeader(HttpHeaders.ETAG);

        mvc.perform(post("/api/v1/rooms/" + id + "/deactivate")
            .principal(principal(employee)).header(HttpHeaders.IF_MATCH, etag))
            .andExpect(status().isForbidden());
        MvcResult disabled = mvc.perform(post("/api/v1/rooms/" + id + "/deactivate")
            .principal(principal(administrator)).header(HttpHeaders.IF_MATCH, etag))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(disabled).path("data").path("status").asText()).isEqualTo("INACTIVE");
        assertThat(rooms.findById(UUID.fromString(id)).orElseThrow().getStatus()).isEqualTo(RoomStatus.INACTIVE);

        MvcResult visibleToAdmin = mvc.perform(get("/api/v1/rooms").principal(principal(administrator))
            .param("status", "INACTIVE")).andExpect(status().isOk()).andReturn();
        assertThat(visibleToAdmin.getResponse().getContentAsString()).contains(id);
        MvcResult employeeList = mvc.perform(get("/api/v1/rooms").principal(principal(employee)))
            .andExpect(status().isOk()).andReturn();
        assertThat(employeeList.getResponse().getContentAsString()).doesNotContain(id);
        mvc.perform(get("/api/v1/rooms").principal(principal(employee)).param("status", "INACTIVE"))
            .andExpect(status().isForbidden());
        mvc.perform(get("/api/v1/rooms/" + id).principal(principal(employee)))
            .andExpect(status().isOk());
        mvc.perform(patch("/api/v1/rooms/" + id).principal(principal(administrator))
            .header(HttpHeaders.IF_MATCH, disabled.getResponse().getHeader(HttpHeaders.ETAG))
            .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"Cannot re-enable\"}"))
            .andExpect(status().isConflict());
    }

    @Test
    void listUsesFilteringAndPaginationAndRejectsInvalidSort() throws Exception {
        String unique = "R" + UUID.randomUUID().toString().substring(0, 8);
        create(unique + "A");
        create(unique + "B");
        MvcResult result = mvc.perform(get("/api/v1/rooms").principal(principal(employee))
            .param("q", unique).param("page", "0").param("size", "1").param("sort", "code,asc"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(result).path("data")).hasSize(1);
        assertThat(body(result).path("meta").path("pagination").path("totalElements").asLong()).isEqualTo(2);
        mvc.perform(get("/api/v1/rooms").principal(principal(employee))
            .param("sort", "something,asc")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/rooms").principal(principal(employee))
            .param("size", "101")).andExpect(status().isUnprocessableEntity());
        mvc.perform(delete("/api/v1/rooms/" + body(result).path("data").get(0).path("id").asText())
            .principal(principal(administrator))).andExpect(status().isMethodNotAllowed());
    }
}
