package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.net.URI;
import java.net.http.*;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.micrometer.metrics.test.autoconfigure.AutoConfigureMetrics;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;

@ActiveProfiles("test")
@AutoConfigureMetrics(export=true)
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(PostgresTestConfiguration.class)
class PrivateMetricsDefaultTests {
    @Autowired WebServerApplicationContext context;
    @Test void defaultApplicationHasOnlyApprovedHealthManagementExposure() throws Exception {
        assertThat(context.getBeansOfType(PrivateMetricsController.class)).isEmpty();
        assertThat(context.getBeansOfType(io.micrometer.prometheusmetrics.PrometheusMeterRegistry.class)).isEmpty();
        try(var client=HttpClient.newHttpClient()) {
            String base="http://localhost:"+context.getWebServer().getPort();
            for(String path:List.of("/internal/monitoring/prometheus","/actuator/prometheus","/actuator/metrics","/actuator/env","/actuator/configprops"))
                assertThat(client.send(HttpRequest.newBuilder(URI.create(base+path)).GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isIn(401,403,404);
            assertThat(client.send(HttpRequest.newBuilder(URI.create(base+"/actuator/health/liveness")).GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(200);
        }
    }
}
