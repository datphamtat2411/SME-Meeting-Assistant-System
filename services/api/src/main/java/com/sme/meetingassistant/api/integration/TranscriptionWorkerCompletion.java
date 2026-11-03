package com.sme.meetingassistant.api.integration;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.worker.*;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.services.s3.model.S3Exception;

/** S3 verification precedes canonical locks. Only the local projection transaction publishes. */
@Service
public class TranscriptionWorkerCompletion {
    private final TranscriptionWorkerService worker;
    private final ObjectStorage storage;
    private final TranscriptFinalizationService finalization;
    private final TransactionTemplate transactions;
    public TranscriptionWorkerCompletion(TranscriptionWorkerService worker,ObjectStorage storage,
            TranscriptFinalizationService finalization,TransactionTemplate transactions) {
        this.worker=worker; this.storage=storage; this.finalization=finalization; this.transactions=transactions;
    }
    public Map<String,Object> complete(UUID job,WorkerCommands.Complete cmd) {
        try { return completeNew(job,cmd); }
        catch(WorkerException e) {
            if(e.code().equals("WORKER_LEASE_LOST")) {
                var replay=worker.completionReplay(job,cmd); if(replay!=null) return replay;
            }
            throw e;
        }
    }
    private Map<String,Object> completeNew(UUID job,WorkerCommands.Complete cmd) {
        if(TransactionSynchronizationManager.isActualTransactionActive()) throw new IllegalStateException("Result verification requires no transaction.");
        var replay=worker.completionReplay(job,cmd); if(replay!=null) return replay;
        var delivery=worker.delivery(job,cmd.owner().eventId()); var claim=worker.completionSource(job,cmd);
        byte[] bytes;
        try {
            String key=TranscriptionWorkerRepository.resultKey(job,cmd.resultProducerStageRunId());
            var head=storage.head(key);
            if(head.sizeBytes()<1 || head.sizeBytes()>CorrectedTranscript.MAX_BYTES) throw new WorkerException(413,"TRANSCRIPT_RESULT_INVALID");
            bytes=storage.readBounded(key,CorrectedTranscript.MAX_BYTES);
            if(bytes==null || bytes.length!=head.sizeBytes()) throw WorkerException.invalid();
        } catch(S3Exception e) {
            throw new WorkerException(e.statusCode()==404?422:503,e.statusCode()==404?"TRANSCRIPT_RESULT_MISSING":"SERVICE_UNAVAILABLE");
        } catch(IOException | SdkException e) { throw new WorkerException(503,"SERVICE_UNAVAILABLE"); }
        var result=CorrectedTranscript.validate(bytes,job,delivery.mediaId(),claim.source().get("sourceRevision").asString(),cmd.resultProducerStageRunId(),cmd.resultSha256());
        // Register a verified protected reference so a publication failure can reuse exactly these bytes.
        worker.registerVerified(job,cmd,result,bytes.length);
        return transactions.execute(tx->{
            finalization.lockMeeting(delivery.meetingId());
            // project takes the job lock; replay must be checked under that same serialization boundary.
            var finalizer=worker.projectOrReplay(job,cmd,result);
            if(finalizer==null) return worker.completionReplay(job,cmd);
            finalization.finalizeTranscript(finalizer,result.mapping(delivery.meetingId(),finalizer.stageRunId()));
            return worker.accept(job,cmd,finalization.publicationId(job),result.status().name());
        });
    }
}
