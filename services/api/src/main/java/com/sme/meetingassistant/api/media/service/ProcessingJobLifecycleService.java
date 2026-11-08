package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.integration.OfflineIntelligenceSnapshotPreparation;
import com.sme.meetingassistant.api.common.SafeAiDiagnostics;
import com.sme.meetingassistant.api.common.SafeProcessingFailureSummary;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.intelligence.IntelligenceWorkerCapability;
import com.sme.meetingassistant.api.media.intelligence.IntelligenceOperationLog;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.beans.factory.annotation.Autowired;
import java.util.UUID;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

@Service
public class ProcessingJobLifecycleService implements ProcessingJobLifecycle {
    private final MediaRepository repository;
    private final ObjectMapper mapper;
    private final MediaProperties properties;
    private final ProcessingTranscriptEvidence transcriptEvidence;
    private final ProcessingDerivedSnapshotEvidence derivedEvidence;
    private final OfflineIntelligenceSnapshotPreparation offlinePreparation;
    private final IntelligenceWorkerCapability intelligence;
    private final PlatformTransactionManager transactions;

    /** Preserves isolated legacy lifecycle unit tests without derived feature setup. */
    public ProcessingJobLifecycleService(MediaRepository repository, ObjectMapper mapper,
            MediaProperties properties, ProcessingTranscriptEvidence transcriptEvidence) {
        this(repository, mapper, properties, transcriptEvidence, null, null,null,null);
    }

    @Autowired
    public ProcessingJobLifecycleService(MediaRepository repository, ObjectMapper mapper,
            MediaProperties properties, ProcessingTranscriptEvidence transcriptEvidence,
            ProcessingDerivedSnapshotEvidence derivedEvidence,
            OfflineIntelligenceSnapshotPreparation offlinePreparation,
            IntelligenceWorkerCapability intelligence,PlatformTransactionManager transactions) {
        this.repository = repository;
        this.mapper = mapper;
        this.properties = properties;
        this.transcriptEvidence = transcriptEvidence;
        this.derivedEvidence = derivedEvidence;
        this.offlinePreparation = offlinePreparation;
        this.intelligence=intelligence;
        this.transactions=transactions;
    }

    @Override
    @Transactional(readOnly = true)
    public DerivedStage derivedStage(UUID stageRunId) {
        if (stageRunId == null) throw new IllegalArgumentException("Stage attempt is required.");
        return repository.derivedStage(stageRunId);
    }

    @Override
    @Transactional(readOnly=true)
    public boolean hasAcceptedStageClaim(StageClaim claim) {
        if(claim==null || claim.stageRunId()==null || claim.claimToken()==null)
            return false;
        return repository.hasAcceptedStageClaim(claim);
    }

    private int leaseSeconds() {
        int value = this.properties.getProcessing().getStageLeaseSeconds();
        if (value < 30) throw new IllegalStateException("Stage lease must be at least 30 seconds.");
        return value;
    }

    @Scheduled(fixedDelayString = "${app.media.processing.stage-lease-sweep-ms:60000}")
    public void expireAbandonedStages() {
        this.repository.expireAbandonedStages(25);
        repository.reconcileIntelligencePublicationFailures(25,properties.getIntelligence().getDispatchClaimTimeoutSeconds());
        // Expiry commits before taking any Meeting lock. Each repaired job has
        // its own short transaction, so abandoned attempts cannot invert lock order.
        var configuration=properties.getIntelligence();
        var enabled=configuration.isEnabled() && configuration.isDispatchEnabled()?configuration.getEnabledStages():List.<String>of();
        if(transactions!=null) for(UUID job:repository.intelligenceRecoveryCandidates(25,enabled)) {
            try {new TransactionTemplate(transactions).executeWithoutResult(tx->advanceJob(job));}
            catch(RuntimeException unavailable) {
                IntelligenceOperationLog.record("RECONCILIATION_REQUIRED",job,null,null);
            }
        }
    }

