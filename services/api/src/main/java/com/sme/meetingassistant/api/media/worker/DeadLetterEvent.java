package com.sme.meetingassistant.api.media.worker;

import static com.sme.meetingassistant.api.media.worker.WorkerJson.*;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;

/** Strict Worker V1 envelope; broker metadata is evidence, never business authority. */
public record DeadLetterEvent(UUID event,UUID job,UUID meeting,UUID media,UUID requester,int generation,
        String type,int version,String retryStage,String evidence) {
    public static DeadLetterEvent decode(Message message) {
        var p=message.getMessageProperties();
        require("application/json".equals(p.getContentType()));
        require(p.getReceivedDeliveryMode()==MessageDeliveryMode.PERSISTENT || p.getDeliveryMode()==MessageDeliveryMode.PERSISTENT);
        var n=parse(message.getBody(),16384);
        int version=(int)number(n,"schemaVersion",1,2);
        if(version==1) fields(n,"eventId","processingJobId","meetingId","sourceMediaId","requestedByUserId","requestId","schemaVersion","occurredAt");
        else fields(n,"eventId","processingJobId","meetingId","sourceMediaId","requestedByUserId","requestId","schemaVersion","occurredAt","attemptNumber","retryFromStage");
        String correlation=string(n,"requestId",128);
        require(correlation.codePoints().noneMatch(c->Character.isISOControl(c) || Character.getType(c)==Character.FORMAT));
        try { OffsetDateTime.parse(string(n,"occurredAt",80)); }
        catch(java.time.format.DateTimeParseException e) { throw new WorkerException(422,"VALIDATION_ERROR"); }
        UUID event=uuid(n,"eventId");
        String type=version==1?"PROCESSING_JOB_QUEUED":"PROCESSING_JOB_RETRY_REQUESTED";
        require(event.toString().equals(p.getMessageId()) && event.toString().equals(p.getHeader("eventId")) && type.equals(p.getHeader("eventType")));
        Object deaths=p.getHeader("x-death");
        require(deaths instanceof List<?> && !((List<?>)deaths).isEmpty());
        Object first=((List<?>)deaths).getFirst(); require(first instanceof Map<?,?>);
        var death=(Map<?,?>)first;
        require("meeting.processing.jobs".equals(String.valueOf(death.get("queue")))
            && "meeting.processing".equals(String.valueOf(death.get("exchange")))
            && List.of("delivery_limit","rejected").contains(String.valueOf(death.get("reason")))
            && death.get("count") instanceof Long && (Long)death.get("count")>0);
        require(death.get("routing-keys") instanceof List<?> keys && keys.size()==1 && "processing.job.queued".equals(String.valueOf(keys.getFirst())));
        String stage=version==1 || n.get("retryFromStage").isNull()?null:choice(n,"retryFromStage",
            "TRANSCRIPTION","CONTEXTUAL_CORRECTION","FINALIZING_TRANSCRIPT","GENERATING_SUMMARY","EXTRACTING_DECISIONS","EXTRACTING_ACTION_ITEMS","INDEXING");
        return new DeadLetterEvent(event,uuid(n,"processingJobId"),uuid(n,"meetingId"),uuid(n,"sourceMediaId"),uuid(n,"requestedByUserId"),
            version==1?0:(int)number(n,"attemptNumber",1,Integer.MAX_VALUE),type,version,stage,sha256(message.getBody()));
    }
}
