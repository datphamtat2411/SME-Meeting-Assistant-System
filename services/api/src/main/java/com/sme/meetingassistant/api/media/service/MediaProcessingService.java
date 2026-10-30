package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.dto.CreateMediaUploadRequest;
import com.sme.meetingassistant.api.media.dto.FinalizeMediaResponse;
import com.sme.meetingassistant.api.media.dto.MediaUploadIntentResponse;
import com.sme.meetingassistant.api.media.dto.ProcessingJobResponse;
import com.sme.meetingassistant.api.media.dto.RetryProcessingJobRequest;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Job;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Media;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.validation.MediaInspection;
import com.sme.meetingassistant.api.media.validation.MediaInspector;
import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpHeaders;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.core.exception.SdkException;

@Service
public class MediaProcessingService {
    private static final String UPLOAD_OPERATION = "MEDIA_UPLOAD";
    private static final String JOB_OPERATION = "PROCESSING_JOB";
    private static final long FINALIZATION_LEASE_SECONDS = 30 * 60;
    private static final long PENDING_RETENTION_SECONDS = 24 * 60 * 60;
    private final MediaRepository repository;
    private final ObjectStorage storage;
    private final MediaInspector inspector;
    private final MeetingMediaAccess meetingAccess;
    private final AuthenticatedUserId authenticatedUser;
    private final MediaProperties properties;

    public MediaProcessingService(MediaRepository repository, ObjectStorage storage, MediaInspector inspector,
            MeetingMediaAccess meetingAccess, AuthenticatedUserId authenticatedUser, MediaProperties properties) {
        this.repository = repository;
        this.storage = storage;
        this.inspector = inspector;
        this.meetingAccess = meetingAccess;
        this.authenticatedUser = authenticatedUser;
        this.properties = properties;
    }

