package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.service.ProcessingIntelligenceSource.Snapshot;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;

/** Meeting Intelligence owns snapshot persistence; Media consumes only this application boundary. */
@Service
public class IntelligenceWorkerSnapshots {
    private final JdbcTemplate jdbc;
    private final TranscriptSourceGuard transcripts;
    public IntelligenceWorkerSnapshots(JdbcTemplate jdbc,TranscriptSourceGuard transcripts) {this.jdbc=jdbc;this.transcripts=transcripts;}
    @Transactional(readOnly=true)
    public Snapshot descriptor(UUID job,UUID meeting,UUID media) {
        var sources=jdbc.query("""
            SELECT id,transcript_id,content_revision,object_key,sha256,size_bytes
            FROM meeting_intelligence_source_snapshots
            WHERE processing_job_id=? AND meeting_id=? AND source_media_id=?
            """,(r,n)->new Snapshot(r.getObject("id",UUID.class),r.getObject("transcript_id",UUID.class),
                r.getLong("content_revision"),r.getString("object_key"),r.getString("sha256"),r.getLong("size_bytes")),job,meeting,media);
        if(sources.size()!=1) throw WorkerException.conflict("INTELLIGENCE_SOURCE_INVALID");
        var s=sources.getFirst();
        if(!s.objectKey().equals("processing/"+job+"/intelligence/source/"+s.snapshotId()+".json")
            || !s.sha256().matches("[a-f0-9]{64}") || s.sizeBytes()<1 || s.sizeBytes()>8*1024*1024)
            throw WorkerException.conflict("INTELLIGENCE_SOURCE_INVALID");
        return s;
    }
    @Transactional(propagation=Propagation.MANDATORY)
    public void requireBinding(UUID job,UUID meeting,UUID media,boolean derived,Snapshot expected) {
        if(!descriptor(job,meeting,media).equals(expected)) throw WorkerException.conflict("INTELLIGENCE_SOURCE_INVALID");
        var evidence=transcripts.derivedSource(meeting,expected.transcriptId(),expected.contentRevision());
        if(!evidence.eligible() || !derived && !evidence.current()) throw WorkerException.conflict("INTELLIGENCE_SOURCE_STALE");
    }
}
