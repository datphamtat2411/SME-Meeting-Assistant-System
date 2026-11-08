package com.sme.meetingassistant.api.meetingexport;

import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.micrometer.core.instrument.MeterRegistry;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;

class ExportIdempotencyRetentionCleanupTests {
    @Test
    void cleanupFailureIsObservableAndTheNextPollCanRecover() {
        MeetingExportRepository repository = mock(MeetingExportRepository.class);
        ExportOperationalMetrics metrics = mock(ExportOperationalMetrics.class);
        PlatformTransactionManager transactions = transactionManager();
        ExportIdempotencyRetentionCleanup cleanup = new ExportIdempotencyRetentionCleanup(
                repository, transactions, metrics, 200, 10);

        doThrow(new IllegalStateException("database unavailable"))
                .doReturn(1)
                .when(repository).deleteExpiredIdempotencyReceipts(200);

        cleanup.poll();
        verify(metrics).idempotencyCleanupFailure();

        cleanup.poll();
        verify(metrics).idempotencyCleanup(1);
    }

    private static PlatformTransactionManager transactionManager() {
        TransactionStatus status = mock(TransactionStatus.class);
        AtomicBoolean rolledBack = new AtomicBoolean();
        return new PlatformTransactionManager() {
            @Override
            public TransactionStatus getTransaction(TransactionDefinition definition) {
                return status;
            }

            @Override
            public void commit(TransactionStatus ignored) {
                if (rolledBack.get()) throw new AssertionError("Committed a rolled-back transaction");
            }

            @Override
            public void rollback(TransactionStatus ignored) {
                rolledBack.set(true);
                rolledBack.set(false);
            }
        };
    }
}
