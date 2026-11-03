package com.sme.meetingassistant.api.media.worker;

import static org.mockito.Mockito.*;
import com.rabbitmq.client.Channel;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory;

class DeadLetterConsumerTests {
    @Test void ackFollowsDurableDispositionAndLostAckCanReplay() throws Exception {
        var reconciliation=mock(DeadLetterReconciliation.class);
        var client=new com.rabbitmq.client.ConnectionFactory();
        client.useSslProtocol(); client.enableHostnameVerification(); client.setUsername("publisher");
        var consumer=new DeadLetterConsumer(new CachingConnectionFactory(client),reconciliation,"reconciler","fixture-only");
        var fixture=new DeadLetterEventTests(); var message=fixture.message(fixture.json());
        var channel=mock(Channel.class);
        when(reconciliation.reconcile(any())).thenReturn("EXHAUSTED");
        doThrow(new java.io.IOException("lost ACK")).doNothing().when(channel).basicAck(anyLong(),eq(false));
        org.assertj.core.api.Assertions.assertThatThrownBy(()->consumer.receive(message,channel)).isInstanceOf(java.io.IOException.class);
        consumer.receive(message,channel);
        var ordered=inOrder(reconciliation,channel);
        ordered.verify(reconciliation).reconcile(any()); ordered.verify(channel).basicAck(anyLong(),eq(false));
        ordered.verify(reconciliation).reconcile(any()); ordered.verify(channel).basicAck(anyLong(),eq(false));
    }
    @Test void databaseFailureLeavesDeliveryUnacknowledgedAndPoisonMustPersist() throws Exception {
        var reconciliation=mock(DeadLetterReconciliation.class);
        var client=new com.rabbitmq.client.ConnectionFactory(); client.useSslProtocol(); client.setUsername("publisher");
        var consumer=new DeadLetterConsumer(new CachingConnectionFactory(client),reconciliation,"reconciler","fixture-only");
        var fixture=new DeadLetterEventTests(); var channel=mock(Channel.class);
        doThrow(new org.springframework.dao.DataAccessResourceFailureException("fixture")).when(reconciliation).quarantine(anyString(),anyString(),anyInt());
        consumer.receive(fixture.message("invalid"),channel);
        verify(channel,never()).basicAck(anyLong(),anyBoolean()); verify(channel).abort();
        reset(reconciliation,channel);
        consumer.receive(fixture.message("invalid"),channel);
        var ordered=inOrder(reconciliation,channel);
        ordered.verify(reconciliation).quarantine(anyString(),eq("INVALID_ENVELOPE"),eq(7));
        ordered.verify(channel).basicAck(anyLong(),eq(false));
    }
}
