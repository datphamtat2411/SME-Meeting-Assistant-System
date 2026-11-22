package com.sme.meetingassistant.api.media.validation;

import java.util.Locale;
import java.util.Set;

/** Public representations paired with the demuxer and decoder accepted by AI normalization. */
public enum UploadAudioFormat {
    WAV("wav", "audio/wav", "wav",
        Set.of("pcm_u8", "pcm_s8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_s64le",
            "pcm_f32le", "pcm_f64le"), Set.of("audio/x-wav", "audio/wave", "audio/vnd.wave")),
    MP3("mp3", "audio/mpeg", "mp3", Set.of("mp3"), Set.of("audio/mp3", "audio/x-mp3", "audio/x-mpeg")),
    M4A("m4a", "audio/mp4", "mov,mp4,m4a,3gp,3g2,mj2", Set.of("aac"),
        Set.of("audio/m4a", "audio/x-m4a", "video/mp4", "application/mp4"));

    private final String extension;
    private final String contentType;
    private final String container;
    private final Set<String> codecs;
    private final Set<String> aliases;

    UploadAudioFormat(String extension, String contentType, String container,
            Set<String> codecs, Set<String> aliases) {
        this.extension = extension;
        this.contentType = contentType;
        this.container = container;
        this.codecs = codecs;
        this.aliases = aliases;
    }

    public static UploadAudioFormat forExtension(String extension) {
        for (var type : values()) {
            if (type.extension.equals(extension)) return type;
        }
        return null;
    }

    public String contentType() { return this.contentType; }

    public boolean isMime(String value) {
        String normalized = value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return contentType.equals(normalized) || aliases.contains(normalized);
    }

    public boolean acceptsDeclaration(String value) {
        return isMime(value) || "application/octet-stream".equalsIgnoreCase(value.trim());
    }

    public boolean matches(MediaInspection inspection) {
        return inspection.singleAudioTrack() && this.container.equals(inspection.detectedFormat())
            && this.codecs.contains(inspection.audioCodec());
    }
}
