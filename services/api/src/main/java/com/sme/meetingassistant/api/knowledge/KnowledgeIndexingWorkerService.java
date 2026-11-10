package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Core-owned claim, source and result boundary for the future T05-B worker. */
@Service
public class KnowledgeIndexingWorkerService {
    private final JdbcTemplate jdbc;
    private final MediaProperties properties;

    public KnowledgeIndexingWorkerService(JdbcTemplate jdbc, MediaProperties properties) {
        this.jdbc = jdbc;
        this.properties = properties;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> status(UUID eventId) {
        Work work = find(eventId).orElseThrow(() -> new WorkerException(404, "WORKER_DELIVERY_UNKNOWN"));
        return statusData(work, false);
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> verifySources(List<SourceVerificationRequest> requests) {
        OffsetDateTime verifiedAt = OffsetDateTime.now(java.time.ZoneOffset.UTC);
        return requests.stream().map(request -> verifySource(request, verifiedAt)).toList();
    }

    private Map<String, Object> verifySource(SourceVerificationRequest request, OffsetDateTime verifiedAt) {
        boolean visible = !jdbc.query("SELECT id FROM meetings WHERE id=?",
            (rs, row) -> rs.getObject(1, UUID.class), request.meetingId()).isEmpty();
        boolean exists = sourceExists(request);
        Work probe = new Work(UUID.randomUUID(), request.meetingId(), request.sourceType(), request.sourceId(),
            request.sourceRevision(), null, null, 0, "verification", "verification", "0".repeat(64),
            "verification", "UPSERT", "NEW_REVISION", "PENDING", 0, null, null, null, null, null,
            null, null, null, null, null, null, null, null);
        SourceState source = source(probe);
        boolean current = exists && source.sameIdentity() && source.currentRevision() == request.sourceRevision();
        String status = !visible ? "NOT_VISIBLE" : !exists ? "DELETED"
            : !current ? "SUPERSEDED" : source.eligible() ? "CURRENT" : "INELIGIBLE";
        Map<String, Object> identity = Map.of("sourceType", request.sourceType(),
            "sourceId", request.sourceId().toString(), "meetingId", request.meetingId().toString());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("sourceIdentity", identity);
        result.put("sourceRevision", Map.of("number", request.sourceRevision()));
        if (source.currentRevision() >= 0) result.put("currentRevision",
            Map.of("number", source.currentRevision()));
        result.put("status", status);
        result.put("eligible", "CURRENT".equals(status));
        result.put("available", exists);
        result.put("visible", visible);
        result.put("verifiedAt", verifiedAt.toString());
        return result;
    }

    private boolean sourceExists(SourceVerificationRequest request) {
        String table = switch (request.sourceType()) {
            case "TRANSCRIPT" -> "transcripts";
            case "SUMMARY" -> "meeting_summary_versions";
            case "DECISION" -> "meeting_decisions";
            case "ACTION_ITEM" -> "action_items";
            default -> throw new IllegalArgumentException("Unsupported knowledge source type.");
        };
        return !jdbc.query("SELECT id FROM " + table + " WHERE meeting_id=? AND id=?",
            (rs, row) -> rs.getObject(1, UUID.class), request.meetingId(), request.sourceId()).isEmpty();
    }

    @Transactional
    public Map<String, Object> claim(UUID eventId, KnowledgeIndexingWorkerCommands.Claim command,
            String certificateFingerprint) {
        KnowledgeIndexingWorkerCommands.requireEvent(eventId, command.eventId());
        Work initial = find(eventId).orElseThrow(() -> new WorkerException(404, "WORKER_DELIVERY_UNKNOWN"));
        if (terminal(initial)) return statusData(initial, false);
        if (initial.publishedAt() == null) {
            throw WorkerException.conflict("WORKER_DELIVERY_NOT_PUBLISHED");
        }
        validateCommand(initial, command);
        lockMeeting(initial.meetingId());
        Work work = lock(eventId);

        if (terminal(work)) return statusData(work, false);
        int maxAttempts = properties.getKnowledgeIndexing().getMaxAttempts();
        if (maxAttempts < 1 || maxAttempts > 100) {
            throw new IllegalStateException("Invalid knowledge claim attempt limit");
        }
        if (work.attemptCount() >= maxAttempts) {
            jdbc.update("""
                UPDATE knowledge_indexing_work SET state='TERMINAL_FAILURE',
                  claim_token=NULL, claim_request_id=NULL, claim_fingerprint=NULL,
                  owner_certificate_sha256=NULL, claim_expires_at=NULL,
                  last_error_code='KNOWLEDGE_ATTEMPTS_EXHAUSTED',
                  last_error_summary='Knowledge indexing claim attempt limit was reached.',
                  updated_at=CURRENT_TIMESTAMP WHERE event_id=?
                """, eventId);
            return statusData(lock(eventId), false);
        }
        if (work.state().equals("CLAIMED") && live(work)) {
            if (command.claimRequestId().equals(work.claimRequestId())
                    && certificateFingerprint.equals(work.ownerCertificateSha256())
                    && KnowledgeIndexingWorkerCommands.fingerprint(command)
                        .equals(work.claimFingerprint())) {
                return claimData(work, false);
            }
            throw WorkerException.conflict("WORKER_ATTEMPT_BUSY");
        }
        if (work.state().equals("CLAIMED")) {
            clearClaim(eventId, "CLAIM_EXPIRED", "Previous knowledge indexing claim expired.");
            work = lock(eventId);
        }
        if (work.state().equals("RETRYABLE_FAILURE") && work.nextAttemptAt() != null
                && work.nextAttemptAt().isAfter(jdbc.queryForObject("SELECT CURRENT_TIMESTAMP", OffsetDateTime.class))) {
            throw WorkerException.conflict("WORKER_RETRY_BACKOFF");
        }
        if ("UPSERT".equals(work.operation())) {
            SourceState source = source(work);
            if (!source.eligible() || source.currentRevision() != work.sourceRevision()
                    || !source.sameIdentity()) {
                supersede(eventId);
                throw WorkerException.conflict("WORKER_SOURCE_SUPERSEDED");
            }
        }

        UUID token = UUID.randomUUID();
        int lease = properties.getKnowledgeIndexing().getLeaseSeconds();
        if (lease < 30 || lease > 7200) throw new IllegalStateException("Invalid knowledge claim lease");
        jdbc.update("""
            UPDATE knowledge_indexing_work
               SET state='CLAIMED', attempt_count=attempt_count+1,
                   claim_token=?, claim_request_id=?, claim_fingerprint=?,
                   owner_certificate_sha256=?, claim_expires_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                   next_attempt_at=CURRENT_TIMESTAMP, accepted_result_id=NULL,
                   accepted_outcome=NULL, accepted_receipt_sha256=NULL,
                   accepted_claim_token_sha256=NULL, indexed_chunk_count=NULL,
                   last_error_code=NULL, last_error_summary=NULL, updated_at=CURRENT_TIMESTAMP
             WHERE event_id=? AND state IN ('PENDING','RETRYABLE_FAILURE')
            """, token, command.claimRequestId(), KnowledgeIndexingWorkerCommands.fingerprint(command),
            certificateFingerprint, lease, eventId);
        return claimData(lock(eventId), false);
    }

    @Transactional
    public Map<String, Object> renew(UUID eventId, KnowledgeIndexingWorkerCommands.Owner command,
            String certificateFingerprint) {
        KnowledgeIndexingWorkerCommands.requireEvent(eventId, command.eventId());
        Work initial = find(eventId).orElseThrow(() -> new WorkerException(404, "WORKER_DELIVERY_UNKNOWN"));
        lockMeeting(initial.meetingId());
        Work work = lock(eventId);
        requireOwner(work, command, certificateFingerprint, true);
        int lease = properties.getKnowledgeIndexing().getLeaseSeconds();
        jdbc.update("""
            UPDATE knowledge_indexing_work
               SET claim_expires_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                   updated_at=CURRENT_TIMESTAMP
             WHERE event_id=? AND claim_token=? AND claim_expires_at>CURRENT_TIMESTAMP
            """, lease, eventId, command.claimToken());
        Work renewed = lock(eventId);
        return leaseData(renewed);
    }

    @Transactional
    public SnapshotResponse snapshot(UUID eventId, KnowledgeIndexingWorkerCommands.Owner command,
            String certificateFingerprint) {
        KnowledgeIndexingWorkerCommands.requireEvent(eventId, command.eventId());
        Work initial = find(eventId).orElseThrow(() -> new WorkerException(404, "WORKER_DELIVERY_UNKNOWN"));
        // Keep the meeting/work locks until the bytes have been read. A read-only
        // owner check followed by an unlocked snapshot read lets a replacement
        // claim race the response and defeats lease fencing.
        lockMeeting(initial.meetingId());
        Work work = lock(eventId);
        requireOwner(work, command, certificateFingerprint, true);
        if (!"UPSERT".equals(work.operation())) {
            throw WorkerException.conflict("WORKER_SNAPSHOT_INTEGRITY_UNAVAILABLE");
        }
        SnapshotRow snapshot = jdbc.queryForObject("""
            SELECT id,sha256,size_bytes,payload FROM knowledge_source_snapshots
            WHERE id=? AND source_type=? AND source_id=? AND source_revision=?
            """, (rs, row) -> new SnapshotRow(rs.getObject("id", UUID.class),
                rs.getString("sha256"), rs.getLong("size_bytes"), rs.getBytes("payload")),
            work.snapshotId(), work.sourceType(), work.sourceId(), work.sourceRevision());
        if (snapshot.payload() == null || snapshot.payload().length != snapshot.sizeBytes()
                || !snapshot.sha256().equals(sha256(snapshot.payload()))
                || !work.snapshotSha256().equals(snapshot.sha256())
                || work.snapshotSizeBytes() != snapshot.sizeBytes()) {
            throw new WorkerException(503, "WORKER_SNAPSHOT_INTEGRITY_UNAVAILABLE");
        }
        return new SnapshotResponse(snapshot.id(), snapshot.sha256(), snapshot.sizeBytes(), snapshot.payload());
    }

    @Transactional
    public Map<String, Object> result(UUID eventId, KnowledgeIndexingWorkerCommands.Result command,
            String certificateFingerprint) {
        KnowledgeIndexingWorkerCommands.requireEvent(eventId, command.eventId());
        Work initial = find(eventId).orElseThrow(() -> new WorkerException(404, "WORKER_DELIVERY_UNKNOWN"));
        lockMeeting(initial.meetingId());
        Work work = lock(eventId);
        if (terminal(work)) {
            if (sameResult(work, command)) return statusData(work, true);
            throw WorkerException.conflict("WORKER_RESULT_CONFLICT");
        }
        requireOwner(work, new KnowledgeIndexingWorkerCommands.Owner(command.contractVersion(),
            command.eventId(), command.claimToken()), certificateFingerprint, true);
        if (!work.indexGenerationId().equals(command.indexGenerationId())) {
            throw WorkerException.conflict("WORKER_GENERATION_CONFLICT");
        }
        if ("UPSERT".equals(work.operation())) {
            SourceState source = source(work);
            if (!source.eligible() || source.currentRevision() != work.sourceRevision()
                    || !source.sameIdentity()) {
                supersede(eventId);
                throw WorkerException.conflict("WORKER_SOURCE_SUPERSEDED");
            }
        }
        String state = command.state();
        if ("INVALIDATE".equals(work.operation()) && !"INVALIDATED".equals(state)
                || "DELETE".equals(work.operation()) && !"DELETED".equals(state)
                || "UPSERT".equals(work.operation()) && Set.of("INVALIDATED", "DELETED").contains(state)) {
            throw WorkerException.conflict("WORKER_RESULT_CONFLICT");
        }
        String errorCode = "NONE".equals(command.errorCode()) ? null : command.errorCode();
        jdbc.update("""
            UPDATE knowledge_indexing_work
               SET state=?, claim_token=NULL, claim_request_id=NULL, claim_fingerprint=NULL,
                   owner_certificate_sha256=NULL, claim_expires_at=NULL,
                   accepted_result_id=?, accepted_outcome=?, accepted_receipt_sha256=?,
                   accepted_claim_token_sha256=?, indexed_chunk_count=?,
                   last_error_code=?, last_error_summary=?,
                   next_attempt_at=CASE WHEN ?='RETRYABLE_FAILURE'
                       THEN CURRENT_TIMESTAMP + INTERVAL '5 seconds' ELSE CURRENT_TIMESTAMP END,
                   updated_at=CURRENT_TIMESTAMP
             WHERE event_id=? AND state='CLAIMED'
            """, state, command.resultId(), state, command.receiptSha256(),
            KnowledgeIndexingWorkerCommands.tokenHash(command.claimToken()), command.chunkCount(),
            errorCode, errorCode == null ? null : "Knowledge indexing worker reported a bounded failure.",
            state, eventId);
        return statusData(lock(eventId), false);
    }

    private void validateCommand(Work work, KnowledgeIndexingWorkerCommands.Claim command) {
        if (!work.meetingId().equals(command.meetingId()) || !work.sourceType().equals(command.sourceType())
                || !work.sourceId().equals(command.sourceId()) || work.sourceRevision() != command.sourceRevision()
                || !work.operation().equals(command.operation()) || !work.reason().equals(command.reason())
                || !work.indexGenerationId().equals(command.indexGenerationId())
                || !work.configurationVersion().equals(command.configurationVersion())
                || !work.configurationSha256().equals(command.configurationSha256())
                || !work.tokenizerId().equals(command.tokenizerId())) {
            throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        }
        if ("UPSERT".equals(work.operation())
                ? !Objects.equals(work.snapshotId(), command.snapshotId())
                    || !Objects.equals(work.snapshotSha256(), command.snapshotSha256())
                    || work.snapshotSizeBytes() != command.snapshotSizeBytes()
                : command.snapshotId() != null || command.snapshotSha256() != null
                    || command.snapshotSizeBytes() != 0) {
            throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        }
    }

    private void requireOwner(Work work, KnowledgeIndexingWorkerCommands.Owner command,
            String certificateFingerprint, boolean live) {
        if (!"CLAIMED".equals(work.state()) || !command.claimToken().equals(work.claimToken())
                || !certificateFingerprint.equals(work.ownerCertificateSha256())
                || live && !live(work)) {
            throw WorkerException.conflict("WORKER_LEASE_LOST");
        }
    }

    private boolean sameResult(Work work, KnowledgeIndexingWorkerCommands.Result result) {
        String errorCode = "NONE".equals(result.errorCode()) ? null : result.errorCode();
        return result.resultId().equals(work.acceptedResultId())
            && result.state().equals(work.acceptedOutcome())
            && result.indexGenerationId().equals(work.indexGenerationId())
            && result.chunkCount() == work.indexedChunkCount()
            && java.util.Objects.equals(errorCode, work.lastErrorCode())
            && result.receiptSha256().equals(work.acceptedReceiptSha256())
            && KnowledgeIndexingWorkerCommands.tokenHash(result.claimToken())
                .equals(work.acceptedClaimTokenSha256());
    }

    private Map<String, Object> claimData(Work work, boolean replay) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("contractVersion", "1.0");
        data.put("eventId", work.eventId());
        data.put("meetingId", work.meetingId());
        data.put("sourceIdentity", Map.of("sourceType", work.sourceType(),
            "sourceId", work.sourceId(), "meetingId", work.meetingId()));
        data.put("sourceRevision", Map.of("number", work.sourceRevision()));
        data.put("operation", work.operation());
        data.put("reason", work.reason());
        if ("UPSERT".equals(work.operation())) {
            data.put("snapshot", Map.of("snapshotId", work.snapshotId(), "sha256", work.snapshotSha256(),
                "sizeBytes", work.snapshotSizeBytes()));
        }
        data.put("indexGeneration", Map.of("generationId", work.indexGenerationId(),
            "configurationVersion", work.configurationVersion(),
            "configurationSha256", work.configurationSha256(), "tokenizerId", work.tokenizerId()));
        data.put("claimToken", work.claimToken());
        data.put("leaseExpiresAt", work.claimExpiresAt());
        data.put("serverTime", now());
        data.put("leaseSeconds", properties.getKnowledgeIndexing().getLeaseSeconds());
        data.put("renewAfterSeconds", Math.max(10, properties.getKnowledgeIndexing().getLeaseSeconds() / 3));
        data.put("replay", replay);
        return data;
    }

    private Map<String, Object> leaseData(Work work) {
        return Map.of("contractVersion", "1.0", "eventId", work.eventId(),
            "leaseExpiresAt", work.claimExpiresAt(), "serverTime", now(),
            "renewAfterSeconds", Math.max(10, properties.getKnowledgeIndexing().getLeaseSeconds() / 3));
    }

    private Map<String, Object> statusData(Work work, boolean replay) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("contractVersion", "1.0");
        data.put("eventId", work.eventId());
        data.put("meetingId", work.meetingId());
        data.put("sourceType", work.sourceType());
        data.put("sourceId", work.sourceId());
        data.put("sourceRevision", work.sourceRevision());
        data.put("operation", work.operation());
        data.put("reason", work.reason());
        data.put("indexGenerationId", work.indexGenerationId());
        data.put("state", work.state());
        data.put("acknowledge", terminal(work));
        data.put("attemptCount", work.attemptCount());
        data.put("replay", replay);
        if (work.acceptedResultId() != null) {
            data.put("resultId", work.acceptedResultId());
            data.put("chunkCount", work.indexedChunkCount());
            data.put("receiptSha256", work.acceptedReceiptSha256());
        }
        if (work.lastErrorCode() != null) data.put("errorCode", work.lastErrorCode());
        return data;
    }

