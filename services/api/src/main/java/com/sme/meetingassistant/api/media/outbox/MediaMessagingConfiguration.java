package com.sme.meetingassistant.api.media.outbox;

import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.DirectExchange;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.media.messaging", name = "enabled", havingValue = "true")
@EnableScheduling
public class MediaMessagingConfiguration {

	@Bean
	DirectExchange mediaProcessingExchange(@Value("${app.media.messaging.exchange:media.processing}") String name) {
		return new DirectExchange(name, true, false);
	}

	@Bean
	Queue mediaProcessingQueue(@Value("${app.media.messaging.queue:media.processing.jobs}") String name) {
		return QueueBuilder.durable(name).build();
	}

	@Bean
	Binding mediaProcessingBinding(Queue mediaProcessingQueue, DirectExchange mediaProcessingExchange,
			@Value("${app.media.messaging.routing-key:processing.job.requested}") String routingKey) {
		return BindingBuilder.bind(mediaProcessingQueue).to(mediaProcessingExchange).with(routingKey);
	}

}
