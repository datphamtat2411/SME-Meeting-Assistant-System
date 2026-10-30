package com.sme.meetingassistant.api.media;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import org.springframework.http.HttpStatus;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sme.meetingassistant.api.media.dto.CreateMediaUploadRequest;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Job;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Media;
import com.sme.meetingassistant.api.media.service.MediaProcessingService;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.validation.MediaInspection;
import com.sme.meetingassistant.api.media.validation.MediaInspector;
import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.time.OffsetDateTime;
import java.nio.file.Files;
import org.mockito.ArgumentCaptor;
import software.amazon.awssdk.services.s3.model.S3Exception;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.server.ResponseStatusException;

@ExtendWith(MockitoExtension.class)
class MediaProcessingServiceTests {
    private final UUID actor = UUID.randomUUID();
    private final UUID meetingId = UUID.randomUUID();
    private MediaProperties properties;
    @Mock private MediaRepository repository;
    @Mock private ObjectStorage storage;
    @Mock private MediaInspector inspector;
    @Mock private MeetingMediaAccess meetingAccess;
    @Mock private AuthenticatedUserId authenticatedUser;
    private MediaProcessingService service;

    @BeforeEach
    void setUp() {
        this.properties = new MediaProperties();
        this.properties.getUpload().setAllowedExtensions(List.of("wav"));
        this.properties.getUpload().setAllowedContentTypes(List.of("audio/wav"));
        this.properties.getUpload().setMaxSizeBytes(1024 * 1024);
        this.properties.getUpload().setMaxDurationMs(60_000);
        this.properties.getUpload().setFfprobePath("ffprobe");
        when(this.authenticatedUser.requireUserId()).thenReturn(this.actor);
        this.service = new MediaProcessingService(this.repository, this.storage, this.inspector,
            this.meetingAccess, this.authenticatedUser, this.properties);
    }

    @Test
    void createsPendingUploadAndReturnsShortLivedCapability() {
        when(this.repository.claimIdempotency(any(), anyString(), anyString(), anyString(), any(UUID.class)))
            .thenAnswer(invocation -> invocation.getArgument(4));
        when(this.storage.createUploadCapability(anyString(), anyString(),
                org.mockito.ArgumentMatchers.anyLong(), any())).thenReturn("https://storage.test/signed");

        var result = this.service.createUploadIntent(this.meetingId,
            new CreateMediaUploadRequest(CreateMediaUploadRequest.SourceType.UPLOAD,
                "C:\\temp\\meeting.wav", "audio/wav", 512L), "upload-once");

        assertEquals("PENDING_UPLOAD", result.status());
        assertEquals("https://storage.test/signed", result.uploadUrl());
        assertEquals("audio/wav", result.requiredContentType());
        ArgumentCaptor<Media> uploaded = ArgumentCaptor.forClass(Media.class);
        assertNotNull(result.expiresAt());
        verify(this.meetingAccess).requireUploadAllowed(this.meetingId, this.actor);
        verify(this.repository).insertMedia(uploaded.capture());
        assertTrue(uploaded.getValue().objectKey().contains("/pending/"));
    }

    @Test
    void uploadPermissionIsCheckedBeforeAnyIdempotencyOrMediaWrite() {
        doThrow(new ResponseStatusException(HttpStatus.NOT_FOUND))
            .when(this.meetingAccess).requireUploadAllowed(this.meetingId, this.actor);
        ResponseStatusException denied = assertThrows(ResponseStatusException.class, () ->
            this.service.createUploadIntent(this.meetingId,
                new CreateMediaUploadRequest(CreateMediaUploadRequest.SourceType.UPLOAD,
                    "recording.wav", "audio/wav", 512L), "upload-key"));
        assertEquals(404, denied.getStatusCode().value());
        verify(this.repository, never()).claimIdempotency(any(), anyString(), anyString(),
            anyString(), any(UUID.class));
        verify(this.repository, never()).insertMedia(any(Media.class));
        verify(this.storage, never()).createUploadCapability(anyString(), anyString(),
            org.mockito.ArgumentMatchers.anyLong(), any());
    }