    private boolean terminal(Work work) {
        return List.of("INDEXED", "NO_ELIGIBLE_CONTENT", "INVALIDATED", "DELETED", "TERMINAL_FAILURE", "SUPERSEDED")
            .contains(work.state());
    }

    private boolean live(Work work) {
        return work.claimExpiresAt() != null && work.claimExpiresAt().isAfter(now());
    }

    private void lockMeeting(UUID meetingId) {
        if (jdbc.query("SELECT id FROM meetings WHERE id=? FOR UPDATE",
                (rs, row) -> rs.getObject(1, UUID.class), meetingId).isEmpty()) {
            throw new WorkerException(404, "WORKER_DELIVERY_UNKNOWN");
        }
    }

    private Work lock(UUID eventId) {
        return jdbc.query("SELECT * FROM knowledge_indexing_work WHERE event_id=? FOR UPDATE",
            (rs, row) -> work(rs), eventId).stream().findFirst()
            .orElseThrow(() -> new WorkerException(404, "WORKER_DELIVERY_UNKNOWN"));
    }

    private java.util.Optional<Work> find(UUID eventId) {
        return jdbc.query("SELECT * FROM knowledge_indexing_work WHERE event_id=?",
            (rs, row) -> work(rs), eventId).stream().findFirst();
    }

