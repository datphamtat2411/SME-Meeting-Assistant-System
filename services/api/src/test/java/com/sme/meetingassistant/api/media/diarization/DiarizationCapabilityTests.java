package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.*;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class DiarizationCapabilityTests {
    @Test void disabledByDefaultAndRequiresPrivateTransportAndVerifiedImmutableStorage() {
        var env=new MockEnvironment();var media=new MediaProperties();
        assertThatThrownBy(()->new DiarizationWorkerCapability(env,media).requireAvailable()).isInstanceOf(WorkerException.class);
        env.setProperty("app.worker.diarization.enabled","true");
        assertThatThrownBy(()->new DiarizationWorkerCapability(env,media)).isInstanceOf(IllegalStateException.class)
            .hasMessage("Invalid diarization worker capability configuration");
    }
}
