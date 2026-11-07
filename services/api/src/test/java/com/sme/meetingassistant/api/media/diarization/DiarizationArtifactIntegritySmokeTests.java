package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.when;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import software.amazon.awssdk.services.s3.model.S3Exception;
import tools.jackson.databind.node.ObjectNode;

/** Untrusted artifact matrix: real PostgreSQL/transactions, controlled storage I/O. */
class DiarizationArtifactIntegritySmokeTests extends DiarizationIntegrationFixture {
    @ParameterizedTest
    @ValueSource(strings={"missing","corrupt","digest","oversize","transcript","revision","producer","speaker","assignment"})
    void invalidEvidenceNeverMutatesCanonicalTranscriptOrCreatesAcceptance(String fault) throws Exception {
        claim();var n=artifact();
        switch(fault) {
            case "transcript" -> n.put("transcriptId",UUID.randomUUID().toString());
            case "revision" -> n.put("transcriptRevision",1);
            case "producer" -> n.put("producerStageRunId",UUID.randomUUID().toString());
            case "speaker" -> ((ObjectNode)n.withArray("assignments").get(0)).put("speakerLabel","SPEAKER_99");
            case "assignment" -> n.putArray("assignments");
            default -> { }
        }
        var cmd=upload(n);var key=DiarizationWorkerRepository.resultKey(job,stage);
        var before=jdbc.queryForList("SELECT * FROM transcript_segments WHERE transcript_id=?",transcript);
        if(fault.equals("missing")) when(storage.head(key)).thenThrow(S3Exception.builder().statusCode(404).build());
        if(fault.equals("oversize")) when(storage.head(key)).thenReturn(new ObjectStorage.StoredObject(16777217,"application/json",null));
        if(fault.equals("corrupt")) {
            byte[] corrupt="not a result".getBytes(StandardCharsets.UTF_8);
            when(storage.head(key)).thenReturn(new ObjectStorage.StoredObject(corrupt.length,"application/json",null));
            when(storage.readBounded(key,16777216)).thenReturn(corrupt);
        }
        if(fault.equals("digest")) cmd=new DiarizationCommands.Complete(cmd.commandId(),owner,"b".repeat(64),stage);
        var command=cmd;
        assertThatThrownBy(()->completion.complete(job,command)).isInstanceOfSatisfying(WorkerException.class,error->{
            assertThat(error.status()).isEqualTo(422);
            assertThat(error.code()).isEqualTo(fault.equals("missing")?"DIARIZATION_RESULT_MISSING":"DIARIZATION_RESULT_INVALID");
        });
        assertThat(jdbc.queryForList("SELECT * FROM transcript_segments WHERE transcript_id=?",transcript)).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM speaker_clusters WHERE transcript_id=?",Long.class,transcript)).isZero();
        assertThat(jdbc.queryForObject("SELECT status FROM transcripts WHERE id=?",String.class,transcript)).isEqualTo("READY");
        assertThat(count("diarization_worker_verifications")).isZero();assertThat(count("diarization_worker_receipts")).isZero();
        assertThat(stageStatus()).isEqualTo("RUNNING");
        assertThat(worker.status(job,event).get("acknowledge")).isEqualTo(false);
    }
}