    private void clearClaim(UUID eventId, String code, String summary) {
        jdbc.update("""
            UPDATE knowledge_indexing_work SET state='PENDING', claim_token=NULL,
              claim_request_id=NULL, claim_fingerprint=NULL, owner_certificate_sha256=NULL,
              claim_expires_at=NULL, last_error_code=?, last_error_summary=?,
              next_attempt_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
            WHERE event_id=?
            """, code, summary, eventId);
    }

    private void supersede(UUID eventId) {
        jdbc.update("""
            UPDATE knowledge_indexing_work SET state='SUPERSEDED', claim_token=NULL,
              claim_request_id=NULL, claim_fingerprint=NULL, owner_certificate_sha256=NULL,
              claim_expires_at=NULL, last_error_code='SOURCE_SUPERSEDED',
              last_error_summary='Canonical source is no longer the eligible current revision.',
              updated_at=CURRENT_TIMESTAMP WHERE event_id=?
            """, eventId);
    }

    private SourceState source(Work work) {
        return switch (work.sourceType()) {
            case "TRANSCRIPT" -> transcriptSource(work);
            case "SUMMARY" -> summarySource(work);
            case "DECISION" -> decisionSource(work);
            case "ACTION_ITEM" -> actionSource(work);
            default -> new SourceState(-1, false, false);
        };
    }

