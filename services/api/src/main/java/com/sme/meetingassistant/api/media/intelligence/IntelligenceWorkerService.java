package com.sme.meetingassistant.api.media.intelligence;

import com.sme.meetingassistant.api.media.service.ProcessingIntelligenceSource;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;

/** Private worker facade: never retain a PostgreSQL transaction across source storage I/O. */
@Service
public class IntelligenceWorkerService {
    private final IntelligenceWorkerTransactions commands;
    private final ProcessingIntelligenceSource sources;
    public IntelligenceWorkerService(IntelligenceWorkerTransactions commands,ProcessingIntelligenceSource sources) {this.commands=commands;this.sources=sources;}
    @Transactional(propagation=Propagation.NEVER)
    public Map<String,Object> claim(UUID job,IntelligenceCommands.Claim command,String peer) {
        var preflight=commands.preflight(job,command,peer);
        if(preflight.terminal()!=null) return preflight.terminal();
        var d=preflight.delivery();ProcessingIntelligenceSource.Snapshot source;
        try {source=sources.prepare(job,d.meeting(),d.media(),d.derived());}
        catch(RuntimeException invalid) {IntelligenceOperationLog.record("SOURCE_REJECTED",job,d.stage(),d.event());throw invalid;}
        return commands.claim(job,command,peer,source);
    }
    public Map<String,Object> renew(UUID job,IntelligenceCommands.Owner command,String peer) {return commands.renew(job,command,peer);}
    public Map<String,Object> fail(UUID job,IntelligenceCommands.Fail command,String peer) {return commands.fail(job,command,peer);}
    public Map<String,Object> status(UUID job,UUID event) {return commands.status(job,event);}
}
