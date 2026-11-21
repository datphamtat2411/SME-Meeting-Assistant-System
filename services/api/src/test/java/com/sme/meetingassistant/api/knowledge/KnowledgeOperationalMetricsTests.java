package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.mockito.Mockito.mock;

class KnowledgeOperationalMetricsTests {
    @Test
    void publishesOnlyFixedCardinalityKnowledgeMeasurements() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        KnowledgeOperationalMetrics metrics = new KnowledgeOperationalMetrics(
            new JdbcTemplate(mock(DataSource.class)), registry);

        metrics.sealAttempt();
        metrics.sealSuccess();
        metrics.sealRejected("QDRANT_PERMIT_OPEN");
        metrics.activationRejected("SEAL_REQUIRED");
        metrics.permitReservationConflict();
        metrics.permitStartConflict();
        metrics.permitCompletionConflict();
        metrics.reconciliationClaimExpired();
        metrics.reconciliationStaleResult();
        metrics.reconciliationEpochMismatch();
        metrics.remoteAuditLatency("SOURCE_COUNTS", 2_000_000_000L);
        metrics.reconciliationTransactionDuration(3_000_000_000L);

        assertThat(registry.get("product.integration.knowledge.seal.attempts").gauge().value())
            .isEqualTo(1);
        assertThat(registry.get("product.integration.knowledge.seal.successes").gauge().value())
            .isEqualTo(1);
        assertThat(registry.get("product.integration.knowledge.seal.rejections")
            .tag("reason", "QDRANT_PERMIT_OPEN").gauge().value()).isEqualTo(1);
        assertThat(registry.get("product.integration.knowledge.activation.rejections")
            .tag("reason", "SEAL_REQUIRED").gauge().value()).isEqualTo(1);
        assertThat(registry.get("product.integration.reconciliation.remote.audit.latency.seconds")
            .tag("phase", "SOURCE_COUNTS").gauge().value()).isEqualTo(2);
        assertThat(registry.get("product.integration.reconciliation.transaction.duration.seconds")
            .gauge().value()).isEqualTo(3);
        assertThat(registry.getMeters()).allSatisfy(meter -> assertThat(meter.getId().getTags())
            .allMatch(tag -> tag.getKey().equals("reason") || tag.getKey().equals("phase")));
    }
}
