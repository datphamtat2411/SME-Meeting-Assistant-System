package com.sme.meetingassistant.api.media.validation;

public record MediaInspection(String detectedFormat, long durationMs, String audioCodec,
        boolean singleAudioTrack) {
    public boolean hasAudio() { return audioCodec != null; }
}
