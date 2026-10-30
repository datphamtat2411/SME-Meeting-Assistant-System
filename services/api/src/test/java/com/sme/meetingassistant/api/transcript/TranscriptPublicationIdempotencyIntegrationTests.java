package com.sme.meetingassistant.api.transcript;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.CoverageResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SegmentResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SpeakerResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@ActiveProfiles("test")
@SpringBootTest(properties = "app.media.outbox.enabled=false")
@Import(PostgresTestConfiguration.class)
class TranscriptPublicationIdempotencyIntegrationTests {
    @Autowired TranscriptIngestion ingestion;
    @Autowired TranscriptRepository repository;
    @Autowired TransactionTemplate transactions;
    @Autowired JdbcTemplate jdbc;

    private UUID actor, meeting, media, job, finalization;

    @BeforeEach
    void setup() {
        actor = UUID.randomUUID();
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        String email = "tr01-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Transcript publication test','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Transcript publication',?,?)
            """, meeting, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
              content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, actor);
        var first = completedJob();
        job = first.job();
        finalization = first.stage();
    }

    private record Source(UUID job, UUID stage) { }

    private Source completedJob() {
        UUID newJob = UUID.randomUUID(), newStage = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,
                status,reprocess_of_job_id)
            VALUES (?,?,?,?,'COMPLETED',?)
            """, newJob, meeting, media, actor, job);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'FINALIZING_TRANSCRIPT',1,'SUCCEEDED')
            """, newStage, newJob);
        return new Source(newJob, newStage);
    }

    private TranscriptResult result(UUID jobId, UUID stage, String text) {
        return new TranscriptResult(meeting, media, jobId, stage, "vi", 10000L,
            TranscriptIngestion.Status.READY,
            List.of(new SegmentResult(0, 100, 1200, text, "ACCEPTED", "Speaker 1",
                stage, Map.of("confidence", 0.97))),
            List.of(new CoverageResult(100, 1200, "COVERED", false, 0, Map.of("accepted", true))),
            List.of(new SpeakerResult("Speaker 1")));
    }

    private TranscriptResult result(String text) { return result(job, finalization, text); }

    private int versions() {
        return jdbc.queryForObject("SELECT count(*) FROM transcripts WHERE meeting_id=?",
            Integer.class, meeting);
    }

    private UUID current() {
        return jdbc.queryForObject("SELECT id FROM transcripts WHERE meeting_id=? AND is_current",
            UUID.class, meeting);
    }

    private static void assertConflict(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOf(ResponseStatusException.class)
            .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));
    }

    @Test
    void identicalRedeliveryDoesNotCreateVersionsSegmentsOrSpeakerClusters() {
        TranscriptResult r = result("Nội dung đã được LLM hiệu chỉnh.");
        ingestion.publish(r);
        UUID accepted = current();
        ingestion.publish(r);
        assertThat(current()).isEqualTo(accepted);
        assertThat(versions()).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM transcript_segments WHERE transcript_id=?", Integer.class, accepted))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM speaker_clusters WHERE transcript_id=?", Integer.class, accepted))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM transcript_coverage_regions WHERE transcript_id=?", Integer.class, accepted))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT publication_sha256 FROM transcripts WHERE id=?", String.class, accepted))
            .matches("[0-9a-f]{64}");
    }

    @Test
    void sameJobDifferentTextIsRejectedWithoutMutatingCanonicalVersion() {
        ingestion.publish(result("Bản kết quả đầu."));
        UUID accepted = current();
        assertConflict(() -> ingestion.publish(result("Bản kết quả đã thay đổi.")));
        assertThat(versions()).isEqualTo(1);
        assertThat(current()).isEqualTo(accepted);
    }

    @Test
    void replayAfterHumanCorrectionDoesNotOverwriteHumanText() {
        TranscriptResult original = result("Lời AI ban đầu.");
        ingestion.publish(original);
        UUID accepted = current();
        jdbc.update("""
            UPDATE transcript_segments SET current_text='Nội dung người dùng đã sửa.',
                version=version+1 WHERE transcript_id=?
            """, accepted);
        ingestion.publish(original);
        assertThat(jdbc.queryForObject(
            "SELECT current_text FROM transcript_segments WHERE transcript_id=?",
            String.class, accepted)).isEqualTo("Nội dung người dùng đã sửa.");
        assertThat(versions()).isEqualTo(1);
    }

    @Test
    void fingerprintIsInsensitiveToNestedMetadataMapOrdering() {
        Map<String, Object> one = new LinkedHashMap<>();
        one.put("z", Map.of("b", 2, "a", 1));
        one.put("a", 0.97);
        Map<String, Object> two = new LinkedHashMap<>();
        two.put("a", 0.97);
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("a", 1); nested.put("b", 2);
        two.put("z", nested);
        TranscriptResult initial = result("Bản hiệu chỉnh.");
        TranscriptResult first = new TranscriptResult(initial.meetingId(), initial.sourceMediaId(),
            initial.processingJobId(), initial.sourceStageRunId(), initial.languageCode(), initial.durationMs(),
            initial.status(), List.of(new SegmentResult(0, 100, 1200, "Bản hiệu chỉnh.",
                "ACCEPTED", "Speaker 1", finalization, one)),
            initial.coverage(), initial.speakers());
        TranscriptResult second = new TranscriptResult(initial.meetingId(), initial.sourceMediaId(),
            initial.processingJobId(), initial.sourceStageRunId(), initial.languageCode(), initial.durationMs(),
            initial.status(), List.of(new SegmentResult(0, 100, 1200, "Bản hiệu chỉnh.",
                "ACCEPTED", "Speaker 1", finalization, two)),
            initial.coverage(), initial.speakers());
        ingestion.publish(first);
        ingestion.publish(second);
        assertThat(versions()).isEqualTo(1);
    }

    @Test
    void invalidFinalizationOrForeignJobStageDoesNotPublish() {
        UUID unrelatedStage = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'TRANSCRIPTION',1,'SUCCEEDED')
            """, unrelatedStage, job);
        assertConflict(() -> ingestion.publish(result(job, unrelatedStage, "Wrong stage.")));
        var other = completedJob();
        assertConflict(() -> ingestion.publish(result(job, other.stage(), "Wrong job.")));
        assertThatThrownBy(() -> ingestion.publish(result(job, null, "Missing provenance.")))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY));
        assertThat(versions()).isZero();
    }

    @Test
    void staleFinalizationAttemptCannotPublish() {
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'FINALIZING_TRANSCRIPT',2,'SUCCEEDED')
            """, UUID.randomUUID(), job);
        assertConflict(() -> ingestion.publish(result("Old attempt.")));
        assertThat(versions()).isZero();
    }

    @Test
    void concurrentDuplicateDeliveriesCommitOneCanonicalVersion() throws Exception {
        TranscriptResult result = result("Bản được công bố một lần.");
        try (var workers = Executors.newFixedThreadPool(2)) {
            var gate = new CountDownLatch(1);
            var first = workers.submit(() -> { gate.await(); ingestion.publish(result); return true; });
            var second = workers.submit(() -> { gate.await(); ingestion.publish(result); return true; });
            gate.countDown();
            assertThat(first.get(20, TimeUnit.SECONDS)).isTrue();
            assertThat(second.get(20, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(versions()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT version_number FROM transcripts WHERE meeting_id=?",
            Integer.class, meeting)).isEqualTo(1);
    }

    @Test
    void competingDifferentResultsCannotBothBecomeCanonical() throws Exception {
        try (var workers = Executors.newFixedThreadPool(2)) {
            var gate = new CountDownLatch(1);
            var first = workers.submit(() -> {
                gate.await();
                ingestion.publish(result("Candidate A."));
                return true;
            });
            var second = workers.submit(() -> {
                gate.await();
                ingestion.publish(result("Candidate B."));
                return true;
            });
            gate.countDown();
            int accepted = 0, rejected = 0;
            for (var task : List.of(first, second)) {
                try {
                    assertThat(task.get(20, TimeUnit.SECONDS)).isTrue();
                    accepted++;
                } catch (ExecutionException error) {
                    assertThat(error.getCause()).isInstanceOf(ResponseStatusException.class);
                    assertThat(((ResponseStatusException) error.getCause()).getStatusCode())
                        .isEqualTo(HttpStatus.CONFLICT);
                    rejected++;
                }
            }
            assertThat(accepted).isEqualTo(1);
            assertThat(rejected).isEqualTo(1);
        }
        assertThat(versions()).isEqualTo(1);
    }

    @Test
    void failedInsertRollsBackPromotionAndKeepsPreviousCurrentVersion() {
        ingestion.publish(result("First canonical result."));
        UUID existing = current();
        Source next = completedJob();
        TranscriptResult malformed = new TranscriptResult(meeting, media, next.job(), next.stage(),
            "vi", 10000L, TranscriptIngestion.Status.READY,
            List.of(
                new SegmentResult(0, 100, 500, "First.", "ACCEPTED", null, next.stage(), null),
                new SegmentResult(0, 500, 900, "Duplicate ordinal.", "ACCEPTED", null, next.stage(), null)),
            List.of(new CoverageResult(0, 900, "COVERED", false, 0, null)), List.of());
        assertThatThrownBy(() -> ingestion.publish(malformed))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(current()).isEqualTo(existing);
        assertThat(versions()).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT is_current FROM transcripts WHERE id=?", Boolean.class, existing)).isTrue();
    }

    private UUID transcriptFor(UUID jobId) {
        return jdbc.queryForObject("SELECT id FROM transcripts WHERE processing_job_id=?",
            UUID.class, jobId);
    }

    private UUID segmentFor(UUID transcriptId) {
        return jdbc.queryForObject("SELECT id FROM transcript_segments WHERE transcript_id=?",
            UUID.class, transcriptId);
    }

    private long revision(UUID transcriptId) {
        return jdbc.queryForObject("SELECT content_revision FROM transcripts WHERE id=?",
            Long.class, transcriptId);
    }

    private void edit(UUID transcriptId, String updatedText) {
        transactions.executeWithoutResult(tx ->
            repository.correct(meeting, segmentFor(transcriptId), actor, updatedText, "Review", 0));
    }

    @Test
    void uneditedCurrentIsAutomaticallySupersededByNewerReprocessingResult() {
        ingestion.publish(result("Initial result"));
        UUID initial = current();
        Source newer = completedJob();
        ingestion.publish(result(newer.job(), newer.stage(), "Newer reprocess"));
        assertThat(versions()).isEqualTo(2);
        assertThat(current()).isEqualTo(transcriptFor(newer.job()));
        assertThat(jdbc.queryForObject("SELECT is_current FROM transcripts WHERE id=?",
            Boolean.class, initial)).isFalse();
        assertThat(revision(initial)).isZero();
    }

    @Test
    void humanEditedCurrentRemainsSelectedAndReprocessedResultBecomesCandidate() {
        ingestion.publish(result("Initial result"));
        UUID edited = current();
        edit(edited, "Human correction must win");
        assertThat(revision(edited)).isEqualTo(1L);
        assertThat(repository.current(meeting).orElseThrow().contentRevision()).isEqualTo(1L);
        Source newer = completedJob();
        TranscriptResult newResult = result(newer.job(), newer.stage(), "Reprocessed AI");
        ingestion.publish(newResult);
        UUID candidate = transcriptFor(newer.job());
        assertThat(candidate).isNotEqualTo(edited);
        assertThat(current()).isEqualTo(edited);
        assertThat(jdbc.queryForObject("SELECT is_current FROM transcripts WHERE id=?",
            Boolean.class, candidate)).isFalse();
        assertThat(jdbc.queryForObject(
            "SELECT current_text FROM transcript_segments WHERE transcript_id=?",
            String.class, edited)).isEqualTo("Human correction must win");
        assertThat(versions()).isEqualTo(2);
        ingestion.publish(newResult);
        assertThat(current()).isEqualTo(edited);
        assertThat(versions()).isEqualTo(2);
    }

    @Test
    void newerJobAcceptedBeforeOldResultPreventsStaleAutoPromotion() {
        Source newer = completedJob();
        ingestion.publish(result("Late initial result"));
        assertThat(versions()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM transcripts WHERE meeting_id=? AND is_current",
            Integer.class, meeting)).isZero();
        ingestion.publish(result(newer.job(), newer.stage(), "Newer result"));
        assertThat(current()).isEqualTo(transcriptFor(newer.job()));
        assertThat(versions()).isEqualTo(2);
    }

    @Test
    void olderResultCannotReplaceAlreadyCurrentNewerJob() {
        Source newer = completedJob();
        ingestion.publish(result(newer.job(), newer.stage(), "Newer result first"));
        UUID winning = current();
        ingestion.publish(result("Older result late"));
        assertThat(current()).isEqualTo(winning);
        assertThat(jdbc.queryForObject("SELECT is_current FROM transcripts WHERE processing_job_id=?",
            Boolean.class, job)).isFalse();
        assertThat(versions()).isEqualTo(2);
    }

    @Test
    void speakerMappingChangeCreatesHumanRevisionAndProtectsCurrent() {
        ingestion.publish(result("Speaker result"));
        UUID original = current();
        UUID cluster = jdbc.queryForObject("SELECT id FROM speaker_clusters WHERE transcript_id=?",
            UUID.class, original);
        transactions.executeWithoutResult(tx -> repository.mapSpeaker(meeting, cluster, actor, actor, original, 0));
        assertThat(revision(original)).isEqualTo(1);
        transactions.executeWithoutResult(tx -> repository.mapSpeaker(meeting, cluster, actor, actor, original, 1));
        assertThat(revision(original)).isEqualTo(1);
        Source newer = completedJob();
        ingestion.publish(result(newer.job(), newer.stage(), "New AI"));
        assertThat(current()).isEqualTo(original);
        assertThat(jdbc.queryForObject("SELECT is_current FROM transcripts WHERE processing_job_id=?",
            Boolean.class, newer.job())).isFalse();
        transactions.executeWithoutResult(tx -> repository.mapSpeaker(meeting, cluster, null, actor, original, 1));
        assertThat(revision(original)).isEqualTo(2);
        transactions.executeWithoutResult(tx -> repository.mapSpeaker(meeting, cluster, null, actor, original, 2));
        assertThat(revision(original)).isEqualTo(2);
    }

    @Test
    void unchangedHumanTextDoesNotIncrementContentRevision() {
        ingestion.publish(result("Already approved"));
        UUID existing = current();
        edit(existing, "Already approved");
        assertThat(revision(existing)).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM transcript_segment_revisions r JOIN transcript_segments s ON r.segment_id=s.id WHERE s.transcript_id=?",
            Integer.class, existing)).isZero();
    }

    @Test
    void editingPreviousVersionAfterNewCurrentIsRejected() {
        ingestion.publish(result("Initial version"));
        UUID old = current();
        Source newer = completedJob();
        ingestion.publish(result(newer.job(), newer.stage(), "Promoted version"));
        assertThatThrownBy(() -> edit(old, "Stale change"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND));
        assertThat(revision(old)).isZero();
    }

    @Test
    void pendingHumanEditFinishesBeforePublicationCanReplaceCurrent() throws Exception {
        ingestion.publish(result("Before human correction"));
        UUID original = current();
        Source newer = completedJob();
        var edited = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var correction = workers.submit(() -> {
                transactions.executeWithoutResult(tx -> {
                    repository.correct(meeting, segmentFor(original), actor,
                        "Human revision wins", "Review", 0);
                    edited.countDown();
                    try {
                        if (!release.await(15, TimeUnit.SECONDS)) {
                            throw new IllegalStateException("Edit transaction gate timed out.");
                        }
                    } catch (InterruptedException ex) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(ex);
                    }
                });
                return true;
            });
            assertThat(edited.await(15, TimeUnit.SECONDS)).isTrue();
            var publication = workers.submit(() -> {
                ingestion.publish(result(newer.job(), newer.stage(), "New AI candidate"));
                return true;
            });
            release.countDown();
            assertThat(correction.get(20, TimeUnit.SECONDS)).isTrue();
            assertThat(publication.get(20, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(current()).isEqualTo(original);
        assertThat(revision(original)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("SELECT is_current FROM transcripts WHERE processing_job_id=?",
            Boolean.class, newer.job())).isFalse();
    }

    private static CoverageResult region(long start, long end, String status) {
        return new CoverageResult(start, end, status, false, 0, null);
    }

    private static SegmentResult segment(int ordinal, long start, long end, String quality) {
        return new SegmentResult(ordinal, start, end, "Đoạn hội thoại đã hiệu chỉnh.",
            quality, null, null, null);
    }

    private TranscriptResult qualityResult(TranscriptIngestion.Status status,
            List<SegmentResult> segments, List<CoverageResult> coverage) {
        return new TranscriptResult(meeting, media, job, finalization, "vi", 10000L,
            status, segments, coverage, List.of());
    }

    private static void assertInvalidQuality(Runnable publish) {
        assertThatThrownBy(publish::run).isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY));
    }

    @Test
    void readyRejectsUnresolvedSpeechEvenWhenAcceptedTextExistsElsewhere() {
        TranscriptResult value = qualityResult(TranscriptIngestion.Status.READY,
            List.of(segment(0, 100, 1200, "ACCEPTED")),
            List.of(region(100, 1200, "COVERED"), region(2000, 3000, "UNRESOLVED_ERROR")));
        assertInvalidQuality(() -> ingestion.publish(value));
        assertThat(versions()).isZero();
    }

    @Test
    void readyRejectsSuspiciousCoverageRatherThanHidingIt() {
        TranscriptResult value = qualityResult(TranscriptIngestion.Status.READY,
            List.of(segment(0, 100, 1200, "ACCEPTED")),
            List.of(region(100, 1200, "COVERED"), region(2000, 2500, "SUSPICIOUS")));
        assertInvalidQuality(() -> ingestion.publish(value));
        assertThat(versions()).isZero();
    }

    @Test
    void readyRejectsSuspiciousOrUnresolvedTranscriptSegments() {
        for (String state : List.of("SUSPICIOUS", "UNRESOLVED")) {
            TranscriptResult value = qualityResult(TranscriptIngestion.Status.READY,
                List.of(segment(0, 100, 1200, state)),
                List.of(region(100, 1200, "SUSPICIOUS")));
            assertInvalidQuality(() -> ingestion.publish(value));
        }
        assertThat(versions()).isZero();
    }

    @Test
    void warningsPreserveTimelineOfDetectedButUnresolvedSpeech() {
        TranscriptResult value = qualityResult(TranscriptIngestion.Status.READY_WITH_WARNINGS,
            List.of(segment(0, 100, 1200, "ACCEPTED")),
            List.of(region(100, 1200, "COVERED"), region(2100, 2800, "UNRESOLVED_ERROR")));
        ingestion.publish(value);
        UUID accepted = current();
        assertThat(jdbc.queryForObject("SELECT status FROM transcripts WHERE id=?",
            String.class, accepted)).isEqualTo("READY_WITH_WARNINGS");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM transcript_coverage_regions WHERE transcript_id=?
              AND coverage_status='UNRESOLVED_ERROR' AND start_ms=2100 AND end_ms=2800
            """, Integer.class, accepted)).isEqualTo(1);
        ingestion.publish(value);
        assertThat(versions()).isEqualTo(1);
    }

    @Test
    void missingSpeechCoverageEvidenceIsNotAcceptedAsComplete() {
        TranscriptResult value = qualityResult(TranscriptIngestion.Status.READY,
            List.of(segment(0, 100, 1200, "ACCEPTED")), List.of());
        assertInvalidQuality(() -> ingestion.publish(value));
        assertThat(versions()).isZero();
    }

    @Test
    void coveredRegionRequiresAcceptedTextRatherThanSuspiciousText() {
        TranscriptResult value = qualityResult(TranscriptIngestion.Status.READY_WITH_WARNINGS,
            List.of(segment(0, 100, 1200, "SUSPICIOUS")),
            List.of(region(100, 1200, "COVERED")));
        assertInvalidQuality(() -> ingestion.publish(value));
        assertThat(versions()).isZero();
    }

    @Test
    void coveredRegionCannotClaimSuccessWithTextAtUnrelatedTime() {
        TranscriptResult value = qualityResult(TranscriptIngestion.Status.READY,
            List.of(segment(0, 100, 1200, "ACCEPTED")),
            List.of(region(2000, 2500, "COVERED")));
        assertInvalidQuality(() -> ingestion.publish(value));
        assertThat(versions()).isZero();
    }

    @Test
    void transcriptSegmentOutsideEveryCoverageRegionIsRejected() {
        TranscriptResult value = qualityResult(TranscriptIngestion.Status.READY,
            List.of(segment(0, 100, 1200, "ACCEPTED"),
                segment(1, 5000, 5500, "ACCEPTED")),
            List.of(region(100, 1200, "COVERED")));
        assertInvalidQuality(() -> ingestion.publish(value));
        assertThat(versions()).isZero();
    }

    @Test
    void touchingIntervalBoundariesDoNotPretendSpeechOverlap() {
        TranscriptResult value = qualityResult(TranscriptIngestion.Status.READY,
            List.of(segment(0, 100, 1200, "ACCEPTED")),
            List.of(region(1200, 2000, "COVERED")));
        assertInvalidQuality(() -> ingestion.publish(value));
        assertThat(versions()).isZero();
    }

    @Test
    void transcriptStatusReflectsFinalizationStageWarnings() {
        jdbc.update("""
            UPDATE processing_stage_runs SET status='SUCCEEDED_WITH_WARNING'
            WHERE id=?
            """, finalization);
        TranscriptResult nominal = result("Only accepted text but a finalization warning");
        assertInvalidQuality(() -> ingestion.publish(nominal));
        TranscriptResult warned = new TranscriptResult(nominal.meetingId(),
            nominal.sourceMediaId(), nominal.processingJobId(), nominal.sourceStageRunId(),
            nominal.languageCode(), nominal.durationMs(),
            TranscriptIngestion.Status.READY_WITH_WARNINGS, nominal.segments(),
            nominal.coverage(), nominal.speakers());
        ingestion.publish(warned);
        assertThat(jdbc.queryForObject(
            "SELECT status FROM transcripts WHERE processing_job_id=?",
            String.class, job)).isEqualTo("READY_WITH_WARNINGS");
    }

    @Test
    void cannotDeclareWarningsWithoutAnyPersistedQualityOrStageEvidence() {
        TranscriptResult nominal = result("Fully accepted transcript");
        TranscriptResult warned = new TranscriptResult(nominal.meetingId(),
            nominal.sourceMediaId(), nominal.processingJobId(), nominal.sourceStageRunId(),
            nominal.languageCode(), nominal.durationMs(),
            TranscriptIngestion.Status.READY_WITH_WARNINGS, nominal.segments(),
            nominal.coverage(), nominal.speakers());
        assertInvalidQuality(() -> ingestion.publish(warned));
        assertThat(versions()).isZero();
    }

    @Test
    void suspiciousTranscriptSegmentIsPreservedWithWarningsForReview() {
        TranscriptResult value = qualityResult(TranscriptIngestion.Status.READY_WITH_WARNINGS,
            List.of(segment(0, 100, 1200, "SUSPICIOUS")),
            List.of(region(100, 1200, "SUSPICIOUS")));
        ingestion.publish(value);
        assertThat(jdbc.queryForObject("""
            SELECT quality_status FROM transcript_segments
            WHERE transcript_id=(SELECT id FROM transcripts WHERE processing_job_id=?)
            """, String.class, job)).isEqualTo("SUSPICIOUS");
        assertThat(jdbc.queryForObject("""
            SELECT status FROM transcripts WHERE processing_job_id=?
            """, String.class, job)).isEqualTo("READY_WITH_WARNINGS");
    }
}
