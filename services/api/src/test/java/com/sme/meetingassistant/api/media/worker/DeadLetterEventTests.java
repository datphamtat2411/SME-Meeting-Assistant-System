package com.sme.meetingassistant.api.media.worker;

import static org.assertj.core.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.core.MessageDeliveryMode;

class DeadLetterEventTests {
    Message message(String json) {
        var p=new MessageProperties(); p.setMessageId("11111111-1111-4111-8111-111111111111");
        p.setContentType("application/json"); p.setDeliveryMode(MessageDeliveryMode.PERSISTENT);
        p.setHeader("eventId",p.getMessageId()); p.setHeader("eventType","PROCESSING_JOB_QUEUED");
        p.setHeader("x-death",List.of(Map.of("queue","meeting.processing.jobs","exchange","meeting.processing",
            "reason","delivery_limit","count",1L,"routing-keys",List.of("processing.job.queued"))));
        return new Message(json.getBytes(StandardCharsets.UTF_8),p);
    }
    String json() {
        var n=WorkerJson.MAPPER.createObjectNode();
        for(String key:List.of("eventId","processingJobId","meetingId","sourceMediaId","requestedByUserId"))
            n.put(key,key.equals("eventId")?"11111111-1111-4111-8111-111111111111":UUID.randomUUID().toString());
        return n.put("schemaVersion",1).put("requestId","fixture").put("occurredAt","2026-11-03T00:00:00Z").toString();
    }
    @Test void acceptsOnlyStrictEnvelopeAndBrokerHandoff() {
        assertThat(DeadLetterEvent.decode(message(json())).generation()).isZero();
        assertThatThrownBy(()->DeadLetterEvent.decode(message(json().replace("\"schemaVersion\":1","\"schemaVersion\":true"))))
            .isInstanceOf(WorkerException.class);
        var m=message(json()); m.getMessageProperties().setHeader("x-death",List.of());
        assertThatThrownBy(()->DeadLetterEvent.decode(m)).isInstanceOf(WorkerException.class);
        assertThatThrownBy(()->DeadLetterEvent.decode(message(json().replace("\"requestId\":", "\"eventId\":\"bad\",\"requestId\":"))))
            .isInstanceOf(WorkerException.class);
    }
}
