package com.sme.meetingassistant.api.media;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.sme.meetingassistant.api.media.outbox.OutboxPublisher;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Outbox;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;

@ExtendWith(MockitoExtension.class)
class OutboxPublisherTests {
    @Mock MediaRepository repository;
    @Mock RabbitTemplate rabbit;
    private MediaProperties props;
    private OutboxPublisher publisher;
    private Outbox event;

    @BeforeEach
    void setUp() {
        props = new MediaProperties();
        props.getOutbox().setExchange("meeting.processing");
        props.getOutbox().setRoutingKey("processing.job.queued");
        props.getOutbox().setLeaseSeconds(60);
        props.getOutbox().setConfirmTimeoutSeconds(1);
        props.getOutbox().setMaxAttempts(3);
        event = new Outbox(UUID.randomUUID(), "PROCESSING_JOB_QUEUED",
            "{\"processingJobId\":\"example\"}", 1, UUID.randomUUID());
        publisher = new OutboxPublisher(repository, rabbit, props);
    }

    private void oneClaim() {
        when(repository.claimPendingOutbox(1, 60, 3))
            .thenReturn(List.of(event), List.of());
    }

    @Test
    void confirmedRoutableEventIsPersistentAndFencedByClaimToken() {
        oneClaim();
        when(repository.markPublished(event.id(), event.claimToken())).thenReturn(true);
        doAnswer(invocation -> {
            CorrelationData cd = invocation.getArgument(3);
            cd.getFuture().complete(new CorrelationData.Confirm(true, null));
            return null;
        }).when(rabbit).send(eq("meeting.processing"), eq("processing.job.queued"),
            any(Message.class), any(CorrelationData.class));

        publisher.publishPending();

        ArgumentCaptor<Message> msg = ArgumentCaptor.forClass(Message.class);
        verify(rabbit).send(eq("meeting.processing"), eq("processing.job.queued"),
            msg.capture(), any(CorrelationData.class));
        assertEquals(event.payload(), new String(msg.getValue().getBody(), StandardCharsets.UTF_8));
        assertEquals(event.id().toString(), msg.getValue().getMessageProperties().getMessageId());
        assertEquals(event.id().toString(), msg.getValue().getMessageProperties().getHeaders().get("eventId"));
        assertEquals(MessageDeliveryMode.PERSISTENT, msg.getValue().getMessageProperties().getDeliveryMode());
        verify(repository).markPublished(event.id(), event.claimToken());
        verify(repository, never()).markPublishFailed(any(), any(), org.mockito.ArgumentMatchers.anyInt(), org.mockito.ArgumentMatchers.anyInt(), any());
    }

    @Test
    void brokerNackRetainsEventForBackoffUnderSameLease() {
        oneClaim();
        doAnswer(invocation -> {
            CorrelationData cd = invocation.getArgument(3);
            cd.getFuture().complete(new CorrelationData.Confirm(false, "nack"));
            return null;
        }).when(rabbit).send(any(String.class), any(String.class),
            any(Message.class), any(CorrelationData.class));

        publisher.publishPending();

        verify(repository).markPublishFailed(event.id(), event.claimToken(), 1, 3, "IllegalStateException");
        verify(repository, never()).markPublished(any(), any());
    }

    @Test
    void unconfirmedDeliveryTimesOutAndReleasesLeaseForBackoff() {
        oneClaim();

        publisher.publishPending();

        verify(repository).markPublishFailed(event.id(), event.claimToken(), 1, 3, "TimeoutException");
        verify(repository, never()).markPublished(any(), any());
    }

    @Test
    void acknowledgedButReturnedMessageIsNotMarkedPublished() {
        oneClaim();
        doAnswer(invocation -> {
            CorrelationData cd = invocation.getArgument(3);
            cd.setReturned(new org.springframework.amqp.core.ReturnedMessage(
                invocation.getArgument(2), 312, "NO_ROUTE", "meeting.processing", "processing.job.queued"));
            cd.getFuture().complete(new CorrelationData.Confirm(true, null));
            return null;
        }).when(rabbit).send(any(String.class), any(String.class),
            any(Message.class), any(CorrelationData.class));

        publisher.publishPending();

        verify(repository).markPublishFailed(event.id(), event.claimToken(), 1, 3, "IllegalStateException");
        verify(repository, never()).markPublished(any(), any());
    }

    @Test
    void latePublisherCannotClearAnotherWorkersLeaseAfterConfirm() {
        oneClaim();
        when(repository.markPublished(event.id(), event.claimToken())).thenReturn(false);
        doAnswer(invocation -> {
            CorrelationData cd = invocation.getArgument(3);
            cd.getFuture().complete(new CorrelationData.Confirm(true, null));
            return null;
        }).when(rabbit).send(any(String.class), any(String.class),
            any(Message.class), any(CorrelationData.class));

        publisher.publishPending();

        verify(repository).markPublished(event.id(), event.claimToken());
        verify(repository, never()).markPublishFailed(any(), any(), org.mockito.ArgumentMatchers.anyInt(), org.mockito.ArgumentMatchers.anyInt(), any());
    }
}
