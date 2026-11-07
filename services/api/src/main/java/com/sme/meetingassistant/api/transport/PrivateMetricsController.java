package com.sme.meetingassistant.api.transport;

import com.sme.meetingassistant.api.media.diarization.DiarizationMetrics;
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
    private final PrometheusMeterRegistry registry;
    public PrivateMetricsController(PrometheusMeterRegistry registry) { this.registry=registry; }

    @GetMapping(value=PrivateConnector.METRICS_PATH,produces="text/plain; version=0.0.4; charset=utf-8")
    public ResponseEntity<String> scrape() {
        var meters=registry.getMeters().stream().filter(m->DiarizationMetrics.EXPORTED_NAMES.contains(m.getId().getName())).toList();
        // Common deployment tags are also checked: never accidentally export sensitive tags.
        if(meters.stream().anyMatch(m->m.getId().getTags().stream().anyMatch(t->!safeTag(t.getKey(),t.getValue()))))
            return ResponseEntity.status(503).header("Cache-Control","no-store").body("Metrics unavailable.\n");
        Set<String> names=meters.stream().map(m->m.getId().getName().replace('.','_')).collect(Collectors.toSet());
        return ResponseEntity.ok().header("Cache-Control","no-store").body(registry.scrape("text/plain; version=0.0.4; charset=utf-8",names));
    }
    private static boolean safeTag(String key,String value) {
        return switch(key) {
            case "outcome" -> Set.of("accepted","failed").contains(value);
            case "state" -> Set.of("actionable","stale","superseded").contains(value);
            case "le_seconds" -> Set.of("30","120","300","900","3600","infinity").contains(value);
            case "le" -> Set.of("0","1","2","5","10","100","1000","16384").contains(value);
            default -> false;
        };
    }
}
