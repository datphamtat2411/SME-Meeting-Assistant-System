package com.sme.meetingassistant.api.media.worker;

import java.util.Set;

public record WorkerFailure(String code,boolean retryable) {
    public static WorkerFailure classify(WorkerCommands.Fail f,String stage) {
        String p=f.phase(),c=f.category();
        if(Set.of("CONFIGURATION","AUTHENTICATION").contains(c)) return failure("WORKER_CONFIGURATION_INVALID",false);
        if(p.equals("SOURCE_DOWNLOAD") && c.equals("NOT_FOUND")) return failure("SOURCE_MEDIA_MISSING",false);
        if(p.equals("SOURCE_DOWNLOAD") && c.equals("INTEGRITY")) return failure("SOURCE_MEDIA_INTEGRITY",false);
        if(Set.of("SOURCE_DOWNLOAD","PREPROCESSING").contains(p) && Set.of("VALIDATION","DECODING").contains(c)) return failure("SOURCE_MEDIA_INVALID",false);
        if(c.equals("VALIDATION") && Set.of("CHUNK_PLANNING","ASR","COVERAGE_RECOVERY","RECONCILIATION","CORRECTION").contains(p)
            || p.equals("PREPROCESSING") && c.equals("MALFORMED_OUTPUT")) return failure("TRANSCRIPTION_EVIDENCE_INVALID",false);
        if(p.equals("CORRECTION") && c.equals("CONTEXT_OVERFLOW")) return failure("LLM_CONTEXT_UNSUPPORTED",false);
        if(p.equals("RESULT_VALIDATION") && c.equals("EMPTY_OUTPUT")) return failure("TRANSCRIPTION_EMPTY",false);
        if(p.equals("PUBLICATION") && c.equals("NOT_FOUND") && stage.equals("FINALIZING_TRANSCRIPT")) return failure("TRANSCRIPT_RESULT_MISSING",true);
        if(Set.of("RESULT_VALIDATION","RESULT_STORAGE").contains(p) && Set.of("VALIDATION","MALFORMED_OUTPUT","SUSPICIOUS_OUTPUT","INTEGRITY").contains(c)) return failure("TRANSCRIPT_RESULT_INVALID",false);
        if(p.equals("INTERRUPTED") || c.equals("CANCELLED")) return failure("WORKER_INTERRUPTED",true);
        if(p.equals("CORRECTION")) return failure("LLM_CORRECTION_FAILED",true);
        if(p.equals("ASR") && Set.of("PROVIDER","MALFORMED_OUTPUT","SUSPICIOUS_OUTPUT","EMPTY_OUTPUT").contains(c)) return failure("ASR_FAILED",true);
        if(Set.of("TRANSPORT","TIMEOUT","RESOURCE","PROVIDER","RATE_LIMIT").contains(c)) return failure("TRANSCRIPTION_TEMPORARY",true);
        throw new WorkerException(422,"VALIDATION_ERROR");
    }
    private static WorkerFailure failure(String code,boolean retryable) { return new WorkerFailure(code,retryable); }
}
