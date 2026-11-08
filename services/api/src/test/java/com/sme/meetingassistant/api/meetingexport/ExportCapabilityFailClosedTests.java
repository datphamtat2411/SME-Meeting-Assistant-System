package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Issued bearer capabilities must never bypass the audit gate. */
class ExportCapabilityFailClosedTests {
    @Test
    void auditWriteFailurePreventsReturningPreviouslyMintedSignedCapability() {
        UUID id=UUID.randomUUID(), meeting=UUID.randomUUID(), actor=UUID.randomUUID();
        var repository=mock(MeetingExportRepository.class);
        var access=mock(MeetingMediaAccess.class);
        var identity=mock(AuthenticatedUserId.class);
        var storage=mock(ExportDownloadStore.class);
        var audit=mock(ExportSecurityAudit.class);
        OffsetDateTime time=OffsetDateTime.now(ZoneOffset.UTC);
        var record=new ExportRecord(id,meeting,ExportFormat.PDF,ExportStatus.READY,
                actor,time,time,"private-key","a".repeat(64),null,1,
                null,null,"snapshot-key","fop-1","b".repeat(64),100L,1L);
        when(repository.require(id)).thenReturn(record);
        when(identity.requireUserId()).thenReturn(actor);
        when(storage.createVerifiedCapability(eq(record),eq(Duration.ofSeconds(60))))
                .thenReturn("https://downloads.example.invalid/private?k=secret");
        doThrow(new IllegalStateException("audit database unavailable"))
                .when(audit).capabilityIssued(eq(actor),eq(record),any(Duration.class));
        var service=new ExportAccessService(repository,access,identity,storage,
                Clock.systemUTC(),60,audit);
        assertThatThrownBy(()->service.issue(id))
                .isInstanceOf(IllegalStateException.class);
        verify(access,times(2)).requireReadable(meeting,actor);
        verify(audit,times(1)).capabilityIssued(eq(actor),eq(record),any(Duration.class));
    }

    @Test
    void invalidCapabilityNeverWritesFalseSuccessAudit() {
        UUID id=UUID.randomUUID(), meeting=UUID.randomUUID(), actor=UUID.randomUUID();
        var repository=mock(MeetingExportRepository.class);
        var access=mock(MeetingMediaAccess.class);
        var identity=mock(AuthenticatedUserId.class);
        var storage=mock(ExportDownloadStore.class);
        var audit=mock(ExportSecurityAudit.class);
        OffsetDateTime time=OffsetDateTime.now(ZoneOffset.UTC);
        var record=new ExportRecord(id,meeting,ExportFormat.MARKDOWN,ExportStatus.READY,
                actor,time,time,"private-key","a".repeat(64),null,1,
                null,null,"snapshot-key","renderer-1","b".repeat(64),100L,1L);
        when(repository.require(id)).thenReturn(record);
        when(identity.requireUserId()).thenReturn(actor);
        when(storage.createVerifiedCapability(eq(record),any(Duration.class)))
                .thenReturn("http://insecure.example.invalid/file?k=not-a-capability");
        var service=new ExportAccessService(repository,access,identity,storage,
                Clock.systemUTC(),60,audit);
        assertThatThrownBy(()->service.issue(id))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        verifyNoInteractions(audit);
    }
}
