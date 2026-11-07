package com.sme.meetingassistant.api.meetingminutes;

import com.sme.meetingassistant.api.actionitems.application.ActionItemMinutesSource;
import com.sme.meetingassistant.api.meeting.service.MeetingMinutesSource;
import com.sme.meetingassistant.api.meetingintelligence.dto.DecisionView;
import com.sme.meetingassistant.api.meetingintelligence.dto.SummaryView;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceMinutesSource;
import com.sme.meetingassistant.api.transcript.service.TranscriptMinutesSource;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

/**
 * DE-05 canonical, read-only and consistency-safe source assembly.
 *
 * The authorization is checked on the Meeting source FIRST. Source-domain
 * ports independently enforce content permissions. REPEATABLE_READ establishes
 * a single PostgreSQL snapshot across canonical SQL/JPA reads, including
 * current summary selection and transcript revision. Do not call this inside
 * an existing weaker transaction.
 */
@Service
public class MinutesAssembler {
    private static final int SCHEMA_VERSION = 1;
    private final MeetingMinutesSource meetings;
    private final IntelligenceMinutesSource intelligence;
    private final ActionItemMinutesSource actions;
    private final TranscriptMinutesSource transcripts;
    private final AuthenticatedUserId principal;
    private final ObjectMapper json;
    private final Clock clock;

