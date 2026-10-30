package com.sme.meetingassistant.api.transcript;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SegmentResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.CoverageResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SpeakerResult;
import java.security.Principal;
import java.util.List;
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

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class TranscriptReviewIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired TranscriptIngestion ingestion;
    @MockitoBean ObjectStorage storage;

    private UUID organizer, participant, outsider, meeting, media, job, segment, cluster;

    @BeforeEach
    void setUp() {
        organizer = user();
        participant = user();
        outsider = user();
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        job = UUID.randomUUID();
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?, 'Transcript test', ?, ?)",
            meeting, organizer, organizer);
        jdbc.update("INSERT INTO meeting_participants(id,meeting_id,user_id,added_by_user_id) VALUES (?,?,?,?)",
            UUID.randomUUID(), meeting, participant, organizer);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,content_type,
              expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',10,10,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, organizer);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """, job, meeting, media, organizer);
        UUID finalization = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'FINALIZING_TRANSCRIPT',1,'SUCCEEDED')
            """, finalization, job);
        ingestion.publish(new TranscriptResult(meeting, media, job, finalization, "vi", 10_000L,
            TranscriptIngestion.Status.READY, List.of(new SegmentResult(0, 0, 1500,
                "Chúng ta bắt đầu cuộc họp.", "ACCEPTED", "Speaker 1", null, null)),
            List.of(new CoverageResult(0, 1500, "COVERED", false, 0, null)),
            List.of(new SpeakerResult("Speaker 1"))));
        segment = jdbc.queryForObject("SELECT id FROM transcript_segments WHERE transcript_id = "
            + "(SELECT id FROM transcripts WHERE meeting_id=? AND is_current)", UUID.class, meeting);
        cluster = jdbc.queryForObject("SELECT id FROM speaker_clusters WHERE transcript_id = "
            + "(SELECT id FROM transcripts WHERE meeting_id=? AND is_current)", UUID.class, meeting);
    }

    private UUID user() {
        UUID id = UUID.randomUUID();
        String email = "transcript-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Transcript test','test-only','EMPLOYEE','ACTIVE')
            """, id, email, email);
        return id;
    }

    private static Principal as(UUID id) { return () -> id.toString(); }
    private String transcriptUrl() { return "/api/v1/meetings/" + meeting + "/transcript"; }

    @Test
    void authorizedReadAndAttributedCorrectionPreserveHistoryAndRejectStaleTag() throws Exception {
        var transcript = mvc.perform(get(transcriptUrl()).principal(as(participant)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.status").value("READY"))
            .andExpect(jsonPath("$.data.segments[0].text").value("Chúng ta bắt đầu cuộc họp."))
            .andReturn().getResponse();
        assertThat(transcript.getHeader("Cache-Control")).contains("no-store");
        String etag = "\"s-" + segment + "-0\"";

        mvc.perform(patch(transcriptUrl() + "/segments/" + segment).principal(as(participant))
                .header("If-Match", etag).contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\":\"Chúng ta bắt đầu cuộc họp nhé.\",\"reason\":\"Punctuation\"}"))
            .andExpect(status().isNotFound());
        mvc.perform(patch(transcriptUrl() + "/segments/" + segment).principal(as(organizer))
                .header("If-Match", etag).contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\":\"Chúng ta bắt đầu cuộc họp nhé.\",\"reason\":\"Punctuation\"}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.text").value("Chúng ta bắt đầu cuộc họp nhé."));
        mvc.perform(patch(transcriptUrl() + "/segments/" + segment).principal(as(organizer))
                .header("If-Match", etag).contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\":\"stale\"}"))
            .andExpect(status().isPreconditionFailed());

        assertThat(jdbc.queryForObject("SELECT count(*) FROM transcript_segment_revisions WHERE segment_id=?",
            Integer.class, segment)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT edited_by_user_id FROM transcript_segment_revisions WHERE segment_id=?",
            UUID.class, segment)).isEqualTo(organizer);
        mvc.perform(get(transcriptUrl()).principal(as(outsider))).andExpect(status().isNotFound());
    }

    @Test
    void coverageAndSpeakerClusterReadsAreMeetingScoped() throws Exception {
        mvc.perform(get(transcriptUrl() + "/coverage").principal(as(participant)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data[0].coverageStatus").value("COVERED"));
        mvc.perform(get("/api/v1/meetings/" + meeting + "/speaker-clusters").principal(as(participant)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data[0].label").value("Speaker 1"));
        mvc.perform(get("/api/v1/meetings/" + UUID.randomUUID() + "/speaker-clusters").principal(as(participant)))
            .andExpect(status().isNotFound());
        assertThat(cluster).isNotNull();
    }

    @Test
    void onlyOrganizerCanMapSpeakersAndMappedUserMustBeMeetingMember() throws Exception {
        String endpoint = "/api/v1/meetings/" + meeting + "/speaker-clusters/" + cluster;
        String participantBody = "{\"userId\":\"" + participant + "\"}";
        String outsiderBody = "{\"userId\":\"" + outsider + "\"}";

        mvc.perform(patch(endpoint).principal(as(participant))
                .contentType(MediaType.APPLICATION_JSON).content(participantBody))
            .andExpect(status().isNotFound());
        mvc.perform(patch(endpoint).principal(as(outsider))
                .contentType(MediaType.APPLICATION_JSON).content(participantBody))
            .andExpect(status().isNotFound());
        mvc.perform(patch(endpoint).principal(as(organizer))
                .contentType(MediaType.APPLICATION_JSON).content(outsiderBody))
            .andExpect(status().isNotFound());

        mvc.perform(patch(endpoint).principal(as(organizer))
                .contentType(MediaType.APPLICATION_JSON).content(participantBody))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.userId").value(participant.toString()));
        assertThat(jdbc.queryForObject("""
            SELECT content_revision FROM transcripts WHERE meeting_id=? AND is_current
            """, Long.class, meeting)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("""
            SELECT mapped_by_user_id FROM speaker_mappings
            WHERE speaker_cluster_id=? AND superseded_at IS NULL
            """, UUID.class, cluster)).isEqualTo(organizer);

        mvc.perform(patch(endpoint).principal(as(organizer))
                .contentType(MediaType.APPLICATION_JSON).content(participantBody))
            .andExpect(status().isOk());
        assertThat(jdbc.queryForObject("""
            SELECT content_revision FROM transcripts WHERE meeting_id=? AND is_current
            """, Long.class, meeting)).isEqualTo(1L);

        mvc.perform(patch(endpoint).principal(as(organizer))
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isOk());
        assertThat(jdbc.queryForObject("""
            SELECT content_revision FROM transcripts WHERE meeting_id=? AND is_current
            """, Long.class, meeting)).isEqualTo(2L);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM speaker_mappings
            WHERE speaker_cluster_id=? AND superseded_at IS NOT NULL
            """, Integer.class, cluster)).isEqualTo(1);
        mvc.perform(get("/api/v1/meetings/" + meeting + "/speaker-clusters")
                .principal(as(participant)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data[0].userId").doesNotExist());
    }

    @Test
    void currentTranscriptReturnsContentRevisionAfterAuthorizedReview() throws Exception {
        mvc.perform(get(transcriptUrl()).principal(as(participant)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.contentRevision").value(0));
        String etag = "\"s-" + segment + "-0\"";
        mvc.perform(patch(transcriptUrl() + "/segments/" + segment).principal(as(organizer))
                .header("If-Match", etag).contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\":\"Đã chỉnh sửa và xác minh.\"}"))
            .andExpect(status().isOk());
        mvc.perform(get(transcriptUrl()).principal(as(participant)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.contentRevision").value(1))
            .andExpect(jsonPath("$.data.segments[0].text").value("Đã chỉnh sửa và xác minh."));
    }
}
