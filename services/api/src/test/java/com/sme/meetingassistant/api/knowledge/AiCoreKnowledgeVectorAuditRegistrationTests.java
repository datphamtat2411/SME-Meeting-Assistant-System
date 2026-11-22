package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.transport.AiCoreTransport;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.FilterType;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class AiCoreKnowledgeVectorAuditRegistrationTests {
    private final ApplicationContextRunner contexts = new ApplicationContextRunner()
        .withUserConfiguration(AuditScan.class, TransportConfiguration.class);

    @Test
    void registersTheScannedAuditWhenTheTransportBeanIsDeclaredLater() {
        contexts.withPropertyValues("app.transport.ai.enabled=true").run(context -> {
            assertThat(context).hasSingleBean(AiCoreTransport.class)
                .hasSingleBean(AiCoreKnowledgeVectorAudit.class);
        });
    }

    @Test
    void noAuditWhenTheAuthenticatedTransportIsDisabled() {
        contexts.withPropertyValues("app.transport.ai.enabled=false").run(context -> {
            assertThat(context).doesNotHaveBean(AiCoreTransport.class)
                .doesNotHaveBean(AiCoreKnowledgeVectorAudit.class);
        });
    }

    @TestConfiguration(proxyBeanMethods = false)
    @ComponentScan(basePackageClasses = AiCoreKnowledgeVectorAudit.class, useDefaultFilters = false,
        includeFilters = @ComponentScan.Filter(type = FilterType.ASSIGNABLE_TYPE,
            classes = AiCoreKnowledgeVectorAudit.class))
    static class AuditScan {}

    @TestConfiguration(proxyBeanMethods = false)
    static class TransportConfiguration {
        @Bean
        @ConditionalOnProperty(name = "app.transport.ai.enabled", havingValue = "true")
        AiCoreTransport aiCoreTransport() {
            return mock(AiCoreTransport.class);
        }

        @Bean
        ObjectMapper objectMapper() {
            return JsonMapper.builder().build();
        }
    }
}
