package com.sme.meetingassistant.api.assistant;

import com.sme.meetingassistant.api.transport.AiCoreTransport;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.FilterType;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class AiCoreAssistantGatewayRegistrationTests {
    private final ApplicationContextRunner contexts = new ApplicationContextRunner()
        .withUserConfiguration(GatewayScan.class, TransportConfiguration.class);

    @Test
    void registersTheScannedGatewayWhenTheTransportBeanIsDeclaredLater() {
        contexts.withPropertyValues("app.transport.ai.enabled=true").run(context -> {
            assertThat(context).hasSingleBean(AiCoreTransport.class)
                .hasSingleBean(AssistantAiGateway.class);
        });
    }

    @Test
    void noGatewayWhenTheAuthenticatedTransportIsDisabled() {
        contexts.withPropertyValues("app.transport.ai.enabled=false").run(context -> {
            assertThat(context).doesNotHaveBean(AiCoreTransport.class)
                .doesNotHaveBean(AssistantAiGateway.class);
        });
    }

    @Test
    void noGatewayInTheDedicatedInitialAdministratorBootstrapContext() {
        contexts.withPropertyValues(
            "app.transport.ai.enabled=true",
            "app.initial-administrator-bootstrap.enabled=true").run(context -> {
                assertThat(context).hasSingleBean(AiCoreTransport.class)
                    .doesNotHaveBean(AssistantAiGateway.class);
            });
    }

    @TestConfiguration(proxyBeanMethods = false)
    @ComponentScan(basePackageClasses = AiCoreAssistantGateway.class, useDefaultFilters = false,
        includeFilters = @ComponentScan.Filter(type = FilterType.ASSIGNABLE_TYPE, classes = AiCoreAssistantGateway.class))
    static class GatewayScan {}

    @TestConfiguration(proxyBeanMethods = false)
    static class TransportConfiguration {
        @Bean
        @ConditionalOnProperty(name = "app.transport.ai.enabled", havingValue = "true")
        AiCoreTransport aiCoreTransport() {
            return mock(AiCoreTransport.class);
        }
    }
}
