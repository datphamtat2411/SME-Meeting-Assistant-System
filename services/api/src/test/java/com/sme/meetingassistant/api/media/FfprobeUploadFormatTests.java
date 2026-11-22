package com.sme.meetingassistant.api.media;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sme.meetingassistant.api.media.validation.FfprobeMediaInspector;
import com.sme.meetingassistant.api.media.validation.UploadAudioFormat;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import tools.jackson.databind.ObjectMapper;

class FfprobeUploadFormatTests {
    @TempDir Path directory;

    @ParameterizedTest
    @CsvSource({"wav,pcm_s16le,true", "mp3,libmp3lame,true", "m4a,aac,true", "m4a,alac,false"})
    void probesRealContainersAndCodecsWithoutUsingStorageFilename(String ext, String encoder,
            boolean supported) throws Exception {
        Path media = directory.resolve("opaque-storage-key");
        var process = new ProcessBuilder("ffmpeg", "-v", "error", "-f", "lavfi", "-i",
            "sine=duration=1:sample_rate=16000", "-c:a", encoder, "-f", ext.equals("m4a") ? "ipod" : ext,
            media.toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        try {
            assertTrue(process.waitFor(15, TimeUnit.SECONDS));
            assertEquals(0, process.exitValue());
        } finally {
            if (process.isAlive()) process.destroyForcibly();
        }
        var properties = new MediaProperties();
        properties.getUpload().setFfprobePath("ffprobe");
        var result = new FfprobeMediaInspector(properties, new ObjectMapper()).inspect(media);
        assertTrue(result.hasAudio());
        assertEquals(supported, UploadAudioFormat.forExtension(ext).matches(result));
    }
}