    @Override
    @Transactional
    public StageClaim startStage(UUID jobId, String stageCode, String providerName, String modelName) {
        requireCode(stageCode, 48, "stageCode");
        requireOptionalText(providerName, 80, "providerName");
        requireOptionalText(modelName, 160, "modelName");
        if ("EXTRACTING_ACTION_ITEMS".equals(stageCode)
                && !properties.getProcessing().isActionItemHandoffEnabled()) {
            throw new org.springframework.web.server.ResponseStatusException(
                org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                "Action Item proposal handoff is disabled.");
        }
        if(isIntelligenceStage(stageCode)) {
            var planned=repository.latestIntelligenceStages(jobId).stream().filter(s->stageCode.equals(s.stageCode())).findFirst();
            if(planned.isEmpty() || !intelligenceStageEligible(jobId,planned.get().stageRunId(),stageCode))
                throw new ProcessingLifecycleConflictException("Only the next admitted intelligence attempt may start.");
        }
        if ("DIARIZING".equals(stageCode)) requireCurrentDiarizationSource(jobId);
        boolean derived = this.repository.isDerivedSummaryJob(jobId);
        if (derived) {
            if (!"GENERATING_SUMMARY".equals(stageCode)
                    || derivedEvidence == null || !derivedEvidence.hasPinnedSummarySource(jobId)) {
                throw new ProcessingLifecycleConflictException(
                    "Derived processing requires its verified pinned Summary source.");
            }
        } else {
            if (List.of("GENERATING_SUMMARY", "EXTRACTING_DECISIONS", "EXTRACTING_ACTION_ITEMS", "INDEXING")
                    .contains(stageCode)) repository.requireTerminalDiarization(jobId);
            if (List.of("GENERATING_SUMMARY", "EXTRACTING_DECISIONS",
                    "EXTRACTING_ACTION_ITEMS", "INDEXING").contains(stageCode)
                    && !this.transcriptEvidence.hasFinalizedTranscript(jobId)) {
                throw new ProcessingLifecycleConflictException(
                    "Downstream processing requires a persisted finalized transcript.");
            }
            if (List.of("GENERATING_SUMMARY", "EXTRACTING_DECISIONS",
                    "EXTRACTING_ACTION_ITEMS").contains(stageCode)) {
                if (offlinePreparation == null) {
                    throw new ProcessingLifecycleConflictException(
                        "Offline source snapshot preparation is not installed.");
                }
                // The API-side preparation bean suspends this transaction
                // across S3 I/O. Its source/DB admission is independently
                // committed before the worker receives a stage claim.
                offlinePreparation.prepare(jobId);
            }
        }
        return this.repository.startStage(jobId, stageCode, providerName, modelName, leaseSeconds());
    }

    @Override @Transactional
    public StageClaim startIntelligenceWorkerStage(UUID jobId,UUID stageRunId,String stageCode) {
        if(!intelligenceStageEligible(jobId,stageRunId,stageCode))
            throw new ProcessingLifecycleConflictException("Intelligence stage attempt is not eligible.");
        intelligence.requireStage(stageCode);
        if(derivedEvidence==null || !derivedEvidence.hasPinnedSummarySource(jobId))
            throw new ProcessingLifecycleConflictException("Intelligence execution requires its admitted verified snapshot.");
        // The worker source port has verified the immutable object before this
        // transaction and rechecked the binding under the Meeting lock.
        return repository.startStage(jobId,stageCode,null,null,leaseSeconds());
    }

    @Override @Transactional(readOnly=true)
    public boolean intelligenceStageEligible(UUID jobId,UUID stageRunId,String stageCode) {
        if(!isIntelligenceStage(stageCode) || !repository.intelligenceUpstreamReady(jobId)) return false;
        if(!repository.isDerivedSummaryJob(jobId) && !transcriptEvidence.hasFinalizedTranscript(jobId)) return false;
        for(var s:repository.latestIntelligenceStages(jobId)) {
            if(List.of("SUCCEEDED","SUCCEEDED_WITH_WARNING").contains(s.status())) {
                if(!hasAcceptedResult(jobId,s.stageRunId(),s.stageCode())) return false;
            } else return "PENDING".equals(s.status()) && s.stageRunId().equals(stageRunId) && s.stageCode().equals(stageCode);
        }
        return false;
    }

