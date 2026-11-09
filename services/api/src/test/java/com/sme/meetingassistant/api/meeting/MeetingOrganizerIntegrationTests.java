package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingOrganizerIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    private static Principal principal(UUID id) {
        return () -> id.toString();
    }

    private UUID user(String displayName, String accountStatus) {
        UUID id = UUID.randomUUID();
        String email = "organizer-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,?,?,'EMPLOYEE',?)
            """, id, email, email, displayName, "test-only", accountStatus);
        return id;
    }

    private void createMeeting(UUID organizer, String title, UUID... participants)
            throws Exception {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("title", title);
        request.put("participantUserIds", List.of(participants));
        mvc.perform(post("/api/v1/meetings").principal(principal(organizer))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(request)))
            .andExpect(status().isCreated());
    }

    private JsonNode body(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsString());
    }

    @Test
    void listsDistinctAccessibleOrganizersWithSearchPaginationAndHistoricalNames() throws Exception {
        UUID viewer = user("Viewer", "ACTIVE");
        UUID alice = user("Alice Organizer", "ACTIVE");
        UUID zed = user("Zed Organizer", "ACTIVE");
        UUID historical = user("Historical Organizer", "ACTIVE");
        UUID hidden = user("Hidden Organizer", "ACTIVE");

        createMeeting(alice, "Alice meeting", viewer);
        createMeeting(zed, "Zed first", viewer);
        createMeeting(zed, "Zed second", viewer);
        createMeeting(historical, "Historical meeting", viewer);
        createMeeting(hidden, "Hidden meeting");
        jdbc.update("""
            UPDATE users
               SET account_status='INACTIVE', deactivated_at=CURRENT_TIMESTAMP
             WHERE id=?
            """, historical);

        MvcResult firstPage = mvc.perform(get("/api/v1/meeting-organizers")
                .principal(principal(viewer)).param("page", "0").param("size", "2"))
            .andExpect(status().isOk()).andReturn();
        JsonNode firstPageBody = body(firstPage);
        assertThat(firstPageBody.path("data")).hasSize(2);
        assertThat(firstPageBody.path("data").get(0).path("name").asText())
            .isEqualTo("Alice Organizer");
        assertThat(firstPageBody.path("data").get(1).path("name").asText())
            .isEqualTo("Historical Organizer");
        assertThat(firstPageBody.path("meta").path("pagination").path("totalElements").asLong())
            .isEqualTo(3);

        MvcResult secondPage = mvc.perform(get("/api/v1/meeting-organizers")
                .principal(principal(viewer)).param("page", "1").param("size", "2"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(secondPage).path("data").get(0).path("name").asText())
            .isEqualTo("Zed Organizer");
        assertThat(body(secondPage).path("data").toString()).doesNotContain(hidden.toString());

        MvcResult search = mvc.perform(get("/api/v1/meeting-organizers")
                .principal(principal(viewer)).param("q", "historical"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(search).path("data")).hasSize(1);
        assertThat(body(search).path("data").get(0).path("id").asText())
            .isEqualTo(historical.toString());
    }

    @Test
    void idLookupReturnsOnlyAnOrganizerFromAnAccessibleMeeting() throws Exception {
        UUID viewer = user("Lookup viewer", "ACTIVE");
        UUID accessible = user("Accessible historical organizer", "ACTIVE");
        UUID hidden = user("Hidden lookup organizer", "ACTIVE");
        createMeeting(accessible, "Accessible meeting", viewer);
        createMeeting(hidden, "Hidden meeting");
        jdbc.update("""
            UPDATE users
               SET account_status='INACTIVE', deactivated_at=CURRENT_TIMESTAMP
             WHERE id=?
            """, accessible);

        MvcResult result = mvc.perform(get("/api/v1/meeting-organizers/{id}", accessible)
                .principal(principal(viewer)))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(result).path("data").path("id").asText())
            .isEqualTo(accessible.toString());
        assertThat(body(result).path("data").path("name").asText())
            .isEqualTo("Accessible historical organizer");

        mvc.perform(get("/api/v1/meeting-organizers/{id}", hidden)
                .principal(principal(viewer)))
            .andExpect(status().isNotFound());
    }
}
