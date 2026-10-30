package com.sme.meetingassistant.api.media.outbox;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
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
        for (var event : this.repository.pendingOutbox(25)) {
            try {
                Message message = MessageBuilder.withBody(event.payload().getBytes(StandardCharsets.UTF_8))
                    .setContentType(MessageProperties.CONTENT_TYPE_JSON)
                    .setDeliveryMode(MessageDeliveryMode.PERSISTENT)
                    .setMessageId(event.id().toString())
                    .setHeader("eventId", event.id().toString())
                    .setHeader("eventType", event.eventType())
                    .build();
                CorrelationData correlation = new CorrelationData(event.id().toString());
                this.rabbitTemplate.send(this.properties.getOutbox().getExchange(),
                    this.properties.getOutbox().getRoutingKey(), message, correlation);
                var confirm = correlation.getFuture().get(10, TimeUnit.SECONDS);
                if (!confirm.ack()) throw new IllegalStateException("RabbitMQ did not confirm event publication");
                if (correlation.getReturned() != null) throw new IllegalStateException("RabbitMQ returned an unroutable event");
                this.repository.markPublished(event.id());
            } catch (Exception exception) {
                LOGGER.warn("Outbox publish failed for event {}: {}", event.id(), safeMessage(exception));
                this.repository.markPublishFailed(event.id(), event.attemptCount(),
                    this.properties.getOutbox().getMaxAttempts(), safeMessage(exception));
            }
        }
    }

    private static String safeMessage(Exception exception) {
        return exception.getClass().getSimpleName();
    }
}
