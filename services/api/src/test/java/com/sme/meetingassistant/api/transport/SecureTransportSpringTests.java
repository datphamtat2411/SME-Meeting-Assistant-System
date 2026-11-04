package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;

import jakarta.servlet.DispatcherType;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.EnumSet;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.web.filter.DelegatingFilterProxy;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;

/** Production Spring worker chain plus Valve over real sockets, no business controller. */
class SecureTransportSpringTests {
    @TempDir Path pki;

    @Test void authenticatedWorkerReachesMissingControllerWithoutFakeBusinessSuccess() throws Exception {
        TestPki.create(pki);
        var factory = new TomcatServletWebServerFactory(0);
        var connector = PrivateConnector.configure(factory, new PrivateConnector.Settings(true, "127.0.0.1", 0, "localhost",
            pki.resolve("server.crt"), pki.resolve("server.key"), pki.resolve("ca.crt"), pki.resolve("ca.crt")));
        var app = new AnnotationConfigWebApplicationContext();
        var server = factory.getWebServer(context -> {
            app.setServletContext(context); app.register(App.class); app.refresh();
            context.addServlet("dispatcher", new DispatcherServlet(app)).addMapping("/");
            context.addFilter("springSecurity", new DelegatingFilterProxy("springSecurityFilterChain", app))
                .addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST), false, "/*");
        });
        server.start();
        try (var transport = java.net.http.HttpClient.newBuilder().sslContext(PemTls.clientContext(pki.resolve("worker.crt"),
                pki.resolve("worker.key"), pki.resolve("ca.crt"), pki.resolve("ca.crt"), "urn:sme:service:ai-worker")).build()) {
            var response = transport.send(HttpRequest.newBuilder(URI.create("https://localhost:" + connector.getLocalPort()
                + SecureTransportTests.ROUTE)).timeout(Duration.ofSeconds(4)).POST(HttpRequest.BodyPublishers.noBody()).build(),
                HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).isEqualTo(404);
        } finally { server.stop(); server.destroy(); app.close(); }
    }

    @TestConfiguration(proxyBeanMethods = false)
    @EnableWebMvc @EnableWebSecurity
    @Import(SecureTransportConfiguration.class)
    static class App {
        @Bean @Order(100) SecurityFilterChain otherRoutes(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a -> a.anyRequest().permitAll()).build();
        }
    }
}
