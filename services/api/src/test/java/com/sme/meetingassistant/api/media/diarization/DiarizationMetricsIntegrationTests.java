package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.*;

import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.OffsetDateTime;
import java.util.UUID;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.stream.Stream;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.*;
import org.springframework.test.annotation.DirtiesContext;

/** Real migrated PostgreSQL; only external storage/capability use fixture doubles. */
@DirtiesContext(classMode=DirtiesContext.ClassMode.BEFORE_CLASS)
class DiarizationMetricsIntegrationTests extends DiarizationIntegrationFixture {
    @BeforeEach void baselineView() throws Exception {
        try(var input=new org.springframework.core.io.ClassPathResource("db/migration/V38__diarization_verified_only_monitoring.sql").getInputStream()) {
            String sql=new String(input.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);
            jdbc.execute("CREATE OR REPLACE VIEW spk12_v38_baseline AS "+sql.split("CREATE VIEW diarization_verified_only_backlog AS",2)[1]);
        }
    }
    private void equivalentToV38() {
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM (
                (SELECT * FROM spk12_v38_baseline EXCEPT ALL SELECT * FROM diarization_verified_only_backlog)
                UNION ALL
                (SELECT * FROM diarization_verified_only_backlog EXCEPT ALL SELECT * FROM spk12_v38_baseline)
            ) differences
            """,Long.class)).as("V38 classification equivalence, including null bindings").isZero();
    }
    private DiarizationMetrics reader() { return new DiarizationMetrics(jdbc,new SimpleMeterRegistry()); }
    private DiarizationCommands.Complete verified() throws Exception {
        claim();var n=artifact();var cmd=upload(n);
        worker.registerVerified(job,cmd,WorkerJson.MAPPER.writeValueAsBytes(n).length);return cmd;
    }
    private OffsetDateTime now() { return jdbc.queryForObject("SELECT clock_timestamp()",OffsetDateTime.class); }
    private void backlog(long total,long active,long stale,long superseded) {
        equivalentToV38();
        var b=reader().read(now()).backlog();
        assertThat(b.outstanding()).isEqualTo(total);assertThat(b.actionable()).isEqualTo(active);
        assertThat(b.stale()).isEqualTo(stale);assertThat(b.superseded()).isEqualTo(superseded);
        assertThat(b.actionable()+b.stale()+b.superseded()).isEqualTo(b.outstanding());
    }
    @AfterEach void clearIsolatedTestEvidence() { jdbc.execute("TRUNCATE users CASCADE"); }

    @Test void verificationAcceptanceAndExactReplayReconstructWithoutInflation() throws Exception {
        backlog(0,0,0,0);var cmd=verified();backlog(1,1,0,0);
        var response=completion.complete(job,cmd);backlog(0,0,0,0);
        assertThat(completion.complete(job,cmd)).isEqualTo(response);backlog(0,0,0,0);
        assertThat(reader().read(now()).backlog().oldestAgeSeconds()).isZero();
        assertThat(count("diarization_acceptance_measurements")).isEqualTo(1);
    }
    @Test void durableFailureResolvesVerificationWithoutDeletingEvidence() throws Exception {
        verified();backlog(1,1,0,0);
        worker.fail(job,new DiarizationCommands.Fail(UUID.randomUUID(),owner,"INFERENCE","TIMEOUT"));
        backlog(0,0,0,0);assertThat(count("diarization_worker_verifications")).isEqualTo(1);
    }
    @Test void leaseExpiryBecomesStaleThenSweeperReceiptResolvesIt() throws Exception {
        verified();expire();backlog(1,0,1,0);sweeper.expireAbandonedStages();backlog(0,0,0,0);
        assertThat(reader().read(now()).leaseExpirations()).isEqualTo(1);
    }
    @Test void supersededEvidenceRemainsOutstandingButCannotBeActionable() throws Exception {
        verified();jdbc.update("INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status) VALUES (?,?,'DIARIZING',2,'PENDING')",UUID.randomUUID(),job);
        backlog(1,0,0,1);
    }
    @ParameterizedTest @ValueSource(strings={"revision","source","notCurrent","claim","job"})
    void staleBindingsCannotAppearActionable(String kind) throws Exception {
        verified();switch(kind) {
            case "revision" -> jdbc.update("UPDATE transcripts SET content_revision=1 WHERE id=?",transcript);
            case "source" -> jdbc.update("UPDATE meeting_media SET sha256=? WHERE id=?","b".repeat(64),media);
            case "notCurrent" -> jdbc.update("UPDATE transcripts SET is_current=false WHERE id=?",transcript);
            case "claim" -> jdbc.update("UPDATE processing_stage_runs SET claim_token=? WHERE id=?",UUID.randomUUID(),stage);
            default -> jdbc.update("UPDATE processing_jobs SET current_stage='INDEXING' WHERE id=?",job);
        }backlog(1,0,1,0);
    }
    @Test void oldVerificationAgeUsesPersistedTimeWithoutWindowExpiryAndSurvivesReaderRecreation() throws Exception {
        verified();var persisted=jdbc.queryForObject("SELECT verified_at FROM diarization_worker_verifications WHERE event_id=?",OffsetDateTime.class,event);
        var end=persisted.plusHours(49);var snapshot=reader().read(end);
        assertThat(snapshot.backlog().outstanding()).isEqualTo(1);
        assertThat(snapshot.backlog().oldestAgeSeconds()).isEqualTo(49*3600);
        assertThat(snapshot.backlog().stale()).isEqualTo(1);
        assertThat(reader().read(end)).isEqualTo(snapshot); // independent Core replica / restart
        assertThat(reader().read(end.plusDays(5)).backlog().outstanding()).isEqualTo(1);
    }
    @Test void rollbackCannotFabricateTerminalResolution() throws Exception {
        var cmd=verified();var bytes=WorkerJson.MAPPER.writeValueAsBytes(artifact());
        var result=DiarizationResultContract.validate(bytes,worker.completionContext(job,cmd),cmd.resultSha256());
        transactions.executeWithoutResult(tx->{worker.projectVerified(job,cmd,result);tx.setRollbackOnly();});
        backlog(1,1,0,0);assertThat(count("diarization_worker_receipts")).isZero();
        assertThat(count("diarization_acceptance_measurements")).isZero();
    }
    @Test void concurrentCompletionCreatesOneReceiptMeasurementAndNoBacklog() throws Exception {
        var cmd=verified();var gate=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            Callable<Object> action=()->{gate.await();return completion.complete(job,cmd);};
            var a=pool.submit(action);var b=pool.submit(action);gate.countDown();
            assertThat(a.get(20,TimeUnit.SECONDS)).isEqualTo(b.get(20,TimeUnit.SECONDS));
        }
        backlog(0,0,0,0);assertThat(count("diarization_worker_receipts")).isEqualTo(1);
        assertThat(count("diarization_acceptance_measurements")).isEqualTo(1);
    }
    static Stream<Arguments> durations() {
        return Stream.of(true,false).flatMap(success->Stream.of(0,30,31,120,121,300,301,900,901,3600,3601)
            .map(seconds->Arguments.of(success,seconds)));
    }
    @ParameterizedTest @MethodSource("durations")
    void executionDurationsAndEveryCumulativeBoundaryAreCorrect(boolean success,int seconds) throws Exception {
        claim();if(success) completion.complete(job,upload(artifact()));
        else worker.fail(job,new DiarizationCommands.Fail(UUID.randomUUID(),owner,"INFERENCE","TIMEOUT"));
        var end=OffsetDateTime.parse("2040-01-02T00:00:00Z");var completed=end.minusHours(1);
        jdbc.update("UPDATE processing_stage_runs SET created_at=?,started_at=?,completed_at=? WHERE id=?",
            completed.minusHours(4),completed.minusSeconds(seconds),completed,stage);
        var s=reader().read(end);
        assertThat(s.successfulDurationCount()).isEqualTo(success?1:0);
        assertThat(s.failedDurationCount()).isEqualTo(success?0:1);
        assertThat(s.successfulDurationSeconds()).isEqualTo(success?seconds:0);
        assertThat(s.failedDurationSeconds()).isEqualTo(success?0:seconds);
        long[] actual={s.latency30(),s.latency120(),s.latency300(),s.latency900(),s.latency3600(),s.successfulDurationCount()+s.failedDurationCount()};
        int[] bounds={30,120,300,900,3600,Integer.MAX_VALUE};
        for(int i=0;i<actual.length;i++) {assertThat(actual[i]).isEqualTo(seconds<=bounds[i]?1:0);if(i>0) assertThat(actual[i]).isGreaterThanOrEqualTo(actual[i-1]);}
        assertThat(reader().read(end)).isEqualTo(s);
        assertThat(reader().read(completed.plusHours(24)).successfulDurationCount()+reader().read(completed.plusHours(24)).failedDurationCount()).isEqualTo(1);
        assertThat(reader().read(completed).successfulDurationCount()+reader().read(completed).failedDurationCount()).isZero();
        var expired=reader().read(completed.plusHours(24).plusNanos(1_000_000));
        assertThat(expired.successfulDurationCount()+expired.failedDurationCount()).isZero();
    }
    @ParameterizedTest @ValueSource(strings={"incomplete","invalid","missingStart"})
    void incompleteAndInvalidTimingsAreExcluded(String kind) {
        claim();worker.fail(job,new DiarizationCommands.Fail(UUID.randomUUID(),owner,"INFERENCE","TIMEOUT"));
        if(kind.equals("incomplete")) jdbc.update("UPDATE processing_stage_runs SET completed_at=NULL WHERE id=?",stage);
        else if(kind.equals("invalid")) jdbc.update("UPDATE processing_stage_runs SET started_at=completed_at+interval '1 second' WHERE id=?",stage);
        else jdbc.update("UPDATE processing_stage_runs SET started_at=NULL WHERE id=?",stage);
        var s=reader().read(now());assertThat(s.failed()).isEqualTo(1);
        assertThat(s.failedDurationCount()).isZero();assertThat(s.failedDurationSeconds()).isZero();
        assertThat(s.latency3600()).isZero();
    }
    @Test void monitoringQueryHasIndexedAntiJoinAndNoTranscriptSegmentAccess() throws Exception {
        verified();
        double[] work=new double[2];
        for(int i=0;i<2;i++) {
            final int index=i;int jobs=i==0?512:2048;
            transactions.executeWithoutResult(tx->{
                seedRepresentativeHistory(jobs);
                work[index]=assertEfficientPlan("v33-representative-"+jobs,jobs*3+1);
                equivalentToV38();
                assertThat(jdbc.queryForObject("SELECT count(*) FROM diarization_verified_only_backlog",Long.class)).isEqualTo(1+jobs/16+jobs/64);
                var classified=jdbc.queryForMap("""
                    SELECT count(*) FILTER (WHERE superseded) superseded,
                        count(*) FILTER (WHERE NOT superseded AND current_binding AND lease_expires_at>transaction_timestamp()) actionable,
                        count(*) FILTER (WHERE NOT superseded AND NOT coalesce(current_binding AND lease_expires_at>transaction_timestamp(),false)) stale
                    FROM diarization_verified_only_backlog
                    """);
                assertThat(((Number)classified.get("actionable")).intValue()).isEqualTo(1+jobs/32);
                assertThat(((Number)classified.get("stale")).intValue()).isEqualTo(jobs/32);
                assertThat(((Number)classified.get("superseded")).intValue()).isEqualTo(jobs/64);
                tx.setRollbackOnly();
            });
        }
        // Four times the independently valid job histories must not cause superlinear work.
        assertThat(work[1]).isLessThanOrEqualTo(work[0]*4.5);
        backlog(1,1,0,0);
    }
    @Test void concentratedHistoricalAttemptsRemainBounded() throws Exception {
        verified();
        var definition=jdbc.queryForObject("SELECT pg_get_viewdef('diarization_verified_only_backlog'::regclass,true)",String.class);
        assertThat(definition).contains("diarization_worker_receipts","processing_diarization_dispatches","processing_stage_runs").doesNotContain("transcript_segments","current_text");
        transactions.executeWithoutResult(tx->{
            seedMonitoringHistory();
            assertEfficientPlan("v33-concentrated-4096",4097);
            equivalentToV38();
        });
        backlog(33,1,0,32);
        var end=now();var snapshot=reader().read(end);
        assertThat(snapshot.backlog().oldestAgeSeconds()).isGreaterThanOrEqualTo(49*3600);
        assertThat(reader().read(end)).isEqualTo(snapshot);
    }
    private double assertEfficientPlan(String name,int verifications) {
            for(String table:List.of("diarization_worker_verifications","diarization_worker_receipts",
                    "processing_diarization_dispatches","processing_stage_runs","processing_jobs",
                    "diarization_worker_claims","transcripts","meeting_media")) jdbc.execute("ANALYZE "+table);
            // Exercise classification too: count/min alone lets PostgreSQL prune those joins.
            // Full history scans of evidence are legitimate; repeated unbounded scans are not.
            assertThat(jdbc.queryForObject("SHOW enable_seqscan",String.class)).isEqualTo("on");
            String json=jdbc.queryForObject("""
                EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
                SELECT count(*), min(verified_at), count(*) FILTER (WHERE superseded),
                    count(*) FILTER (WHERE NOT superseded AND current_binding AND lease_expires_at>transaction_timestamp())
                FROM diarization_verified_only_backlog
                """,String.class);
            persistPlan(name,json);
            var plan=WorkerJson.MAPPER.readTree(json).get(0).path("Plan");
            var nodes=new ArrayList<tools.jackson.databind.JsonNode>();planNodes(plan,nodes);
            assertThat(plan.path("Node Type").asText()).isEqualTo("Aggregate");
            assertThat(plan.path("Actual Rows").asLong()).isEqualTo(1);
            assertThat(nodes).noneMatch(n->n.path("Relation Name").asText().equals("transcript_segments"));
            assertThat(nodes).anyMatch(n->n.path("Join Type").asText().equals("Anti"));
            assertThat(nodes).anyMatch(n->n.path("Node Type").asText().contains("Index")
                && List.of("processing_stage_runs","processing_diarization_dispatches").contains(n.path("Relation Name").asText()));
            double scanWork=nodes.stream().filter(n->n.has("Relation Name")).mapToDouble(n->n.path("Actual Loops").asDouble()
                *(n.path("Actual Rows").asDouble()+n.path("Rows Removed by Filter").asDouble()+n.path("Rows Removed by Index Recheck").asDouble())).sum();
            // Two evidence scans plus at most six binding lookups per unresolved row,
            // one top-attempt lookup per relevant job, and upstream fixture history.
            // Retains the original 20x ceiling even for concentrated adversarial data.
            assertThat(scanWork).as("bounded linear scan work for %s verifications",verifications).isLessThan(verifications*20);
            assertThat(plan.path("Shared Hit Blocks").asLong()+plan.path("Shared Read Blocks").asLong())
                .as("bounded buffer work, independent of wall-clock timing").isLessThan(verifications*50);
            var latest=nodes.stream().filter(n->n.path("Relation Name").asText().equals("processing_stage_runs")
                && n.path("Alias").asText().equals("latest")).toList();
            assertThat(latest).hasSize(1);
            assertThat(latest.getFirst().path("Node Type").asText()).contains("Index");
            assertThat(latest.getFirst().path("Actual Rows").asLong()).isEqualTo(1);
            assertThat(latest.getFirst().path("Actual Loops").asLong()).isEqualTo(jdbc.queryForObject("""
                SELECT count(DISTINCT v.processing_job_id) FROM diarization_worker_verifications v
                WHERE NOT EXISTS (SELECT 1 FROM diarization_worker_receipts r WHERE r.event_id=v.event_id)
                """,Long.class));
            System.out.println("SPK12 plan "+name+": scanWork="+scanWork+", buffers="+plan.path("Shared Hit Blocks")
                +", latestLoops="+latest.getFirst().path("Actual Loops")+", ms="+plan.path("Actual Total Time"));
            return scanWork;
    }
    private static void planNodes(tools.jackson.databind.JsonNode node,List<tools.jackson.databind.JsonNode> nodes) {
        nodes.add(node);for(var child:node.path("Plans")) planNodes(child,nodes);
    }
    private static void persistPlan(String name,String json) {
        try {
            var directory=java.nio.file.Path.of("target/spk12-plans");java.nio.file.Files.createDirectories(directory);
            java.nio.file.Files.writeString(directory.resolve(name+".json"),json+"\n");
        } catch(java.io.IOException failure) {throw new java.io.UncheckedIOException(failure);}
    }
    private void seedMonitoringHistory() {
        // Synthetic persisted history only; all foreign keys and evidence triggers stay enabled.
        jdbc.execute("""
            CREATE TEMP TABLE spk12_plan_seed ON COMMIT DROP AS
            SELECT n,gen_random_uuid() AS stage_id,gen_random_uuid() AS event_id,
                gen_random_uuid() AS token,gen_random_uuid() AS command_id,gen_random_uuid() AS verification_id
            FROM generate_series(1,4096) n
            """);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status,claim_token,lease_expires_at)
            SELECT stage_id,?,'DIARIZING',n+1,CASE WHEN n<=4064 THEN 'FAILED' ELSE 'RUNNING' END,
                token,transaction_timestamp()+interval '1 hour' FROM spk12_plan_seed
            """,job);
        jdbc.update("""
            INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
            SELECT x.event_id,e.aggregate_type,e.aggregate_id,e.event_type,
                e.payload || jsonb_build_object('stageRunId',x.stage_id,'eventId',x.event_id)
            FROM spk12_plan_seed x CROSS JOIN outbox_events e WHERE e.id=?
            """,event);
        jdbc.update("""
            INSERT INTO processing_diarization_dispatches(stage_run_id,processing_job_id,meeting_id,source_media_id,
                source_revision,transcript_id,transcript_revision,event_id,created_at)
            SELECT x.stage_id,d.processing_job_id,d.meeting_id,d.source_media_id,d.source_revision,
                d.transcript_id,d.transcript_revision,x.event_id,transaction_timestamp()-interval '49 hours'
            FROM spk12_plan_seed x CROSS JOIN processing_diarization_dispatches d WHERE d.event_id=?
            """,event);
        jdbc.update("""
            INSERT INTO diarization_worker_claims(event_id,processing_job_id,execution_stage_run_id,principal,
                claim_request_id,request_sha256,claim_token,source_descriptor)
            SELECT x.event_id,c.processing_job_id,x.stage_id,c.principal,gen_random_uuid(),c.request_sha256,x.token,c.source_descriptor
            FROM spk12_plan_seed x CROSS JOIN diarization_worker_claims c WHERE c.event_id=?
            """,event);
        jdbc.update("""
            INSERT INTO diarization_worker_commands(command_id,processing_job_id,event_id,execution_stage_run_id,command_type,request_sha256)
            SELECT x.command_id,c.processing_job_id,x.event_id,x.stage_id,'COMPLETE',c.request_sha256
            FROM spk12_plan_seed x CROSS JOIN diarization_worker_commands c WHERE c.event_id=?
            """,event);
        jdbc.update("""
            INSERT INTO diarization_worker_verifications(verification_id,processing_job_id,event_id,execution_stage_run_id,
                producer_stage_run_id,command_id,source_revision,transcript_id,transcript_revision,result_sha256,storage_id,object_key,size_bytes,verified_at)
            SELECT x.verification_id,v.processing_job_id,x.event_id,x.stage_id,x.stage_id,x.command_id,v.source_revision,
                v.transcript_id,v.transcript_revision,v.result_sha256,v.storage_id,
                'processing/' || v.processing_job_id || '/diarization/results/' || x.stage_id || '.json',v.size_bytes,
                transaction_timestamp()-interval '49 hours'
            FROM spk12_plan_seed x CROSS JOIN diarization_worker_verifications v WHERE v.event_id=?
            """,event);
        jdbc.update("""
            INSERT INTO diarization_worker_receipts(receipt_id,processing_job_id,event_id,execution_stage_run_id,outcome,error_code,retryable)
            SELECT gen_random_uuid(),?,event_id,stage_id,'FAILURE_RECORDED','DIARIZATION_TIMEOUT',true
            FROM spk12_plan_seed WHERE n<=4064
            """,job);
    }
    private void seedRepresentativeHistory(int jobs) {
        // Independent source/transcript/job lineage; three attempts (configured maxRetries=2),
        // with failed predecessors, terminal history, and old unresolved latest attempts.
        jdbc.execute("CREATE TEMP TABLE spk12_jobs ON COMMIT DROP AS SELECT n,gen_random_uuid() job_id,gen_random_uuid() meeting_id,gen_random_uuid() media_id,gen_random_uuid() transcript_id,gen_random_uuid() finalizer_id FROM generate_series(1,"+jobs+") n");
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) SELECT meeting_id,'synthetic monitoring',?,? FROM spk12_jobs",actor,actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,content_type,expected_size_bytes,
                size_bytes,duration_ms,sha256,uploaded_by_user_id,available_at)
            SELECT media_id,meeting_id,'UPLOAD','AVAILABLE','meetings/'||meeting_id||'/sources/'||media_id,
                'meetings/'||meeting_id||'/pending/'||media_id,'audio/wav',1024,1024,10000,CASE WHEN n%256=0 THEN repeat('b',64) ELSE repeat('a',64) END,?,transaction_timestamp()
            FROM spk12_jobs
            """,actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status,current_stage,diarization_planned)
            SELECT job_id,meeting_id,media_id,?,CASE WHEN n%16=0 THEN 'RUNNING' ELSE 'COMPLETED_WITH_WARNINGS' END,
                CASE WHEN n%16=0 THEN 'DIARIZING' ELSE NULL END,true FROM spk12_jobs
            """,actor);
        jdbc.execute("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status,created_at,started_at,completed_at)
            SELECT gen_random_uuid(),job_id,code,1,'SUCCEEDED',transaction_timestamp()-interval '50 hours',
                transaction_timestamp()-interval '50 hours',transaction_timestamp()-interval '49 hours'
            FROM spk12_jobs CROSS JOIN (VALUES ('TRANSCRIPTION'),('CONTEXTUAL_CORRECTION')) upstream(code)
            """);
        jdbc.execute("INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status) SELECT finalizer_id,job_id,'FINALIZING_TRANSCRIPT',1,'SUCCEEDED' FROM spk12_jobs");
        jdbc.execute("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,source_stage_run_id,
                version_number,language_code,status,is_current,duration_ms,content_revision)
            SELECT transcript_id,meeting_id,media_id,job_id,finalizer_id,1,'vi','READY',n%512<>0,10000,
                CASE WHEN n%128=0 THEN 1 ELSE 0 END FROM spk12_jobs
            """);
        jdbc.execute("""
            CREATE TEMP TABLE spk12_attempts ON COMMIT DROP AS SELECT j.*,a,gen_random_uuid() stage_id,
                gen_random_uuid() event_id,gen_random_uuid() token,gen_random_uuid() command_id,
                gen_random_uuid() verification_id,(n%16=0 AND (a=3 OR (n%64=0 AND a=2))) unresolved
            FROM spk12_jobs j CROSS JOIN generate_series(1,3) a
            """);
        jdbc.execute("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status,claim_token,lease_expires_at,created_at,started_at)
            SELECT stage_id,job_id,'DIARIZING',a,CASE WHEN unresolved AND a=3 THEN 'RUNNING' ELSE 'FAILED' END,
                token,transaction_timestamp()+CASE WHEN n%32=0 THEN interval '-1 hour' ELSE interval '20 minutes' END,
                transaction_timestamp()-interval '49 hours',transaction_timestamp()-interval '49 hours' FROM spk12_attempts
            """);
        jdbc.execute("""
            INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
            SELECT event_id,'PROCESSING_JOB',job_id,'PROCESSING_DIARIZATION_REQUESTED',
                jsonb_build_object('stageRunId',stage_id,'eventId',event_id,'processingJobId',job_id,
                    'meetingId',meeting_id,'sourceMediaId',media_id,'schemaVersion',1) FROM spk12_attempts
            """);
        jdbc.execute("""
            INSERT INTO processing_diarization_dispatches(stage_run_id,processing_job_id,meeting_id,source_media_id,
                source_revision,transcript_id,transcript_revision,event_id,created_at)
            SELECT stage_id,job_id,meeting_id,media_id,repeat('a',64),transcript_id,0,event_id,transaction_timestamp()-interval '49 hours' FROM spk12_attempts
            """);
        jdbc.execute("""
            INSERT INTO diarization_worker_claims(event_id,processing_job_id,execution_stage_run_id,principal,
                claim_request_id,request_sha256,claim_token,source_descriptor)
            SELECT event_id,job_id,stage_id,'urn:sme:service:ai-worker',gen_random_uuid(),repeat('a',64),token,'{}'::jsonb FROM spk12_attempts
            """);
        jdbc.execute("""
            INSERT INTO diarization_worker_commands(command_id,processing_job_id,event_id,execution_stage_run_id,command_type,request_sha256)
            SELECT command_id,job_id,event_id,stage_id,'COMPLETE',repeat('a',64) FROM spk12_attempts
            """);
        jdbc.execute("""
            INSERT INTO diarization_worker_verifications(verification_id,processing_job_id,event_id,execution_stage_run_id,
                producer_stage_run_id,command_id,source_revision,transcript_id,transcript_revision,result_sha256,storage_id,object_key,size_bytes,verified_at)
            SELECT verification_id,job_id,event_id,stage_id,stage_id,command_id,repeat('a',64),transcript_id,0,repeat('c',64),
                'synthetic','processing/'||job_id||'/diarization/results/'||stage_id||'.json',128,
                transaction_timestamp()-CASE WHEN unresolved AND a=3 AND n%32<>0 THEN interval '1 minute' ELSE interval '49 hours' END FROM spk12_attempts
            """);
        jdbc.execute("""
            INSERT INTO diarization_worker_receipts(receipt_id,processing_job_id,event_id,execution_stage_run_id,outcome,error_code,retryable)
            SELECT gen_random_uuid(),job_id,event_id,stage_id,'FAILURE_RECORDED','DIARIZATION_TIMEOUT',true FROM spk12_attempts WHERE NOT unresolved
            """);
    }
    @Test void v38UpgradePreservesEvidenceAndClassification() throws Exception {
        verified();String schema="spk12_"+UUID.randomUUID().toString().replace("-","");
        try {
            var source=jdbc.getDataSource();
            org.flywaydb.core.Flyway.configure().dataSource(source).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").target("38").load().migrate();
            transactions.executeWithoutResult(tx->{
                jdbc.execute("SET LOCAL search_path TO "+schema+",public");
                for(String table:List.of("users","meetings","meeting_media","processing_jobs","processing_stage_runs",
                        "outbox_events","transcripts","processing_diarization_dispatches","diarization_worker_claims",
                        "diarization_worker_commands","diarization_worker_verifications"))
                {
                    String columns=String.join(",",jdbc.queryForList("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=? AND is_generated='NEVER' ORDER BY ordinal_position",String.class,table));
                    jdbc.execute("INSERT INTO "+schema+"."+table+" ("+columns+") SELECT "+columns+" FROM public."+table);
                }
            });
            var before=jdbc.queryForList("SELECT * FROM "+schema+".diarization_verified_only_backlog");
            assertThat(before).hasSize(1);
            var upgrade=org.flywaydb.core.Flyway.configure().dataSource(source).schemas(schema).defaultSchema(schema).locations("classpath:db/migration").load();
            assertThat(upgrade.migrate().migrationsExecuted).isEqualTo(1);upgrade.validate();
            assertThat(jdbc.queryForList("SELECT * FROM "+schema+".diarization_verified_only_backlog")).isEqualTo(before);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM "+schema+".diarization_worker_verifications",Long.class)).isEqualTo(1);
        } finally {jdbc.execute("DROP SCHEMA IF EXISTS "+schema+" CASCADE");}
    }
    @Test void databaseAggregationFailureReturnsNanAndUnhealthyRatherThanAFalseZero() {
        var registry=new SimpleMeterRegistry();new DiarizationMetrics(jdbc,registry);
        jdbc.execute("ALTER VIEW diarization_verified_only_backlog RENAME TO spk12_temporarily_unavailable");
        try {
            assertThat(registry.get("diarization.verified.only.outstanding").gauge().value()).isNaN();
            assertThat(registry.get("diarization.metrics.aggregation.healthy").gauge().value()).isZero();
        } finally {jdbc.execute("ALTER VIEW spk12_temporarily_unavailable RENAME TO diarization_verified_only_backlog");}
        var restarted=new SimpleMeterRegistry();new DiarizationMetrics(jdbc,restarted);
        assertThat(restarted.get("diarization.metrics.aggregation.healthy").gauge().value()).isEqualTo(1);
    }
    @Test void scrapeRefreshUsesOneBoundedReadOnlyRepeatableSnapshotAndCachesAcrossGauges() throws Exception {
        var queries=new ArrayList<String>();var statements=new ArrayList<java.sql.Statement>();var source=jdbc.getDataSource();
        var tracked=new org.springframework.jdbc.datasource.AbstractDataSource() {
            @Override public java.sql.Connection getConnection() throws java.sql.SQLException {
                var connection=org.mockito.Mockito.spy(source.getConnection());
                org.mockito.Mockito.doAnswer(invocation->{
                    assertThat(connection.isReadOnly()).isTrue();
                    assertThat(connection.getTransactionIsolation()).isEqualTo(java.sql.Connection.TRANSACTION_REPEATABLE_READ);
                    queries.add(invocation.getArgument(0));
                    var statement=(java.sql.PreparedStatement)invocation.callRealMethod();
                    var spy=org.mockito.Mockito.spy(statement);statements.add(spy);return spy;
                }).when(connection).prepareStatement(org.mockito.ArgumentMatchers.anyString());
                org.mockito.Mockito.doAnswer(invocation->{
                    assertThat(connection.isReadOnly()).isTrue();
                    assertThat(connection.getTransactionIsolation()).isEqualTo(java.sql.Connection.TRANSACTION_REPEATABLE_READ);
                    queries.add("transaction_timestamp");
                    var spy=org.mockito.Mockito.spy((java.sql.Statement)invocation.callRealMethod());statements.add(spy);return spy;
                }).when(connection).createStatement();
                return connection;
            }
            @Override public java.sql.Connection getConnection(String user,String password) throws java.sql.SQLException {return getConnection();}
        };
        var registry=new SimpleMeterRegistry();var metrics=new DiarizationMetrics(new org.springframework.jdbc.core.JdbcTemplate(tracked),registry);
        registry.getMeters().forEach(m->m.measure().forEach(measurement->measurement.getValue()));
        assertThat(queries).hasSize(6).noneMatch(sql->sql.contains("FOR UPDATE"));
        registry.getMeters().forEach(m->m.measure().forEach(measurement->measurement.getValue()));
        assertThat(queries).hasSize(6);
        // Advance only the monotonic cache timestamp; no wall-clock wait or production seam.
        org.springframework.test.util.ReflectionTestUtils.setField(metrics,"refreshedAt",System.nanoTime()-61_000_000_000L);
        assertThat(registry.get("diarization.metrics.aggregation.healthy").gauge().value()).isEqualTo(1);
        assertThat(queries).hasSize(12);
        for(var statement:statements) org.mockito.Mockito.verify(statement).setQueryTimeout(5);
    }
}