    @Test
    void processingPermissionIsCheckedBeforeJobOrIdempotencyLookup() {
        doThrow(new ResponseStatusException(HttpStatus.NOT_FOUND))
            .when(this.meetingAccess).requireProcessingAllowed(this.meetingId, this.actor);
        ResponseStatusException denied = assertThrows(ResponseStatusException.class, () ->
            this.service.createJob(this.meetingId, UUID.randomUUID(), "job-key"));
        assertEquals(404, denied.getStatusCode().value());
        verify(this.repository, never()).findMedia(any(UUID.class));
        verify(this.repository, never()).insertJobAndOutbox(any(Job.class), any(UUID.class));
    }

    @Test
    void sourcePermissionIsCheckedBeforeSignedDownloadCapability() {
        UUID mediaId = UUID.randomUUID();
        doThrow(new ResponseStatusException(HttpStatus.NOT_FOUND))
            .when(this.meetingAccess).requireSourceReadable(this.meetingId, this.actor);
        ResponseStatusException denied = assertThrows(ResponseStatusException.class, () ->
            this.service.mediaAccessUrl(this.meetingId, mediaId));
        assertEquals(404, denied.getStatusCode().value());
        verify(this.repository, never()).findMedia(mediaId);
        verify(this.storage, never()).createDownloadCapability(anyString(), any());
    }

    @Test
    void finalizePermissionIsCheckedBeforeClaimOrStorageRead() {
        UUID mediaId = UUID.randomUUID();
        doThrow(new ResponseStatusException(HttpStatus.NOT_FOUND))
            .when(this.meetingAccess).requireUploadAllowed(this.meetingId, this.actor);
        ResponseStatusException denied = assertThrows(ResponseStatusException.class, () ->
            this.service.finalizeUpload(this.meetingId, mediaId));
        assertEquals(404, denied.getStatusCode().value());
        verify(this.repository, never()).claimFinalization(any(UUID.class), any(UUID.class),
            org.mockito.ArgumentMatchers.anyLong());
        verify(this.storage, never()).head(anyString());
    }

    @Test
    void rejectsIdempotencyKeyReuseForDifferentRequest() {
        when(this.repository.claimIdempotency(any(), anyString(), anyString(), anyString(), any(UUID.class)))
            .thenThrow(new MediaRepository.IdempotencyConflictException());

        ResponseStatusException error = assertThrows(ResponseStatusException.class, () ->
            this.service.createUploadIntent(this.meetingId,
                new CreateMediaUploadRequest(CreateMediaUploadRequest.SourceType.UPLOAD,
                    "meeting.wav", "audio/wav", 512L), "reused-key"));

        assertEquals(409, error.getStatusCode().value());
        verify(this.repository, never()).insertMedia(any(Media.class));
    }

    @Test
    void rejectedMediaCannotAdmitProcessingJob() {
        UUID mediaId = UUID.randomUUID();
        when(this.repository.findMedia(mediaId)).thenReturn(Optional.of(media(mediaId, "REJECTED")));

        ResponseStatusException error = assertThrows(ResponseStatusException.class, () ->
            this.service.createJob(this.meetingId, mediaId, "job-once"));

        assertEquals(409, error.getStatusCode().value());
        verify(this.repository, never()).insertJobAndOutbox(any(Job.class), any(UUID.class));
    }

    @Test
    void admittedJobIsPersistedWithOutboxAndStartsQueued() {
        UUID mediaId = UUID.randomUUID();
        AtomicReference<Job> saved = new AtomicReference<>();
        when(this.repository.findMedia(mediaId)).thenReturn(Optional.of(media(mediaId, "AVAILABLE")));
        when(this.repository.claimIdempotency(any(), anyString(), anyString(), anyString(), any(UUID.class)))
            .thenAnswer(invocation -> invocation.getArgument(4));
        doAnswer(invocation -> {
            saved.set(invocation.getArgument(0));
            return null;
        }).when(this.repository).insertJobAndOutbox(any(Job.class), any(UUID.class));
        when(this.repository.findJob(any(UUID.class))).thenAnswer(invocation -> Optional.of(saved.get()));
        when(this.repository.recentJobAdmissions(this.actor, 60))
            .thenReturn(new MediaRepository.RecentJobAdmissions(0, 1));

        var result = this.service.createJob(this.meetingId, mediaId, "job-once");

        assertEquals("QUEUED", result.status());
        assertEquals(mediaId, result.sourceMediaId());
        verify(this.repository).insertJobAndOutbox(any(Job.class), any(UUID.class));
    }

