package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/** A test-only projection double exercises the transaction seam; no canonical speakers are written. */
class DiarizationProjectionBoundaryIntegrationTests extends DiarizationIntegrationFixture {
    @MockitoBean DiarizationSpeakerProjection projection;

    @Test void verificationIsDurableIdempotentNonterminalAndCannotBypassProjection() throws Exception {
        claim();var cmd=upload(artifact());
        doThrow(new IllegalStateException("projection unavailable")).when(projection).project(any());
        assertThatThrownBy(()->completion.complete(job,cmd)).isInstanceOf(IllegalStateException.class);
        assertThat(count("diarization_worker_verifications")).isEqualTo(1);assertThat(count("diarization_worker_receipts")).isZero();
        assertThat(stageStatus()).isEqualTo("RUNNING");assertThat(worker.status(job,event).get("state")).isEqualTo("RESULT_VERIFIED");
        // Roll back even after the projection, receipt, stage and job mutations have all run.
        doNothing().when(projection).project(any());
        var bytes=WorkerJson.MAPPER.writeValueAsBytes(artifact());
        var validated=DiarizationResultContract.validate(bytes,worker.completionContext(job,cmd),cmd.resultSha256());
        transactions.executeWithoutResult(tx->{assertThat(worker.projectVerified(job,cmd,validated).get("state")).isEqualTo("RESULT_ACCEPTED");tx.setRollbackOnly();});
        assertThat(count("diarization_worker_receipts")).isZero();assertThat(stageStatus()).isEqualTo("RUNNING");
        var accepted=completion.complete(job,cmd);assertThat(accepted.get("state")).isEqualTo("RESULT_ACCEPTED");
        expire();jdbc.update("UPDATE transcripts SET content_revision=1 WHERE id=?",transcript);
        clearInvocations(storage,projection);
        assertThat(completion.complete(job,cmd)).isEqualTo(accepted);verifyNoInteractions(storage,projection);
        assertThat(count("diarization_worker_receipts")).isEqualTo(1);
    }
}
