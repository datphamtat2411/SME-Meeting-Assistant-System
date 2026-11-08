package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.meetingminutes.MinutesAssembler;
import com.sme.meetingassistant.api.meetingminutes.MinutesSnapshot;
import java.security.Principal;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * DE-10: PostgreSQL V35/V36 + MVC + real authorization. Only the network
 * object-signing boundary is simulated; separate MinIO tests cover AWS S3.
 */
@ActiveProfiles("test")
@SpringBootTest(properties={
        "app.exports.worker.enabled=true",
        "app.exports.worker.poll-delay-ms=3600000",
        "app.exports.public-admission-enabled=true",
        "app.exports.download.ttl-seconds=45",
        "app.media.outbox.enabled=false"
})
@AutoConfigureMockMvc
@Import({PostgresTestConfiguration.class, ExportAccessHttpIntegrationTests.Wiring.class})
class ExportAccessHttpIntegrationTests {

    @TestConfiguration(proxyBeanMethods=false)
    static class Wiring {
        @Bean @Primary
        TestDownloadStore controlledDownloadStore() {
            return new TestDownloadStore();
        }
    }

    static final class TestDownloadStore implements ExportDownloadStore {
        final AtomicInteger calls = new AtomicInteger();
        volatile boolean tampered;
        volatile boolean missing;
        volatile boolean insecure;
        volatile Runnable duringStorage;
        volatile ExportRecord lastRecord;
        volatile Duration lastTtl;

        @Override
        public String createVerifiedCapability(ExportRecord record, Duration ttl) {
            calls.incrementAndGet();
            lastRecord = record;
            lastTtl = ttl;
            if (tampered) throw new ExportArtifactStore.IntegrityFailure(
                    "Simulated object checksum mismatch");
            if (missing) throw new ExportArtifactStore.StorageFailure(
                    "Synthetic bucket exception", new IllegalStateException("secret provider details"));
            Runnable callback = duringStorage;
            if (callback != null) {
                duringStorage = null;
                callback.run();
            }
            return (insecure ? "http" : "https")
                    + "://downloads.example.invalid/private/"
                    + record.id() + "?X-Amz-Signature=synthetic-only";
        }

        void reset() {
            calls.set(0);
            tampered = false;
            missing = false;
            insecure = false;
            duringStorage = null;
            lastRecord = null;
            lastTtl = null;
        }
    }

    @Autowired MockMvc mvc;
    @MockitoBean MinutesAssembler minutes;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired MeetingExportRepository records;
    @Autowired ExportIntentService intents;
    @Autowired ExportGenerationStateMachine state;
    @Autowired ExportAccessService accessService;
    @Autowired TestDownloadStore storage;

    @BeforeEach
    void reset() {
        storage.reset();
        for (int i=0; i<100; i++) {
            var outstanding=state.claimNext(60);
            if (outstanding.isEmpty()) return;
            state.fail(outstanding.get().id(), outstanding.get().claimToken(),
                    "TEST_FIXTURE_CLEANUP");
        }
        throw new IllegalStateException("Unexpected DE-10 export fixture backlog");
    }

    @Test
    void onlyCurrentlyAuthorizedReadyExportGetsBoundedHttpsCapability() throws Exception {
        UUID owner=user("EMPLOYEE"), member=user("EMPLOYEE"), admin=user("ADMINISTRATOR");
        UUID target=meeting(owner);
        participant(target,member);
        UUID ready=ready(owner,target,ExportFormat.PDF);

        MvcResult result=mvc.perform(post(endpoint(ready))
                .principal(principal(member)))
                .andExpect(status().isOk()).andReturn();
        assertThat(result.getResponse().getHeader(HttpHeaders.CACHE_CONTROL)).contains("no-store");
        assertThat(result.getResponse().getHeader("Referrer-Policy")).isEqualTo("no-referrer");
        assertThat(result.getResponse().getHeader("Pragma")).isEqualTo("no-cache");
        JsonNode data=json.readTree(result.getResponse().getContentAsString()).path("data");
        assertThat(data.path("accessUrl").asText())
                .startsWith("https://downloads.example.invalid/")
                .contains("X-Amz-Signature=");
        assertThat(data.path("filename").asText())
                .isEqualTo("meeting-minutes-" + ready + ".pdf");
        assertThat(data.path("contentType").asText()).isEqualTo("application/pdf");
        assertThat(data.path("expiresAt").asText()).isNotBlank();
        assertThat(data.path("exportId").asText()).isEqualTo(ready.toString());
        assertThat(data.toString()).doesNotContain("objectKey","claimToken",
                "artifactSha256","snapshotObjectKey","intakeSha256");
        assertThat(storage.lastRecord.id()).isEqualTo(ready);
        assertThat(storage.lastTtl).isEqualTo(Duration.ofSeconds(45));

        // Global administrator role cannot override meeting-content membership.
        mvc.perform(post(endpoint(ready)).principal(principal(admin)))
                .andExpect(status().isNotFound());
        mvc.perform(post(endpoint(UUID.randomUUID())).principal(principal(member)))
                .andExpect(status().isNotFound());
        assertThat(storage.calls.get()).isEqualTo(1);
    }

