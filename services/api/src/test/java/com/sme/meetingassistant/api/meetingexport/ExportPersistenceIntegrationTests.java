package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

/**
 * DE-06 real PostgreSQL 17 Testcontainers/Flyway V35 acceptance.
 * No enclosing test transaction: concurrency and post-commit effects are real.
 * The shorter 1-second test lease is a TEST-ONLY override; production minimum
 * remains 30 seconds unless Operations explicitly changes configuration.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = {
        "app.exports.minimum-lease-seconds=1",
        "app.media.outbox.enabled=false",
        "app.media.processing.stage-lease-sweep-ms=3600000"
})
@Import(PostgresTestConfiguration.class)
class ExportPersistenceIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired MeetingExportRepository exports;
    @Autowired ExportIntentService admission;
    @Autowired ExportGenerationStateMachine machine;
    @Autowired PlatformTransactionManager transactionManager;

    @BeforeEach
    void drainUnclaimedFixtures() {
        // Each test owns fresh UUIDs but this suite shares the container.
        // No pending job from a previous test may affect FIFO claim assertions.
        for (int i = 0; i < 100; i++) {
            var next = machine.claimNext(30);
            if (next.isEmpty()) return;
            assertThat(machine.fail(next.get().id(), next.get().claimToken(),
                    "TEST_FIXTURE_CLEANUP")).isTrue();
        }
        throw new IllegalStateException("Unexpectedly large pending export test backlog");
    }

    @AfterEach
    void clearIdentity() {
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void authenticatedIntentIsDurableRetrySafeAndFormatConflictIsAtomic() {
        UUID actor = user("EMPLOYEE");
        UUID meeting = meeting(actor);
        ExportRecord first = as(actor, () -> admission.create(meeting, ExportFormat.PDF, "network-retry"));
        ExportRecord replay = as(actor, () -> admission.create(meeting, ExportFormat.PDF, "network-retry"));

        assertThat(replay.id()).isEqualTo(first.id());
        assertThat(first.status()).isEqualTo(ExportStatus.PENDING);
        assertThat(first.generationAttempt()).isZero();
        assertThat(first.objectKey()).isNull();
        assertThat(first.sourceFingerprint()).isNull();
        assertThat(first.readyAt()).isNull();
        assertThat(first.claimToken()).isNull();
        assertThat(first.requestedByUserId()).isEqualTo(actor);
        assertThat(count("SELECT count(*) FROM meeting_exports WHERE meeting_id=?", meeting))
                .isEqualTo(1L);
        assertThat(count("SELECT count(*) FROM meeting_export_idempotency WHERE meeting_id=?", meeting))
                .isEqualTo(1L);
        assertThatThrownBy(() -> as(actor,
                () -> admission.create(meeting, ExportFormat.MARKDOWN, "network-retry")))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("409");
        assertThat(count("SELECT count(*) FROM meeting_exports WHERE meeting_id=?", meeting))
                .isEqualTo(1L);
        assertThatThrownBy(() -> as(actor,
                () -> admission.create(meeting, ExportFormat.PDF, "../unsafe")))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("400");
    }

    @Test
    void authorizationIsRecheckedOnReplayAndCannotBeExpandedByRoleOrTaskAccess() {
        UUID organizer = user("EMPLOYEE");
        UUID member = user("EMPLOYEE");
        UUID administrator = user("ADMINISTRATOR");
        UUID manager = user("DEPARTMENT_MANAGER");
        UUID target = meeting(organizer);
        participant(target, member);

        ExportRecord fromMember = as(member,
                () -> admission.create(target, ExportFormat.MARKDOWN, "my-key"));
        assertThat(fromMember.requestedByUserId()).isEqualTo(member);
        for (UUID actor : List.of(administrator, manager, user("EMPLOYEE"))) {
            assertThatThrownBy(() -> as(actor,
                    () -> admission.create(target, ExportFormat.PDF, "my-key")))
                    .isInstanceOf(ResponseStatusException.class).hasMessageContaining("404");
        }
        jdbc.update("""
            UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP
             WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """, target, member);
        assertThatThrownBy(() -> as(member,
                () -> admission.create(target, ExportFormat.MARKDOWN, "my-key")))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("404");
        assertThatThrownBy(() -> admission.create(target, ExportFormat.PDF, "none"))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("401");

        jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?", organizer);
        assertThatThrownBy(() -> as(organizer,
                () -> admission.create(target, ExportFormat.PDF, "disabled")))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("401");
        assertThat(count("SELECT count(*) FROM meeting_exports WHERE meeting_id=?", target))
                .isEqualTo(1L);
    }

    @Test
    void idempotencyScopesKeyByActorAndMeetingRatherThanSharingAccess() {
        UUID organizer = user("EMPLOYEE"), colleague = user("EMPLOYEE");
        UUID firstMeeting = meeting(organizer), secondMeeting = meeting(organizer);
        participant(firstMeeting, colleague);
        ExportRecord a = as(organizer,
                () -> admission.create(firstMeeting, ExportFormat.PDF, "same-key"));
        ExportRecord b = as(colleague,
                () -> admission.create(firstMeeting, ExportFormat.PDF, "same-key"));
        ExportRecord c = as(organizer,
                () -> admission.create(secondMeeting, ExportFormat.PDF, "same-key"));
        assertThat(List.of(a.id(), b.id(), c.id())).doesNotHaveDuplicates();
        assertThat(count("SELECT count(*) FROM meeting_exports WHERE meeting_id=?",
                firstMeeting)).isEqualTo(2L);
    }

    @Test
    void concurrentRequestRetriesCreateExactlyOneExportAndOneReceipt() throws Exception {
        UUID actor = user("EMPLOYEE"), meeting = meeting(actor);
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            Callable<UUID> retry = () -> {
                start.await(10, TimeUnit.SECONDS);
                return as(actor,
                        () -> admission.create(meeting, ExportFormat.PDF, "parallel-key")).id();
            };
            Future<UUID> a = executor.submit(retry);
            Future<UUID> b = executor.submit(retry);
            start.countDown();
            assertThat(a.get(20, TimeUnit.SECONDS)).isEqualTo(b.get(20, TimeUnit.SECONDS));
        }
        assertThat(count("SELECT COUNT(*) FROM meeting_exports WHERE meeting_id=?", meeting))
                .isEqualTo(1L);
        assertThat(count("SELECT COUNT(*) FROM meeting_export_idempotency WHERE meeting_id=?",
                meeting)).isEqualTo(1L);
    }

    @Test
    void claimedSnapshotAndArtifactRequireCorrectLiveTokenAndSourceProof() {
        UUID actor = user("EMPLOYEE"), meeting = meeting(actor);
        ExportRecord pending = as(actor,
                () -> admission.create(meeting, ExportFormat.PDF, "finish-pdf"));
        ExportRecord claimed = machine.claimNext(30).orElseThrow();
        assertThat(claimed.id()).isEqualTo(pending.id());
        assertThat(claimed.generationAttempt()).isEqualTo(1);
        assertThat(claimed.claimToken()).isNotNull();
        assertThat(claimed.leaseExpiresAt()).isNotNull();

        UUID forged = UUID.randomUUID();
        assertThat(machine.pinSnapshot(pending.id(), forged, "a".repeat(64), "pdf-v1")).isFalse();
        assertThat(machine.publishReady(pending.id(), claimed.claimToken(),
                "b".repeat(64), 1024)).isFalse();
        assertThat(machine.pinSnapshot(pending.id(), claimed.claimToken(),
                "a".repeat(64), "pdf-v1")).isTrue();
        assertThat(machine.pinSnapshot(pending.id(), claimed.claimToken(),
                "f".repeat(64), "pdf-v2")).isFalse();
        assertThat(machine.renew(pending.id(), claimed.claimToken(), 60)).isTrue();
        assertThat(machine.publishReady(pending.id(), forged, "b".repeat(64), 1024)).isFalse();
        assertThat(machine.publishReady(pending.id(), claimed.claimToken(),
                "b".repeat(64), 1024)).isTrue();

        ExportRecord ready = exports.require(pending.id());
        assertThat(ready.status()).isEqualTo(ExportStatus.READY);
        assertThat(ready.sourceFingerprint()).isEqualTo("a".repeat(64));
        assertThat(ready.snapshotObjectKey()).isEqualTo(
                "exports/" + ready.id() + "/snapshots/" + "a".repeat(64) + ".json");
        assertThat(ready.objectKey()).isEqualTo(
                "exports/" + ready.id() + "/artifacts/" + "b".repeat(64) + ".pdf");
        assertThat(ready.artifactSha256()).isEqualTo("b".repeat(64));
        assertThat(ready.artifactSizeBytes()).isEqualTo(1024L);
        assertThat(ready.claimToken()).isNull();
        assertThat(ready.readyAt()).isNotNull();
        assertThat(machine.fail(ready.id(), claimed.claimToken(), "RENDER_FAILED")).isFalse();
        assertThat(machine.requeueFailed(ready.id())).isFalse();
        assertThat(machine.publishReady(ready.id(), claimed.claimToken(),
                "c".repeat(64), 1024)).isFalse();
    }

    @Test
    void leaseExpiryFencesLateWorkerThenExplicitRetryCreatesNewAttempt()
            throws Exception {
        UUID actor = user("EMPLOYEE"), meeting = meeting(actor);
        UUID id = as(actor, () -> admission.create(meeting, ExportFormat.MARKDOWN, "retry")).id();
        ExportRecord first = machine.claimNext(1).orElseThrow();
        assertThat(first.id()).isEqualTo(id);
        assertThat(machine.pinSnapshot(id, first.claimToken(), "a".repeat(64), "md-v1")).isTrue();

        Thread.sleep(1350L);
        assertThat(machine.publishReady(id, first.claimToken(), "b".repeat(64), 10)).isFalse();
        assertThat(machine.renew(id, first.claimToken(), 30)).isFalse();
        assertThat(machine.failExpired(25)).isEqualTo(1);

        ExportRecord failed = exports.require(id);
        assertThat(failed.status()).isEqualTo(ExportStatus.FAILED);
        assertThat(failed.lastErrorCode()).isEqualTo("EXPORT_LEASE_EXPIRED");
        assertThat(failed.claimToken()).isNull();
        assertThat(failed.generationAttempt()).isEqualTo(1);

        assertThat(machine.requeueFailed(id)).isTrue();
        assertThat(exports.require(id).sourceFingerprint()).isNull();
        ExportRecord second = machine.claimNext(30).orElseThrow();
        assertThat(second.id()).isEqualTo(id);
        assertThat(second.generationAttempt()).isEqualTo(2);
        assertThat(second.claimToken()).isNotEqualTo(first.claimToken());
        assertThat(machine.pinSnapshot(id, first.claimToken(), "c".repeat(64), "md-v2")).isFalse();
        assertThat(machine.pinSnapshot(id, second.claimToken(), "c".repeat(64), "md-v2")).isTrue();
        assertThat(machine.fail(id, second.claimToken(), "RENDER_FAILED")).isTrue();
        assertThat(exports.require(id).lastErrorCode()).isEqualTo("RENDER_FAILED");
    }

    @Test
    void databaseRejectsInvalidRowsBypassTransitionsOverwriteAndDelete() {
        UUID actor = user("EMPLOYEE"), meeting = meeting(actor);
        UUID id = as(actor, () -> admission.create(meeting, ExportFormat.PDF, "db-guards")).id();
        assertInvalid(() -> jdbc.update("""
            INSERT INTO meeting_exports(id,meeting_id,format,requested_by_user_id)
            VALUES (?,?,'HTML',?)
            """, UUID.randomUUID(), meeting, actor));
        assertInvalid(() -> jdbc.update("""
            UPDATE meeting_exports SET status='READY',row_version=row_version+1 WHERE id=?
            """, id));
        assertInvalid(() -> jdbc.update("""
            UPDATE meeting_exports SET format='MARKDOWN',row_version=row_version+1 WHERE id=?
            """, id));
        assertInvalid(() -> jdbc.update("DELETE FROM meeting_exports WHERE id=?", id));

        ExportRecord generating = machine.claimNext(30).orElseThrow();
        assertThat(generating.id()).isEqualTo(id);
        assertInvalid(() -> jdbc.update("""
            UPDATE meeting_exports SET claim_token=?,row_version=row_version+1 WHERE id=?
            """, UUID.randomUUID(), id));
        assertThat(machine.pinSnapshot(id, generating.claimToken(),
                "a".repeat(64), "r1")).isTrue();
        assertInvalid(() -> jdbc.update("""
            UPDATE meeting_exports SET source_fingerprint=?,
                snapshot_object_key=?,row_version=row_version+1 WHERE id=?
            """, "d".repeat(64),
                "exports/" + id + "/snapshots/" + "d".repeat(64) + ".json", id));
        assertThat(machine.publishReady(id, generating.claimToken(),
                "b".repeat(64), 12)).isTrue();
        assertInvalid(() -> jdbc.update("""
            UPDATE meeting_exports SET status='FAILED',row_version=row_version+1 WHERE id=?
            """, id));
        assertInvalid(() -> jdbc.update("DELETE FROM meeting_exports WHERE id=?", id));
    }

    @Test
    void databaseAllowsOnlyInitialPendingOnDirectExportInsert() {
        UUID actor = user("EMPLOYEE"), meeting = meeting(actor);

        UUID pending = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_exports(id,meeting_id,format,status,requested_by_user_id)
            VALUES (?,?,'MARKDOWN','PENDING',?)
            """, pending, meeting, actor);
        assertThat(exports.require(pending).status()).isEqualTo(ExportStatus.PENDING);
        assertThat(machine.claimNextStaged(30)).isEmpty();

        UUID generating = UUID.randomUUID();
        assertInvalid(() -> jdbc.update("""
            INSERT INTO meeting_exports(
                id,meeting_id,format,status,requested_by_user_id,
                generation_attempt,claim_token,lease_expires_at)
            VALUES (?,?,'MARKDOWN','GENERATING',?,1,?,clock_timestamp()+INTERVAL '1 hour')
            """, generating, meeting, actor, UUID.randomUUID()));

        UUID failed = UUID.randomUUID();
        assertInvalid(() -> jdbc.update("""
            INSERT INTO meeting_exports(
                id,meeting_id,format,status,requested_by_user_id,
                generation_attempt,last_error_code)
            VALUES (?,?,'MARKDOWN','FAILED',?,1,'RENDER_FAILED')
            """, failed, meeting, actor));

        UUID ready = UUID.randomUUID();
        String source = "a".repeat(64);
        String artifact = "b".repeat(64);
        assertInvalid(() -> jdbc.update("""
            INSERT INTO meeting_exports(
                id,meeting_id,format,status,requested_by_user_id,
                ready_at,generation_attempt,source_fingerprint,snapshot_object_key,
                renderer_version,object_key,artifact_sha256,artifact_size_bytes)
            VALUES (?,?, 'MARKDOWN','READY',?,clock_timestamp(),1,?,?,?, ?,?,?)
            """, ready, meeting, actor, source,
                "exports/" + ready + "/snapshots/" + source + ".json", "md-v1",
                "exports/" + ready + "/artifacts/" + artifact + ".md", artifact, 12L));
    }

    @Test
    void databaseForbidsCommittedUnboundAndCrossMeetingIdempotencyReceipts() {
        UUID actor = user("EMPLOYEE"), other = user("EMPLOYEE");
        UUID target = meeting(actor), foreign = meeting(other);
        UUID key = UUID.randomUUID();
        assertInvalid(() -> jdbc.update("""
            INSERT INTO meeting_export_idempotency(
                actor_user_id,meeting_id,key_digest,request_digest,expires_at)
            VALUES (?,?,?,?,clock_timestamp()+INTERVAL '24 hours')
            """, actor, target, "a".repeat(64), "b".repeat(64)));
        assertThat(count("SELECT COUNT(*) FROM meeting_export_idempotency WHERE meeting_id=?",
                target)).isZero();

        UUID otherExport = as(other,
                () -> admission.create(foreign, ExportFormat.PDF, "foreign")).id();
        assertInvalid(() -> jdbc.update("""
            INSERT INTO meeting_export_idempotency(
                actor_user_id,meeting_id,key_digest,request_digest,export_id,expires_at)
            VALUES (?,?,?,?,?,clock_timestamp()+INTERVAL '24 hours')
            """, actor, target, "c".repeat(64), "d".repeat(64), otherExport));
        assertThat(count("SELECT COUNT(*) FROM meeting_export_idempotency WHERE meeting_id=?",
                target)).isZero();
    }

    @Test
    void expiredIdempotencyReceiptCanBeReplacedWithoutDeletingHistoricalExport() {
        UUID actor = user("EMPLOYEE"), meeting = meeting(actor);
        ExportRecord first = as(actor, () -> admission.create(meeting, ExportFormat.PDF, "old"));
        jdbc.update("""
            UPDATE meeting_export_idempotency
               SET created_at=clock_timestamp()-INTERVAL '48 hours',
                   expires_at=clock_timestamp()-INTERVAL '24 hours'
             WHERE export_id=?
            """, first.id());
        ExportRecord next = as(actor, () -> admission.create(meeting, ExportFormat.PDF, "old"));
        assertThat(next.id()).isNotEqualTo(first.id());
        assertThat(count("SELECT COUNT(*) FROM meeting_exports WHERE meeting_id=?", meeting))
                .isEqualTo(2L);
        assertThat(count("SELECT COUNT(*) FROM meeting_export_idempotency WHERE meeting_id=?",
                meeting)).isEqualTo(1L);
        assertThat(exports.require(first.id()).id()).isEqualTo(first.id());
    }

    private void assertInvalid(Runnable sql) {
        assertThatThrownBy(() -> new TransactionTemplate(transactionManager)
                .executeWithoutResult(s -> sql.run()))
                .isInstanceOf(Exception.class);
    }

    private long count(String sql, Object... args) {
        return jdbc.queryForObject(sql, Long.class, args);
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "de06-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'DE06 test actor','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private UUID meeting(UUID organizer) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES (?,'DE06 export source',?,?,'DRAFT')
            """, id, organizer, organizer);
        return id;
    }

    private void participant(UUID meetingId, UUID userId) {
        jdbc.update("INSERT INTO meeting_participants(id,meeting_id,user_id) VALUES (?,?,?)",
                UUID.randomUUID(), meetingId, userId);
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
