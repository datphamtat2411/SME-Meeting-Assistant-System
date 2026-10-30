package com.sme.meetingassistant.api.media.outbox;

import com.sme.meetingassistant.api.media.MediaProperties;
import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.Declarables;
import org.springframework.amqp.core.DirectExchange;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;

@Configuration
@ConditionalOnProperty(name = "app.media.outbox.enabled", havingValue = "true", matchIfMissing = true)
public class MediaMessagingConfiguration {
    public static final String QUEUE = "meeting.processing.jobs";
    public static final String DEAD_LETTER_EXCHANGE = "meeting.processing.dlx";
    public static final String DEAD_LETTER_QUEUE = "meeting.processing.jobs.dead";

    @Bean
    Declarables mediaProcessingTopology(MediaProperties properties) {
        DirectExchange exchange = new DirectExchange(properties.getOutbox().getExchange(), true, false);
        DirectExchange deadLetterExchange = new DirectExchange(DEAD_LETTER_EXCHANGE, true, false);
        Queue queue = QueueBuilder.durable(QUEUE).deadLetterExchange(DEAD_LETTER_EXCHANGE)
            .deadLetterRoutingKey(DEAD_LETTER_QUEUE).build();
        Queue deadLetterQueue = QueueBuilder.durable(DEAD_LETTER_QUEUE).build();
        Binding binding = BindingBuilder.bind(queue).to(exchange).with(properties.getOutbox().getRoutingKey());
        Binding deadBinding = BindingBuilder.bind(deadLetterQueue).to(deadLetterExchange).with(DEAD_LETTER_QUEUE);
        return new Declarables(exchange, deadLetterExchange, queue, deadLetterQueue, binding, deadBinding);
    }
}
