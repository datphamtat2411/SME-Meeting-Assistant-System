package com.sme.meetingassistant.api.media.diarization;

import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.services.s3.model.S3Exception;

/** Storage I/O never runs inside a database transaction or while canonical locks are held. */
@Service
public class DiarizationCompletion {
    private final DiarizationWorkerService worker;
    private final ObjectStorage storage;
    public DiarizationCompletion(DiarizationWorkerService worker,ObjectStorage storage) {this.worker=worker;this.storage=storage;}
    public Map<String,Object> complete(UUID job,DiarizationCommands.Complete cmd) {
        if(TransactionSynchronizationManager.isActualTransactionActive()) throw new IllegalStateException("Result verification requires no transaction.");
        try {return completeResult(job,cmd);}
        catch(WorkerException conflict) {
            // Another identical completion can commit between our short database transactions.
            // Only the existing authenticated, digest-bound accepted replay may recover that race.
            if(conflict.status()==409) {
                try {
                    var replay=worker.completionReplay(job,cmd);
                    if(replay!=null && "RESULT_ACCEPTED".equals(replay.get("state"))) return replay;
                } catch(WorkerException rejectedReplay) { /* Preserve the original sanitized conflict. */ }
            }
            throw conflict;
        }
    }
    private Map<String,Object> completeResult(UUID job,DiarizationCommands.Complete cmd) {
        var replay=worker.completionReplay(job,cmd);if(replay!=null) return replay;
        var context=worker.completionContext(job,cmd);byte[] bytes;
        String key=DiarizationWorkerRepository.resultKey(job,cmd.resultProducerStageRunId());
        try {
            var head=storage.head(key);
            if(head.sizeBytes()<1 || head.sizeBytes()>DiarizationResultContract.MAX_RESULT_BYTES) throw invalid();
            bytes=storage.readBounded(key,DiarizationResultContract.MAX_RESULT_BYTES);
            if(bytes==null || bytes.length!=head.sizeBytes()) throw invalid();
        } catch(S3Exception error) {
            throw new WorkerException(error.statusCode()==404?422:503,error.statusCode()==404?"DIARIZATION_RESULT_MISSING":"SERVICE_UNAVAILABLE");
        } catch(IOException | SdkException error) {throw new WorkerException(503,"SERVICE_UNAVAILABLE");}
        DiarizationResultContract.ValidatedResult result;
        try {result=DiarizationResultContract.validate(bytes,context,cmd.resultSha256());}
        catch(IllegalArgumentException invalid) {throw invalid();}
        worker.registerVerified(job,cmd,bytes.length);
        return worker.projectVerified(job,cmd,result);
    }
    private static WorkerException invalid() {return new WorkerException(422,"DIARIZATION_RESULT_INVALID");}
}