    private SourceState transcriptSource(Work work) {
        return jdbc.query("""
            SELECT id,content_revision,status,finalized_at,
                   EXISTS(SELECT 1 FROM transcript_segments s WHERE s.transcript_id=t.id) AS has_content
              FROM transcripts t WHERE meeting_id=? AND is_current
            """, (rs, row) -> {
                UUID id = rs.getObject("id", UUID.class);
                long revision = rs.getLong("content_revision");
                boolean eligible = work.sourceId().equals(id)
                    && List.of("READY", "READY_WITH_WARNINGS").contains(rs.getString("status"))
                    && rs.getObject("finalized_at") != null && rs.getBoolean("has_content");
                return new SourceState(revision, eligible, work.sourceId().equals(id));
            }, work.meetingId()).stream().findFirst().orElse(new SourceState(-1, false, false));
    }

    private SourceState summarySource(Work work) {
        return jdbc.query("""
            SELECT s.id,s.version_number,s.is_current,s.quality_status,s.transcript_id,
                   s.content_revision,current_source.id AS current_transcript_id,
                   current_source.content_revision AS current_transcript_revision,
                   current_source.status AS current_transcript_status
              FROM meeting_summary_versions s
              LEFT JOIN transcripts current_source
                ON current_source.meeting_id=s.meeting_id AND current_source.is_current
             WHERE s.meeting_id=? AND s.id=?
            """, (rs, row) -> {
                UUID id = rs.getObject("id", UUID.class);
                Long revision = nullableLong(rs, "content_revision");
                boolean stale = rs.getObject("transcript_id") != null &&
                    (rs.getObject("current_transcript_id") == null
                    || !rs.getObject("transcript_id", UUID.class).equals(
                        rs.getObject("current_transcript_id", UUID.class))
                    || !java.util.Objects.equals(revision, nullableLong(rs, "current_transcript_revision"))
                    || !List.of("READY", "READY_WITH_WARNINGS").contains(rs.getString("current_transcript_status")));
                boolean eligible = rs.getBoolean("is_current") && !stale
                    && List.of("READY", "READY_WITH_WARNINGS").contains(rs.getString("quality_status"));
                return new SourceState(rs.getLong("version_number"), eligible, work.sourceId().equals(id));
            }, work.meetingId(), work.sourceId()).stream().findFirst().orElse(new SourceState(-1, false, false));
    }

