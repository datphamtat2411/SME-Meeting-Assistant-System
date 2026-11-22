package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultPayload.GroundingDiagnostic;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultPayload.GroundingDiagnosticCounts;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultPayload.GroundingEvidence;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultPayload.GroundingReference;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Transactional, content-free persistence for claim-level grounding outcomes.
 *
 * The owner is either an accepted MI result receipt or an accepted Action Item
 * batch receipt. Transcript text is intentionally absent; only allowlisted
 * hashes, coordinates, lengths, markers and assessments are retained.
 */
@Service
public class GroundingDiagnosticPersistence {
    private static final int MAX_DIAGNOSTICS = 32;
    private static final int MAX_REFERENCES = 16;
    private static final int MAX_REFERENCE_OFFSET = 8_388_608;
    private static final int MAX_ITEM_INDEX = 10_000;
    private static final int MAX_STATEMENT_CHARS = 2_000;
    private static final int MAX_EVIDENCE_CHARS = 8_388_608;
    private static final Set<String> LEGACY_DISPOSITIONS = Set.of("DISCARDED", "REPAIRED");
    private static final Set<String> CLAIM_DISPOSITIONS = Set.of("ACCEPTED", "REJECTED");
    private static final Set<String> REASONS = Set.of(
        "INVALID_REFERENCE", "GROUNDING_FAILURE", "SUPPORTED", "UNSUPPORTED",
        "MISSING_REFERENCE", "STALE", "CONTRADICTED", "UNCERTAIN",
        "REVISION_MISMATCH");
    private static final Set<String> CLAIM_REASONS = Set.of(
        "SUPPORTED", "UNSUPPORTED", "INVALID_REFERENCE", "MISSING_REFERENCE",
        "STALE", "CONTRADICTED", "UNCERTAIN", "REVISION_MISMATCH",
        "GROUNDING_FAILURE");
    private static final Set<String> CLAIM_STAGES = Set.of(
        "GENERATING_SUMMARY", "EXTRACTING_DECISIONS", "EXTRACTING_ACTION_ITEMS");
    private static final Set<String> RULES = Set.of(
        "SOURCE_IDENTITY", "REFERENCE_SHAPE", "REFERENCE_SEGMENT_NOT_FOUND", "REFERENCE_RANGE",
        "REFERENCE_DUPLICATE", "REFERENCE_OUTSIDE_WINDOW", "REFERENCE_NOT_ALLOWED", "TEXT_POLICY",
        "STATEMENT_NOT_GROUNDED", "QUALIFICATION_NOT_GROUNDED", "UNSUPPORTED_NUMBER",
        "AGREEMENT_UNSUPPORTED", "AGREEMENT_CONTRADICTED", "REDUCTION_COVERAGE", "REDUCTION_EMPTY",
        "CLAIM_SECTION", "CLAIM_NOT_MATCHED", "CLAIM_UNCERTAINTY", "CLAIM_CONFLICT_UNRESOLVED",
        "CLAIM_NOT_GROUNDED", "CLAIM_RECORD_GROUNDING", "CLAIM_QUALIFICATION_GROUNDING",
        "MATERIAL_CLAIM_COVERAGE");
    private static final Set<String> ASSESSMENTS = Set.of(
        "SUPPORTED", "NEGATIVE_OR_TENTATIVE", "INCOMPLETE_CITATION",
        "POSSIBLE_VALIDATOR_FALSE_NEGATIVE", "UNSUPPORTED_MODEL_CLASSIFICATION");

    private final JdbcTemplate jdbc;
    private final TranscriptSourceGuard transcripts;

    public GroundingDiagnosticPersistence(JdbcTemplate jdbc, TranscriptSourceGuard transcripts) {
        this.jdbc = jdbc;
        this.transcripts = transcripts;
    }

    public record Source(UUID snapshotId, UUID transcriptId, long contentRevision,
                         String sha256) {}