    @Test
    void existingIdempotentJobReplaySkipsAllNewAdmissionLimits() {
        UUID mediaId = UUID.randomUUID();
        Job saved = new Job(UUID.randomUUID(), this.meetingId, mediaId, "OFFLINE_MEETING_PROCESSING",
            "QUEUED", this.actor, null, 0, OffsetDateTime.now(), null, null, null, null, null,
            OffsetDateTime.now(), OffsetDateTime.now());
        when(this.repository.findMedia(mediaId)).thenReturn(Optional.of(media(mediaId, "AVAILABLE")));
        when(this.repository.claimIdempotency(any(), anyString(), anyString(), anyString(), any(UUID.class)))
            .thenReturn(saved.id());
        when(this.repository.findJob(saved.id())).thenReturn(Optional.of(saved));

        assertEquals(saved.id(), this.service.createJob(this.meetingId, mediaId, "replay").id());
        verify(this.repository).lockAdmissionUser(this.actor);
        verify(this.repository, never()).recentJobAdmissions(this.actor, 60);
        verify(this.repository, never()).insertJobAndOutbox(any(Job.class), any(UUID.class));
    }

    @Test
    void activeMeetingRejectsDifferentProcessingRequestBeforeJobWrite() {
        UUID mediaId = UUID.randomUUID();
        when(this.repository.findMedia(mediaId)).thenReturn(Optional.of(media(mediaId, "AVAILABLE")));
        when(this.repository.claimIdempotency(any(), anyString(), anyString(), anyString(), any(UUID.class)))
            .thenAnswer(invocation -> invocation.getArgument(4));
        when(this.repository.activeJobsForMeeting(this.meetingId)).thenReturn(1);

        ResponseStatusException rejected = assertThrows(ResponseStatusException.class, () ->
            this.service.createJob(this.meetingId, mediaId, "second-key"));

        assertEquals(409, rejected.getStatusCode().value());
        verify(this.repository, never()).insertJobAndOutbox(any(Job.class), any(UUID.class));
    }

    @Test
    void rollingQuotaReturns429AndRetryAfterWithoutPublishingEvent() {
        UUID mediaId = UUID.randomUUID();
        when(this.repository.findMedia(mediaId)).thenReturn(Optional.of(media(mediaId, "AVAILABLE")));
        when(this.repository.claimIdempotency(any(), anyString(), anyString(), anyString(), any(UUID.class)))
            .thenAnswer(invocation -> invocation.getArgument(4));
        when(this.repository.recentJobAdmissions(this.actor, 60))
            .thenReturn(new MediaRepository.RecentJobAdmissions(12, 45));

        ResponseStatusException rejected = assertThrows(ResponseStatusException.class, () ->
            this.service.createJob(this.meetingId, mediaId, "over-quota"));

        assertEquals(429, rejected.getStatusCode().value());
        assertEquals("45", rejected.getHeaders().getFirst("Retry-After"));
        verify(this.repository, never()).insertJobAndOutbox(any(Job.class), any(UUID.class));
    }

    @Test
    void pendingUploadCapacityCheckRejectsNewIntentBeforeStorageCapability() {
        this.properties.getAdmission().setMaxPendingUploadsPerUser(2);
        when(this.repository.claimIdempotency(any(), anyString(), anyString(), anyString(), any(UUID.class)))
            .thenAnswer(invocation -> invocation.getArgument(4));
        when(this.repository.pendingUploadIntentsForUser(this.actor)).thenReturn(2);

        ResponseStatusException rejected = assertThrows(ResponseStatusException.class, () ->
            this.service.createUploadIntent(this.meetingId,
                new CreateMediaUploadRequest(CreateMediaUploadRequest.SourceType.UPLOAD,
                    "recording.wav", "audio/wav", 512L), "new-upload"));

        assertEquals(429, rejected.getStatusCode().value());
        verify(this.storage, never()).createUploadCapability(anyString(), anyString(),
            org.mockito.ArgumentMatchers.anyLong(), any());
        verify(this.repository, never()).insertMedia(any(Media.class));
    }

