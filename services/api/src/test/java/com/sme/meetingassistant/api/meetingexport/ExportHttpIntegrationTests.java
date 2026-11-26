package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meetingminutes.MinutesAssembler;
import com.sme.meetingassistant.api.meetingminutes.MinutesSnapshot;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Live MVC/security/PG/idempotency boundary for opt-in DE09 contracts.
 * Only Minutes assembly is stubbed to isolate this HTTP admission task.
 */
@ActiveProfiles("test")
@SpringBootTest(properties={
    "app.exports.worker.enabled=true",
    "app.exports.worker.poll-delay-ms=3600000",
    "app.exports.public-admission-enabled=true",
    "app.media.outbox.enabled=false"
})
@AutoConfigureMockMvc
@Import({PostgresTestConfiguration.class, ExportHttpIntegrationTests.TestStorage.class})
class ExportHttpIntegrationTests {
    @TestConfiguration(proxyBeanMethods=false)
    static class TestStorage {
        @Bean @Primary
        ExportJobIntegrationTests.InMemoryExportStore exportTestStore() {
            return new ExportJobIntegrationTests.InMemoryExportStore();
        }
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @MockitoBean MinutesAssembler minutes;

    @Test
    void authorizedPostCreatesDurableJobAndScopedStatusNeverLeaksStorageKeys()
            throws Exception {
        UUID organizer=user("EMPLOYEE"), outsider=user("EMPLOYEE");
        UUID target=meeting(organizer);
        when(minutes.current(target)).thenReturn(snapshot(target, organizer, "COMPLETE"));
        MvcResult create=mvc.perform(post("/api/v1/meetings/{id}/exports",target)
                .principal(principal(organizer)).contentType(MediaType.APPLICATION_JSON)
                .header("Idempotency-Key","http-create")
                .content("{\"format\":\"MARKDOWN\"}"))
                .andExpect(status().isAccepted()).andReturn();
        JsonNode response=json.readTree(create.getResponse().getContentAsString());
        UUID exportId=UUID.fromString(response.path("data").path("exportId").asText());
        assertThat(response.path("success").asBoolean()).isTrue();
        assertThat(create.getResponse().getHeader(HttpHeaders.CACHE_CONTROL))
                .contains("no-store");

        MvcResult readable=mvc.perform(get("/api/v1/exports/{id}",exportId)
                .principal(principal(organizer)))
                .andExpect(status().isOk()).andReturn();
        String publicJson=readable.getResponse().getContentAsString();
        assertThat(json.readTree(publicJson).path("data").path("retryEligible").isBoolean()).isTrue();
        assertThat(publicJson).contains(exportId.toString())
                .doesNotContain("objectKey","snapshotObjectKey","claimToken",
                        "artifactSha256","intakeSha256");
        mvc.perform(get("/api/v1/exports/{id}",exportId)
                .principal(principal(outsider)))
                .andExpect(status().isNotFound());
    }

