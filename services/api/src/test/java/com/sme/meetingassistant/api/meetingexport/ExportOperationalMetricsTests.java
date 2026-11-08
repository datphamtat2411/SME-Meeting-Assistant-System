package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class ExportOperationalMetricsTests {
    @Test
    void operationCountersHaveFiniteLabelsAndNoSensitiveIds() {
        var registry = new SimpleMeterRegistry();
        var metrics = new ExportOperationalMetrics(registry, mock(JdbcTemplate.class));
        metrics.execution(ExportFormat.PDF,"READY",2_000_000L);
        metrics.execution(ExportFormat.MARKDOWN,"untrusted exception text secret URL",4_000_000L);
        metrics.retried();
        metrics.expiredClaims(2);
        metrics.reconciliation(12,4,0);
        metrics.reconciliationFailure();
        metrics.idempotencyCleanup(3);
        metrics.idempotencyCleanupFailure();

        var ok = registry.find("sme.exports.generation.duration")
                .tags("format","PDF","outcome","READY").timer();
        assertThat(ok).isNotNull();
        assertThat(ok.count()).isEqualTo(1);
        assertThat(registry.find("sme.exports.generation.duration")
                .tags("format","MARKDOWN","outcome","RENDER_FAILED").timer())
                .isNotNull();
        assertThat(registry.find("sme.exports.retries").counter().count()).isEqualTo(1);
        assertThat(registry.find("sme.exports.expired.claims").counter().count())
                .isEqualTo(2);
        assertThat(registry.find("sme.exports.idempotency.receipts.cleaned").counter().count())
                .isEqualTo(3);
        assertThat(registry.find("sme.exports.idempotency.cleanup.failures").counter().count())
                .isEqualTo(1);
        assertThat(registry.find("sme.exports.jobs").tags("state","PENDING").gauge())
                .isNotNull();
        String ids = registry.getMeters().stream()
                .map(m -> m.getId().getTags().toString()).reduce("",String::concat);
        assertThat(ids).doesNotContain("untrusted", "secret", "URL", "token");
        registry.close();
    }
}