    @Test
    void pendingAndFailedCannotIssueUrlAndNoStorageOperationOccurs() throws Exception {
        UUID owner=user("EMPLOYEE"),target=meeting(owner);
        UUID pending=as(owner, () -> intents.create(target, ExportFormat.MARKDOWN,
                "pending-de10")).id();
        mvc.perform(post(endpoint(pending)).principal(principal(owner)))
                .andExpect(status().isConflict());
        var claim=state.claimNext(60).orElseThrow();
        assertThat(claim.id()).isEqualTo(pending);
        assertThat(state.fail(pending,claim.claimToken(),"RENDER_FAILED")).isTrue();
        mvc.perform(post(endpoint(pending)).principal(principal(owner)))
                .andExpect(status().isConflict());
        assertThat(storage.calls.get()).isZero();
    }

    @Test
    void permissionRemovalAndInactiveActorImmediatelyBlockNewCapability() throws Exception {
        UUID owner=user("EMPLOYEE"),member=user("EMPLOYEE"),target=meeting(owner);
        participant(target,member);
        UUID id=ready(owner,target,ExportFormat.MARKDOWN);
        mvc.perform(post(endpoint(id)).principal(principal(member)))
                .andExpect(status().isOk());
        jdbc.update("""
            UPDATE meeting_participants SET removed_at=clock_timestamp()
             WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """,target,member);
        mvc.perform(post(endpoint(id)).principal(principal(member)))
                .andExpect(status().isNotFound());
        jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?",owner);
        mvc.perform(post(endpoint(id)).principal(principal(owner)))
                .andExpect(status().isUnauthorized());
        assertThat(storage.calls.get()).isEqualTo(1);
    }

    @Test
    void accessRevalidationDeniesCapabilityRevokedDuringStorageVerification()
            throws Exception {
        UUID owner=user("EMPLOYEE"),member=user("EMPLOYEE"),target=meeting(owner);
        participant(target,member);
        UUID id=ready(owner,target,ExportFormat.PDF);
        storage.duringStorage=()->jdbc.update("""
            UPDATE meeting_participants SET removed_at=clock_timestamp()
             WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """,target,member);
        MvcResult result=mvc.perform(post(endpoint(id)).principal(principal(member)))
                .andExpect(status().isNotFound()).andReturn();
        assertThat(result.getResponse().getContentAsString())
                .doesNotContain("X-Amz-Signature","downloads.example.invalid");
        assertThat(storage.calls.get()).isEqualTo(1);
    }

    @Test
    void storageMissingTamperedAndInsecureUrlNeverExposeSignerSecrets()
            throws Exception {
        UUID actor=user("EMPLOYEE"),target=meeting(actor);
        UUID id=ready(actor,target,ExportFormat.PDF);
        storage.tampered=true;
        MvcResult mismatch=mvc.perform(post(endpoint(id)).principal(principal(actor)))
                .andExpect(status().isServiceUnavailable()).andReturn();
        assertThat(mismatch.getResponse().getContentAsString())
                .doesNotContain("Simulated object","X-Amz-Signature");
        storage.tampered=false;
        storage.missing=true;
        MvcResult missing=mvc.perform(post(endpoint(id)).principal(principal(actor)))
                .andExpect(status().isServiceUnavailable()).andReturn();
        assertThat(missing.getResponse().getContentAsString())
                .doesNotContain("secret provider details");
        storage.missing=false;
        storage.insecure=true;
        MvcResult insecure=mvc.perform(post(endpoint(id)).principal(principal(actor)))
                .andExpect(status().isServiceUnavailable()).andReturn();
        assertThat(insecure.getResponse().getContentAsString())
                .doesNotContain("http://","X-Amz-Signature");
        storage.insecure=false;
        assertThat(storage.calls.get()).isEqualTo(3);
    }

