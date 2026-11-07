package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.sme.meetingassistant.api.integration.TranscriptFinalizationService;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.diarization.*;
import com.sme.meetingassistant.api.media.outbox.OutboxPublisher;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.service.*;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.*;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.amqp.core.*;
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory;
import org.springframework.amqp.rabbit.core.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.*;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.*;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.*;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionTemplate;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.model.S3Exception;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** Real Core + migrated PostgreSQL + RabbitMQ TLS + immutable HTTPS S3 + Python worker.
 * Only inference and deterministic faults/checkpoints are test-controlled.
 */
@EnabledIfEnvironmentVariable(named="SPK11_FULL_STACK", matches="1")
@ActiveProfiles("test")
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT, properties={
    "app.media.outbox.enabled=false", "app.media.processing.stage-lease-sweep-ms=3600000",
    "app.media.processing.diarization-enabled=true", "app.media.processing.max-retries=2",
    "app.worker.diarization.enabled=true", "app.worker.diarization.infrastructure-verified=true",
    "app.worker.diarization.storage-id=spk11", "app.worker.transcription.enabled=true",
    "app.worker.transcription.storage-id=spk11", "app.transport.private.enabled=true",
    "app.transport.private.hostname=localhost"})
@AutoConfigureMockMvc
@Import(Spk11FullStackSmokeTests.RabbitConfiguration.class)
@DirtiesContext
class Spk11FullStackSmokeTests {
    static final String QUEUE="meeting.processing.diarization";
    static Spk11Infrastructure infra;
    static int privatePort;
    static final Path AI=Path.of("../ai").toAbsolutePath().normalize();
    static final JsonNode FIXTURE=readFixture();
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc mvc;
    @Autowired MediaProperties properties;
    @Autowired MediaRepository mediaRepository;
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired ProcessingJobLifecycleService recovery;
    @Autowired TranscriptFinalizationService finalization;
    @Autowired TranscriptRepository transcripts;
    @Autowired DiarizationWorkerService worker;
    @Autowired DiarizationCompletion completion;
    @Autowired ObjectStorage storage;
    @Autowired TransactionTemplate transactions;
    @Autowired RabbitTemplate rabbit;
    @Autowired CachingConnectionFactory connectionFactory;
    RabbitAdmin admin;
    UUID actor,meeting,media,job,stage,event,transcript;
    List<Map<String,Object>> upstream;

    static JsonNode readFixture() {
        try {return WorkerJson.MAPPER.readTree(Files.readString(AI.resolve("tests/fixtures/diarization-smoke.json")));}
        catch(IOException failure) {throw new IllegalStateException("SPK11 fixture unavailable",failure);}
    }

    @DynamicPropertySource static void infrastructure(DynamicPropertyRegistry registry) throws Exception {
        infra=new Spk11Infrastructure();
        try(var socket=new java.net.ServerSocket(0)) {privatePort=socket.getLocalPort();}
        registry.add("spring.datasource.url",infra.postgres::getJdbcUrl);
        registry.add("spring.datasource.username",infra.postgres::getUsername);
        registry.add("spring.datasource.password",infra.postgres::getPassword);
        registry.add("app.transport.private.port",()->privatePort);
        registry.add("app.transport.private.certificate",()->infra.directory.resolve("server.crt").toString());
        registry.add("app.transport.private.key",()->infra.directory.resolve("server.key").toString());
        registry.add("app.transport.private.issuer-ca",()->infra.directory.resolve("ca.crt").toString());
        registry.add("app.transport.private.client-ca",()->infra.directory.resolve("ca.crt").toString());
        registry.add("app.media.storage.endpoint",infra::storageUrl);
        registry.add("app.media.storage.bucket",()->Spk11Infrastructure.BUCKET);
        registry.add("app.media.storage.access-key",()->Spk11Infrastructure.USER);
        registry.add("app.media.storage.secret-key",()->Spk11Infrastructure.PASSWORD);
        registry.add("app.media.storage.ca-file",()->infra.directory.resolve("ca.crt").toString());
    }

    @TestConfiguration(proxyBeanMethods=false) static class RabbitConfiguration {
        @Bean CachingConnectionFactory connectionFactory() throws Exception {return infra.rabbit();}
    }

    @AfterAll static void cleanup() throws Exception {if(infra!=null) infra.close();}