    private SourceState decisionSource(Work work) {
        return jdbc.query("""
            SELECT d.id,d.version,d.status,d.transcript_id,d.content_revision,
                   current_source.id AS current_transcript_id,
                   current_source.content_revision AS current_transcript_revision,
                   current_source.status AS current_transcript_status
              FROM meeting_decisions d
              LEFT JOIN transcripts current_source
                ON current_source.meeting_id=d.meeting_id AND current_source.is_current
             WHERE d.meeting_id=? AND d.id=?
            """, (rs, row) -> {
                UUID id = rs.getObject("id", UUID.class);
                UUID transcript = rs.getObject("transcript_id", UUID.class);
                Long revision = nullableLong(rs, "content_revision");
                boolean stale = transcript != null && (rs.getObject("current_transcript_id") == null
                    || !transcript.equals(rs.getObject("current_transcript_id", UUID.class))
                    || !java.util.Objects.equals(revision, nullableLong(rs, "current_transcript_revision"))
                    || !List.of("READY", "READY_WITH_WARNINGS").contains(rs.getString("current_transcript_status")));
                return new SourceState(rs.getLong("version"), "CONFIRMED".equals(rs.getString("status"))
                    && !stale, work.sourceId().equals(id));
            }, work.meetingId(), work.sourceId()).stream().findFirst().orElse(new SourceState(-1, false, false));
    }

