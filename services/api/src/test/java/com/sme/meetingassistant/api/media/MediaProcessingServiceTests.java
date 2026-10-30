package com.sme.meetingassistant.api.media;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
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
        assertNotNull(result.expiresAt());
        verify(this.meetingAccess).requireReadable(this.meetingId, this.actor);
        verify(this.repository).insertMedia(any(Media.class));
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

        var result = this.service.createJob(this.meetingId, mediaId, "job-once");

        assertEquals("QUEUED", result.status());
        assertEquals(mediaId, result.sourceMediaId());
        verify(this.repository).insertJobAndOutbox(any(Job.class), any(UUID.class));
    }

    @Test
    void finalizeRejectsContainerWithoutConfiguredAudioFormat() throws Exception {
        UUID mediaId = UUID.randomUUID();
        Media pending = media(mediaId, "PENDING_UPLOAD");
        Media rejected = media(mediaId, "REJECTED");
        when(this.repository.findMedia(mediaId)).thenReturn(Optional.of(pending), Optional.of(rejected));
        when(this.storage.head(pending.objectKey())).thenReturn(new ObjectStorage.StoredObject(512, "audio/wav", "etag"));
        doAnswer(invocation -> {
            java.nio.file.Files.writeString(invocation.getArgument(1), "test-object");
            return null;
        }).when(this.storage).downloadTo(anyString(), any());
        when(this.inspector.inspect(any())).thenReturn(new MediaInspection("matroska,webm", 1000, true));

        var response = this.service.finalizeUpload(this.meetingId, mediaId);

        assertEquals("REJECTED", response.status());
        verify(this.repository).rejectMedia(mediaId, "MEDIA_FORMAT_UNSUPPORTED");
        verify(this.repository, never()).acceptMedia(any(), org.mockito.ArgumentMatchers.anyLong(),
            org.mockito.ArgumentMatchers.anyLong(), anyString());
    }

    private Media media(UUID id, String status) {
        return new Media(id, this.meetingId, "UPLOAD", status, "meetings/" + this.meetingId + "/source/" + id,
            "meeting.wav", "audio/wav", 512, "AVAILABLE".equals(status) ? 512L : null,
            "AVAILABLE".equals(status) ? 1000L : null, null, this.actor,
            OffsetDateTime.now(), "AVAILABLE".equals(status) ? OffsetDateTime.now() : null, null);
    }
}