    @Override @Transactional
    public void advanceJob(UUID jobId) {
        transcriptEvidence.lockDiarizationSource(jobId);
        var job=repository.lockJobForOfflineSource(jobId).orElseThrow();
        if(!repository.intelligenceUpstreamReady(jobId)) return;
        if(!repository.isDerivedSummaryJob(jobId) && !transcriptEvidence.hasFinalizedTranscript(jobId)) return;
        for(var s:repository.latestIntelligenceStages(jobId)) {
            if(List.of("SUCCEEDED","SUCCEEDED_WITH_WARNING").contains(s.status())) {
                if(!hasAcceptedResult(jobId,s.stageRunId(),s.stageCode()))
                    throw new ProcessingLifecycleConflictException("Intelligence progression requires canonical acceptance evidence.");
            } else {
                if("PENDING".equals(s.status()) && intelligence!=null && intelligence.canDispatch(s.stageCode()))
                    repository.dispatchIntelligenceStage(jobId,s.stageRunId(),s.stageCode(),UUID.randomUUID());
                else if("PENDING".equals(s.status())) IntelligenceOperationLog.record("DISPATCH_BLOCKED",jobId,s.stageRunId(),null);
                return;
            }
        }
        if("RUNNING".equals(job.status()) && !repository.hasUnfinishedRequiredStages(jobId)) completeJob(jobId);
    }

    @Override
    @Transactional
    public StageClaim startTranscriptionWorkerStage(UUID jobId, String stageCode) {
        if (!List.of("TRANSCRIPTION", "CONTEXTUAL_CORRECTION", "FINALIZING_TRANSCRIPT").contains(stageCode)) {
            throw new IllegalArgumentException("Unsupported transcription capability stage.");
        }
        StageClaim claim = startStage(jobId, stageCode, null, null);
        repository.renewStageLease(claim, 120);
        return claim;
    }

    @Override
    @Transactional
    public void renewTranscriptionWorkerLease(StageClaim claim) {
        requireClaim(claim);
        repository.renewStageLease(claim, 120);
    }

    @Override
    @Transactional
    public void renewStageLease(StageClaim claim) {
        requireClaim(claim);
        this.repository.renewStageLease(claim, leaseSeconds());
    }

    @Override
    @Transactional
    public void completeStage(StageClaim claim, String outcome, String errorCode, String metricsJson) {
        requireClaim(claim);
        if (!"SUCCEEDED".equals(outcome) && !"SUCCEEDED_WITH_WARNING".equals(outcome)) {
            throw new IllegalArgumentException("Stage outcome must be successful.");
        }
        requireOptionalText(errorCode, 96, "errorCode");
        if (metricsJson != null) {
            try {
                if (!this.mapper.readTree(metricsJson).isObject()) {
                    throw new IllegalArgumentException("Stage metrics must be a JSON object.");
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> metadata = (Map<String, Object>) this.mapper.readValue(metricsJson, Map.class);
                SafeAiDiagnostics.stageMetrics(metadata);
            } catch (JacksonException invalidJson) {
                throw new IllegalArgumentException("Stage metrics must be valid JSON.", invalidJson);
            }
        }
        var identity = this.repository.stageIdentity(claim.stageRunId());
        if(isIntelligenceStage(identity.stageCode())) transcriptEvidence.lockDiarizationSource(identity.jobId());
        if ("EXTRACTING_ACTION_ITEMS".equals(identity.stageCode())
                && !properties.getProcessing().isActionItemHandoffEnabled()) {
            throw new org.springframework.web.server.ResponseStatusException(
                org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                "Action Item proposal handoff is disabled.");
        }
        if ("FINALIZING_TRANSCRIPT".equals(identity.stageCode())
                && this.transcriptEvidence.forFinalization(identity.jobId(), claim.stageRunId()).isEmpty()) {
            throw new ProcessingLifecycleConflictException("Canonical transcript must exist before stage success.");
        }
        if ("DIARIZING".equals(identity.stageCode())) {
            transcriptEvidence.lockDiarizationSource(identity.jobId());
            repository.requireAcceptedDiarizationSource(identity.jobId(), claim.stageRunId(),
                transcriptEvidence.diarizationSource(identity.jobId()).orElse(null));
        }
        if (isIntelligenceStage(identity.stageCode())
                && !hasAcceptedResult(identity.jobId(),claim.stageRunId(),identity.stageCode())) {
            throw new ProcessingLifecycleConflictException(
                "AI-dependent stage cannot succeed without matching canonical acceptance evidence.");
        }
        this.repository.completeStage(claim, outcome, errorCode, metricsJson);
        if(isIntelligenceStage(identity.stageCode())) {
            IntelligenceOperationLog.record("ACCEPTED",identity.jobId(),claim.stageRunId(),repository.intelligenceEvent(claim.stageRunId()).orElse(null));
            advanceJob(identity.jobId());
        } else if("DIARIZING".equals(identity.stageCode())) advanceJob(identity.jobId());
    }

    private void requireCurrentDiarizationSource(UUID jobId) {
        transcriptEvidence.lockDiarizationSource(jobId);
        repository.requireDiarizationSource(jobId, transcriptEvidence.diarizationSource(jobId).orElse(null));
    }

    @Override
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.MANDATORY)
    public void dispatchPlannedDiarization(UUID jobId) {
        if (!repository.isDiarizationPlanned(jobId)) return;
        transcriptEvidence.lockDiarizationSource(jobId);
        repository.dispatchPlannedDiarization(jobId, transcriptEvidence.diarizationSource(jobId).orElse(null));
    }