    @Test
    void finalizeRejectsContainerWithoutConfiguredAudioFormat() throws Exception {
        UUID mediaId = UUID.randomUUID();
        Media pending = media(mediaId, "PENDING_UPLOAD");
        when(this.repository.findMedia(mediaId))
            .thenReturn(Optional.of(pending), Optional.of(media(mediaId, "REJECTED")));
        when(this.repository.claimFinalization(any(UUID.class), any(UUID.class),
            org.mockito.ArgumentMatchers.anyLong())).thenReturn(true);
        when(this.storage.head(acceptedKey(mediaId))).thenThrow(missing());
        when(this.storage.head(pending.objectKey()))
            .thenReturn(new ObjectStorage.StoredObject(512, "audio/wav", "etag"));
        doAnswer(invocation -> {
            Files.write(invocation.getArgument(1), new byte[512]);
            return null;
        }).when(this.storage).downloadTo(anyString(), any());
        when(this.inspector.inspect(any())).thenReturn(new MediaInspection("matroska,webm", 1000, true));
        when(this.repository.rejectMedia(any(UUID.class), any(UUID.class), anyString())).thenReturn(true);

        var response = this.service.finalizeUpload(this.meetingId, mediaId);

        assertEquals("REJECTED", response.status());
        verify(this.repository).rejectMedia(org.mockito.ArgumentMatchers.eq(mediaId),
            any(UUID.class), org.mockito.ArgumentMatchers.eq("MEDIA_FORMAT_UNSUPPORTED"));
        verify(this.storage, never()).putAcceptedIfAbsent(anyString(), any(), anyString());
    }

    @Test
    void promotedSourceUsesSeparateAcceptedKeyAndCanonicalAccess() throws Exception {
        UUID id = UUID.randomUUID();
        Media pending = media(id, "PENDING_UPLOAD");
        Media accepted = media(id, "AVAILABLE");
        when(this.repository.findMedia(id)).thenReturn(Optional.of(pending), Optional.of(accepted),
            Optional.of(accepted));
        when(this.repository.claimFinalization(any(UUID.class), any(UUID.class),
            org.mockito.ArgumentMatchers.anyLong())).thenReturn(true);
        when(this.storage.head(acceptedKey(id)))
            .thenThrow(missing())
            .thenReturn(new ObjectStorage.StoredObject(512, "audio/wav", "accepted-etag"));
        when(this.storage.head(pending.objectKey()))
            .thenReturn(new ObjectStorage.StoredObject(512, "audio/wav", "pending-etag"));
        doAnswer(invocation -> {
            Files.write(invocation.getArgument(1), new byte[512]);
            return null;
        }).when(this.storage).downloadTo(anyString(), any());
        when(this.inspector.inspect(any())).thenReturn(new MediaInspection("wav", 1000, true));
        when(this.storage.putAcceptedIfAbsent(anyString(), any(), anyString())).thenReturn(true);
        when(this.repository.acceptMedia(any(UUID.class), any(UUID.class), anyString(),
            org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.anyLong(), anyString()))
            .thenReturn(true);
        when(this.storage.createDownloadCapability(org.mockito.ArgumentMatchers.eq(acceptedKey(id)), any()))
            .thenReturn("https://storage.test/download");

        assertEquals("AVAILABLE", this.service.finalizeUpload(this.meetingId, id).status());
        assertEquals("https://storage.test/download", this.service.mediaAccessUrl(this.meetingId, id));
        verify(this.storage).putAcceptedIfAbsent(org.mockito.ArgumentMatchers.eq(acceptedKey(id)), any(), anyString());
        verify(this.repository).acceptMedia(org.mockito.ArgumentMatchers.eq(id), any(UUID.class),
            org.mockito.ArgumentMatchers.eq(acceptedKey(id)),
            org.mockito.ArgumentMatchers.eq(512L), org.mockito.ArgumentMatchers.eq(1000L), anyString());
        // The upload capability can change pending bytes, not the accepted key.
        assertTrue(!pending.objectKey().equals(accepted.objectKey()));
    }

    @Test
    void recoversPreviouslyPromotedSourceWithoutReadingMutablePendingUpload() throws Exception {
        UUID id = UUID.randomUUID();
        Media pending = media(id, "PENDING_UPLOAD");
        when(this.repository.findMedia(id)).thenReturn(Optional.of(pending), Optional.of(media(id, "AVAILABLE")));
        when(this.repository.claimFinalization(any(UUID.class), any(UUID.class),
            org.mockito.ArgumentMatchers.anyLong())).thenReturn(true);
        when(this.storage.head(acceptedKey(id)))
            .thenReturn(new ObjectStorage.StoredObject(512, "audio/wav", "accepted-etag"));
        doAnswer(invocation -> {
            Files.write(invocation.getArgument(1), new byte[512]);
            return null;
        }).when(this.storage).downloadTo(org.mockito.ArgumentMatchers.eq(acceptedKey(id)), any());
        when(this.inspector.inspect(any())).thenReturn(new MediaInspection("wav", 1000, true));
        when(this.repository.acceptMedia(any(UUID.class), any(UUID.class), anyString(),
            org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.anyLong(), anyString()))
            .thenReturn(true);

        assertEquals("AVAILABLE", this.service.finalizeUpload(this.meetingId, id).status());
        verify(this.storage, never()).putAcceptedIfAbsent(anyString(), any(), anyString());
        verify(this.storage, never()).downloadTo(org.mockito.ArgumentMatchers.eq(pending.objectKey()), any());
    }

