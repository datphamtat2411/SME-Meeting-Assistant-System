package com.sme.meetingassistant.api.media.worker;

/** Safe protocol classification: never carries input, object keys, text or causes. */
public final class WorkerException extends RuntimeException {
    private final int status;
    private final String code;
    public WorkerException(int status, String code) { super(code); this.status = status; this.code = code; }
    public int status() { return status; }
    public String code() { return code; }
    public static WorkerException invalid() { return new WorkerException(422, "TRANSCRIPT_RESULT_INVALID"); }
    public static WorkerException conflict(String code) { return new WorkerException(409, code); }
}
