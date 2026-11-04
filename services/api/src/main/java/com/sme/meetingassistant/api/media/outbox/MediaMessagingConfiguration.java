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
import org.springframework.beans.factory.annotation.Value;

@Configuration
@ConditionalOnProperty(name = "app.media.outbox.enabled", havingValue = "true", matchIfMissing = true)
public class MediaMessagingConfiguration {
    public static final String QUEUE = "meeting.processing.jobs";
    public static final String DEAD_LETTER_EXCHANGE = "meeting.processing.dlx";
    public static final String DEAD_LETTER_QUEUE = "meeting.processing.jobs.dead";

    @Bean
    Declarables mediaProcessingTopology(MediaProperties properties,
            @Value("${app.media.messaging.topology:legacy}") String topology) {
        // Secure deployments are provisioned by an operator. Publisher credentials
        // deliberately have no configure grant. Never delete/recreate on conflict.
        if ("external-quorum".equals(topology)) return new Declarables();
        if (!"legacy".equals(topology) && !"quorum".equals(topology))
            throw new IllegalStateException("Unknown media messaging topology mode");
        DirectExchange exchange = new DirectExchange(properties.getOutbox().getExchange(), true, false);
        DirectExchange deadLetterExchange = new DirectExchange(DEAD_LETTER_EXCHANGE, true, false);
        var work = QueueBuilder.durable(QUEUE).deadLetterExchange(DEAD_LETTER_EXCHANGE)
            .deadLetterRoutingKey(DEAD_LETTER_QUEUE);
        var dead = QueueBuilder.durable(DEAD_LETTER_QUEUE);
        if ("quorum".equals(topology)) {
            work.quorum().withArgument("x-delivery-limit",5).withArgument("x-overflow","reject-publish")
                .withArgument("x-dead-letter-strategy","at-least-once");
            dead.quorum().withArgument("x-delivery-limit",-1);
        }
        Queue queue = work.build();
        Queue deadLetterQueue = dead.build();
        Binding binding = BindingBuilder.bind(queue).to(exchange).with(properties.getOutbox().getRoutingKey());
        Binding deadBinding = BindingBuilder.bind(deadLetterQueue).to(deadLetterExchange).with(DEAD_LETTER_QUEUE);
        return new Declarables(exchange, deadLetterExchange, queue, deadLetterQueue, binding, deadBinding);
    }
}
