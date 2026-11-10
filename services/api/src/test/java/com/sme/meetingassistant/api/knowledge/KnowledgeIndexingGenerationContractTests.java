package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.media.MediaProperties;
import org.junit.jupiter.api.Test;

class KnowledgeIndexingGenerationContractTests {
    @Test
    void coreDefaultsMatchTheVersionedBgeM3DeploymentContract() {
        var generation = new MediaProperties().getKnowledgeIndexing();

        assertThat(generation.getGenerationId()).isEqualTo("rag-t02-bge-m3-v1");
        assertThat(generation.getConfigurationVersion()).isEqualTo("rag-t02-bge-m3-v1");
        assertThat(generation.getConfigurationSha256())
            .isEqualTo("b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1");
        assertThat(generation.getTokenizerId())
            .isEqualTo("BAAI/bge-m3-tokenizer:5617a9f61b028005a4858fdac845db406aefb181");
        assertThat(generation.getCollectionName()).isEqualTo("sme_meeting_knowledge_bge_m3");
    }
}
