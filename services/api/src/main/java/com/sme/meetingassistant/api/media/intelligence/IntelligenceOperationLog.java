package com.sme.meetingassistant.api.media.intelligence;

import java.util.UUID;
import org.slf4j.LoggerFactory;
import org.springframework.transaction.support.*;

/** Identity-only operational events, emitted after commit when a transaction is present. */
public final class IntelligenceOperationLog {
    private IntelligenceOperationLog() {}
    public static void record(String action,UUID job,UUID stage,UUID event) {
        String correlation=com.sme.meetingassistant.api.observability.RequestIdContext.currentRequestId();
        String safeCorrelation=correlation!=null && correlation.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")?correlation:null;
        Runnable write=()->LoggerFactory.getLogger(IntelligenceOperationLog.class).atInfo()
            .addKeyValue("operation",action).addKeyValue("processingJobId",job)
            .addKeyValue("executionStageRunId",stage).addKeyValue("eventId",event).addKeyValue("requestId",safeCorrelation).log("Meeting Intelligence lifecycle");
        if(TransactionSynchronizationManager.isSynchronizationActive())
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() {write.run();}
            });
        else write.run();
    }
}
