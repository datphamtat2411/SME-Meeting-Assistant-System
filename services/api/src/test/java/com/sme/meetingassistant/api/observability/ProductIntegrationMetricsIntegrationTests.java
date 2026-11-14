package com.sme.meetingassistant.api.observability;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/** Real migrated database; no business fixtures or mocked JDBC counts. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class ProductIntegrationMetricsIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired ProductIntegrationMetrics metrics;
    @Autowired MeterRegistry registry;

    @Test
    void publishesRealDurableBacklogWithNoIdentityTags() {
        UUID id=UUID.randomUUID();
        try {
            jdbc.update("""
                INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,status)
                VALUES (?,'PI06_ACCEPTANCE',?,'PI06_METRIC',CAST('{}' AS jsonb),'PENDING')
                """, id, UUID.randomUUID());
            var state=metrics.readSnapshot();
            assertThat(state).containsOnlyKeys(ProductIntegrationMetrics.EXPORTED_NAMES.stream()
                .filter(s -> !s.endsWith(".aggregation.healthy")).toArray(String[]::new));
            assertThat(state.get("product.integration.outbox.pending")).isGreaterThanOrEqualTo(1.0);
            assertThat(state.get("product.integration.outbox.oldest.age.seconds")).isGreaterThanOrEqualTo(0.0);
            for (String name : ProductIntegrationMetrics.EXPORTED_NAMES) {
                assertThat(registry.find(name).gauge()).as(name).isNotNull();
                assertThat(registry.find(name).gauge().getId().getTags()).isEmpty();
            }
        } finally {
            jdbc.update("DELETE FROM outbox_events WHERE id=?",id);
        }
    }

    @Test
    void doesNotTreatMissingOperationalRowsAsFailures() {
        var snapshot=metrics.readSnapshot();
        assertThat(snapshot).hasSize(ProductIntegrationMetrics.EXPORTED_NAMES.size()-1);
        assertThat(snapshot.values()).allSatisfy(value -> assertThat(value).isGreaterThanOrEqualTo(0));
    }
}
