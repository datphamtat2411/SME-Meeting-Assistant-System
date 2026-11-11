package com.sme.meetingassistant.api.transcript;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.sme.meetingassistant.api.assistant.AssistantAiGateway;
import com.sme.meetingassistant.api.knowledge.KnowledgeIndexingProducer;
import com.sme.meetingassistant.api.knowledge.KnowledgeIndexingWorkerService;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * PI-03: real PostgreSQL/Flyway, HTTP, meeting authorization, transcript,
 * intelligence, knowledge and Assistant history. Only AI inference is mocked.
 */
@ActiveProfiles("test")
@SpringBootTest(properties={
    "app.media.knowledge-indexing.enabled=true",
    "app.media.outbox.enabled=false",
    "app.assistant.enabled=true"
})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class CrossModuleRevisionConsistencyIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired KnowledgeIndexingProducer knowledge;
    @Autowired KnowledgeIndexingWorkerService verification;
    @Autowired PlatformTransactionManager transactions;
    @MockitoBean AssistantAiGateway gateway;

    private UUID user() {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'PI03 reviewer','test-only','EMPLOYEE','ACTIVE')
            """,id,id+"@example.invalid",id+"@example.invalid");
        return id;
    }
    private static Principal as(UUID user){return ()->user.toString();}
    private String sourceStatus(String type,UUID source,UUID meeting,long revision) {
        return (String)verification.verifySources(List.of(
            new KnowledgeIndexingWorkerService.SourceVerificationRequest(type,source,meeting,revision)))
            .getFirst().get("status");
    }
    private int intents(String type,UUID source,String operation){
        return jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_indexing_work
             WHERE source_type=? AND source_id=? AND operation=?
            """,Integer.class,type,source,operation);
    }

    @Test
    void transcriptCorrectionInvalidatesDerivedEvidenceWithoutDestroyingOfficialHistory()
            throws Exception {
        UUID organizer=user(),reader=user(),meeting=UUID.randomUUID();
        UUID media=UUID.randomUUID(),job=UUID.randomUUID(),transcript=UUID.randomUUID();
        UUID segment=UUID.randomUUID(),summary=UUID.randomUUID(),decision=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'PI03 revision propagation',?,?)
            """,meeting,organizer,organizer);
        jdbc.update("""
            INSERT INTO meeting_participants(id,meeting_id,user_id,added_by_user_id)
            VALUES (?,?,?,?)
            """,UUID.randomUUID(),meeting,reader,organizer);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,
                pending_object_key,content_type,expected_size_bytes,size_bytes,
                duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """,media,meeting,"meetings/"+meeting+"/sources/"+media,
            "meetings/"+meeting+"/pending/"+media,organizer);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """,job,meeting,media,organizer);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,
                version_number,language_code,status,is_current,content_revision,finalized_at)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,0,CURRENT_TIMESTAMP)
            """,transcript,meeting,media,job);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,
                current_text,quality_status)
            VALUES (?,?,0,0,1000,'Báo cáo ngân sách ban đầu.','ACCEPTED')
            """,segment,transcript);
        UUID stage=UUID.randomUUID(),snapshot=UUID.randomUUID(),receipt=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'SUCCEEDED')
            """,stage,job);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(id,meeting_id,source_media_id,
                processing_job_id,transcript_id,content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,0,?,?,100)
            """,snapshot,meeting,media,job,transcript,"a".repeat(64),
            "processing/"+job+"/intelligence/source/"+snapshot+".json");
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(id,meeting_id,processing_job_id,
                stage_run_id,result_type,source_snapshot_id,transcript_id,content_revision,
                artifact_sha256,artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,'SUMMARY',?,?,0,?,?,200)
            """,receipt,meeting,job,stage,snapshot,transcript,"b".repeat(64),
            "processing/"+job+"/intelligence/results/"+stage+".json");
        jdbc.update("""
            INSERT INTO meeting_summary_versions(id,meeting_id,version_number,content,
                source_type,processing_job_id,result_receipt_id,transcript_id,
                content_revision,quality_status,is_current)
            VALUES (?,?,1,'Tổng hợp theo bản ghi cũ','AI_GENERATED',?,?,?,0,'READY',TRUE)
            """,summary,meeting,job,receipt,transcript);
        jdbc.update("""
            INSERT INTO meeting_decisions(id,meeting_id,content,status,source_type,
                transcript_id,content_revision,created_by_user_id,confirmed_by_user_id,confirmed_at)
            VALUES (?,?,'Đồng ý ngân sách cũ','CONFIRMED','MANUAL',?,0,?,?,CURRENT_TIMESTAMP)
            """,decision,meeting,transcript,organizer,organizer);

        new TransactionTemplate(transactions).execute(tx->{
            assertThat(knowledge.request("SUMMARY",summary,meeting)).isPresent();
            assertThat(knowledge.request("DECISION",decision,meeting)).isPresent();
            return null;
        });
        assertThat(intents("SUMMARY",summary,"UPSERT")).isEqualTo(1);
        assertThat(intents("DECISION",decision,"UPSERT")).isEqualTo(1);
        assertThat(sourceStatus("SUMMARY",summary,meeting,1)).isEqualTo("CURRENT");
        assertThat(sourceStatus("DECISION",decision,meeting,0)).isEqualTo("CURRENT");

        // A historical answer with a canonical citation must be hidden when
        // its source is superseded, even if the user still has meeting access.
        UUID conversation=UUID.randomUUID(),answer=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO assistant_conversations(id,user_id,meeting_id,title)
            VALUES (?,?,?,'Recorded knowledge')
            """,conversation,reader,meeting);
        jdbc.update("""
            INSERT INTO assistant_messages(id,conversation_id,role,content,answer_status,answer_claims)
            VALUES (?,?,'ASSISTANT','Nội dung từ bản cũ','GROUNDED','[]'::jsonb)
            """,answer,conversation);
        jdbc.update("""
            INSERT INTO assistant_message_sources(assistant_message_id,citation_id,source_type,
                source_id,meeting_id,source_revision,retrieval_chunk_id,claim_ids,citation_payload,rank)
            VALUES (?,'C1','SUMMARY',?,?,1,'historic-summary','[]'::jsonb,'{}'::jsonb,1)
            """,answer,summary,meeting);
        String conversationUrl="/api/v1/assistant/conversations/"+conversation;
        JsonNode before=json.readTree(mvc.perform(get(conversationUrl).principal(as(reader)))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        assertThat(before.path("data").path("messages").get(0).path("visibility").asText())
            .isEqualTo("VISIBLE");

        // Same transaction commits current transcript content and enqueue
        // source-specific cleanup of formerly current derived evidence.
        mvc.perform(patch("/api/v1/meetings/"+meeting+"/transcript/segments/"+segment)
            .principal(as(organizer)).header("If-Match","\"s-"+segment+"-0\"")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"text\":\"Ngân sách sau xác minh đã thay đổi.\",\"reason\":\"Fact correction\"}"))
            .andExpect(status().isOk());
        assertThat(jdbc.queryForObject("""
            SELECT content_revision FROM transcripts WHERE id=?
            """,Long.class,transcript)).isEqualTo(1L);
        assertThat(sourceStatus("SUMMARY",summary,meeting,1)).isEqualTo("SUPERSEDED");
        assertThat(sourceStatus("DECISION",decision,meeting,0)).isEqualTo("SUPERSEDED");
        assertThat(intents("SUMMARY",summary,"INVALIDATE")).isEqualTo(1);
        assertThat(intents("DECISION",decision,"INVALIDATE")).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM outbox_events o
            JOIN knowledge_indexing_work k ON k.event_id=o.id
            WHERE k.meeting_id=? AND k.operation='INVALIDATE'
              AND k.source_type IN ('SUMMARY','DECISION')
              AND o.event_type='KNOWLEDGE_INDEXING_REQUESTED'
            """,Integer.class,meeting)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT content FROM meeting_summary_versions WHERE id=?
            """,String.class,summary)).isEqualTo("Tổng hợp theo bản ghi cũ");
        assertThat(jdbc.queryForObject("""
            SELECT status FROM meeting_decisions WHERE id=?
            """,String.class,decision)).isEqualTo("CONFIRMED");
        mvc.perform(get("/api/v1/meetings/"+meeting+"/summary").principal(as(reader)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.isStale").value(true));
        mvc.perform(get("/api/v1/meetings/"+meeting+"/decisions").principal(as(reader)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data[0].isStale").value(true));

        JsonNode after=json.readTree(mvc.perform(get(conversationUrl).principal(as(reader)))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        JsonNode stale=after.path("data").path("messages").get(0);
        assertThat(stale.path("visibility").asText()).isEqualTo("SOURCE_UNAVAILABLE");
        assertThat(stale.path("content").isNull()).isTrue();
        assertThat(stale.path("citations").size()).isZero();

        // Another edit cannot produce duplicate cleanup events for the same
        // source/generation/revision.
        mvc.perform(patch("/api/v1/meetings/"+meeting+"/transcript/segments/"+segment)
            .principal(as(organizer)).header("If-Match","\"s-"+segment+"-1\"")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"text\":\"Ngân sách đã cập nhật lần hai.\",\"reason\":\"Review\"}"))
            .andExpect(status().isOk());
        assertThat(intents("SUMMARY",summary,"INVALIDATE")).isEqualTo(1);
        assertThat(intents("DECISION",decision,"INVALIDATE")).isEqualTo(1);

        // An authorized historical reader who loses membership cannot fetch
        // the same protected source through another feature's HTTP route.
        jdbc.update("""
            UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP
             WHERE meeting_id=? AND user_id=?
            """,meeting,reader);
        mvc.perform(get("/api/v1/meetings/"+meeting+"/transcript").principal(as(reader)))
            .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/meetings/"+meeting+"/summary").principal(as(reader)))
            .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/meetings/"+meeting+"/decisions").principal(as(reader)))
            .andExpect(status().isNotFound());
        mvc.perform(get(conversationUrl).principal(as(reader)))
            .andExpect(status().isNotFound());
        // Revocation cannot destroy the organizer's canonical historical record.
        mvc.perform(get("/api/v1/meetings/"+meeting+"/summary").principal(as(organizer)))
            .andExpect(status().isOk());
    }
}
