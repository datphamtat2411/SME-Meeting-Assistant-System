package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.meeting.repository.MeetingParticipantRepository;
import com.sme.meetingassistant.api.room.service.RoomCatalogService;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalIdentityLookup;
import java.security.Principal;
import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
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
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingListProjectionIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    @MockitoSpyBean MeetingParticipantRepository participantRepository;
    @MockitoSpyBean OrganizationalIdentityLookup identityLookup;
    @MockitoSpyBean RoomCatalogService roomCatalog;

    private UUID organizer;

    @BeforeEach
    void setup() {
        organizer = user("Organizer", "ACTIVE");
    }

    private UUID user(String displayName, String accountStatus) {
        UUID id = UUID.randomUUID();
        String email = "projection-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,?,?,'EMPLOYEE',?)
            """, id, email, email, displayName, "test-only", accountStatus);
        return id;
    }

    private UUID room(String name, String location) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO rooms(id,code,name,location) VALUES (?,?,?,?)",
            id, "PROJECTION-" + id, name, location);
        return id;
    }

    private static Principal principal(UUID id) {
        return () -> id.toString();
    }

    private JsonNode body(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsString());
    }

    private UUID meetingId(MvcResult result) throws Exception {
        return UUID.fromString(body(result).path("data").path("id").asText());
    }

    private MvcResult create(UUID actor, String title, List<UUID> invitees, UUID roomId)
            throws Exception {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("title", title);
        request.put("participantUserIds", invitees);
        if (roomId != null) request.put("roomId", roomId);
        return mvc.perform(post("/api/v1/meetings").principal(principal(actor))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(request)))
            .andExpect(status().isCreated()).andReturn();
    }

    private MvcResult list(UUID actor, String... query) throws Exception {
        var request = get("/api/v1/meetings").principal(principal(actor));
        if (query.length % 2 != 0) throw new IllegalArgumentException("Incomplete query pair");
        for (int i = 0; i < query.length; i += 2) request.param(query[i], query[i + 1]);
        return mvc.perform(request).andExpect(status().isOk()).andReturn();
    }

    private String etag(MvcResult result) {
        return result.getResponse().getHeader(HttpHeaders.ETAG);
    }

    private JsonNode display(MvcResult result, int index) throws Exception {
        return body(result).path("data").get(index).path("display");
    }

    @Test
    void listMapsExistingMeetingFieldsAndRoomAndParticipantProjection() throws Exception {
        UUID first = user("First participant", "ACTIVE");
        UUID second = user("Second participant", "ACTIVE");
        UUID room = room("Boardroom", "Headquarters 2");
        UUID meeting = meetingId(create(organizer, "Projection meeting", List.of(first, second), room));

        setMembershipOrder(meeting, organizer, "2030-01-01T09:00:00Z");
        setMembershipOrder(meeting, first, "2030-01-01T09:01:00Z");
        setMembershipOrder(meeting, second, "2030-01-01T09:02:00Z");

        MvcResult result = list(organizer, "relationship", "ORGANIZER");
        JsonNode item = body(result).path("data").get(0);
        JsonNode projection = item.path("display");

        assertThat(item.path("id").asText()).isEqualTo(meeting.toString());
        assertThat(item.path("title").asText()).isEqualTo("Projection meeting");
        assertThat(item.path("organizerUserId").asText()).isEqualTo(organizer.toString());
        assertThat(item.path("roomId").asText()).isEqualTo(room.toString());
        assertThat(item.path("status").asText()).isEqualTo("DRAFT");
        assertThat(projection.path("organizerName").asText()).isEqualTo("Organizer");
        assertThat(projection.path("roomName").asText()).isEqualTo("Boardroom");
        assertThat(projection.path("roomLocation").asText()).isEqualTo("Headquarters 2");
        assertThat(projection.path("participantCount").asInt()).isEqualTo(3);
        assertThat(projection.path("participantPreview")).hasSize(2);
        assertThat(projection.path("participantPreview").get(0).path("userId").asText())
            .isEqualTo(organizer.toString());
        assertThat(projection.path("participantPreview").get(0).path("displayName").asText())
            .isEqualTo("Organizer");
        assertThat(projection.path("participantPreview").get(1).path("userId").asText())
            .isEqualTo(first.toString());
        assertThat(projection.path("participantPreview").get(1).path("displayName").asText())
            .isEqualTo("First participant");
        assertThat(projection.toString()).doesNotContain(second.toString());
    }

    @Test
    void listUsesNullRoomDisplayAndExcludesRemovedMembershipsButKeepsInactiveIdentity() throws Exception {
        UUID inactive = user("Historical participant", "ACTIVE");
        UUID removed = user("Removed participant", "ACTIVE");
        MvcResult created = create(organizer, "Historical projection", List.of(inactive, removed), null);
        UUID meeting = meetingId(created);

        jdbc.update("""
            UPDATE users
               SET account_status='INACTIVE', deactivated_at=CURRENT_TIMESTAMP
             WHERE id=?
            """, inactive);
        mvc.perform(delete("/api/v1/meetings/{meetingId}/participants/{userId}", meeting, removed)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH, etag(created)))
            .andExpect(status().isOk());

        JsonNode projection = display(list(organizer, "relationship", "ORGANIZER"), 0);
        assertThat(projection.path("organizerName").asText()).isEqualTo("Organizer");
        assertThat(projection.path("roomName").isNull()).isTrue();
        assertThat(projection.path("roomLocation").isNull()).isTrue();
        assertThat(projection.path("participantCount").asInt()).isEqualTo(2);
        assertThat(projection.path("participantPreview")).hasSize(2);
        assertThat(projection.toString()).contains(inactive.toString(), "Historical participant");
        assertThat(projection.toString()).doesNotContain(removed.toString(), "Removed participant");
    }

    @Test
    void visibilityIsAppliedBeforePaginationAndProjectionDoesNotExposeHiddenMeetings() throws Exception {
        UUID viewer = user("Viewer", "ACTIVE");
        UUID hiddenOwner = user("Hidden owner", "ACTIVE");
        UUID visibleA = meetingId(create(hiddenOwner, "Visible A", List.of(viewer), null));
        UUID visibleB = meetingId(create(hiddenOwner, "Visible B", List.of(viewer), null));
        UUID visibleC = meetingId(create(hiddenOwner, "Visible C", List.of(viewer), null));
        UUID hidden = meetingId(create(hiddenOwner, "Hidden", List.of(), null));

        for (int page = 0; page < 3; page++) {
            MvcResult result = list(viewer, "relationship", "PARTICIPANT", "sort", "title,asc",
                "page", String.valueOf(page), "size", "1");
            assertThat(body(result).path("meta").path("pagination").path("totalElements").asLong())
                .isEqualTo(3);
            assertThat(body(result).path("meta").path("pagination").path("totalPages").asInt())
                .isEqualTo(3);
            UUID returned = UUID.fromString(body(result).path("data").get(0).path("id").asText());
            assertThat(returned).isIn(visibleA, visibleB, visibleC);
            assertThat(returned).isNotEqualTo(hidden);
            assertThat(body(result).path("data").get(0).path("display").path("participantCount").asInt())
                .isEqualTo(2);
        }
    }

    @Test
    void listEnrichmentUsesOneBatchPerPageScopedBoundary() throws Exception {
        UUID first = user("Batch first", "ACTIVE");
        UUID second = user("Batch second", "ACTIVE");
        UUID room = room("Batch room", "Batch location");
        UUID pageMeeting = meetingId(create(organizer, "Batch page", List.of(first, second), room));
        meetingId(create(organizer, "Batch outside page", List.of(first), room));

        clearInvocations(participantRepository, identityLookup, roomCatalog);
        MvcResult result = list(organizer, "relationship", "ORGANIZER", "sort", "title,asc",
            "page", "1", "size", "1");

        ArgumentCaptor<Collection<UUID>> participantIds = ArgumentCaptor.forClass(Collection.class);
        verify(participantRepository).findActivePreviewByMeetingIdIn(participantIds.capture());
        assertThat(participantIds.getValue()).containsExactly(pageMeeting);

        ArgumentCaptor<Collection<UUID>> identityIds = ArgumentCaptor.forClass(Collection.class);
        verify(identityLookup).displayNamesFor(identityIds.capture());
        assertThat(identityIds.getValue()).contains(organizer, first);
        assertThat(identityIds.getValue()).doesNotContain(second);

        ArgumentCaptor<Collection<UUID>> roomIds = ArgumentCaptor.forClass(Collection.class);
        verify(roomCatalog).displayByIds(roomIds.capture());
        assertThat(roomIds.getValue()).containsExactly(room);
        assertThat(body(result).path("data")).hasSize(1);
    }

    private void setMembershipOrder(UUID meetingId, UUID userId, String addedAt) {
        jdbc.update("UPDATE meeting_participants SET added_at=? WHERE meeting_id=? AND user_id=?",
            OffsetDateTime.parse(addedAt), meetingId, userId);
    }
}