    @Transactional(propagation = Propagation.MANDATORY)
    public void persistForResult(UUID meetingId, UUID resultReceiptId, Source source,
            List<GroundingDiagnostic> diagnostics) {
        persist(meetingId, resultReceiptId, null, source, diagnostics,
            counts("0.0", diagnostics));
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void persistForResult(UUID meetingId, UUID resultReceiptId, Source source,
            List<GroundingDiagnostic> diagnostics, GroundingDiagnosticCounts counts) {
        persist(meetingId, resultReceiptId, null, source, diagnostics, counts);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void persistForActionItemBatch(UUID meetingId, UUID batchReceiptId, Source source,
            List<GroundingDiagnostic> diagnostics) {
        persist(meetingId, null, batchReceiptId, source, diagnostics,
            counts("0.0", diagnostics));
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void persistForActionItemBatch(UUID meetingId, UUID batchReceiptId, Source source,
            List<GroundingDiagnostic> diagnostics, GroundingDiagnosticCounts counts) {
        persist(meetingId, null, batchReceiptId, source, diagnostics, counts);
    }

    private void persist(UUID meetingId, UUID resultReceiptId, UUID batchReceiptId,
            Source source, List<GroundingDiagnostic> diagnostics,
            GroundingDiagnosticCounts counts) {
        validateSource(source);
        List<GroundingDiagnostic> normalized = validateDiagnostics(meetingId, source, diagnostics);
        GroundingDiagnosticCounts normalizedCounts = validateCounts(counts, normalized);
        boolean resultOwner = resultReceiptId != null;
        String ownerColumn = resultOwner ? "result_receipt_id" : "action_item_batch_receipt_id";
        UUID ownerId = resultOwner ? resultReceiptId : batchReceiptId;
        if (ownerId == null) throw new IllegalArgumentException("Diagnostic receipt owner is required.");

        List<GroundingDiagnostic> existing = load(ownerColumn, ownerId);
        if (!existing.isEmpty()) {
            if (!existing.equals(normalized)) {
                throw new IllegalArgumentException("Grounding diagnostics differ for an accepted receipt.");
            }
        } else if (!normalized.isEmpty()) {
            insertDiagnostics(meetingId, resultReceiptId, batchReceiptId, normalized);
        }
        GroundingDiagnosticCounts existingCounts = loadCounts(ownerColumn, ownerId);
        if (existingCounts != null && !existingCounts.equals(normalizedCounts)) {
            throw new IllegalArgumentException(
                "Grounding diagnostic counts differ for an accepted receipt.");
        }
        if (existingCounts == null) insertCounts(
            meetingId, resultReceiptId, batchReceiptId, normalizedCounts);
    }

    private void insertDiagnostics(UUID meetingId, UUID resultReceiptId, UUID batchReceiptId,
            List<GroundingDiagnostic> normalized) {
        for (int index = 0; index < normalized.size(); index++) {
            GroundingDiagnostic diagnostic = normalized.get(index);
            GroundingEvidence evidence = diagnostic.evidence();
            UUID diagnosticId = UUID.randomUUID();
            jdbc.update("""
                INSERT INTO meeting_intelligence_grounding_diagnostics(
                    id,meeting_id,result_receipt_id,action_item_batch_receipt_id,
                    diagnostic_index,disposition,reason,rule,item_index,
                    source_snapshot_id,transcript_id,content_revision,source_sha256,
                    model_category,statement_sha256,statement_char_length,
                    evidence_sha256,evidence_char_length,affirmative_marker,
                    negative_marker,assessment,diagnostic_version,stage_code,
                    fingerprint,warning_codes)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::text[])
                """,
                diagnosticId, meetingId, resultReceiptId, batchReceiptId, index,
                diagnostic.disposition(), diagnostic.reason(), diagnostic.rule(),
                diagnostic.itemIndex(),
                evidence == null ? null : evidence.sourceSnapshotId(),
                evidence == null ? null : evidence.transcriptId(),
                evidence == null ? null : evidence.contentRevision(),
                evidence == null ? null : evidence.sourceSha256(),
                evidence == null ? null : evidence.modelCategory(),
                evidence == null ? null : evidence.statementSha256(),
                evidence == null ? null : evidence.statementCharLength(),
                evidence == null ? null : evidence.evidenceSha256(),
                evidence == null ? null : evidence.evidenceCharLength(),
                evidence == null ? null : evidence.affirmativeMarker(),
                evidence == null ? null : evidence.negativeMarker(),
                evidence == null ? null : evidence.assessment(),
                diagnostic.diagnosticVersion(), diagnostic.stage(), diagnostic.fingerprint(),
                AiQualityMetadata.pgArray(diagnostic.warningCodes()));
            if (evidence != null) {
                for (int referenceIndex = 0; referenceIndex < evidence.references().size();
                        referenceIndex++) {
                    GroundingReference reference = evidence.references().get(referenceIndex);
                    jdbc.update("""
                        INSERT INTO meeting_intelligence_grounding_diagnostic_references(
                            diagnostic_id,reference_index,transcript_id,transcript_segment_id,
                            char_start,char_end)
                        VALUES (?,?,?,?,?,?)
                        """,
                        diagnosticId, referenceIndex, evidence.transcriptId(),
                        reference.segmentId(), reference.charStart(), reference.charEnd());
                }
            }
        }
    }

    private void insertCounts(UUID meetingId, UUID resultReceiptId, UUID batchReceiptId,
            GroundingDiagnosticCounts counts) {
        jdbc.update("""
            INSERT INTO meeting_intelligence_grounding_diagnostic_reconciliations(
                id,meeting_id,result_receipt_id,action_item_batch_receipt_id,
                diagnostic_version,accepted_count,rejected_count,discarded_count,
                repaired_count,total_count)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """, UUID.randomUUID(), meetingId, resultReceiptId, batchReceiptId,
            counts.version(), counts.accepted(), counts.rejected(), counts.discarded(),
            counts.repaired(), counts.total());
    }

    private List<GroundingDiagnostic> validateDiagnostics(UUID meetingId, Source source,
            List<GroundingDiagnostic> diagnostics) {
        if (diagnostics == null || diagnostics.size() > MAX_DIAGNOSTICS) {
            throw new IllegalArgumentException("Grounding diagnostic count exceeds bounds.");
        }
        List<GroundingDiagnostic> normalized = new ArrayList<>();
        for (GroundingDiagnostic diagnostic : diagnostics) {
            if (diagnostic == null
                    || !LEGACY_DISPOSITIONS.contains(diagnostic.disposition())
                        && !CLAIM_DISPOSITIONS.contains(diagnostic.disposition())
                    || !REASONS.contains(diagnostic.reason())
                    || diagnostic.rule() != null && !RULES.contains(diagnostic.rule())
                    || diagnostic.itemIndex() != null
                        && (diagnostic.itemIndex() < 0 || diagnostic.itemIndex() > MAX_ITEM_INDEX)) {
                throw new IllegalArgumentException("Invalid grounding diagnostic.");
            }
            boolean claim = CLAIM_DISPOSITIONS.contains(diagnostic.disposition());
            if (claim) {
                if (!"1.0".equals(diagnostic.diagnosticVersion())
                        || !CLAIM_STAGES.contains(diagnostic.stage())
                        || !CLAIM_REASONS.contains(diagnostic.reason())
                        || !digest(diagnostic.fingerprint())
                        || diagnostic.warningCodes() == null
                        || diagnostic.warningCodes().size() > 6
                        || diagnostic.warningCodes().stream().anyMatch(
                            code -> !AiQualityMetadata.ALLOWED.contains(code))
                        || diagnostic.warningCodes().stream().distinct().count()
                            != diagnostic.warningCodes().size()) {
                    throw new IllegalArgumentException("Invalid versioned grounding diagnostic.");
                }
            } else if (diagnostic.diagnosticVersion() != null
                    || diagnostic.stage() != null || diagnostic.fingerprint() != null
                    || diagnostic.warningCodes() == null
                    || !diagnostic.warningCodes().isEmpty()) {
                throw new IllegalArgumentException("Invalid legacy grounding diagnostic.");
            }
            GroundingEvidence evidence = diagnostic.evidence();
            if (evidence != null) {
                if (!source.snapshotId().equals(evidence.sourceSnapshotId())
                        || !source.transcriptId().equals(evidence.transcriptId())
                        || source.contentRevision() != evidence.contentRevision()
                        || !source.sha256().equals(evidence.sourceSha256())) {
                    throw new IllegalArgumentException("Grounding diagnostic source identity is not trusted.");
                }
                if (evidence.references() == null || evidence.references().isEmpty()
                        || evidence.references().size() > MAX_REFERENCES
                        || evidence.modelCategory() == null
                        || !evidence.modelCategory().matches("[A-Z_]{1,32}")
                        || !ASSESSMENTS.contains(evidence.assessment())
                        || !digest(evidence.statementSha256())
                        || !digest(evidence.evidenceSha256())
                        || evidence.statementCharLength() < 0
                        || evidence.statementCharLength() > MAX_STATEMENT_CHARS
                        || evidence.evidenceCharLength() < 0
                        || evidence.evidenceCharLength() > MAX_EVIDENCE_CHARS) {
                    throw new IllegalArgumentException("Invalid grounding diagnostic evidence.");
                }
                Set<GroundingReference> distinct = new HashSet<>();
                List<UUID> segmentIds = new ArrayList<>();
                for (GroundingReference reference : evidence.references()) {
                    if (reference == null || reference.segmentId() == null
                            || reference.charStart() < 0 || reference.charStart() > MAX_REFERENCE_OFFSET
                            || reference.charEnd() < 0 || reference.charEnd() > MAX_REFERENCE_OFFSET
                            || reference.charStart() > reference.charEnd()
                         || !distinct.add(reference)) {
                        throw new IllegalArgumentException("Invalid grounding diagnostic reference.");
                    }
                    if (!segmentIds.contains(reference.segmentId())) {
                        segmentIds.add(reference.segmentId());
                    }
                }
                transcripts.requireDerivedSegments(meetingId, source.transcriptId(), segmentIds);
            }
            normalized.add(diagnostic);
        }
        return List.copyOf(normalized);
    }

    private static GroundingDiagnosticCounts counts(String version,
            List<GroundingDiagnostic> diagnostics) {
        int accepted = 0;
        int rejected = 0;
        int discarded = 0;
        int repaired = 0;
        for (GroundingDiagnostic diagnostic : diagnostics == null ? List.<GroundingDiagnostic>of()
                : diagnostics) {
            switch (diagnostic.disposition()) {
                case "ACCEPTED" -> accepted++;
                case "REJECTED" -> rejected++;
                case "DISCARDED" -> discarded++;
                case "REPAIRED" -> repaired++;
                default -> throw new IllegalArgumentException("Invalid grounding diagnostic disposition.");
            }
        }
        return new GroundingDiagnosticCounts(version, accepted, rejected, discarded, repaired,
            accepted + rejected + discarded + repaired);
    }

    private static GroundingDiagnosticCounts validateCounts(GroundingDiagnosticCounts counts,
            List<GroundingDiagnostic> diagnostics) {
        if (counts == null || (!"0.0".equals(counts.version())
                && !"1.0".equals(counts.version()))
                || counts.accepted() < 0 || counts.rejected() < 0
                || counts.discarded() < 0 || counts.repaired() < 0 || counts.total() < 0
                || counts.total() > MAX_DIAGNOSTICS) {
            throw new IllegalArgumentException("Invalid grounding diagnostic counts.");
        }
        if (diagnostics.stream().anyMatch(diagnostic ->
                CLAIM_DISPOSITIONS.contains(diagnostic.disposition()))
                && !"1.0".equals(counts.version())) {
            throw new IllegalArgumentException(
                "Versioned grounding diagnostics require version 1.0 counts.");
        }
        GroundingDiagnosticCounts expected = counts(counts.version(), diagnostics);
        if (!expected.equals(counts)) {
            throw new IllegalArgumentException("Grounding diagnostic count reconciliation failed.");
        }
        return counts;
    }

    private static void validateSource(Source source) {
        if (source == null || source.snapshotId() == null || source.transcriptId() == null
                || source.contentRevision() < 0 || !digest(source.sha256())) {
            throw new IllegalArgumentException("Trusted grounding source is required.");
        }
    }

    private static boolean digest(String value) {
        return value != null && value.matches("[0-9a-f]{64}");
    }

    private List<GroundingDiagnostic> load(String ownerColumn, UUID ownerId) {
        String sql = """
            SELECT id,disposition,reason,rule,item_index,source_snapshot_id,transcript_id,
                   content_revision,source_sha256,model_category,statement_sha256,
                   statement_char_length,evidence_sha256,evidence_char_length,
                   affirmative_marker,negative_marker,assessment,diagnostic_version,
                   stage_code,fingerprint,array_to_string(warning_codes,',') AS warning_codes_csv
              FROM meeting_intelligence_grounding_diagnostics
             WHERE %s=?
             ORDER BY diagnostic_index
            """.formatted(ownerColumn);
        return jdbc.query(sql, (rs, index) -> readDiagnostic(rs), ownerId);
    }

    private GroundingDiagnostic readDiagnostic(ResultSet rs) throws SQLException {
        UUID diagnosticId = rs.getObject("id", UUID.class);
        UUID snapshotId = rs.getObject("source_snapshot_id", UUID.class);
        GroundingEvidence evidence = null;
        if (snapshotId != null) {
            UUID transcriptId = rs.getObject("transcript_id", UUID.class);
            long revisionValue = rs.getLong("content_revision");
            int statementLength = rs.getInt("statement_char_length");
            int evidenceLength = rs.getInt("evidence_char_length");
            evidence = new GroundingEvidence(snapshotId, transcriptId, revisionValue,
                rs.getString("source_sha256"), loadReferences(diagnosticId),
                rs.getString("model_category"), rs.getString("statement_sha256"),
                statementLength, rs.getString("evidence_sha256"), evidenceLength,
                rs.getBoolean("affirmative_marker"), rs.getBoolean("negative_marker"),
                rs.getString("assessment"));
        }
        Integer itemIndex = (Integer) rs.getObject("item_index");
        return new GroundingDiagnostic(rs.getString("disposition"), rs.getString("reason"),
            rs.getString("rule"), itemIndex, evidence,
            rs.getString("diagnostic_version"), rs.getString("stage_code"),
            rs.getString("fingerprint"), AiQualityMetadata.fromCsv(rs.getString("warning_codes_csv")));
    }

    private List<GroundingReference> loadReferences(UUID diagnosticId) {
        return jdbc.query("""
            SELECT transcript_segment_id,char_start,char_end
              FROM meeting_intelligence_grounding_diagnostic_references
             WHERE diagnostic_id=?
             ORDER BY reference_index
            """, (rs, index) -> new GroundingReference(
                rs.getObject("transcript_segment_id", UUID.class),
                rs.getInt("char_start"), rs.getInt("char_end")), diagnosticId);
    }

    private GroundingDiagnosticCounts loadCounts(String ownerColumn, UUID ownerId) {
        String sql = """
            SELECT diagnostic_version,accepted_count,rejected_count,discarded_count,
                   repaired_count,total_count
              FROM meeting_intelligence_grounding_diagnostic_reconciliations
             WHERE %s=?
            """.formatted(ownerColumn);
        List<GroundingDiagnosticCounts> rows = jdbc.query(sql, (rs, index) ->
            new GroundingDiagnosticCounts(rs.getString("diagnostic_version"),
                rs.getInt("accepted_count"), rs.getInt("rejected_count"),
                rs.getInt("discarded_count"), rs.getInt("repaired_count"),
                rs.getInt("total_count")), ownerId);
        if (rows.size() > 1) throw new IllegalStateException("Duplicate grounding reconciliation.");
        return rows.isEmpty() ? null : rows.getFirst();
    }
}
