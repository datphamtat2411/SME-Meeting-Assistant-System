package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.time.Duration;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import software.amazon.awssdk.services.s3.model.S3Exception;

@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.media.outbox.enabled=false",
    "app.media.upload.allowed-extensions=wav",
    "app.media.upload.allowed-content-types=audio/wav",
    "app.media.upload.max-size-bytes=1048576",
    "app.media.upload.max-duration-ms=60000",
    "app.media.upload.upload-url-ttl=PT2M",
    "app.media.upload.download-url-ttl=PT1M"
})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MediaApiHardeningIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @MockitoBean ObjectStorage storage;
    private UUID actor;
    private UUID meetingId;
    private UUID mediaId;

    @BeforeEach
    void setUp() {
        actor = UUID.randomUUID();
        meetingId = UUID.randomUUID();
        mediaId = UUID.randomUUID();
        String email = "t07-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'T07 organizer','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'T07 media hardening',?,?)
            """, meetingId, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                original_filename,content_type,expected_size_bytes,size_bytes,duration_ms,sha256,
                uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'recording.wav','audio/wav',
                512,512,1000,?,?,CURRENT_TIMESTAMP)
            """, mediaId, meetingId,
            "meetings/" + meetingId + "/sources/" + mediaId,
            "meetings/" + meetingId + "/pending/" + mediaId,
            "a".repeat(64), actor);
    }

    private static Principal as(UUID userId) { return () -> userId.toString(); }

    private String uploadPath() {
        return "/api/v1/meetings/" + meetingId + "/media/uploads";
    }

    private String accessPath() {
        return "/api/v1/meetings/" + meetingId + "/media/" + mediaId + "/access-url";
    }

    private String uploadBody() {
        return """
            {"sourceType":"UPLOAD","originalFilename":"recording.wav",
             "contentType":"audio/wav","expectedSizeBytes":512}
            """;
    }

    @Test
    void uploadIntentPresignedUrlIsNotCachedAndHonorsConfiguredTwoMinuteTtl() throws Exception {
        when(storage.createUploadCapability(anyString(), anyString(), anyLong(), any()))
            .thenReturn("https://storage.example.invalid/private-upload");

        var response = mvc.perform(post(uploadPath()).principal(as(actor))
            .header("Idempotency-Key", "upload-secure")
            .contentType(MediaType.APPLICATION_JSON).content(uploadBody()))
            .andExpect(status().isCreated()).andReturn().getResponse();

        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        assertThat(response.getContentAsString()).contains("https://storage.example.invalid/private-upload");
        verify(storage).createUploadCapability(anyString(), eq("audio/wav"),
            eq(512L), eq(Duration.ofMinutes(2)));
    }

    @Test
    void downloadPresignedUrlIsNotCachedAndHonorsConfiguredOneMinuteTtl() throws Exception {
        when(storage.createDownloadCapability(anyString(), any()))
            .thenReturn("https://storage.example.invalid/private-download");

        var response = mvc.perform(post(accessPath()).principal(as(actor)))
            .andExpect(status().isOk()).andReturn().getResponse();

        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        assertThat(response.getContentAsString()).contains("https://storage.example.invalid/private-download");
        verify(storage).createDownloadCapability(eq("meetings/" + meetingId + "/sources/" + mediaId),
            eq(Duration.ofMinutes(1)));
    }

    @Test
    void failedUploadSigningRollsBackMediaIntentAndReturnsSafe503Error() throws Exception {
        when(storage.createUploadCapability(anyString(), anyString(), anyLong(), any()))
            .thenThrow(S3Exception.builder().statusCode(503).message("secret-storage-detail").build());

        var response = mvc.perform(post(uploadPath()).principal(as(actor))
            .header("Idempotency-Key", "upload-storage-failure")
            .contentType(MediaType.APPLICATION_JSON).content(uploadBody()))
            .andExpect(status().isServiceUnavailable()).andReturn().getResponse();

        assertThat(response.getContentAsString()).doesNotContain("secret-storage-detail");
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM meeting_media WHERE meeting_id = ?", Integer.class, meetingId))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM processing_job_idempotency WHERE requester_id = ?",
            Integer.class, actor)).isZero();
    }

    @Test
    void failedDownloadSigningReturnsSafe503WithoutLeakingStorageDetails() throws Exception {
        when(storage.createDownloadCapability(anyString(), any()))
            .thenThrow(S3Exception.builder().statusCode(503).message("secret-storage-detail").build());

        var response = mvc.perform(post(accessPath()).principal(as(actor)))
            .andExpect(status().isServiceUnavailable()).andReturn().getResponse();

        assertThat(response.getContentAsString()).doesNotContain("secret-storage-detail");
    }

    @Test
    void whitespacePaddedIdempotencyKeyIsRejectedBeforeDatabaseMutation() throws Exception {
        mvc.perform(post(uploadPath()).principal(as(actor))
            .header("Idempotency-Key", " padded-key ")
            .contentType(MediaType.APPLICATION_JSON).content(uploadBody()))
            .andExpect(status().isBadRequest());

        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM processing_job_idempotency WHERE requester_id = ?",
            Integer.class, actor)).isZero();
    }
}
