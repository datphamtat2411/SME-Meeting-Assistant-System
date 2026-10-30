package com.sme.meetingassistant.api.media.validation;

public record MediaInspection(String detectedFormat, long durationMs, boolean hasAudio) { }
