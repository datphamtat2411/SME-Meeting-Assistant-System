package com.sme.meetingassistant.api.media.validation;

import com.sme.meetingassistant.api.media.MediaProperties;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Component
public class FfprobeMediaInspector implements MediaInspector {
    private final MediaProperties.Upload properties;
    private final ObjectMapper mapper;

    public FfprobeMediaInspector(MediaProperties properties, ObjectMapper mapper) {
        this.properties = properties.getUpload();
        this.mapper = mapper;
    }

    @Override
    public MediaInspection inspect(Path mediaFile) {
        Path output = null;
        Process process = null;
        try {
            output = Files.createTempFile("media-probe-", ".json");
            process = new ProcessBuilder(this.properties.getFfprobePath(), "-v", "error",
                "-protocol_whitelist", "file", "-probesize", "10485760", "-analyzeduration", "10000000",
                "-max_alloc", "100000000",
                "-show_entries", "format=format_name,duration", "-show_entries", "stream=codec_type",
                "-of", "json", mediaFile.toAbsolutePath().toString()).redirectErrorStream(true)
                .redirectOutput(output.toFile()).start();
            Duration timeout = this.properties.getProbeTimeout();
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                throw new IllegalArgumentException("MEDIA_PROBE_TIMEOUT");
            }
            if (process.exitValue() != 0) {
                throw new IllegalArgumentException("MEDIA_UNREADABLE");
            }
            JsonNode root;
            try {
                root = this.mapper.readTree(Files.readString(output));
            } catch (JacksonException malformedProbeOutput) {
                throw new IllegalArgumentException("MEDIA_UNREADABLE", malformedProbeOutput);
            }
            String format = root.path("format").path("format_name").asText("");
            double seconds = root.path("format").path("duration").asDouble(0);
            boolean hasAudio = false;
            for (JsonNode stream : root.path("streams")) {
                if ("audio".equals(stream.path("codec_type").asText())) {
                    hasAudio = true;
                    break;
                }
            }
            if (format.isBlank() || seconds <= 0 || !Double.isFinite(seconds)) {
                throw new IllegalArgumentException("MEDIA_UNREADABLE");
            }
            return new MediaInspection(format, Math.round(seconds * 1000), hasAudio);
        } catch (IOException exception) {
            throw new IllegalArgumentException("MEDIA_PROBE_UNAVAILABLE", exception);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalArgumentException("MEDIA_PROBE_INTERRUPTED", exception);
        } finally {
            if (process != null && process.isAlive()) process.destroyForcibly();
            if (output != null) {
                try { Files.deleteIfExists(output); } catch (IOException ignored) { /* temp cleanup is best-effort */ }
            }
        }
    }
}