    public MinutesAssembler(MeetingMinutesSource meetings,
            IntelligenceMinutesSource intelligence, ActionItemMinutesSource actions,
            TranscriptMinutesSource transcripts, AuthenticatedUserId principal,
            ObjectMapper json, Clock clock) {
        this.meetings = meetings;
        this.intelligence = intelligence;
        this.actions = actions;
        this.transcripts = transcripts;
        this.principal = principal;
        this.json = json;
        this.clock = clock;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public MinutesSnapshot current(UUID meetingId) {
        // Identity may not be supplied by client query/body. The Meeting-owned
        // authorization is enforced before any content source is touched.
        UUID actor = principal.requireUserId();
        var canonicalMeeting = meetings.authorizedMeeting(meetingId);
        if (!actor.equals(principal.requireUserId())) {
            throw new IllegalStateException("Current authenticated actor changed");
        }

        var meeting = new MinutesSnapshot.Meeting(
                canonicalMeeting.id(), canonicalMeeting.title(),
                canonicalMeeting.description(), canonicalMeeting.organizerUserId(),
                canonicalMeeting.status(), canonicalMeeting.scheduledStartAt(),
                canonicalMeeting.scheduledEndAt(), canonicalMeeting.startedAt(),
                canonicalMeeting.endedAt());

        var currentTranscript = transcripts.currentReference(meetingId);
        var transcript = currentTranscript.map(t -> new MinutesSnapshot.Transcript(
                "READY".equals(t.status()) && t.suspiciousSegments() == 0
                        && t.unresolvedSegments() == 0 && t.unresolvedCoverageRegions() == 0
                        ? "AVAILABLE" : ("PROCESSING".equals(t.status()) ? "PROCESSING"
                        : ("FAILED".equals(t.status()) ? "FAILED" : "NEEDS_REVIEW")),
                t.id(), t.processingJobId(), t.versionNumber(), t.languageCode(),
                t.status(), t.contentRevision(), t.durationMs(),
                t.suspiciousSegments(), t.unresolvedSegments(),
                t.unresolvedCoverageRegions()))
            .orElse(new MinutesSnapshot.Transcript(
                    "NOT_AVAILABLE", null, null, null, null, null, null, null, 0, 0, 0));

        var mi = intelligence.currentApproved(meetingId);
        var summary = mi.summary().map(s -> new MinutesSnapshot.Summary(
                s.isStale() || "READY_WITH_WARNINGS".equals(s.qualityStatus())
                        || !s.aiWarnings().isEmpty() ? "NEEDS_REVIEW" : "AVAILABLE",
                s.id(), s.versionNumber(), s.content(), s.sourceType(),
                s.qualityStatus(), s.transcriptId(), s.contentRevision(),
                s.isStale(), s.aiWarnings()))
            .orElse(new MinutesSnapshot.Summary(
                    "NOT_AVAILABLE", null, null, null, null, null, null, null,
                    false, List.of()));

        List<MinutesSnapshot.Decision> decisions = mi.confirmedDecisions().stream()
            .map(MinutesAssembler::decision).toList();
        List<MinutesSnapshot.Action> official = actions.officialForMeeting(meetingId).stream()
            .map(a -> new MinutesSnapshot.Action(
                    a.id(), a.title(), a.details(), a.status().name(), a.sourceType(),
                    a.assigneeUserId(), a.dueDate(), a.version(), a.createdAt(),
                    a.confirmedByUserId(), a.confirmedAt())).toList();

        LinkedHashSet<String> warnings = new LinkedHashSet<>();
        if ("NOT_AVAILABLE".equals(transcript.availability())) warnings.add("TRANSCRIPT_NOT_AVAILABLE");
        if ("PROCESSING".equals(transcript.availability())) warnings.add("TRANSCRIPT_PROCESSING");
        if ("FAILED".equals(transcript.availability())) warnings.add("TRANSCRIPT_FAILED");
        if (transcript.suspiciousSegments() > 0) warnings.add("TRANSCRIPT_SUSPICIOUS_SEGMENTS");
        if (transcript.unresolvedSegments() > 0) warnings.add("TRANSCRIPT_UNRESOLVED_SEGMENTS");
        if (transcript.unresolvedCoverageRegions() > 0) warnings.add("TRANSCRIPT_INCOMPLETE_COVERAGE");
        if ("NEEDS_REVIEW".equals(transcript.availability())
                && transcript.suspiciousSegments() == 0
                && transcript.unresolvedSegments() == 0
                && transcript.unresolvedCoverageRegions() == 0) {
            warnings.add("TRANSCRIPT_QUALITY_WARNING");
        }
        if ("NOT_AVAILABLE".equals(summary.availability())) warnings.add("SUMMARY_NOT_AVAILABLE");
        if (summary.isStale()) warnings.add("SUMMARY_SOURCE_STALE");
        if ("READY_WITH_WARNINGS".equals(summary.qualityStatus())
                || !summary.aiWarnings().isEmpty()) warnings.add("SUMMARY_QUALITY_WARNING");
        for (MinutesSnapshot.Decision d : decisions) {
            if (d.isStale()) warnings.add("DECISION_SOURCE_STALE");
            if ("MATERIAL".equals(d.aiUncertainty()) || !d.aiWarnings().isEmpty()) {
                warnings.add("DECISION_EVIDENCE_WARNING");
            }
        }
        List<String> warningCodes = List.copyOf(warnings);
        String completeness = warningCodes.isEmpty() ? "COMPLETE"
                : (warnings.stream().anyMatch(w -> w.contains("SUSPICIOUS")
                    || w.contains("UNRESOLVED") || w.contains("QUALITY")
                    || w.contains("STALE") || w.contains("COVERAGE"))
                    ? "NEEDS_REVIEW" : "PARTIAL");

        var content = new MinutesSnapshot.CanonicalContent(
                SCHEMA_VERSION, completeness, meeting, summary,
                decisions, official, transcript, warningCodes, false);
        // Versioned SHA-256 over deterministic typed JSON fields. Never hash
        // assembledAt; identical canonical snapshots have identical fingerprints.
        String fingerprint = fingerprint(content);
        OffsetDateTime assembledAt = clock.instant().atOffset(ZoneOffset.UTC);
        return new MinutesSnapshot(SCHEMA_VERSION, assembledAt, fingerprint,
                completeness, meeting, summary, decisions, official, transcript,
                warningCodes, false);
    }

    private static MinutesSnapshot.Decision decision(DecisionView d) {
        if (!"CONFIRMED".equals(d.status())) {
            throw new IllegalStateException("Unreviewed Decision reached official Minutes");
        }
        return new MinutesSnapshot.Decision(
                d.id(), d.content(), d.status(), d.sourceType(), d.transcriptId(),
                d.contentRevision(), d.isStale(), d.version(), d.confirmedByUserId(),
                d.confirmedAt(), d.evidenceSegmentIds(), d.aiUncertainty(), d.aiWarnings());
    }

    private String fingerprint(MinutesSnapshot.CanonicalContent content) {
        try {
            byte[] canonical = json.writeValueAsBytes(content);
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(sha.digest(canonical));
        } catch (JacksonException | NoSuchAlgorithmException unexpected) {
            throw new IllegalStateException("Canonical Minutes fingerprint failed", unexpected);
        }
    }
}
