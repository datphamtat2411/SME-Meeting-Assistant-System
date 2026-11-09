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
    public static final String INTELLIGENCE_QUEUE="meeting.processing.intelligence";
    public static final String INTELLIGENCE_DEAD_LETTER_QUEUE=INTELLIGENCE_QUEUE+".dead";
    public static final String KNOWLEDGE_QUEUE="meeting.knowledge.indexing";
    public static final String KNOWLEDGE_DEAD_LETTER_QUEUE=KNOWLEDGE_QUEUE+".dead";

    @Bean
    @ConditionalOnProperty(name="app.media.intelligence.dispatch-enabled",havingValue="true")
    Declarables intelligenceTopology(MediaProperties properties,@Value("${app.media.messaging.topology:legacy}") String topology) {
        if("external-quorum".equals(topology)) return new Declarables();
        if(!"quorum".equals(topology)) throw new IllegalStateException("Intelligence workers require a quorum topology");
        if(!"processing.intelligence.requested".equals(properties.getOutbox().getIntelligenceRoutingKey())
            || properties.getOutbox().getIntelligenceRoutingKey().equals(properties.getOutbox().getRoutingKey()))
            throw new IllegalStateException("Intelligence requires an isolated notification route");
        var exchange=new DirectExchange(properties.getOutbox().getExchange(),true,false);
        var dlx=new DirectExchange(DEAD_LETTER_EXCHANGE,true,false);
        var work=QueueBuilder.durable(INTELLIGENCE_QUEUE).quorum().withArgument("x-delivery-limit",5)
            .withArgument("x-overflow","reject-publish").withArgument("x-dead-letter-strategy","at-least-once")
            .deadLetterExchange(DEAD_LETTER_EXCHANGE).deadLetterRoutingKey(INTELLIGENCE_DEAD_LETTER_QUEUE).build();
        var dead=QueueBuilder.durable(INTELLIGENCE_DEAD_LETTER_QUEUE).quorum().withArgument("x-delivery-limit",-1).build();
        return new Declarables(exchange,dlx,work,dead,
            BindingBuilder.bind(work).to(exchange).with(properties.getOutbox().getIntelligenceRoutingKey()),
            BindingBuilder.bind(dead).to(dlx).with(INTELLIGENCE_DEAD_LETTER_QUEUE));
    }

    @Bean
    @ConditionalOnProperty(name="app.media.knowledge-indexing.enabled",havingValue="true")
    Declarables knowledgeTopology(MediaProperties properties,
            @Value("${app.media.messaging.topology:legacy}") String topology) {
        if ("external-quorum".equals(topology)) return new Declarables();
        if (!"quorum".equals(topology)) throw new IllegalStateException(
            "Knowledge indexing requires a quorum topology");
         String route = properties.getOutbox().getKnowledgeRoutingKey();
        if (!"knowledge.indexing.requested".equals(route)
                || route.equals(properties.getOutbox().getRoutingKey())
                || route.equals(properties.getOutbox().getDiarizationRoutingKey())
                || route.equals(properties.getOutbox().getIntelligenceRoutingKey())) {
            throw new IllegalStateException("Knowledge indexing requires an isolated notification route");
        }
        var exchange = new DirectExchange(properties.getOutbox().getExchange(), true, false);
        var dlx = new DirectExchange(DEAD_LETTER_EXCHANGE, true, false);
        var work = QueueBuilder.durable(KNOWLEDGE_QUEUE).quorum()
            .withArgument("x-delivery-limit", 5)
            .withArgument("x-overflow", "reject-publish")
            .withArgument("x-dead-letter-strategy", "at-least-once")
            .deadLetterExchange(DEAD_LETTER_EXCHANGE)
            .deadLetterRoutingKey(KNOWLEDGE_DEAD_LETTER_QUEUE).build();
        var dead = QueueBuilder.durable(KNOWLEDGE_DEAD_LETTER_QUEUE).quorum()
            .withArgument("x-delivery-limit", -1).build();
        return new Declarables(exchange, dlx, work, dead,
            BindingBuilder.bind(work).to(exchange).with(route),
            BindingBuilder.bind(dead).to(dlx).with(KNOWLEDGE_DEAD_LETTER_QUEUE));
    }

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
