package com.sme.meetingassistant.api.media.outbox;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageBuilder;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;

@Component
@ConditionalOnProperty(name = "app.media.outbox.enabled", havingValue = "true", matchIfMissing = true)
public class OutboxPublisher {
    private static final Logger LOGGER = LoggerFactory.getLogger(OutboxPublisher.class);
    private final MediaRepository repository;
    private final RabbitTemplate rabbitTemplate;
    private final MediaProperties properties;

    public OutboxPublisher(MediaRepository repository, RabbitTemplate rabbitTemplate, MediaProperties properties) {
        this.repository = repository;
        this.rabbitTemplate = rabbitTemplate;
        this.properties = properties;
    }

    @Scheduled(fixedDelayString = "${app.media.outbox.poll-delay-ms:2000}")
    public void publishPending() {
        var outbox = this.properties.getOutbox();
        int leaseSeconds = outbox.getLeaseSeconds();
        int confirmTimeoutSeconds = outbox.getConfirmTimeoutSeconds();
        int maxAttempts = outbox.getMaxAttempts();
        if (confirmTimeoutSeconds < 1 || leaseSeconds <= confirmTimeoutSeconds + 5 || maxAttempts < 1) {
            throw new IllegalStateException("Invalid media outbox confirm/lease/retry configuration");
        }

        // Claim exactly one row per publish. Never lease 25 events up front:
        // a slow broker could expire the later leases before they are sent.
        for (int i = 0; i < 25; i++) {
            boolean intelligenceEnabled=properties.getIntelligence().isEnabled() && properties.getIntelligence().isDispatchEnabled();
            var claimed = this.repository.claimPendingOutbox(1, leaseSeconds, maxAttempts,intelligenceEnabled);
            if (claimed.isEmpty()) return;
            var event = claimed.get(0);
            try {
                byte[] payload = event.payload().getBytes(StandardCharsets.UTF_8);
                var builder = MessageBuilder.withBody(payload)
                    .setContentType(MessageProperties.CONTENT_TYPE_JSON)
                    .setDeliveryMode(MessageDeliveryMode.PERSISTENT)
                    .setMessageId(event.id().toString())
                    .setHeader("eventId", event.id().toString())
                    .setHeader("eventType", event.eventType());
                boolean diarization = "PROCESSING_DIARIZATION_REQUESTED".equals(event.eventType());
                boolean intelligence="PROCESSING_INTELLIGENCE_STAGE_REQUESTED".equals(event.eventType());
                boolean knowledge = "KNOWLEDGE_INDEXING_REQUESTED".equals(event.eventType());
                if (diarization || intelligence || knowledge) {
                    // Retry the persisted notification, never manufacture a version
                    // for legacy payloads or upgrade them during publication.
                    int version = (int) WorkerJson.number(WorkerJson.parse(payload, 16384), "schemaVersion", 1, 1);
                    builder.setHeader("eventSchemaVersion", version);
                }
                Message message = builder.build();
                CorrelationData correlation = new CorrelationData(event.id().toString());
                String routingKey = knowledge ? outbox.getKnowledgeRoutingKey()
                    : intelligence ? outbox.getIntelligenceRoutingKey()
                    : diarization ? outbox.getDiarizationRoutingKey() : outbox.getRoutingKey();
                this.rabbitTemplate.send(outbox.getExchange(), routingKey, message, correlation);
                var confirm = correlation.getFuture().get(confirmTimeoutSeconds, TimeUnit.SECONDS);
                if (!confirm.ack()) {
                    throw new IllegalStateException("RabbitMQ did not confirm event publication");
                }
                // mandatory=true + publisher-returns prevents an ACK of an unroutable
                // message from being mistaken for successful delivery.
                if (correlation.getReturned() != null) {
                    throw new IllegalStateException("RabbitMQ returned an unroutable event");
                }
                if (!this.repository.markPublished(event.id(), event.claimToken())) {
                    LOGGER.warn("Ignoring stale publisher confirmation for event {}", event.id());
                }
            } catch (Exception exception) {
                if (exception instanceof InterruptedException) Thread.currentThread().interrupt();
                LOGGER.warn("Outbox publish failed for event {}: {}", event.id(), safeMessage(exception));
                if (!this.repository.markPublishFailed(event.id(), event.claimToken(),
                        event.attemptCount(), maxAttempts, safeMessage(exception))) {
                    LOGGER.warn("Ignoring stale publisher failure for event {}", event.id());
                }
                if (Thread.currentThread().isInterrupted()) return;
            }
        }
    }

    private static String safeMessage(Exception exception) {
        return exception.getClass().getSimpleName();
    }
}
