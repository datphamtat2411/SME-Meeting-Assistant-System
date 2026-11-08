package com.sme.meetingassistant.api.observability;

import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * DE-12: bounded operation-level latency/error telemetry, separate from the
 * generic HTTP server metrics. NEVER use userId, meetingId, exportId, URL,
 * object key, request body, or exception detail in metric names/labels.
 */
@Component
@Order(Ordered.LOWEST_PRECEDENCE - 10)
public final class DashboardExportHttpMetricsFilter extends OncePerRequestFilter {
    private static final Pattern MEETING_MINUTES = Pattern.compile(
            "^/api/v1/meetings/[0-9a-fA-F-]{36}/minutes$");
    private static final Pattern MEETING_EXPORTS = Pattern.compile(
            "^/api/v1/meetings/[0-9a-fA-F-]{36}/exports$");
    private static final Pattern EXPORT_STATUS = Pattern.compile(
            "^/api/v1/exports/[0-9a-fA-F-]{36}$");
    private static final Pattern EXPORT_ACCESS = Pattern.compile(
            "^/api/v1/exports/[0-9a-fA-F-]{36}/access-url$");

    private final MeterRegistry registry;

    public DashboardExportHttpMetricsFilter(MeterRegistry registry) {
        this.registry = registry;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return operation(request.getMethod(), request.getRequestURI()) == null;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String operation = operation(request.getMethod(), request.getRequestURI());
        if (operation == null) {
            chain.doFilter(request, response);
            return;
        }
        long started = System.nanoTime();
        boolean failed = false;
        try {
            chain.doFilter(request, response);
        } catch (ServletException | IOException | RuntimeException | Error ex) {
            failed = true;
            throw ex;
        } finally {
            int status = failed ? 500 : response.getStatus();
            String result = status >= 500 ? "SERVER_ERROR"
                    : status >= 400 ? "CLIENT_ERROR" : "SUCCESS";
            Timer.builder("sme.dashboard_export.http.duration")
                    .description("Authorized dashboard/export HTTP boundary duration")
                    .tags("operation", operation, "result", result)
                    .publishPercentileHistogram()
                    .minimumExpectedValue(Duration.ofMillis(1))
                    .maximumExpectedValue(Duration.ofSeconds(60))
                    .register(registry)
                    .record(Math.max(0, System.nanoTime() - started),
                            java.util.concurrent.TimeUnit.NANOSECONDS);
        }
    }

    /** Return ONLY finite controlled names, never a dynamic request path. */
    static String operation(String method, String uri) {
        if (method == null || uri == null) return null;
        String m = method.toUpperCase(Locale.ROOT);
        if ("GET".equals(m)) {
            if ("/api/v1/dashboard/me".equals(uri)) return "DASHBOARD_PERSONAL";
            if ("/api/v1/dashboard/management".equals(uri)) return "DASHBOARD_MANAGEMENT";
            if (MEETING_MINUTES.matcher(uri).matches()) return "MINUTES_VIEW";
            if (EXPORT_STATUS.matcher(uri).matches()) return "EXPORT_STATUS";
        } else if ("POST".equals(m)) {
            if (MEETING_EXPORTS.matcher(uri).matches()) return "EXPORT_ADMISSION";
            if (EXPORT_ACCESS.matcher(uri).matches()) return "EXPORT_ACCESS";
        }
        return null;
    }
}
