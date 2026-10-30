package com.sme.meetingassistant.api.media;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app.media")
public class MediaProperties {
    private final Storage storage = new Storage();
    private final Upload upload = new Upload();
    private final Outbox outbox = new Outbox();
    private final Admission admission = new Admission();
    private final Processing processing = new Processing();

    public Storage getStorage() { return storage; }
    public Upload getUpload() { return upload; }
    public Outbox getOutbox() { return outbox; }
    public Admission getAdmission() { return admission; }
    public Processing getProcessing() { return processing; }

    public static class Storage {
        private String endpoint;
        private String region;
        private String bucket;
        private String accessKey;
        private String secretKey;
        private boolean pathStyleAccess = true;
        private boolean createBucketIfMissing;
        public String getEndpoint() { return endpoint; }
        public void setEndpoint(String value) { endpoint = value; }
        public String getRegion() { return region; }
        public void setRegion(String value) { region = value; }
        public String getBucket() { return bucket; }
        public void setBucket(String value) { bucket = value; }
        public String getAccessKey() { return accessKey; }
        public void setAccessKey(String value) { accessKey = value; }
        public String getSecretKey() { return secretKey; }
        public void setSecretKey(String value) { secretKey = value; }
        public boolean isPathStyleAccess() { return pathStyleAccess; }
        public void setPathStyleAccess(boolean value) { pathStyleAccess = value; }
        public boolean isCreateBucketIfMissing() { return createBucketIfMissing; }
        public void setCreateBucketIfMissing(boolean value) { createBucketIfMissing = value; }
    }

    public static class Upload {
        private List<String> allowedExtensions = new ArrayList<>();
        private List<String> allowedContentTypes = new ArrayList<>();
        private long maxSizeBytes;
        private long maxDurationMs;
        private String ffprobePath;
        private Duration probeTimeout = Duration.ofSeconds(30);
        private Duration uploadUrlTtl = Duration.ofMinutes(15);
        private Duration downloadUrlTtl = Duration.ofMinutes(5);
        public List<String> getAllowedExtensions() { return allowedExtensions; }
        public void setAllowedExtensions(List<String> value) { allowedExtensions = value; }
        public List<String> getAllowedContentTypes() { return allowedContentTypes; }
        public void setAllowedContentTypes(List<String> value) { allowedContentTypes = value; }
        public long getMaxSizeBytes() { return maxSizeBytes; }
        public void setMaxSizeBytes(long value) { maxSizeBytes = value; }
        public long getMaxDurationMs() { return maxDurationMs; }
        public void setMaxDurationMs(long value) { maxDurationMs = value; }
        public String getFfprobePath() { return ffprobePath; }
        public void setFfprobePath(String value) { ffprobePath = value; }
        public Duration getProbeTimeout() { return probeTimeout; }
        public void setProbeTimeout(Duration value) { probeTimeout = value; }
        public Duration getUploadUrlTtl() { return uploadUrlTtl; }
        public void setUploadUrlTtl(Duration value) { uploadUrlTtl = value; }
        public Duration getDownloadUrlTtl() { return downloadUrlTtl; }
        public void setDownloadUrlTtl(Duration value) { downloadUrlTtl = value; }
    }

    /**
     * Operational limits for new expensive work. One active job per meeting is
     * an invariant enforced by a database index, not a tunable rate limit.
     */
    public static class Admission {
        private int maxJobsPerWindow = 12;
        private int jobWindowMinutes = 60;
        private int maxActiveJobsPerUser = 3;
        private int maxPendingUploadsPerUser = 5;

        public int getMaxJobsPerWindow() { return maxJobsPerWindow; }
        public void setMaxJobsPerWindow(int value) { maxJobsPerWindow = value; }
        public int getJobWindowMinutes() { return jobWindowMinutes; }
        public void setJobWindowMinutes(int value) { jobWindowMinutes = value; }
        public int getMaxActiveJobsPerUser() { return maxActiveJobsPerUser; }
        public void setMaxActiveJobsPerUser(int value) { maxActiveJobsPerUser = value; }
        public int getMaxPendingUploadsPerUser() { return maxPendingUploadsPerUser; }
        public void setMaxPendingUploadsPerUser(int value) { maxPendingUploadsPerUser = value; }
    }

    public static class Outbox {
        private String exchange;
        private String routingKey;
        private long pollDelayMs = 2000;
        private int maxAttempts = 12;
        private int leaseSeconds = 60;
        private int confirmTimeoutSeconds = 10;
        public String getExchange() { return exchange; }
        public void setExchange(String value) { exchange = value; }
        public String getRoutingKey() { return routingKey; }
        public void setRoutingKey(String value) { routingKey = value; }
        public long getPollDelayMs() { return pollDelayMs; }
        public void setPollDelayMs(long value) { pollDelayMs = value; }
        public int getMaxAttempts() { return maxAttempts; }
        public void setMaxAttempts(int value) { maxAttempts = value; }
        public int getLeaseSeconds() { return leaseSeconds; }
        public void setLeaseSeconds(int value) { leaseSeconds = value; }
        public int getConfirmTimeoutSeconds() { return confirmTimeoutSeconds; }
        public void setConfirmTimeoutSeconds(int value) { confirmTimeoutSeconds = value; }
    }

    /** A value of zero disables manual retries until the deployment sets a finite policy. */
    public static class Processing {
        private int maxRetries;
        private int stageLeaseSeconds = 1800;
        public int getMaxRetries() { return maxRetries; }
        public void setMaxRetries(int value) { maxRetries = value; }
        public int getStageLeaseSeconds() { return stageLeaseSeconds; }
        public void setStageLeaseSeconds(int value) { stageLeaseSeconds = value; }
    }
}
