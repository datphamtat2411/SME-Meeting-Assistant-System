package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceOrphanCleanupAudit;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceOrphanReconciler;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Tests the non-atomic S3-delete / transactional-audit fault boundary. */
class IntelligenceOrphanAuditFaultInjectionTests {
    private final ObjectStorage objects=mock(ObjectStorage.class);
    private final IntelligenceOrphanCleanupAudit audit=mock(IntelligenceOrphanCleanupAudit.class);
    private final UUID job=UUID.randomUUID(),meeting=UUID.randomUUID();
    private final String key="processing/"+job+"/intelligence/results/"+UUID.randomUUID()+".json";
    private final String prefix="processing/"+job+"/intelligence/";

    private IntelligenceOrphanReconciler reconciler() {
        when(audit.claim(eq(job),eq(meeting),any(UUID.class),any(Instant.class)))
            .thenReturn(true);
        when(audit.authorize(eq(job),eq(meeting),any(UUID.class),eq(key),
            eq("RESULT"),any(Instant.class),eq(false))).thenReturn(true);
        when(objects.list(eq(prefix),isNull(),eq(100)))
            .thenReturn(new ObjectStorage.ListedObjects(List.of(
                new ObjectStorage.ListedObject(key,Instant.now().minus(Duration.ofDays(7)))),null));
        return new IntelligenceOrphanReconciler(objects,audit,true,false,Duration.ofHours(48));
    }

    @Test
    void successfulS3DeleteButFailedSuccessAuditMustNotClaimDeleteFailed() {
        var subject=reconciler();
        doThrow(new IllegalStateException("audit db unavailable"))
            .when(audit).outcome(job,meeting,key,"RESULT",true);

        assertThatThrownBy(()->subject.reconcileJob(job,meeting))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("audit db unavailable");
        verify(objects,times(1)).delete(key);
        verify(audit,times(1)).outcome(job,meeting,key,"RESULT",true);
        verify(audit,never()).outcome(job,meeting,key,"RESULT",false);
        verify(audit,never()).scanned(eq(job),eq(meeting),any(UUID.class),
            anyInt(),anyInt(),anyInt(),anyBoolean());
    }

    @Test
    void actualS3FailureReportsFailureWithoutFakingSuccessfulDelete() {
        var subject=reconciler();
        doThrow(new IllegalStateException("S3 unreachable")).when(objects).delete(key);
        var result=subject.reconcileJob(job,meeting);
        assertThat(result.deleted()).isZero();
        assertThat(result.eligible()).isEqualTo(1);
        verify(audit).outcome(job,meeting,key,"RESULT",false);
        verify(audit,never()).outcome(job,meeting,key,"RESULT",true);
        verify(audit).scanned(eq(job),eq(meeting),any(UUID.class),
            eq(1),eq(1),eq(0),eq(false));
    }
}
