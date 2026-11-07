package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;
import java.net.http.*;
import java.net.URI;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.core.io.support.PropertiesLoaderUtils;
import org.springframework.core.io.ClassPathResource;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.micrometer.metrics.autoconfigure.MetricsAutoConfiguration;
import org.springframework.boot.micrometer.metrics.autoconfigure.export.prometheus.PrometheusMetricsExportAutoConfiguration;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

class PrivateMetricsConfigurationTests {
    // No @SpringBootTest metrics customizer: exercise production auto-configuration
    // and the actual application.properties, without database or inference startup.
    private final ApplicationContextRunner runtime=new ApplicationContextRunner()
        .withInitializer(new ConfigDataApplicationContextInitializer())
        .withConfiguration(AutoConfigurations.of(MetricsAutoConfiguration.class,PrometheusMetricsExportAutoConfiguration.class))
        .withUserConfiguration(PrivateMetricsController.class);

    @Test void productionDefaultsDoNotConstructAnExporter() {
        runtime.run(context->{
            assertThat(context).hasNotFailed().doesNotHaveBean(PrivateMetricsController.class).doesNotHaveBean(PrometheusMeterRegistry.class);
        });
    }
    @Test void productionOptInConstructsTheSupportedRegistryWithoutInference() {
        runtime.withPropertyValues("app.monitoring.private.enabled=true").run(context->{
            assertThat(context).hasNotFailed().hasSingleBean(PrometheusMeterRegistry.class).hasSingleBean(PrivateMetricsController.class);
            var registry=context.getBean(PrometheusMeterRegistry.class);
            io.micrometer.core.instrument.Gauge.builder("diarization.verified.only.outstanding",()->2).register(registry);
            assertThat(context.getBean(PrivateMetricsController.class).scrape().getBody())
                .contains("# TYPE diarization_verified_only_outstanding gauge","diarization_verified_only_outstanding 2.0");
        });
    }
    @Test void enabledExporterWithAnExplicitlyDisabledRegistryFailsClosed() {
        runtime.withPropertyValues("app.monitoring.private.enabled=true","management.prometheus.metrics.export.enabled=false").run(context->{
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasRootCauseInstanceOf(org.springframework.beans.factory.NoSuchBeanDefinitionException.class)
                .hasStackTraceContaining("privateMetricsController").hasStackTraceContaining("PrometheusMeterRegistry");
        });
    }
    @Test void defaultsExposeOnlyHealthAndKeepAllProductionAdmissionOff() throws Exception {
        var p=PropertiesLoaderUtils.loadProperties(new ClassPathResource("application.properties"));
        assertThat(p.getProperty("management.endpoints.web.exposure.include")).isEqualTo("health");
        assertThat(p.getProperty("app.monitoring.private.enabled")).endsWith(":false}");
        for(String key:List.of("app.media.processing.diarization-enabled","app.worker.diarization.enabled"))
            assertThat(p.getProperty(key)).endsWith(":false}");
        var factory=new TomcatServletWebServerFactory(0);PrivateConnector.configure(factory,PrivateConnector.Settings.disabled());
        var server=factory.getWebServer();server.start();
        try(var client=HttpClient.newHttpClient()) {
            assertThat(client.send(HttpRequest.newBuilder(URI.create("http://localhost:"+server.getPort()+"/internal/monitoring/prometheus")).GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
        } finally {server.stop();server.destroy();}
    }
    @ParameterizedTest @ValueSource(strings={"0.0.0.0","::","8.8.8.8","localhost",""})
    void exporterRequiresAnExplicitPrivateNetworkBind(String address) {
        var env=new MockEnvironment().withProperty("app.monitoring.private.enabled","true")
            .withProperty("app.transport.private.enabled","true").withProperty("app.transport.private.address",address);
        assertThatThrownBy(()->new SecureTransportConfiguration().privateConnector(env)).isInstanceOf(IllegalStateException.class)
            .hasMessage("Private monitoring requires an explicit private mTLS bind");
    }
    @Test void missingPrivateConnectorFailsClosed() {
        var env=new MockEnvironment().withProperty("app.monitoring.private.enabled","true");
        assertThatThrownBy(()->new SecureTransportConfiguration().privateConnector(env)).isInstanceOf(IllegalStateException.class);
    }
    @Test void missingTlsMaterialCannotStartExporter() {
        var env=new MockEnvironment().withProperty("app.monitoring.private.enabled","true")
            .withProperty("app.transport.private.enabled","true").withProperty("app.transport.private.address","127.0.0.1");
        assertThatThrownBy(()->new SecureTransportConfiguration().privateConnector(env).customize(new TomcatServletWebServerFactory(0)))
            .isInstanceOf(IllegalStateException.class).hasMessage("Invalid private mTLS connector configuration");
    }
}
