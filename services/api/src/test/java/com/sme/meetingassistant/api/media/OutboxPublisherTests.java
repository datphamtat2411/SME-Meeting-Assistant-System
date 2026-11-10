package com.sme.meetingassistant.api.media;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
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
        when(repository.claimPendingOutbox(1, 60, 3, false))
            .thenReturn(List.of(event), List.of());
    }

    @Test
    void diarizationNotificationUsesItsDedicatedRouteAndNeverChangesStageState() {
        event = new Outbox(UUID.randomUUID(), "PROCESSING_DIARIZATION_REQUESTED", "{\"schemaVersion\":1}", 1, UUID.randomUUID());
        props.getOutbox().setDiarizationRoutingKey("processing.diarization.requested");
        oneClaim();
        when(repository.markPublished(event.id(), event.claimToken())).thenReturn(true);
        doAnswer(invocation -> {
            CorrelationData cd = invocation.getArgument(3);
            cd.getFuture().complete(new CorrelationData.Confirm(true, null));
            return null;
        }).when(rabbit).send(eq("meeting.processing"), eq("processing.diarization.requested"),
            any(Message.class), any(CorrelationData.class));
        publisher.publishPending();
        ArgumentCaptor<Message> msg = ArgumentCaptor.forClass(Message.class);
        verify(rabbit).send(eq("meeting.processing"), eq("processing.diarization.requested"),
            msg.capture(), any(CorrelationData.class));
        assertEquals(event.payload(), new String(msg.getValue().getBody(), StandardCharsets.UTF_8));
        assertEquals(1, msg.getValue().getMessageProperties().getHeaders().get("eventSchemaVersion"));
        assertEquals(event.id().toString(), msg.getValue().getMessageProperties().getHeaders().get("eventId"));
        assertEquals(event.eventType(), msg.getValue().getMessageProperties().getHeaders().get("eventType"));
        verify(repository).markPublished(event.id(), event.claimToken());
        verify(repository, never()).completeStage(any(), any(), any(), any());
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "{}", "{\"schemaVersion\":null}", "{\"schemaVersion\":\"1\"}",
        "{\"schemaVersion\":true}", "{\"schemaVersion\":false}", "{\"schemaVersion\":1.0}",
        "{\"schemaVersion\":1.5}", "{\"schemaVersion\":2}", "{\"schemaVersion\":0}",
        "{\"schemaVersion\":-1}", "{\"schemaVersion\":[]}", "{\"schemaVersion\":{}}",
        "{\"schemaVersion\":999999999999999999999}", "{\"schemaVersion\":1,\"schemaVersion\":1}",
        "{\"schemaVersion\":1} {}"
    })
    void invalidPersistedVersionIsNotPublishedOrUpgraded(String payload) {
        event = new Outbox(UUID.randomUUID(), "PROCESSING_DIARIZATION_REQUESTED", payload, 1, UUID.randomUUID());
        oneClaim();
        publisher.publishPending();
        verify(rabbit, never()).send(any(String.class), any(String.class), any(Message.class), any(CorrelationData.class));
        verify(repository).markPublishFailed(event.id(), event.claimToken(), 1, 3, "WorkerException");
        verify(repository, never()).markPublished(any(), any());
    }

    @Test
    void diarizationRetriesAndDuplicatePublicationRetainExactPayloadAndVersion() {
        UUID eventId = UUID.randomUUID();
        String payload = "{ \"schemaVersion\" : 1, \"eventId\" : \"" + eventId + "\" }";
        event = new Outbox(eventId, "PROCESSING_DIARIZATION_REQUESTED", payload, 1, UUID.randomUUID());
        var retry = new Outbox(event.id(), event.eventType(), payload, 2, UUID.randomUUID());
        var duplicate = new Outbox(event.id(), event.eventType(), payload, 3, UUID.randomUUID());
        when(repository.claimPendingOutbox(1, 60, 3, false))
            .thenReturn(List.of(event), List.of(), List.of(retry), List.of(), List.of(duplicate), List.of());
        when(repository.markPublished(eq(event.id()), any(UUID.class))).thenReturn(true);
        // The initial broker NACK must not replace the stored version on retry.
        doAnswer(invocation -> {
            CorrelationData cd = invocation.getArgument(3);
            cd.getFuture().complete(new CorrelationData.Confirm(false, "nack"));
            return null;
        }).doAnswer(invocation -> {
            CorrelationData cd = invocation.getArgument(3);
            cd.getFuture().complete(new CorrelationData.Confirm(true, null));
            return null;
        }).when(rabbit).send(any(String.class), any(String.class), any(Message.class), any(CorrelationData.class));
        publisher.publishPending();
        publisher.publishPending();
        publisher.publishPending();
        ArgumentCaptor<Message> messages = ArgumentCaptor.forClass(Message.class);
        verify(rabbit, org.mockito.Mockito.times(3)).send(eq("meeting.processing"), eq("processing.diarization.requested"),
            messages.capture(), any(CorrelationData.class));
        for (Message message : messages.getAllValues()) {
            assertEquals(payload, new String(message.getBody(), StandardCharsets.UTF_8));
            assertEquals(Integer.valueOf(1), message.getMessageProperties().getHeaders().get("eventSchemaVersion"));
            assertEquals(event.id().toString(), message.getMessageProperties().getMessageId());
        }
        verify(repository).markPublishFailed(event.id(), event.claimToken(), 1, 3, "IllegalStateException");
        verify(repository).markPublished(retry.id(), retry.claimToken());
        verify(repository).markPublished(duplicate.id(), duplicate.claimToken());
    }

    @ParameterizedTest
    @ValueSource(strings = {"PROCESSING_JOB_QUEUED", "PROCESSING_JOB_RETRY_REQUESTED"})
    void confirmedRoutableEventIsPersistentAndFencedByClaimToken(String eventType) {
        event = new Outbox(event.id(), eventType, event.payload(), event.attemptCount(), event.claimToken());
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
        assertFalse(msg.getValue().getMessageProperties().getHeaders().containsKey("eventSchemaVersion"));
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
    void intelligenceUsesDedicatedRouteAndPersistedVersionWithConfirmFencing() {
        props.getIntelligence().setEnabled(true);
        props.getIntelligence().setDispatchEnabled(true);
        event=new Outbox(UUID.randomUUID(),"PROCESSING_INTELLIGENCE_STAGE_REQUESTED","{\"schemaVersion\":1}",1,UUID.randomUUID());
        when(repository.claimPendingOutbox(1,60,3,true)).thenReturn(List.of(event),List.of());
        doAnswer(c->{((CorrelationData)c.getArgument(3)).getFuture().complete(new CorrelationData.Confirm(true,null));return null;})
            .when(rabbit).send(eq("meeting.processing"),eq("processing.intelligence.requested"),any(Message.class),any(CorrelationData.class));
        publisher.publishPending();
        verify(repository).markPublished(event.id(),event.claimToken());
        verify(rabbit,never()).send(eq("meeting.processing"),eq("processing.job.queued"),any(Message.class),any(CorrelationData.class));
    }

    @Test
    void knowledgeNotificationUsesDedicatedRouteAndPersistentVersionedHeaders() {
        event = new Outbox(UUID.randomUUID(), "KNOWLEDGE_INDEXING_REQUESTED",
            "{\"schemaVersion\":1,\"operation\":\"UPSERT\"}", 1, UUID.randomUUID());
        props.getOutbox().setKnowledgeRoutingKey("knowledge.indexing.requested");
        when(repository.claimPendingOutbox(1,60,3,false)).thenReturn(List.of(event),List.of());
        when(repository.markPublished(event.id(),event.claimToken())).thenReturn(true);
        doAnswer(invocation -> {
            CorrelationData cd = invocation.getArgument(3);
            cd.getFuture().complete(new CorrelationData.Confirm(true,null));
            return null;
        }).when(rabbit).send(eq("meeting.processing"),eq("knowledge.indexing.requested"),
            any(Message.class),any(CorrelationData.class));

        publisher.publishPending();

        ArgumentCaptor<Message> message = ArgumentCaptor.forClass(Message.class);
        verify(rabbit).send(eq("meeting.processing"),eq("knowledge.indexing.requested"),
            message.capture(),any(CorrelationData.class));
        assertEquals(MessageDeliveryMode.PERSISTENT,
            message.getValue().getMessageProperties().getDeliveryMode());
        assertEquals(Integer.valueOf(1),
            message.getValue().getMessageProperties().getHeaders().get("eventSchemaVersion"));
        assertEquals(event.id().toString(),
            message.getValue().getMessageProperties().getHeaders().get("eventId"));
        verify(repository).markPublished(event.id(),event.claimToken());
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
