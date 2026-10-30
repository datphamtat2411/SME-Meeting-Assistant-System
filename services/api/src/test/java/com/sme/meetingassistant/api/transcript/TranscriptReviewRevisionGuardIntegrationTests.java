package com.sme.meetingassistant.api.transcript;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository.TranscriptSource;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.CoverageResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SegmentResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SpeakerResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@ActiveProfiles("test")
@SpringBootTest(properties = "app.media.outbox.enabled=false")
@Import(PostgresTestConfiguration.class)
class TranscriptReviewRevisionGuardIntegrationTests {
    @Autowired TranscriptRepository transcripts;
    @Autowired TranscriptIngestion ingestion;
    @Autowired TranscriptSourceGuard guard;
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;

    private UUID meeting;
    private UUID actor;
    private UUID media;
    private UUID job;
    private UUID finalization;

    @BeforeEach
    void setup() {
        actor = UUID.randomUUID();
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        job = UUID.randomUUID();
        finalization = UUID.randomUUID();
        String email = "tr04-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'TR04 editor','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'TR04 review',?,?)
            """, meeting, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """, job, meeting, media, actor);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'FINALIZING_TRANSCRIPT',1,'SUCCEEDED')
            """, finalization, job);
    }

    private void publish(String quality, String coverage, TranscriptIngestion.Status status) {
        ingestion.publish(new TranscriptResult(meeting, media, job, finalization, "vi",
            10000L, status, List.of(new SegmentResult(0, 0, 1500,
                "Đoạn nói đã được LLM hiệu chỉnh.", quality, "Speaker 1", finalization, null)),
            List.of(new CoverageResult(0, 1500, coverage, false, 0, null)),
            List.of(new SpeakerResult("Speaker 1"))));
    }

    private UUID segment() {
        return jdbc.queryForObject("""
            SELECT s.id FROM transcript_segments s JOIN transcripts t ON t.id=s.transcript_id
            WHERE t.meeting_id=? AND t.is_current
            """, UUID.class, meeting);
    }

    private UUID cluster() {
        return jdbc.queryForObject("""
            SELECT c.id FROM speaker_clusters c JOIN transcripts t ON t.id=c.transcript_id
            WHERE t.meeting_id=? AND t.is_current
            """, UUID.class, meeting);
    }

    private static void conflict(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOf(ResponseStatusException.class)
            .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));
    }

    @Test
    void acceptingSuspiciousTextUnchangedIsAnAuditedHumanDecision() {
        publish("SUSPICIOUS", "SUSPICIOUS", TranscriptIngestion.Status.READY_WITH_WARNINGS);
        UUID id = segment();
        TranscriptSource before = guard.current(meeting);
        var accepted = tx.execute(status -> transcripts.correct(meeting, id, actor,
            "Đoạn nói đã được LLM hiệu chỉnh.", "Reviewed against audio", 0));
        assertThat(accepted.qualityStatus()).isEqualTo("ACCEPTED");
        assertThat(accepted.version()).isEqualTo(1);
        TranscriptSource after = guard.current(meeting);
        assertThat(after.transcriptId()).isEqualTo(before.transcriptId());
        assertThat(after.contentRevision()).isEqualTo(1);
        assertThat(after.status()).isEqualTo("READY_WITH_WARNINGS");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM transcript_segment_revisions WHERE segment_id=?
            """, Integer.class, id)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT edited_by_user_id FROM transcript_segment_revisions WHERE segment_id=?
            """, UUID.class, id)).isEqualTo(actor);
        assertThat(jdbc.queryForObject("""
            SELECT previous_text=new_text FROM transcript_segment_revisions WHERE segment_id=?
            """, Boolean.class, id)).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT quality_status FROM transcript_segments WHERE id=?
            """, String.class, id)).isEqualTo("ACCEPTED");
        conflict(() -> tx.executeWithoutResult(status -> guard.requireCurrentForDerivedWrite(meeting, before)));
    }

    @Test
    void repeatedAcceptanceWithCurrentTagIsNoOpButStaleTagFails() {
        publish("SUSPICIOUS", "SUSPICIOUS", TranscriptIngestion.Status.READY_WITH_WARNINGS);
        UUID id = segment();
        tx.executeWithoutResult(status -> transcripts.correct(meeting, id, actor,
            "Đoạn nói đã được LLM hiệu chỉnh.", "Accepted", 0));
        var noop = tx.execute(status -> transcripts.correct(meeting, id, actor,
            "Đoạn nói đã được LLM hiệu chỉnh.", "Retry", 1));
        assertThat(noop.version()).isEqualTo(1);
        assertThat(guard.current(meeting).contentRevision()).isEqualTo(1);
        conflictPrecondition(() -> tx.executeWithoutResult(status -> transcripts.correct(meeting, id, actor,
            "Đoạn nói đã được LLM hiệu chỉnh.", "Stale", 0)));
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM transcript_segment_revisions WHERE segment_id=?",
            Integer.class, id)).isEqualTo(1);
    }

    private static void conflictPrecondition(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOf(ResponseStatusException.class)
            .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode())
                .isEqualTo(HttpStatus.PRECONDITION_FAILED));
    }

    @Test
    void downstreamGuardRequiresAnExistingWriteTransaction() {
        publish("ACCEPTED", "COVERED", TranscriptIngestion.Status.READY);
        TranscriptSource source = guard.current(meeting);
        assertThatThrownBy(() -> guard.requireCurrentForDerivedWrite(meeting, source))
            .isInstanceOf(IllegalTransactionStateException.class);
        tx.executeWithoutResult(status -> guard.requireCurrentForDerivedWrite(meeting, source));
    }

    @Test
    void correctionMakesOlderDerivedSourceStale() {
        publish("ACCEPTED", "COVERED", TranscriptIngestion.Status.READY);
        TranscriptSource initial = guard.current(meeting);
        tx.executeWithoutResult(status -> transcripts.correct(meeting, segment(), actor,
            "Human-corrected statement.", "Corrected fact", 0));
        assertThat(guard.current(meeting).contentRevision()).isEqualTo(1);
        conflict(() -> tx.executeWithoutResult(status -> guard.requireCurrentForDerivedWrite(meeting, initial)));
        tx.executeWithoutResult(status -> guard.requireCurrentForDerivedWrite(meeting, guard.current(meeting)));
    }

    @Test
    void speakerMapAndUnmapInvalidateDerivedEvidenceWithoutChangingSpeechText() {
        publish("ACCEPTED", "COVERED", TranscriptIngestion.Status.READY);
        UUID speaker = cluster();
        UUID id = segment();
        String text = jdbc.queryForObject(
            "SELECT current_text FROM transcript_segments WHERE id=?", String.class, id);
        TranscriptSource initial = guard.current(meeting);
        tx.executeWithoutResult(status -> transcripts.mapSpeaker(meeting, speaker, actor, actor, initial.transcriptId(), initial.contentRevision()));
        conflict(() -> tx.executeWithoutResult(status -> guard.requireCurrentForDerivedWrite(meeting, initial)));
        TranscriptSource mapped = guard.current(meeting);
        assertThat(mapped.contentRevision()).isEqualTo(1L);
        tx.executeWithoutResult(status -> transcripts.mapSpeaker(meeting, speaker, actor, actor, mapped.transcriptId(), mapped.contentRevision()));
        assertThat(guard.current(meeting)).isEqualTo(mapped);
        tx.executeWithoutResult(status -> transcripts.mapSpeaker(meeting, speaker, null, actor, mapped.transcriptId(), mapped.contentRevision()));
        assertThat(guard.current(meeting).contentRevision()).isEqualTo(2L);
        assertThat(jdbc.queryForObject(
            "SELECT current_text FROM transcript_segments WHERE id=?", String.class, id)).isEqualTo(text);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM speaker_mappings WHERE speaker_cluster_id=? AND superseded_at IS NOT NULL",
            Integer.class, speaker)).isEqualTo(1);
    }

    private boolean attemptMapping(UUID cluster, UUID targetUser, TranscriptSource expected) {
        try {
            tx.executeWithoutResult(status -> transcripts.mapSpeaker(meeting, cluster, targetUser, actor,
                expected.transcriptId(), expected.contentRevision()));
            return true;
        } catch (ResponseStatusException stale) {
            assertThat(stale.getStatusCode()).isEqualTo(HttpStatus.PRECONDITION_FAILED);
            return false;
        }
    }

    @Test
    void twoConcurrentSpeakerMappingsUsingSameTranscriptRevisionCannotBothWin() throws Exception {
        publish("ACCEPTED", "COVERED", TranscriptIngestion.Status.READY);
        UUID speaker = cluster();
        TranscriptSource captured = guard.current(meeting);
        UUID alternate = UUID.randomUUID();
        String email = "tr04-concurrent-" + alternate + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Mapping contender','test-only','EMPLOYEE','ACTIVE')
            """, alternate, email, email);

        var gate = new CountDownLatch(1);
        var pool = Executors.newFixedThreadPool(2);
        try {
            var first = pool.submit(() -> {
                if (!gate.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Concurrency gate timed out.");
                return attemptMapping(speaker, actor, captured);
            });
            var second = pool.submit(() -> {
                if (!gate.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Concurrency gate timed out.");
                return attemptMapping(speaker, alternate, captured);
            });
            gate.countDown();
            boolean one = first.get(15, TimeUnit.SECONDS);
            boolean two = second.get(15, TimeUnit.SECONDS);
            assertThat(one).isNotEqualTo(two);
            assertThat(guard.current(meeting).contentRevision()).isEqualTo(1L);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM speaker_mappings
                WHERE speaker_cluster_id=? AND superseded_at IS NULL
                """, Integer.class, speaker)).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void newCurrentTranscriptMakesOldDerivedInputStaleEvenAtSameContentRevision() {
        publish("ACCEPTED", "COVERED", TranscriptIngestion.Status.READY);
        TranscriptSource old = guard.current(meeting);
        UUID newerJob = UUID.randomUUID(), newerStage = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,
                status,reprocess_of_job_id)
            VALUES (?,?,?,?,'COMPLETED',?)
            """, newerJob, meeting, media, actor, job);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'FINALIZING_TRANSCRIPT',1,'SUCCEEDED')
            """, newerStage, newerJob);
        ingestion.publish(new TranscriptResult(meeting, media, newerJob, newerStage, "vi",
            10000L, TranscriptIngestion.Status.READY,
            List.of(new SegmentResult(0, 0, 1500, "New verified text.",
                "ACCEPTED", "Speaker 1", newerStage, null)),
            List.of(new CoverageResult(0, 1500, "COVERED", false, 0, null)),
            List.of(new SpeakerResult("Speaker 1"))));
        assertThat(guard.current(meeting).transcriptId()).isNotEqualTo(old.transcriptId());
        assertThat(guard.current(meeting).contentRevision()).isZero();
        conflict(() -> tx.executeWithoutResult(status -> guard.requireCurrentForDerivedWrite(meeting, old)));
    }

    @Test
    void transactionGuardHoldsMeetingLockUntilDerivedWriteCompletes() throws Exception {
        publish("ACCEPTED", "COVERED", TranscriptIngestion.Status.READY);
        TranscriptSource captured = guard.current(meeting);
        var locked = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var editorStarted = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var writer = workers.submit(() -> {
                tx.executeWithoutResult(status -> {
                    guard.requireCurrentForDerivedWrite(meeting, captured);
                    locked.countDown();
                    try {
                        if (!release.await(15, TimeUnit.SECONDS))
                            throw new IllegalStateException("Writer lock timed out");
                    } catch (InterruptedException ex) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(ex);
                    }
                });
                return true;
            });
            assertThat(locked.await(15, TimeUnit.SECONDS)).isTrue();
            var editor = workers.submit(() -> {
                editorStarted.countDown();
                tx.executeWithoutResult(status -> transcripts.correct(meeting, segment(), actor,
                    "New human review text.", "Edit", 0));
                return true;
            });
            assertThat(editorStarted.await(15, TimeUnit.SECONDS)).isTrue();
            // While writer holds the row lock, correction cannot commit.
            assertThat(guard.current(meeting)).isEqualTo(captured);
            release.countDown();
            assertThat(writer.get(20, TimeUnit.SECONDS)).isTrue();
            assertThat(editor.get(20, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(guard.current(meeting).contentRevision()).isEqualTo(1L);
        conflict(() -> tx.executeWithoutResult(status -> guard.requireCurrentForDerivedWrite(meeting, captured)));
    }

    @Test
    void noCurrentTranscriptCannotBeUsedForDerivedWrite() {
        assertThatThrownBy(() -> guard.current(meeting))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND));
    }
}