    @Test
    void missingUploadIsRetryableAndDoesNotRejectMedia() {
        UUID id = UUID.randomUUID();
        when(this.repository.findMedia(id)).thenReturn(Optional.of(media(id, "PENDING_UPLOAD")));
        when(this.repository.claimFinalization(any(UUID.class), any(UUID.class),
            org.mockito.ArgumentMatchers.anyLong())).thenReturn(true);
        when(this.storage.head(acceptedKey(id))).thenThrow(missing());
        when(this.storage.head(media(id, "PENDING_UPLOAD").objectKey())).thenThrow(missing());

        ResponseStatusException error = assertThrows(ResponseStatusException.class,
            () -> this.service.finalizeUpload(this.meetingId, id));

        assertEquals(409, error.getStatusCode().value());
        verify(this.repository, never()).rejectMedia(any(UUID.class), any(UUID.class), anyString());
        verify(this.repository).releaseFinalization(org.mockito.ArgumentMatchers.eq(id), any(UUID.class));
    }

    @Test
    void concurrentFinalizeCannotProcessWithoutDatabaseLease() {
        UUID id = UUID.randomUUID();
        when(this.repository.findMedia(id)).thenReturn(Optional.of(media(id, "PENDING_UPLOAD")));

        ResponseStatusException error = assertThrows(ResponseStatusException.class,
            () -> this.service.finalizeUpload(this.meetingId, id));

        assertEquals(409, error.getStatusCode().value());
        verify(this.storage, never()).head(anyString());
    }

    @Test
    void changedPendingBytesBetweenHeadAndDownloadAreRejected() throws Exception {
        UUID id = UUID.randomUUID();
        when(this.repository.findMedia(id)).thenReturn(Optional.of(media(id, "PENDING_UPLOAD")),
            Optional.of(media(id, "REJECTED")));
        when(this.repository.claimFinalization(any(UUID.class), any(UUID.class),
            org.mockito.ArgumentMatchers.anyLong())).thenReturn(true);
        when(this.storage.head(acceptedKey(id))).thenThrow(missing());
        when(this.storage.head(media(id, "PENDING_UPLOAD").objectKey()))
            .thenReturn(new ObjectStorage.StoredObject(512, "audio/wav", "etag"));
        doAnswer(invocation -> {
            Files.write(invocation.getArgument(1), new byte[511]);
            return null;
        }).when(this.storage).downloadTo(anyString(), any());
        when(this.repository.rejectMedia(any(UUID.class), any(UUID.class), anyString())).thenReturn(true);

        assertEquals("REJECTED", this.service.finalizeUpload(this.meetingId, id).status());
        verify(this.repository).rejectMedia(org.mockito.ArgumentMatchers.eq(id), any(UUID.class),
            org.mockito.ArgumentMatchers.eq("MEDIA_SIZE_INVALID"));
        verify(this.inspector, never()).inspect(any());
    }

    private String acceptedKey(UUID id) {
        return "meetings/" + this.meetingId + "/sources/" + id;
    }

    private static S3Exception missing() {
        return (S3Exception) S3Exception.builder().statusCode(404).message("Not found").build();
    }

    private Media media(UUID id, String status) {
        return new Media(id, this.meetingId, "UPLOAD", status, ("AVAILABLE".equals(status) ? acceptedKey(id) : "meetings/" + this.meetingId + "/pending/" + id),
            "meeting.wav", "audio/wav", 512, "AVAILABLE".equals(status) ? 512L : null,
            "AVAILABLE".equals(status) ? 1000L : null, null, this.actor,
            OffsetDateTime.now(), "AVAILABLE".equals(status) ? OffsetDateTime.now() : null, null);
    }
}
