package com.sme.meetingassistant.api.media.dto;

import jakarta.validation.constraints.Pattern;

public record RetryProcessingJobRequest(
        @Pattern(regexp = "[A-Z][A-Z0-9_]{0,47}") String stageCode) { }
