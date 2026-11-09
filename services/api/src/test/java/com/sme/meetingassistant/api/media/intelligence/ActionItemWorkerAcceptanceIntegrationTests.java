package com.sme.meetingassistant.api.media.intelligence;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.integration.TranscriptFinalizationService;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.service.*;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.*;
import com.sme.meetingassistant.api.transport.*;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.*;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** Real sockets, mTLS/token filters, T01 ownership, handoff, canonical sink and PostgreSQL. */
@ActiveProfiles("test")
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.DEFINED_PORT,properties={
    "server.port=0","app.media.outbox.enabled=false","app.media.processing.stage-lease-sweep-ms=3600000",
    "app.mi.internal-result.enabled=true","app.mi.internal-result.token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "app.media.processing.action-item-handoff-enabled=true"})
@Import(PostgresTestConfiguration.class)
class ActionItemWorkerAcceptanceIntegrationTests {
    static final String TOKEN="A".repeat(43);
    static final Path PKI;
    static final int PORT;
    static {
        try {
            PKI=Files.createTempDirectory("aimi-t06-pki-");TestPki.create(PKI);
            TestPki.issue(PKI,"mi-other","URI:urn:sme:service:mi-worker","clientAuth","ca",false);
            try(var socket=new java.net.ServerSocket(0)) {PORT=socket.getLocalPort();}
        } catch(Exception e) {throw new ExceptionInInitializerError(e);}
    }
    @DynamicPropertySource static void transport(DynamicPropertyRegistry r) {
        r.add("app.transport.private.enabled",()->true);r.add("app.transport.private.address",()->"127.0.0.1");
        r.add("app.transport.private.port",()->PORT);r.add("app.transport.private.hostname",()->"localhost");
        r.add("app.transport.private.certificate",()->PKI.resolve("server.crt").toString());
        r.add("app.transport.private.key",()->PKI.resolve("server.key").toString());
        r.add("app.transport.private.issuer-ca",()->PKI.resolve("ca.crt").toString());
        r.add("app.transport.private.client-ca",()->PKI.resolve("ca.crt").toString());
    }
    @Autowired JdbcTemplate jdbc;
    @Autowired MediaRepository repository;
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired TranscriptFinalizationService finalization;
    @Autowired TransactionTemplate transactions;
    @Autowired IntelligenceWorkerService worker;
    @Autowired ProcessingIntelligenceSource sources;
    @Autowired com.sme.meetingassistant.api.media.MediaProperties properties;
    @org.springframework.boot.test.web.server.LocalServerPort int publicPort;
    @MockitoBean ObjectStorage storage;
    @MockitoBean IntelligenceWorkerCapability capability;
    final Map<String,byte[]> blobs=new ConcurrentHashMap<>();
    UUID actor,meeting,media,job,event,stage;

    @BeforeEach void fixture() throws Exception {
        properties.getProcessing().setActionItemHandoffEnabled(true);
        reset(storage);blobs.clear();when(capability.canDispatch(anyString())).thenReturn(true);
        when(capability.storageId()).thenReturn("meeting-media");
        when(storage.putAcceptedIfAbsent(anyString(),any(Path.class),anyString())).thenAnswer(c->
            blobs.putIfAbsent(c.getArgument(0),Files.readAllBytes(c.getArgument(1)))==null);
        when(storage.head(anyString())).thenAnswer(c->new ObjectStorage.StoredObject(blobs.get((String)c.getArgument(0)).length,"application/json",null));
        when(storage.readBounded(anyString(),anyInt())).thenAnswer(c->blobs.get((String)c.getArgument(0)).clone());
        doAnswer(c->{Files.write(c.getArgument(1),blobs.get((String)c.getArgument(0)));return null;})
            .when(storage).downloadTo(anyString(),any(Path.class));
        doAnswer(c->{blobs.remove((String)c.getArgument(0));return null;}).when(storage).delete(anyString());
        actor=UUID.randomUUID();meeting=UUID.randomUUID();media=UUID.randomUUID();job=UUID.randomUUID();
        jdbc.update("INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status) VALUES (?,?,?,'T06','test','EMPLOYEE','ACTIVE')",actor,actor+"@t06.invalid",actor+"@t06.invalid");
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'T06',?,?)",meeting,actor,actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,content_type,
              expected_size_bytes,size_bytes,duration_ms,sha256,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,10000,?,?,CURRENT_TIMESTAMP)
            """,media,meeting,"meetings/"+meeting+"/sources/"+media,"meetings/"+meeting+"/pending/"+media,"c".repeat(64),actor);
        transactions.executeWithoutResult(tx->repository.insertJobAndOutbox(new MediaRepository.Job(job,meeting,media,
            "OFFLINE_MEETING_PROCESSING","PENDING",actor,null,0,null,null,null,null,null,null,
            OffsetDateTime.now(),OffsetDateTime.now()),UUID.randomUUID(),List.of("EXTRACTING_ACTION_ITEMS")));
        var asr=lifecycle.startStage(job,"TRANSCRIPTION",null,null);lifecycle.completeStage(asr,"SUCCEEDED",null,null);
        var correction=lifecycle.startStage(job,"CONTEXTUAL_CORRECTION",null,null);
        lifecycle.completeStage(correction,"SUCCEEDED",null,"{\"contextScope\":\"WHOLE_MEETING\",\"outputSha256\":\""+
            TranscriptCorrectionDigest.sha256(result(correction.stageRunId()))+"\",\"promptVersion\":\"t06-v1\"}");
        var finalize=lifecycle.startStage(job,"FINALIZING_TRANSCRIPT",null,null);
        finalization.finalizeTranscript(finalize,result(finalize.stageRunId()));
        event=jdbc.queryForObject("SELECT event_id FROM processing_intelligence_dispatches WHERE processing_job_id=?",UUID.class,job);
        stage=jdbc.queryForObject("SELECT stage_run_id FROM processing_intelligence_dispatches WHERE processing_job_id=?",UUID.class,job);
    }
    TranscriptResult result(UUID producer) {
        return new TranscriptResult(meeting,media,job,producer,"vi",10000L,Status.READY,
            List.of(new SegmentResult(0,100,1200,"Anh Minh kiểm tra lỗi đăng nhập và gửi kết quả cho nhóm.","ACCEPTED",null,producer,null)),
            List.of(new CoverageResult(100,1200,"COVERED",false,0,null)),List.of());
    }
    HttpClient client(String cert,String identity) {
        return HttpClient.newBuilder().sslContext(PemTls.clientContext(PKI.resolve(cert+".crt"),PKI.resolve(cert+".key"),
            PKI.resolve("ca.crt"),PKI.resolve("ca.crt"),"urn:sme:service:"+identity)).build();
    }
    HttpResponse<String> post(HttpClient client,String path,String body,String token) throws Exception {
        return post(client,path,body,token,false);
    }
    HttpResponse<String> post(HttpClient client,String path,String body,String token,boolean expectContinue) throws Exception {
        var builder=HttpRequest.newBuilder(URI.create("https://localhost:"+PORT+path)).header("Content-Type","application/json")
            .header("X-Request-Id","t06-test").timeout(java.time.Duration.ofSeconds(15));
        if(token!=null) builder.header("Authorization","Bearer "+token);
        if(expectContinue) builder.expectContinue(true);
        return client.send(builder.POST(HttpRequest.BodyPublishers.ofString(body)).build(),HttpResponse.BodyHandlers.ofString());
    }
    String control() {return "/internal/v1/worker/processing-jobs/"+job+"/intelligence/";}
    String acceptPath() {return "/internal/api/v1/meeting-intelligence/action-items/accept";}
    ObjectNode claim(HttpClient client) throws Exception {
        String body=WorkerJson.MAPPER.writeValueAsString(Map.of("contractVersion","1.0","eventId",event,
            "eventType","PROCESSING_INTELLIGENCE_STAGE_REQUESTED","eventSchemaVersion",1,"executionStageRunId",stage,
            "executionStageCode","EXTRACTING_ACTION_ITEMS","claimRequestId",UUID.randomUUID()));
        var response=post(client,control()+"claim",body,null);assertThat(response.statusCode()).isEqualTo(200);
        var data=(ObjectNode)WorkerJson.MAPPER.readTree(response.body()).get("data");assertThat(data.has("resultSlot")).isFalse();return data;
    }
    ObjectNode batch(JsonNode claim,boolean empty) {
        var source=claim.get("source");var input=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0")
            .put("eventId",event.toString()).put("stageRunId",stage.toString()).put("claimToken",claim.get("claimToken").asString());
        var pinned=input.putObject("source");
        for(String field:List.of("snapshotId","transcriptId","contentRevision","sha256")) pinned.set(field,source.get(field));
        var candidates=input.putArray("candidates");
        if(!empty) {
            UUID segment=jdbc.queryForObject("SELECT id FROM transcript_segments WHERE transcript_id=?",UUID.class,UUID.fromString(source.get("transcriptId").asString()));
            var candidate=candidates.addObject().put("candidateKey","action-test").put("title","kiểm tra lỗi đăng nhập").putNull("details").putNull("suggestedDueDate");
            candidate.putArray("evidenceSegmentIds").add(segment.toString());
        }
        return input;
    }
    long count(String table) {return jdbc.queryForObject("SELECT count(*) FROM "+table+" WHERE processing_job_id=?",Long.class,job);}
    void assertAccepted(int count) {
        assertThat(count("action_item_batch_receipts")).isEqualTo(1);assertThat(count("action_items")).isEqualTo(count);
        assertThat(worker.status(job,event)).containsEntry("state","RESULT_ACCEPTED").containsEntry("acknowledge",true);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM action_items WHERE processing_job_id=? AND (status<>'PROPOSED' OR source_type<>'AI_EXTRACTED' OR assignee_user_id IS NOT NULL)",Long.class,job)).isZero();
    }
    @Test void realCanonicalReceiptCompletesStageAndReplayCannotOverwriteIt() throws Exception {
        try(var mi=client("mi","mi-worker")) {
            var input=batch(claim(mi),false);
            assertThat(post(mi,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(200);assertAccepted(1);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM action_item_evidence WHERE action_item_id IN (SELECT id FROM action_items WHERE processing_job_id=?)",Long.class,job)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM action_item_history WHERE action_item_id IN (SELECT id FROM action_items WHERE processing_job_id=?)",Long.class,job)).isEqualTo(1);
            assertThat(post(mi,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(409);
            ((ObjectNode)input.get("candidates").get(0)).put("title","Divergent proposal");
            assertThat(post(mi,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(409);assertAccepted(1);
        }
    }
    @Test void emptyBatchHasDurableReceipt() throws Exception {
        try(var mi=client("mi","mi-worker")) {
            var input=batch(claim(mi),true);
            assertThat(post(mi,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(200);assertAccepted(0);
        }
    }
    @Test void independentMachineCredentialsAndOriginalOwnerAreRequired() throws Exception {
        try(var mi=client("mi","mi-worker");var wrong=client("worker","ai-worker");var core=client("core","core-api")) {
            var input=batch(claim(mi),false);
            for(String token:Arrays.asList(null,"bad","eyJhbGciOiJIUzI1NiJ9.user.jwt"))
                assertThat(post(mi,acceptPath(),input.toString(),token).statusCode()).isEqualTo(401);
            assertThat(post(wrong,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(403);
            assertThat(post(core,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(403);
            var cookie=HttpRequest.newBuilder(URI.create("https://localhost:"+PORT+acceptPath()))
                .header("Content-Type","application/json").header("Authorization","Bearer "+TOKEN)
                .header("Cookie","sma_at=browser").POST(HttpRequest.BodyPublishers.ofString(input.toString())).build();
            assertThat(mi.send(cookie,HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
            try(var plain=HttpClient.newHttpClient()) {
                var publicRequest=HttpRequest.newBuilder(URI.create("http://localhost:"+publicPort+acceptPath()))
                    .header("Content-Type","application/json").header("Authorization","Bearer "+TOKEN)
                    .POST(HttpRequest.BodyPublishers.ofString(input.toString())).build();
                assertThat(plain.send(publicRequest,HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
            }
            try(var otherOwner=client("mi-other","mi-worker")) {
                assertThat(post(otherOwner,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(409);
            }
            assertThat(count("action_item_batch_receipts")).isZero();
        }
    }
    @Test void supersededAndDisabledClaimsCannotCommit() throws Exception {
        try(var mi=client("mi","mi-worker")) {
            var input=batch(claim(mi),false);
            properties.getProcessing().setActionItemHandoffEnabled(false);
            assertThat(post(mi,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(503);
            properties.getProcessing().setActionItemHandoffEnabled(true);
            jdbc.update("INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status) VALUES (?,?,'EXTRACTING_ACTION_ITEMS',2,'PENDING')",UUID.randomUUID(),job);
            assertThat(post(mi,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(409);
            assertThat(count("action_item_batch_receipts")).isZero();assertThat(count("action_items")).isZero();
        }
    }
    @Test void dedicatedBatchLimitDoesNotWidenSmallControlLimits() throws Exception {
        try(var mi=client("mi","mi-worker")) {
            var input=batch(claim(mi),false);
            assertThat(post(mi,acceptPath()," ".repeat(4194305),TOKEN,true).statusCode()).isEqualTo(413);
            assertThat(post(mi,control()+"renew"," ".repeat(17000),null,true).statusCode()).isEqualTo(413);
            var duplicate=input.toString().replace("\"contractVersion\":\"1.0\"","\"contractVersion\":\"1.0\",\"contractVersion\":\"1.0\"");
            assertThat(post(mi,acceptPath(),duplicate,TOKEN).statusCode()).isEqualTo(422);
            ((ObjectNode)input.get("candidates").get(0)).put("details","ệ".repeat(8000));
            assertThat(post(mi,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(200);assertAccepted(1);
        }
    }
    @Test void eventSnapshotTokenForeignEvidenceAndExpiredOwnerFailWithoutPartialWrites() throws Exception {
        try(var mi=client("mi","mi-worker")) {
            var input=batch(claim(mi),false);
            for(String field:List.of("eventId","claimToken","stageRunId")) {
                var forged=input.deepCopy().put(field,UUID.randomUUID().toString());
                assertThat(post(mi,acceptPath(),forged.toString(),TOKEN).statusCode()).isIn(404,409,422);
            }
            var foreign=input.deepCopy();((ObjectNode)foreign.get("candidates").get(0)).putArray("evidenceSegmentIds").add(UUID.randomUUID().toString());
            assertThat(post(mi,acceptPath(),foreign.toString(),TOKEN).statusCode()).isEqualTo(422);
            var source=input.deepCopy();((ObjectNode)source.get("source")).put("snapshotId",UUID.randomUUID().toString());
            assertThat(post(mi,acceptPath(),source.toString(),TOKEN).statusCode()).isEqualTo(409);
            jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",stage);
            assertThat(post(mi,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(409);
            assertThat(count("action_item_batch_receipts")).isZero();assertThat(count("action_items")).isZero();
        }
    }
    @Test void lateCompletionFailureRollsBackRealSinkReceiptEvidenceAndHistory() throws Exception {
        try(var mi=client("mi","mi-worker")) {
            var input=batch(claim(mi),false);
            String name="t06_"+stage.toString().replace("-","");
            jdbc.execute("CREATE FUNCTION "+name+"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='"+stage+"'::uuid AND NEW.status='SUCCEEDED' THEN RAISE EXCEPTION 'forced completion failure'; END IF; RETURN NEW; END $$");
            jdbc.execute("CREATE TRIGGER "+name+" BEFORE UPDATE ON processing_stage_runs FOR EACH ROW EXECUTE FUNCTION "+name+"()");
            try {
                assertThat(post(mi,acceptPath(),input.toString(),TOKEN).statusCode()).isEqualTo(503);
                assertThat(count("action_item_batch_receipts")).isZero();assertThat(count("action_items")).isZero();
                assertThat(worker.status(job,event)).containsEntry("state","RUNNING");
            } finally {jdbc.execute("DROP TRIGGER "+name+" ON processing_stage_runs");jdbc.execute("DROP FUNCTION "+name+"()");}
        }
    }

    @Test void actualPythonCoordinatorAndBrokerAckFollowCanonicalAcceptanceIncludingResponseLossAndEmptyBatch() throws Exception {
        try(var broker=new org.testcontainers.containers.GenericContainer<>("rabbitmq:4.1-alpine")
                .withEnv("RABBITMQ_DEFAULT_USER","t06").withEnv("RABBITMQ_DEFAULT_PASS","isolated-t06-password")
                .withCopyToContainer(org.testcontainers.images.builder.Transferable.of("""
                    listeners.tcp = none
                    listeners.ssl.default = 5671
                    ssl_options.cacertfile = /etc/rabbitmq/ca.crt
                    ssl_options.certfile = /etc/rabbitmq/server.crt
                    ssl_options.keyfile = /etc/rabbitmq/server.key
                    ssl_options.verify = verify_none
                    ssl_options.fail_if_no_peer_cert = false
                    """.getBytes()),"/etc/rabbitmq/rabbitmq.conf")
                .withCopyToContainer(org.testcontainers.images.builder.Transferable.of(Files.readAllBytes(PKI.resolve("ca.crt")),0444),"/etc/rabbitmq/ca.crt")
                .withCopyToContainer(org.testcontainers.images.builder.Transferable.of(Files.readAllBytes(PKI.resolve("server.crt")),0444),"/etc/rabbitmq/server.crt")
                .withCopyToContainer(org.testcontainers.images.builder.Transferable.of(Files.readAllBytes(PKI.resolve("server.key")),0444),"/etc/rabbitmq/server.key")
                .withExposedPorts(5671).waitingFor(org.testcontainers.containers.wait.strategy.Wait.forListeningPort())
                .withStartupTimeout(java.time.Duration.ofSeconds(120))) {
            broker.start();
            for(String mode:List.of("normal","lost","empty")) {
                if(!mode.equals("normal")) fixture();
                if(mode.equals("empty")) jdbc.update("UPDATE transcript_segments SET current_text='Cảm ơn mọi người đã tham gia.' WHERE transcript_id IN (SELECT id FROM transcripts WHERE processing_job_id=?)",job);
                var source=sources.prepare(job,meeting,media,false);
                String eventJson=jdbc.queryForObject("SELECT payload::text FROM outbox_events WHERE id=?",String.class,event);
                var config=WorkerJson.MAPPER.createObjectNode().put("pki",PKI.toString()).put("mode",mode)
                    .put("coreUrl","https://localhost:"+PORT).put("brokerUrl","amqps://localhost:"+broker.getMappedPort(5671)+"/")
                    .put("brokerPort",broker.getMappedPort(5671)).put("snapshot",new String(blobs.get(source.objectKey()),java.nio.charset.StandardCharsets.UTF_8));
                config.set("event",WorkerJson.MAPPER.readTree(eventJson));
                Path ai=Path.of("../ai").toAbsolutePath().normalize();
                var command=new ProcessBuilder("uv","run","--no-sync","python","tests/integration/action_item_core_process.py").directory(ai.toFile());
                command.environment().put("PYTHONPATH",ai.resolve("src")+":"+ai.resolve("tests"));
                Path stderr=Files.createTempFile("t06-python-",".log");command.redirectError(stderr.toFile());
                var process=command.start();
                try(var stdin=process.getOutputStream()) {stdin.write(WorkerJson.MAPPER.writeValueAsBytes(config));}
                boolean finished=process.waitFor(90,java.util.concurrent.TimeUnit.SECONDS);
                if(!finished) process.destroyForcibly();
                String stdout=new String(process.getInputStream().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);
                assertThat(finished).as("Python coordinator timeout").isTrue();
                assertThat(process.exitValue()).as("Python coordinator stderr: %s",Files.readString(stderr)).isZero();
                var report=WorkerJson.MAPPER.readTree(stdout);
                assertThat(report.get("acknowledged").asInt()).isEqualTo(2);
                assertThat(report.get("modelCalls").asInt()).isEqualTo(1);
                assertThat(report.get("accepts").asInt()).isEqualTo(1);
                assertThat(report.get("redelivery").asBoolean()).isTrue();
                assertAccepted(mode.equals("empty")?0:1);
            }
        }
    }
}
