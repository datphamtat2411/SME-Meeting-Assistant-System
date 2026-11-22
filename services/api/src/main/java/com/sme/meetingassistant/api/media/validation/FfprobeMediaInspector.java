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
    private static final long MAX_PROBE_OUTPUT_BYTES = 256 * 1024;
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
                "-protocol_whitelist", "file", "-format_whitelist", "wav,mp3,mov,matroska,webm",
                "-probesize", "10485760", "-analyzeduration", "10000000",
                "-max_alloc", "100000000",
                "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,duration:stream_disposition=attached_pic",
                "-of", "json", mediaFile.toAbsolutePath().toString()).redirectErrorStream(true)
                .redirectOutput(output.toFile()).start();
            Duration timeout = this.properties.getProbeTimeout();
            long remainingNanos = timeout.toNanos();
            long started = System.nanoTime();
            while (!process.waitFor(Math.max(0, Math.min(remainingNanos, TimeUnit.MILLISECONDS.toNanos(100))),
                    TimeUnit.NANOSECONDS)) {
                if (Files.size(output) > MAX_PROBE_OUTPUT_BYTES) {
                    throw new IllegalArgumentException("MEDIA_UNREADABLE");
                }
                remainingNanos = timeout.toNanos() - (System.nanoTime() - started);
                if (remainingNanos <= 0) throw new IllegalArgumentException("MEDIA_PROBE_TIMEOUT");
            }
            if (process.exitValue() != 0 || Files.size(output) > MAX_PROBE_OUTPUT_BYTES) {
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
            String audioCodec = null;
            int primaryStreams = 0;
            for (JsonNode stream : root.path("streams")) {
                String type = stream.path("codec_type").asText();
                if ("video".equals(type) && stream.path("disposition").path("attached_pic").asInt() == 1) {
                    continue;
                }
                primaryStreams++;
                if ("audio".equals(type)) {
                    audioCodec = stream.path("codec_name").asText("");
                    seconds = Math.max(seconds, stream.path("duration").asDouble(0));
                }
            }
            if (format.isBlank() || seconds <= 0 || !Double.isFinite(seconds)) {
                throw new IllegalArgumentException("MEDIA_UNREADABLE");
            }
            return new MediaInspection(format, Math.round(seconds * 1000), audioCodec, primaryStreams == 1);
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