    @Test
    void replayPreservesImmutableIntentAndChangedCompletenessCannotCreateNewOne()
            throws Exception {
        UUID actor=user("EMPLOYEE"),target=meeting(actor);
        var complete=snapshot(target,actor,"COMPLETE");
        var partial=snapshot(target,actor,"PARTIAL");
        when(minutes.current(target)).thenReturn(complete,partial);
        String url="/api/v1/meetings/"+target+"/exports";
        MvcResult first=mvc.perform(post(url).principal(principal(actor))
                .header("Idempotency-Key","http-replay")
                .contentType(MediaType.APPLICATION_JSON).content("{\"format\":\"PDF\"}"))
                .andExpect(status().isAccepted()).andReturn();
        MvcResult replay=mvc.perform(post(url).principal(principal(actor))
                .header("Idempotency-Key","http-replay")
                .contentType(MediaType.APPLICATION_JSON).content("{\"format\":\"PDF\"}"))
                .andExpect(status().isAccepted()).andReturn();
        assertThat(json.readTree(replay.getResponse().getContentAsString())
                .path("data").path("exportId").asText()).isEqualTo(
                        json.readTree(first.getResponse().getContentAsString())
                                .path("data").path("exportId").asText());
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_exports WHERE meeting_id=?",
                Long.class,target)).isEqualTo(1L);
    }

    @Test
    void incompleteMinutesAndUnrelatedActorCannotCreatePublicExport()
            throws Exception {
        UUID organizer=user("EMPLOYEE"),other=user("EMPLOYEE"),target=meeting(organizer);
        when(minutes.current(target)).thenReturn(snapshot(target,organizer,"PARTIAL"));
        String url="/api/v1/meetings/"+target+"/exports";
        mvc.perform(post(url).principal(principal(organizer))
                .header("Idempotency-Key","incomplete")
                .contentType(MediaType.APPLICATION_JSON).content("{\"format\":\"PDF\"}"))
                .andExpect(status().isConflict());
        mvc.perform(post(url).principal(principal(other))
                .header("Idempotency-Key","wrong-owner")
                .contentType(MediaType.APPLICATION_JSON).content("{\"format\":\"PDF\"}"))
                .andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_exports WHERE meeting_id=?",
                Long.class,target)).isZero();
    }

    @Test
    void recoveryIsReadOnlyAndDoesNotRequireCurrentCompleteMinutes() throws Exception {
        UUID actor=user("EMPLOYEE"), outsider=user("EMPLOYEE"), target=meeting(actor);
        when(minutes.current(target)).thenReturn(snapshot(target,actor,"COMPLETE"));
        String url="/api/v1/meetings/"+target+"/exports";
        String recover=url+"/recover";
        String body="{\"format\":\"PDF\"}";
        MvcResult original=mvc.perform(post(url).principal(principal(actor))
                .header("Idempotency-Key","recover-only")
                .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isAccepted()).andReturn();
        String exportId=json.readTree(original.getResponse().getContentAsString())
                .path("data").path("exportId").asText();

        when(minutes.current(target)).thenThrow(new IllegalStateException("Minutes unavailable"));
        MvcResult replay=mvc.perform(post(recover).principal(principal(actor))
                .header("Idempotency-Key","recover-only")
                .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk()).andReturn();
        var recovered=json.readTree(replay.getResponse().getContentAsString()).path("data");
        assertThat(recovered.path("outcome").asText()).isEqualTo("RECOVERED");
        assertThat(recovered.path("admission").path("exportId").asText()).isEqualTo(exportId);

        mvc.perform(post(recover).principal(principal(outsider))
                .header("Idempotency-Key","recover-only")
                .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isNotFound());
        mvc.perform(post(recover).principal(principal(actor))
                .header("Idempotency-Key","recover-only")
                .contentType(MediaType.APPLICATION_JSON).content("{\"format\":\"MARKDOWN\"}"))
                .andExpect(status().isConflict());

        jdbc.update("""
            UPDATE meeting_export_idempotency
               SET created_at=clock_timestamp()-INTERVAL '48 hours',
                   expires_at=clock_timestamp()-INTERVAL '1 hour'
             WHERE export_id=?
            """,UUID.fromString(exportId));
        for (String key: List.of("recover-only","never-admitted")) {
            MvcResult missing=mvc.perform(post(recover).principal(principal(actor))
                    .header("Idempotency-Key",key)
                    .contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isOk()).andReturn();
            assertThat(json.readTree(missing.getResponse().getContentAsString())
                    .path("data").path("outcome").asText()).isEqualTo("UNAVAILABLE");
        }
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_exports WHERE meeting_id=?",
                Long.class,target)).isEqualTo(1L);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_export_intakes WHERE meeting_id=?",
                Long.class,target)).isEqualTo(1L);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_export_idempotency WHERE meeting_id=?",
                Long.class,target)).isLessThanOrEqualTo(1L);
    }

    @Test
    void capabilityReadIsMeetingAuthorizedAndReflectsEnabledRoutes() throws Exception {
        UUID actor=user("EMPLOYEE"), other=user("EMPLOYEE"), target=meeting(actor);
        String url="/api/v1/meetings/"+target+"/exports/capabilities";
        MvcResult response=mvc.perform(get(url).principal(principal(actor)))
                .andExpect(status().isOk()).andReturn();
        var data=json.readTree(response.getResponse().getContentAsString()).path("data");
        assertThat(data.path("meetingId").asText()).isEqualTo(target.toString());
        for (String field: List.of("admission","recovery","status","access")) {
            assertThat(data.path(field).asBoolean()).isTrue();
        }
        assertThat(response.getResponse().getHeader(HttpHeaders.CACHE_CONTROL)).contains("no-store");
        mvc.perform(get(url).principal(principal(other))).andExpect(status().isNotFound());
    }

    private MinutesSnapshot snapshot(UUID id,UUID owner,String completeness) throws Exception {
        OffsetDateTime now=OffsetDateTime.parse("2026-11-07T12:00:00Z");
        var meeting=new MinutesSnapshot.Meeting(id,"Thảo luận sprint",null,owner,
                MeetingStatus.DRAFT,null,null,null,null);
        UUID tid=UUID.randomUUID();
        var summary=new MinutesSnapshot.Summary("AVAILABLE",UUID.randomUUID(),1,
                "Nội dung được duyệt","HUMAN_EDIT","READY",tid,1L,1L,false,List.of());
        var transcript=new MinutesSnapshot.Transcript("AVAILABLE",tid,UUID.randomUUID(),
                1,"vi","READY",1L,60000L,0,0,0);
        var canonical=new MinutesSnapshot.CanonicalContent(1,completeness,meeting,
                summary,List.of(),List.of(),transcript,List.of(),false);
        String digest=ExportSnapshotCodec.sha256(json.writeValueAsBytes(canonical));
        return new MinutesSnapshot(1,now,digest,completeness,meeting,
                summary,List.of(),List.of(),transcript,List.of(),false);
    }

    private UUID user(String role) {
        UUID id=UUID.randomUUID();
        String email="de09-http-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                              global_role,account_status)
            VALUES(?,?,?,'DE09 http actor','test-only',?,'ACTIVE')
            """,id,email,email,role);
        return id;
    }

    private UUID meeting(UUID organizer) {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES(?,'DE09 http fixture',?,?,'DRAFT')
            """,id,organizer,organizer);
        return id;
    }

    private static Principal principal(UUID id) { return () -> id.toString(); }
}
