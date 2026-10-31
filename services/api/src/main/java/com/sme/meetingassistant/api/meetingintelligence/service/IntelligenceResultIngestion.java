package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/**
 * Internal ingestion entry point for a future authenticated worker adapter.
 * Media issues the StageClaim. External clients cannot call this via HTTP.
 * No DB transaction is held while waiting for object storage or parsing bytes.
 */
@Service
public class IntelligenceResultIngestion {
    private final ProcessingJobLifecycle media;
    private final IntelligenceResultArtifactReader reader;
    private final IntelligenceResultAcceptance acceptance;
    private final ObjectMapper json;

    public IntelligenceResultIngestion(ProcessingJobLifecycle media,
            IntelligenceResultArtifactReader reader, IntelligenceResultAcceptance acceptance,
            ObjectMapper json) {
        this.media=media;
        this.reader=reader;
        this.acceptance=acceptance;
        this.json=json;
    }

    public IntelligenceResultAcceptance.Acceptance ingest(StageClaim claim, String expectedSha256) {
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
