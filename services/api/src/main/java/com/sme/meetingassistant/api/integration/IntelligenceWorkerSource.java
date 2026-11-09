package com.sme.meetingassistant.api.integration;

import com.sme.meetingassistant.api.media.service.ProcessingIntelligenceSource;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceSnapshotStore;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceWorkerSnapshots;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;

@Service
public class IntelligenceWorkerSource implements ProcessingIntelligenceSource {
    private final OfflineIntelligenceSnapshotPreparation offline;
    private final IntelligenceWorkerSnapshots snapshots;
    private final IntelligenceSnapshotStore storage;
    public IntelligenceWorkerSource(OfflineIntelligenceSnapshotPreparation offline,IntelligenceWorkerSnapshots snapshots,IntelligenceSnapshotStore storage) {
        this.offline=offline;this.snapshots=snapshots;this.storage=storage;
    }
    @Override @Transactional(propagation=Propagation.NEVER)
    public Snapshot prepare(UUID job,UUID meeting,UUID media,boolean derived) {
        if(!derived) offline.prepare(job);
        var s=snapshots.descriptor(job,meeting,media);
        storage.verify(new IntelligenceSnapshotStore.Snapshot(s.objectKey(),s.sha256(),s.sizeBytes()));
        return s;
    }
    @Override @Transactional(propagation=Propagation.MANDATORY)
    public void requireBinding(UUID job,UUID meeting,UUID media,boolean derived,Snapshot expected) {
        snapshots.requireBinding(job,meeting,media,derived,expected);
    }
}