    private SourceState actionSource(Work work) {
        return jdbc.query("""
            SELECT id,version,status,source_type,confirmed_by_user_id
              FROM action_items WHERE meeting_id=? AND id=?
            """, (rs, row) -> {
                UUID id = rs.getObject("id", UUID.class);
                boolean official = "MANUAL".equals(rs.getString("source_type"))
                    || rs.getObject("confirmed_by_user_id") != null;
                return new SourceState(rs.getLong("version"), official && !"PROPOSED".equals(rs.getString("status")),
                    work.sourceId().equals(id));
            }, work.meetingId(), work.sourceId()).stream().findFirst().orElse(new SourceState(-1, false, false));
    }

    private OffsetDateTime now() {
        return jdbc.queryForObject("SELECT CURRENT_TIMESTAMP", OffsetDateTime.class);
    }

    private static Work work(ResultSet rs) throws SQLException {
        return new Work(rs.getObject("event_id", UUID.class), rs.getObject("meeting_id", UUID.class),
            rs.getString("source_type"), rs.getObject("source_id", UUID.class), rs.getLong("source_revision"),
            rs.getObject("snapshot_id", UUID.class), rs.getString("snapshot_sha256"),
            rs.getLong("snapshot_size_bytes"), rs.getString("index_generation_id"),
            rs.getString("configuration_version"), rs.getString("configuration_sha256"),
            rs.getString("tokenizer_id"), rs.getString("operation"), rs.getString("reason"),
            rs.getString("state"), rs.getInt("attempt_count"),
            rs.getObject("claim_token", UUID.class), rs.getObject("claim_request_id", UUID.class),
            rs.getString("claim_fingerprint"), rs.getString("owner_certificate_sha256"),
            rs.getObject("claim_expires_at", OffsetDateTime.class),
            rs.getObject("next_attempt_at", OffsetDateTime.class),
            rs.getObject("accepted_result_id", UUID.class), rs.getString("accepted_outcome"),
            rs.getString("accepted_receipt_sha256"), rs.getString("accepted_claim_token_sha256"),
            (Integer) rs.getObject("indexed_chunk_count"), rs.getString("last_error_code"),
            rs.getObject("published_at", OffsetDateTime.class));
    }

