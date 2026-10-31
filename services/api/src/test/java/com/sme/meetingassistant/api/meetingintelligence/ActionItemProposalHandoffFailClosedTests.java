package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemProposalHandoff;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

/** No Action Items owner is installed on this branch: never accept fake work. */
class ActionItemProposalHandoffFailClosedTests {
    @Test
    void missingOwnedSinkIs503AndDoesNotReadOrMutateCanonicalData() {
        var jdbc=mock(JdbcTemplate.class);
        var media=mock(ProcessingJobLifecycle.class);
        var transcript=mock(TranscriptSourceGuard.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<ActionItemProposalSink> sinks=mock(ObjectProvider.class);
        when(sinks.getIfAvailable()).thenReturn(null);
        var handoff=new ActionItemProposalHandoff(jdbc,media,transcript,sinks,
            new ObjectMapper());
        var claim=new ProcessingJobLifecycle.StageClaim(UUID.randomUUID(),UUID.randomUUID());
        var source=new ActionItemProposalHandoff.SourceReference(
            UUID.randomUUID(),UUID.randomUUID(),0,"a".repeat(64));
        assertThatThrownBy(()->handoff.handoff(claim,source,List.of()))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(ex->assertThat(((ResponseStatusException)ex).getStatusCode())
                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));
        verifyNoInteractions(jdbc,media,transcript);
    }
}
