package com.sme.meetingassistant.api.userorganization.bootstrap;

import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.context.WebApplicationContext;

/**
 * The bootstrap runner is absent unless explicitly enabled.  It also refuses
 * to run inside a web application context, so ordinary HTTP startup cannot
 * accidentally expose or execute the operation.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(
    prefix = "app.initial-administrator-bootstrap",
    name = "enabled",
    havingValue = "true")
public class InitialAdministratorBootstrapConfiguration {
    @Bean
    ApplicationRunner initialAdministratorBootstrapRunner(
            InitialAdministratorBootstrapProperties properties,
            InitialAdministratorBootstrapService bootstrap,
            ApplicationContext context) {
        return args -> {
            if (context instanceof WebApplicationContext) {
                throw new IllegalStateException(
                    "Initial administrator bootstrap requires a non-web application");
            }
            properties.requireOperatorIntent();
            var result = bootstrap.request(properties.email(), properties.displayName());
            System.out.println("initial-administrator-bootstrap status="
                + result.status() + " user_id=" + result.userId());
        };
    }
}
