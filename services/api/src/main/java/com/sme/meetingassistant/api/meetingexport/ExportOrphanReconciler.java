package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * DE-11: bounded S3 inventory + two-pass durable quarantine; optional
 * deletion is restricted to objects with NO COMMITTED export intent, EVER.
 *
 * IMPORTANT: This is NOT a retention policy for referenced historical exports.
 * D11 human sign-off is required before enabling ANY physical orphan purge.
 */
@Service
public final class ExportOrphanReconciler {
    private static final Logger LOG = LoggerFactory.getLogger(ExportOrphanReconciler.class);
    private static final Pattern KEY = Pattern.compile(
        "^exports/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/"
        + "(intake/[0-9a-f]{64}[.]json|snapshots/[0-9a-f]{64}[.]json"
        + "|artifacts/[0-9a-f]{64}[.](md|pdf))$");

    private final ExportOrphanRepository repository;
    private final ObjectStorage storage;
    private final Clock clock;
    private final int minAgeHours, quarantineHours, maxPages, pageSize;
    private final boolean purgeEnabled;

    public ExportOrphanReconciler(ExportOrphanRepository repository,
            ObjectStorage storage, Clock clock,
            @Value("${app.exports.reconciliation.min-age-hours:72}") int minAgeHours,
            @Value("${app.exports.reconciliation.quarantine-hours:24}") int quarantineHours,
            @Value("${app.exports.reconciliation.max-pages-per-poll:3}") int maxPages,
            @Value("${app.exports.reconciliation.page-size:100}") int pageSize,
            @Value("${app.exports.reconciliation.purge-enabled:false}") boolean purgeEnabled,
            @Value("${app.exports.reconciliation.approved-policy-reference:UNAPPROVED}")
                String approvedPolicy) {
        if (minAgeHours < 72 || minAgeHours > 8760
                || quarantineHours < 24 || quarantineHours > 720
                || maxPages < 1 || maxPages > 10 || pageSize < 1 || pageSize > 100) {
            throw new IllegalArgumentException("Unsafe export reconciliation bounds");
        }
        if (purgeEnabled && (approvedPolicy == null
                || !approvedPolicy.matches("D11-APPROVED-[A-Za-z0-9._-]{6,100}"))) {
            throw new IllegalArgumentException(
                "Orphan purging requires a reviewed D11 retention policy reference");
        }
        this.repository = repository;
        this.storage = storage;
        this.clock = clock;
        this.minAgeHours = minAgeHours;
        this.quarantineHours = quarantineHours;
        this.maxPages = maxPages;
        this.pageSize = pageSize;
        this.purgeEnabled = purgeEnabled;
    }

    public record Summary(int listed, int orphanObserved, int deleted) { }

    /**
     * Can run on multiple API nodes. Only the node bearing the DB cursor lease
     * walks the S3 namespace; inventory observations are idempotent.
     */
    public Summary runOnce() {
        int listed=0, observed=0, deleted=0;
        Optional<ExportOrphanRepository.ScanLease> scan = repository.acquireScan();
        if (scan.isPresent()) {
            var lease = scan.get();
            String next = lease.cursor();
            boolean finished = false;
            try {
                for (int page=0; page<maxPages; page++) {
                    var result = storage.list("exports/", next, pageSize);
                    for (var item : result.objects()) {
                        listed++;
                        if (observe(item)) observed++;
                    }
                    next = result.nextToken();
                    if (next == null) break;
                }
                finished = repository.finishScan(lease.token(), next);
                if (!finished) LOG.warn("Export inventory cursor lease expired during scan");
            } finally {
                if (!finished) repository.abandonScan(lease.token());
            }
        }
        if (purgeEnabled) {
            repository.recoverExpiredClaims();
            for (var candidate : repository.eligible(minAgeHours,quarantineHours,10)) {
                if (deleteSafely(candidate)) deleted++;
            }
        }
        LOG.info("Export reconciliation inventory: listed={}, orphanObserved={}, purged={}",
                listed,observed,deleted);
        return new Summary(listed,observed,deleted);
    }

    private boolean observe(ObjectStorage.ListedObject object) {
        String key=object.key();
        Matcher m = KEY.matcher(key);
        if (!m.matches() || object.lastModified() == null) return false;
        UUID exportId;
        try { exportId = UUID.fromString(m.group(1)); }
        catch (IllegalArgumentException invalid) { return false; }
        if (!exportId.toString().equals(m.group(1))) return false;
        // Never collect referenced bytes: even a FAILED retry needs its intake.
        if (repository.hasCommittedExportReference(exportId,key)) {
            repository.markReferenced(key);
            return false;
        }
        // No fast deletion of objects observed less than the minimum age.
        if (object.lastModified().isAfter(clock.instant().minus(Duration.ofHours(minAgeHours)))) {
            return false;
        }
        var head=storage.head(key);
        // S3 LIST and HEAD may race with a replacement, even if the
        // replacement has the same ETag/size. Require age evidence from HEAD.
        if (head.eTag() == null || head.eTag().isBlank()
                || head.eTag().length() > 256 || head.sizeBytes() < 0
                || head.lastModified() == null
                || !head.lastModified().equals(object.lastModified())
                || head.lastModified().isAfter(
                        clock.instant().minus(Duration.ofHours(minAgeHours)))) {
            return false;
        }
        repository.observe(key,exportId,object.lastModified(),head.eTag(),head.sizeBytes());
        return true;
    }

    private boolean deleteSafely(ExportOrphanRepository.Candidate candidate) {
        UUID token=UUID.randomUUID();
        if (!repository.claim(candidate,token,minAgeHours,quarantineHours)) return false;
        try {
            if (repository.hasCommittedExportReference(candidate.exportId(),candidate.objectKey())) {
                repository.protectReferenced(candidate.objectKey(),token);
                return false;
            }
            var head=storage.head(candidate.objectKey());
            if (!candidate.etag().equals(head.eTag())
                    || candidate.size()!=head.sizeBytes()
                    || head.lastModified()==null
                    || !candidate.lastModified().toInstant().equals(head.lastModified())
                    || head.lastModified().isAfter(
                            clock.instant().minus(Duration.ofHours(minAgeHours)))) {
                repository.releaseClaim(candidate.objectKey(),token,"EVIDENCE_CHANGED");
                return false;
            }
            if (repository.hasCommittedExportReference(candidate.exportId(),candidate.objectKey())) {
                repository.protectReferenced(candidate.objectKey(),token);
                return false;
            }
            // Conditional delete is atomic with provider's ETag check, never
            // an unguarded DeleteObject. Unsupported implementations fail closed.
            if (!storage.deleteIfEtagMatches(candidate.objectKey(),candidate.etag())) {
                repository.releaseClaim(candidate.objectKey(),token,"ETAG_CHANGED");
                return false;
            }
            repository.finishPurged(candidate.objectKey(),token);
            return true;
        } catch (RuntimeException exception) {
            repository.releaseClaim(candidate.objectKey(),token,"STORAGE_UNAVAILABLE");
            LOG.warn("Export orphan cleanup attempt failed ({})",
                    exception.getClass().getSimpleName());
            return false;
        }
    }
}
