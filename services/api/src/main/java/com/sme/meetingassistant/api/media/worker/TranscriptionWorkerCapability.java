package com.sme.meetingassistant.api.media.worker;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.transport.PemTls;
import java.net.URI;
import java.nio.file.Path;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@Component
public class TranscriptionWorkerCapability {
    private final boolean enabled;
    private final String storageId;
    public TranscriptionWorkerCapability(Environment env,MediaProperties media) {
        enabled=env.getProperty("app.worker.transcription.enabled",Boolean.class,false);
        storageId=env.getProperty("app.worker.transcription.storage-id","");
        if(enabled) {
            try {
                if(env.acceptsProfiles(org.springframework.core.env.Profiles.of("secure-integration"))
                    && (!"external-quorum".equals(env.getProperty("app.media.messaging.topology"))
                        || !env.getProperty("app.worker.dead-letter.enabled",Boolean.class,false)
                        || !env.getProperty("app.worker.transcription.infrastructure-verified",Boolean.class,false)
                        || media.getStorage().getAccessKey()==null || media.getStorage().getAccessKey().isBlank()
                        || media.getStorage().getSecretKey()==null || media.getStorage().getSecretKey().isBlank()))
                    throw new IllegalStateException();
                var storage=media.getStorage(); var uri=URI.create(storage.getEndpoint());
                if(!env.getProperty("app.transport.private.enabled",Boolean.class,false)
                    || !storageId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
                    || !"https".equals(uri.getScheme()) || uri.getHost()==null || uri.getUserInfo()!=null
                    || uri.getQuery()!=null || uri.getFragment()!=null || storage.getBucket()==null || storage.getBucket().isBlank()
                    || storage.getRegion()==null || storage.getRegion().isBlank() || storage.isCreateBucketIfMissing())
                    throw new IllegalStateException();
                PemTls.trustStore(Path.of(storage.getCaFile()));
            } catch(Exception e) { throw new IllegalStateException("Invalid transcription worker capability configuration"); }
        }
    }
    public void requireAvailable() {
        if(!enabled) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Transcription worker capability is unavailable.");
    }
    public String storageId() { return storageId; }
    public boolean isEnabled() { return enabled; }
}