    @Override
    @Transactional
    public void failStage(StageClaim claim, String errorCode, String untrustedWorkerSummary, boolean retryable) {
        requireClaim(claim);
        requireCode(errorCode, 96, "errorCode");
        var identity = repository.stageIdentity(claim.stageRunId());
        if("DIARIZING".equals(identity.stageCode())) transcriptEvidence.lockDiarizationSource(identity.jobId());
        // The worker/provider summary is untrusted and may contain raw ASR text,
        // provider payloads or credentials. Never persist it as business state.
        this.repository.failStage(claim, errorCode,
            SafeProcessingFailureSummary.forCode(errorCode), retryable);
        if ("DIARIZING".equals(identity.stageCode())) advanceJob(identity.jobId());
    }

    @Override
    @Transactional(readOnly = true)
    public boolean hasPendingPipelineStages(UUID jobId) {
        return this.repository.hasPendingPipelineStages(jobId);
    }

    private static boolean isIntelligenceStage(String stageCode) {
        return List.of("GENERATING_SUMMARY","EXTRACTING_DECISIONS",
            "EXTRACTING_ACTION_ITEMS").contains(stageCode);
    }

    private boolean hasAcceptedResult(UUID jobId,UUID stageRunId,String stageCode) {
        return derivedEvidence!=null
            && derivedEvidence.hasAcceptedResultForStage(jobId,stageRunId,stageCode);
    }

    private void verifyLatestIntelligenceResults(UUID jobId) {
        for (var stage : repository.latestIntelligenceStages(jobId)) {
            if (!List.of("SUCCEEDED","SUCCEEDED_WITH_WARNING").contains(stage.status())
                    || !hasAcceptedResult(jobId,stage.stageRunId(),stage.stageCode())) {
                throw new ProcessingLifecycleConflictException(
                    "Processing job requires successful intelligence stages with canonical acceptance.");
            }
        }
    }

    @Override
    @Transactional
    public void completeJob(UUID jobId) {
        verifyLatestIntelligenceResults(jobId);
        if (this.repository.isDerivedSummaryJob(jobId)) {
            if (derivedEvidence == null || !derivedEvidence.hasAcceptedSummary(jobId)) {
                throw new ProcessingLifecycleConflictException(
                    "Derived Summary job has no accepted successful result.");
            }
            this.repository.completeDerivedSummaryJob(jobId);
        } else {
            this.repository.completeJob(jobId,
                this.transcriptEvidence.latestSuccessfulFinalization(jobId).orElse(null));
        }
        var stages=repository.latestIntelligenceStages(jobId);
        if(!stages.isEmpty()) {
            var last=stages.getLast();
            IntelligenceOperationLog.record("COMPLETED",jobId,last.stageRunId(),repository.intelligenceEvent(last.stageRunId()).orElse(null));
        }
    }

