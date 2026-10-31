package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/**
 * Internal ingestion entry point for a future authenticated worker adapter.
 * Media issues the StageClaim. External clients cannot call this via HTTP.
 * No DB transaction is held while waiting for object storage or parsing bytes.
 */
@Service
public class IntelligenceResultIngestion {
    private static final Logger LOGGER = LoggerFactory.getLogger(IntelligenceResultIngestion.class);
    private final ProcessingJobLifecycle media;
    private final IntelligenceResultArtifactReader reader;
    private final IntelligenceResultAcceptance acceptance;
    private final ObjectMapper json;
    private final MeetingIntelligenceMetrics metrics;

    public IntelligenceResultIngestion(ProcessingJobLifecycle media,
            IntelligenceResultArtifactReader reader, IntelligenceResultAcceptance acceptance,
            ObjectMapper json, MeetingIntelligenceMetrics metrics) {
        this.media=media;
        this.reader=reader;
        this.acceptance=acceptance;
        this.json=json;
        this.metrics=metrics;
    }

    public IntelligenceResultAcceptance.Acceptance ingest(StageClaim claim, String expectedSha256) {
        try {
            return ingestInternal(claim, expectedSha256);
        } catch (RuntimeException failure) {
            metrics.failure("ai_result_ingestion", failure);
            LOGGER.atWarn()
                .addKeyValue("stageRunId", claim == null ? null : claim.stageRunId())
                .addKeyValue("failureType", failure.getClass().getSimpleName())
                .log("Meeting Intelligence result rejected");
            throw failure;
        }
    }

    private IntelligenceResultAcceptance.Acceptance ingestInternal(StageClaim claim, String expectedSha256) {
        if (claim==null || claim.stageRunId()==null || claim.claimToken()==null) {
            throw new IllegalArgumentException("A Media-issued stage claim is required.");
        }
        var stage=media.derivedStage(claim.stageRunId());
        if (!"GENERATING_SUMMARY".equals(stage.stageCode())
                && !"EXTRACTING_DECISIONS".equals(stage.stageCode())) {
            throw new IllegalArgumentException("Only approved Meeting Intelligence stages are accepted.");
        }
        var artifact=reader.read(stage.jobId(),claim.stageRunId(),expectedSha256);
        var parsed=IntelligenceResultPayload.parse(artifact.bytes(),json);
        return acceptance.accept(claim,stage,artifact,parsed);
    }
}
