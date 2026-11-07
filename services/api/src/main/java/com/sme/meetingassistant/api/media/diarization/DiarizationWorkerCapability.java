package com.sme.meetingassistant.api.media.diarization;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.transport.PemTls;
import java.net.URI;
import java.nio.file.Path;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import com.sme.meetingassistant.api.media.worker.WorkerException;

@Component
public class DiarizationWorkerCapability {
    private final boolean enabled;
    private final String storageId;
    public DiarizationWorkerCapability(Environment env,MediaProperties media) {
        enabled=env.getProperty("app.worker.diarization.enabled",Boolean.class,false);
        storageId=env.getProperty("app.worker.diarization.storage-id","");
        if(enabled) try {
            var s=media.getStorage();var uri=URI.create(s.getEndpoint());
            if(!env.getProperty("app.transport.private.enabled",Boolean.class,false)
                || !env.getProperty("app.worker.diarization.infrastructure-verified",Boolean.class,false)
                || !storageId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
                || !"https".equals(uri.getScheme()) || uri.getHost()==null || uri.getUserInfo()!=null
                || uri.getQuery()!=null || uri.getFragment()!=null || s.getBucket()==null || s.getBucket().isBlank()
                || s.getRegion()==null || s.getRegion().isBlank() || s.isCreateBucketIfMissing()) throw new IllegalStateException();
            PemTls.trustStore(Path.of(s.getCaFile()));
        } catch(Exception invalid) { throw new IllegalStateException("Invalid diarization worker capability configuration"); }
    }
    public void requireAvailable() { if(!enabled) throw new WorkerException(503,"SERVICE_UNAVAILABLE"); }
    public String storageId() { return storageId; }
}