    @Transactional
    public MediaUploadIntentResponse createUploadIntent(UUID meetingId, CreateMediaUploadRequest request,
            String idempotencyKey) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireUploadAllowed(meetingId, actor);
        validateIdempotencyKey(idempotencyKey);
        String filename = sanitizeFilename(request.originalFilename());
        String extension = extension(filename);
        String contentType = request.contentType().split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        validateUploadMetadata(extension, contentType, request.expectedSizeBytes());
        String fingerprint = fingerprint(request.sourceType() + "\n" + filename + "\n" + contentType + "\n"
            + request.expectedSizeBytes());
        String operation = UPLOAD_OPERATION + ":" + meetingId;
        UUID mediaId = UUID.randomUUID();
        // Lock before inserting the FK-backed idempotency record; otherwise
        // two concurrent requests can deadlock while upgrading user row locks.
        this.repository.lockAdmissionUser(actor);
        UUID claimedId = claimIdempotency(actor, operation, idempotencyKey, fingerprint, mediaId);
        if (!claimedId.equals(mediaId)) {
            Media prior = media(claimedId);
            if (!prior.meetingId().equals(meetingId)) throw notFound();
            return uploadResponse(prior);
        }
        int uploadLimit = positiveLimit(this.properties.getAdmission().getMaxPendingUploadsPerUser(),
            "max-pending-uploads-per-user");
        if (this.repository.pendingUploadIntentsForUser(actor) >= uploadLimit) {
            throw rateLimited("Too many outstanding upload intents.", 0);
        }
        String objectKey = "meetings/" + meetingId + "/pending/" + mediaId;
        Media pending = new Media(mediaId, meetingId, request.sourceType().name(), "PENDING_UPLOAD", objectKey,
            filename, contentType, request.expectedSizeBytes(), null, null, null, actor,
            OffsetDateTime.now(), null, null);
        this.repository.insertMedia(pending);
        return uploadResponse(pending);
    }

    /**
     * S3 I/O and ffprobe run outside a database transaction. A short DB lease
     * fences competing finalizers; the accepted key is never client-writable.
     */
    public FinalizeMediaResponse finalizeUpload(UUID meetingId, UUID mediaId) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireUploadAllowed(meetingId, actor);
        Media current = media(mediaId);
        if (!current.meetingId().equals(meetingId) || !current.uploadedBy().equals(actor)) throw notFound();
        if (!"PENDING_UPLOAD".equals(current.status())) return toResponse(current);

        UUID leaseToken = UUID.randomUUID();
        if (!this.repository.claimFinalization(mediaId, leaseToken, FINALIZATION_LEASE_SECONDS)) {
            Media fresh = media(mediaId);
            if ("AVAILABLE".equals(fresh.status())) return toResponse(fresh);
            throw conflict("Media finalization is already in progress or no longer allowed.");
        }

        String acceptedKey = acceptedKey(meetingId, mediaId);
        try {
            ValidatedSource validated = acceptedObjectExists(acceptedKey)
                ? inspectAcceptedObject(acceptedKey, current.expectedSizeBytes())
                : validateAndPromote(current, acceptedKey);
            // Reauthorize after slow storage/probing I/O: account and meeting state can change.
            this.meetingAccess.requireUploadAllowed(meetingId, actor);
            if (!this.repository.acceptMedia(mediaId, leaseToken, acceptedKey,
                    validated.sizeBytes(), validated.durationMs(), validated.sha256())) {
                throw conflict("Media finalization lease expired; retry the request.");
            }
            return toResponse(media(mediaId));
        } catch (InvalidMediaException rejected) {
            this.meetingAccess.requireUploadAllowed(meetingId, actor);
            if (!this.repository.rejectMedia(mediaId, leaseToken, rejected.code())) {
                throw conflict("Media finalization lease expired; retry the request.");
            }
            return toResponse(media(mediaId));
        } catch (SdkException storageFailure) {
            throw storageUnavailable();
        } finally {
            this.repository.releaseFinalization(mediaId, leaseToken);
        }
    }

    private ValidatedSource validateAndPromote(Media media, String acceptedKey) {
        ObjectStorage.StoredObject pending;
        try {
            pending = this.storage.head(media.objectKey());
        } catch (S3Exception failure) {
            if (failure.statusCode() == 404) {
                throw conflict("Upload object is not yet available for finalization.");
            }
            throw failure;
        }
        if (pending.sizeBytes() <= 0 || pending.sizeBytes() != media.expectedSizeBytes()
                || pending.sizeBytes() > this.properties.getUpload().getMaxSizeBytes()) {
            throw new InvalidMediaException("MEDIA_SIZE_INVALID");
        }
        if (pending.contentType() == null || !pending.contentType().equalsIgnoreCase(media.contentType())) {
            throw new InvalidMediaException("MEDIA_CONTENT_TYPE_MISMATCH");
        }

        Path snapshot = null;
        try {
            snapshot = Files.createTempFile("meeting-media-", ".upload");
            this.storage.downloadTo(media.objectKey(), snapshot);
            // Pending bytes may change after HEAD via a still-valid signed PUT.
            ValidatedSource source = inspectSnapshot(snapshot, media.expectedSizeBytes());
            if (!this.storage.putAcceptedIfAbsent(acceptedKey, snapshot, source.sha256())) {
                // A previous finalized snapshot won the create-only PUT.
                return inspectAcceptedObject(acceptedKey, media.expectedSizeBytes());
            }
            ObjectStorage.StoredObject accepted = this.storage.head(acceptedKey);
            if (accepted.sizeBytes() != source.sizeBytes()) {
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Accepted media verification failed.");
            }
            return source;
        } catch (IOException failure) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Media validation is unavailable.");
        } finally {
            removeTemporaryFile(snapshot);
        }
    }

    private boolean acceptedObjectExists(String acceptedKey) {
        try {
            this.storage.head(acceptedKey);
            return true;
        } catch (S3Exception failure) {
            if (failure.statusCode() == 404) return false;
            throw failure;
        }
    }

    private ValidatedSource inspectAcceptedObject(String acceptedKey, long expectedBytes) {
        Path snapshot = null;
        try {
            snapshot = Files.createTempFile("meeting-media-accepted-", ".upload");
            this.storage.downloadTo(acceptedKey, snapshot);
            return inspectSnapshot(snapshot, expectedBytes);
        } catch (IOException failure) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Accepted media verification is unavailable.");
        } finally {
            removeTemporaryFile(snapshot);
        }
    }

    private ValidatedSource inspectSnapshot(Path snapshot, long expectedBytes) throws IOException {
        long actualBytes = Files.size(snapshot);
        if (actualBytes <= 0 || actualBytes != expectedBytes
                || actualBytes > this.properties.getUpload().getMaxSizeBytes()) {
            throw new InvalidMediaException("MEDIA_SIZE_INVALID");
        }
        MediaInspection inspection;
        try {
            inspection = this.inspector.inspect(snapshot);
        } catch (IllegalArgumentException failure) {
            if ("MEDIA_UNREADABLE".equals(failure.getMessage())) {
                throw new InvalidMediaException("MEDIA_UNREADABLE");
            }
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Media validation is unavailable.");
        }
        if (!inspection.hasAudio()) throw new InvalidMediaException("MEDIA_AUDIO_TRACK_REQUIRED");
        if (inspection.durationMs() <= 0 || inspection.durationMs() > this.properties.getUpload().getMaxDurationMs()) {
            throw new InvalidMediaException("MEDIA_DURATION_EXCEEDED");
        }
        if (!detectedFormatAllowed(inspection.detectedFormat())) {
            throw new InvalidMediaException("MEDIA_FORMAT_UNSUPPORTED");
        }
        return new ValidatedSource(actualBytes, inspection.durationMs(), sha256(snapshot));
    }

    private static String acceptedKey(UUID meetingId, UUID mediaId) {
        return "meetings/" + meetingId + "/sources/" + mediaId;
    }

    private static void removeTemporaryFile(Path path) {
        if (path != null) {
            try { Files.deleteIfExists(path); } catch (IOException ignored) { /* best effort */ }
        }
    }

    /** Clean only pending keys, long after any presigned PUT capability has expired. */
    @Scheduled(fixedDelayString = "${app.media.upload.cleanup-delay-ms:3600000}")
    public void cleanupStalePendingUploads() {
        this.repository.expireOldUploads(PENDING_RETENTION_SECONDS, 25);
        for (MediaRepository.PendingCleanup candidate :
                this.repository.pendingCleanupCandidates(PENDING_RETENTION_SECONDS, 25)) {
            try {
                this.storage.delete(candidate.pendingObjectKey());
                this.repository.markPendingCleaned(candidate.id(), candidate.pendingObjectKey());
            } catch (RuntimeException storageOrDatabaseFailure) {
                // A later sweep retries; accepted source keys are never deleted here.
            }
        }
    }

    private record ValidatedSource(long sizeBytes, long durationMs, String sha256) { }

    private static final class InvalidMediaException extends RuntimeException {
        private final String code;
        private InvalidMediaException(String code) { super(code); this.code = code; }
        private String code() { return code; }
    }

    private static int positiveLimit(int value, String property) {
        if (value <= 0) throw new IllegalStateException("Invalid media admission configuration: " + property);
        return value;
    }

    private static ResponseStatusException rateLimited(String reason, long retryAfterSeconds) {
        // ResponseStatusException's default headers are read-only in Spring 7.
        return new AdmissionRateLimitException(reason, retryAfterSeconds);
    }

    private static final class AdmissionRateLimitException extends ResponseStatusException {
        private final HttpHeaders headers = new HttpHeaders();

        private AdmissionRateLimitException(String reason, long retryAfterSeconds) {
            super(HttpStatus.TOO_MANY_REQUESTS, reason);
            if (retryAfterSeconds > 0) {
                this.headers.set(HttpHeaders.RETRY_AFTER, Long.toString(retryAfterSeconds));
            }
        }

        @Override
        public HttpHeaders getHeaders() { return this.headers; }
    }

    private static ResponseStatusException conflict(String message) {
        return new ResponseStatusException(HttpStatus.CONFLICT, message);
    }

    @Transactional(readOnly = true)
    public List<FinalizeMediaResponse> listMedia(UUID meetingId) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireReadable(meetingId, actor);
        return this.repository.listMedia(meetingId).stream().map(MediaProcessingService::toResponse).toList();
    }

    @Transactional(readOnly = true)
    public FinalizeMediaResponse getMedia(UUID meetingId, UUID mediaId) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireReadable(meetingId, actor);
        Media media = media(mediaId);
        if (!media.meetingId().equals(meetingId)) throw notFound();
        return toResponse(media);
    }

    @Transactional(readOnly = true)
    public String mediaAccessUrl(UUID meetingId, UUID mediaId) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireSourceReadable(meetingId, actor);
        Media media = media(mediaId);
        if (!media.meetingId().equals(meetingId) || !"AVAILABLE".equals(media.status())) throw notFound();
        try {
            return this.storage.createDownloadCapability(media.objectKey(), cappedTtl(
                this.properties.getUpload().getDownloadUrlTtl(), Duration.ofMinutes(5)));
        } catch (SdkException storageFailure) {
            throw storageUnavailable();
        }
    }

    @Transactional
    public ProcessingJobResponse createJob(UUID meetingId, UUID mediaId, String idempotencyKey) {
        return createJob(meetingId, mediaId, null, idempotencyKey);
    }

    @Transactional
    public ProcessingJobResponse createJob(UUID meetingId, UUID mediaId, UUID reprocessOfJobId,
            String idempotencyKey) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireProcessingAllowed(meetingId, actor);
        validateIdempotencyKey(idempotencyKey);
        Media media = media(mediaId);
        if (!media.meetingId().equals(meetingId) || !"AVAILABLE".equals(media.status())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Only accepted meeting media can be processed.");
        }
        String operation = JOB_OPERATION + ":" + meetingId;
        Job parent = null;
        if (reprocessOfJobId != null) {
            parent = job(reprocessOfJobId);
            if (!parent.meetingId().equals(meetingId) || !parent.sourceMediaId().equals(mediaId)
                    || !List.of("COMPLETED", "COMPLETED_WITH_WARNINGS", "FAILED").contains(parent.status())) {
                throw conflict("Reprocessing must reference a terminal job for the same meeting and source media.");
            }
        }
        String fingerprint = fingerprint(mediaId + "\n" + reprocessOfJobId);
        Job job = new Job(UUID.randomUUID(), meetingId, mediaId, "OFFLINE_MEETING_PROCESSING", "PENDING", actor,
            null, 0, null, null, null, null, null, null,
            OffsetDateTime.now(), OffsetDateTime.now(), reprocessOfJobId, false);
        // Every admission takes the same row lock before inserting idempotency.
        this.repository.lockAdmissionUser(actor);
        UUID claimedId = claimIdempotency(actor, operation, idempotencyKey, fingerprint, job.id());
        if (!claimedId.equals(job.id())) return toResponse(job(claimedId));

        // The user lock remains held through all counts, job and outbox inserts
        // in this @Transactional PostgreSQL transaction.
        if (this.repository.activeJobsForMeeting(meetingId) > 0) {
            throw conflict("Another processing job is already active for this meeting.");
        }
        if (reprocessOfJobId == null && this.repository.initialJobsForSource(mediaId) > 0) {
            throw conflict("This source has already been submitted for processing.");
        }
        int activeLimit = positiveLimit(this.properties.getAdmission().getMaxActiveJobsPerUser(),
            "max-active-jobs-per-user");
        if (this.repository.activeJobsForUser(actor) >= activeLimit) {
            throw rateLimited("Too many active processing jobs.", 0);
        }

        int windowMinutes = positiveLimit(this.properties.getAdmission().getJobWindowMinutes(),
            "job-window-minutes");
        int hourlyLimit = positiveLimit(this.properties.getAdmission().getMaxJobsPerWindow(),
            "max-jobs-per-window");
        MediaRepository.RecentJobAdmissions usage = this.repository.recentJobAdmissions(actor, windowMinutes);
        if (usage.count() >= hourlyLimit) {
            throw rateLimited("Processing job admission quota exceeded.", usage.retryAfterSeconds());
        }

        try {
            this.repository.insertJobAndOutbox(job, UUID.randomUUID());
        } catch (MediaRepository.JobAdmissionConflictException concurrentAdmission) {
            // Unique indexes remain authoritative if a second API instance races.
            throw conflict("Another processing job already occupies the meeting or source.");
        }
        return toResponse(job(job.id()));
    }

    @Transactional(readOnly = true)
    public List<ProcessingJobResponse> listJobs(UUID meetingId) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireReadable(meetingId, actor);
        return this.repository.listJobs(meetingId).stream().map(this::toResponse).toList();
    }

    @Transactional(readOnly = true)
    public ProcessingJobResponse getJob(UUID jobId) {
        UUID actor = this.authenticatedUser.requireUserId();
        Job job = job(jobId);
        this.meetingAccess.requireReadable(job.meetingId(), actor);
        return toResponse(job);
    }

    @Transactional
    public ProcessingJobResponse retryJob(UUID jobId, String idempotencyKey, RetryProcessingJobRequest request) {
        UUID actor = this.authenticatedUser.requireUserId();
        Job target = job(jobId);
        this.meetingAccess.requireProcessingAllowed(target.meetingId(), actor);
        validateIdempotencyKey(idempotencyKey);
        String stageCode = request == null ? null : request.stageCode();
        String operation = "PROCESSING_JOB_RETRY:" + jobId;
        String fingerprint = fingerprint(stageCode == null ? "JOB" : "STAGE\n" + stageCode);
        this.repository.lockAdmissionUser(actor);
        var claim = this.repository.claimIdempotencyWithStatus(actor, operation, idempotencyKey,
            fingerprint, jobId);
        if (!claim.claimed()) return toResponse(job(jobId));
        if (!"FAILED".equals(target.status())) throw conflict("Only failed processing jobs can be retried.");
        int maxRetries = this.properties.getProcessing().getMaxRetries();
        if (maxRetries < 0) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Processing retry policy is invalid.");
        }
        if (target.retryCount() >= maxRetries) {
            throw conflict("Processing retry limit has been reached or retries are disabled.");
        }
        if (stageCode == null && !target.retryable()) {
            throw conflict("This processing job is not eligible for retry.");
        }
        if (stageCode != null && !this.repository.hasRetryableFailedStage(jobId, stageCode)) {
            throw conflict("The requested stage has no retryable failed attempt.");
        }
        if (!this.repository.retryJobAndOutbox(target, UUID.randomUUID(), stageCode, maxRetries)) {
            throw conflict("The processing job changed or reached its retry limit.");
        }
        return toResponse(job(jobId));
    }

    private void validateUploadMetadata(String extension, String contentType, long expectedBytes) {
        var upload = this.properties.getUpload();
        if (upload.getMaxSizeBytes() <= 0 || upload.getMaxDurationMs() <= 0
                || upload.getAllowedExtensions() == null || upload.getAllowedExtensions().isEmpty()
                || upload.getAllowedContentTypes() == null || upload.getAllowedContentTypes().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Media uploads are not configured.");
        }
        if (expectedBytes <= 0 || expectedBytes > upload.getMaxSizeBytes()) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "Media size exceeds the configured limit.");
        }
        if (upload.getAllowedExtensions().stream().map(MediaProcessingService::normalizeExtension)
                .noneMatch(extension::equals)
                || upload.getAllowedContentTypes().stream().map(v -> v.toLowerCase(Locale.ROOT))
                    .noneMatch(contentType::equals)) {
            throw new ResponseStatusException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "Media type is not supported.");
        }
    }

    private boolean detectedFormatAllowed(String ffprobeFormats) {
        List<String> allowed = this.properties.getUpload().getAllowedExtensions().stream()
            .map(MediaProcessingService::normalizeExtension).toList();
        return java.util.Arrays.stream(ffprobeFormats.toLowerCase(Locale.ROOT).split(","))
            .map(MediaProcessingService::normalizeExtension).anyMatch(allowed::contains);
    }

    private MediaUploadIntentResponse uploadResponse(Media media) {
        if (!"PENDING_UPLOAD".equals(media.status())) {
            return new MediaUploadIntentResponse(media.id(), media.status(), null, null, media.contentType());
        }
        Duration ttl = cappedTtl(this.properties.getUpload().getUploadUrlTtl(), Duration.ofMinutes(15));
        String url;
        try {
            url = this.storage.createUploadCapability(media.objectKey(), media.contentType(),
                media.expectedSizeBytes(), ttl);
        } catch (SdkException storageFailure) {
            throw storageUnavailable();
        }
        return new MediaUploadIntentResponse(media.id(), media.status(), url, OffsetDateTime.now().plus(ttl),
            media.contentType());
    }

    private static Duration cappedTtl(Duration configured, Duration maximum) {
        if (configured == null || configured.isNegative() || configured.isZero()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Media URL signing is not configured.");
        }
        return configured.compareTo(maximum) > 0 ? maximum : configured;
    }

    private static ResponseStatusException storageUnavailable() {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
            "Media storage is unavailable.");
    }

    private Media media(UUID id) {
        return this.repository.findMedia(id).orElseThrow(MediaProcessingService::notFound);
    }

    private Job job(UUID id) {
        return this.repository.findJob(id).orElseThrow(MediaProcessingService::notFound);
    }

    private static FinalizeMediaResponse toResponse(Media media) {
        return new FinalizeMediaResponse(media.id(), media.meetingId(), media.sourceType(), media.status(),
            media.originalFilename(), media.contentType(), media.sizeBytes(), media.durationMs(), media.sha256(),
            media.createdAt(), media.availableAt(), media.failureCode());
    }

    private ProcessingJobResponse toResponse(Job job) {
        return new ProcessingJobResponse(job.id(), job.meetingId(), job.sourceMediaId(), job.jobType(), job.status(),
            job.requestedBy(), job.currentStage(), job.queuedAt(), job.startedAt(), job.completedAt(),
            job.errorCode(), job.errorSummary(), job.warningSummary(), job.createdAt(), job.updatedAt(),
            job.reprocessOfJobId(), job.retryable(), job.retryCount(), this.repository.listStageRuns(job.id()));
    }

    private static String sanitizeFilename(String filename) {
        String normalized = filename.replace('\\', '/');
        String basename = normalized.substring(normalized.lastIndexOf('/') + 1)
            .replaceAll("[\\p{Cntrl}]", "").trim();
        if (basename.isBlank() || basename.length() > 512) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid media filename.");
        }
        return basename;
    }

    private static String extension(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot < 0 ? "" : normalizeExtension(filename.substring(dot + 1));
    }

    private static String normalizeExtension(String extension) {
        String value = extension.trim().toLowerCase(Locale.ROOT);
        return value.startsWith(".") ? value.substring(1) : value;
    }

    private static void validateIdempotencyKey(String key) {
        if (key == null || key.isBlank() || key.length() > 255
                || !key.equals(key.strip()) || key.chars().anyMatch(Character::isISOControl)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A valid Idempotency-Key is required.");
        }
    }

    private static String fingerprint(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private UUID claimIdempotency(UUID actor, String operation, String key, String fingerprint, UUID resourceId) {
        try {
            return this.repository.claimIdempotency(actor, operation, key, fingerprint, resourceId);
        } catch (MediaRepository.IdempotencyConflictException conflict) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "The Idempotency-Key was already used for a different request.");
        }
    }

    private static String sha256(Path path) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (var stream = Files.newInputStream(path)) {
                byte[] buffer = new byte[64 * 1024];
                for (int read; (read = stream.read(buffer)) >= 0;) digest.update(buffer, 0, read);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND);
    }
}