    @Test
    void ttlBoundariesFailFastEvenWhenMisconfigured() {
        assertThatThrownBy(()->new ExportAccessService(
                records,null,null,storage,Clock.systemUTC(),29))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(()->new ExportAccessService(
                records,null,null,storage,Clock.systemUTC(),301))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void sourceRevisionChangeMakesHistoricalReadyExportStaleWithoutMutation()
            throws Exception {
        UUID owner=user("EMPLOYEE"),meetingId=meeting(owner);
        UUID exported=ready(owner,meetingId,ExportFormat.PDF);
        OffsetDateTime time=OffsetDateTime.parse("2026-11-08T00:00:00Z");
        MinutesSnapshot sourceAtExport=new MinutesSnapshot(1,time,
                "a".repeat(64),"COMPLETE",null,null,
                java.util.List.of(),java.util.List.of(),null,java.util.List.of(),false);
        MinutesSnapshot editedSource=new MinutesSnapshot(1,time.plusMinutes(1),
                "c".repeat(64),"COMPLETE",null,null,
                java.util.List.of(),java.util.List.of(),null,java.util.List.of(),false);
        when(minutes.current(meetingId)).thenReturn(sourceAtExport,editedSource);

        MvcResult current=mvc.perform(get("/api/v1/exports/{id}",exported)
                .principal(principal(owner))).andExpect(status().isOk()).andReturn();
        assertThat(json.readTree(current.getResponse().getContentAsString())
                .path("data").path("freshness").asText()).isEqualTo("CURRENT");

        MvcResult stale=mvc.perform(get("/api/v1/exports/{id}",exported)
                .principal(principal(owner))).andExpect(status().isOk()).andReturn();
        JsonNode data=json.readTree(stale.getResponse().getContentAsString()).path("data");
        assertThat(data.path("freshness").asText()).isEqualTo("STALE");
        assertThat(data.path("freshnessCheckedAt").asText()).isNotBlank();

        MvcResult historical=mvc.perform(post(endpoint(exported))
                .principal(principal(owner))).andExpect(status().isOk()).andReturn();
        JsonNode issued=json.readTree(historical.getResponse().getContentAsString())
                .path("data");
        assertThat(issued.path("freshness").asText()).isEqualTo("STALE");
        assertThat(issued.path("accessUrl").asText()).startsWith("https://");
        assertThat(records.require(exported).status()).isEqualTo(ExportStatus.READY);
        assertThat(records.require(exported).sourceFingerprint()).isEqualTo("a".repeat(64));
    }

    private UUID ready(UUID owner,UUID meetingId,ExportFormat format) {
        var pending=as(owner,()->intents.create(meetingId,format,
                "de10-"+UUID.randomUUID()));
        var claim=state.claimNext(60).orElseThrow();
        assertThat(claim.id()).isEqualTo(pending.id());
        assertThat(state.pinSnapshot(claim.id(),claim.claimToken(),
                "a".repeat(64),"de10-renderer-v1")).isTrue();
        assertThat(state.publishReady(claim.id(),claim.claimToken(),
                "b".repeat(64),1234)).isTrue();
        return claim.id();
    }

    private UUID user(String role) {
        UUID id=UUID.randomUUID();
        String email="de10-http-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                global_role,account_status)
            VALUES(?,?,?,'DE10 test actor','test-only',?,'ACTIVE')
            """,id,email,email,role);
        return id;
    }

    private UUID meeting(UUID organizer) {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES(?,'DE10 fixture',?,?,'DRAFT')
            """,id,organizer,organizer);
        return id;
    }

    private void participant(UUID meetingId,UUID userId) {
        jdbc.update("INSERT INTO meeting_participants(id,meeting_id,user_id) VALUES (?,?,?)",
                UUID.randomUUID(),meetingId,userId);
    }

    private static String endpoint(UUID exportId) {
        return "/api/v1/exports/" + exportId + "/access-url";
    }

    private static Principal principal(UUID id) { return () -> id.toString(); }

    private static <T> T as(UUID actor, Supplier<T> op) {
        RequestAttributes old=RequestContextHolder.getRequestAttributes();
        MockHttpServletRequest request=new MockHttpServletRequest();
        request.setUserPrincipal(principal(actor));
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        try {return op.get();}
        finally {
            if (old==null) RequestContextHolder.resetRequestAttributes();
            else RequestContextHolder.setRequestAttributes(old);
        }
    }
}
