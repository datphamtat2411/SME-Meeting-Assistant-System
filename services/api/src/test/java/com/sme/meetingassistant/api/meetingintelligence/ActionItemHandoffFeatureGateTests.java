package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.service.MediaProcessingService;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycleService;
import com.sme.meetingassistant.api.media.service.ProcessingTranscriptEvidence;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemProposalHandoff;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

/** Fail-closed gates require no database, application actor or remote service. */
class ActionItemHandoffFeatureGateTests {
    private static void is503(Throwable error) {
        assertThat(error).isInstanceOf(ResponseStatusException.class);
        assertThat(((ResponseStatusException)error).getStatusCode())
            .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
    }

    @Test
    void jobPlanningCannotDeclareDisabledCapabilityRequiredOrCompleted() {
        var props=new MediaProperties();
        props.getProcessing().setRequiredDownstreamStages(
            List.of("GENERATING_SUMMARY","EXTRACTING_ACTION_ITEMS"));
        var service=new MediaProcessingService(mock(MediaRepository.class),null,null,null,null,props);
        assertThatThrownBy(()->ReflectionTestUtils.invokeMethod(service,"plannedDownstreamStages"))
            .satisfies(ActionItemHandoffFeatureGateTests::is503);
        props.getProcessing().setRequiredDownstreamStages(List.of("GENERATING_SUMMARY"));
        assertThat(((List<?>)ReflectionTestUtils.invokeMethod(
            service,"plannedDownstreamStages")).stream().map(Object::toString).toList())
            .containsExactly("GENERATING_SUMMARY");
        props.getProcessing().setActionItemHandoffEnabled(true);
        props.getProcessing().setRequiredDownstreamStages(
            List.of("GENERATING_SUMMARY","EXTRACTING_ACTION_ITEMS"));
        assertThat(((List<?>)ReflectionTestUtils.invokeMethod(
            service,"plannedDownstreamStages")).stream().map(Object::toString).toList())
            .containsExactly("GENERATING_SUMMARY","EXTRACTING_ACTION_ITEMS");
    }

    @Test
    void disabledHandoffDoesNotCallEvenInstalledSinkOrCanonicalDependencies() {
        var db=mock(org.springframework.jdbc.core.JdbcTemplate.class);
        var media=mock(ProcessingJobLifecycle.class);
        var source=mock(TranscriptSourceGuard.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<ActionItemProposalSink> provider=mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(mock(ActionItemProposalSink.class));
        var props=new MediaProperties();
        var handoff=new ActionItemProposalHandoff(db,media,source,provider,
            new ObjectMapper(),props);
        var claim=new ProcessingJobLifecycle.StageClaim(UUID.randomUUID(),UUID.randomUUID());
        var reference=new ActionItemProposalHandoff.SourceReference(
            UUID.randomUUID(),UUID.randomUUID(),0,"a".repeat(64));
        assertThatThrownBy(()->handoff.handoff(claim,reference,List.of()))
            .satisfies(ActionItemHandoffFeatureGateTests::is503);
        verify(provider,never()).getIfAvailable();
        verifyNoInteractions(db,media,source);
    }

    @Test
    void disabledStageCannotBeClaimedEvenWhenMediaRepositoryHasPendingWork() {
        var repo=mock(MediaRepository.class);
        var props=new MediaProperties();
        var lifecycle=new ProcessingJobLifecycleService(repo,new ObjectMapper(),props,
            mock(ProcessingTranscriptEvidence.class));
        assertThatThrownBy(()->lifecycle.startStage(
            UUID.randomUUID(),"EXTRACTING_ACTION_ITEMS",null,null))
            .satisfies(ActionItemHandoffFeatureGateTests::is503);
        verifyNoInteractions(repo);
    }
}
