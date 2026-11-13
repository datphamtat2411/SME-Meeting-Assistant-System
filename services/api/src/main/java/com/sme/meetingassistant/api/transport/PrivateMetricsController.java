package com.sme.meetingassistant.api.transport;

import com.sme.meetingassistant.api.assistant.AssistantAdmissionMetrics;
import com.sme.meetingassistant.api.media.diarization.DiarizationMetrics;
import com.sme.meetingassistant.api.observability.ProductIntegrationMetrics;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Registry transport only. The connector Valve and security chain authorize every scrape. */
@RestController
@ConditionalOnProperty(name="app.monitoring.private.enabled",havingValue="true")
public class PrivateMetricsController {
    private static final Set<String> EXPORTED_NAMES = java.util.stream.Stream.concat(
        java.util.stream.Stream.concat(DiarizationMetrics.EXPORTED_NAMES.stream(),
            ProductIntegrationMetrics.EXPORTED_NAMES.stream()),
        AssistantAdmissionMetrics.EXPORTED_NAMES.stream())
        .collect(Collectors.toUnmodifiableSet());
    private final PrometheusMeterRegistry registry;
    public PrivateMetricsController(PrometheusMeterRegistry registry) { this.registry=registry; }

    @GetMapping(value=PrivateConnector.METRICS_PATH,produces="text/plain; version=0.0.4; charset=utf-8")
    public ResponseEntity<String> scrape() {
        var meters=registry.getMeters().stream().filter(m->EXPORTED_NAMES.contains(m.getId().getName())).toList();
        // Use the registry's supported conversion: Prometheus removes reserved gauge
        // suffixes such as _bucket. Dot replacement silently omitted distributions.
        var convention=registry.config().namingConvention();
        Set<String> names=meters.stream().map(m->m.getId().getConventionName(convention)).collect(Collectors.toSet());
        // Check complete selected families, including a non-allowlisted name that
        // normalizes to an approved family. Common deployment tags also fail closed.
        if(registry.getMeters().stream().filter(m->names.contains(m.getId().getConventionName(convention)))
            .anyMatch(m->!EXPORTED_NAMES.contains(m.getId().getName())
                || !safeType(m.getId().getName(),m.getId().getType())
                || m.getId().getTags().stream().anyMatch(t->!safeTag(t.getKey(),t.getValue()))))
            return ResponseEntity.status(503).header("Cache-Control","no-store").body("Metrics unavailable.\n");
        return ResponseEntity.ok().header("Cache-Control","no-store").body(registry.scrape("text/plain; version=0.0.4; charset=utf-8",names));
    }
    private static boolean safeTag(String key,String value) {
        return switch(key) {
            case "outcome" -> Set.of("accepted","failed").contains(value);
            case "state" -> Set.of("actionable","stale","superseded").contains(value);
            case "le_seconds" -> Set.of("30","120","300","900","3600","infinity").contains(value);
            case "le" -> Set.of("0","1","2","5","10","100","1000","16384").contains(value);
            case "operation" -> Set.of("ASK","CONVERSATION_CREATE").contains(value);
            case "reason" -> Set.of("ASK_QUOTA","CONVERSATION_QUOTA","USER_CONCURRENCY",
                "MEETING_CONCURRENCY","GLOBAL_CONCURRENCY").contains(value);
            default -> false;
        };
    }

    private static boolean safeType(String name,io.micrometer.core.instrument.Meter.Type type) {
        if (!AssistantAdmissionMetrics.EXPORTED_NAMES.contains(name)) {
            return type==io.micrometer.core.instrument.Meter.Type.GAUGE;
        }
        return switch(name) {
            case "sme.assistant.admission.active" -> type==io.micrometer.core.instrument.Meter.Type.GAUGE;
            case "sme.assistant.admission.latency" -> type==io.micrometer.core.instrument.Meter.Type.TIMER;
            default -> type==io.micrometer.core.instrument.Meter.Type.COUNTER;
        };
    }
}
