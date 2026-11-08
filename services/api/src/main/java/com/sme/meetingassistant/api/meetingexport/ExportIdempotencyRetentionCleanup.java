package com.sme.meetingassistant.api.meetingexport;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Bounded physical retention for abandoned export idempotency receipts.
 * Receipt expiry never authorizes deletion of an export or an object artifact.
 */
@Component
public final class ExportIdempotencyRetentionCleanup {
    private static final Logger LOG = LoggerFactory.getLogger(
            ExportIdempotencyRetentionCleanup.class);
    private final MeetingExportRepository repository;
    private final TransactionTemplate transactions;
    private final ExportOperationalMetrics metrics;
    private final int batchSize;
    private final int maxBatchesPerRun;

    public ExportIdempotencyRetentionCleanup(MeetingExportRepository repository,
            PlatformTransactionManager transactionManager, ExportOperationalMetrics metrics,
            @Value("${app.exports.idempotency-cleanup.batch-size:200}") int batchSize,
            @Value("${app.exports.idempotency-cleanup.max-batches-per-run:10}")
                int maxBatchesPerRun) {
        if (batchSize < 1 || batchSize > 500 || maxBatchesPerRun < 1
                || maxBatchesPerRun > 100) {
            throw new IllegalArgumentException("Unsafe export idempotency cleanup bounds");
        }
        this.repository = repository;
        this.transactions = new TransactionTemplate(transactionManager);
        this.metrics = metrics;
        this.batchSize = batchSize;
        this.maxBatchesPerRun = maxBatchesPerRun;
    }

    /**
     * One scheduled poll is finite. A later poll continues cleanup after a
     * transient database failure or when more receipts remain.
     */
    public void poll() {
        int removed = 0;
        try {
            for (int batch = 0; batch < maxBatchesPerRun; batch++) {
                int count = cleanupBatch();
                removed += count;
                if (count < batchSize) break;
            }
            metrics.idempotencyCleanup(removed);
            if (removed > 0) {
                LOG.info("Export idempotency receipt cleanup: removed={}", removed);
            }
        } catch (RuntimeException failure) {
            metrics.idempotencyCleanupFailure();
            LOG.warn("Export idempotency receipt cleanup failed ({})",
                    failure.getClass().getSimpleName());
        }
    }

    /** One independently atomic, bounded pass; safe across API instances. */
    public int cleanupBatch() {
        Integer result = transactions.execute(status ->
                repository.deleteExpiredIdempotencyReceipts(batchSize));
        if (result == null) {
            throw new IllegalStateException("Idempotency cleanup transaction did not execute");
        }
        return result;
    }
}