    @Override
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.MANDATORY)
    public void requireActionItemExtractionClaim(UUID jobId, UUID meetingId, UUID mediaId,
            StageClaim claim) {
        requireClaim(claim);
        repository.requireActionItemExtractionClaim(jobId, meetingId, mediaId, claim);
    }

    @Override
    @Transactional
    public boolean requireFinalizationClaim(UUID jobId, UUID meetingId, UUID mediaId, StageClaim claim) {
        return this.repository.requireFinalizationClaim(jobId, meetingId, mediaId, claim);
    }

    @Override
    @Transactional
    public void recordArtifact(UUID jobId, StageClaim claim, String artifactType, String objectKey,
            String sha256, Long sizeBytes, String retentionClass) {
        recordBinaryArtifact(jobId, claim, false, artifactType, objectKey, sha256,
            sizeBytes, retentionClass);
    }

    @Override
    @Transactional
    public void recordJobArtifact(UUID jobId, StageClaim producerClaim, String artifactType,
            String objectKey, String sha256, Long sizeBytes, String retentionClass) {
        recordBinaryArtifact(jobId, producerClaim, true, artifactType, objectKey, sha256,
            sizeBytes, retentionClass);
    }

    private void recordBinaryArtifact(UUID jobId, StageClaim claim, boolean jobScoped,
            String artifactType, String objectKey, String sha256, Long sizeBytes,
            String retentionClass) {
        requireClaim(claim);
        if (jobId == null) throw new IllegalArgumentException("jobId is required.");
        if (!"NORMALIZED_AUDIO".equals(artifactType) && !"AUDIO_CHUNK".equals(artifactType)) {
            // Raw ASR/Whisper text and unvalidated debug JSON are never durable artifacts.
            throw new IllegalArgumentException("Only approved non-text audio artifacts are allowed.");
        }
        if (sha256 == null || !sha256.matches("[0-9a-fA-F]{64}")) {
            throw new IllegalArgumentException("Artifact sha256 is required.");
        }
        if (sizeBytes == null || sizeBytes <= 0) {
            throw new IllegalArgumentException("Artifact sizeBytes must be positive.");
        }
        if (retentionClass != null && !"TEMPORARY".equals(retentionClass)
                && !"STANDARD".equals(retentionClass)) {
            throw new IllegalArgumentException("Invalid artifact retentionClass.");
        }
        String prefix = "processing/" + jobId + "/artifacts/";
        if (objectKey == null || !objectKey.startsWith(prefix)) {
            throw new IllegalArgumentException("Artifact must belong to its processing job namespace.");
        }
        String basename = objectKey.substring(prefix.length());
        if (!basename.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(wav|flac|pcm)")) {
            throw new IllegalArgumentException("Artifact object key must use a generated binary-audio identifier.");
        }
        this.repository.recordArtifact(jobId, claim, jobScoped, artifactType, objectKey,
            sha256.toLowerCase(java.util.Locale.ROOT), sizeBytes, retentionClass);
    }

    private static void requireClaim(StageClaim claim) {
        if (claim == null || claim.stageRunId() == null || claim.claimToken() == null) {
            throw new IllegalArgumentException("Stage claim is required.");
        }
    }

    private static void requireCode(String value, int max, String field) {
        if (value == null || !value.matches("[A-Z][A-Z0-9_]{0," + (max - 1) + "}")) {
            throw new IllegalArgumentException(field + " has an invalid code format.");
        }
    }

    private static void requireOptionalText(String value, int max, String field) {
        if (value != null && (value.length() > max || hasControls(value))) {
            throw new IllegalArgumentException(field + " is invalid.");
        }
    }

    private static boolean hasControls(String value) {
        return value.chars().anyMatch(Character::isISOControl);
    }
}
