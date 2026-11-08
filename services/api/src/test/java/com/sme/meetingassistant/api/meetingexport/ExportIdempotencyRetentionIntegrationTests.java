package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.scheduling.annotation.ScheduledAnnotationBeanPostProcessor;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@ActiveProfiles("test")
@SpringBootTest(properties = {
        "app.media.outbox.enabled=false",
        "app.exports.worker.enabled=false"
})
@Import(PostgresTestConfiguration.class)
class ExportIdempotencyRetentionIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired ApplicationContext context;
    @Autowired MeetingExportRepository exports;
    @Autowired ExportIntentService admission;
    @Autowired ExportGenerationStateMachine state;
    @Autowired ExportIdempotencyRetentionCleanup cleanup;

    @BeforeEach
    void drainPendingFixtures() {
        for (int i = 0; i < 600; i++) {
            var pending = state.claimNext(30);
            if (pending.isEmpty()) return;
            assertThat(state.fail(pending.get().id(), pending.get().claimToken(),
                    "TEST_FIXTURE_CLEANUP")).isTrue();
        }
        throw new IllegalStateException("Unexpectedly large pending export test backlog");
    }

    @Test
    void expiredUnusedReceiptIsRemovedWithoutDeletingReadyExportMetadata() {
        UUID actor = user(), meeting = meeting(actor);
        ExportRecord export = as(actor,
                () -> admission.create(meeting, ExportFormat.MARKDOWN, "expired-unused"));
        var claim = state.claimNext(30).orElseThrow();
        assertThat(claim.id()).isEqualTo(export.id());
        assertThat(state.pinSnapshot(export.id(), claim.claimToken(), "a".repeat(64), "md-v1"))
                .isTrue();
        assertThat(state.publishReady(export.id(), claim.claimToken(), "b".repeat(64), 12))
                .isTrue();
        expireReceipt(export.id());

        assertThat(cleanup.cleanupBatch()).isEqualTo(1);
        ExportRecord retained = exports.require(export.id());
        assertThat(retained.status()).isEqualTo(ExportStatus.READY);
        assertThat(retained.snapshotObjectKey()).isNotNull();
        assertThat(retained.objectKey()).isNotNull();
        assertThat(receiptCount(export.id())).isZero();
    }

    @Test
    void activeReceiptIsPreserved() {
        UUID actor = user(), meeting = meeting(actor);
        ExportRecord export = as(actor,
                () -> admission.create(meeting, ExportFormat.PDF, "active-receipt"));

        assertThat(cleanup.cleanupBatch()).isZero();
        assertThat(receiptCount(export.id())).isEqualTo(1);
        assertThat(exports.require(export.id()).status()).isEqualTo(ExportStatus.PENDING);
    }

    @Test
    void cleanupIsScheduledIndependentlyOfExportWorker() {
        assertThat(context.getBeansOfType(
                ExportIdempotencyRetentionSchedulingConfiguration.class)).hasSize(1);
        ScheduledAnnotationBeanPostProcessor processor =
                context.getBean(ScheduledAnnotationBeanPostProcessor.class);
        assertThat(processor.getScheduledTasks())
                .anySatisfy(task -> assertThat(task.getTask().getRunnable().toString())
                        .contains("ExportIdempotencyRetentionSchedulingConfiguration.cleanup"));
    }

    @Test
    void cleanupHonorsBoundedBatchSize() {
        UUID actor = user(), meeting = meeting(actor);
        for (int i = 0; i < 201; i++) {
            createExpiredReceipt(actor, meeting, "batch-" + i);
        }

        assertThat(cleanup.cleanupBatch()).isEqualTo(200);
        assertThat(expiredReceiptCount()).isEqualTo(1);
        assertThat(cleanup.cleanupBatch()).isEqualTo(1);
        assertThat(cleanup.cleanupBatch()).isZero();
    }

    @Test
    void concurrentCleanupAttemptsDeleteEachExpiredReceiptAtMostOnce() throws Exception {
        UUID actor = user(), meeting = meeting(actor);
        for (int i = 0; i < 201; i++) {
            createExpiredReceipt(actor, meeting, "parallel-cleanup-" + i);
        }
        CountDownLatch start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            Callable<Integer> task = () -> {
                start.await();
                return cleanup.cleanupBatch();
            };
            var first = pool.submit(task);
            var second = pool.submit(task);
            start.countDown();
            int removed = first.get() + second.get();
            assertThat(removed).isEqualTo(201);
        }
        assertThat(expiredReceiptCount()).isZero();
    }

    @Test
    void concurrentAdmissionAndCleanupPreserveExpiredKeyReplacementSemantics() throws Exception {
        UUID actor = user(), meeting = meeting(actor);
        ExportRecord old = as(actor,
                () -> admission.create(meeting, ExportFormat.PDF, "expired-race"));
        expireReceipt(old.id());
        CountDownLatch start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var cleanupTask = pool.submit(() -> {
                start.await();
                return cleanup.cleanupBatch();
            });
            var admissionTask = pool.submit(() -> {
                start.await();
                return as(actor,
                        () -> admission.create(meeting, ExportFormat.PDF, "expired-race"));
            });
            start.countDown();
            cleanupTask.get();
            ExportRecord replacement = admissionTask.get();
            assertThat(replacement.id()).isNotEqualTo(old.id());
        }
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_exports WHERE meeting_id=?", Long.class, meeting))
                .isEqualTo(2L);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_export_idempotency WHERE meeting_id=?", Long.class, meeting))
                .isEqualTo(1L);
    }

    private void createExpiredReceipt(UUID actor, UUID meeting, String key) {
        UUID export = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_exports(id,meeting_id,format,requested_by_user_id)
            VALUES (?,?,'MARKDOWN',?)
            """, export, meeting, actor);
        jdbc.update("""
            INSERT INTO meeting_export_idempotency(
                actor_user_id,meeting_id,key_digest,request_digest,export_id,
                created_at,expires_at)
            VALUES (?,?,?,?,?,clock_timestamp()-INTERVAL '48 hours',
                    clock_timestamp()-INTERVAL '1 hour')
            """, actor, meeting, ExportDigests.keyDigest(meeting, key),
                "c".repeat(64), export);
        var claim = state.claimNext(30).orElseThrow();
        assertThat(claim.id()).isEqualTo(export);
        assertThat(state.fail(export, claim.claimToken(), "TEST_EXPIRED_RECEIPT")).isTrue();
    }

    private void expireReceipt(UUID export) {
        jdbc.update("""
            UPDATE meeting_export_idempotency
               SET created_at=clock_timestamp()-INTERVAL '48 hours',
                   expires_at=clock_timestamp()-INTERVAL '1 hour'
             WHERE export_id=?
            """, export);
    }

    private long expiredReceiptCount() {
        return jdbc.queryForObject("""
            SELECT count(*) FROM meeting_export_idempotency
             WHERE expires_at<=clock_timestamp()
            """, Long.class);
    }

    private long receiptCount(UUID export) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM meeting_export_idempotency WHERE export_id=?
            """, Long.class, export);
    }

    private UUID user() {
        UUID id = UUID.randomUUID();
        String email = "export-cleanup-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                              global_role,account_status)
            VALUES (?,?,?,'Export cleanup actor','test-only','EMPLOYEE','ACTIVE')
            """, id, email, email);
        return id;
    }

    private UUID meeting(UUID actor) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES (?,'Export cleanup fixture',?,?,'DRAFT')
            """, id, actor, actor);
        return id;
    }

    private static <T> T as(UUID actor, Supplier<T> action) {
        RequestAttributes old = RequestContextHolder.getRequestAttributes();
        MockHttpServletRequest request = new MockHttpServletRequest();
        Principal principal = () -> actor.toString();
        request.setUserPrincipal(principal);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        try {
            return action.get();
        } finally {
            if (old == null) RequestContextHolder.resetRequestAttributes();
            else RequestContextHolder.setRequestAttributes(old);
        }
    }
}
