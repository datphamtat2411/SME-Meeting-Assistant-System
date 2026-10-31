package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Bounded opt-in maintenance: only unreferenced, old private intelligence
 * objects under an existing terminal job are candidates. No business data
 * retention policy is inferred from cleanup eligibility.
 */
@Component
public class IntelligenceOrphanReconciler {
    private static final Logger LOG=LoggerFactory.getLogger(IntelligenceOrphanReconciler.class);
    private static final Pattern KEY=Pattern.compile(
        "^processing/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/intelligence/"
        +"(source|results)/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.json$");
    private static final int PAGE_SIZE=100;
    private static final int MAX_PAGES=3;
    private final ObjectStorage objects;
    private final IntelligenceOrphanCleanupAudit audit;
    private final boolean enabled,dryRun;
    private final Duration minAge;

    public IntelligenceOrphanReconciler(ObjectStorage objects,IntelligenceOrphanCleanupAudit audit,
            @Value("${app.meeting-intelligence.orphan-cleanup.enabled:false}") boolean enabled,
            @Value("${app.meeting-intelligence.orphan-cleanup.dry-run:true}") boolean dryRun,
            @Value("${app.meeting-intelligence.orphan-cleanup.min-age:PT0S}") Duration minAge) {
        this.objects=objects;this.audit=audit;this.enabled=enabled;
        this.dryRun=dryRun;this.minAge=minAge;
        if(enabled && (minAge==null || minAge.compareTo(Duration.ofHours(24))<0))
            throw new IllegalStateException(
                "Orphan cleanup requires an explicitly configured minimum age >= 24 hours.");
    }

    @Scheduled(fixedDelayString="${app.meeting-intelligence.orphan-cleanup.poll-ms:3600000}")
    public void sweep() {
        if(!enabled)return;
        Instant cutoff=Instant.now().minus(minAge);
        for(var job:audit.eligibleJobs(cutoff,8)) {
            try { reconcile(job.id(),job.meetingId(),cutoff); }
            catch(RuntimeException error) {
                // No object paths, document contents, credentials or exception details.
                LOG.warn("Intelligence orphan reconciliation failed for job {}",job.id());
            }
        }
    }

    /** Internal maintenance API; never exposed as an HTTP endpoint. */
    public Result reconcileJob(UUID jobId,UUID meetingId) {
        if(!enabled) throw new IllegalStateException("Intelligence cleanup is disabled.");
        return reconcile(jobId,meetingId,Instant.now().minus(minAge));
    }

    private Result reconcile(UUID jobId,UUID meetingId,Instant cutoff) {
        String prefix="processing/"+jobId+"/intelligence/";
        int inspected=0,eligible=0,deleted=0;
        String token=null;
        boolean truncated=false;
        for(int pageIndex=0;pageIndex<MAX_PAGES;pageIndex++) {
            var page=objects.list(prefix,token,PAGE_SIZE);
            if(page==null || page.objects().size()>PAGE_SIZE)
                throw new IllegalStateException("Invalid bounded object listing.");
            for(var object:page.objects()) {
                inspected++;
                if(object==null || object.key()==null || object.lastModified()==null
                        || !object.key().startsWith(prefix)
                        || !KEY.matcher(object.key()).matches()
                        || !object.lastModified().isBefore(cutoff)) continue;
                String kind=object.key().contains("/source/")?"SOURCE":"RESULT";
                if(!audit.authorize(jobId,meetingId,object.key(),kind,cutoff,dryRun))
                    continue;
                eligible++;
                if(!dryRun) {
                    try {
                        objects.delete(object.key());
                        audit.outcome(jobId,meetingId,object.key(),kind,true);
                        deleted++;
                    } catch(RuntimeException error) {
                        audit.outcome(jobId,meetingId,object.key(),kind,false);
                    }
                }
            }
            token=page.nextToken();
            if(token==null)break;
            if(pageIndex==MAX_PAGES-1)truncated=true;
        }
        audit.scanned(jobId,meetingId,inspected,eligible,deleted,truncated);
        return new Result(inspected,eligible,deleted,truncated);
    }

    public record Result(int inspected,int eligible,int deleted,boolean truncated) { }
}
