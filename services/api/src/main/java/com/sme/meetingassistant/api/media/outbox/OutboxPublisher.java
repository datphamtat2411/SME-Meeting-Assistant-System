package com.sme.meetingassistant.api.media.outbox;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

@Component
@ConditionalOnProperty(prefix = "app.media.messaging", name = "enabled", havingValue = "true")
public class OutboxPublisher {

	private static final int BATCH_SIZE = 25;
	private static final long CONFIRM_TIMEOUT_SECONDS = 5;
	private static final RowMapper<PendingEvent> ROW_MAPPER = OutboxPublisher::mapEvent;

	private final JdbcTemplate jdbcTemplate;
	private final RabbitTemplate rabbitTemplate;
	private final String exchange;
	private final String routingKey;

	public OutboxPublisher(JdbcTemplate jdbcTemplate, RabbitTemplate rabbitTemplate,
			@Value("${app.media.messaging.exchange:media.processing}") String exchange,
			@Value("${app.media.messaging.routing-key:processing.job.requested}") String routingKey) {
		this.jdbcTemplate = jdbcTemplate;
		this.rabbitTemplate = rabbitTemplate;
		this.exchange = exchange;
		this.routingKey = routingKey;
	}

	@Scheduled(fixedDelayString = "${app.media.messaging.poll-delay-ms:1000}")
	@Transactional
	public void publishPending() {
		List<PendingEvent> events = this.jdbcTemplate.query("""
				SELECT id, event_type, payload
				FROM outbox_events
				WHERE published_at IS NULL AND next_attempt_at <= CURRENT_TIMESTAMP
				ORDER BY next_attempt_at, created_at, id
				LIMIT ?
				FOR UPDATE SKIP LOCKED
				""", ROW_MAPPER, BATCH_SIZE);
		for (PendingEvent event : events) {
			try {
				publish(event);
				this.jdbcTemplate.update("""
						UPDATE outbox_events
						SET published_at = CURRENT_TIMESTAMP, delivery_attempts = delivery_attempts + 1, last_error = NULL
						WHERE id = ?
						""", event.id());
			}
			catch (Exception exception) {
				this.jdbcTemplate.update("""
						UPDATE outbox_events
						SET delivery_attempts = delivery_attempts + 1,
						    next_attempt_at = CURRENT_TIMESTAMP + make_interval(secs => LEAST(power(2, delivery_attempts), 300)::int),
						    last_error = 'PUBLISH_FAILED'
						WHERE id = ?
						""", event.id());
			}
		}
	}

	private void publish(PendingEvent event) throws Exception {
		CorrelationData correlation = new CorrelationData(event.id().toString());
		this.rabbitTemplate.convertAndSend(this.exchange, this.routingKey, event.payload(), message -> {
			message.getMessageProperties().setHeader("eventId", event.id().toString());
			message.getMessageProperties().setHeader("eventType", event.eventType());
			message.getMessageProperties().setContentType(MessageProperties.CONTENT_TYPE_JSON);
			return message;
		}, correlation);
		CorrelationData.Confirm confirm = correlation.getFuture().get(CONFIRM_TIMEOUT_SECONDS, TimeUnit.SECONDS);
		if (!confirm.ack() || correlation.getReturned() != null) {
			throw new IllegalStateException("Broker did not confirm the outbox event.");
		}
	}

	private static PendingEvent mapEvent(ResultSet resultSet, int rowNumber) throws SQLException {
		return new PendingEvent(resultSet.getObject("id", java.util.UUID.class), resultSet.getString("event_type"),
				resultSet.getString("payload"));
	}

	private record PendingEvent(java.util.UUID id, String eventType, String payload) {
	}

}
