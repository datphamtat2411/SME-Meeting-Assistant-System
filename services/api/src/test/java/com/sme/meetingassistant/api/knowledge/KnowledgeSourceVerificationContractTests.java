package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

class KnowledgeSourceVerificationContractTests {
    @Test
    void acceptsMissingOptionalContentHash() throws Exception {
        var request = KnowledgeSourceVerificationController.parseRequest(item(
            "{\"number\":4}"));

        assertThat(request.sourceRevision()).isEqualTo(4);
        assertThat(request.contentSha256()).isNull();
    }

    @Test
    void acceptsAndPreservesAValidContentHash() throws Exception {
        String hash = "a".repeat(64);
        var request = KnowledgeSourceVerificationController.parseRequest(item(
            "{\"number\":4,\"contentSha256\":\"" + hash + "\"}"));

        assertThat(request.sourceRevision()).isEqualTo(4);
        assertThat(request.contentSha256()).isEqualTo(hash);
    }

    @Test
    void rejectsNullMalformedAndUnexpectedContentHashValues() throws Exception {
        for (String revision : new String[] {
            "{\"number\":4,\"contentSha256\":null}",
            "{\"number\":4,\"contentSha256\":\"" + "a".repeat(63) + "\"}",
            "{\"number\":4,\"contentSha256\":\"" + "G".repeat(64) + "\"}",
            "{\"number\":4,\"contentSha256\":\"" + "a".repeat(64) + "\",\"unexpected\":true}"
        }) {
            assertThatThrownBy(() -> KnowledgeSourceVerificationController.parseRequest(item(revision)))
                .isInstanceOf(WorkerException.class)
                .satisfies(error -> assertThat(((WorkerException) error).status()).isEqualTo(422));
        }
    }

    private static JsonNode item(String revision) throws Exception {
        return WorkerJson.MAPPER.readTree("""
            {
              "sourceIdentity": {
                "sourceType": "TRANSCRIPT",
                "sourceId": "11111111-1111-4111-8111-111111111111",
                "meetingId": "22222222-2222-4222-8222-222222222222"
              },
              "sourceRevision": %s
            }
            """.formatted(revision));
    }
}
