package com.sme.meetingassistant.api.media.worker;

import static org.assertj.core.api.Assertions.*;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.*;
import java.util.List;
import org.junit.jupiter.api.Test;

class WorkerCorrectionDigestTests {
    @Test void matchesPythonGoldenVectorAndSeparatesByteDigest() {
        var result = new TranscriptResult(null,null,null,null,"vi",1750L,Status.READY,List.of(
            new SegmentResult(0,0,1000,"Xin chào.","ACCEPTED",null,null,null),
            new SegmentResult(1,1000,1750,"Chốt lịch họp.","ACCEPTED",null,null,null)),List.of(),List.of());
        assertThat(TranscriptCorrectionDigest.sha256(result))
            .isEqualTo("dfa8c6d7a8a5297c28f1b4f7f4fcea73a0c21b04fe4e3377a5b9ad29e9acb70a");
        assertThat(WorkerJson.sha256("{\"a\":1}".getBytes()))
            .isNotEqualTo(WorkerJson.sha256("{ \"a\": 1 }".getBytes()));
        assertThat(TranscriptCorrectionDigest.sha256(result)).isEqualTo(TranscriptCorrectionDigest.sha256(result));
    }
}
