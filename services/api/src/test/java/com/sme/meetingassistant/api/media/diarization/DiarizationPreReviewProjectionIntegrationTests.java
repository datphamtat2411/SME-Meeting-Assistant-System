package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class DiarizationPreReviewProjectionIntegrationTests extends DiarizationIntegrationFixture {
    @Override
    protected boolean preReviewDiarization() { return true; }

    @Test
    void projectionCanCommitBeforeReviewAndOpenTranscriptReview() throws Exception {
        claim();
        var command = upload(artifact());

        assertThat(completion.complete(job, command).get("state")).isEqualTo("RESULT_ACCEPTED");
        assertThat(stageStatus()).isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?", String.class, job))
            .isEqualTo("WAITING_FOR_REVIEW");
        assertThat(jdbc.queryForObject("SELECT content_revision FROM transcripts WHERE id=?", Long.class, transcript))
            .isEqualTo(1L);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM speaker_clusters WHERE transcript_id=?", Long.class, transcript))
            .isEqualTo(1L);
    }
}
