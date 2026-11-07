package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.meetingexport.render.MarkdownMinutesRenderer;
import com.sme.meetingassistant.api.meetingexport.render.PdfMinutesRenderer;
import jakarta.annotation.PreDestroy;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * DE-09 bounded, durable, fenced export execution.
 * No request principal is forged inside a worker. Workers use only previously
 * authorized, checksum-verified frozen source envelopes.
 */
@Service
public final class ExportJobProcessor {
    private static final Logger LOG = LoggerFactory.getLogger(ExportJobProcessor.class);
    private final ExportGenerationStateMachine state;
    private final ExportIntakeRepository intakes;
    private final ExportArtifactStore storage;
    private final ExportSnapshotCodec codec;
    private final MarkdownMinutesRenderer markdown;
    private final PdfMinutesRenderer pdf;
    private final JdbcTemplate jdbc;
    private final int leaseSeconds, maxAttempts, retryBaseSeconds;
    private final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(
        job -> {
            Thread t = new Thread(job, "export-claim-heartbeat");
            t.setDaemon(true);
            return t;
        });

    public ExportJobProcessor(ExportGenerationStateMachine state,
            ExportIntakeRepository intakes, ExportArtifactStore storage,
            ExportSnapshotCodec codec, MarkdownMinutesRenderer markdown,
            PdfMinutesRenderer pdf, JdbcTemplate jdbc,
            @Value("${app.exports.worker.lease-seconds:120}") int leaseSeconds,
            @Value("${app.exports.worker.max-attempts:3}") int maxAttempts,
            @Value("${app.exports.worker.retry-base-seconds:15}") int retryBaseSeconds) {
        if (leaseSeconds < 30 || leaseSeconds > 900 || maxAttempts < 1
                || maxAttempts > 6 || retryBaseSeconds < 1 || retryBaseSeconds > 300) {
            throw new IllegalArgumentException("Invalid bounded export worker configuration");
        }
        this.state = state;
        this.intakes = intakes;
        this.storage = storage;
        this.codec = codec;
        this.markdown = markdown;
        this.pdf = pdf;
        this.jdbc = jdbc;
        this.leaseSeconds = leaseSeconds;
        this.maxAttempts = maxAttempts;
        this.retryBaseSeconds = retryBaseSeconds;
    }

    /** True means one job was attempted, not that the artifact became READY. */
    public boolean processNext() {
        var optional = state.claimNextStaged(leaseSeconds);
        if (optional.isEmpty()) return false;
        ExportRecord claim = optional.get();
        AtomicBoolean stillOwner = new AtomicBoolean(true);
        int heartbeatInterval = Math.max(1, leaseSeconds / 3);
        ScheduledFuture<?> renew = heartbeat.scheduleAtFixedRate(() -> {
            if (!stillOwner.get()) return;
            try {
                if (!state.renew(claim.id(), claim.claimToken(), leaseSeconds)) {
                    stillOwner.set(false);
                    LOG.warn("Export claim no longer renewable for {}", claim.id());
                }
            } catch (RuntimeException e) {
                stillOwner.set(false);
                LOG.warn("Export heartbeat failed for {} ({})",
                        claim.id(), e.getClass().getSimpleName());
            }
        }, heartbeatInterval, heartbeatInterval, TimeUnit.SECONDS);
        try {
            processClaim(claim, stillOwner);
        } catch (ExportArtifactStore.IntegrityFailure e) {
            failClaim(claim, stillOwner, "EXPORT_STORAGE_INTEGRITY");
        } catch (ExportArtifactStore.StorageFailure e) {
            failClaim(claim, stillOwner, "EXPORT_STORAGE_UNAVAILABLE");
        } catch (IllegalArgumentException e) {
            failClaim(claim, stillOwner, "EXPORT_SOURCE_INVALID");
        } catch (RuntimeException e) {
            LOG.warn("Export processing failed for {} ({})",
                    claim.id(), e.getClass().getSimpleName());
            failClaim(claim, stillOwner, "EXPORT_RENDER_FAILED");
        } finally {
            stillOwner.set(false);
            renew.cancel(true);
        }
        return true;
    }

    private void processClaim(ExportRecord claim, AtomicBoolean stillOwner) {
        var intake = intakes.find(claim.id())
                .orElseThrow(() -> new IllegalArgumentException("Missing export intake"));
        byte[] frozen = storage.readVerified(intake.objectKey(), intake.intakeSha256(),
                ExportSnapshotCodec.MAX_INTAKE_BYTES);
        var envelope = codec.decode(frozen, intake, claim);
        var snapshot = envelope.snapshot();
        if (!stillOwner.get()) return;

        byte[] snapshotBytes = codec.snapshotBytes(snapshot);
        String snapshotSha = ExportSnapshotCodec.sha256(snapshotBytes);
        String snapshotKey = ExportDigests.snapshotKey(claim.id(), snapshot.sourceFingerprint());
        storage.putVerified(snapshotKey, snapshotBytes, "application/json", snapshotSha);
        if (!stillOwner.get()) return;

        String version = claim.format() == ExportFormat.PDF
                ? PdfMinutesRenderer.VERSION : MarkdownMinutesRenderer.VERSION;
        if (!state.pinSnapshot(claim.id(), claim.claimToken(),
                snapshot.sourceFingerprint(), version)) {
            return;
        }
        if (!stillOwner.get()) return;

        byte[] artifact;
        String artifactSha;
        String contentType;
        if (claim.format() == ExportFormat.PDF) {
            var result = pdf.render(snapshot);
            artifact = result.bytes();
            artifactSha = result.sha256();
            contentType = result.mediaType();
        } else {
            var result = markdown.render(snapshot);
            artifact = result.utf8();
            artifactSha = result.sha256();
            contentType = result.mediaType();
        }
        if (!stillOwner.get()) return;

        storage.putVerified(ExportDigests.artifactKey(claim.id(), claim.format(),
                artifactSha), artifact, contentType, artifactSha);
        if (!stillOwner.get()) return;

        if (!state.publishReady(claim.id(), claim.claimToken(),
                artifactSha, artifact.length)) {
            LOG.warn("Export result fenced before READY publication for {}", claim.id());
        }
    }

    private void failClaim(ExportRecord claim, AtomicBoolean stillOwner, String code) {
        if (stillOwner.get() && !state.fail(claim.id(), claim.claimToken(), code)) {
            LOG.warn("Failure receipt fenced for export {}", claim.id());
        }
    }

    /**
     * Expired attempts first become FAILED. Only transient failures may retry
     * with bounded DB-clock exponential backoff. Failed->PENDING clears the
     * generation pin but preserves the immutable admission source.
     */
    public void reconcile() {
        state.failExpired(25);
        List<UUID> due = jdbc.query("""
            SELECT e.id FROM meeting_exports e
              JOIN meeting_export_intakes i ON i.export_id=e.id
             WHERE e.status='FAILED' AND e.generation_attempt < ?
               AND e.last_error_code IN
                   ('EXPORT_STORAGE_UNAVAILABLE','EXPORT_LEASE_EXPIRED')
               AND e.updated_at <= clock_timestamp() -
                   ((? * (1 << LEAST(e.generation_attempt-1, 10))) * INTERVAL '1 second')
             ORDER BY e.updated_at,e.id LIMIT 25
            """, (rs, ignored) -> rs.getObject(1, UUID.class),
                maxAttempts, retryBaseSeconds);
        for (UUID id : due) state.requeueFailed(id);
    }

    @PreDestroy
    public void close() {
        heartbeat.shutdownNow();
    }
}
