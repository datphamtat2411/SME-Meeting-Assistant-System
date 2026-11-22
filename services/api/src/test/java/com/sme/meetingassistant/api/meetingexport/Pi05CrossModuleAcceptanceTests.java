package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.assistant.AssistantAiGateway;
import com.sme.meetingassistant.api.meetingminutes.MinutesAssembler;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * PI-05 integration acceptance: real HTTP, authorization, Core Assistant,
 * export lifecycle, and PostgreSQL/Flyway. Only external AI inference and the
 * S3 presigning boundary are controlled. This is NOT a real Core/AI/Qdrant E2E test.
 */
@ActiveProfiles("test")
@SpringBootTest(properties={
    "app.assistant.enabled=true",
    "app.exports.worker.enabled=true",
    "app.exports.worker.poll-delay-ms=3600000",
    "app.exports.public-admission-enabled=true",
    "app.exports.download.ttl-seconds=45",
    "app.media.outbox.enabled=false"
})
@AutoConfigureMockMvc
@Import({PostgresTestConfiguration.class, Pi05CrossModuleAcceptanceTests.StorageWiring.class})
class Pi05CrossModuleAcceptanceTests {
    @TestConfiguration(proxyBeanMethods=false)
    static class StorageWiring {
        @Bean @Primary
        ControlledDownloadStore pi05DownloadStore() { return new ControlledDownloadStore(); }
    }

    static final class ControlledDownloadStore implements ExportDownloadStore {
        final AtomicInteger calls=new AtomicInteger();
        @Override
        public String createVerifiedCapability(ExportRecord record, Duration ttl) {
            calls.incrementAndGet();
            return "https://private.example.invalid/exp/" + record.id()
                + "?X-Amz-Signature=fixture-only";
        }
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ExportIntentService intents;
    @Autowired ExportGenerationStateMachine state;
    @Autowired ControlledDownloadStore downloads;
    @MockitoBean AssistantAiGateway aiGateway;
    @MockitoBean MinutesAssembler minutes;

    @BeforeEach
    void resetExportQueue() {
        downloads.calls.set(0);
        // Prevent a pending export from another case taking the single worker
        // claim. Do not mutate unrelated canonical meeting/assistant data.
        for (int i=0;i<100;i++) {
            var pending=state.claimNext(60);
            if (pending.isEmpty()) return;
            state.fail(pending.get().id(),pending.get().claimToken(),"PI05_FIXTURE_CLEANUP");
        }
        throw new IllegalStateException("Unexpected PI-05 export fixture backlog");
    }

    @Test
    void meetingMembershipRevocationBlocksAssistantHistoryAndExportAccessTogether()
            throws Exception {
        UUID organizer=user("EMPLOYEE"),member=user("EMPLOYEE"),admin=user("ADMINISTRATOR");
        UUID meeting=meeting(organizer);
        jdbc.update("""
            INSERT INTO meeting_participants(id,meeting_id,user_id,added_by_user_id)
            VALUES (?,?,?,?)
            """,UUID.randomUUID(),meeting,member,organizer);
        UUID conversation=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO assistant_conversations(id,user_id,meeting_id,title)
            VALUES (?,?,?,'PI05 protected conversation')
            """,conversation,member,meeting);
        UUID export=ready(organizer,meeting);

        mvc.perform(get("/api/v1/assistant/conversations/{id}",conversation)
                .principal(as(member))).andExpect(status().isOk());
        mvc.perform(get("/api/v1/exports/{id}",export)
                .principal(as(member))).andExpect(status().isOk());
        mvc.perform(post("/api/v1/exports/{id}/access-url",export)
                .principal(as(member))).andExpect(status().isOk());
        assertThat(downloads.calls.get()).isEqualTo(1);

        // A global administrator is not a privileged meeting-content reader.
        mvc.perform(post("/api/v1/exports/{id}/access-url",export)
                .principal(as(admin))).andExpect(status().isNotFound());

        jdbc.update("""
            UPDATE meeting_participants SET removed_at=clock_timestamp()
             WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """,meeting,member);

        mvc.perform(get("/api/v1/assistant/conversations/{id}",conversation)
                .principal(as(member))).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/exports/{id}",export)
                .principal(as(member))).andExpect(status().isNotFound());
        mvc.perform(post("/api/v1/exports/{id}/access-url",export)
                .principal(as(member))).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/meetings/{id}/summary",meeting)
                .principal(as(member))).andExpect(status().isNotFound());
        assertThat(downloads.calls.get()).isEqualTo(1);

        // Revocation is forward-looking: it must not erase the historical
        // conversation, export or the organizer's own access.
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM assistant_conversations WHERE id=?
            """,Integer.class,conversation)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT status FROM meeting_exports WHERE id=?
            """,String.class,export)).isEqualTo("READY");
        mvc.perform(post("/api/v1/exports/{id}/access-url",export)
                .principal(as(organizer))).andExpect(status().isOk());
        assertThat(downloads.calls.get()).isEqualTo(2);
    }

    private UUID ready(UUID owner,UUID meeting) {
        var pending=as(owner,()->intents.create(meeting,ExportFormat.PDF,
            "pi05-"+UUID.randomUUID()));
        var claim=state.claimNext(60).orElseThrow();
        assertThat(claim.id()).isEqualTo(pending.id());
        assertThat(state.pinSnapshot(claim.id(),claim.claimToken(),
            "a".repeat(64),"pi05-renderer-v1")).isTrue();
        assertThat(state.publishReady(claim.id(),claim.claimToken(),
            "b".repeat(64),1024)).isTrue();
        return claim.id();
    }

    private UUID user(String role) {
        UUID id=UUID.randomUUID();
        String email="pi05-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                global_role,account_status)
            VALUES (?,?,?,'PI05 actor','test-only',?,'ACTIVE')
            """,id,email,email,role);
        return id;
    }

    private UUID meeting(UUID organizer) {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES (?,'PI05 acceptance',?,?,'DRAFT')
            """,id,organizer,organizer);
        return id;
    }

    private static Principal as(UUID actor) { return ()->actor.toString(); }

    private static <T> T as(UUID actor, Supplier<T> action) {
        RequestAttributes previous=RequestContextHolder.getRequestAttributes();
        MockHttpServletRequest request=new MockHttpServletRequest();
        request.setUserPrincipal(as(actor));
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        try { return action.get(); }
        finally {
            if (previous==null) RequestContextHolder.resetRequestAttributes();
            else RequestContextHolder.setRequestAttributes(previous);
        }
    }
}
