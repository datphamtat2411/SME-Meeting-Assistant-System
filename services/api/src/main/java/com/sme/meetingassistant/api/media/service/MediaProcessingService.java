package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.dto.CreateMediaUploadRequest;
import com.sme.meetingassistant.api.media.dto.FinalizeMediaResponse;
import com.sme.meetingassistant.api.media.dto.MediaUploadIntentResponse;
import com.sme.meetingassistant.api.media.dto.ProcessingJobResponse;
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
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import software.amazon.awssdk.services.s3.model.S3Exception;

@Service
public class MediaProcessingService {
    private static final String UPLOAD_OPERATION = "MEDIA_UPLOAD";
    private static final String JOB_OPERATION = "PROCESSING_JOB";
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
        this.meetingAccess.requireReadable(meetingId, actor);
        validateIdempotencyKey(idempotencyKey);
        String filename = sanitizeFilename(request.originalFilename());
        String extension = extension(filename);
        String contentType = request.contentType().split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        validateUploadMetadata(extension, contentType, request.expectedSizeBytes());
        String fingerprint = fingerprint(request.sourceType() + "\n" + filename + "\n" + contentType + "\n"
            + request.expectedSizeBytes());
        String operation = UPLOAD_OPERATION + ":" + meetingId;
        UUID mediaId = UUID.randomUUID();
        UUID claimedId = claimIdempotency(actor, operation, idempotencyKey, fingerprint, mediaId);
        if (!claimedId.equals(mediaId)) {
            Media prior = media(claimedId);
            if (!prior.meetingId().equals(meetingId)) throw notFound();
            return uploadResponse(prior);
        }
        String objectKey = "meetings/" + meetingId + "/source/" + mediaId;
        Media pending = new Media(mediaId, meetingId, request.sourceType().name(), "PENDING_UPLOAD", objectKey,
            filename, contentType, request.expectedSizeBytes(), null, null, null, actor,
            OffsetDateTime.now(), null, null);
        this.repository.insertMedia(pending);
        return uploadResponse(pending);
    }

    @Transactional
    public FinalizeMediaResponse finalizeUpload(UUID meetingId, UUID mediaId) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireReadable(meetingId, actor);
        Media media = media(mediaId);
        if (!media.meetingId().equals(meetingId) || !media.uploadedBy().equals(actor)) throw notFound();
        if (!"PENDING_UPLOAD".equals(media.status())) return toResponse(media);
        ObjectStorage.StoredObject stored;
        try {
            stored = this.storage.head(media.objectKey());
        } catch (S3Exception exception) {
            if (exception.statusCode() == 404) {
                this.repository.rejectMedia(mediaId, "UPLOAD_OBJECT_MISSING");
                return toResponse(media(mediaId));
            }
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Media storage is unavailable.");
        }
        if (stored.sizeBytes() <= 0 || stored.sizeBytes() != media.expectedSizeBytes()
                || stored.sizeBytes() > this.properties.getUpload().getMaxSizeBytes()) {
            this.repository.rejectMedia(mediaId, "MEDIA_SIZE_INVALID");
            return toResponse(media(mediaId));
        }
        if (stored.contentType() == null || !stored.contentType().equalsIgnoreCase(media.contentType())) {
            this.repository.rejectMedia(mediaId, "MEDIA_CONTENT_TYPE_MISMATCH");
            return toResponse(media(mediaId));
        }
        Path temporaryFile = null;
        try {
            temporaryFile = Files.createTempFile("meeting-media-", ".upload");
            this.storage.downloadTo(media.objectKey(), temporaryFile);
            MediaInspection inspection = this.inspector.inspect(temporaryFile);
            if (!inspection.hasAudio()) {
                this.repository.rejectMedia(mediaId, "MEDIA_AUDIO_TRACK_REQUIRED");
                return toResponse(media(mediaId));
            }
            if (inspection.durationMs() > this.properties.getUpload().getMaxDurationMs()) {
                this.repository.rejectMedia(mediaId, "MEDIA_DURATION_EXCEEDED");
                return toResponse(media(mediaId));
            }
            if (!detectedFormatAllowed(inspection.detectedFormat())) {
                this.repository.rejectMedia(mediaId, "MEDIA_FORMAT_UNSUPPORTED");
                return toResponse(media(mediaId));
            }
            this.repository.acceptMedia(mediaId, stored.sizeBytes(), inspection.durationMs(), sha256(temporaryFile));
            return toResponse(media(mediaId));
        } catch (IllegalArgumentException invalidMedia) {
            String code = invalidMedia.getMessage();
            if (code != null && (code.equals("MEDIA_UNREADABLE") || code.equals("MEDIA_PROBE_TIMEOUT"))) {
                this.repository.rejectMedia(mediaId, code);
                return toResponse(media(mediaId));
            }
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Media validation is unavailable.");
        } catch (S3Exception storageFailure) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Media storage is unavailable.");
        } catch (IOException exception) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Media validation is unavailable.");
        } finally {
            if (temporaryFile != null) {
                try { Files.deleteIfExists(temporaryFile); } catch (IOException ignored) { /* best-effort cleanup */ }
            }
        }
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
        this.meetingAccess.requireReadable(meetingId, actor);
        Media media = media(mediaId);
        if (!media.meetingId().equals(meetingId) || !"AVAILABLE".equals(media.status())) throw notFound();
        return this.storage.createDownloadCapability(media.objectKey(), cappedTtl(
            this.properties.getUpload().getDownloadUrlTtl(), Duration.ofMinutes(5)));
    }

    @Transactional
    public ProcessingJobResponse createJob(UUID meetingId, UUID mediaId, String idempotencyKey) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireReadable(meetingId, actor);
        validateIdempotencyKey(idempotencyKey);
        Media media = media(mediaId);
        if (!media.meetingId().equals(meetingId) || !"AVAILABLE".equals(media.status())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Only accepted meeting media can be processed.");
        }
        String operation = JOB_OPERATION + ":" + meetingId;
        String fingerprint = fingerprint(mediaId.toString());
        Job job = new Job(UUID.randomUUID(), meetingId, mediaId, "OFFLINE_MEETING_PROCESSING", "QUEUED", actor,
            null, 0, OffsetDateTime.now(), null, null, null, null, null,
            OffsetDateTime.now(), OffsetDateTime.now());
        UUID claimedId = claimIdempotency(actor, operation, idempotencyKey, fingerprint, job.id());
        if (!claimedId.equals(job.id())) return toResponse(job(claimedId));
        this.repository.insertJobAndOutbox(job, UUID.randomUUID());
        return toResponse(job(job.id()));
    }

    @Transactional(readOnly = true)
    public List<ProcessingJobResponse> listJobs(UUID meetingId) {
        UUID actor = this.authenticatedUser.requireUserId();
        this.meetingAccess.requireReadable(meetingId, actor);
        return this.repository.listJobs(meetingId).stream().map(MediaProcessingService::toResponse).toList();
    }

    @Transactional(readOnly = true)
    public ProcessingJobResponse getJob(UUID jobId) {
        UUID actor = this.authenticatedUser.requireUserId();
        Job job = job(jobId);
        this.meetingAccess.requireReadable(job.meetingId(), actor);
        return toResponse(job);
    }

    private void validateUploadMetadata(String extension, String contentType, long expectedBytes) {
        var upload = this.properties.getUpload();
        if (expectedBytes <= 0 || upload.getMaxSizeBytes() <= 0 || expectedBytes > upload.getMaxSizeBytes()) {
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
        String url = this.storage.createUploadCapability(media.objectKey(), media.contentType(),
            media.expectedSizeBytes(), ttl);
        return new MediaUploadIntentResponse(media.id(), media.status(), url, OffsetDateTime.now().plus(ttl),
            media.contentType());
    }

    private static Duration cappedTtl(Duration configured, Duration maximum) {
        if (configured == null || configured.isNegative() || configured.isZero()) return maximum;
        return configured.compareTo(maximum) > 0 ? maximum : configured;
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

    private static ProcessingJobResponse toResponse(Job job) {
        return new ProcessingJobResponse(job.id(), job.meetingId(), job.sourceMediaId(), job.jobType(), job.status(),
            job.requestedBy(), job.currentStage(), job.queuedAt(), job.startedAt(), job.completedAt(),
            job.errorCode(), job.errorSummary(), job.warningSummary(), job.createdAt(), job.updatedAt());
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
        if (key == null || key.isBlank() || key.length() > 255) {
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
