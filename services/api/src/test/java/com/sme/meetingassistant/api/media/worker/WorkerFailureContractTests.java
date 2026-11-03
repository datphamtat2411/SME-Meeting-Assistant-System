package com.sme.meetingassistant.api.media.worker;

import static org.assertj.core.api.Assertions.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class WorkerFailureContractTests {
    private tools.jackson.databind.node.ObjectNode command(String phase, String category) {
        var n=WorkerJson.MAPPER.createObjectNode();
        n.put("contractVersion","1.0").put("commandId",UUID.randomUUID().toString())
            .put("eventId",UUID.randomUUID().toString()).put("generation",0)
            .put("executionStageRunId",UUID.randomUUID().toString()).put("claimToken",UUID.randomUUID().toString())
            .put("phase",phase).put("category",category).putNull("completedThrough");
        n.putObject("metrics");
        return n;
    }

    @Test void sharedMatrixExercisesActualParserAndClassifier() throws Exception {
        var cases=WorkerJson.MAPPER.readTree(Files.readString(Path.of("../../contracts/CORE_API_AI_TRANSCRIPTION_WORKER_V1.failure-fixtures.json")));
        for (var c:cases) {
            var phase=c.get("phase").asString(); var category=c.get("category").asString();
            var stage=c.has("stage")?c.get("stage").asString():"TRANSCRIPTION";
            var fail=WorkerCommands.fail(command(phase,category));
            if(c.get("code").isNull()) {
                assertThatThrownBy(()->WorkerFailure.classify(fail,stage)).isInstanceOfSatisfying(
                    WorkerException.class,e->assertThat(e.status()).isEqualTo(422));
            } else {
                var result=WorkerFailure.classify(fail,stage);
                assertThat(result.code()).as(phase+"/"+category).isEqualTo(c.get("code").asString());
                assertThat(result.retryable()).isEqualTo(c.get("retryable").booleanValue());
            }
        }
    }

    @Test void rejectsInvalidProofMetricsAndTokens() {
        var bad=command("CORRECTION","VALIDATION"); bad.put("completedThrough","RECONCILIATION");
        bad.putObject("metrics").put("sampleCount",0).put("warningCount",0).put("unresolvedRegionCount",0);
        assertThatThrownBy(()->WorkerCommands.fail(bad)).isInstanceOf(WorkerException.class);
        var unknown=command("UNKNOWN","VALIDATION");
        assertThatThrownBy(()->WorkerCommands.fail(unknown)).isInstanceOf(WorkerException.class);
    }

    @Test void emitActualExhaustiveClassificationsForPythonBridge() throws Exception {
        String matrix=System.getProperty("f02.matrix");
        if(matrix==null) return;
        var lines=Files.readAllLines(Path.of(matrix));
        assertThat(lines).hasSize(528);
        var results=new ArrayList<String>();
        for(var line:lines) {
            var parts=line.split(",");
            var cmd=WorkerCommands.fail(command(parts[0],parts[1]));
            try {
                var classified=WorkerFailure.classify(cmd,parts[2]);
                results.add(line+","+classified.code()+","+classified.retryable());
            } catch(WorkerException e) {
                assertThat(e.status()).isEqualTo(422);
                results.add(line+",422,false");
            }
        }
        Files.write(Path.of(matrix+".results"),results);
    }
}
