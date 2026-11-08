package com.sme.meetingassistant.api.media.intelligence;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.transport.PemTls;
import java.net.URI;
import java.nio.file.Path;
import java.util.List;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/** Explicit deployment gates; enabling never invents a canonical result adapter. */
@Component
public class IntelligenceWorkerCapability {
    public static final List<String> ORDER=List.of("GENERATING_SUMMARY","EXTRACTING_DECISIONS","EXTRACTING_ACTION_ITEMS");
    private final MediaProperties properties;
    public IntelligenceWorkerCapability(Environment env,MediaProperties properties) {
        this.properties=properties;
        var p=properties.getIntelligence();
        if(p.isEnabled() || p.isDispatchEnabled()) try {
            var s=properties.getStorage();var uri=URI.create(s.getEndpoint());
            if(!p.isEnabled() || !p.isInfrastructureVerified() || p.getDispatchClaimTimeoutSeconds()<30
                || !env.getProperty("app.transport.private.enabled",Boolean.class,false)
                || !env.getProperty("app.mi.internal-result.enabled",Boolean.class,false)
                || !env.getProperty("app.media.outbox.enabled",Boolean.class,true)
                || !env.getProperty("spring.rabbitmq.ssl.enabled",Boolean.class,false)
                || !env.getProperty("spring.rabbitmq.ssl.validate-server-certificate",Boolean.class,false)
                || !env.getProperty("spring.rabbitmq.ssl.verify-hostname",Boolean.class,false)
                || !"correlated".equals(env.getProperty("spring.rabbitmq.publisher-confirm-type"))
                || !env.getProperty("spring.rabbitmq.publisher-returns",Boolean.class,false)
                || !env.getProperty("spring.rabbitmq.template.mandatory",Boolean.class,false)
                || !List.of("quorum","external-quorum").contains(env.getProperty("app.media.messaging.topology","legacy"))
                || !"processing.intelligence.requested".equals(properties.getOutbox().getIntelligenceRoutingKey())
                || properties.getOutbox().getIntelligenceRoutingKey().equals(properties.getOutbox().getRoutingKey())
                || properties.getOutbox().getIntelligenceRoutingKey().equals(properties.getOutbox().getDiarizationRoutingKey())
                || properties.getOutbox().getExchange()==null || properties.getOutbox().getExchange().isBlank()
                || p.getStorageId()==null || !p.getStorageId().matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
                || p.getEnabledStages()==null || p.getEnabledStages().isEmpty()
                || p.getEnabledStages().stream().anyMatch(v->!ORDER.contains(v))
                || p.getEnabledStages().stream().distinct().count()!=p.getEnabledStages().size()
                || p.getEnabledStages().contains("EXTRACTING_ACTION_ITEMS") && !properties.getProcessing().isActionItemHandoffEnabled()
                || !"https".equals(uri.getScheme()) || uri.getHost()==null || uri.getUserInfo()!=null || uri.getQuery()!=null || uri.getFragment()!=null
                || s.getBucket()==null || s.getBucket().isBlank() || s.getRegion()==null || s.getRegion().isBlank()
                || s.isCreateBucketIfMissing() || properties.getProcessing().getStageLeaseSeconds()<30) throw new IllegalStateException();
            PemTls.trustStore(Path.of(s.getCaFile()));
        } catch(Exception invalid) {throw new IllegalStateException("Invalid Meeting Intelligence worker capability configuration");}
    }
    public boolean canDispatch(String stage) {
        var p=properties.getIntelligence();
        return p.isEnabled() && p.isDispatchEnabled() && p.getEnabledStages().contains(stage)
            && (!"EXTRACTING_ACTION_ITEMS".equals(stage) || properties.getProcessing().isActionItemHandoffEnabled());
    }
    public void requireStage(String stage) {
        var p=properties.getIntelligence();
        if(!p.isEnabled() || !p.getEnabledStages().contains(stage)
            || "EXTRACTING_ACTION_ITEMS".equals(stage) && !properties.getProcessing().isActionItemHandoffEnabled())
            throw new WorkerException(503,"INTELLIGENCE_CAPABILITY_UNAVAILABLE");
    }
    public String storageId() {return properties.getIntelligence().getStorageId();}
}