    private static Long nullableLong(ResultSet rs, String name) throws SQLException {
        long value = rs.getLong(name);
        return rs.wasNull() ? null : value;
    }

    private static String sha256(byte[] bytes) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    public record SnapshotResponse(UUID snapshotId, String sha256, long sizeBytes, byte[] bytes) {
        public SnapshotResponse { bytes = bytes.clone(); }
        @Override public byte[] bytes() { return bytes.clone(); }
    }

    public record SourceVerificationRequest(String sourceType, UUID sourceId, UUID meetingId,
            long sourceRevision) { }

    private record SnapshotRow(UUID id, String sha256, long sizeBytes, byte[] payload) { }
    private record SourceState(long currentRevision, boolean eligible, boolean sameIdentity) { }
    private record Work(UUID eventId, UUID meetingId, String sourceType, UUID sourceId,
            long sourceRevision, UUID snapshotId, String snapshotSha256, long snapshotSizeBytes,
            String indexGenerationId, String configurationVersion, String configurationSha256,
            String tokenizerId, String operation, String reason, String state, int attemptCount,
            UUID claimToken, UUID claimRequestId,
            String claimFingerprint, String ownerCertificateSha256, OffsetDateTime claimExpiresAt,
            OffsetDateTime nextAttemptAt, UUID acceptedResultId, String acceptedOutcome,
            String acceptedReceiptSha256, String acceptedClaimTokenSha256, Integer indexedChunkCount,
            String lastErrorCode, OffsetDateTime publishedAt) { }
}
