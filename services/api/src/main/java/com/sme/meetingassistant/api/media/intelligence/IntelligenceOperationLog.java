package com.sme.meetingassistant.api.media.intelligence;

import org.slf4j.LoggerFactory;
import org.springframework.transaction.support.*;

/** Identity-only operational events, emitted after commit when a transaction is present. */
public final class IntelligenceOperationLog {
    private IntelligenceOperationLog() {}
    public static void record(String action,java.util.UUID job,java.util.UUID stage,java.util.UUID event) {
        Runnable write=()->LoggerFactory.getLogger(IntelligenceOperationLog.class).atInfo()
            .addKeyValue("operation",action).addKeyValue("processingJobId",job)
            .addKeyValue("executionStageRunId",stage).addKeyValue("eventId",event)
            .log("Meeting Intelligence lifecycle");
        if(TransactionSynchronizationManager.isSynchronizationActive())
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() {write.run();}
            });
        else write.run();
    }
}
