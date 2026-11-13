package com.sme.meetingassistant.api.assistant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.sme.meetingassistant.api.assistant.AssistantModels.Ask;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Real PostgreSQL contention, quota, rollback and lease-fencing coverage. */
@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.assistant.enabled=true",
    "app.media.outbox.enabled=false",
    "app.assistant.admission.max-ask-requests-per-user=3",
    "app.assistant.admission.ask-window-seconds=600",
    "app.assistant.admission.max-active-turns-per-user=2",
    "app.assistant.admission.max-active-turns-global=3",
    "app.assistant.admission.max-active-turns-per-meeting=2",
    "app.assistant.admission.max-conversation-creations-per-user=2",
    "app.assistant.admission.conversation-creation-window-seconds=3600"
})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class AssistantAdmissionIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired PlatformTransactionManager transactionManager;
    @Autowired AssistantStore store;
    @Autowired AssistantAdmissionGuard admission;
    @Autowired AssistantAdmissionProperties properties;
    @Autowired AssistantAdmissionMetrics metrics;
    @Autowired MeterRegistry meterRegistry;
    @MockitoBean AssistantAiGateway gateway;
    @MockitoBean AssistantSourceVerifier sourceVerifier;

    @BeforeEach
    void resetProvider() {
        reset(gateway, sourceVerifier);
    }

    @Test
    void tenConcurrentConversationsForOneUserNeverHoldMoreThanTwoTurns() throws Exception {
        UUID owner = user();
        List<UUID> conversations = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            UUID meeting = meeting(owner);
            conversations.add(conversation(owner, meeting));
        }
        BlockingProvider provider = blockingProvider(2);
        double rejectedBefore = rejected("USER_CONCURRENCY");
        List<Callable<Integer>> requests = new ArrayList<>();
        for (int i = 0; i < conversations.size(); i++) {
            UUID current = conversations.get(i);
            int requestNumber = i;
            requests.add(() -> submit(owner, current, "user-race-" + requestNumber).getResponse().getStatus());
        }

        try (ConcurrentRequests running = launch(requests)) {
            assertThat(provider.entered().await(20, TimeUnit.SECONDS)).isTrue();
            assertThat(activeTurns()).isEqualTo(2L);
            awaitRejections("USER_CONCURRENCY", rejectedBefore, 8);
            provider.release().countDown();
            List<Integer> statuses = running.results();
            assertThat(statuses).containsExactlyInAnyOrder(200, 200, 429, 429, 429, 429, 429, 429, 429, 429);
        }
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM assistant_turns t
              JOIN assistant_conversations c ON c.id=t.conversation_id
             WHERE c.user_id=?
            """, Long.class, owner)).isEqualTo(2L);
        verify(gateway, times(2)).answer(anyString());
    }

    @Test
    void competingUsersCannotExceedGlobalActiveCapacity() throws Exception {
        BlockingProvider provider = blockingProvider(3);
        double rejectedBefore = rejected("GLOBAL_CONCURRENCY");
        List<Callable<Integer>> requests = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            UUID owner = user();
            UUID meeting = meeting(owner);
            UUID conversation = conversation(owner, meeting);
            int requestNumber = i;
            requests.add(() -> submit(owner, conversation, "global-race-" + requestNumber)
                .getResponse().getStatus());
        }

        try (ConcurrentRequests running = launch(requests)) {
            assertThat(provider.entered().await(20, TimeUnit.SECONDS)).isTrue();
            assertThat(activeTurns()).isEqualTo(3L);
            awaitRejections("GLOBAL_CONCURRENCY", rejectedBefore, 1);
            provider.release().countDown();
            assertThat(running.results()).containsExactlyInAnyOrder(200, 200, 200, 429);
        }
        verify(gateway, times(3)).answer(anyString());
    }

    @Test
    void sameMeetingCapacityIsEnforcedBeforeGlobalCapacity() throws Exception {
        UUID owner = user();
        UUID memberOne = user();
        UUID memberTwo = user();
        UUID memberThree = user();
        UUID meeting = meeting(owner, memberOne, memberTwo, memberThree);
        UUID[] users = {owner, memberOne, memberTwo, memberThree};
        List<UUID> conversations = new ArrayList<>();
        for (UUID current : users) conversations.add(conversation(current, meeting));

        BlockingProvider provider = blockingProvider(2);
        double rejectedBefore = rejected("MEETING_CONCURRENCY");
        List<Callable<Integer>> requests = new ArrayList<>();
        for (int i = 0; i < users.length; i++) {
            UUID currentUser = users[i];
            UUID currentConversation = conversations.get(i);
            int requestNumber = i;
            requests.add(() -> submit(currentUser, currentConversation, "meeting-race-" + requestNumber)
                .getResponse().getStatus());
        }

        try (ConcurrentRequests running = launch(requests)) {
            assertThat(provider.entered().await(20, TimeUnit.SECONDS)).isTrue();
            assertThat(activeTurns()).isEqualTo(2L);
            awaitRejections("MEETING_CONCURRENCY", rejectedBefore, 2);
            provider.release().countDown();
            assertThat(running.results()).containsExactlyInAnyOrder(200, 200, 429, 429);
        }
        verify(gateway, times(2)).answer(anyString());
    }

    @Test
    void independentGuardInstancesSharePostgresCapacityAtTheBoundary() throws Exception {
        UUID owner = user();
        List<UUID> meetings = new ArrayList<>();
        List<UUID> conversations = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            UUID currentMeeting = meeting(owner);
            meetings.add(currentMeeting);
            conversations.add(conversation(owner, currentMeeting));
        }
        AssistantAdmissionGuard secondInstance = new AssistantAdmissionGuard(jdbc, properties, metrics);
        TransactionTemplate transactions = new TransactionTemplate(transactionManager);
        List<Callable<Integer>> attempts = new ArrayList<>();
        for (int i = 0; i < conversations.size(); i++) {
            int attempt = i;
            AssistantAdmissionGuard guard = i % 2 == 0 ? admission : secondInstance;
            attempts.add(() -> {
                try {
                    Boolean accepted = transactions.execute(status -> {
                        guard.lockAskScope(owner, meetings.get(attempt));
                        guard.ensureAskQuota(owner);
                        guard.ensureActiveCapacity(owner, meetings.get(attempt));
                        var turn = store.insertTurn(conversations.get(attempt), "guard-race-" + attempt,
                            WorkerJson.sha256(("question-" + attempt).getBytes()), "question-" + attempt,
                            "test-scope");
                        guard.recordAsk(owner, turn.id());
                        return true;
                    });
                    return Boolean.TRUE.equals(accepted) ? 1 : 0;
                } catch (AssistantAdmissionGuard.Rejected rejected) {
                    return 0;
                }
            });
        }

        try (ConcurrentRequests running = launch(attempts)) {
            assertThat(running.results()).containsExactlyInAnyOrder(1, 1, 0, 0, 0, 0, 0, 0, 0, 0);
        } finally {
            jdbc.update("UPDATE assistant_turns SET claim_expires_at=clock_timestamp()-interval '1 second' "
                + "WHERE conversation_id IN (" + String.join(",", conversations.stream()
                    .map(id -> "'" + id + "'").toList()) + ")");
        }
        assertThat(activeTurns()).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_admission_events WHERE user_id=? "
            + "AND event_type='ASK'", Long.class, owner)).isEqualTo(2L);
    }

    @Test
    void askQuotaIsRollingIdempotentAndRejectedRequestDoesNotCreateTurn() throws Exception {
        UUID owner = user();
        UUID conversation = conversation(owner, meeting(owner));
        fastProvider();

        for (int i = 0; i < 3; i++) {
            assertThat(submit(owner, conversation, "quota-key-" + i).getResponse().getStatus()).isEqualTo(200);
        }
        MvcResult limited = submit(owner, conversation, "quota-key-3");
        assertRateLimited(limited);
        assertThat(submit(owner, conversation, "quota-key-0").getResponse().getStatus()).isEqualTo(200);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_turns WHERE conversation_id=?",
            Long.class, conversation)).isEqualTo(3L);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_admission_events WHERE user_id=? "
            + "AND event_type='ASK'", Long.class, owner)).isEqualTo(3L);
        verify(gateway, times(3)).answer(anyString());
    }

    @Test
    void oldAskEventsLeaveTheRollingWindow() throws Exception {
        UUID owner = user();
        UUID conversation = conversation(owner, meeting(owner));
        fastProvider();
        for (int i = 0; i < 3; i++) submit(owner, conversation, "window-key-" + i);
        jdbc.update("UPDATE assistant_admission_events SET occurred_at=clock_timestamp()-interval '600 seconds' "
            + "WHERE user_id=? AND event_type='ASK'", owner);

        assertThat(submit(owner, conversation, "window-key-3").getResponse().getStatus()).isEqualTo(200);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_admission_events WHERE user_id=? "
            + "AND event_type='ASK'", Long.class, owner)).isEqualTo(4L);
    }

    @Test
    void conversationCreationQuotaIsTransactionalAndUsesCanonical429Contract() throws Exception {
        UUID owner = user();
        UUID meeting = meeting(owner);
        for (int i = 0; i < 2; i++) {
            assertThat(create(owner, meeting).getResponse().getStatus()).isEqualTo(201);
        }
        MvcResult limited = create(owner, meeting);
        assertRateLimited(limited);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_conversations WHERE user_id=?",
            Long.class, owner)).isEqualTo(2L);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_admission_events WHERE user_id=? "
            + "AND event_type='CONVERSATION_CREATE'", Long.class, owner)).isEqualTo(2L);
    }

    @Test
    void rolledBackConversationCreationLeavesNoConversationOrQuotaEvent() throws Exception {
        UUID owner = user();
        UUID meeting = meeting(owner);
        TransactionTemplate transactions = new TransactionTemplate(transactionManager);
        assertThatThrownBy(() -> transactions.execute(status -> {
            admission.lockConversationCreationScope(owner);
            admission.ensureConversationCreationQuota(owner);
            var saved = store.create(UUID.randomUUID(), owner, meeting, "rolled back");
            admission.recordConversationCreation(owner, saved.id());
            throw new IllegalStateException("intentional admission rollback");
        })).isInstanceOf(IllegalStateException.class);

        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_conversations WHERE user_id=?",
            Long.class, owner)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_admission_events WHERE user_id=?",
            Long.class, owner)).isZero();
        assertThat(create(owner, meeting).getResponse().getStatus()).isEqualTo(201);
    }

    @Test
    void expiredReclaimReusesTheExistingQuotaEvent() throws Exception {
        UUID owner = user();
        UUID meeting = meeting(owner);
        UUID conversation = conversation(owner, meeting);
        TransactionTemplate transactions = new TransactionTemplate(transactionManager);
        AssistantStore.Turn original = transactions.execute(status -> {
            admission.lockAskScope(owner, meeting);
            admission.ensureAskQuota(owner);
            admission.ensureActiveCapacity(owner, meeting);
            var turn = store.insertTurn(conversation, "reclaim-key",
                WorkerJson.sha256("Question reclaim-key".getBytes()), "Question reclaim-key", "test-scope");
            admission.recordAsk(owner, turn.id());
            return turn;
        });
        jdbc.update("UPDATE assistant_turns SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",
            original.id());
        fastProvider();

        assertThat(submit(owner, conversation, "reclaim-key").getResponse().getStatus()).isEqualTo(200);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_admission_events WHERE user_id=? "
            + "AND event_type='ASK'", Long.class, owner)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_turns WHERE id=? AND state='COMPLETED'",
            Long.class, original.id())).isEqualTo(1L);
        verify(gateway, times(1)).answer(anyString());
    }

    @Test
    void staleClaimCannotFinalizeAfterReclaim() throws Exception {
        UUID owner = user();
        UUID meeting = meeting(owner);
        UUID conversation = conversation(owner, meeting);
        TransactionTemplate transactions = new TransactionTemplate(transactionManager);
        AssistantStore.Turn original = transactions.execute(status ->
            store.insertTurn(conversation, "fence-key",
                WorkerJson.sha256("fence question".getBytes()), "fence question", "test-scope"));
        jdbc.update("UPDATE assistant_turns SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",
            original.id());
        AssistantStore.Turn reclaimed = transactions.execute(status -> {
            store.require(conversation, owner, true);
            return store.reclaim(original);
        });
        var failed = new AssistantModels.ValidatedAnswer("FAILED", "Unavailable",
            WorkerJson.MAPPER.createArrayNode(), WorkerJson.MAPPER.createObjectNode(), null, List.of(), List.of());

        assertThatThrownBy(() -> transactions.executeWithoutResult(status ->
            store.saveCompleted(original, original.token(), failed)))
            .isInstanceOf(AssistantStore.StaleTurn.class);
        transactions.executeWithoutResult(status -> store.saveCompleted(reclaimed, reclaimed.token(), failed));
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_messages WHERE conversation_id=? "
            + "AND role='ASSISTANT'", Long.class, conversation)).isEqualTo(1L);
    }

    private void fastProvider() throws Exception {
        when(gateway.answer(anyString())).thenAnswer(invocation -> answer(invocation.getArgument(0)));
    }

    private BlockingProvider blockingProvider(int capacity) throws Exception {
        CountDownLatch entered = new CountDownLatch(capacity);
        CountDownLatch release = new CountDownLatch(1);
        when(gateway.answer(anyString())).thenAnswer(invocation -> {
            entered.countDown();
            if (!release.await(20, TimeUnit.SECONDS)) {
                throw new IllegalStateException("test provider release timed out");
            }
            return answer(invocation.getArgument(0));
        });
        return new BlockingProvider(entered, release);
    }

    private MvcResult submit(UUID owner, UUID conversation, String key) throws Exception {
        return mvc.perform(post("/api/v1/assistant/conversations/" + conversation + "/messages")
            .principal(principal(owner)).header("Idempotency-Key", key)
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(new Ask("Question " + key))))
            .andReturn();
    }

    private MvcResult create(UUID owner, UUID meeting) throws Exception {
        return mvc.perform(post("/api/v1/assistant/conversations").principal(principal(owner))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("meetingId", meeting, "title", "Quota test"))))
            .andReturn();
    }

    private String answer(String request) throws Exception {
        JsonNode input = json.readTree(request);
        return json.writeValueAsString(Map.of(
            "contractVersion", "1.0",
            "requestId", input.path("requestId").asText(),
            "status", "INSUFFICIENT_EVIDENCE",
            "answer", "No evidence is available.",
            "scopeId", input.path("authorizedScope").path("scopeId").asText(),
            "scopeVersion", input.path("authorizedScope").path("scopeVersion").asText(),
            "claims", List.of(), "citations", List.of(), "diagnostics", Map.of(), "failures", List.of()));
    }

    private void assertRateLimited(MvcResult result) throws Exception {
        assertThat(result.getResponse().getStatus()).isEqualTo(429);
        JsonNode body = json.readTree(result.getResponse().getContentAsString());
        assertThat(body.path("code").asText()).isEqualTo("RATE_LIMIT_EXCEEDED");
        assertThat(result.getResponse().getHeader(HttpHeaders.RETRY_AFTER)).isNotBlank();
        assertThat(result.getResponse().getHeader(HttpHeaders.CACHE_CONTROL)).contains("no-store");
        assertThat(result.getResponse().getContentAsString()).doesNotContain("assistant-admission|", "userId");
    }

    private long activeTurns() {
        return jdbc.queryForObject("""
            SELECT count(*) FROM assistant_turns
             WHERE state='PROCESSING' AND claim_expires_at > clock_timestamp()
            """, Long.class);
    }

    private double rejected(String reason) {
        return meterRegistry.counter("sme.assistant.admission.rejected", "reason", reason).count();
    }

    private void awaitRejections(String reason, double baseline, int amount) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (rejected(reason) - baseline < amount && System.nanoTime() < deadline) {
            Thread.onSpinWait();
        }
        assertThat(rejected(reason) - baseline).isGreaterThanOrEqualTo(amount);
    }

    private UUID user() {
        UUID id = UUID.randomUUID();
        String email = id + "@assistant-admission.test";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Admission actor','test-only','EMPLOYEE','ACTIVE')
            """, id, email, email);
        return id;
    }

    private UUID meeting(UUID owner, UUID... members) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'Admission test',?,?)",
            id, owner, owner);
        for (UUID member : members) {
            jdbc.update("""
                INSERT INTO meeting_participants(id,meeting_id,user_id,added_by_user_id)
                VALUES (?,?,?,?)
                """, UUID.randomUUID(), id, member, owner);
        }
        return id;
    }

    private UUID conversation(UUID owner, UUID meeting) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO assistant_conversations(id,user_id,meeting_id,title,status)
            VALUES (?,?,?,'Admission fixture','ACTIVE')
            """, id, owner, meeting);
        return id;
    }

    private static Principal principal(UUID id) {
        return () -> id.toString();
    }

    private ConcurrentRequests launch(List<Callable<Integer>> calls) throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(calls.size());
        CountDownLatch ready = new CountDownLatch(calls.size());
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Integer>> futures = new ArrayList<>();
        try {
            for (Callable<Integer> call : calls) {
                futures.add(executor.submit(() -> {
                    ready.countDown();
                    if (!start.await(20, TimeUnit.SECONDS)) throw new IllegalStateException("start barrier timed out");
                    return call.call();
                }));
            }
            if (!ready.await(20, TimeUnit.SECONDS)) throw new IllegalStateException("ready barrier timed out");
            start.countDown();
            return new ConcurrentRequests(executor, futures);
        } catch (Exception failure) {
            start.countDown();
            executor.shutdownNow();
            throw failure;
        }
    }

    private record BlockingProvider(CountDownLatch entered, CountDownLatch release) {}

    private static final class ConcurrentRequests implements AutoCloseable {
        private final ExecutorService executor;
        private final List<Future<Integer>> futures;

        private ConcurrentRequests(ExecutorService executor, List<Future<Integer>> futures) {
            this.executor = executor;
            this.futures = futures;
        }

        private List<Integer> results() throws Exception {
            List<Integer> results = new ArrayList<>();
            for (Future<Integer> future : futures) results.add(future.get(30, TimeUnit.SECONDS));
            return results;
        }

        @Override
        public void close() throws Exception {
            executor.shutdownNow();
            if (!executor.awaitTermination(20, TimeUnit.SECONDS)) {
                throw new IllegalStateException("concurrent test executor did not terminate");
            }
        }
    }
}
