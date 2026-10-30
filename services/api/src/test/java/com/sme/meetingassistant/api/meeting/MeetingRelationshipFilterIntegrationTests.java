package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * T03: HTTP-to-PostgreSQL acceptance for caller-scoped, disjoint relationship
 * filtering. No @Transactional: every command commits independently, so
 * removal and lifecycle tests exercise the current authorization state.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingRelationshipFilterIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    private UUID alice, bob, carol, admin;

    @BeforeEach void setup() {
        alice = user("EMPLOYEE");
        bob = user("EMPLOYEE");
        carol = user("EMPLOYEE");
        admin = user("ADMINISTRATOR");
    }

    private UUID user(String role) {
        UUID id=UUID.randomUUID();
        String email="t03-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'T03 fixture','test-only',?,'ACTIVE')
            """,id,email,email,role);
        return id;
    }

    private UUID room() {
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO rooms(id,code,name) VALUES (?,?,?)",
            id,"T03-"+id,"T03 room");
        return id;
    }

    private static Principal as(UUID id) {
        return () -> id.toString();
    }

    private JsonNode body(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsString());
    }

    private UUID createdId(MvcResult result) throws Exception {
        return UUID.fromString(body(result).path("data").path("id").asText());
    }

    private MvcResult create(UUID actor, String title, List<UUID> invitees,
            UUID roomId, String from, String to) throws Exception {
        Map<String,Object> payload=new LinkedHashMap<>();
        payload.put("title",title);
        if (invitees != null) payload.put("participantUserIds",invitees);
        if (roomId != null) payload.put("roomId",roomId);
        if (from != null) payload.put("scheduledStartAt",from);
        if (to != null) payload.put("scheduledEndAt",to);
        return mvc.perform(post("/api/v1/meetings").principal(as(actor))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(payload)))
            .andExpect(status().isCreated()).andReturn();
    }

    private MvcResult create(UUID actor, String title, UUID... invitees) throws Exception {
        return create(actor,title,List.of(invitees),null,null,null);
    }

    private MvcResult list(UUID actor, String... query) throws Exception {
        MockHttpServletRequestBuilder req=get("/api/v1/meetings").principal(as(actor));
        if (query.length % 2 != 0) throw new IllegalArgumentException("Incomplete query pair");
        for (int i=0; i<query.length; i+=2) req.param(query[i],query[i+1]);
        return mvc.perform(req).andExpect(status().isOk()).andReturn();
    }

    private List<UUID> ids(MvcResult result) throws Exception {
        List<UUID> output=new ArrayList<>();
        for (JsonNode item:body(result).path("data")) {
            output.add(UUID.fromString(item.path("id").asText()));
        }
        return output;
    }

    private long total(MvcResult result) throws Exception {
        return body(result).path("meta").path("pagination").path("totalElements").asLong();
    }

    private String etag(MvcResult result) {
        return result.getResponse().getHeader(HttpHeaders.ETAG);
    }

    @Test void defaultScopeAndDisjointRelationshipsDoNotDuplicateOrganizerMembership()
            throws Exception {
        UUID aliceFirst=createdId(create(alice,"Owned first",bob));
        UUID aliceSecond=createdId(create(alice,"Owned second",bob));
        UUID aliceInvited=createdId(create(bob,"Invited to Alice",alice));
        UUID unrelated=createdId(create(carol,"Confidential unrelated",bob));

        MvcResult all=list(alice);
        assertThat(ids(all)).containsExactlyInAnyOrder(aliceFirst,aliceSecond,aliceInvited);
        assertThat(total(all)).isEqualTo(3);
        MvcResult organized=list(alice,"relationship","ORGANIZER");
        assertThat(ids(organized)).containsExactlyInAnyOrder(aliceFirst,aliceSecond);
        assertThat(total(organized)).isEqualTo(2);

        MvcResult participating=list(alice,"relationship","PARTICIPANT");
        assertThat(ids(participating)).containsExactly(aliceInvited);
        assertThat(total(participating)).isEqualTo(1);
        assertThat(ids(participating)).doesNotContain(aliceFirst,aliceSecond,unrelated);

        // The organizer has a canonical participant row but the two views are
        // intentionally disjoint, so organized meetings do not count twice.
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants
            WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """,Integer.class,aliceFirst,alice)).isEqualTo(1);
        assertThat(ids(list(bob,"relationship","ORGANIZER"))).containsExactly(aliceInvited);
        assertThat(ids(list(admin))).isEmpty(); // ADMINISTRATOR is not omniscient.
        assertThat(ids(list(admin,"relationship","PARTICIPANT"))).isEmpty();
    }

    @Test void removedParticipantImmediatelyLosesListAccessAndReaddRestoresIt()
            throws Exception {
        MvcResult invited=create(bob,"Permission changes",alice);
        UUID meeting=createdId(invited);
        assertThat(ids(list(alice,"relationship","PARTICIPANT"))).contains(meeting);
        MvcResult removed=mvc.perform(delete(
            "/api/v1/meetings/"+meeting+"/participants/"+alice)
            .principal(as(bob)).header(HttpHeaders.IF_MATCH,etag(invited)))
            .andExpect(status().isOk()).andReturn();

        assertThat(ids(list(alice))).doesNotContain(meeting);
        assertThat(ids(list(alice,"relationship","PARTICIPANT"))).doesNotContain(meeting);
        assertThat(total(list(alice,"relationship","PARTICIPANT"))).isZero();
        assertThat(ids(list(bob,"relationship","ORGANIZER"))).contains(meeting);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants
             WHERE meeting_id=? AND user_id=? AND removed_at IS NOT NULL
            """, Integer.class,meeting,alice)).isEqualTo(1);

        mvc.perform(post("/api/v1/meetings/"+meeting+"/participants")
            .principal(as(bob)).header(HttpHeaders.IF_MATCH,etag(removed))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("userId",alice))))
            .andExpect(status().isCreated());

        assertThat(ids(list(alice,"relationship","PARTICIPANT"))).containsExactly(meeting);
        assertThat(total(list(alice,"relationship","PARTICIPANT"))).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants
             WHERE meeting_id=? AND user_id=?
            """, Integer.class,meeting,alice)).isEqualTo(2);
    }

    @Test void authorizedFilteringOccursBeforePaginationAndDoesNotInflateCounts()
            throws Exception {
        // Deliberately duplicate titles: sorting must use existing ID tie-break.
        UUID one=createdId(create(bob,"Same title",alice));
        UUID two=createdId(create(bob,"Same title",alice));
        UUID three=createdId(create(bob,"Same title",alice));
        UUID own=createdId(create(alice,"Same title"));
        UUID hiddenA=createdId(create(carol,"Same title"));
        UUID hiddenB=createdId(create(carol,"Same title"));

        List<UUID> expected=new ArrayList<>(List.of(one,two,three));
        expected.sort(Comparator.comparing(UUID::toString));
        List<UUID> actual=new ArrayList<>();
        for (int page=0;page<3;page++) {
            MvcResult result=list(alice,"relationship","PARTICIPANT",
                "sort","title,asc","page",String.valueOf(page),"size","1");
            assertThat(total(result)).isEqualTo(3);
            assertThat(body(result).path("meta").path("pagination").path("totalPages").asInt())
                .isEqualTo(3);
            assertThat(body(result).path("meta").path("pagination").path("page").asInt())
                .isEqualTo(page);
            assertThat(body(result).path("meta").path("pagination").path("hasNext").asBoolean())
                .isEqualTo(page<2);
            actual.addAll(ids(result));
        }
        assertThat(actual).containsExactlyElementsOf(expected);
        assertThat(new HashSet<>(actual)).hasSize(3);
        assertThat(actual).doesNotContain(own,hiddenA,hiddenB);
        MvcResult empty=list(alice,"relationship","PARTICIPANT","page","3","size","1");
        assertThat(ids(empty)).isEmpty();
        assertThat(total(empty)).isEqualTo(3);
        assertThat(ids(list(alice,"relationship","ORGANIZER"))).containsExactly(own);
    }

    @Test void relationshipComposesWithExistingStatusDatesOrganizerRoomAndSearch()
            throws Exception {
        String nine="2030-06-10T09:00:00Z",ten="2030-06-10T10:00:00Z";
        UUID requestedRoom=room(), anotherRoom=room();
        UUID matching=createdId(create(bob,"Budget Planning",List.of(alice),
            requestedRoom,nine,ten));
        UUID otherRoomMeeting=createdId(create(bob,"Budget Planning",List.of(alice),
            anotherRoom,nine,ten));
        UUID notInvited=createdId(create(bob,"Budget Planning",List.of(),
            requestedRoom,nine,ten));
        UUID own=createdId(create(alice,"Budget Planning",List.of(),
            requestedRoom,nine,ten));
        UUID hidden=createdId(create(carol,"Budget Planning",List.of(),
            requestedRoom,nine,ten));

        String[] filters={"relationship","PARTICIPANT","status","DRAFT",
            "organizerId",bob.toString(),"roomId",requestedRoom.toString(),
            "q","plAnNiNg","from","2030-06-10T08:00:00Z",
            "to","2030-06-10T11:00:00Z"};
        MvcResult filtered=list(alice,filters);
        assertThat(ids(filtered)).containsExactly(matching);
        assertThat(total(filtered)).isEqualTo(1);
        assertThat(ids(filtered)).doesNotContain(otherRoomMeeting,notInvited,own,hidden);
        assertThat(ids(list(alice,"relationship","PARTICIPANT",
            "organizerId",bob.toString(),"roomId",anotherRoom.toString())))
            .containsExactly(otherRoomMeeting);

        // Half-open overlap: ending exactly at 'from' or starting exactly at 'to'
        // cannot match, and filtering never grants access by guessing a UUID.
        assertThat(ids(list(alice,"relationship","PARTICIPANT",
            "roomId",requestedRoom.toString(),"from",ten))).isEmpty();
        assertThat(ids(list(alice,"relationship","PARTICIPANT",
            "roomId",requestedRoom.toString(),"to",nine))).isEmpty();
        assertThat(total(list(alice,"relationship","PARTICIPANT",
            "organizerId",carol.toString()))).isZero();
        assertThat(total(list(alice,"relationship","ORGANIZER",
            "organizerId",bob.toString()))).isZero();
        assertThat(total(list(alice,"relationship","PARTICIPANT",
            "status","ENDED"))).isZero();
    }

    @Test void historicalStatusesRemainVisibleToCurrentMembersOnly() throws Exception {
        String start="2030-12-10T09:00:00Z",end="2030-12-10T10:00:00Z";
        MvcResult first=create(bob,"Cancelled meeting",List.of(alice),null,start,end);
        UUID cancelled=createdId(first);
        MvcResult scheduled=mvc.perform(post("/api/v1/meetings/"+cancelled+"/schedule")
            .principal(as(bob)).header(HttpHeaders.IF_MATCH,etag(first)))
            .andExpect(status().isOk()).andReturn();
        mvc.perform(post("/api/v1/meetings/"+cancelled+"/cancel")
            .principal(as(bob)).header(HttpHeaders.IF_MATCH,etag(scheduled)))
            .andExpect(status().isOk());

        MvcResult second=create(bob,"Ended meeting",List.of(alice),null,start,end);
        UUID ended=createdId(second);
        MvcResult committed=mvc.perform(post("/api/v1/meetings/"+ended+"/schedule")
            .principal(as(bob)).header(HttpHeaders.IF_MATCH,etag(second)))
            .andExpect(status().isOk()).andReturn();
        MvcResult started=mvc.perform(post("/api/v1/meetings/"+ended+"/start")
            .principal(as(bob)).header(HttpHeaders.IF_MATCH,etag(committed)))
            .andExpect(status().isOk()).andReturn();
        mvc.perform(post("/api/v1/meetings/"+ended+"/end")
            .principal(as(bob)).header(HttpHeaders.IF_MATCH,etag(started)))
            .andExpect(status().isOk());

        assertThat(ids(list(alice,"relationship","PARTICIPANT","status","CANCELLED")))
            .containsExactly(cancelled);
        assertThat(ids(list(alice,"relationship","PARTICIPANT","status","ENDED")))
            .containsExactly(ended);
        assertThat(ids(list(alice,"relationship","PARTICIPANT")))
            .containsExactlyInAnyOrder(cancelled,ended);
    }

    @Test void malformedFilterCannotSilentlyReturnAllMeetingsAndInactiveAccountsCannotList()
            throws Exception {
        create(alice,"Private meeting");
        mvc.perform(get("/api/v1/meetings").principal(as(alice))
            .param("relationship","OWNER")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/meetings").principal(as(alice))
            .param("relationship","participant")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/meetings").principal(as(alice))
            .param("relationship","PARTICIPANT").param("size","101"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/v1/meetings").principal(as(alice))
            .param("relationship","PARTICIPANT").param("sort","unknown,asc"))
            .andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/meetings").principal(as(alice))
            .param("relationship","PARTICIPANT").param("from","2030-06-11T00:00:00Z")
            .param("to","2030-06-10T00:00:00Z"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/v1/meetings").param("relationship","ORGANIZER"))
            .andExpect(status().isUnauthorized());
        jdbc.update("""
            UPDATE users SET account_status='INACTIVE',deactivated_at=CURRENT_TIMESTAMP
             WHERE id=?
            """,alice);
        mvc.perform(get("/api/v1/meetings").principal(as(alice))
            .param("relationship","ORGANIZER"))
            .andExpect(status().isUnauthorized());
    }
}
