package com.sme.meetingassistant.api.media.worker;

import com.rabbitmq.client.Channel;
import org.springframework.amqp.core.AcknowledgeMode;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer;
import org.springframework.amqp.rabbit.listener.api.ChannelAwareMessageListener;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;
import org.slf4j.LoggerFactory;

/** Independent consumer credentials; ACK occurs only after the proxied transaction returns. */
@Component
@ConditionalOnProperty(name="app.worker.dead-letter.enabled",havingValue="true")
public class DeadLetterConsumer implements SmartLifecycle {
    private final SimpleMessageListenerContainer container;
    private final CachingConnectionFactory connection;
    private final DeadLetterReconciliation reconciliation;
    public DeadLetterConsumer(@Qualifier("rabbitConnectionFactory") ConnectionFactory publisher,
            DeadLetterReconciliation reconciliation,
            @Value("${app.worker.dead-letter.username}") String username,
            @Value("${app.worker.dead-letter.password}") String password) throws CloneNotSupportedException {
        if(username.isBlank() || password.isBlank() || username.equals(publisher.getUsername()))
            throw new IllegalStateException("Separate DLQ consumer credentials required");
        if(!(publisher instanceof CachingConnectionFactory main) || !main.getRabbitConnectionFactory().isSSL())
            throw new IllegalStateException("DLQ consumer requires verified secure broker configuration");
        this.reconciliation=reconciliation;
        var client=main.getRabbitConnectionFactory().clone();
        client.setUsername(username); client.setPassword(password);
        connection=new CachingConnectionFactory(client);
        container=new SimpleMessageListenerContainer(connection);
        container.setQueueNames("meeting.processing.jobs.dead");
        container.setAutoDeclare(false); container.setMissingQueuesFatal(true);
        container.setAcknowledgeMode(AcknowledgeMode.MANUAL);
        container.setPrefetchCount(1); container.setConcurrentConsumers(1);
        container.setRecoveryInterval(5000);
        container.setMessageListener((ChannelAwareMessageListener)this::receive);
    }
    void receive(Message message,Channel channel) throws Exception {
        String disposition;
        DeadLetterEvent event=null;
        try { event=DeadLetterEvent.decode(message); }
        catch(WorkerException invalid) { /* Persist fixed reason and digest, never rejected values. */ }
        try {
            if(event==null) {
                reconciliation.quarantine(WorkerJson.sha256(message.getBody()),"INVALID_ENVELOPE",message.getBody().length);
                disposition="QUARANTINED";
            } else disposition=reconciliation.reconcile(event);
        } catch(RuntimeException unavailable) {
            LoggerFactory.getLogger(getClass()).warn("worker.dlq.persistence.unavailable");
            // Preserve unacknowledged delivery; container recovers its channel with backoff.
            channel.abort();
            return;
        }
        LoggerFactory.getLogger(getClass()).info("worker.dlq.disposition={}",disposition);
        channel.basicAck(message.getMessageProperties().getDeliveryTag(),false);
    }
    @Override public void start() { container.start(); }
    @Override public void stop() { container.stop(); connection.destroy(); }
    @Override public boolean isRunning() { return container.isRunning(); }
    @Override public boolean isAutoStartup() { return true; }
}