    @BeforeEach void admitAndFinalizeSyntheticTranscript() throws Exception {
        admin=new RabbitAdmin(connectionFactory);
        var exchange=new DirectExchange("meeting.processing",true,false); admin.declareExchange(exchange);
        for(String queue:List.of(QUEUE,"meeting.processing.jobs")) {
            admin.declareQueue(QueueBuilder.durable(queue).quorum().withArgument("x-delivery-limit",5).build());
            admin.declareBinding(new Binding(queue,Binding.DestinationType.QUEUE,exchange.getName(),
                queue.equals(QUEUE)?"processing.diarization.requested":"processing.job.queued",null));
            admin.purgeQueue(queue);
        }
        rabbit.setMandatory(true);
        actor=UUID.randomUUID();meeting=UUID.randomUUID();media=UUID.randomUUID();
        byte[] audio=syntheticWav();
        jdbc.update("INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status) VALUES (?,?,?,'SPK11','test','EMPLOYEE','ACTIVE')",actor,actor+"@spk11.invalid",actor+"@spk11.invalid");
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'SPK11',?,?)",meeting,actor,actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,content_type,
              expected_size_bytes,size_bytes,duration_ms,sha256,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',?,?,3000,?,?,CURRENT_TIMESTAMP)
            """,media,meeting,sourceKey(),"meetings/"+meeting+"/pending/"+media,audio.length,audio.length,WorkerJson.sha256(audio),actor);
        infra.s3.putObject(b->b.bucket(Spk11Infrastructure.BUCKET).key(sourceKey()).ifNoneMatch("*"),RequestBody.fromBytes(audio));
        var admitted=mvc.perform(post("/api/v1/meetings/"+meeting+"/processing-jobs").principal(()->actor.toString())
            .header("Idempotency-Key",UUID.randomUUID().toString()).contentType(MediaType.APPLICATION_JSON)
            .content("{\"mediaId\":\""+media+"\"}")).andReturn().getResponse();
        assertThat(admitted.getStatus()).as("Core business admission").isEqualTo(202);
        job=UUID.fromString(WorkerJson.MAPPER.readTree(admitted.getContentAsString()).path("data").path("id").asText());
        var asr=lifecycle.startStage(job,"TRANSCRIPTION",null,null);lifecycle.completeStage(asr,"SUCCEEDED",null,null);
        var correction=lifecycle.startStage(job,"CONTEXTUAL_CORRECTION",null,null);
        lifecycle.completeStage(correction,"SUCCEEDED",null,"{\"contextScope\":\"WHOLE_MEETING\",\"outputSha256\":\""+TranscriptCorrectionDigest.sha256(result(correction.stageRunId()))+"\",\"promptVersion\":\"spk11\"}");
        var finalizer=lifecycle.startStage(job,"FINALIZING_TRANSCRIPT",null,null);
        finalization.finalizeTranscript(finalizer,result(finalizer.stageRunId()));
        transcript=jdbc.queryForObject("SELECT id FROM transcripts WHERE processing_job_id=?",UUID.class,job);
        dispatch();upstream=upstream();
        assertThat(worker.status(job,event).get("state")).isEqualTo("AVAILABLE");
        assertThat(count("diarization_worker_claims")).isZero();
        assertThat(transcripts.current(meeting).orElseThrow().status()).isEqualTo("READY");
        publish();
    }

    TranscriptResult result(UUID producer) {
        var segments=new ArrayList<SegmentResult>();
        for(var s:FIXTURE.path("segments")) segments.add(new SegmentResult(s.path("ordinal").asInt(),s.path("startMs").asLong(),
            s.path("endMs").asLong(),s.path("text").asText(),"ACCEPTED",null,producer,null));
        return new TranscriptResult(meeting,media,job,producer,"vi",3000L,Status.READY,segments,
            List.of(new CoverageResult(100,2900,"COVERED",false,0,null)),List.of());
    }

    void dispatch() {
        stage=jdbc.queryForObject("SELECT id FROM processing_stage_runs WHERE processing_job_id=? AND stage_code='DIARIZING' ORDER BY attempt_number DESC LIMIT 1",UUID.class,job);
        event=jdbc.queryForObject("SELECT event_id FROM processing_diarization_dispatches WHERE stage_run_id=?",UUID.class,stage);
    }
    void publish() {
        new OutboxPublisher(mediaRepository,rabbit,properties).publishPending();
        assertThat(jdbc.queryForObject("SELECT status FROM outbox_events WHERE id=?",String.class,event)).isEqualTo("PUBLISHED");
    }
    String sourceKey() {return "meetings/"+meeting+"/sources/"+media;}
    String resultKey() {return DiarizationWorkerRepository.resultKey(job,stage);}
    long count(String table) {return jdbc.queryForObject("SELECT count(*) FROM "+table+" WHERE processing_job_id=?",Long.class,job);}
    long revision() {return jdbc.queryForObject("SELECT content_revision FROM transcripts WHERE id=?",Long.class,transcript);}
    long clusters() {return jdbc.queryForObject("SELECT count(*) FROM speaker_clusters WHERE transcript_id=?",Long.class,transcript);}
    String stageStatus() {return jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",String.class,stage);}
    String jobStatus() {return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?",String.class,job);}
    UUID segment() {return transcripts.current(meeting).orElseThrow().segments().getFirst().id();}
    List<Map<String,Object>> upstream() {return jdbc.queryForList("SELECT * FROM processing_stage_runs WHERE processing_job_id=? AND stage_code<>'DIARIZING' ORDER BY stage_code",job);}
    List<Map<String,Object>> content() {return jdbc.queryForList("SELECT id,ordinal,start_ms,end_ms,current_text,quality_status,source_stage_run_id FROM transcript_segments WHERE transcript_id=? ORDER BY ordinal",transcript);}

    void retry() throws Exception {
        var response=mvc.perform(post("/api/v1/processing-jobs/"+job+"/retry").principal(()->actor.toString())
            .header("Idempotency-Key",UUID.randomUUID().toString()).contentType(MediaType.APPLICATION_JSON)
            .content("{\"stageCode\":\"DIARIZING\"}")).andReturn().getResponse();
        assertThat(response.getStatus()).as("Authorized isolated diarization retry").isEqualTo(202);
        dispatch();publish();assertThat(upstream()).isEqualTo(upstream);
    }

    void accepted(String scenario,List<Map<String,Object>> before) throws Exception {
        var expected=FIXTURE.path("scenarios").path(scenario);
        List<String> labels=new ArrayList<>();expected.path("labels").forEach(n->labels.add(n.asText()));
        assertThat(transcripts.speakers(meeting)).extracting(s->s.label()).containsExactlyInAnyOrderElementsOf(labels);
        List<String> assignments=new ArrayList<>();expected.path("assignments").forEach(n->assignments.add(n.isNull()?null:n.asText()));
        assertThat(transcripts.current(meeting).orElseThrow().segments()).extracting(s->s.speakerLabel()).containsExactlyElementsOf(assignments);
        assertThat(clusters()).isEqualTo(labels.size());assertThat(content()).isEqualTo(before);
        assertThat(upstream()).isEqualTo(upstream);
        assertThat(stageStatus()).isEqualTo("SUCCEEDED");assertThat(jobStatus()).isEqualTo("COMPLETED");
        assertThat(count("diarization_worker_receipts")).isGreaterThanOrEqualTo(1);
        assertThat(worker.status(job,event)).containsEntry("state","RESULT_ACCEPTED").containsEntry("acknowledge",true);
        var artifact=WorkerJson.MAPPER.readTree(storage.readBounded(resultKey(),16777216));
        assertThat(artifact.path("speakerLabels")).isEqualTo(expected.path("labels"));
        var turns=artifact.path("turns");assertThat(turns.size()).isEqualTo(expected.path("turns").size());
        for(int i=0;i<turns.size();i++) {
            assertThat(turns.get(i).path("startMs").asInt()).isEqualTo(expected.path("turns").get(i).get(0).asInt());
            assertThat(turns.get(i).path("endMs").asInt()).isEqualTo(expected.path("turns").get(i).get(1).asInt());
            assertThat(turns.get(i).path("speakerLabel").asText()).isEqualTo(expected.path("turns").get(i).get(2).asText());
        }
        assertThat(storage.readBounded(sourceKey(),16777216)).isEqualTo(syntheticWav());
    }

    @ParameterizedTest @ValueSource(strings={"one","two","overlap","zero"})
    void successPersistsCanonicalSpeakersAndPreservesEvidence(String scenario) throws Exception {
        var before=content();try(var process=process(scenario,null,Map.of())) {
            var stats=process.finished();
            assertThat(stats.path("acks").asInt()).as("Worker terminal ACK; sanitized counters: %s",stats).isEqualTo(1);
        }
        accepted(scenario,before);assertThat(revision()).isEqualTo(scenario.equals("zero")?0:1);
        assertThat(count("diarization_worker_claims")).isEqualTo(1);
    }

    @ParameterizedTest @ValueSource(strings={"auth","timeout","rate-persistent"})
    void providerFailureIsOptionalSanitizedAndIndependent(String mode) throws Exception {
        var before=content();
        // Required downstream work must wait for terminal optional failure, then proceed.
        jdbc.update("INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status) VALUES (?,?,'INDEXING',1,'PENDING')",UUID.randomUUID(),job);
        try(var process=process(mode,null,Map.of())) {
            var stats=process.finished();assertThat(stats.path("acks").asInt()).isEqualTo(1);
            assertThat(stats.path("predictions").asInt()).isEqualTo(mode.equals("rate-persistent")?3:0);
            assertThat(stats.path("failures").asInt()).isEqualTo(1);assertThat(stats.path("completes").asInt()).isZero();
        }
        assertThat(stageStatus()).isEqualTo("FAILED");assertThat(content()).isEqualTo(before);assertThat(clusters()).isZero();
        assertThat(transcripts.current(meeting).orElseThrow().status()).isEqualTo("READY");
        assertThat(worker.status(job,event)).containsEntry("state","FAILURE_RECORDED");
        var indexing=lifecycle.startStage(job,"INDEXING",null,null);lifecycle.completeStage(indexing,"SUCCEEDED",null,null);lifecycle.completeJob(job);
        assertThat(jobStatus()).isEqualTo("COMPLETED_WITH_WARNINGS");
    }

    @Test void transientRateLimitRecoversWithinBudget() throws Exception {
        var before=content();try(var process=process("rate-transient",null,Map.of())) {
            var stats=process.finished();assertThat(stats.path("predictions").asInt()).isEqualTo(2);
            assertThat(stats.path("backoffs").size()).isEqualTo(1);
            assertThat(stats.path("backoffs").get(0).asDouble()).isEqualTo(2.0);
        } accepted("two",before);
    }

    @Test void isolatedRetryDoesNotExecuteOrRefinalizeUpstream() throws Exception {
        var before=content();UUID failed=stage,failedEvent=event;
        try(var process=process("timeout",null,Map.of())) {process.finished();}
        retry();assertThat(stage).isNotEqualTo(failed);assertThat(event).isNotEqualTo(failedEvent);
        try(var process=process("two",null,Map.of())) {assertThat(process.finished().path("uploads").asInt()).isEqualTo(1);}
        accepted("two",before);assertThat(count("diarization_worker_claims")).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",String.class,failed)).isEqualTo("FAILED");
    }

    @Test void duplicateAndLostCompletionResponseReturnOriginalReceiptWithoutInference() throws Exception {
        var before=content();try(var process=process("two",null,Map.of("lose_response",true,"replay",true))) {
            assertThat(process.finished().path("acks").asInt()).isEqualTo(1);
        }
        var receipt=worker.status(job,event);var speakers=transcripts.speakers(meeting);
        var notification=notification();rabbit.send("meeting.processing","processing.diarization.requested",notification);
        try(var process=process("two",null,Map.of())) {
            var stats=process.finished();assertThat(stats.path("uploads").asInt()).isZero();assertThat(stats.path("claims").asInt()).isZero();
            assertThat(stats.path("acks").asInt()).isEqualTo(1);
        }
        accepted("two",before);assertThat(worker.status(job,event)).isEqualTo(receipt);
        assertThat(transcripts.speakers(meeting)).isEqualTo(speakers);assertThat(revision()).isEqualTo(1);
    }

    @Test void twoPythonProcessesRacingTheSameEventHaveOneAuthorizedOwner() throws Exception {
        var before=content();
        try(var first=process("two","before-claim",Map.of())) {
            first.paused("before-claim");rabbit.send("meeting.processing","processing.diarization.requested",notification());
            try(var second=process("two","before-claim",Map.of())) {
                second.paused("before-claim");first.resume();second.resume();
                var one=first.finished();var two=second.finished();
                assertThat(one.path("uploads").asInt()+two.path("uploads").asInt()).isEqualTo(1);
                assertThat(count("diarization_worker_claims")).isEqualTo(1);
                assertThat(count("diarization_worker_receipts")).isEqualTo(1);
            }
        }
        accepted("two",before);
    }

    @ParameterizedTest @ValueSource(strings={"before-claim","claimed","inference","uploaded","accepted"})
    void abruptWorkerRestartHonorsDurableOwnership(String checkpoint) throws Exception {
        var before=content();UUID previousEvent=event;
        try(var process=process("two",checkpoint,Map.of())) {process.paused(checkpoint);}
        if(!checkpoint.equals("before-claim") && !checkpoint.equals("accepted")) {
            // Redelivery alone cannot steal a live execution or mint another token.
            try(var competing=process("two",null,Map.of())) {
                var stats=competing.finished();assertThat(stats.path("acks").asInt()).isZero();assertThat(stats.path("uploads").asInt()).isZero();
            }
            assertThat(count("diarization_worker_claims")).isEqualTo(1);
            expire();recovery.expireAbandonedStages();
            assertThat(worker.status(job,previousEvent)).containsEntry("state","FAILURE_RECORDED");
            try(var terminal=process("two",null,Map.of())) {assertThat(terminal.finished().path("acks").asInt()).isEqualTo(1);}
            retry();
        }
        try(var recovered=process("two",null,Map.of())) {
            var stats=recovered.finished();assertThat(stats.path("acks").asInt()).isEqualTo(1);
            assertThat(stats.path("uploads").asInt()).isEqualTo(checkpoint.equals("accepted")?0:1);
        }
        accepted("two",before);assertThat(revision()).isEqualTo(1);
    }

    @Test void interruptedBrokerAckReconcilesAcceptedResult() throws Exception {
        var before=content();try(var process=process("two",null,Map.of("lose_ack",true))) {
            assertThat(process.finished().path("acks").asInt()).isZero();
        }
        var receipt=worker.status(job,event);
        try(var process=process("two",null,Map.of())) {var stats=process.finished();assertThat(stats.path("uploads").asInt()).isZero();assertThat(stats.path("acks").asInt()).isEqualTo(1);}
        assertThat(worker.status(job,event)).isEqualTo(receipt);accepted("two",before);
    }

    @Test void humanTranscriptEditDuringInferenceRejectsPinnedResult() throws Exception {
        try(var process=process("two","inference",Map.of())) {
            process.paused("inference");
            transactions.executeWithoutResult(tx->transcripts.correct(meeting,segment(),actor,"Nội dung đã được duyệt.","Review",0));
            assertThat(revision()).isEqualTo(1);var human=content();process.resume();
            assertThat(process.finished().path("acks").asInt()).isZero();assertThat(content()).isEqualTo(human);
        }
        assertThat(clusters()).isZero();assertThat(count("diarization_worker_receipts")).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM transcript_segment_revisions WHERE segment_id=?",Long.class,segment())).isEqualTo(1);
    }

    @Test void activeHumanSpeakerMappingAndHistorySurviveInference() throws Exception {
        UUID cluster=UUID.randomUUID();
        jdbc.update("INSERT INTO speaker_clusters(id,transcript_id,label) VALUES (?,?,'SPEAKER_01')",cluster,transcript);
        try(var process=process("two","inference",Map.of())) {
            process.paused("inference");
            transactions.executeWithoutResult(tx->transcripts.mapSpeaker(meeting,cluster,actor,actor,transcript,0));
            var history=jdbc.queryForList("SELECT * FROM speaker_mappings WHERE speaker_cluster_id=?",cluster);
            var speakers=transcripts.speakers(meeting);assertThat(revision()).isEqualTo(1);process.resume();
            assertThat(process.finished().path("acks").asInt()).isZero();
            assertThat(transcripts.speakers(meeting)).isEqualTo(speakers);
            assertThat(jdbc.queryForList("SELECT * FROM speaker_mappings WHERE speaker_cluster_id=?",cluster)).isEqualTo(history);
        }
        assertThat(count("diarization_worker_receipts")).isZero();assertThat(clusters()).isEqualTo(1);
    }

    @Test void expiredOwnerCannotPublishOrOverwriteNewerAttempt() throws Exception {
        var before=content();DiarizationCommands.Complete stale;
        try(var process=process("two","uploaded",Map.of())) {
            process.paused("uploaded");stale=completionCommand();expire();process.resume();
            assertThat(process.finished().path("acks").asInt()).isZero();
        }
        assertThat(clusters()).isZero();recovery.expireAbandonedStages();
        assertThat(worker.status(job,event)).containsEntry("state","FAILURE_RECORDED");
        // This single-delivery harness must ACK the old durable failure before
        // publishing a new attempt, otherwise it consumes only the old redelivery.
        try(var terminal=process("two",null,Map.of())) {
            var stats=terminal.finished();assertThat(stats.path("acks").asInt()).isEqualTo(1);
            assertThat(stats.path("claims").asInt()).isZero();assertThat(stats.path("uploads").asInt()).isZero();
        }
        retry();
        try(var process=process("two",null,Map.of())) {
            var stats=process.finished();
            assertThat(stats.path("uploads").asInt()).as("Retry execution; sanitized counters: %s; new attempt state: %s",
                stats,worker.status(job,event).get("state")).isEqualTo(1);
            assertThat(stats.path("claims").asInt()).isEqualTo(1);assertThat(stats.path("acks").asInt()).isEqualTo(1);
        }
        var accepted=worker.status(job,event);var speakers=transcripts.speakers(meeting);
        assertThatThrownBy(()->completion.complete(job,stale)).isInstanceOf(com.sme.meetingassistant.api.media.worker.WorkerException.class);
        assertThat(transcripts.speakers(meeting)).isEqualTo(speakers);assertThat(worker.status(job,event)).isEqualTo(accepted);accepted("two",before);
    }

    @Test void databaseFailureRollsBackProjectionReceiptStageAndJobThenOriginalCommandRecovers() throws Exception {
        var before=content();
        // A real PostgreSQL error after projection, receipt and stage-success writes,
        // at the resulting terminal job transition in the same transaction.
        jdbc.execute("CREATE FUNCTION spk11_acceptance_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SPK11 injected acceptance fault'; END $$");
        jdbc.execute("CREATE TRIGGER spk11_acceptance_fault AFTER UPDATE OF status ON processing_jobs FOR EACH ROW WHEN (NEW.status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')) EXECUTE FUNCTION spk11_acceptance_fault()");
        try {
            try(var process=process("two",null,Map.of())) {assertThat(process.finished().path("acks").asInt()).isZero();}
            assertThat(worker.status(job,event)).containsEntry("state","RESULT_VERIFIED").containsEntry("acknowledge",false);
            assertThat(clusters()).isZero();assertThat(content()).isEqualTo(before);assertThat(revision()).isZero();
            assertThat(count("diarization_worker_receipts")).isZero();assertThat(count("diarization_worker_verifications")).isEqualTo(1);
            assertThat(stageStatus()).isEqualTo("RUNNING");assertThat(jobStatus()).isEqualTo("RUNNING");
        } finally {
            jdbc.execute("DROP TRIGGER spk11_acceptance_fault ON processing_jobs");jdbc.execute("DROP FUNCTION spk11_acceptance_fault()");
        }
        // Exact original authorized command, not a manufactured acceptance or new inference.
        var command=completionCommand();assertThat(completion.complete(job,command).get("state")).isEqualTo("RESULT_ACCEPTED");
        try(var recovered=process("two",null,Map.of())) {var stats=recovered.finished();assertThat(stats.path("uploads").asInt()).isZero();assertThat(stats.path("acks").asInt()).isEqualTo(1);}
        accepted("two",before);
    }

    @Test void immutableStorageRejectsUnconditionalAndConflictingWrites() throws Exception {
        try(var process=process("two",null,Map.of())) {process.finished();}
        byte[] accepted=storage.readBounded(resultKey(),16777216);
        assertThatThrownBy(()->infra.s3.putObject(b->b.bucket(Spk11Infrastructure.BUCKET).key(resultKey()),RequestBody.fromString("corrupt")))
            .isInstanceOfSatisfying(S3Exception.class,e->assertThat(e.statusCode()).isEqualTo(403));
        assertThatThrownBy(()->infra.s3.putObject(b->b.bucket(Spk11Infrastructure.BUCKET).key(resultKey()).ifNoneMatch("*"),RequestBody.fromString("corrupt")))
            .isInstanceOfSatisfying(S3Exception.class,e->assertThat(e.statusCode()).isEqualTo(412));
        assertThat(storage.readBounded(resultKey(),16777216)).isEqualTo(accepted);
    }

    @Test void unauthorizedIdentityCannotClaimOrRetrieveSnapshot() throws Exception {
        try(var client=HttpClient.newBuilder().sslContext(PemTls.clientContext(infra.directory.resolve("core.crt"),infra.directory.resolve("core.key"),
            infra.directory.resolve("ca.crt"),infra.directory.resolve("ca.crt"),"urn:sme:service:core-api")).build()) {
            for(String operation:List.of("claim","snapshot")) {
                var response=client.send(HttpRequest.newBuilder(URI.create("https://localhost:"+privatePort+"/internal/v1/worker/processing-jobs/"+job+"/diarization/"+operation))
                    .header("Content-Type","application/json").header("X-Request-Id","spk11").POST(HttpRequest.BodyPublishers.ofString("{}")).build(),HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(403);assertThat(response.body()).doesNotContain("claimToken","segments","objectKey");
            }
        }
        assertThat(count("diarization_worker_claims")).isZero();
    }

    void expire() {jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",stage);}
    DiarizationCommands.Complete completionCommand() throws Exception {
        var c=jdbc.queryForMap("SELECT claim_token FROM diarization_worker_claims WHERE event_id=?",event);
        var commands=jdbc.queryForList("SELECT command_id FROM diarization_worker_commands WHERE event_id=? AND command_type='COMPLETE'",UUID.class,event);
        UUID command=commands.isEmpty()?UUID.randomUUID():commands.getFirst();
        return new DiarizationCommands.Complete(command,new DiarizationCommands.Owner(event,stage,(UUID)c.get("claim_token")),WorkerJson.sha256(storage.readBounded(resultKey(),16777216)),stage);
    }
    Message notification() {
        byte[] payload=jdbc.queryForObject("SELECT payload::text FROM outbox_events WHERE id=?",String.class,event).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        return MessageBuilder.withBody(payload).setContentType("application/json").setDeliveryMode(MessageDeliveryMode.PERSISTENT)
            .setMessageId(event.toString()).setHeader("eventId",event.toString()).setHeader("eventType","PROCESSING_DIARIZATION_REQUESTED").setHeader("eventSchemaVersion",1).build();
    }

    WorkerProcess process(String mode,String pause,Map<String,Object> faults) throws Exception {
        var settings=new LinkedHashMap<String,Object>();
        settings.putAll(Map.of("service_name","spk11","service_identity","ai-worker","environment","test","diarization_enabled",true,
            "replicate_api_token","spk11-synthetic-only","diarization_timeout_seconds",mode.equals("timeout")?0.05:10));
        settings.putAll(Map.of("core_api_base_url","https://localhost:"+privatePort,"core_api_server_ca_file",infra.directory.resolve("ca.crt").toString(),
            "core_api_client_cert_file",infra.directory.resolve("worker.crt").toString(),"core_api_client_key_file",infra.directory.resolve("worker.key").toString()));
        settings.putAll(Map.of("rabbitmq_url","amqps://localhost:"+infra.broker.getMappedPort(5671)+"/","rabbitmq_username",Spk11Infrastructure.USER,
            "rabbitmq_password",Spk11Infrastructure.PASSWORD,"rabbitmq_ca_file",infra.directory.resolve("ca.crt").toString()));
        settings.putAll(Map.of("s3_endpoint_url",infra.storageUrl(),"s3_storage_id","spk11","s3_bucket",Spk11Infrastructure.BUCKET,
            "s3_access_key_id",Spk11Infrastructure.USER,"s3_secret_access_key",Spk11Infrastructure.PASSWORD,"s3_ca_file",infra.directory.resolve("ca.crt").toString(),
            "audio_temp_dir",infra.audioDirectory.toString()));
        var config=new LinkedHashMap<String,Object>(faults);config.put("settings",settings);config.put("mode",mode);if(pause!=null) config.put("pause",pause);
        return new WorkerProcess(config);
    }

    static class WorkerProcess implements AutoCloseable {
        final Process process;
        final BufferedReader output;
        final BufferedWriter input;
        WorkerProcess(Map<String,Object> config) throws Exception {
            this(config,System.getenv().getOrDefault("SPK11_PYTHON",AI.resolve(".venv/bin/python").toString()),
                "-m","integration.spk11_worker_process");
        }
        WorkerProcess(Map<String,Object> config,String... command) throws Exception {
            var builder=new ProcessBuilder(command).directory(AI.toFile()).redirectError(ProcessBuilder.Redirect.DISCARD);
            builder.environment().clear();builder.environment().put("PATH",System.getenv().getOrDefault("PATH","/usr/bin:/bin"));
            builder.environment().put("LANG","C.UTF-8");builder.environment().put("PYTHONPATH",AI.resolve("tests")+":"+AI.resolve("src"));
            try {process=builder.start();}
            catch(IOException failure) {throw new IOException("SPK11_WORKER_LAUNCH_FAILED");}
            output=process.inputReader();input=process.outputWriter();
            input.write(WorkerJson.MAPPER.writeValueAsString(config));input.newLine();input.flush();
        }
        JsonNode next() throws Exception {
            try(var pool=Executors.newVirtualThreadPerTaskExecutor()) {
                var read=pool.submit(()->readEnvelope(output));
                try {
                    String line=read.get(90,TimeUnit.SECONDS);
                    if(line==null) {
                        String exit=process.waitFor(2,TimeUnit.SECONDS)?Integer.toString(process.exitValue()):"RUNNING";
                        throw new AssertionError("SPK11_WORKER_EXIT_WITHOUT_ENVELOPE exitCode="+exit);
                    }
                    return decode(line);
                } catch(TimeoutException failure) {
                    process.destroyForcibly();throw new AssertionError("SPK11_WORKER_CHECKPOINT_TIMEOUT");
                } catch(ExecutionException failure) {
                    process.destroyForcibly();throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
                }
            }
        }
        static String readEnvelope(Reader output) throws IOException {
            var line=new StringBuilder();
            for(int value;(value=output.read())!=-1;) {
                if(value=='\n') return line.toString();
                if(line.length()>=4096) throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
                line.append((char)value);
            }
            if(!line.isEmpty()) throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
            return null;
        }
        static JsonNode decode(String line) {
            JsonNode message;
            try {message=WorkerJson.MAPPER.readTree(line);}
            catch(Exception failure) {throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");}
            if(message==null || !message.isObject()) throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
            if(message.has("failure")) {
                String phase=message.path("phase").asText(),category=message.path("category").asText();
                if(message.size()!=3 || !message.path("failure").asText().equals("SPK11_WORKER_PROCESS_FAILED")
                    || !Set.of("CONFIGURATION","PROVIDER_SETUP","TEMP_STORAGE","CORE_MTLS","RABBITMQ","WORKER_STARTUP","RUNTIME").contains(phase)
                    || !Set.of("VALIDATION","CONFIGURATION","AUTHENTICATION","FILESYSTEM","TIMEOUT","TRANSPORT","RESOURCE","INTERRUPTED","UNEXPECTED").contains(category))
                    throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
                throw new AssertionError("SPK11_WORKER_PROCESS_FAILED phase="+phase+" category="+category);
            }
            String checkpoint=message.path("checkpoint").asText();
            if(!Set.of("before-claim","claimed","inference","uploaded","accepted","finished").contains(checkpoint))
                throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
            if(!checkpoint.equals("finished")) {
                if(message.size()!=1) throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
            } else {
                if(message.size()!=12) throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
                for(String count:List.of("claims","completes","failures","acks","uploads","predictions","lookups","core_errors","core_status","rejects")) {
                    var value=message.path(count);
                    if(!value.isIntegralNumber() || !value.canConvertToInt() || value.asInt()<0 || value.asInt()>1000000)
                        throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
                }
                var backoffs=message.path("backoffs");
                if(!backoffs.isArray() || backoffs.size()>32) throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
                for(var value:backoffs) if(!value.isNumber() || !(value.asDouble()>=0 && value.asDouble()<=30))
                    throw new AssertionError("SPK11_WORKER_PROTOCOL_INVALID");
            }
            return message;
        }
        void paused(String name) throws Exception {assertThat(next().path("checkpoint").asText()).isEqualTo(name);}
        void resume() throws Exception {input.write("continue\n");input.flush();}
        JsonNode finished() throws Exception {var stats=next();assertThat(stats.path("checkpoint").asText()).isEqualTo("finished");return stats;}
        @Override public void close() throws Exception {
            if(process.isAlive()) process.destroyForcibly();assertThat(process.waitFor(20,TimeUnit.SECONDS)).isTrue();output.close();input.close();
        }
    }

    static byte[] syntheticWav() {
        int rate=8000,frames=rate*3;var b=ByteBuffer.allocate(44+frames*2).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(36+frames*2).put("WAVEfmt ".getBytes()).putInt(16).putShort((short)1).putShort((short)1)
            .putInt(rate).putInt(rate*2).putShort((short)2).putShort((short)16).put("data".getBytes()).putInt(frames*2);
        for(int i=0;i<frames;i++) b.putShort((short)(4000*Math.sin(2*Math.PI*(i<rate?220:440)*i/rate)));
        return b.array();
    }
}
