package com.sme.meetingassistant.api.observability;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.UUID;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/** Hardening: route names and result tags have strictly bounded cardinality. */
class DashboardExportHttpMetricsFilterTests {
    @Test
    void recordsOnlyConstantOperationNamesNeverSensitiveIdentifiers() throws Exception {
        var meters = new SimpleMeterRegistry();
        var filter = new DashboardExportHttpMetricsFilter(meters);
        UUID meeting=UUID.randomUUID();
        UUID export=UUID.randomUUID();
        measure(filter, "GET", "/api/v1/dashboard/me", 200);
        measure(filter, "GET", "/api/v1/dashboard/management", 403);
        measure(filter, "GET", "/api/v1/meetings/"+meeting+"/minutes", 200);
        measure(filter, "POST", "/api/v1/meetings/"+meeting+"/exports", 202);
        measure(filter, "GET", "/api/v1/exports/"+export, 404);
        measure(filter, "POST", "/api/v1/exports/"+export+"/access-url", 503);
        assertThat(meters.find("sme.dashboard_export.http.duration")
                .tags("operation","EXPORT_ACCESS","result","SERVER_ERROR").timer())
                .isNotNull();
        assertThat(meters.find("sme.dashboard_export.http.duration")
                .tags("operation","DASHBOARD_PERSONAL","result","SUCCESS").timer()
                .count()).isEqualTo(1);
        assertThat(meters.getMeters()).hasSize(6);
        String tags = meters.getMeters().stream().map(m -> m.getId().getTags().toString())
                .reduce("", String::concat);
        assertThat(tags).doesNotContain(meeting.toString(), export.toString(),
                "access-url", "Idempotency-Key", "X-Amz-Signature");
        meters.close();
    }

    @Test
    void ignoresUnknownRoutesAndMethodsWithoutAllocatingMetrics() throws Exception {
        var meters = new SimpleMeterRegistry();
        var filter = new DashboardExportHttpMetricsFilter(meters);
        measure(filter, "GET", "/api/v1/exports/malformed-uuid", 200);
        measure(filter, "POST", "/api/v1/dashboard/me", 200);
        measure(filter, "GET", "/api/v1/exports/"+UUID.randomUUID()+"/access-url", 200);
        assertThat(meters.getMeters()).isEmpty();
        meters.close();
    }

    private void measure(DashboardExportHttpMetricsFilter filter,
            String method, String uri, int status) throws Exception {
        MockHttpServletRequest request=new MockHttpServletRequest(method,uri);
        MockHttpServletResponse response=new MockHttpServletResponse();
        filter.doFilter(request,response,(req,res)->((HttpServletResponse)res).setStatus(status));
    }
}
